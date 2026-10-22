// a log's store in memory: its records as frames back to back, as the file store keeps them on
// disk, and where each step is
#include <string.h>

#include "store.h"
#include "wire.h"

int tp_index_hold(tp_index *x, const tp_at *at, uint64_t offset, uint64_t length) {
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
	if (at->n < 1 || at->n > p->count + 1) return TP_BOUND;
	if (at->n == p->count + 1) {
		if (p->count == p->room) {
			size_t room = p->room ? 2 * p->room : 16, each = 2 * sizeof *p->where;
			uint64_t *q = tp_grow(x->mem, p->where, p->room * each, room * each);
			if (!q) return TP_NOMEM;
			p->where = q, p->room = room;
		}
		p->count++;
	}
	p->where[2 * at->n - 2] = offset, p->where[2 * at->n - 1] = length;
	return 0;
}

int tp_index_find(const tp_index *x, const uint8_t device[32], uint64_t n, uint64_t *offset,
	uint64_t *length) {
	for (size_t i = 0; i < x->count; i++) {
		const tp_place *p = &x->places[i];
		if (memcmp(p->device, device, 32)) continue;
		if (n < 1 || n > p->count) return -1;
		*offset = p->where[2 * n - 2], *length = p->where[2 * n - 1];
		return 0;
	}
	return -1;
}

void tp_index_clear(tp_index *x) {
	for (size_t i = 0; i < x->count; i++) {
		tp_free(x->mem, x->places[i].where, x->places[i].room * 2 * sizeof(uint64_t));
	}
	tp_free(x->mem, x->places, x->room * sizeof *x->places);
	x->places = NULL, x->count = x->room = 0;
}

// ---- in memory

typedef struct {
	tp_store store;
	tp_mem mem;
	tp_index index;
	tp_buf frames;
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
			int why = tp_index_hold(&m->index, &step, at + 4, length);
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
	return at ? tp_index_hold(&m->index, at, offset, length) : 0;
}

static long get(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	memory *m = self;
	uint64_t offset, length;
	if (tp_index_find(&m->index, device, n, &offset, &length)) return -1;
	if (length <= cap) memcpy(out, m->frames.p + offset, (size_t)length);
	return (long)length;
}

static int key(void *self, const uint8_t seed[32], uint8_t out[32]) {
	memory *m = self;
	if (!m->keyed) memcpy(m->key, seed, 32), m->keyed = 1;
	memcpy(out, m->key, 32);
	return 0;
}

static void shut(void *self) {
	memory *m = self;
	tp_mem mem = m->mem;
	tp_index_clear(&m->index);
	tp_buf_free(&m->frames);
	tp_free(&mem, m, sizeof *m);
}

tp_store *tp_memory_store(const tp_mem *mem, size_t max) {
	memory *m = tp_alloc(mem, sizeof *m);
	if (!m) return NULL;
	memset(m, 0, sizeof *m);
	m->mem = *mem;
	m->index.mem = &m->mem;
	m->frames.mem = &m->mem, m->frames.max = max;
	m->store = (tp_store){m, load, append, get, key, shut};
	return &m->store;
}
