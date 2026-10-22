// the log (typescript/log.ts): every device's steps this device holds, in order, and the
// signatures over their runs (../WIRE.md runs). the steps' bytes stay in the store; in memory, per
// device, only each step's hash and the signatures. tippet.h says how it's used
#include <string.h>

#include "wire.h"

// a run is closed at this many steps, or bytes of them; lamports may go this far past the highest
#define EVERY 32
#define BYTES 2048
#define JUMP (1ull << 20)

typedef struct {
	uint64_t n;
	uint8_t sig[64];
} signed_at;

// a device's step hashes (count of them) and the signatures over them, by n; top: the highest
typedef struct {
	uint8_t device[32];
	uint8_t (*hashes)[32];
	uint64_t count, room;
	signed_at *sigs;
	size_t nsigs, sigroom;
	uint64_t top;
} feed;

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
	// this device's highest step asked to be signed, and the bytes written since
	uint64_t asked, loose;
	tp_told told;
	void *ctx;
	// one step's bytes, written here
	tp_buf scratch;
};

tp_log *tp_log_new(const tp_log_options *o) {
	tp_log *log = tp_alloc(&o->mem, sizeof *log);
	if (!log) return NULL;
	memset(log, 0, sizeof *log);
	log->mem = o->mem, log->store = o->store, log->limits = o->limits;
	if (!log->limits.devices) log->limits.devices = 4096;
	if (!log->limits.steps) log->limits.steps = 1 << 24;
	if (!log->limits.step) log->limits.step = 1 << 20;
	if (o->seed) memcpy(log->seed, o->seed, 32), log->seeded = 1;
	log->strict = o->strict, log->told = o->told, log->ctx = o->ctx;
	log->scratch.mem = &log->mem, log->scratch.max = log->limits.step;
	return log;
}

void tp_log_free(tp_log *log) {
	if (!log) return;
	tp_mem mem = log->mem;
	for (size_t i = 0; i < log->nfeeds; i++) {
		feed *f = &log->feeds[i];
		tp_free(&mem, f->hashes, f->room * 32);
		tp_free(&mem, f->sigs, f->sigroom * sizeof *f->sigs);
	}
	tp_free(&mem, log->feeds, log->feedroom * sizeof *log->feeds);
	tp_buf_free(&log->scratch);
	if (log->store) log->store->close(log->store->self);
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

static int own(const tp_log *log, const uint8_t device[32]) {
	return log->keyed && !memcmp(device, log->key.pub, 32);
}

uint64_t tp_log_count(const tp_log *log, const uint8_t device[32]) {
	const feed *f = find(log, device);
	return f ? f->count : 0;
}

size_t tp_log_devices(const tp_log *log) { return log->nfeeds; }

const uint8_t *tp_log_have(const tp_log *log, size_t i, uint64_t *have) {
	const feed *f = &log->feeds[i];
	*have = own(log, f->device) ? f->count : f->top;
	return f->device;
}

long tp_log_step(const tp_log *log, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	return log->store->get(log->store->self, device, n, out, cap);
}

// where the first signature at n or past it is
static size_t from(const feed *f, uint64_t n) {
	size_t lo = 0, hi = f->nsigs;
	while (lo < hi) {
		size_t mid = lo + (hi - lo) / 2;
		if (f->sigs[mid].n < n) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

// room for k more hashes and one more signature: what follows can't fail
static int fit(tp_log *log, feed *f, uint64_t k) {
	if (k > log->limits.steps - f->count) return TP_BOUND;
	if (f->count + k > f->room) {
		uint64_t room = f->room ? f->room : 16;
		while (room < f->count + k) room *= 2;
		if (room > log->limits.steps) room = log->limits.steps;
		void *q = tp_grow(&log->mem, f->hashes, (size_t)f->room * 32, (size_t)room * 32);
		if (!q) return TP_NOMEM;
		f->hashes = q, f->room = room;
	}
	if (f->nsigs == f->sigroom) {
		size_t room = f->sigroom ? 2 * f->sigroom : 4;
		signed_at *q = tp_grow(&log->mem, f->sigs, f->sigroom * sizeof *q, room * sizeof *q);
		if (!q) return TP_NOMEM;
		f->sigs = q, f->sigroom = room;
	}
	return 0;
}

static int vouch(tp_log *log, feed *f, uint64_t n, const uint8_t sig[64]) {
	size_t i = from(f, n);
	if (i < f->nsigs && f->sigs[i].n == n) {
		memcpy(f->sigs[i].sig, sig, 64);
		return 0;
	}
	int why = fit(log, f, 0);
	if (why) return why;
	memmove(&f->sigs[i + 1], &f->sigs[i], (f->nsigs - i) * sizeof *f->sigs);
	f->sigs[i].n = n;
	memcpy(f->sigs[i].sig, sig, 64);
	f->nsigs++;
	if (n > f->top) f->top = n;
	return 0;
}

// 1: s is step n, after before (NULL: none)
static int follows(const tp_step *s, uint64_t n, const uint8_t *before) {
	return s->n == n && (s->before == NULL) == (before == NULL) &&
		(!before || !memcmp(s->before, before, 32));
}

// a hash at the end of a feed's
static int push(tp_log *log, feed *f, const uint8_t hash[32]) {
	int why = fit(log, f, 1);
	if (!why) memcpy(f->hashes[f->count++], hash, 32);
	return why;
}

// a signature's record, as typescript/log.ts writes one: {device: hex, n, sig}
static int save(tp_log *log, const uint8_t device[32], uint64_t n, const uint8_t sig[64]) {
	uint8_t record[160];
	char text[64];
	tp_buf b = {record, 0, sizeof record, sizeof record, NULL, 0};
	tp_hex(text, device, 32);
	tp_put_head(&b, 5, 3);
	tp_put_text(&b, "n"), tp_put_head(&b, 0, n);
	tp_put_text(&b, "sig"), tp_put_head(&b, 2, 64), tp_put(&b, sig, 64);
	tp_put_text(&b, "device"), tp_put_head(&b, 3, 64), tp_put(&b, text, 64);
	return log->store->append(log->store->self, record, b.len, NULL);
}

// this device's step n signed and kept; saved if it can be (else signed again after a load)
static int sign(tp_log *log, uint64_t n) {
	feed *f = find(log, log->key.pub);
	if (n == f->count) log->loose = 0;
	if (n > log->asked) log->asked = n;
	size_t i = from(f, n);
	if (i < f->nsigs && f->sigs[i].n == n) return 0;
	uint8_t sig[64];
	tp_sign(&log->key, f->hashes[n - 1], 32, sig);
	int why = vouch(log, f, n, sig);
	if (!why) save(log, f->device, n, sig);
	return why;
}

// told a copy of device: what it does may move the log's own
static void tell(tp_log *log, const uint8_t device[32], uint64_t from, size_t count) {
	uint8_t d[32];
	memcpy(d, device, 32);
	if (log->told && count) log->told(log->ctx, d, from, count);
}

int tp_log_write(tp_log *log, const tp_write *w, uint64_t *n, uint64_t *lamport) {
	if (!log->keyed) return TP_NOKEY;
	if (log->lamport >= TP_WHOLE) return TP_END;
	feed *f = make(log, log->key.pub);
	if (!f) return log->nfeeds == log->limits.devices ? TP_BOUND : TP_NOMEM;
	if (f->count >= log->limits.steps) return TP_BOUND;
	tp_step s = {{0}, log->key.pub, f->count + 1, f->count ? f->hashes[f->count - 1] : NULL,
		w->node, w->part, w->patches, w->who, 0, log->lamport + 1, w->when};
	// written, then read as a step: one that isn't one is never kept
	size_t length = tp_step_encode(&s, NULL, 0);
	log->scratch.len = 0;
	uint8_t *bytes = tp_reserve(&log->scratch, length);
	if (!bytes) return tp_buf_why(&log->scratch);
	tp_step_encode(&s, bytes, length);
	tp_step check;
	if (tp_step_decode(bytes, length, &check)) return TP_NOTSTEP;
	uint8_t hash[32];
	tp_step_hash(bytes, length, hash);
	tp_at at = {log->key.pub, s.n};
	// room, then the store, then the log: once the step is out, nothing fails
	int why = fit(log, f, 1);
	if (why || (why = log->store->append(log->store->self, bytes, length, &at))) return why;
	push(log, f, hash);
	log->lamport = s.lamport;
	log->loose += length;
	if (s.n - log->asked >= EVERY || log->loose >= BYTES) sign(log, s.n);
	*n = s.n, *lamport = s.lamport;
	tell(log, log->key.pub, s.n, 1);
	return 0;
}

int tp_log_run(tp_log *log, const uint8_t device[32], uint64_t at, uint64_t *to, uint8_t sig[64]) {
	feed *f = find(log, device);
	if (!f || at < 1 || at > f->count) return 1;
	size_t i = from(f, at);
	if (i == f->nsigs) {
		if (!own(log, device) || sign(log, f->count)) return 1;
		i = from(f, at);
	}
	*to = f->sigs[i].n;
	memcpy(sig, f->sigs[i].sig, 64);
	return 0;
}

long tp_log_take(tp_log *log, const uint8_t device[32], const tp_span *steps, size_t n,
	const uint8_t sig[64]) {
	if (own(log, device)) return TP_OWN;
	if (!n) return 0;
	// no feed is made for a device until its steps check out
	feed *f = find(log, device);
	uint64_t held = f ? f->count : 0;
	tp_step s;
	if (tp_step_decode(steps[0].p, steps[0].n, &s)) return TP_CHAIN;
	uint64_t first = s.n, last = first + n - 1;
	if (first > held + 1) return TP_GAP;
	size_t skip = (size_t)(held + 1 - first), fresh = n > skip ? n - skip : 0;
	// the fresh steps' hashes, each going on from the one before; high: their highest lamport
	uint8_t(*hashes)[32] = NULL;
	if (fresh && !(hashes = tp_alloc(&log->mem, fresh * 32))) return TP_NOMEM;
	long why = 0;
	uint64_t high = 0;
	const uint8_t *before = held ? f->hashes[held - 1] : NULL;
	for (size_t i = 0; i < fresh && !why; i++) {
		const tp_span *b = &steps[skip + i];
		if (tp_step_decode(b->p, b->n, &s) || memcmp(s.device, device, 32) ||
			!follows(&s, held + 1 + i, before))
			why = TP_CHAIN;
		if (s.lamport > high) high = s.lamport;
		tp_step_hash(b->p, b->n, hashes[i]);
		before = hashes[i];
	}
	// lamport near what is held, once the chain holds
	if (!why && high > log->lamport + JUMP) why = TP_LAMPORT;
	const uint8_t *top = last <= held ? f->hashes[last - 1] : hashes[last - held - 1];
	if (!why && !fresh) {
		size_t i = from(f, last);
		uint8_t mine[32];
		tp_step_hash(steps[n - 1].p, steps[n - 1].n, mine);
		if ((i < f->nsigs && f->sigs[i].n == last) || memcmp(mine, top, 32)) goto done;
	}
	if (!why && !tp_verify(device, top, 32, sig)) why = TP_SIGNATURE;
	// room, then the store, then the log: all of the run or none of it
	if (!why && !(f = make(log, device))) why = log->nfeeds == log->limits.devices ? TP_BOUND : TP_NOMEM;
	if (!why) why = fit(log, f, fresh);
	for (size_t i = 0; i < fresh && !why; i++) {
		tp_at at = {device, held + 1 + i};
		why = log->store->append(log->store->self, steps[skip + i].p, steps[skip + i].n, &at);
	}
	if (!why) {
		if (fresh) memcpy(f->hashes[held], hashes, fresh * 32), f->count += fresh;
		vouch(log, f, last, sig);
		if (high > log->lamport) log->lamport = high;
		// the signature saved if it can be (else vouched for when it comes again)
		save(log, device, last, sig);
		tell(log, device, held + 1, fresh);
		why = (long)fresh;
	}
done:
	tp_free(&log->mem, hashes, fresh * 32);
	return why;
}

// ---- load

static int unhex(uint8_t *out, const uint8_t *s, size_t n) {
	for (size_t i = 0; i < 2 * n; i++) {
		int c = s[i], d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
		if (d < 0) return -1;
		out[i / 2] = (uint8_t)(i % 2 ? out[i / 2] << 4 | d : d);
	}
	return 0;
}

// a record: a signature's (vouched for when it is of a step held), or a step that goes on from
// what is held (kept). anything else passed over
static int loaded(void *ctx, const uint8_t *r, size_t length, tp_at *at) {
	tp_log *log = ctx;
	tp_in in = {r, r + length};
	uint64_t k, n = 0;
	if (length && *r >> 5 == 5) {
		tp_span key, device = {0}, sig = {0};
		uint8_t d[32];
		if (!tp_canonical(r, length) || tp_map(&in, &k)) return 0;
		for (uint64_t i = 0; i < k; i++) {
			if (tp_text(&in, &key)) return 0;
			if (tp_is(key, "n") ? tp_whole(&in, &n)
				: tp_is(key, "sig") ? tp_bytes(&in, 64, &sig)
				: tp_is(key, "device") ? tp_text(&in, &device)
				: tp_skip(&in, NULL))
				return 0;
		}
		if (!sig.p || device.n != 64 || unhex(d, device.p, 32)) return 0;
		feed *f = find(log, d);
		if (f && n >= 1 && n <= f->count) vouch(log, f, n, sig.p);
		return 0;
	}
	tp_step s;
	if (tp_step_decode(r, length, &s)) return 0;
	feed *f = find(log, s.device);
	uint64_t held = f ? f->count : 0;
	if (!follows(&s, held + 1, held ? f->hashes[held - 1] : NULL)) return 0;
	uint8_t hash[32];
	tp_step_hash(r, length, hash);
	if (!(f = make(log, s.device)) || push(log, f, hash)) return 0;
	if (s.lamport > log->lamport) log->lamport = s.lamport;
	at->device = s.device, at->n = s.n;
	return 1;
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
	feed *f = log->keyed ? find(log, log->key.pub) : NULL;
	log->asked = f ? f->top : 0;
	return 0;
}
