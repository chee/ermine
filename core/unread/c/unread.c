// unread (unread.h), in C.
#include "unread.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../../../core/scheduler/c/ptrmap.h"

// a set of containers, each held by it (op_ref): open addressing, linear probing, no tombstones
typedef struct {
	op_value **slots;
	size_t capacity; // 0 or a power of two
	size_t count;
	// NULL, or each container in the set → the set (kept in step: the owner map)
	pm *owner;
} set;

static size_t where(const set *s, const op_value *v) {
	return (size_t)(((uintptr_t)v >> 4) * 0x9E3779B97F4A7C15ull) & (s->capacity - 1);
}
static int has(const set *s, const op_value *v) {
	if (s->count == 0) return 0;
	for (size_t i = where(s, v); s->slots[i] != NULL; i = (i + 1) & (s->capacity - 1))
		if (s->slots[i] == v) return 1;
	return 0;
}
static void put(set *s, op_value *v) {
	for (size_t i = where(s, v);; i = (i + 1) & (s->capacity - 1)) {
		if (s->slots[i] == NULL) {
			s->slots[i] = v;
			s->count++;
			return;
		}
	}
}
// holds v (not in the set)
static void add(set *s, op_value *v) {
	if (2 * (s->count + 1) > s->capacity) {
		set big = {calloc(s->capacity ? 2 * s->capacity : 16, sizeof(op_value *)),
			s->capacity ? 2 * s->capacity : 16, 0, s->owner};
		if (big.slots == NULL) abort();
		for (size_t i = 0; i < s->capacity; i++)
			if (s->slots[i] != NULL) put(&big, s->slots[i]);
		free(s->slots);
		*s = big;
	}
	put(s, op_ref(v));
	if (s->owner != NULL) pm_set(s->owner, v, s);
}
// 1 and let go of when v was in it
static int del(set *s, const op_value *v) {
	if (!has(s, v)) return 0;
	size_t mask = s->capacity - 1, i = where(s, v);
	while (s->slots[i] != v) i = (i + 1) & mask;
	op_value *held = s->slots[i];
	// close the gap: a later item of the run moves back into it unless its home is past the gap
	s->slots[i] = NULL;
	for (size_t j = i;;) {
		j = (j + 1) & mask;
		if (s->slots[j] == NULL) break;
		size_t home = where(s, s->slots[j]);
		if (j > i ? (home <= i || home > j) : (home <= i && home > j)) {
			s->slots[i] = s->slots[j];
			s->slots[j] = NULL;
			i = j;
		}
	}
	s->count--;
	if (s->owner != NULL) pm_delete(s->owner, held);
	op_free(held);
	return 1;
}
static void clear(set *s) {
	for (size_t i = 0; i < s->capacity; i++) {
		if (s->slots[i] == NULL) continue;
		if (s->owner != NULL) pm_delete(s->owner, s->slots[i]);
		op_free(s->slots[i]);
	}
	free(s->slots);
	*s = (set){.owner = s->owner};
}

// a wiring of un_keeping, kept by u until un_free
typedef struct wiring {
	struct un_unread *u;
	const op_value *(*handed)(const void *key, void *ctx);
	void *ctx;
	struct wiring *next;
} wiring;

typedef struct {
	const nd_entry *entry;
	set *owned; // its own allocation: the owner map points at it
	size_t at; // where it is in records
} record;

struct un_unread {
	record **records; // each its own allocation: the by-entry map points at it
	size_t count, capacity;
	pm owner; // an owned container → the set it is in
	pm by_entry; // an entry → its record
	struct wiring *wirings;
};

un_unread *un_new(void) { return calloc(1, sizeof(un_unread)); }

void un_free(un_unread *u) {
	if (u == NULL) return;
	for (size_t i = 0; i < u->count; i++) {
		clear(u->records[i]->owned), free(u->records[i]->owned), free(u->records[i]);
	}
	pm_clear(&u->owner);
	pm_clear(&u->by_entry);
	while (u->wirings != NULL) {
		struct wiring *next = u->wirings->next;
		free(u->wirings);
		u->wirings = next;
	}
	free(u->records);
	free(u);
}

static record *find(const un_unread *u, const nd_entry *e) { return pm_get(&u->by_entry, e); }

void un_read(un_unread *u, const nd_entry *entry) {
	record *r = find(u, entry);
	if (r == NULL) return;
	clear(r->owned);
	free(r->owned);
	pm_delete(&u->by_entry, entry);
	record *last = u->records[--u->count];
	u->records[r->at] = last;
	last->at = r->at;
	free(r);
}

size_t un_owned(const un_unread *u, const nd_entry *entry) {
	record *r = find(u, entry);
	return r == NULL ? 0 : r->owned->count;
}

// containers: what a write can change in place
static int container(const op_value *v) {
	return v != NULL && (v->type == OP_LIST || v->type == OP_MAP || v->type == OP_TYPED);
}

// a shallow copy: the same items, one reference on each. a typed array's elements copied
static op_value *copy(const op_value *v) {
	if (v->type == OP_TYPED) return op_typed(v->kind, v->data, op_length(v));
	op_value *c = v->type == OP_LIST ? op_list() : op_map();
	if (v->count == 0) return c;
	c->items = malloc(v->count * sizeof *c->items);
	if (c->items == NULL) abort();
	c->capacity = v->count;
	if (v->type == OP_MAP) {
		c->keys = malloc(v->count * sizeof *c->keys);
		if (c->keys == NULL) abort();
	}
	for (size_t i = 0; i < v->count; i++) {
		c->items[i] = op_ref(v->items[i]);
		if (v->type == OP_MAP) {
			c->keys[i] = strdup(v->keys[i]);
			if (c->keys[i] == NULL) abort();
		}
		c->count++;
	}
	return c;
}

// the copies one write made owned, for a write that is refused to let go of
typedef struct {
	op_value **copies;
	size_t count, capacity;
} made;

// v when it is not a container or is owned; else its copy, owned (one hold for the caller: the
// tree's)
static op_value *take(set *mine, made *m, op_value *v) {
	if (!container(v) || has(mine, v)) return v;
	op_value *c = copy(v);
	add(mine, c);
	if (m->count == m->capacity) {
		m->capacity = m->capacity ? 2 * m->capacity : 16;
		m->copies = realloc(m->copies, m->capacity * sizeof *m->copies);
		if (m->copies == NULL) abort();
	}
	m->copies[m->count++] = c;
	return c;
}

// the slot a key leads to in v: NULL when v has none (as hasOwn does not)
static op_value **slot(op_value *v, const op_key *k) {
	if (v->type == OP_LIST) {
		if (k->type != OP_NUM_KEY || k->n < 0 || (size_t)k->n >= v->count) return NULL;
		return &v->items[k->n];
	}
	if (v->type != OP_MAP || k->type != OP_STR_KEY) return NULL;
	long i = op_find(v, k->s);
	return i < 0 ? NULL : &v->items[i];
}

// the containers a patch changes in place on its target's path: owned, copied where not
static void own_target(op_value **root, const op_target *t, set *mine, made *m) {
	if (t->length == 0 && !t->has_range) return;
	op_value *r = take(mine, m, *root);
	if (r != *root) op_free(*root), *root = r;
	op_value *v = *root;
	// the containers above the last key; a range's own container too
	size_t end = t->has_range ? t->length : t->length - 1;
	for (size_t i = 0; i < end; i++) {
		if (!container(v)) break;
		op_value **at = slot(v, &t->path[i]);
		if (at == NULL) break;
		op_value *c = take(mine, m, *at);
		if (c != *at) op_free(*at), *at = c;
		v = c;
	}
}

static int same_key(const op_key *a, const op_key *b) {
	if (a->type != b->type) return 0;
	if (a->type == OP_NUM_KEY) return a->n == b->n;
	if (a->type == OP_STR_KEY) return strcmp(a->s, b->s) == 0;
	return a->a == b->a && a->b == b->b;
}

// a move takes, then puts: where it puts is found after the take, which shifts the list it took
// from. t, read after the take, as it reads before it: a number past what the list lost, moved up.
// keys: room for t's path, written when it shifts
static op_target before(const op_target *t, const op_target *m, op_key *keys) {
	size_t list;
	long a, b;
	if (m->has_range) {
		list = m->length, a = m->from, b = m->to;
	} else if (m->length > 0 && m->path[m->length - 1].type == OP_NUM_KEY) {
		list = m->length - 1, a = m->path[m->length - 1].n, b = a + 1;
	} else {
		return *t;
	}
	if (t->length <= list) return *t;
	for (size_t i = 0; i < list; i++)
		if (!same_key(&t->path[i], &m->path[i])) return *t;
	if (t->path[list].type != OP_NUM_KEY || t->path[list].n < a) return *t;
	memcpy(keys, t->path, t->length * sizeof *keys);
	keys[list].n += b - a;
	op_target out = *t;
	out.path = keys;
	return out;
}

// what a write took out (its undo holds it) no longer owned: owned containers are connected from
// the root, so only those are walked, under the top (a span's undo: a list made for it)
static void let_go(set *mine, const op_value *v, int top) {
	if (!container(v)) return;
	int owned = del(mine, v);
	if ((!owned && !top) || v->type == OP_TYPED) return;
	for (size_t i = 0; i < v->count; i++) let_go(mine, v->items[i], 0);
}

// what is owned under v let go, v too: owned copies are connected from the root, so only those
// are walked
static void drop(un_unread *u, op_value *v) {
	if (!container(v)) return;
	set *in = pm_get(&u->owner, v);
	if (in == NULL) return;
	del(in, v);
	if (v->type == OP_TYPED) return;
	for (size_t i = 0; i < v->count; i++) drop(u, v->items[i]);
}

typedef struct {
	const op_value *const *items;
	size_t n;
	set *big; // for many: the same, as a set
} given;

static int is_given(const given *g, const op_value *v) {
	if (g->big != NULL) return has(g->big, v);
	for (size_t i = 0; i < g->n; i++)
		if (g->items[i] == v) return 1;
	return 0;
}

// every container in v let go, in every entry's set; at one handed, what is owned under it, no
// deeper. seen: the containers walked, made at the first step into a container (a value a run
// made may share, or loop), so a flat one makes none; held, so none is freed and its address
// reused while the walk goes on
static void let_all(un_unread *u, op_value *v, const given *g, set **seen) {
	if (!container(v)) return;
	if (is_given(g, v)) {
		drop(u, v);
		return;
	}
	if (*seen != NULL) {
		if (has(*seen, v)) return;
		add(*seen, v);
	}
	set *in = pm_get(&u->owner, v);
	if (in != NULL) del(in, v);
	if (v->type == OP_TYPED) return;
	for (size_t i = 0; i < v->count; i++) {
		if (!container(v->items[i])) continue;
		if (*seen == NULL) {
			*seen = calloc(1, sizeof **seen);
			if (*seen == NULL) abort();
			add(*seen, v);
		}
		let_all(u, v->items[i], g, seen);
	}
}

void un_kept(un_unread *u, const op_value *value, const op_value *const *handed, size_t n) {
	given g = {handed, n, NULL};
	if (n > 8) {
		g.big = calloc(1, sizeof *g.big);
		if (g.big == NULL) abort();
		for (size_t i = 0; i < n; i++)
			if (!has(g.big, handed[i])) add(g.big, (op_value *)handed[i]);
	}
	set *seen = NULL;
	let_all(u, (op_value *)value, &g, &seen);
	if (seen != NULL) clear(seen), free(seen);
	if (g.big != NULL) clear(g.big), free(g.big);
}

int un_update(un_unread *u, nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed) {
	record *r = find(u, entry);
	if (r == NULL) {
		if (u->count == u->capacity) {
			u->capacity = u->capacity ? 2 * u->capacity : 4;
			u->records = realloc(u->records, u->capacity * sizeof *u->records);
			if (u->records == NULL) abort();
		}
		r = malloc(sizeof *r);
		set *owned = calloc(1, sizeof *owned);
		if (r == NULL || owned == NULL) abort();
		owned->owner = &u->owner;
		*r = (record){.entry = entry, .owned = owned, .at = u->count};
		u->records[u->count++] = r;
		pm_set(&u->by_entry, entry, r);
	}
	set *mine = r->owned;
	op_undo *undos = calloc(n + 1, sizeof *undos);
	if (undos == NULL) abort();
	// one patch at a time: each owns what it changes in the tree the ones before it left (one may
	// move a subtree, or put a value in, that the next writes under)
	made made_here = {0};
	op_value *after = op_ref(entry->value);
	size_t i = 0;
	int code = OP_OK;
	for (; i < n; i++) {
		op_value *out;
		if (patches[i].has_move) {
			own_target(&after, &patches[i].move, mine, &made_here);
			op_key *keys = malloc((patches[i].place.length + 1) * sizeof *keys);
			if (keys == NULL) abort();
			op_target put = before(&patches[i].place, &patches[i].move, keys);
			own_target(&after, &put, mine, &made_here);
			free(keys);
		} else {
			own_target(&after, &patches[i].place, mine, &made_here);
		}
		op_apply_options options = {.undo = &undos[i], .in_place = 1};
		code = op_apply(after, &patches[i], 1, &options, &out, NULL);
		if (code != OP_OK) break;
		op_free(after);
		after = out;
	}
	if (code != OP_OK) {
		// what landed put back, last first; the patch that failed named in the whole write
		op_apply_options back = {.in_place = 1};
		for (size_t j = i; j-- > 0;) {
			op_value *out;
			op_apply(after, undos[j].patches, undos[j].n, &back, &out, NULL);
			op_free(after);
			after = out;
		}
		op_free(after);
		// the copies it made are no longer wanted: each let go of, now nothing holds it but the set
		for (size_t j = 0; j < made_here.count; j++) del(mine, made_here.copies[j]);
		free(made_here.copies);
		for (size_t j = 0; j < i; j++) op_undo_free(&undos[j]);
		free(undos);
		if (failed) *failed = i;
		return code;
	}
	// the undo of the write: the patches' undos, the last patch's first
	op_undo undo = {0};
	for (size_t j = 0; j < n; j++) undo.n += undos[j].n;
	if (undo.n > 0) {
		undo.patches = malloc(undo.n * sizeof *undo.patches);
		if (undo.patches == NULL) abort();
		undo.capacity = undo.n;
	}
	size_t at = 0;
	for (size_t j = n; j-- > 0;) {
		for (size_t k = 0; k < undos[j].n; k++) undo.patches[at++] = undos[j].patches[k];
		free(undos[j].patches);
	}
	free(undos);
	free(made_here.copies);
	for (size_t k = 0; k < undo.n; k++)
		if (undo.patches[k].has_value) let_go(mine, undo.patches[k].value, 1);
	op_free(entry->value);
	entry->value = after;
	op_undo_free(&entry->undo);
	entry->undo = undo;
	entry->change = header;
	entry->change.has_op = 1;
	entry->change.patches = patches;
	entry->change.patches_length = n;
	entry->change.undo = undo.patches;
	entry->change.undo_length = undo.n;
	return OP_OK;
}

// the scheduler's run end: what a run keeps past it, when a container, is kept; the values its
// reads gave it (containers) are what it was handed
static void run_end(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads, size_t nreads,
	const sc_more *more, void *data) {
	(void)c, (void)n, (void)ended;
	wiring *w = data;
	if (!more->has_kept || !container(more->kept)) return;
	if (w->handed == NULL || nreads == 0) {
		un_kept(w->u, more->kept, NULL, 0);
		return;
	}
	const op_value *stack[16], **given = stack;
	if (nreads > 16) {
		given = malloc(nreads * sizeof *given);
		if (given == NULL) abort();
	}
	size_t count = 0;
	for (size_t i = 0; i < nreads; i++) {
		const op_value *x = w->handed(reads[i], w->ctx);
		if (container(x)) given[count++] = x;
	}
	un_kept(w->u, more->kept, given, count);
	if (given != stack) free(given);
}

sc_listener *un_keeping(sc_scheduler *s, un_unread *u,
	const op_value *(*handed)(const void *key, void *ctx), void *ctx) {
	wiring *w = malloc(sizeof *w);
	if (w == NULL) abort();
	*w = (wiring){u, handed, ctx, u->wirings};
	u->wirings = w;
	return sc_on_run_end(s, run_end, w);
}
