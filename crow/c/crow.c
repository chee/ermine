// crow (crow.h), in C.
#include "crow.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../../changeable/c/ptrmap.h"

// A set of containers, each held by it (op_ref): open addressing, linear probing, no tombstones.
typedef struct {
	op_value **slots;
	size_t capacity; // 0 or a power of two
	size_t count;
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
static op_value *out(set *s, const op_value *v) {
	if (!has(s, v)) return NULL;
	size_t mask = s->capacity - 1, i = where(s, v);
	while (s->slots[i] != v) i = (i + 1) & mask;
	op_value *held = s->slots[i];
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
	return held;
}
static int del(set *s, const op_value *v) {
	op_value *held = out(s, v);
	if (held == NULL) return 0;
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

typedef struct {
	const void *root;
	set *owned; // its own allocation: the owner map points at it
	size_t at; // where it is in records
} record;

typedef struct {
	set *in;
	op_value *v;
} gone;

struct cr_crow {
	record **records; // each its own allocation: the by-root map points at it
	size_t count, capacity;
	pm owner; // an owned container → the set it is in
	pm by_root; // a root → its record
	// While a write is applying (noting): what it let go of, put back if it is refused, so
	// ownership changes only once the write has.
	gone *gone;
	size_t ngone, gone_capacity;
	bool noting;
};

cr_crow *cr_new(void) { return calloc(1, sizeof(cr_crow)); }

void cr_free(cr_crow *u) {
	if (u == NULL) return;
	for (size_t i = 0; i < u->count; i++) {
		clear(u->records[i]->owned), free(u->records[i]->owned), free(u->records[i]);
	}
	pm_clear(&u->owner);
	pm_clear(&u->by_root);
	free(u->records);
	free(u->gone);
	free(u);
}

static record *find(const cr_crow *u, const void *root) { return pm_get(&u->by_root, root); }

void cr_let_go(cr_crow *u, const void *root) {
	record *r = find(u, root);
	if (r == NULL) return;
	clear(r->owned);
	free(r->owned);
	pm_delete(&u->by_root, root);
	record *last = u->records[--u->count];
	u->records[r->at] = last;
	last->at = r->at;
	free(r);
}

// A typed array or bytes: its elements are its own, no items under it.
static int flat(const op_value *v) { return v->type == OP_TYPED || v->type == OP_BYTES; }

static int container(const op_value *v) {
	return v != NULL && (v->type == OP_LIST || v->type == OP_MAP || flat(v));
}

// A shallow copy: the same items with one reference on each, a map's keys shared; a typed
// array's elements, or bytes, are copied.
static op_value *copy(const op_value *v) {
	if (v->type == OP_TYPED) return op_typed(v->kind, v->data, op_length(v));
	if (v->type == OP_BYTES) return op_bytes(v->data, v->bytes);
	op_value *c;
	if (v->type == OP_MAP) c = op_map_copy(v);
	else {
		c = op_list();
		if (v->count == 0) return c;
		c->items = malloc(v->count * sizeof *c->items);
		if (c->items == NULL) abort();
		memcpy(c->items, v->items, v->count * sizeof *c->items);
		c->capacity = c->count = v->count;
	}
	for (size_t i = 0; i < c->count; i++) op_ref(c->items[i]);
	return c;
}

typedef struct {
	op_value **copies;
	size_t count, capacity;
} made;

// v if it is not a container or is already owned, otherwise its owned copy (one hold for the
// caller: the tree's).
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

typedef struct {
	set *mine;
	made made;
} owning;
static op_value *owned(op_value *v, void *data) {
	owning *o = data;
	return take(o->mine, &o->made, v);
}

static void let_go(set *mine, const op_value *v, int top) {
	if (!container(v)) return;
	int owned = del(mine, v);
	if ((!owned && !top) || flat(v)) return;
	for (size_t i = 0; i < v->count; i++) let_go(mine, v->items[i], 0);
}

static void note(cr_crow *u, set *in, op_value *held) {
	if (u->ngone == u->gone_capacity) {
		u->gone_capacity = u->gone_capacity ? 2 * u->gone_capacity : 16;
		u->gone = realloc(u->gone, u->gone_capacity * sizeof *u->gone);
		if (u->gone == NULL) abort();
	}
	u->gone[u->ngone++] = (gone){in, held};
}

static void leave(cr_crow *u, set *in, const op_value *v) {
	if (!u->noting) {
		del(in, v);
		return;
	}
	op_value *held = out(in, v);
	if (held != NULL) note(u, in, held);
}

// Lets go of what is owned under v, and v. Owned copies are connected from the root, so only
// those are walked.
static void drop(cr_crow *u, op_value *v) {
	if (!container(v)) return;
	set *in = pm_get(&u->owner, v);
	if (in == NULL) return;
	leave(u, in, v);
	if (flat(v)) return;
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

// Lets go of every container in v, in every root's set. At a handed subtree, only what is owned
// under it. seen is made at the first step into a container (a value a run made may share or
// loop), so a flat value makes none. It holds its containers so none is freed and its address
// reused during the walk.
static void let_all(cr_crow *u, op_value *v, const given *g, set **seen) {
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
	if (in != NULL) leave(u, in, v);
	if (flat(v)) return;
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

void cr_let_go_in(cr_crow *u, const op_value *value, const op_value *const *subtrees, size_t n) {
	given g = {subtrees, n, NULL};
	if (n > 8) {
		g.big = calloc(1, sizeof *g.big);
		if (g.big == NULL) abort();
		for (size_t i = 0; i < n; i++)
			if (!has(g.big, subtrees[i])) add(g.big, (op_value *)subtrees[i]);
	}
	set *seen = NULL;
	let_all(u, (op_value *)value, &g, &seen);
	if (seen != NULL) clear(seen), free(seen);
	if (g.big != NULL) clear(g.big), free(g.big);
}

int cr_update(cr_crow *u, const void *root, const op_value *value, const op_patch *patches, size_t n,
	op_value **after, op_undo *undo_out, size_t *failed) {
	u->noting = true;
	for (size_t i = 0; i < n; i++)
		if (patches[i].has_value && container(patches[i].value)) cr_let_go_in(u, patches[i].value, NULL, 0);
	record *r = find(u, root);
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
		*r = (record){.root = root, .owned = owned, .at = u->count};
		u->records[u->count++] = r;
		pm_set(&u->by_root, root, r);
	}
	owning o = {r->owned, {0}};
	op_undo undo = {0};
	op_apply_options options = {.undo = &undo, .in_place = 1, .owned = owned, .data = &o};
	int code = op_apply((op_value *)value, patches, n, &options, after, failed);
	u->noting = false;
	if (code != OP_OK) {
		for (size_t j = 0; j < o.made.count; j++) del(o.mine, o.made.copies[j]);
		free(o.made.copies);
		for (size_t j = 0; j < u->ngone; j++)
			add(u->gone[j].in, u->gone[j].v), op_free(u->gone[j].v);
		u->ngone = 0;
		return code;
	}
	free(o.made.copies);
	for (size_t j = 0; j < u->ngone; j++) op_free(u->gone[j].v);
	u->ngone = 0;
	for (size_t k = 0; k < undo.n; k++)
		if (undo.patches[k].has_value) let_go(o.mine, undo.patches[k].value, 1);
	*undo_out = undo;
	return OP_OK;
}
