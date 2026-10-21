// littlesync over the gateway's HTTP sessions (http.h): the pacing, the body, the answer fed in. No IO
#include "http.h"

#include "frame.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// the gateway's: the most a body may carry, and the longest wait
#define BODY 65536
#define WAIT 25000
#define MOST 16384

// a frame taken from the link, its first `at` bytes sent
typedef struct {
	ls_framed *f;
	size_t at;
} taken;

struct ls_http {
	struct ls_link *link;
	char session[65];
	char *base; // url/littlesync/<session>
	char *url;  // base?wait=&most=
	size_t url_room;
	uint32_t idle, most;
	// the frames taken from the link not yet sent (at: the first one's bytes sent), held their bytes;
	// body: the pieces of them in the request out, length bytes
	taken *frames;
	size_t n_frames, c_frames;
	ls_piece *body;
	size_t c_body;
	uint8_t *answer;
	size_t held, length, answer_room;
	int out;          // a request handed out, not ended
	int64_t next;     // no begin before this
	uint32_t back;    // the pause after the next failure
	ls_http_stats stats;
};

static int session_ok(const char *s) {
	size_t n = strlen(s);
	if (n < 8 || n > 64) return 0;
	for (; *s; s++)
		if (!((*s >= 'a' && *s <= 'z') || (*s >= 'A' && *s <= 'Z') || (*s >= '0' && *s <= '9') || *s == '_' || *s == '-'))
			return 0;
	return 1;
}

ls_http *ls_http_open(struct ls_link *link, const ls_http_options *o) {
	if (link == NULL || o == NULL || o->url == NULL || o->url[0] == 0) return NULL;
	if (o->session == NULL && o->random == NULL) return NULL;
	if (o->session != NULL && !session_ok(o->session)) return NULL;
	ls_http *h = calloc(1, sizeof *h);
	if (h == NULL) return NULL;
	h->link = link;
	if (o->session != NULL) snprintf(h->session, sizeof h->session, "%s", o->session);
	else {
		uint8_t r[8];
		o->random(o->random_context, r, sizeof r);
		for (int i = 0; i < 8; i++) snprintf(h->session + 2 * i, 3, "%02x", r[i]);
	}
	h->idle = o->idle_ms ? (o->idle_ms < WAIT ? o->idle_ms : WAIT) : LS_HTTP_IDLE_MS;
	h->most = o->most ? o->most : MOST;
	// one frame always comes, however big; the link keeps none past LS_FRAME_MAX
	h->answer_room = h->most > LS_FRAME_MAX + 2 ? h->most : LS_FRAME_MAX + 2;
	size_t u = strlen(o->url);
	while (u && o->url[u - 1] == '/') u--;
	size_t bn = u + sizeof "/littlesync/" + strlen(h->session);
	h->url_room = bn + 48;
	h->base = malloc(bn);
	h->url = malloc(h->url_room);
	h->answer = malloc(h->answer_room);
	if (h->base == NULL || h->url == NULL || h->answer == NULL) return ls_http_close(h), NULL;
	snprintf(h->base, bn, "%.*s/littlesync/%s", (int)u, o->url, h->session);
	return h;
}

void ls_http_close(ls_http *h) {
	if (h == NULL) return;
	for (size_t i = 0; i < h->n_frames; i++) ls_framed_drop(h->frames[i].f);
	free(h->base), free(h->url), free(h->frames), free(h->body), free(h->answer), free(h);
}

int ls_http_begin(ls_http *h, int64_t now, ls_http_request *r) {
	if (h->out || now < h->next) return 0;
	for (;;) {
		if (h->n_frames == h->c_frames) {
			size_t c = h->c_frames ? h->c_frames * 2 : 16;
			void *f = realloc(h->frames, c * sizeof *h->frames);
			if (f == NULL) return 0; // the frames stay the link's: taken next time
			h->frames = f, h->c_frames = c;
		}
		ls_framed *f[16];
		size_t room = h->c_frames - h->n_frames, m = ls_take(h->link, f, room < 16 ? room : 16);
		if (m == 0) break;
		for (size_t i = 0; i < m; i++) h->frames[h->n_frames++] = (taken){f[i], 0}, h->held += f[i]->length;
	}
	// past the gateway's most (a link's out queue is 16 KB by default): the rest goes next
	size_t n = 0, k = 0;
	for (; k < h->n_frames && n < BODY; k++) n += h->frames[k].f->length - h->frames[k].at;
	if (k > h->c_body) {
		ls_piece *b = realloc(h->body, k * sizeof *b);
		if (b == NULL) return 0;
		h->body = b, h->c_body = k;
	}
	n = 0;
	for (size_t i = 0; i < k; i++) {
		size_t at = h->frames[i].at, m = h->frames[i].f->length - at;
		if (m > BODY - n) m = BODY - n;
		h->body[i] = (ls_piece){h->frames[i].f->bytes + at, m};
		n += m;
	}
	h->length = n;
	uint32_t wait = n ? 0 : h->idle;
	snprintf(h->url, h->url_room, "%s?wait=%u&most=%u", h->base, (unsigned)wait, (unsigned)h->most);
	*r = (ls_http_request){h->url, wait, h->body, k, n, h->answer, h->answer_room};
	h->out = 1;
	return 1;
}

void ls_http_end(ls_http *h, int64_t now, long length) {
	if (!h->out) return;
	h->out = 0;
	h->stats.posts++;
	// what was carried is gone either way (a failed one's lost as on a line)
	size_t k = 0;
	for (size_t gone = h->length; gone && k < h->n_frames; k++) {
		size_t m = h->frames[k].f->length - h->frames[k].at;
		if (m > gone) {
			h->frames[k].at += gone;
			break;
		}
		gone -= m;
		ls_framed_drop(h->frames[k].f);
	}
	memmove(h->frames, h->frames + k, (h->n_frames - k) * sizeof *h->frames);
	h->n_frames -= k;
	h->held -= h->length;
	// room taken up by a big burst is given back
	if (h->n_frames == 0 && h->c_frames > 16) free(h->frames), free(h->body), h->frames = NULL, h->body = NULL, h->c_frames = h->c_body = 0;
	if (length < 0 || (size_t)length > h->answer_room) {
		h->stats.failed++, h->stats.failing++;
		h->back = h->back ? (h->back * 2 < LS_HTTP_BACK_MAX_MS ? h->back * 2 : LS_HTTP_BACK_MAX_MS) : LS_HTTP_BACK_MS;
		h->next = now + h->back;
		return;
	}
	h->stats.failing = 0, h->back = 0, h->next = now;
	h->stats.up += h->length, h->stats.down += (uint64_t)length;
	if (length) ls_feed(h->link, h->answer, (size_t)length);
}

int ls_http_turn(ls_http *h, int64_t now, ls_http_post post, void *context) {
	ls_http_request r;
	if (!ls_http_begin(h, now, &r)) return 0;
	long n = post(context, r.url, r.wait_ms, r.body, r.pieces, r.length, r.answer, r.room);
	// no clock here: a failure's pause counts from before the post
	ls_http_end(h, now, n);
	return 1;
}

const ls_http_stats *ls_http_stats_of(const ls_http *h) { return &h->stats; }
const char *ls_http_session(const ls_http *h) { return h->session; }
