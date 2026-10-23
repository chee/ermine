// tippet's http long-poll carrier (poll.h)
#include "poll.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "den.h"

// a pause after a request that failed
#define AGAIN 1000

static void *plain(void *ctx, void *p, size_t old, size_t size) {
	(void)ctx, (void)old;
	if (size == 0) return free(p), NULL;
	return realloc(p, size);
}

static struct {
	tp_sync *sync;
	char url[160], host[64];
	tp_http h;
	tp_link *link;
	// the link lost (a 409 or 410, or the outbox past its bound): made again once both are idle
	int gone;
	poll_request r[2];
	int busy[2];
	int64_t rest[2];
	// the send's body, copied (the outbox moves as it grows); and how many messages it carries
	uint8_t *body;
	size_t count;
	int joined;
	unsigned requests, failed, in, out;
	char state[48];
} me;

static int done(int i) { return __atomic_load_n(&me.r[i].done, __ATOMIC_ACQUIRE); }

// a message onto the link: into the outbox. full (no more runs till tp_sync_go) at POLL_FULL bytes
// waiting, not tp_http's half a megabyte: catching a room up on this den's steps would queue every
// run at once, and the outbox, doubling, wants a block the heap doesn't have
static int send(void *ctx, const uint8_t *bytes, size_t length) {
	(void)ctx;
	int r = tp_http_send(&me.h, bytes, length);
	if (r < 0) {
		printf("poll: a message of %zu bytes not sent (%s): the link is gone\n", length, tp_why(r));
		me.gone = 1, me.link = NULL;
		return r;
	}
	me.out++;
	return r || me.h.length >= POLL_FULL;
}

static void open_link(void) {
	uint8_t b[8];
	char id[17];
	den_random(b, sizeof b);
	for (int i = 0; i < 8; i++) sprintf(id + 2 * i, "%02x", b[i]);
	tp_http_open(&me.h, &(tp_mem){plain, NULL}, id, POLL_ROOM);
	me.gone = 0, me.joined = 0;
	me.link = tp_sync_link(me.sync, send, NULL, 0);
	if (me.link == NULL) me.gone = 1;
	// the server (galaxy) keeps every run it is sent: what has passed on to it may be forgotten here
	else tp_sync_keeper(me.sync, me.link);
}

void poll_start(tp_sync *sync, const char *url) {
	if (sync == NULL) return;
	me.sync = sync;
	snprintf(me.url, sizeof me.url, "%s", url);
	const char *h = strstr(url, "://");
	snprintf(me.host, sizeof me.host, "%s", h ? h + 3 : url);
	char *slash = strchr(me.host, '/');
	if (slash) *slash = 0;
	open_link();
}

static void told(void *ctx, const uint8_t *message, size_t length) {
	(void)ctx;
	me.in++;
	den_heard(message, length);
	if (me.link) tp_sync_receive(me.sync, me.link, message, length);
}

static void begin(int i, int post, const uint8_t *body, size_t n) {
	char query[160];
	tp_http_query(&me.h, query, sizeof query);
	poll_request *r = &me.r[i];
	free(r->answer);
	memset(r, 0, sizeof *r);
	r->post = post, r->body = body, r->n = n;
	snprintf(r->url, sizeof r->url, "%s/%s?%s", me.url, post ? "send" : "recv", query);
	me.busy[i] = 1;
	me.requests++;
	poll_do(POLL_WORKERS == 1 ? 0 : i, r);
}

void poll_turn(int64_t now) {
	if (me.sync == NULL) return;
	poll_request *r = me.r;
	// an answer to recv: each message past ack to the sync
	if (me.busy[0] && done(0)) {
		me.busy[0] = 0;
		int code = r[0].status < 0 ? 1 : tp_http_recv(&me.h, r[0].status, r[0].answer, r[0].length, told, NULL);
		free(r[0].answer), r[0].answer = NULL;
		if (code == TP_GONE) me.gone = 1, printf("poll: recv answered %d: the link is gone\n", r[0].status);
		else if (code) me.failed++, me.rest[0] = now + AGAIN;
		else me.joined = 1;
	}
	// a send answered: its messages out of the outbox
	if (me.busy[1] && done(1)) {
		me.busy[1] = 0;
		int code = tp_http_sent(&me.h, r[1].status < 0 ? 0 : r[1].status, me.count);
		free(me.body), me.body = NULL;
		free(r[1].answer), r[1].answer = NULL;
		if (code == TP_GONE) me.gone = 1, printf("poll: send answered %d: the link is gone\n", r[1].status);
		else if (code) me.failed++, me.rest[1] = now + AGAIN;
		else if (me.link && me.h.length < POLL_FULL) tp_sync_go(me.sync, me.link);
	}
	// lost: linked again with a new id once neither worker is busy
	if (me.gone) {
		if (me.busy[0] || me.busy[1]) return;
		if (me.link) tp_sync_unlink(me.sync, me.link), me.link = NULL;
		tp_http_close(&me.h);
		open_link();
		printf("poll: linked again as %s\n", me.h.id);
		return;
	}
	if (!poll_up()) return;
	// one worker: a request at a time, a send first (a recv waits till something comes for this
	// den, a live of another den's at the latest: 2 s with one in the room)
	int one = POLL_WORKERS == 1, idle = !me.busy[0] && !me.busy[1];
	int sending = !me.busy[1] && now >= me.rest[1] && me.h.length > 0 && (!one || idle);
	if (!sending && !me.busy[0] && now >= me.rest[0] && (!one || idle)) begin(0, 0, NULL, 0);
	if (sending) {
		// the outbox's first frames, as many as fit in POLL_BODY (one at least), copied
		size_t at = 0, n = 0;
		while (at < me.h.length) {
			size_t next = at + 4 + ((size_t)me.h.frames[at] << 24 | (size_t)me.h.frames[at + 1] << 16 |
						       (size_t)me.h.frames[at + 2] << 8 | me.h.frames[at + 3]);
			if (n > 0 && next > POLL_BODY) break;
			at = next, n++;
		}
		me.body = malloc(at);
		if (me.body == NULL) return;
		memcpy(me.body, me.h.frames, at);
		me.count = n;
		begin(1, 1, me.body, at);
	}
}

const char *poll_state(void) {
	if (me.sync == NULL) snprintf(me.state, sizeof me.state, "no server");
	else if (!poll_up()) snprintf(me.state, sizeof me.state, "offline");
	else snprintf(me.state, sizeof me.state, "%s %s", me.joined ? "on" : "joining", me.host);
	return me.state;
}

int poll_joined(void) { return me.joined; }

void poll_counts(unsigned *requests, unsigned *failed, unsigned *in, unsigned *out) {
	*requests = me.requests, *failed = me.failed, *in = me.in, *out = me.out;
}
