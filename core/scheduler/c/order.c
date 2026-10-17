#include "order.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "rank.h"

// the due by mark, then the order made
typedef struct dentry {
	od_item *p;
	uint64_t mark;
} dentry;

struct order {
	od_item **live;
	size_t nlive, caplive;
	size_t ndue;
	// ranks made at this epoch are good while ranks_ok; an item is ranked when its rank_epoch is
	// the epoch, and nranked count them
	uint64_t epoch;
	bool ranks_ok;
	size_t nranked;
	// the last stamp given (od_item stamp)
	uint64_t stamps;
	// the items to mend
	od_item **work;
	size_t nwork, capwork;
	// the due counted by rank (each one's counted, good while ranks_ok), and the ranks with some,
	// lowest first (a heap; a rank there twice, or none due at it, stale): the lowest rank due
	size_t *counts;
	size_t capcounts;
	int *lows;
	size_t nlows, caplows;
	// the due again, by mark, then the order made, to pick from; an entry no longer due at its mark,
	// or held, is stale
	dentry *dues;
	size_t ndues, capdues;
	// bumped when an edge goes, or the ranks are made again (a cycle may have joined): every held one
	// is looked at anew at the next pick (looked: the loose then)
	uint64_t loose, looked;
	// holds made since the held were last let go; those let go when what held them is due no longer
	od_hold *holds, *freed;
	size_t nholds, capholds, nfreed, capfreed;
	uint64_t nhold;
	// walks up: their number, and what one reached
	uint64_t walks;
	od_item **reached;
	size_t nreached, capreached;
	// the entries next sets aside, waiting after a due one
	dentry *waiting;
	size_t nwaiting, capwaiting;
};

order *od_new(void) {
	order *o = calloc(1, sizeof *o);
	if (o == NULL) abort();
	return o;
}

void od_free(order *o) {
	free(o->live);
	free(o->counts);
	free(o->lows);
	free(o->work);
	free(o->dues);
	free(o->holds);
	free(o->freed);
	free(o->reached);
	free(o->waiting);
	free(o);
}

void od_item_free(od_item *p) {
	free(p->way);
	free(p->holding);
	p->way = NULL;
	p->holding = NULL;
	p->nway = p->capway = p->nholding = p->capholding = 0;
}

#define GROW(v, n, cap) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
	} while (0)

static bool edge(const od_item *p, const od_item *q) { return q != NULL && q != p && q->alive; }

// p is after q by one more edge, or one less
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

static void tally(order *o, od_item *p, int r) {
	p->counted = r;
	if ((size_t)r >= o->capcounts) {
		size_t cap = o->capcounts ? o->capcounts : 16;
		while (cap <= (size_t)r) cap *= 2;
		o->counts = realloc(o->counts, cap * sizeof *o->counts);
		if (o->counts == NULL) abort();
		memset(o->counts + o->capcounts, 0, (cap - o->capcounts) * sizeof *o->counts);
		o->capcounts = cap;
	}
	if (++o->counts[r] != 1) return;
	GROW(o->lows, o->nlows, o->caplows);
	size_t i = o->nlows++;
	while (i > 0) {
		size_t up = (i - 1) >> 1;
		if (o->lows[up] <= r) break;
		o->lows[i] = o->lows[up];
		i = up;
	}
	o->lows[i] = r;
}
static void uncount(order *o, od_item *p) { o->counts[p->counted]--; }
// a due one's rank changed
static void moved(order *o, od_item *p, int r) {
	uncount(o, p);
	tally(o, p, r);
}
static int lowest(order *o) {
	while (o->nlows > 0 && o->counts[o->lows[0]] == 0) {
		int r = o->lows[--o->nlows];
		if (o->nlows == 0) break;
		size_t i = 0;
		for (;;) {
			size_t c = 2 * i + 1;
			if (c >= o->nlows) break;
			if (c + 1 < o->nlows && o->lows[c + 1] < o->lows[c]) c++;
			if (o->lows[c] >= r) break;
			o->lows[i] = o->lows[c];
			i = c;
		}
		o->lows[i] = r;
	}
	return o->nlows > 0 ? o->lows[0] : 0;
}

// q, an edge of p's: one of the region's edges, or one past its rank into p's floor
static size_t into(const order *o, uint64_t s, const od_item *p, const od_item *q, size_t *adj, size_t count,
                   int *floor) {
	if (!edge(p, q)) return count;
	if (q->stamp == s) adj[count++] = q->index;
	else if (rank_at(o, q, o->epoch) + 1 > *floor) *floor = rank_at(o, q, o->epoch) + 1;
	return count;
}

// ranked again from start and everything after it (the region): rank.h over the region's own
// edges, each at least one past what it is after outside it. nothing outside is after the
// region, so nothing outside changes. its members found again
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
	o->loose++;
	for (size_t i = 0; i < n; i++) {
		od_item *p = at[i];
		if (p->rank_epoch != o->epoch) o->nranked++;
		p->rank = out[i];
		p->rank_epoch = o->epoch;
		p->member_epoch = 0;
		if (p->due) moved(o, p, out[i]);
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

// the edges of what is in work changed: each rises to one past its edges' most, and what is
// after it too, as far as a rank rises; a rank never falls (order.ts). a cycle's member reached,
// or the one it began from reached again (after what is after it: a cycle made now): ranked
// again from there on (local). mending longer than a whole making would take: made whole at the
// next
static void mend(order *o) {
	if (!o->ranks_ok) {
		o->nwork = 0;
		o->ranks_ok = false;
		return;
	}
	// what it began from: its callers give one
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
		if (x->due) moved(o, x, k);
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
	rk_rank(n, off, adj, NULL, out);
	o->nranked = n;
	o->epoch++;
	o->loose++;
	for (size_t i = 0; i < n; i++)
		for (size_t j = off[i]; j < off[i + 1]; j++)
			if (out[adj[j]] == out[i]) at[i]->member_epoch = at[adj[j]]->member_epoch = o->epoch;
	for (size_t i = 0; i < n; i++) {
		at[i]->rank = out[i];
		at[i]->rank_epoch = o->epoch;
	}
	o->ranks_ok = true;
	// counted again, from the due
	if (o->capcounts) memset(o->counts, 0, o->capcounts * sizeof *o->counts);
	o->nlows = 0;
	for (size_t i = 0; i < n; i++)
		if (at[i]->due) tally(o, at[i], out[i]);
	free(off);
	free(adj);
	free(out);
	free(at);
}

// the due by mark, then the order made: a heap
static bool before(const dentry *a, const dentry *b) {
	if (a->mark != b->mark) return a->mark < b->mark;
	return a->p->n < b->p->n;
}
static void enter(order *o, od_item *p, uint64_t mark) {
	GROW(o->dues, o->ndues, o->capdues);
	dentry e = {p, mark};
	size_t i = o->ndues++;
	while (i > 0) {
		size_t up = (i - 1) >> 1;
		if (!before(&e, &o->dues[up])) break;
		o->dues[i] = o->dues[up];
		i = up;
	}
	o->dues[i] = e;
}
static dentry leave(order *o) {
	dentry top = o->dues[0];
	dentry last = o->dues[--o->ndues];
	if (o->ndues > 0) {
		size_t i = 0;
		for (;;) {
			size_t c = 2 * i + 1;
			if (c >= o->ndues) break;
			if (c + 1 < o->ndues && before(&o->dues[c + 1], &o->dues[c])) c++;
			if (!before(&o->dues[c], &last)) break;
			o->dues[i] = o->dues[c];
			i = c;
		}
		o->dues[i] = last;
	}
	return top;
}
static void reenter(order *o) {
	o->ndues = 0;
	for (size_t i = 0; i < o->nlive; i++) {
		od_item *p = o->live[i];
		if (p->due && p->hold == 0) enter(o, p, p->mark);
	}
}

// holds
static void hold(od_item *p) {
	od_item *x = p->way[p->way_at];
	GROW(x->holding, x->nholding, x->capholding);
	x->holding[x->nholding++] = (od_hold){p, p->hold};
}
// p is due no longer: what it held is looked at again
static void unhold(order *o, od_item *p) {
	for (size_t i = 0; i < p->nholding; i++) {
		GROW(o->freed, o->nfreed, o->capfreed);
		o->freed[o->nfreed++] = p->holding[i];
	}
	p->nholding = 0;
}
static bool live_hold(const order *o, od_hold h) {
	return h.p->hold == h.n && h.p->due && h.p->mark == h.p->hold_mark && h.p->hold_loose == o->loose;
}
static void release(order *o, od_item *p) {
	p->hold = 0;
	enter(o, p, p->mark);
}
// a held one whose holder is due no longer: the next due one down the way holds it, else it is
// picked from again
static void again(order *o, od_hold h) {
	if (!live_hold(o, h)) return;
	od_item *p = h.p;
	int k = rank_at(o, p, o->epoch);
	for (size_t i = p->way_at; i < p->nway; i++) {
		od_item *y = p->way[i];
		if (!y->alive || !y->due || rank_at(o, y, o->epoch) >= k) continue;
		p->way_at = i;
		hold(p);
		return;
	}
	release(o, p);
}

// one edge of x's on a walk up from p: reached, unless walked already or ranked under floor. a
// due one ranked under p: found
static bool reach(order *o, od_item *p, int k, int floor, od_item *x, od_item *q) {
	if (!edge(x, q) || q->walked == o->walks) return false;
	q->walked = o->walks;
	q->via = x;
	int r = rank_at(o, q, o->epoch);
	if (r < floor) return false;
	if (q->due && r < k) {
		p->nway = 0;
		GROW(p->way, p->nway, p->capway);
		p->way[p->nway++] = q;
		for (od_item *y = x; y != p; y = y->via) {
			GROW(p->way, p->nway, p->capway);
			p->way[p->nway++] = y;
		}
		return true;
	}
	GROW(o->reached, o->nreached, o->capreached);
	o->reached[o->nreached++] = q;
	return false;
}
// the walk up from p for a due one above it (ranked under it), seen no lower than floor: true,
// the way down from it in p's way
static bool above(order *o, od_item *p, int floor) {
	o->walks++;
	int k = rank_at(o, p, o->epoch);
	p->walked = o->walks;
	o->nreached = 0;
	GROW(o->reached, o->nreached, o->capreached);
	o->reached[o->nreached++] = p;
	for (size_t i = 0; i < o->nreached; i++) {
		od_item *x = o->reached[i];
		if (x->values)
			for (size_t j = 0; j < x->values->cap; j++) {
				od_item *q = (od_item *)x->values->keys[j];
				if (q != NULL && reach(o, p, k, floor, x, q)) return true;
			}
		if (x->after && reach(o, p, k, floor, x, x->after)) return true;
	}
	return false;
}

bool od_has(const order *o, const od_item *p) {
	(void)o;
	return p->due;
}
uint64_t od_at(const od_item *p) { return p->due ? p->mark : 0; }

void od_set(order *o, od_item *p, uint64_t mark) {
	if (!p->due) o->ndue++;
	else if (o->ranks_ok) uncount(o, p);
	p->due = true;
	p->mark = mark;
	p->hold = 0;
	enter(o, p, mark);
	if (o->ranks_ok) tally(o, p, rank_at(o, p, o->epoch));
}

void od_delete(order *o, od_item *p) {
	if (!p->due) return;
	o->ndue--;
	p->due = false;
	if (o->ranks_ok) uncount(o, p);
	p->hold = 0;
	unhold(o, p);
}

size_t od_size(const order *o) { return o->ndue; }

int od_rank(order *o, const od_item *p) {
	ranks(o);
	return rank_at(o, p, o->epoch);
}

od_item *od_next(order *o, int *rank) {
	ranks(o);
	// stale entries past four times the due: made again
	if (o->ndues > 4 * o->ndue + 64) reenter(o);
	// an edge gone or a cycle joined since: every held one is picked from again
	if (o->looked != o->loose) {
		o->looked = o->loose;
		o->nfreed = 0;
		for (size_t i = 0; i < o->nholds; i++)
			if (o->holds[i].p->hold == o->holds[i].n) release(o, o->holds[i].p);
		o->nholds = 0;
	} else if (o->nholds > 4 * o->ndue + 64) {
		size_t k = 0;
		for (size_t i = 0; i < o->nholds; i++)
			if (live_hold(o, o->holds[i])) o->holds[k++] = o->holds[i];
		o->nholds = k;
	}
	for (size_t i = 0; i < o->nfreed; i++) again(o, o->freed[i]);
	o->nfreed = 0;
	// no due one is above what is ranked under the lowest rank due
	int floor = lowest(o);
	od_item *best = NULL;
	while (o->ndues > 0) {
		dentry e = leave(o);
		od_item *p = e.p;
		if (!p->due || p->mark != e.mark || p->hold != 0) continue;
		if (p->after && p->after->due) {
			GROW(o->waiting, o->nwaiting, o->capwaiting);
			o->waiting[o->nwaiting++] = e;
			continue;
		}
		if (rank_at(o, p, o->epoch) > floor && above(o, p, floor)) {
			p->hold = ++o->nhold;
			p->hold_mark = p->mark;
			p->hold_loose = o->loose;
			p->way_at = 0;
			GROW(o->holds, o->nholds, o->capholds);
			o->holds[o->nholds++] = (od_hold){p, p->hold};
			hold(p);
			continue;
		}
		best = p;
		break;
	}
	for (size_t i = 0; i < o->nwaiting; i++) enter(o, o->waiting[i].p, o->waiting[i].mark);
	o->nwaiting = 0;
	if (best == NULL) abort();
	*rank = rank_at(o, best, o->epoch);
	return best;
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
	bool changed = false;
	if (p->values)
		for (size_t i = 0; i < p->values->cap; i++) {
			od_item *q = (od_item *)p->values->keys[i];
			if (q == NULL || (next && pm_has(next, q))) continue;
			unlink(p, q);
			if (edge(p, q)) {
				changed = true;
				o->loose++;
			}
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
	if (p->after == q) return;
	bool changed = false;
	if (p->after) {
		unlink(p, p->after);
		if (edge(p, p->after)) {
			changed = true;
			o->loose++;
		}
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
	o->loose++;
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
	// what was after it keeps its rank; a cycle's member: what was after it ranked again (local)
	if (o->ranks_ok && p->member_epoch == o->epoch) {
		p->member_epoch = 0;
		o->nwork = 0;
		for (size_t i = 0; i < p->rev.cap; i++)
			if (p->rev.keys[i] != NULL) work(o, (od_item *)p->rev.keys[i]);
		local(o, o->work, o->nwork);
		o->nwork = 0;
	}
	pm_clear(&p->rev);
	// out of the live list
	if (p->slot < o->nlive && o->live[p->slot] == p) {
		od_item *last = o->live[--o->nlive];
		o->live[p->slot] = last;
		last->slot = p->slot;
	}
}
