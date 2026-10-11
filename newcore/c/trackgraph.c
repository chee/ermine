#include "trackgraph.h"

#include <stdlib.h>

tg_node *tg_node_new(void *owner) {
	tg_node *n = calloc(1, sizeof *n);
	if (n != NULL) n->owner = owner;
	return n;
}

void tg_node_free(tg_node *n) {
	free(n->readers);
	free(n);
}

// readers keep the order made; a removed one leaves a hole, filled in by compact
static void compact(tg_node *n) {
	size_t j = 0;
	for (size_t i = 0; i < n->length; i++) {
		tg_link *l = n->readers[i];
		if (l == NULL) continue;
		n->readers[j] = l;
		l->at = j++;
	}
	n->length = j;
	n->holes = 0;
}

static void drop(tg_link *l) {
	tg_node *to = l->to;
	if (l->at == to->length - 1) {
		to->length--;
		// the last reader is always a link: track's check needs it
		while (to->length != 0 && to->readers[to->length - 1] == NULL) {
			to->length--;
			to->holes--;
		}
		if (to->holes * 2 > to->length) compact(to);
	} else {
		to->readers[l->at] = NULL;
		if (++to->holes * 2 > to->length) compact(to);
	}
	free(l);
}

static tg_link *link(tg_node *from, tg_node *to, tg_link *prev, tg_link *next) {
	if (to->length == to->capacity) {
		size_t capacity = to->capacity ? to->capacity * 2 : 4;
		tg_link **readers = realloc(to->readers, capacity * sizeof *readers);
		if (readers == NULL) return NULL;
		to->readers = readers;
		to->capacity = capacity;
	}
	tg_link *l = malloc(sizeof *l);
	if (l == NULL) return NULL;
	*l = (tg_link){from, to, prev, next, to->length, from->gen};
	if (prev != NULL) prev->next = l;
	else from->reads = l;
	if (next != NULL) next->prev = l;
	to->readers[to->length++] = l;
	return l;
}

static void unlink_(tg_link *l) {
	tg_node *from = l->from;
	if (l->prev != NULL) l->prev->next = l->next;
	else from->reads = l->next;
	if (l->next != NULL) l->next->prev = l->prev;
	if (from->cursor == l) from->cursor = l->prev;
	drop(l);
}

void tg_begin(tg_node *f) {
	f->gen++;
	f->cursor = NULL;
}

// shift's track: in order, the next link is confirmed; else a new one at the cursor
int tg_track(tg_node *f, tg_node *t) {
	tg_link *cursor = f->cursor;
	tg_link *next = cursor != NULL ? cursor->next : f->reads;
	if (next != NULL && next->to == t) {
		next->gen = f->gen;
		f->cursor = next;
		return 0;
	}
	if (cursor != NULL && cursor->to == t) return 0;
	if (t->length != 0) {
		tg_link *tail = t->readers[t->length - 1];
		if (tail->from == f && tail->gen == f->gen) return 0;
	}
	tg_link *l = link(f, t, cursor, next);
	if (l == NULL) return -1;
	f->cursor = l;
	return 0;
}

// whatever this run did not read again is dropped; without a run, nothing
void tg_end(tg_node *f) {
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

// outside a run: at the end, or left where it is
int tg_add(tg_node *f, tg_node *t) {
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
	tg_link *l = f->reads;
	while (l != NULL) {
		tg_link *next = l->next;
		if (l->to == t) unlink_(l);
		l = next;
	}
}

tg_link *const *tg_readers(tg_node *t, size_t *length) {
	if (t->holes != 0) compact(t);
	*length = t->length;
	return t->readers;
}
