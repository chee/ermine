// a log's store in memory: its records as frames back to back, as the file store keeps them on
// disk, where each record holding steps is, and the snapshot
#include <string.h>

#include "store.h"
#include "wire.h"

int tp_is_run(const uint8_t *r, size_t length) {
	return length > TP_HEAD && !memcmp(r, "\x84\x63run\x58\x20", 7) && !memcmp(r + 39, "\x58\x40", 2);
}

int tp_index_hold(tp_index *x, const tp_at *at, uint64_t offset, uint64_t length, int run) {
	tp_place *p = NULL;
	for (size_t i = 0; i < x->count && !p; i++) {
		if (!memcmp(x->places[i].device, at->device, 32)) p = &x->places[i];
	}
	if (!p) {
		if (x->count == x->room) {
			size_t room = x->room ? 2 * x->room : 4;
			tp_place *q = tp_grow(x->mem, x->places, x->room * sizeof *q, room * sizeof *q);
			if (!q) return TP_NOMEM;
			x->places = q, x->room = room;
		}
		p = &x->places[x->count++];
		memset(p, 0, sizeof *p);
		memcpy(p->device, at->device, 32);
	}
	if (p->count == p->room) {
		size_t room = p->room ? 2 * p->room : 4;
		tp_held *q = tp_grow(x->mem, p->held, p->room * sizeof *q, room * sizeof *q);
		if (!q) return TP_NOMEM;
		p->held = q, p->room = room;
	}
	// those it covers, i up to j, out; it in their place
	size_t i = p->count, j;
	while (i > 0 && p->held[i - 1].first >= at->first) i--;
	for (j = i; j < p->count && p->held[j].last <= at->last; j++) {}
	memmove(&p->held[i + 1], &p->held[j], (p->count - j) * sizeof *p->held);
	p->count = p->count + 1 - (j - i);
	p->held[i] = (tp_held){at->first, at->last, offset, (uint32_t)length, (uint32_t)!!run};
	return 0;
}

const tp_held *tp_index_find(const tp_index *x, const uint8_t device[32], uint64_t n) {
	for (size_t i = 0; i < x->count; i++) {
		const tp_place *p = &x->places[i];
		if (memcmp(p->device, device, 32)) continue;
		size_t lo = 0, hi = p->count;
		while (lo < hi) {
			size_t mid = lo + (hi - lo) / 2;
			if (p->held[mid].first <= n) lo = mid + 1;
			else hi = mid;
		}
		return lo && n <= p->held[lo - 1].last ? &p->held[lo - 1] : NULL;
	}
	return NULL;
}

int tp_index_read(const tp_index *x, const uint8_t device[32], uint64_t n) {
	return x->steps.count && !memcmp(x->device, device, 32) && n >= x->first &&
		n - x->first < x->steps.count;
}

long tp_index_step(tp_index *x, const uint8_t device[32], uint64_t n, const tp_held *r,
	const uint8_t *record, uint8_t *out, size_t cap) {
	const uint8_t *p = record;
	size_t length = r->length;
	if (r->run) {
		if (!tp_index_read(x, device, n)) {
			tp_steps_free(x->mem, &x->steps);
			tp_span pack = {record + TP_HEAD, r->length - TP_HEAD};
			if (tp_unpack(x->mem, pack, x->max, &x->steps)) return -1;
			memcpy(x->device, device, 32), x->first = r->first;
			if (!tp_index_read(x, device, n)) return -1;
		}
		size_t i = (size_t)(n - x->first);
		p = x->steps.bytes + x->steps.at[i], length = x->steps.at[i + 1] - x->steps.at[i];
	}
	if (out && length <= cap) memcpy(out, p, length);
	return (long)length;
}

void tp_index_clear(tp_index *x) {
	for (size_t i = 0; i < x->count; i++) {
		tp_free(x->mem, x->places[i].held, x->places[i].room * sizeof(tp_held));
	}
	tp_free(x->mem, x->places, x->room * sizeof *x->places);
	tp_steps_free(x->mem, &x->steps);
	x->places = NULL, x->count = x->room = 0;
}

long tp_index_drop(tp_index *x, const uint8_t device[32], uint64_t n) {
	for (size_t i = 0; i < x->count; i++) {
		tp_place *p = &x->places[i];
		if (memcmp(p->device, device, 32)) continue;
		size_t k = 0;
		while (k < p->count && p->held[k].last <= n) k++;
		memmove(p->held, p->held + k, (p->count - k) * sizeof *p->held);
		p->count -= k;
		return (long)k;
	}
	return 0;
}

// ---- in memory

typedef struct {
	tp_store store;
	tp_mem mem;
	tp_index index;
	tp_buf frames, snap;
	uint8_t key[32];
	int keyed;
} memory;

static int load(void *self, tp_read read, void *ctx) {
	memory *m = self;
	tp_index_clear(&m->index);
	for (size_t at = 0; at + 4 <= m->frames.len;) {
		const uint8_t *f = m->frames.p + at;
		size_t length = tp_get32(f);
		if (length > m->frames.len - at - 4) break;
		tp_at step;
		if (read(ctx, f + 4, length, &step)) {
			int why = tp_index_hold(&m->index, &step, at + 4, length, tp_is_run(f + 4, length));
			if (why) return why;
		}
		at += 4 + length;
	}
	return 0;
}

static int append(void *self, const uint8_t *record, size_t length, const tp_at *at) {
	memory *m = self;
	uint8_t head[4];
	size_t offset = m->frames.len + 4;
	if (length > 0xffffffffu) return TP_BOUND;
	tp_set32(head, (uint32_t)length);
	tp_put(&m->frames, head, 4);
	tp_put(&m->frames, record, length);
	int why = tp_buf_why(&m->frames);
	if (why) {
		// what didn't fit is not there
		m->frames.bad = 0, m->frames.len = offset - 4;
		return why;
	}
	return at ? tp_index_hold(&m->index, at, offset, length, tp_is_run(record, length)) : 0;
}

static long get(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	memory *m = self;
	const tp_held *r = tp_index_find(&m->index, device, n);
	return r ? tp_index_step(&m->index, device, n, r, m->frames.p + r->offset, out, cap) : -1;
}

static long run(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap,
	uint64_t *first, uint64_t *last) {
	memory *m = self;
	const tp_held *r = tp_index_find(&m->index, device, n);
	if (!r) return -1;
	*first = r->first, *last = r->last;
	if (out) memcpy(out, m->frames.p + r->offset, r->length < cap ? r->length : cap);
	return (long)r->length;
}

// one that doesn't fit: none
static int snapshot(void *self, const uint8_t *bytes, size_t length) {
	memory *m = self;
	m->snap.len = 0, m->snap.bad = 0;
	tp_put(&m->snap, bytes, length);
	int why = tp_buf_why(&m->snap);
	if (why) m->snap.len = 0;
	return why;
}

static long snapped(void *self, uint8_t *out, size_t cap) {
	memory *m = self;
	if (!m->snap.len) return -1;
	if (m->snap.len <= cap) memcpy(out, m->snap.p, m->snap.len);
	return (long)m->snap.len;
}

static int key(void *self, const uint8_t seed[32], uint8_t out[32]) {
	memory *m = self;
	if (!m->keyed) memcpy(m->key, seed, 32), m->keyed = 1;
	memcpy(out, m->key, 32);
	return 0;
}

// forgetting: the bytes stay (this store's records are its memory)
static long drop(void *self, const uint8_t device[32], uint64_t n) {
	return tp_index_drop(&((memory *)self)->index, device, n);
}

static void shut(void *self) {
	memory *m = self;
	tp_mem mem = m->mem;
	tp_index_clear(&m->index);
	tp_buf_free(&m->frames), tp_buf_free(&m->snap);
	tp_free(&mem, m, sizeof *m);
}

tp_store *tp_memory_store(const tp_mem *mem, size_t max) {
	memory *m = tp_alloc(mem, sizeof *m);
	if (!m) return NULL;
	memset(m, 0, sizeof *m);
	m->mem = *mem;
	m->index.mem = &m->mem, m->index.max = max;
	m->frames.mem = &m->mem, m->frames.max = max;
	m->snap.mem = &m->mem, m->snap.max = max;
	m->store = (tp_store){m, load, append, get, run, snapshot, snapped, key, NULL, shut, drop};
	return &m->store;
}
