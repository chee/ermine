#include "tracker.h"

#include <stdbool.h>
#include <stdlib.h>

tg_node *tg_node_new(void *owner) {
	tg_node *n = calloc(1, sizeof *n);
	if (n != NULL) n->owner = owner;
	return n;
}

void tg_node_free(tg_node *n) { free(n); }

// every begin takes the next tick
static uint64_t tick;

// out of to's readers, and freed
static void drop(tg_link *l) {
	if (l->before != NULL) l->before->after = l->after;
	else l->to->first = l->after;
	if (l->after != NULL) l->after->before = l->before;
	else l->to->last = l->before;
	free(l);
}

static tg_link *link(tg_node *from, tg_node *to, tg_link *prev, tg_link *next) {
	tg_link *l = malloc(sizeof *l);
	if (l == NULL) return NULL;
	*l = (tg_link){from, to, next, to->last, NULL, from->open ? from->gen : 0};
	if (prev != NULL) prev->next = l;
	else from->reads = l;
	if (to->last != NULL) to->last->after = l;
	else to->first = l;
	to->last = l;
	return l;
}

// not in a run already: end it first
int tg_begin(tg_node *f) {
	if (f->open) return -2;
	f->open = true;
	f->gen = ++tick;
	f->cursor = NULL;
	return 0;
}

// link's track (alien-signals, solid 2.0): the same spot as the last read, the next link in
// order, or t's newest reader being this run, are free; else a new link at the cursor.
// duplicates are allowed where these miss: reads b, a, b over old [a, b] ends with two b
int tg_track(tg_node *f, tg_node *t) {
	tg_link *cursor = f->cursor;
	if (cursor != NULL && cursor->to == t) return 0;
	tg_link *next = cursor != NULL ? cursor->next : f->reads;
	if (next != NULL && next->to == t) {
		next->gen = f->gen;
		f->cursor = next;
		return 0;
	}
	tg_link *last = t->last;
	if (last != NULL && last->from == f && last->gen == f->gen) return 0;
	tg_link *l = link(f, t, cursor, next);
	if (l == NULL) return -1;
	f->cursor = l;
	return 0;
}

// whatever this run did not read again is dropped; without a run, nothing: leave, then trim
void tg_end(tg_node *f) {
	f->open = false;
	tg_trim(f);
}

// the run ends, no link dropped: the ones it did not reach stay after the cursor, old
void tg_leave(tg_node *f) { f->open = false; }

bool tg_old(const tg_link *l) { return !l->from->open && l->gen != l->from->gen; }

// outside a run: the links after the cursor (all, with no cursor) are dropped
void tg_trim(tg_node *f) {
	tg_link *stale;
	if (f->cursor != NULL) {
		stale = f->cursor->next;
		f->cursor->next = NULL;
	} else {
		stale = f->reads;
		f->reads = NULL;
	}
	while (stale != NULL) {
		tg_link *next = stale->next;
		drop(stale);
		stale = next;
	}
}

// a set of nodes by identity, open addressing; cap a power of two, more than twice what goes in
typedef struct {
	tg_node **slots;
	size_t mask;
} seen_set;

static size_t slot_of(const seen_set *m, const tg_node *n) {
	size_t h = (size_t)(uintptr_t)n;
	h ^= h >> 17;
	h *= (size_t)0x9E3779B97F4A7C15ull;
	size_t i = (h ^ (h >> 29)) & m->mask;
	while (m->slots[i] != NULL && m->slots[i] != n) i = (i + 1) & m->mask;
	return i;
}

// true when n was there already
static bool seen_add(seen_set *m, tg_node *n) {
	size_t i = slot_of(m, n);
	if (m->slots[i] == n) return true;
	m->slots[i] = n;
	return false;
}

// out of f's reads (prev: the link before it, NULL at the front) and to's readers, and freed
static void cut(tg_node *f, tg_link *prev, tg_link *l) {
	if (prev != NULL) prev->next = l->next;
	else f->reads = l->next;
	if (f->cursor == l) f->cursor = prev;
	drop(l);
}

// outside a run: the links after the cursor stay, but one to a spot linked before it, or after it
// already, is dropped: a run left (tg_leave) with its reads in a new order piles up no repeats.
// out of memory: a slower walk, the same links
void tg_dedupe(tg_node *f) {
	tg_link *cursor = f->cursor;
	tg_link *l = cursor != NULL ? cursor->next : f->reads;
	if (l == NULL) return;
	size_t n = 0;
	for (tg_link *x = f->reads; x != NULL; x = x->next) n++;
	size_t cap = 8;
	while (cap < 2 * n + 2) cap <<= 1;
	seen_set m = {calloc(cap, sizeof(tg_node *)), cap - 1};
	tg_link *prev = cursor;
	if (m.slots != NULL) {
		for (tg_link *x = f->reads; x != l; x = x->next) seen_add(&m, x->to);
		while (l != NULL) {
			tg_link *next = l->next;
			if (seen_add(&m, l->to)) cut(f, prev, l);
			else prev = l;
			l = next;
		}
		free(m.slots);
		return;
	}
	while (l != NULL) {
		tg_link *next = l->next;
		bool again = false;
		for (tg_link *x = f->reads; x != l && !again; x = x->next) again = x->to == l->to;
		if (again) cut(f, prev, l);
		else prev = l;
		l = next;
	}
}

// outside a run: at the cursor (the end, after tg_end), the cursor on it; or left where it is. in
// a run it would mean track
int tg_add(tg_node *f, tg_node *t) {
	if (f->open) return -2;
	for (tg_link *l = f->reads; l != NULL; l = l->next)
		if (l->to == t) return 0;
	tg_link *l = link(f, t, f->cursor, f->cursor != NULL ? f->cursor->next : f->reads);
	if (l == NULL) return -1;
	f->cursor = l;
	return 0;
}

void tg_untrack(tg_node *f, tg_node *t) {
	if (t == NULL) {
		tg_link *l = f->reads;
		while (l != NULL) {
			tg_link *next = l->next;
			drop(l);
			l = next;
		}
		f->reads = NULL;
		f->cursor = NULL;
		return;
	}
	tg_link *prev = NULL, *l = f->reads;
	while (l != NULL) {
		tg_link *next = l->next;
		if (l->to != t) {
			prev = l;
		} else {
			if (prev != NULL) prev->next = next;
			else f->reads = next;
			if (f->cursor == l) f->cursor = prev;
			drop(l);
		}
		l = next;
	}
}
