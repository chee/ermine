#include "tracker.h"

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
	*l = (tg_link){from, to, next, to->last, NULL, from->gen};
	if (prev != NULL) prev->next = l;
	else from->reads = l;
	if (to->last != NULL) to->last->after = l;
	else to->first = l;
	to->last = l;
	return l;
}

// not in a run already: end it first
int tg_begin(tg_node *f) {
	if (f->gen != 0) return -2;
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

// whatever this run did not read again is dropped; without a run, nothing
void tg_end(tg_node *f) {
	f->gen = 0;
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

// outside a run: at the end, or left where it is. in a run it would mean track
int tg_add(tg_node *f, tg_node *t) {
	if (f->gen != 0) return -2;
	for (tg_link *l = f->reads; l != NULL; l = l->next)
		if (l->to == t) return 0;
	tg_link *l = link(f, t, f->cursor, NULL);
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
