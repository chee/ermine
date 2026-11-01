// The log (see typescript/log.ts): every device's steps this device holds, stored as the signed,
// packed runs they came in (../WIRE.md). tippet.h says how it is used.
#include <string.h>

#include "store.h"
#include "wire.h"

#define EVERY 32
#define BYTES 2048

typedef struct {
	uint8_t device[32];
	uint64_t count;
	uint8_t last[32];
	uint64_t lamport, when;
	uint64_t next; // the seq the next step has
} feed;

typedef struct {
	uint8_t device[32];
	uint64_t n;
	uint8_t hashes[64];
	uint8_t *message;
	size_t length;
} fork;

struct tp_log {
	tp_mem mem;
	tp_store *store;
	tp_limits limits;
	uint8_t seed[32];
	int seeded, strict, keyed;
	tp_key key;
	feed *feeds;
	size_t nfeeds, feedroom;
	uint64_t lamport;
	uint64_t asked, closed, loose;
	tp_told told;
	void *ctx;
	void (*forked)(void *ctx, size_t i);
	fork *forks;
	size_t nforks, forkroom, proved;
	tp_buf scratch;
};

tp_log *tp_log_new(const tp_log_options *o) {
	tp_log *log = tp_alloc(&o->mem, sizeof *log);
	if (!log) return NULL;
	memset(log, 0, sizeof *log);
	log->mem = o->mem, log->store = o->store, log->limits = o->limits;
	if (!log->limits.devices) log->limits.devices = 4096;
	if (!log->limits.steps) log->limits.steps = 1 << 24;
	if (!log->limits.step) log->limits.step = TP_RUN;
	if (!log->limits.forks) log->limits.forks = (size_t)1 << 25;
	if (o->seed) memcpy(log->seed, o->seed, 32), log->seeded = 1;
	log->strict = o->strict, log->told = o->told, log->ctx = o->ctx, log->forked = o->forked;
	log->scratch.mem = &log->mem, log->scratch.max = log->limits.step;
	return log;
}

void tp_log_free(tp_log *log) {
	if (!log) return;
	tp_mem mem = log->mem;
	for (size_t i = 0; i < log->nfeeds; i++) {
	}
	tp_free(&mem, log->feeds, log->feedroom * sizeof *log->feeds);
	for (size_t i = 0; i < log->nforks; i++) tp_free(&mem, log->forks[i].message, log->forks[i].length);
	tp_free(&mem, log->forks, log->forkroom * sizeof *log->forks);
	tp_buf_free(&log->scratch);
	tp_store *st = log->store;
	if (st && st->sync) st->sync(st->self);
	if (st) st->close(st->self);
	memset(&log->key, 0, sizeof log->key);
	tp_free(&mem, log, sizeof *log);
}

const uint8_t *tp_log_device(const tp_log *log) { return log->keyed ? log->key.pub : NULL; }
uint64_t tp_log_lamport(const tp_log *log) { return log->lamport; }
tp_limits tp_log_limits(const tp_log *log) { return log->limits; }

static feed *find(const tp_log *log, const uint8_t device[32]) {
	for (size_t i = 0; i < log->nfeeds; i++) {
		if (!memcmp(log->feeds[i].device, device, 32)) return &log->feeds[i];
	}
	return NULL;
}

static feed *make(tp_log *log, const uint8_t device[32]) {
	feed *f = find(log, device);
	if (f) return f;
	if (log->nfeeds == log->limits.devices) return NULL;
	if (log->nfeeds == log->feedroom) {
		size_t room = log->feedroom ? 2 * log->feedroom : 4;
		if (room > log->limits.devices) room = log->limits.devices;
		feed *q = tp_grow(&log->mem, log->feeds, log->feedroom * sizeof *q, room * sizeof *q);
		if (!q) return NULL;
		log->feeds = q, log->feedroom = room;
	}
	f = &log->feeds[log->nfeeds++];
	memset(f, 0, sizeof *f);
	memcpy(f->device, device, 32);
	return f;
}
static int unmade(const tp_log *log) { return log->nfeeds == log->limits.devices ? TP_BOUND : TP_NOMEM; }

static int own(const tp_log *log, const uint8_t device[32]) {
	return log->keyed && !memcmp(device, log->key.pub, 32);
}

uint64_t tp_log_count(const tp_log *log, const uint8_t device[32]) {
	const feed *f = find(log, device);
	return f ? f->count : 0;
}

size_t tp_log_devices(const tp_log *log) { return log->nfeeds; }

const uint8_t *tp_log_have(const tp_log *log, size_t i, uint64_t *have) {
	*have = log->feeds[i].count;
	return log->feeds[i].device;
}

long tp_log_step(const tp_log *log, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	return log->store->get(log->store->self, device, n, out, cap);
}

static int follows(const tp_step *s, uint64_t n, const uint8_t *before) {
	return s->n == n && (s->before == NULL) == (before == NULL) &&
		(!before || !memcmp(s->before, before, 32));
}

// the steps that follow one another from what is held (held 0: from the first step's own n, as a
// tail of a proof does); last the hash of the last, *high the highest lamport among the new
static long chain(const tp_log *log, const uint8_t device[32], const tp_span *steps, size_t k, int held,
	uint8_t last[32], uint64_t *high) {
	const feed *f = held ? find(log, device) : NULL;
	tp_step s;
	if (tp_step_decode(steps[0].p, steps[0].n, &s)) return TP_CHAIN;
	uint64_t have = f ? f->count : held ? 0 : s.n - 1, next = f ? f->next : held ? 0 : s.seq;
	if (s.n > have + 1) return TP_GAP;
	size_t skip = (size_t)(have + 1 - s.n), fresh = k > skip ? k - skip : 0;
	if (f && f->count) memcpy(last, f->last, 32);
	else if (!held && s.before) memcpy(last, s.before, 32);
	*high = 0;
	for (size_t i = 0; i < fresh; i++) {
		const tp_span *b = &steps[skip + i];
		if (tp_step_decode(b->p, b->n, &s) || memcmp(s.device, device, 32) ||
			!follows(&s, have + 1 + i, have + i ? last : NULL) || s.seq != next)
			return TP_CHAIN;
		next += tp_step_made(&s);
		if (s.lamport > *high) *high = s.lamport;
		tp_step_hash(b->p, b->n, last);
	}
	return (long)fresh;
}

static feed *fit(tp_log *log, const uint8_t device[32], size_t fresh, int *why) {
	feed *f = make(log, device);
	*why = !f ? unmade(log) : fresh > log->limits.steps - f->count ? TP_BOUND : 0;
	return *why ? NULL : f;
}

// steps: the fresh ones
static void keep(tp_log *log, feed *f, const tp_span *steps, size_t fresh, const uint8_t last[32],
	uint64_t high) {
	tp_step s;
	f->count += fresh;
	memcpy(f->last, last, 32);
	if (!tp_step_decode(steps[fresh - 1].p, steps[fresh - 1].n, &s)) {
		f->lamport = s.lamport, f->when = s.when, f->next = s.seq + tp_step_made(&s);
	}
	if (high > log->lamport) log->lamport = high;
}

uint64_t tp_log_seq(const tp_log *log, const uint8_t device[32]) {
	const feed *f = find(log, device);
	return f ? f->next : 0;
}

int tp_log_prior(const tp_log *log, const uint8_t device[32], uint64_t n, tp_prior *p) {
	const feed *f = find(log, device);
	if (!f || n < 1 || n > f->count) return TP_BEFORE;
	if (n == f->count) {
		memcpy(p->device, device, 32), memcpy(p->hash, f->last, 32);
		p->n = n, p->lamport = f->lamport, p->when = f->when, p->next = f->next;
		return 0;
	}
	long length = tp_log_step(log, device, n, NULL, 0);
	uint8_t *b = length > 0 ? tp_alloc(&log->mem, (size_t)length) : NULL;
	int why = !b || tp_log_step(log, device, n, b, (size_t)length) != length || tp_prior_of(b, (size_t)length, p)
		? TP_BEFORE : 0;
	if (b) tp_free(&log->mem, b, (size_t)length);
	return why;
}

static void put64(tp_buf *b, uint64_t n) {
	uint8_t x[8];
	for (int i = 0; i < 8; i++) x[i] = (uint8_t)(n >> (56 - 8 * i));
	tp_put(b, x, 8);
}

static void recorded(tp_buf *b, const uint8_t *message, size_t length, const tp_prior *prior) {
	uint64_t n;
	int after = 0;
	tp_pack_first((tp_span){message + TP_HEAD, length - TP_HEAD}, &n, &after);
	tp_put(b, after ? "\x85" : "\x84", 1), tp_put(b, message + 1, length - 1);
	if (after) {
		tp_put_head(b, 2, 56), tp_put(b, prior->hash, 32);
		put64(b, prior->lamport), put64(b, prior->when), put64(b, prior->next);
	}
}

static int message(tp_log *log, const uint8_t device[32], const uint8_t sig[64], const tp_span *steps,
	size_t k, const tp_prior *prior, tp_buf *b) {
	tp_span pack;
	tp_buf m = {NULL, 0, 0, TP_HEAD + 1024, &log->mem, 0};
	for (size_t i = 0; i < k; i++) m.max += steps[i].n;
	b->max = m.max + TP_PRIOR;
	int why = tp_pack_after(&log->mem, prior, steps, k, m.max, &pack);
	if (why) return why;
	tp_put_head(&m, 4, 4), tp_put_text(&m, "run");
	tp_put_head(&m, 2, 32), tp_put(&m, device, 32), tp_put_head(&m, 2, 64), tp_put(&m, sig, 64);
	tp_put(&m, pack.p, pack.n);
	tp_span_free(&log->mem, &pack);
	if (!(why = tp_buf_why(&m))) recorded(b, m.p, m.len, prior), why = tp_buf_why(b);
	tp_buf_free(&m);
	return why;
}

static int close_run(tp_log *log, uint64_t first, uint64_t last) {
	size_t k = (size_t)(last - first + 1);
	tp_span spans[EVERY];
	tp_buf steps = {NULL, 0, 0, EVERY * log->limits.step, &log->mem, 0}, b = steps;
	int why = 0;
	for (size_t i = 0; i < k && !why; i++) {
		long n = tp_log_step(log, log->key.pub, first + i, NULL, 0);
		uint8_t *p = n < 0 ? NULL : tp_reserve(&steps, (size_t)n);
		if (!p) why = n < 0 ? TP_STORE : tp_buf_why(&steps);
		else tp_log_step(log, log->key.pub, first + i, p, (size_t)n), spans[i].n = (size_t)n;
	}
	for (size_t i = 0, at = 0; i < k && !why; at += spans[i++].n) spans[i].p = steps.p + at;
	uint8_t hash[32], sig[64];
	if (!why) {
		tp_step_hash(spans[k - 1].p, spans[k - 1].n, hash);
		tp_sign(&log->key, hash, 32, sig);
		tp_prior prior;
		int against = first > 1 && !tp_log_prior(log, log->key.pub, first - 1, &prior);
		why = message(log, log->key.pub, sig, spans, k, against ? &prior : NULL, &b);
	}
	tp_at at = {log->key.pub, first, last};
	if (!why && !(why = log->store->append(log->store->self, b.p, b.len, &at))) log->closed = last;
	tp_buf_free(&steps), tp_buf_free(&b);
	return why;
}

static int close_to(tp_log *log, uint64_t n) {
	if (n == tp_log_count(log, log->key.pub)) log->loose = 0;
	if (n > log->asked) log->asked = n;
	int why = 0;
	while (!why && log->closed < n) {
		uint64_t first = log->closed + 1;
		why = close_run(log, first, n - first < EVERY ? n : first + EVERY - 1);
	}
	return why;
}

static void tell(tp_log *log, const uint8_t device[32], uint64_t from, size_t count) {
	uint8_t d[32];
	memcpy(d, device, 32);
	if (log->told && count) log->told(log->ctx, d, from, count);
}

int tp_log_write(tp_log *log, const tp_write *w, uint64_t *n, uint64_t *lamport) {
	if (!log->keyed) return TP_NOKEY;
	if (log->lamport >= TP_WHOLE) return TP_END;
	feed *f = make(log, log->key.pub);
	if (!f) return unmade(log);
	if (f->count >= log->limits.steps) return TP_BOUND;
	// on and ids are none and null each, when not given
	static const uint8_t none = 0x80;
	uint64_t np = 0;
	tp_in pin = {w->patches.p, w->patches.p + w->patches.n};
	uint8_t nulls[TP_PATCHES / 8 + 8];
	tp_span on = w->on.p ? w->on : (tp_span){&none, 1}, ids = w->ids;
	if (!ids.p) {
		tp_buf nb = {nulls, 0, sizeof nulls, (size_t)-1, NULL, 0};
		if (tp_array(&pin, &np) || np > 4096) return TP_NOTSTEP;
		tp_put_head(&nb, 4, np);
		for (uint64_t i = 0; i < np; i++) tp_put(&nb, "\xf6", 1);
		ids = (tp_span){nulls, nb.len};
	}
	tp_step s = {{0}, log->key.pub, f->count + 1, f->count ? f->last : NULL,
		w->node, w->part, w->patches, w->who, 0, log->lamport + 1, w->when, f->next, 0, on, ids};
	long rest = tp_step_rest(log->key.pub, w->node);
	if (rest >= 0) s.relative = 1, s.node = (tp_span){w->node.p + w->node.n - (size_t)rest, (size_t)rest};
	size_t length = tp_step_encode(&s, NULL, 0);
	log->scratch.len = 0, log->scratch.bad = 0;
	uint8_t *bytes = tp_reserve(&log->scratch, length);
	if (!bytes) return tp_buf_why(&log->scratch);
	tp_step_encode(&s, bytes, length);
	tp_step check;
	if (tp_step_decode(bytes, length, &check)) return TP_NOTSTEP;
	if (length > TP_RUN) return TP_BOUND;
	// no run past TP_RUN: the open one closed first
	if (log->loose && log->loose + length > TP_RUN) close_to(log, f->count);
	tp_at at = {log->key.pub, s.n, s.n};
	tp_store *st = log->store;
	int why = st->open ? st->open(st->self, bytes, length, &at) : st->append(st->self, bytes, length, &at);
	if (why) return why;
	f->count++;
	tp_step_hash(bytes, length, f->last);
	f->lamport = s.lamport, f->when = s.when, f->next = s.seq + tp_step_made(&s);
	log->lamport = s.lamport;
	log->loose += length;
	if (s.n - log->asked >= EVERY || log->loose >= BYTES) close_to(log, s.n);
	*n = s.n, *lamport = s.lamport;
	tell(log, log->key.pub, s.n, 1);
	return 0;
}

int tp_log_run(tp_log *log, const uint8_t device[32], uint64_t at, uint64_t *to, uint8_t sig[64]) {
	feed *f = find(log, device);
	if (!f || at < 1 || at > f->count) return 1;
	// Its steps are on disk in their runs before any leave, so a power cut can't reuse an n.
	tp_store *st = log->store;
	if (own(log, device) && at > log->closed && close_to(log, f->count)) return 1;
	if (own(log, device) && st->sync && st->sync(st->self)) return 1;
	uint8_t head[TP_HEAD];
	uint64_t first;
	long n = st->run(st->self, device, at, head, sizeof head, &first, to);
	if (n < 0 || !tp_is_run(head, (size_t)n)) return 1;
	memcpy(sig, head + TP_SIG, 64);
	return 0;
}

long tp_log_message(tp_log *log, const uint8_t device[32], uint64_t from, uint8_t *out, size_t cap) {
	tp_store *st = log->store;
	uint8_t head[TP_HEAD];
	uint64_t first, last;
	long n = st->run(st->self, device, from, head, sizeof head, &first, &last);
	if (n < 0 || first != from || !tp_is_run(head, (size_t)n)) return -1;
	if (*head == 0x85) n -= TP_PRIOR;
	if (out && (size_t)n <= cap) st->run(st->self, device, from, out, (size_t)n, &first, &last), *out = 0x84;
	return n;
}

size_t tp_log_forks(const tp_log *log) { return log->nforks; }

int tp_log_fork_at(const tp_log *log, size_t i, tp_fork *f) {
	if (i >= log->nforks) return 1;
	const fork *k = &log->forks[i];
	*f = (tp_fork){k->device, k->n, k->hashes, {k->message, k->length}};
	return 0;
}

int tp_log_forked(const tp_log *log, const uint8_t device[32]) {
	for (size_t i = 0; i < log->nforks; i++) {
		if (!memcmp(log->forks[i].device, device, 32)) return 1;
	}
	return 0;
}

// a tail: steps of device, one after another from n, chained, the last signed. first: the hash of
// the first; bytes: all told
static int tail(const tp_log *log, const uint8_t device[32], const tp_span *steps, size_t k,
	const uint8_t sig[64], uint64_t *n, uint8_t first[32], size_t *bytes) {
	uint8_t last[32];
	uint64_t high;
	tp_step s;
	*bytes = 0;
	for (size_t i = 0; i < k; i++) *bytes += steps[i].n;
	if (!k || *bytes > TP_RUN || chain(log, device, steps, k, 0, last, &high) != (long)k) return 0;
	tp_step_decode(steps[0].p, steps[0].n, &s);
	*n = s.n, tp_step_hash(steps[0].p, steps[0].n, first);
	return tp_verify(device, last, 32, sig);
}

static int proof(tp_log *log, const uint8_t device[32], const tp_span *a, size_t ka, const uint8_t siga[64],
	const tp_span *b, size_t kb, const uint8_t sigb[64], tp_buf *m) {
	tp_span pa, pb;
	if (tp_pack(&log->mem, a, ka, TP_RUN, &pa)) return 0;
	if (tp_pack(&log->mem, b, kb, TP_RUN, &pb)) return tp_span_free(&log->mem, &pa), 0;
	tp_put_head(m, 4, 6), tp_put_text(m, "fork");
	tp_put_head(m, 2, 32), tp_put(m, device, 32);
	tp_put_head(m, 2, 64), tp_put(m, siga, 64), tp_put(m, pa.p, pa.n);
	tp_put_head(m, 2, 64), tp_put(m, sigb, 64), tp_put(m, pb.p, pb.n);
	tp_span_free(&log->mem, &pa), tp_span_free(&log->mem, &pb);
	return !tp_buf_why(m);
}

// two tails of device: a fork if they check and differ at the same n. came: the proof as it came,
// or p NULL to make it. 1 if learned.
static int learn(tp_log *log, const uint8_t device[32], const tp_span *a, size_t ka, const uint8_t siga[64],
	const tp_span *b, size_t kb, const uint8_t sigb[64], tp_span came) {
	uint64_t na, nb;
	uint8_t ha[32], hb[32];
	size_t ba, bb;
	if (tp_log_forked(log, device) || !tp_log_count(log, device)) return 0;
	if (!tail(log, device, a, ka, siga, &na, ha, &ba) || !tail(log, device, b, kb, sigb, &nb, hb, &bb)) return 0;
	if (na != nb || !memcmp(ha, hb, 32) || log->proved + ba + bb > log->limits.forks) return 0;
	int low = memcmp(ha, hb, 32) < 0;
	tp_buf m = {NULL, 0, 0, 2 * TP_RUN + 1024, &log->mem, 0};
	if (!came.p) {
		int ok = low ? proof(log, device, a, ka, siga, b, kb, sigb, &m)
			     : proof(log, device, b, kb, sigb, a, ka, siga, &m);
		if (!ok) return tp_buf_free(&m), 0;
	}
	if (log->nforks == log->forkroom) {
		size_t room = log->forkroom ? 2 * log->forkroom : 4;
		fork *q = tp_grow(&log->mem, log->forks, log->forkroom * sizeof *q, room * sizeof *q);
		if (!q) return tp_buf_free(&m), 0;
		log->forks = q, log->forkroom = room;
	}
	size_t length = came.p ? came.n : m.len;
	uint8_t *copy = tp_alloc(&log->mem, length);
	if (!copy) return tp_buf_free(&m), 0;
	memcpy(copy, came.p ? came.p : m.p, length);
	tp_buf_free(&m);
	fork *f = &log->forks[log->nforks];
	memcpy(f->device, device, 32), f->n = na, f->message = copy, f->length = length;
	memcpy(f->hashes, low ? ha : hb, 32), memcpy(f->hashes + 32, low ? hb : ha, 32);
	log->nforks++, log->proved += ba + bb;
	if (log->forked) log->forked(log->ctx, log->nforks - 1);
	return 1;
}

int tp_log_fork(tp_log *log, tp_span message) {
	tp_in in = {message.p, message.p + message.n};
	uint64_t k;
	tp_span t, device, siga, sigb, pa, pb;
	tp_steps sa, sb;
	if (!tp_canonical(message.p, message.n) || tp_array(&in, &k) || k != 6 || tp_text(&in, &t) ||
		!tp_is(t, "fork") || tp_bytes(&in, 32, &device) || tp_bytes(&in, 64, &siga) ||
		tp_skip(&in, &pa) || tp_bytes(&in, 64, &sigb) || tp_skip(&in, &pb) || in.p != in.end) {
		return 0;
	}
	if (tp_unpack(&log->mem, pa, TP_RUN, &sa)) return 0;
	int ok = 0;
	if (!tp_unpack(&log->mem, pb, TP_RUN, &sb)) {
		tp_span *sp = tp_alloc(&log->mem, (sa.count + sb.count) * sizeof *sp);
		if (sp) {
			for (size_t i = 0; i < sa.count; i++) sp[i] = (tp_span){sa.bytes + sa.at[i], sa.at[i + 1] - sa.at[i]};
			for (size_t i = 0; i < sb.count; i++) {
				sp[sa.count + i] = (tp_span){sb.bytes + sb.at[i], sb.at[i + 1] - sb.at[i]};
			}
			ok = learn(log, device.p, sp, sa.count, siga.p, sp + sa.count, sb.count, sigb.p, message);
			tp_free(&log->mem, sp, (sa.count + sb.count) * sizeof *sp);
		}
		tp_steps_free(&log->mem, &sb);
	}
	tp_steps_free(&log->mem, &sa);
	return ok;
}

// A run meeting what is held, with another hash where they meet: two signed chains, a proof from
// that step. 1: a fork. 2: not one, the run is not signed as it is. 0: the same chain.
static int clash(tp_log *log, const uint8_t device[32], const tp_span *steps, size_t k, const uint8_t sig[64]) {
	const feed *f = find(log, device);
	tp_step s;
	if (!f || tp_step_decode(steps[0].p, steps[0].n, &s) || s.n > f->count) return 0;
	uint64_t first = s.n, m = first + k - 1 < f->count ? first + k - 1 : f->count;
	uint8_t held[32], mine[32], head[32];
	uint64_t n;
	size_t bytes;
	int signed_ = -1;
	tp_step_hash(steps[m - first].p, steps[m - first].n, mine);
	// what costs reads of held steps, or closing the open run, needs the run's own chain and
	// signature good first
	if (m == f->count) {
		if (!memcmp(mine, f->last, 32)) return 0;
	} else {
		if (!(signed_ = tail(log, device, steps, k, sig, &n, head, &bytes))) return 0;
		long length = tp_log_step(log, device, m, NULL, 0);
		uint8_t *b = length > 0 ? tp_alloc(&log->mem, (size_t)length) : NULL;
		if (!b) return 0;
		int got = tp_log_step(log, device, m, b, (size_t)length) == length;
		if (got) tp_step_hash(b, (size_t)length, held);
		tp_free(&log->mem, b, (size_t)length);
		if (!got || !memcmp(held, mine, 32)) return 0;
	}
	if (signed_ < 0) signed_ = tail(log, device, steps, k, sig, &n, head, &bytes);
	if (!signed_) return m == f->count ? 2 : 0;
	if (tp_log_forked(log, device)) return 1;
	uint64_t to;
	uint8_t hsig[64];
	if (tp_log_run(log, device, m, &to, hsig)) return 2;
	size_t count = (size_t)(to - m + 1);
	tp_buf bytes_ = {NULL, 0, 0, TP_RUN, &log->mem, 0};
	tp_span *spans = tp_alloc(&log->mem, count * sizeof *spans);
	int ok = spans != NULL;
	for (size_t i = 0; ok && i < count; i++) {
		long length = tp_log_step(log, device, m + i, NULL, 0);
		uint8_t *p = length < 0 ? NULL : tp_reserve(&bytes_, (size_t)length);
		ok = p && tp_log_step(log, device, m + i, p, (size_t)length) == length;
		spans[i] = (tp_span){NULL, (size_t)length};
	}
	for (size_t i = 0, at = 0; ok && i < count; at += spans[i++].n) spans[i].p = bytes_.p + at;
	if (ok) ok = learn(log, device, spans, count, hsig, steps + (m - first), k - (size_t)(m - first), sig, (tp_span){NULL, 0});
	if (spans) tp_free(&log->mem, spans, count * sizeof *spans);
	tp_buf_free(&bytes_);
	return ok ? 1 : 2;
}

long tp_log_take(tp_log *log, const uint8_t device[32], const tp_span *steps, size_t n,
	const uint8_t sig[64], tp_span came) {
	if (!n) return own(log, device) ? TP_OWN : 0;
	int split = clash(log, device, steps, n, sig);
	if (own(log, device)) return TP_OWN;
	if (split) return split == 1 ? TP_FORK : TP_SIGNATURE;
	uint64_t held = tp_log_count(log, device), high;
	uint8_t last[32];
	long fresh = chain(log, device, steps, n, 1, last, &high);
	if (fresh <= 0) return fresh;
	if (!tp_verify(device, last, 32, sig)) return TP_SIGNATURE;
	int why;
	feed *f = fit(log, device, (size_t)fresh, &why);
	// the record: its steps packed, within this device's limit, and its head and prior
	tp_buf b = {NULL, 0, 0, log->limits.step + TP_HEAD + TP_PRIOR, &log->mem, 0};
	tp_prior prior;
	int against = held && !tp_log_prior(log, device, held, &prior);
	if (why) f = NULL;
	if (f && ((size_t)fresh < n || !came.p)) why = message(log, device, sig, steps + n - fresh, (size_t)fresh, against ? &prior : NULL, &b);
	else if (f) {
		b.max = came.n + TP_PRIOR, recorded(&b, came.p, came.n, &prior), why = tp_buf_why(&b);
		if (!why && *b.p == 0x85 && !against) why = TP_BEFORE;
	}
	tp_at at = {device, held + 1, held + (uint64_t)fresh};
	if (!why) why = log->store->append(log->store->self, b.p, b.len, &at);
	tp_buf_free(&b);
	if (why) return why;
	keep(log, f, steps + n - fresh, (size_t)fresh, last, high);
	tell(log, device, held + 1, (size_t)fresh);
	return fresh;
}

int tp_log_snapshot(tp_log *log, const uint8_t *bytes, size_t length) {
	tp_store *st = log->store;
	return st->snapshot ? st->snapshot(st->self, bytes, length) : TP_STORE;
}

long tp_log_snapped(const tp_log *log, uint8_t *out, size_t cap) {
	const tp_store *st = log->store;
	return st->snapped ? st->snapped(st->self, out, cap) : -1;
}

int tp_log_drop(tp_log *log, const uint8_t device[32], uint64_t n) {
	tp_store *st = log->store;
	if (!n || !st->drop || st->drop(st->self, device, n) <= 0) return 0;
	uint8_t record[48];
	tp_buf b = {record, 0, sizeof record, sizeof record, NULL, 0};
	tp_put_head(&b, 4, 3), tp_put_text(&b, "drop");
	tp_put_head(&b, 2, 32), tp_put(&b, device, 32), tp_put_head(&b, 0, n);
	return st->append(st->self, record, b.len, NULL);
}

static int dropped(tp_log *log, const uint8_t *r, size_t length) {
	tp_in in = {r, r + length};
	tp_span t, device;
	uint64_t k, n;
	if (!length || *r != 0x83) return 0;
	if (!tp_array(&in, &k) && !tp_text(&in, &t) && tp_is(t, "drop") && !tp_bytes(&in, 32, &device) &&
		!tp_whole(&in, &n) && log->store->drop)
		log->store->drop(log->store->self, device.p, n);
	return 1;
}

static int loaded(void *ctx, const uint8_t *r, size_t length, tp_at *at) {
	tp_log *log = ctx;
	if (dropped(log, r, length)) return 0;
	tp_steps steps = {0};
	tp_span one = {r, length}, *spans = &one;
	size_t k = 1;
	int run = tp_is_run(r, length);
	if (run) {
		if (tp_record_unpack(&log->mem, r, length, EVERY * log->limits.step, &steps)) return 0;
		k = steps.count;
		if (!(spans = tp_alloc(&log->mem, k * sizeof *spans))) return tp_steps_free(&log->mem, &steps), 0;
		for (size_t i = 0; i < k; i++) {
			spans[i] = (tp_span){steps.bytes + steps.at[i], steps.at[i + 1] - steps.at[i]};
		}
	}
	tp_step s;
	uint64_t high;
	uint8_t last[32];
	int ok = !tp_step_decode(spans[0].p, spans[0].n, &s) && (run || own(log, s.device));
	const uint8_t *device = run ? r + 7 : s.device;
	long fresh = ok ? chain(log, device, spans, k, 1, last, &high) : -1;
	int why = 0;
	feed *f = fresh > 0 ? fit(log, device, (size_t)fresh, &why) : NULL;
	if (f) keep(log, f, spans + k - fresh, (size_t)fresh, last, high);
	ok = (run ? fresh >= 0 : fresh > 0) && !why;
	if (ok) {
		at->device = device, at->first = s.n, at->last = s.n + k - 1;
		if (run && own(log, device) && at->last > log->closed) log->closed = at->last;
	}
	if (run) tp_free(&log->mem, spans, k * sizeof *spans), tp_steps_free(&log->mem, &steps);
	return ok;
}

int tp_log_load(tp_log *log) {
	if (log->seeded) {
		uint8_t key[32];
		int why = log->store->key(log->store->self, log->seed, key);
		if (why) return why;
		if (log->strict && memcmp(key, log->seed, 32)) return TP_KEY;
		tp_key_of(&log->key, key);
		log->keyed = 1;
		memset(key, 0, sizeof key);
	}
	int why = log->store->load(log->store->self, loaded, log);
	if (why) return why;
	log->asked = log->closed;
	return 0;
}
