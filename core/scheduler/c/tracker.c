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
	to->touched = tick;
	if (prev != NULL) prev->next = l;
	else from->reads = l;
	if (to->last != NULL) to->last->after = l;
	else to->first = l;
	to->last = l;
	return l;
}

void tg_begin(tg_node *f) {
	f->gen = ++tick;
	f->cursor = NULL;
}

// a link of f's to t, made or confirmed in f's run
static int read(tg_node *f, tg_node *t) {
	for (tg_link *l = t->last; l != NULL; l = l->before)
		if (l->from == f && l->gen == f->gen) return 1;
	return 0;
}

// shift's track: in order, the next link is confirmed; else a new one at the cursor.
// not in order: f may have read t already in this run, only if it confirmed a link in
// order, or a link was made to t since f began; else t is not looked through.
// in order, but t read already: t was linked anew in this run (so made since f began), and
// the next link is an old second one; it goes
int tg_track(tg_node *f, tg_node *t) {
	tg_link *cursor = f->cursor;
	tg_link *next = cursor != NULL ? cursor->next : f->reads;
	if (next != NULL && next->to == t) {
		if (t->touched >= f->gen && read(f, t)) {
			if (cursor != NULL) cursor->next = next->next;
			else f->reads = next->next;
			drop(next);
			return 0;
		}
		next->gen = f->gen;
		f->cursor = next;
		if (f->kept != f->gen) f->kept = f->gen; // the test is cheaper than a store every read
		return 0;
	}
	if (cursor != NULL && cursor->to == t) return 0;
	if ((f->kept == f->gen || t->touched >= f->gen) && read(f, t)) return 0;
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
