// The keyed index and createSelector (selector.h), in C.
#include "selector.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ptrmap.h"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("selector: out of memory\n", stderr);
		abort();
	}
	return p;
}

// the holders of one key
typedef struct {
	const sx_holder **v;
	size_t n, cap;
} bucket;

typedef struct {
	const sx_holder *h;
	const void *key;
	// the next pair of the same holder, or SIZE_MAX
	size_t next;
	int first;
} pair;

// what one mark's telling uses: kept between marks, so a mark allocates nothing once it has grown
typedef struct {
	pair *pairs;
	size_t cap;
	// holder -> its latest pair + 1
	pm last;
	const void **list;
	size_t caplist;
} scratch;

static void scratch_free(scratch *z) {
	free(z->pairs);
	free(z->list);
	pm_clear(&z->last);
	*z = (scratch){0};
}

struct sx_index {
	sc_scheduler *s;
	sc_listener *on_mark, *on_end;
	// key -> bucket
	pm held;
	size_t told;
	size_t refs;
	sx_index *next;
	// a marked may mark again: that telling takes a scratch of its own
	scratch z;
	bool busy;
};

// the index of each scheduler that has one
static sx_index *indexes;

static void bucket_free(bucket *b) {
	free(b->v);
	free(b);
}

void sx_hold(sx_index *x, const void *key, const sx_holder *h) {
	bucket *b = pm_get(&x->held, key);
	if (b == NULL) {
		b = xalloc(sizeof *b);
		pm_set(&x->held, key, b);
	}
	for (size_t i = 0; i < b->n; i++) {
		if (b->v[i] == h) return;
	}
	if (b->n == b->cap) {
		b->cap = b->cap ? b->cap * 2 : 2;
		b->v = realloc(b->v, b->cap * sizeof *b->v);
		if (b->v == NULL) abort();
	}
	b->v[b->n++] = h;
}

void sx_drop(sx_index *x, const void *key, const sx_holder *h) {
	bucket *b = pm_get(&x->held, key);
	if (b == NULL) return;
	for (size_t i = 0; i < b->n; i++) {
		if (b->v[i] != h) continue;
		memmove(&b->v[i], &b->v[i + 1], (b->n - i - 1) * sizeof *b->v);
		b->n--;
		break;
	}
	if (b->n == 0) {
		pm_delete(&x->held, key);
		bucket_free(b);
	}
}

size_t sx_deliveries(const sx_index *x) { return x->told; }

static void heard_mark(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data) {
	(void)due, (void)ndue;
	sx_index *x = data;
	if (x->held.count == 0) return;
	scratch own = {0};
	scratch *z = x->busy ? &own : &x->z;
	if (z == &x->z) x->busy = true;
	size_t n = 0;
	for (size_t i = 0; i < nkeys; i++) {
		bucket *b = pm_get(&x->held, keys[i]);
		if (b == NULL) continue;
		for (size_t j = 0; j < b->n; j++) {
			if (n == z->cap) {
				z->cap = z->cap ? z->cap * 2 : 8;
				z->pairs = realloc(z->pairs, z->cap * sizeof *z->pairs);
				if (z->pairs == NULL) abort();
			}
			z->pairs[n] = (pair){b->v[j], keys[i], SIZE_MAX, 0};
			size_t before = (size_t)(uintptr_t)pm_get(&z->last, b->v[j]);
			if (before == 0) z->pairs[n].first = 1;
			else z->pairs[before - 1].next = n;
			pm_set(&z->last, b->v[j], (void *)(uintptr_t)(n + 1));
			n++;
		}
	}
	pm_reset(&z->last);
	for (size_t i = 0; i < n; i++) {
		if (!z->pairs[i].first) continue;
		size_t m = 0;
		for (size_t j = i; j != SIZE_MAX; j = z->pairs[j].next) {
			if (m == z->caplist) {
				z->caplist = z->caplist ? z->caplist * 2 : 8;
				z->list = realloc(z->list, z->caplist * sizeof *z->list);
				if (z->list == NULL) abort();
			}
			z->list[m++] = z->pairs[j].key;
		}
		x->told++;
		if (z->pairs[i].h->marked != NULL) {
			z->pairs[i].h->marked(z->pairs[i].h->data, z->list, m, run, tick);
		}
	}
	if (z == &own) scratch_free(&own);
	else x->busy = false;
}

static void heard_end(const void *key, void *data) {
	sx_index *x = data;
	bucket *b = pm_get(&x->held, key);
	if (b == NULL) return;
	// a copy: an ended may drop
	size_t n = b->n;
	const sx_holder *few[8];
	const sx_holder **v = n <= sizeof few / sizeof *few ? few : xalloc(n * sizeof *v);
	memcpy(v, b->v, n * sizeof *v);
	for (size_t i = 0; i < n; i++) {
		if (v[i]->ended != NULL) v[i]->ended(v[i]->data, key);
	}
	if (v != few) free(v);
}

sx_index *sx_index_get(sc_scheduler *s) {
	for (sx_index *x = indexes; x != NULL; x = x->next) {
		if (x->s == s) {
			x->refs++;
			return x;
		}
	}
	sx_index *x = xalloc(sizeof *x);
	x->s = s;
	x->refs = 1;
	x->on_mark = sc_on_mark(s, heard_mark, x);
	x->on_end = sc_on_tracking_end(s, heard_end, x);
	x->next = indexes;
	indexes = x;
	return x;
}

void sx_index_put(sx_index *x) {
	if (x == NULL || --x->refs > 0) return;
	sc_remove_listener(x->on_mark);
	sc_remove_listener(x->on_end);
	for (sx_index **at = &indexes; *at != NULL; at = &(*at)->next) {
		if (*at == x) {
			*at = x->next;
			break;
		}
	}
	for (size_t i = 0; i < x->held.cap; i++) {
		if (x->held.keys[i]) bucket_free(x->held.vals[i]);
	}
	pm_clear(&x->held);
	scratch_free(&x->z);
	free(x);
}

// the selector -------------------------------------------------------------------------------

// the one key object of a selected value
typedef struct {
	const void *value;
	sx_selector *x;
} kobj;

struct sx_selector {
	sc_scheduler *s;
	sx_index *index;
	void *(*source)(void *data);
	void *data;
	bool (*equal)(const void *key, const void *value, void *data);
	// value -> kobj
	pm keys;
	const void *value;
	bool has;
	sx_holder me;
};

static bool selects(const sx_selector *x, const void *key, const void *value) {
	return x->equal != NULL ? x->equal(key, value, x->data) : key == value;
}

static sc_out run_source(void *previous, void *data) {
	(void)previous;
	sx_selector *x = data;
	return (sc_out){.kind = SC_VALUE, .value = x->source(x->data)};
}

static char *moved(void *value, void *data) {
	sx_selector *x = data;
	const void *was = x->value;
	bool had = x->has;
	x->value = value;
	x->has = true;
	const void *few[8];
	const void **marked = x->keys.count + 2 <= sizeof few / sizeof *few ? few
		: xalloc((x->keys.count + 2) * sizeof *marked);
	size_t n = 0;
	if (x->equal == NULL) {
		kobj *a = had ? pm_get(&x->keys, was) : NULL;
		kobj *b = pm_get(&x->keys, value);
		if (a != NULL) marked[n++] = a;
		if (b != NULL && b != a) marked[n++] = b;
	} else {
		for (size_t i = 0; i < x->keys.cap; i++) {
			if (!x->keys.keys[i]) continue;
			bool before = had && x->equal(x->keys.keys[i], was, x->data);
			if (before != x->equal(x->keys.keys[i], value, x->data)) marked[n++] = x->keys.vals[i];
		}
	}
	if (n > 0) sc_mark(x->s, marked, n, sc_get_run(x->s));
	if (marked != few) free(marked);
	return NULL;
}

static void ended(void *data, const void *key) {
	sx_selector *x = data;
	const kobj *o = key;
	if (pm_get(&x->keys, o->value) != o) return;
	pm_delete(&x->keys, o->value);
	sx_drop(x->index, o, &x->me);
	free((void *)o);
}

sx_selector *sx_selector_new(sc_scheduler *s, void *(*source)(void *data), void *data,
	bool (*equal)(const void *key, const void *value, void *data)) {
	sx_selector *x = xalloc(sizeof *x);
	x->s = s;
	x->source = source;
	x->data = data;
	x->equal = equal;
	x->me = (sx_holder){.ended = ended, .data = x};
	x->index = sx_index_get(s);
	sc_def def = {.f = run_source, .set = moved, .data = x};
	if (sc_create_computer(s, def) == NULL) {
		sx_index_put(x->index);
		free(x);
		return NULL;
	}
	return x;
}

bool sx_selected(sx_selector *x, const void *key) {
	if (sc_get_run(x->s) != NULL) {
		kobj *o = pm_get(&x->keys, key);
		if (o == NULL) {
			o = xalloc(sizeof *o);
			o->value = key;
			o->x = x;
			pm_set(&x->keys, key, o);
			sx_hold(x->index, o, &x->me);
		}
		sc_track(x->s, o);
	}
	return x->has && selects(x, key, x->value);
}

void sx_selector_free(sx_selector *x) {
	if (x == NULL) return;
	for (size_t i = 0; i < x->keys.cap; i++) {
		if (!x->keys.keys[i]) continue;
		kobj *o = x->keys.vals[i];
		sx_drop(x->index, o, &x->me);
		free(o);
	}
	pm_clear(&x->keys);
	sx_index_put(x->index);
	free(x);
}
