#include "order.h"

#include <stdlib.h>

#include "rank.h"

typedef struct entry {
	od_item *p;
	int rank;
	uint64_t mark;
} entry;

struct order {
	od_item **live;
	size_t nlive, caplive;
	size_t ndue;
	// ranks made at this epoch are good while ranks_ok
	uint64_t epoch;
	bool ranks_ok;
	// the due as a heap, by rank, then mark, then the order made; made at heap_epoch
	entry *heap;
	size_t nheap, capheap;
	uint64_t heap_epoch;
};

order *od_new(void) {
	order *o = calloc(1, sizeof *o);
	if (o == NULL) abort();
	return o;
}

void od_free(order *o) {
	free(o->live);
	free(o->heap);
	free(o);
}

static void name(od_item *p, int d) {
	if (d > 0) p->named++;
	else if (p->named > 0) p->named--;
}
static bool edge(const od_item *p, const od_item *q) { return q != NULL && q != p && q->alive; }

// the ranks of everything alive
static void ranks(order *o) {
	if (o->ranks_ok) return;
	size_t n = 0;
	for (size_t i = 0; i < o->nlive; i++) {
		if (!o->live[i]->alive) continue;
		o->live[i]->index = n++;
	}
	size_t *off = malloc((n + 1) * sizeof *off);
	size_t cap = 16, count = 0;
	size_t *adj = malloc(cap * sizeof *adj);
	int *out = calloc(n + 1, sizeof *out);
	od_item **at = malloc((n + 1) * sizeof *at);
	if (!off || !adj || !out || !at) abort();
	size_t k = 0;
	for (size_t i = 0; i < o->nlive; i++) {
		od_item *p = o->live[i];
		if (!p->alive) continue;
		at[k] = p;
		off[k++] = count;
		size_t need = count + (p->values ? p->values->count : 0) + 1;
		if (need > cap) {
			while (need > cap) cap *= 2;
			adj = realloc(adj, cap * sizeof *adj);
			if (adj == NULL) abort();
		}
		if (p->values)
			for (size_t j = 0; j < p->values->cap; j++) {
				const od_item *q = p->values->keys[j];
				if (q != NULL && edge(p, q)) adj[count++] = q->index;
			}
		if (edge(p, p->after)) adj[count++] = p->after->index;
	}
	off[n] = count;
	rk_rank(n, off, adj, out);
	o->epoch++;
	for (size_t i = 0; i < n; i++) {
		at[i]->rank = out[i];
		at[i]->rank_epoch = o->epoch;
	}
	o->ranks_ok = true;
	free(off);
	free(adj);
	free(out);
	free(at);
}

static bool less(const entry *a, const entry *b) {
	if (a->rank != b->rank) return a->rank < b->rank;
	if (a->mark != b->mark) return a->mark < b->mark;
	return a->p->n < b->p->n;
}
static void push(order *o, entry e) {
	if (o->nheap == o->capheap) {
		o->capheap = o->capheap ? o->capheap * 2 : 64;
		o->heap = realloc(o->heap, o->capheap * sizeof *o->heap);
		if (o->heap == NULL) abort();
	}
	size_t i = o->nheap++;
	while (i > 0) {
		size_t up = (i - 1) >> 1;
		if (!less(&e, &o->heap[up])) break;
		o->heap[i] = o->heap[up];
		i = up;
	}
	o->heap[i] = e;
}
static entry pop(order *o) {
	entry top = o->heap[0];
	entry last = o->heap[--o->nheap];
	if (o->nheap > 0) {
		size_t i = 0;
		for (;;) {
			size_t c = 2 * i + 1;
			if (c >= o->nheap) break;
			if (c + 1 < o->nheap && less(&o->heap[c + 1], &o->heap[c])) c++;
			if (!less(&o->heap[c], &last)) break;
			o->heap[i] = o->heap[c];
			i = c;
		}
		o->heap[i] = last;
	}
	return top;
}

static int rank_at(const order *o, const od_item *p, uint64_t epoch) {
	(void)o;
	return p->rank_epoch == epoch ? p->rank : 0;
}

bool od_has(const order *o, const od_item *p) {
	(void)o;
	return p->due;
}
uint64_t od_at(const od_item *p) { return p->due ? p->mark : 0; }

void od_set(order *o, od_item *p, uint64_t mark) {
	if (!p->due) o->ndue++;
	p->due = true;
	p->mark = mark;
	if (o->heap_epoch != 0) push(o, (entry){p, rank_at(o, p, o->heap_epoch), mark});
}

void od_delete(order *o, od_item *p) {
	if (p->due) o->ndue--;
	p->due = false;
}

size_t od_size(const order *o) { return o->ndue; }

od_item *od_next(order *o, int *rank) {
	ranks(o);
	// the heap is remade when the ranks are; a popped entry no longer due at its mark is stale
	if (o->heap_epoch != o->epoch || o->nheap > 4 * o->ndue + 64) {
		o->heap_epoch = o->epoch;
		o->nheap = 0;
		for (size_t i = 0; i < o->nlive; i++) {
			od_item *p = o->live[i];
			if (p->due) push(o, (entry){p, rank_at(o, p, o->epoch), p->mark});
		}
	}
	entry *waiting = NULL;
	size_t nwaiting = 0, capwaiting = 0;
	entry best = {0};
	bool found = false;
	while (o->nheap > 0) {
		entry e = pop(o);
		if (!e.p->due || e.p->mark != e.mark) continue;
		if (e.p->after && e.p->after->due) {
			if (nwaiting == capwaiting) {
				capwaiting = capwaiting ? capwaiting * 2 : 16;
				waiting = realloc(waiting, capwaiting * sizeof *waiting);
				if (waiting == NULL) abort();
			}
			waiting[nwaiting++] = e;
			continue;
		}
		best = e;
		found = true;
		break;
	}
	for (size_t i = 0; i < nwaiting; i++) push(o, waiting[i]);
	free(waiting);
	if (!found) abort();
	*rank = best.rank;
	return best.p;
}

void od_started(order *o, od_item *p) {
	if (o->nlive == o->caplive) {
		o->caplive = o->caplive ? o->caplive * 2 : 16;
		o->live = realloc(o->live, o->caplive * sizeof *o->live);
		if (o->live == NULL) abort();
	}
	p->slot = o->nlive;
	o->live[o->nlive++] = p;
	if (o->ranks_ok) {
		p->rank = 0;
		p->rank_epoch = o->epoch;
	}
}

void od_sees(order *o, od_item *p, pm *next) {
	if (p->values == next) return;
	if (p->values)
		for (size_t i = 0; i < p->values->cap; i++) {
			od_item *q = (od_item *)p->values->keys[i];
			if (q == NULL || (next && pm_has(next, q))) continue;
			name(q, -1);
			if (edge(p, q)) o->ranks_ok = false;
		}
	if (next)
		for (size_t i = 0; i < next->cap; i++) {
			od_item *q = (od_item *)next->keys[i];
			if (q == NULL || pm_has(p->values, q)) continue;
			name(q, 1);
			if (edge(p, q)) o->ranks_ok = false;
		}
	if (p->values) {
		pm_clear(p->values);
		free(p->values);
	}
	p->values = next;
}

void od_waits(order *o, od_item *p, od_item *q) {
	if (p->after == q) return;
	if (p->after) {
		name(p->after, -1);
		if (edge(p, p->after)) o->ranks_ok = false;
	}
	p->after = q;
	if (q) {
		name(q, 1);
		if (edge(p, q)) o->ranks_ok = false;
	}
}

void od_gone(order *o, od_item *p) {
	if (p->named > 0) o->ranks_ok = false;
	od_delete(o, p);
	if (p->values) {
		for (size_t i = 0; i < p->values->cap; i++)
			if (p->values->keys[i] != NULL) name((od_item *)p->values->keys[i], -1);
		pm_clear(p->values);
		free(p->values);
		p->values = NULL;
	}
	if (p->after) name(p->after, -1);
	p->after = NULL;
	// out of the live list
	if (p->slot < o->nlive && o->live[p->slot] == p) {
		od_item *last = o->live[--o->nlive];
		o->live[p->slot] = last;
		last->slot = p->slot;
	}
}
