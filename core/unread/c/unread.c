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
// v taken out of the set, its hold given to the caller; NULL when it was not in it
static op_value *out(set *s, const op_value *v) {
	if (!has(s, v)) return NULL;
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
	return held;
}
// 1 and let go of when v was in it
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

// a run going on, as a wiring sees it: what its reads gave it (handed), each held (op_ref);
// returned: its body returned (sc_on_run_return), so a write now is its set's
typedef struct {
	sc_computer *c;
	op_value **given;
	size_t n, capacity;
	bool returned;
} going;

// a wiring of un_keeping, kept by u until un_free: the runs going on, its listeners (NULL once
// unwired)
typedef struct un_wiring {
	struct un_unread *u;
	const op_value *(*handed)(const void *key, void *ctx);
	void *ctx;
	struct un_wiring *next;
	going *runs;
	// nreturned: how many of the runs returned
	size_t nruns, capacity, nreturned;
	sc_listener *start, *ret, *track, *end;
} wiring;

// what a run's reads gave it let go of (each hold released)
static void forget_run(going *g) {
	for (size_t i = 0; i < g->n; i++) op_free(g->given[i]);
	free(g->given);
}

typedef struct {
	const nd_entry *entry;
	set *owned; // its own allocation: the owner map points at it
	size_t at; // where it is in records
} record;

// a container a write let go of before it landed, and the set it was in (its hold kept)
typedef struct {
	set *in;
	op_value *v;
} gone;

struct un_unread {
	record **records; // each its own allocation: the by-entry map points at it
	size_t count, capacity;
	pm owner; // an owned container → the set it is in
	pm by_entry; // an entry → its record
	struct un_wiring *wirings;
	// in a write, before it lands (noting): what it let go of, put back if it is refused, so
	// ownership changes only once the write has
	gone *gone;
	size_t ngone, gone_capacity;
	bool noting;
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
		wiring *next = u->wirings->next;
		for (size_t i = 0; i < u->wirings->nruns; i++) forget_run(&u->wirings->runs[i]);
		free(u->wirings->runs);
		free(u->wirings);
		u->wirings = next;
	}
	free(u->records);
	free(u->gone);
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

// containers: what a write can change in place
static int container(const op_value *v) {
	return v != NULL && (v->type == OP_LIST || v->type == OP_MAP || v->type == OP_TYPED);
}

// a shallow copy: the same items, one reference on each, a map's keys shared. a typed array's
// elements copied
static op_value *copy(const op_value *v) {
	if (v->type == OP_TYPED) return op_typed(v->kind, v->data, op_length(v));
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

// a write's: what it owns, and the copies it made
typedef struct {
	set *mine;
	made made;
} owning;
// op_apply's owned: the container to change in place
static op_value *owned(op_value *v, void *data) {
	owning *o = data;
	return take(o->mine, &o->made, v);
}

// what a write took out (its undo holds it) no longer owned: owned containers are connected from
// the root, so only those are walked, under the top (a span's undo: a list made for it)
static void let_go(set *mine, const op_value *v, int top) {
	if (!container(v)) return;
	int owned = del(mine, v);
	if ((!owned && !top) || v->type == OP_TYPED) return;
	for (size_t i = 0; i < v->count; i++) let_go(mine, v->items[i], 0);
}

// held, out of in, noted: its hold the note's
static void note(un_unread *u, set *in, op_value *held) {
	if (u->ngone == u->gone_capacity) {
		u->gone_capacity = u->gone_capacity ? 2 * u->gone_capacity : 16;
		u->gone = realloc(u->gone, u->gone_capacity * sizeof *u->gone);
		if (u->gone == NULL) abort();
	}
	u->gone[u->ngone++] = (gone){in, held};
}

// v, in in, let go of; noting, noted (its hold kept)
static void leave(un_unread *u, set *in, const op_value *v) {
	if (!u->noting) {
		del(in, v);
		return;
	}
	op_value *held = out(in, v);
	if (held != NULL) note(u, in, held);
}

// what is owned under v let go, v too: owned copies are connected from the root, so only those
// are walked
static void drop(un_unread *u, op_value *v) {
	if (!container(v)) return;
	set *in = pm_get(&u->owner, v);
	if (in == NULL) return;
	leave(u, in, v);
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
	if (in != NULL) leave(u, in, v);
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

// a write while runs past their body's return go on: what their reads gave them let go of; none
// known (no handed), all of the entry written
static void before(un_unread *u, wiring *w, const nd_entry *entry) {
	if (w->handed == NULL) {
		// all of it noted (as un_read, its record kept)
		record *r = find(u, entry);
		if (r == NULL) return;
		set *s = r->owned;
		for (size_t i = 0; i < s->capacity; i++) {
			if (s->slots[i] == NULL) continue;
			pm_delete(s->owner, s->slots[i]);
			note(u, s, s->slots[i]);
		}
		free(s->slots);
		*s = (set){.owner = s->owner};
		return;
	}
	for (size_t i = 0; i < w->nruns; i++) {
		going *g = &w->runs[i];
		if (!g->returned) continue;
		for (size_t j = 0; j < g->n; j++) drop(u, g->given[j]);
	}
}
// once the write landed: what the runs' reads gave them, let go of, is not walked again
static void given_up(wiring *w) {
	if (w->handed == NULL) return;
	for (size_t i = 0; i < w->nruns; i++) {
		going *g = &w->runs[i];
		if (!g->returned) continue;
		for (size_t j = 0; j < g->n; j++) op_free(g->given[j]);
		g->n = 0;
	}
}

int un_update(un_unread *u, nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed) {
	// what is let go of before the op_apply is noted, and put back if it is refused
	u->noting = true;
	// a run past its body's return (un_keeping: its set) may hand on what it read: let go of first
	for (wiring *w = u->wirings; w != NULL; w = w->next)
		if (w->nreturned) before(u, w, entry);
	// what a patch puts is the caller's from now: nothing in it owned
	for (size_t i = 0; i < n; i++)
		if (patches[i].has_value && container(patches[i].value)) un_kept(u, patches[i].value, NULL, 0);
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
	// one op_apply, in place where owned: what a patch changes that is not owned yet is copied
	// (take) as it lands, in the tree the patches before it left (one may move a subtree, or put a
	// value in, that the next writes under)
	owning o = {r->owned, {0}};
	op_undo undo = {0};
	op_apply_options options = {.undo = &undo, .in_place = 1, .owned = owned, .data = &o};
	op_value *after;
	int code = op_apply(entry->value, patches, n, &options, &after, failed);
	u->noting = false;
	if (code != OP_OK) {
		// the copies it made are no longer wanted: each let go of, now nothing holds it but the set
		for (size_t j = 0; j < o.made.count; j++) del(o.mine, o.made.copies[j]);
		free(o.made.copies);
		// what it let go of first owned again, where it was
		for (size_t j = 0; j < u->ngone; j++)
			add(u->gone[j].in, u->gone[j].v), op_free(u->gone[j].v);
		u->ngone = 0;
		return code;
	}
	free(o.made.copies);
	for (size_t j = 0; j < u->ngone; j++) op_free(u->gone[j].v);
	u->ngone = 0;
	for (wiring *w = u->wirings; w != NULL; w = w->next)
		if (w->nreturned) given_up(w);
	for (size_t k = 0; k < undo.n; k++)
		if (undo.patches[k].has_value) let_go(o.mine, undo.patches[k].value, 1);
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

// a run starts: going on
static void run_start(sc_computer *c, unsigned n, int rank, void *data) {
	(void)n, (void)rank;
	wiring *w = data;
	if (w->nruns == w->capacity) {
		w->capacity = w->capacity ? 2 * w->capacity : 4;
		w->runs = realloc(w->runs, w->capacity * sizeof *w->runs);
		if (w->runs == NULL) abort();
	}
	w->runs[w->nruns++] = (going){c, NULL, 0, 0, false};
}
// a run's body returned: a write from now till its end is its set's
static void run_return(sc_computer *c, unsigned n, const void *value, void *data) {
	(void)n, (void)value;
	wiring *w = data;
	for (size_t i = w->nruns; i-- > 0;) {
		if (w->runs[i].c != c) continue;
		if (!w->runs[i].returned) w->runs[i].returned = true, w->nreturned++;
		return;
	}
}
// a key a run tracked: what it gave the run, held
static void run_track(const void *key, sc_run *run, void *data) {
	wiring *w = data;
	sc_computer *c = sc_run_computer(run);
	size_t i = w->nruns;
	while (i > 0 && w->runs[i - 1].c != c) i--;
	if (i == 0) return;
	const op_value *x = w->handed(key, w->ctx);
	if (!container(x)) return;
	going *g = &w->runs[i - 1];
	if (g->n == g->capacity) {
		g->capacity = g->capacity ? 2 * g->capacity : 4;
		g->given = realloc(g->given, g->capacity * sizeof *g->given);
		if (g->given == NULL) abort();
	}
	g->given[g->n++] = op_ref((op_value *)x);
}

// the scheduler's run end: the run goes on no more. what it keeps past it, when a container, is
// kept; the values its reads gave it (containers) are what it was handed
static void run_end(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads, size_t nreads,
	const sc_more *more, void *data) {
	(void)n, (void)ended;
	wiring *w = data;
	for (size_t i = w->nruns; i-- > 0;) {
		if (w->runs[i].c != c) continue;
		if (w->runs[i].returned) w->nreturned--;
		forget_run(&w->runs[i]);
		w->runs[i] = w->runs[--w->nruns];
		break;
	}
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

un_wiring *un_keeping(sc_scheduler *s, un_unread *u,
	const op_value *(*handed)(const void *key, void *ctx), void *ctx) {
	wiring *w = malloc(sizeof *w);
	if (w == NULL) abort();
	*w = (wiring){.u = u, .handed = handed, .ctx = ctx, .next = u->wirings};
	u->wirings = w;
	w->start = sc_on_run_start(s, run_start, w);
	w->ret = sc_on_run_return(s, run_return, w);
	if (handed != NULL) w->track = sc_on_track(s, run_track, w);
	w->end = sc_on_run_end(s, run_end, w);
	return w;
}

void un_unwire(un_wiring *w) {
	if (w->end == NULL) return;
	sc_remove_listener(w->start);
	sc_remove_listener(w->ret);
	if (w->track != NULL) sc_remove_listener(w->track);
	sc_remove_listener(w->end);
	w->start = w->ret = w->track = w->end = NULL;
	for (size_t i = 0; i < w->nruns; i++) forget_run(&w->runs[i]);
	w->nruns = w->nreturned = 0;
}

// the harnesses' hooks (unread_conformance_hook.h), only in their builds
#ifdef CONFORMANCE_HOOK
#include "unread_conformance_hook.c"
#endif
