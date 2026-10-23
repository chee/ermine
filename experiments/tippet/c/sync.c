// sync: a log's steps, caught up over links (typescript/sync.ts, ../WIRE.md messages). each side
// says what it has and is sent what it lacks, a run at a time. a link's pushes take turns: one run
// of a device's, then the next device's. tippet.h says how it's used
#include <string.h>

#include "wire.h"

// what a link knows of one device's: how many of its steps the other side has, or has been sent;
// refused: it refused them; pushing: a push going on, again: asked again while it ran
typedef struct {
	uint8_t device[32];
	uint64_t theirs;
	uint8_t refused, pushing, again;
} peer;

struct tp_link {
	tp_link *next;
	tp_send send;
	void *ctx;
	int many;
	peer *peers;
	size_t npeers, room;
	// the devices whose turn is coming, by their place in peers, from first
	size_t *turns;
	size_t first, nturns, turnroom;
	// pumping: its turns being taken; full: it takes no runs until it says go; gone: let go once
	// nothing here is using it
	int pumping, full, gone;
	// forgetting (history.h): keeper, the other side keeps every run (tp_sync_keeper); said, how
	// many of this device's own its last have said it holds
	int keeper;
	uint64_t said;
};

struct tp_sync {
	tp_mem mem;
	tp_log *log;
	int relay;
	void (*heard)(void *ctx, const uint8_t *data, size_t length);
	void (*random)(void *ctx, uint8_t *out, size_t n);
	void *ctx;
	size_t max, devices;
	// the links, and how many calls are using them: none let go until they end
	tp_link *links;
	int depth;
	// the link a run being taken came on: its steps are not sent back on it
	tp_link *from;
	// live ids lately seen, a ring: count of them, the next to go at at
	uint8_t (*seen)[8];
	size_t nseen, most, at;
	// a run's steps, and a message, made here
	tp_buf steps, out;
	tp_span *spans;
	size_t nspans;
};

tp_sync *tp_sync_new(const tp_sync_options *o) {
	tp_sync *s = tp_alloc(&o->mem, sizeof *s);
	if (!s) return NULL;
	memset(s, 0, sizeof *s);
	s->mem = o->mem, s->log = o->log, s->relay = o->relay;
	s->heard = o->heard, s->random = o->random, s->ctx = o->ctx;
	s->most = o->seen ? o->seen : 1024;
	s->max = o->max ? o->max : 1 << 24;
	s->devices = tp_log_limits(o->log).devices;
	s->steps = (tp_buf){NULL, 0, 0, s->max, &s->mem, 0};
	s->out = (tp_buf){NULL, 0, 0, s->max, &s->mem, 0};
	return s;
}

static void release(tp_sync *s, tp_link *l) {
	tp_free(&s->mem, l->peers, l->room * sizeof *l->peers);
	tp_free(&s->mem, l->turns, l->turnroom * sizeof *l->turns);
	tp_free(&s->mem, l, sizeof *l);
}

void tp_sync_free(tp_sync *s) {
	if (!s) return;
	for (tp_link *l = s->links, *next; l; l = next) next = l->next, release(s, l);
	tp_free(&s->mem, s->seen, s->most * 8);
	tp_free(&s->mem, s->spans, s->nspans * sizeof *s->spans);
	tp_buf_free(&s->steps), tp_buf_free(&s->out);
	tp_mem mem = s->mem;
	tp_free(&mem, s, sizeof *s);
}

size_t tp_sync_links(const tp_sync *s) {
	size_t n = 0;
	for (const tp_link *l = s->links; l; l = l->next) n += !l->gone;
	return n;
}

// the links gone, out and let go, once no call is using them
static void sweep(tp_sync *s) {
	if (s->depth) return;
	for (tp_link **p = &s->links; *p;) {
		tp_link *l = *p;
		if (l->gone) *p = l->next, release(s, l);
		else p = &l->next;
	}
}

void tp_sync_unlink(tp_sync *s, tp_link *l) {
	l->gone = 1;
	sweep(s);
}

// a message's bytes onto a link; one that is full takes no runs until it says go, and one that
// can't send any more is gone
static void send(tp_sync *s, tp_link *l, const uint8_t *bytes, size_t length) {
	if (l->gone) return;
	int r = l->send(l->ctx, bytes, length);
	if (r == 1) l->full = 1;
	else if (r) tp_sync_unlink(s, l);
}

// what the link knows of a device's, made when there is none: its place, or -1 (no memory, or
// as many as the devices the other side may have and this side may)
static long peer_of(tp_sync *s, tp_link *l, const uint8_t device[32]) {
	for (size_t i = 0; i < l->npeers; i++) {
		if (!memcmp(l->peers[i].device, device, 32)) return (long)i;
	}
	if (l->npeers == 2 * s->devices) return -1;
	if (l->npeers == l->room) {
		size_t room = l->room ? 2 * l->room : 4;
		peer *p = tp_grow(&s->mem, l->peers, l->room * sizeof *p, room * sizeof *p);
		if (!p) return -1;
		l->peers = p, l->room = room;
	}
	peer *p = &l->peers[l->npeers];
	memset(p, 0, sizeof *p);
	memcpy(p->device, device, 32);
	return (long)l->npeers++;
}

// ---- messages

// ["have", [[device, n], …]], of everything the log has
static void say_have(tp_sync *s, tp_link *l) {
	tp_buf *b = &s->out;
	size_t n = tp_log_devices(s->log);
	b->len = 0, b->bad = 0;
	tp_put_head(b, 4, 2), tp_put_text(b, "have"), tp_put_head(b, 4, n);
	for (size_t i = 0; i < n; i++) {
		uint64_t have;
		const uint8_t *device = tp_log_have(s->log, i, &have);
		tp_put_head(b, 4, 2), tp_put_head(b, 2, 32), tp_put(b, device, 32), tp_put_head(b, 0, have);
	}
	if (!b->bad) send(s, l, b->p, b->len);
}

static void say_refused(tp_sync *s, tp_link *l, const uint8_t device[32]) {
	uint8_t m[48];
	tp_buf b = {m, 0, sizeof m, sizeof m, NULL, 0};
	tp_put_head(&b, 4, 3), tp_put_text(&b, "refused");
	tp_put_head(&b, 2, 32), tp_put(&b, device, 32), tp_put_head(&b, 0, tp_log_count(s->log, device));
	send(s, l, m, b.len);
}

// ---- pushes

// a run's steps, from to to, from the store, packed: its message into out. 0, or -1
static int packed(tp_sync *s, const uint8_t device[32], uint64_t from, uint64_t to, const uint8_t sig[64]) {
	size_t count = (size_t)(to - from + 1);
	if (count > s->nspans) {
		tp_span *p = tp_grow(&s->mem, s->spans, s->nspans * sizeof *p, count * sizeof *p);
		if (!p) return -1;
		s->spans = p, s->nspans = count;
	}
	s->steps.len = 0, s->steps.bad = 0;
	for (size_t k = 0; k < count; k++) {
		long n = tp_log_step(s->log, device, from + k, NULL, 0);
		size_t at = s->steps.len;
		if (n < 0 || !tp_reserve(&s->steps, (size_t)n)) return -1;
		tp_log_step(s->log, device, from + k, s->steps.p + at, (size_t)n);
		s->spans[k] = (tp_span){NULL, (size_t)n};
	}
	for (size_t k = 0, at = 0; k < count; at += s->spans[k++].n) s->spans[k].p = s->steps.p + at;
	tp_span pack;
	if (tp_pack(&s->mem, s->spans, count, s->max, &pack)) return -1;
	tp_buf *b = &s->out;
	tp_put_head(b, 4, 4), tp_put_text(b, "run");
	tp_put_head(b, 2, 32), tp_put(b, device, 32), tp_put_head(b, 2, 64), tp_put(b, sig, 64);
	tp_put(b, pack.p, pack.n);
	tp_span_free(&s->mem, &pack);
	return 0;
}

// one run of a device's to a link: 1 sent; 0 nothing more to send (or it can't be)
static int one(tp_sync *s, tp_link *l, size_t i) {
	uint8_t device[32], sig[64];
	memcpy(device, l->peers[i].device, 32);
	uint64_t from = l->peers[i].theirs + 1, to;
	if (l->peers[i].refused || from > tp_log_count(s->log, device)) return 0;
	if (tp_log_run(s->log, device, from, &to, sig)) return 0;
	// as the log holds it, when it is all of it; else packed from from
	tp_buf *b = &s->out;
	b->len = 0, b->bad = 0;
	long held = tp_log_message(s->log, device, from, NULL, 0);
	uint8_t *p = held > 0 ? tp_reserve(b, (size_t)held) : NULL;
	if (p) tp_log_message(s->log, device, from, p, (size_t)held);
	else if (held > 0 || packed(s, device, from, to, sig)) return 0;
	if (b->bad) return 0;
	send(s, l, b->p, b->len);
	if (!l->gone) l->peers[i].theirs = to;
	return 1;
}

// a device's turn, at the end of the link's
static int queue(tp_sync *s, tp_link *l, size_t i) {
	if (l->nturns == l->turnroom && l->first) {
		// the turns taken, out
		l->nturns -= l->first;
		memmove(l->turns, l->turns + l->first, l->nturns * sizeof *l->turns);
		l->first = 0;
	}
	if (l->nturns == l->turnroom) {
		size_t room = l->turnroom ? 2 * l->turnroom : 4;
		size_t *t = tp_grow(&s->mem, l->turns, l->turnroom * sizeof *t, room * sizeof *t);
		if (!t) return -1;
		l->turns = t, l->turnroom = room;
	}
	l->turns[l->nturns++] = i;
	return 0;
}

// a device's steps to a link, until it has them all: one push per link and device; asked again
// while it runs, it goes on. its turn comes when the link is pumped
static void push(tp_sync *s, tp_link *l, const uint8_t device[32]) {
	long i = peer_of(s, l, device);
	if (i < 0) return;
	peer *p = &l->peers[i];
	if (p->pushing) {
		p->again = 1;
		return;
	}
	if (!queue(s, l, (size_t)i)) p->pushing = 1;
}

// a link's turns taken, a run each, until none is left or it is full
static void pump(tp_sync *s, tp_link *l) {
	if (l->pumping) return;
	l->pumping = 1;
	while (!l->gone && !l->full && l->first < l->nturns) {
		size_t i = l->turns[l->first++];
		int more = one(s, l, i);
		peer *p = &l->peers[i];
		if (!l->gone && (more || p->again) && !queue(s, l, i)) p->again = 0;
		else p->pushing = 0;
	}
	if (l->first == l->nturns) l->first = l->nturns = 0;
	l->pumping = 0;
}

void tp_sync_go(tp_sync *s, tp_link *l) {
	l->full = 0;
	s->depth++, pump(s, l), s->depth--;
	sweep(s);
}

void tp_sync_told(void *ctx, const uint8_t device[32], uint64_t from, size_t count) {
	tp_sync *s = ctx;
	(void)from, (void)count;
	s->depth++;
	for (tp_link *l = s->links; l; l = l->next) {
		if (!l->gone && l != s->from) push(s, l, device), pump(s, l);
	}
	s->depth--;
	sweep(s);
}

tp_link *tp_sync_link(tp_sync *s, tp_send send_, void *ctx, int many) {
	tp_link *l = tp_alloc(&s->mem, sizeof *l);
	if (!l) return NULL;
	memset(l, 0, sizeof *l);
	l->send = send_, l->ctx = ctx, l->many = many;
	// a broadcast is sent only what comes from now on, and what its peers say they lack
	for (size_t i = 0; many && i < tp_log_devices(s->log); i++) {
		uint64_t have;
		const uint8_t *device = tp_log_have(s->log, i, &have);
		long k = peer_of(s, l, device);
		if (k < 0) return release(s, l), NULL;
		l->peers[k].theirs = tp_log_count(s->log, device);
	}
	// last: the links in the order made
	tp_link **end = &s->links;
	while (*end) end = &(*end)->next;
	*end = l;
	// a link that can't take its have is none
	s->depth++, say_have(s, l), s->depth--;
	if (!l->gone) return l;
	sweep(s);
	return NULL;
}

// ---- receiving

// a live id seen lately; else marked seen
static int seen(tp_sync *s, const uint8_t id[8]) {
	for (size_t i = 0; i < s->nseen; i++) {
		if (!memcmp(s->seen[i], id, 8)) return 1;
	}
	if (!s->seen && !(s->seen = tp_alloc(&s->mem, s->most * 8))) return 0;
	memcpy(s->seen[s->at], id, 8);
	s->at = (s->at + 1) % s->most;
	if (s->nseen < s->most) s->nseen++;
	return 0;
}

static void have(tp_sync *s, tp_link *l, tp_in in, uint64_t k) {
	const uint8_t *me = tp_log_device(s->log);
	if (l->many) {
		// on a broadcast, each says what is its own
		uint64_t theirs = 0, n;
		tp_span device;
		if (!me) return;
		for (uint64_t i = 0; i < k; i++) {
			tp_array(&in, &n), tp_bytes(&in, 32, &device), tp_whole(&in, &n);
			if (!memcmp(device.p, me, 32)) theirs = n;
		}
		long i = peer_of(s, l, me);
		if (i < 0) return;
		if (theirs < l->peers[i].theirs) l->peers[i].theirs = theirs;
		push(s, l, me), pump(s, l);
		return;
	}
	for (size_t i = 0; i < l->npeers; i++) l->peers[i].theirs = 0;
	l->said = 0;
	for (uint64_t i = 0; i < k; i++) {
		uint64_t n;
		tp_span device;
		tp_array(&in, &n), tp_bytes(&in, 32, &device), tp_whole(&in, &n);
		long p = peer_of(s, l, device.p);
		if (p >= 0) l->peers[p].theirs = n;
		if (me && !memcmp(device.p, me, 32)) l->said = n;
	}
	// every device they lack, pushed, then their turns
	for (size_t i = 0; i < tp_log_devices(s->log); i++) {
		uint64_t mine;
		const uint8_t *device = tp_log_have(s->log, i, &mine);
		long p = peer_of(s, l, device);
		if (p >= 0 && l->peers[p].theirs < mine) push(s, l, device);
	}
	pump(s, l);
}

static void run(tp_sync *s, tp_link *l, const uint8_t *device, const uint8_t *sig, tp_span pack,
	tp_span message) {
	tp_steps steps;
	tp_step first;
	// last: the n of the run's last step, which they hold
	uint64_t last = 0;
	long r = tp_unpack(&s->mem, pack, s->max, &steps);
	if (!r) {
		if (!tp_step_decode(steps.bytes, steps.at[1], &first)) last = first.n + steps.count - 1;
		tp_span *spans = tp_alloc(&s->mem, steps.count * sizeof *spans);
		if (!spans) {
			tp_steps_free(&s->mem, &steps);
			return;
		}
		for (size_t i = 0; i < steps.count; i++) {
			spans[i] = (tp_span){steps.bytes + steps.at[i], steps.at[i + 1] - steps.at[i]};
		}
		tp_link *was = s->from;
		s->from = l;
		r = tp_log_take(s->log, device, spans, steps.count, sig, message);
		s->from = was;
		tp_free(&s->mem, spans, steps.count * sizeof *spans);
		tp_steps_free(&s->mem, &steps);
	} else if (r == TP_NOTSTEP) {
		// a pack that doesn't unpack: refused, as a chain that doesn't hold
		r = TP_CHAIN;
	}
	// a gap: say what this side has, and it is sent again from there. refused for good: say so,
	// and it is sent no more
	if (r >= 0) {
		long p = peer_of(s, l, device);
		if (p >= 0 && l->peers[p].theirs < last) l->peers[p].theirs = last;
	} else if (r == TP_GAP) {
		say_have(s, l);
	} else if (r <= TP_OWN && !l->many) {
		say_refused(s, l, device);
	}
}

static void receive(tp_sync *s, tp_link *l, const uint8_t *bytes, size_t length) {
	tp_in in = {bytes, bytes + length};
	uint64_t k, n;
	tp_span t, x, y;
	if (l->gone || !tp_canonical(bytes, length) || tp_array(&in, &k) || !k || tp_text(&in, &t)) return;
	if (tp_is(t, "have") && k == 2 && !tp_array(&in, &n) && n <= s->devices) {
		// every entry [device, n], or the message is none
		tp_in at = in;
		for (uint64_t i = 0; i < n; i++) {
			uint64_t two, w;
			if (tp_array(&at, &two) || two != 2 || tp_bytes(&at, 32, &x) || tp_whole(&at, &w)) return;
		}
		have(s, l, in, n);
	} else if (tp_is(t, "run") && k == 4 && !tp_bytes(&in, 32, &x) && !tp_bytes(&in, 64, &y) &&
		in.p < in.end && *in.p >> 5 == 4) {
		run(s, l, x.p, y.p, (tp_span){in.p, (size_t)(in.end - in.p)}, (tp_span){bytes, length});
	} else if (tp_is(t, "refused") && k == 3 && !tp_bytes(&in, 32, &x) && !tp_whole(&in, &n)) {
		// one peer of a broadcast refusing is not the rest refusing
		long p = !l->many && tp_log_count(s->log, x.p) ? peer_of(s, l, x.p) : -1;
		if (p >= 0) l->peers[p].refused = 1;
	} else if (tp_is(t, "live") && k == 3 && !tp_bytes(&in, 8, &x) && !tp_bytes(&in, 0, &y)) {
		if (seen(s, x.p)) return;
		if (s->heard) s->heard(s->ctx, y.p, y.n);
		if (!s->relay) return;
		for (tp_link *o = s->links; o; o = o->next) {
			if (o != l) send(s, o, bytes, length);
		}
	}
}

void tp_sync_receive(tp_sync *s, tp_link *l, const uint8_t *bytes, size_t length) {
	s->depth++, receive(s, l, bytes, length), s->depth--;
	sweep(s);
}

int tp_sync_live(tp_sync *s, const uint8_t *data, size_t length) {
	uint8_t id[8];
	s->random(s->ctx, id, 8);
	seen(s, id);
	// its own buffer, not out: a send may be answered here, into out, before every link has it
	tp_buf b = {NULL, 0, 0, s->max, &s->mem, 0};
	tp_put_head(&b, 4, 3), tp_put_text(&b, "live");
	tp_put_head(&b, 2, 8), tp_put(&b, id, 8), tp_put_head(&b, 2, length), tp_put(&b, data, length);
	int why = tp_buf_why(&b);
	s->depth++;
	for (tp_link *l = s->links; l && !why; l = l->next) send(s, l, b.p, b.len);
	s->depth--;
	tp_buf_free(&b);
	sweep(s);
	return why;
}

// ---- forgetting (history.h, a try-out)

void tp_sync_keeper(tp_sync *s, tp_link *l) { (void)s, l->keeper = 1; }

uint64_t tp_sync_passed(const tp_sync *s, const uint8_t device[32]) {
	const uint8_t *me = tp_log_device(s->log);
	uint64_t out = 0;
	int any = 0;
	for (const tp_link *l = s->links; l; l = l->next) {
		if (l->gone) continue;
		if (me && !memcmp(me, device, 32)) {
			if (l->keeper && l->said > out) out = l->said;
			continue;
		}
		const peer *p = NULL;
		for (size_t i = 0; i < l->npeers && !p; i++) {
			if (!memcmp(l->peers[i].device, device, 32)) p = &l->peers[i];
		}
		if (l->many || (p && p->refused)) continue;
		uint64_t theirs = p ? p->theirs : 0;
		if (!any++ || theirs < out) out = theirs;
	}
	return out;
}
