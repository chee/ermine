#include "order.h"

#include <stdint.h>
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
	// Ranks are valid while ranks_ok; an item is ranked when its rank_epoch equals epoch.
	uint64_t epoch;
	bool ranks_ok;
	size_t nranked;
	uint64_t stamps;
	od_item **work;
	size_t nwork, capwork;
	// The due items as a heap, ordered by rank, then mark, then order made. Rebuilt when the
	// ranks are, or when a due item's rank was mended.
	entry *heap;
	size_t nheap, capheap;
	uint64_t heap_epoch;
	bool heap_stale;
};

order *od_new(void) {
	order *o = calloc(1, sizeof *o);
	if (o == NULL) abort();
	return o;
}

void od_free(order *o) {
	free(o->live);
	free(o->heap);
	free(o->work);
	free(o);
}

static bool edge(const od_item *p, const od_item *q) { return q != NULL && q != p && q->alive; }

static void link(od_item *p, od_item *q) {
	uintptr_t n = (uintptr_t)pm_get(&q->rev, p);
	pm_set(&q->rev, p, (void *)(n + 1));
}
static void unlink(od_item *p, od_item *q) {
	uintptr_t n = (uintptr_t)pm_get(&q->rev, p);
	if (n > 1) pm_set(&q->rev, p, (void *)(n - 1));
	else if (n == 1) {
		pm_delete(&q->rev, p);
		if (q->rev.count == 0) pm_clear(&q->rev);
	}
}

static void work(order *o, od_item *x) {
	if (o->nwork == o->capwork) {
		o->capwork = o->capwork ? o->capwork * 2 : 16;
		o->work = realloc(o->work, o->capwork * sizeof *o->work);
		if (o->work == NULL) abort();
	}
	o->work[o->nwork++] = x;
}

static int rank_at(const order *o, const od_item *p, uint64_t epoch) {
	(void)o;
	return p->rank_epoch == epoch ? p->rank : 0;
}

static void grow(od_item ***a, size_t n, size_t *cap) {
	if (n < *cap) return;
	*cap = *cap ? *cap * 2 : 16;
	*a = realloc(*a, *cap * sizeof **a);
	if (*a == NULL) abort();
}

// An edge of p's to q: counted in the region if q is in it, else it raises p's minimum rank.
static size_t into(const order *o, uint64_t s, const od_item *p, const od_item *q, size_t *adj, size_t count,
                   int *floor) {
	if (!edge(p, q)) return count;
	if (q->stamp == s) adj[count++] = q->index;
	else if (rank_at(o, q, o->epoch) + 1 > *floor) *floor = rank_at(o, q, o->epoch) + 1;
	return count;
}

// Ranks start and everything after it (the region) again, using rank.h over the region's own
// edges. Each rank is at least one past anything the item is after outside the region. Nothing
// outside the region is after it, so nothing outside changes.
static void local(order *o, od_item *const *start, size_t nstart) {
	uint64_t s = ++o->stamps;
	od_item **stack = NULL, **at = NULL;
	size_t sp = 0, capstack = 0, n = 0, capat = 0;
	for (size_t i = 0; i < nstart; i++) {
		grow(&stack, sp, &capstack);
		stack[sp++] = start[i];
	}
	while (sp) {
		od_item *x = stack[--sp];
		if (!x->alive || x->stamp == s) continue;
		x->stamp = s;
		x->index = n;
		grow(&at, n, &capat);
		at[n++] = x;
		for (size_t i = 0; i < x->rev.cap; i++) {
			if (x->rev.keys[i] == NULL) continue;
			grow(&stack, sp, &capstack);
			stack[sp++] = (od_item *)x->rev.keys[i];
		}
	}
	size_t *off = malloc((n + 1) * sizeof *off);
	int *floor = calloc(n + 1, sizeof *floor);
	int *out = calloc(n + 1, sizeof *out);
	size_t cap = 16, count = 0;
	size_t *adj = malloc(cap * sizeof *adj);
	if (!off || !floor || !out || !adj) abort();
	for (size_t i = 0; i < n; i++) {
		od_item *p = at[i];
		off[i] = count;
		size_t need = count + (p->values ? p->values->count : 0) + 1;
		if (need > cap) {
			while (need > cap) cap *= 2;
			adj = realloc(adj, cap * sizeof *adj);
			if (adj == NULL) abort();
		}
		for (size_t j = 0; p->values && j < p->values->cap; j++)
			count = into(o, s, p, p->values->keys[j], adj, count, &floor[i]);
		count = into(o, s, p, p->after, adj, count, &floor[i]);
	}
	off[n] = count;
	rk_rank(n, off, adj, floor, out);
	for (size_t i = 0; i < n; i++) {
		od_item *p = at[i];
		if (p->rank_epoch != o->epoch) o->nranked++;
		p->rank = out[i];
		p->rank_epoch = o->epoch;
		p->member_epoch = 0;
		if (p->due) o->heap_stale = true;
	}
	for (size_t i = 0; i < n; i++)
		for (size_t j = off[i]; j < off[i + 1]; j++)
			if (out[adj[j]] == out[i]) at[i]->member_epoch = at[adj[j]]->member_epoch = o->epoch;
	free(stack);
	free(at);
	free(off);
	free(floor);
	free(out);
	free(adj);
}

// Mends ranks after the edges of the items in work changed. Each rises to one past its highest
// edge, and so does what is after it, as far as a rank rises. A rank never falls. A cycle member
// that is reached, or a cycle formed now, is ranked again locally. If mending takes longer than
// ranking everything would, the ranks are rebuilt in full on next use.
static void mend(order *o) {
	if (!o->ranks_ok) {
		o->nwork = 0;
		o->ranks_ok = false;
		return;
	}
	od_item *begun = o->nwork == 1 ? o->work[0] : NULL;
	size_t limit = 4 * o->nranked + 64;
	for (size_t steps = 0; o->nwork; steps++) {
		if (steps > limit) goto whole;
		od_item *x = o->work[--o->nwork];
		if (!x->alive) continue;
		if (x->member_epoch == o->epoch) {
			work(o, x);
			if (begun) work(o, begun);
			local(o, o->work, o->nwork);
			o->nwork = 0;
			return;
		}
		int k = 0;
		if (x->values)
			for (size_t i = 0; i < x->values->cap; i++) {
				const od_item *q = x->values->keys[i];
				if (q != NULL && edge(x, q) && rank_at(o, q, o->epoch) + 1 > k) k = rank_at(o, q, o->epoch) + 1;
			}
		if (edge(x, x->after) && rank_at(o, x->after, o->epoch) + 1 > k) k = rank_at(o, x->after, o->epoch) + 1;
		if (k <= rank_at(o, x, o->epoch)) continue;
		if (x->rank_epoch != o->epoch) o->nranked++;
		x->rank = k;
		x->rank_epoch = o->epoch;
		if (x->due) o->heap_stale = true;
		for (size_t i = 0; i < x->rev.cap; i++) {
			od_item *y = (od_item *)x->rev.keys[i];
			if (y == NULL) continue;
			if (y == begun) {
				o->nwork = 0;
				local(o, &begun, 1);
				return;
			}
			work(o, y);
		}
	}
	return;
whole:
	o->nwork = 0;
	o->ranks_ok = false;
}

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
	rk_rank(n, off, adj, NULL, out);
	o->nranked = n;
	o->epoch++;
	for (size_t i = 0; i < n; i++)
		for (size_t j = off[i]; j < off[i + 1]; j++)
			if (out[adj[j]] == out[i]) at[i]->member_epoch = at[adj[j]]->member_epoch = o->epoch;
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

int od_rank(order *o, const od_item *p) {
	ranks(o);
	return rank_at(o, p, o->epoch);
}

od_item *od_next(order *o, int *rank) {
	ranks(o);
	// The heap is rebuilt when the ranks are. A popped entry that is no longer due at its mark is
	// stale.
	if (o->heap_epoch != o->epoch || o->heap_stale || o->nheap > 4 * o->ndue + 64) {
		o->heap_epoch = o->epoch;
		o->heap_stale = false;
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
}

void od_sees(order *o, od_item *p, pm *next) {
	if (p->values == next) return;
	if (next) {
		od_item *gone[8];
		size_t ngone;
		do {
			ngone = 0;
			for (size_t i = 0; i < next->cap && ngone < 8; i++) {
				od_item *q = (od_item *)next->keys[i];
				if (q != NULL && !q->alive) gone[ngone++] = q;
			}
			for (size_t i = 0; i < ngone; i++) pm_delete(next, gone[i]);
		} while (ngone == 8);
	}
	bool changed = false;
	if (p->values)
		for (size_t i = 0; i < p->values->cap; i++) {
			od_item *q = (od_item *)p->values->keys[i];
			if (q == NULL || (next && pm_has(next, q))) continue;
			unlink(p, q);
			if (edge(p, q)) changed = true;
		}
	if (next)
		for (size_t i = 0; i < next->cap; i++) {
			od_item *q = (od_item *)next->keys[i];
			if (q == NULL || pm_has(p->values, q)) continue;
			link(p, q);
			if (edge(p, q)) changed = true;
		}
	if (p->values) {
		pm_clear(p->values);
		free(p->values);
	}
	p->values = next;
	if (changed) {
		work(o, p);
		mend(o);
	}
}

void od_waits(order *o, od_item *p, od_item *q) {
	if (q != NULL && !q->alive) q = NULL;
	if (p->after == q) return;
	bool changed = false;
	if (p->after) {
		unlink(p, p->after);
		if (edge(p, p->after)) changed = true;
	}
	p->after = q;
	if (q) {
		link(p, q);
		if (edge(p, q)) changed = true;
	}
	if (changed) {
		work(o, p);
		mend(o);
	}
}

void od_gone(order *o, od_item *p) {
	od_delete(o, p);
	if (p->values) {
		for (size_t i = 0; i < p->values->cap; i++)
			if (p->values->keys[i] != NULL) unlink(p, (od_item *)p->values->keys[i]);
		pm_clear(p->values);
		free(p->values);
		p->values = NULL;
	}
	if (p->after) unlink(p, p->after);
	p->after = NULL;
	if (o->ranks_ok && p->rank_epoch == o->epoch) {
		p->rank_epoch = 0;
		o->nranked--;
	}
	// What was after p keeps its rank. If p was in a cycle, what was after it is ranked again.
	if (o->ranks_ok && p->member_epoch == o->epoch) {
		p->member_epoch = 0;
		o->nwork = 0;
		for (size_t i = 0; i < p->rev.cap; i++)
			if (p->rev.keys[i] != NULL) work(o, (od_item *)p->rev.keys[i]);
		local(o, o->work, o->nwork);
		o->nwork = 0;
	}
	// Nothing after p is after it any more, so nothing names it and it can be freed. The heap is
	// rebuilt.
	for (size_t i = 0; i < p->rev.cap; i++) {
		od_item *x = (od_item *)p->rev.keys[i];
		if (x == NULL) continue;
		if (x->values) pm_delete(x->values, p);
		if (x->after == p) x->after = NULL;
	}
	if (o->nheap > 0) o->heap_stale = true;
	pm_clear(&p->rev);
	if (p->slot < o->nlive && o->live[p->slot] == p) {
		od_item *last = o->live[--o->nlive];
		o->live[p->slot] = last;
		last->slot = p->slot;
	}
}
