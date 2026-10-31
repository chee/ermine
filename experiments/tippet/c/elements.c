// Elements (see elements.h). A sequence is a list of runs in order: elements one after another of
// one device, numbered one on (or one down), their steps' lamports going on evenly, all gone or none,
// held as one (typing is one run, forward or back). With them how many are not gone, and a cursor (j, and live: how many before
// runs[j] are not gone) that typing and edits near the last move from (an element is found near the
// cursor, else from the first).
#include "elements.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MADE, SPLICE, PUT };

// a run's most elements
#define MOST ((1u << 29) - 1)

// an element as a run holds it: made, its device and seq; born, its place (its step the list's); none,
// the start or the end. device EL_NONE as ORG_NONE
#define ORG_NONE ((1u << 30) - 1)
typedef struct {
	uint32_t device : 30, born : 1, none : 1;
	uint32_t lo, hi;
} org;

// made: numbered c on (back: c down), lamports lamport on (back: down) by rate each; born (there
// since the list's step): places c on. left: what the first goes after (back: each), right: what each
// goes before (back: the last); none the start, the end
typedef struct {
	uint64_t c, lamport;
	uint32_t device, rate;
	uint32_t len : 29, gone : 1, born : 1, back : 1;
	org left, right;
} run;

static const el_id NOWHERE = {EL_NONE, 2, 0, 0};
static int nowhere(const el_id *i) { return i->born == 2; }
static org org_of(const el_id *i) {
	if (nowhere(i)) return (org){0, 0, 1, 0, 0};
	uint64_t x = i->born ? i->k : i->c;
	return (org){i->device == EL_NONE ? ORG_NONE : i->device, i->born, 0, (uint32_t)x, (uint32_t)(x >> 32)};
}
static int org_is(org a, org b) {
	return a.none == b.none && (a.none || (a.device == b.device && a.born == b.born && a.lo == b.lo && a.hi == b.hi));
}

// a run by its lowest id (device, born, number): sorted, with its place in runs
typedef struct {
	uint32_t device, born;
	uint64_t lo, hi;
	size_t j;
} ixe;

struct el_list {
	const tp_mem *mem;
	ixe *ix; // the runs by their lowest id: made when a lookup walks far, kept up to date by edit
	size_t nix, roomix;
	uint8_t *key;
	size_t keyn;
	run *runs;
	size_t n, room;
	el_ref by; // the step its born ones are since
	el_ref last; // the newest step that spliced it (lamport 0: none)
	size_t count, j, live;
};

static void list_free(const tp_mem *mem, el_list *l) {
	tp_free(mem, l->ix, l->roomix * sizeof *l->ix);
	tp_free(mem, l->runs, l->room * sizeof *l->runs);
	tp_free(mem, l->key, l->keyn);
	tp_free(mem, l, sizeof *l);
}

// room for 4 runs more: a change adds 2 at most, and undoing it 2 more
static int grow(const tp_mem *mem, el_list *l) {
	if (l->n + 4 <= l->room) return 0;
	size_t room = l->room ? l->room : 4;
	while (room < l->n + 4) room *= 2;
	run *r = tp_grow(mem, l->runs, l->room * sizeof *r, room * sizeof *r);
	if (!r) return -1;
	l->runs = r, l->room = room;
	return 0;
}

static el_id id_at(const el_list *l, const run *r, uint64_t o) {
	return r->born ? (el_id){r->device, 1, l->by.n, r->c + o}
		: (el_id){r->device, 0, r->back ? r->c - o : r->c + o, 0};
}
// the lowest id of r's [o, o + n)
static el_id low(const el_list *l, const run *r, uint64_t o, uint64_t n) {
	return id_at(l, r, r->back ? o + n - 1 : o);
}
static el_id id_of(const el_list *l, org g) {
	if (g.none) return NOWHERE;
	uint64_t x = (uint64_t)g.hi << 32 | g.lo;
	uint32_t d = g.device == ORG_NONE ? EL_NONE : g.device;
	return g.born ? (el_id){d, 1, l->by.n, x} : (el_id){d, 0, x, 0};
}
static el_id left_of(const el_list *l, const run *r, uint64_t o) {
	return !r->back && o ? id_at(l, r, o - 1) : id_of(l, r->left);
}
static el_id right_of(const el_list *l, const run *r, uint64_t o) {
	return r->back && o + 1 < r->len ? id_at(l, r, o + 1) : id_of(l, r->right);
}
static el_id plus(el_id i, uint64_t x) {
	if (i.born) i.k += x;
	else i.c += x;
	return i;
}
static int same(const el_id *a, const el_id *b) {
	return a->device == b->device && a->born == b->born && a->c == b->c && a->k == b->k;
}
// where id is in r, or -1
static long place(const el_list *l, const run *r, const el_id *id) {
	if (r->device != id->device || r->born != id->born || (id->born && id->c != l->by.n)) return -1;
	uint64_t x = id->born ? id->k : id->c;
	if (r->back) return x <= r->c && r->c - x < r->len ? (long)(r->c - x) : -1;
	return x >= r->c && x - r->c < r->len ? (long)(x - r->c) : -1;
}
// how many of the n ids from run j's place o on are there, one on; *p the first place of them
static uint64_t span(const el_list *l, size_t j, uint64_t o, uint64_t n, uint64_t *p) {
	const run *r = &l->runs[j];
	uint64_t m = r->back ? o + 1 : r->len - o;
	if (m > n) m = n;
	*p = r->back ? o + 1 - m : o;
	return m;
}
static int ix_less(const ixe *e, uint32_t device, uint32_t born, uint64_t x) {
	return e->device != device ? e->device < device : e->born != born ? e->born < born : e->lo <= x;
}
// how many entries sort at or before (device, born, x)
static size_t ix_below(const el_list *l, uint32_t device, uint32_t born, uint64_t x) {
	size_t a = 0, b = l->nix;
	while (a < b) {
		size_t m = (a + b) / 2;
		if (ix_less(&l->ix[m], device, born, x)) a = m + 1;
		else b = m;
	}
	return a;
}
static ixe ix_of(const run *r, size_t j) {
	return (ixe){r->device, r->born, r->back ? r->c - r->len + 1 : r->c, r->back ? r->c : r->c + r->len - 1, j};
}
static int ix_cmp(const void *a, const void *b) {
	const ixe *x = a, *y = b;
	if (x->device != y->device) return x->device < y->device ? -1 : 1;
	if (x->born != y->born) return x->born < y->born ? -1 : 1;
	return x->lo < y->lo ? -1 : x->lo > y->lo;
}
// runs it takes to walk before the index is made
#define FAR 32
static void ix_drop(el_list *l) {
	tp_free(l->mem, l->ix, l->roomix * sizeof *l->ix);
	l->ix = NULL, l->nix = l->roomix = 0;
}
static void ix_build(el_list *l) {
	l->ix = tp_alloc(l->mem, l->n * sizeof *l->ix);
	if (!l->ix) return;
	l->roomix = l->nix = l->n;
	for (size_t j = 0; j < l->n; j++) l->ix[j] = ix_of(&l->runs[j], j);
	qsort(l->ix, l->nix, sizeof *l->ix, ix_cmp);
}
// an element's run and place in it: near the cursor first, then by the index
static int find(el_list *l, const el_id *id, size_t *j, uint64_t *o) {
	for (size_t d = 0; d < 4; d++) {
		size_t at[2] = {l->j - 1 - d, l->j + d};
		for (int i = 0; i < 2; i++) {
			long x = at[i] < l->n ? place(l, &l->runs[at[i]], id) : -1;
			if (x >= 0) return *j = at[i], *o = (uint64_t)x, 1;
		}
	}
	if (l->n > FAR && !l->ix) ix_build(l);
	if (l->ix) {
		uint64_t x = id->born ? id->k : id->c;
		size_t b = ix_below(l, id->device, id->born, x);
		if (!b || (id->born && id->c != l->by.n)) return 0;
		const ixe *e = &l->ix[b - 1];
		if (e->device != id->device || e->born != id->born || x > e->hi) return 0;
		const run *r = &l->runs[e->j];
		return *j = e->j, *o = r->back ? r->c - x : x - r->c, 1;
	}
	for (size_t i = 0; i < l->n; i++) {
		long x = place(l, &l->runs[i], id);
		if (x >= 0) return *j = i, *o = (uint64_t)x, 1;
	}
	return 0;
}
static int there(el_list *l, const el_gone *g) {
	size_t j;
	uint64_t o, p;
	for (uint64_t x = 0; x < g->count; x += span(l, j, o, g->count - x, &p)) {
		el_id id = plus(g->id, x);
		if (!find(l, &id, &j, &o)) return 0;
	}
	return 1;
}

static size_t live_of(const run *r) { return r->gone ? 0 : r->len; }
// how many before runs[j] are not gone, the cursor moved there
static size_t live_before(el_list *l, size_t j) {
	while (l->j < j) l->live += live_of(&l->runs[l->j++]);
	while (l->j > j) l->live -= live_of(&l->runs[--l->j]);
	return l->live;
}
// the a-th element not gone, its run (n: past the last) and place *o, the cursor there
static size_t live_at(el_list *l, size_t a, uint64_t *o) {
	while (l->j > 0 && l->live > a) l->live -= live_of(&l->runs[--l->j]);
	for (; l->j < l->n; l->live += live_of(&l->runs[l->j++])) {
		const run *r = &l->runs[l->j];
		if (!r->gone && l->live + r->len > a) return *o = a - l->live, l->j;
	}
	return *o = 0, l->j;
}
// runs [j, j + del) for ins (room made before), the cursor at j
#define IXGONE 3
static void ix_edit(el_list *l, size_t j, size_t del, const run *ins, size_t nins) {
	// more removed than it holds: the index goes, and is made again at the next lookup that walks far
	if (del > IXGONE) {
		ix_drop(l);
		return;
	}
	if (nins != del) {
		for (size_t i = 0; i < l->nix; i++) {
			if (l->ix[i].j >= j + del) l->ix[i].j = l->ix[i].j + nins - del;
		}
	}
	ixe gone[IXGONE];
	for (size_t k = 0; k < del; k++) {
		gone[k] = ix_of(&l->runs[j + k], 0);
		l->ix[ix_below(l, gone[k].device, gone[k].born, gone[k].lo) - 1].j = (size_t)-1;
	}
	for (size_t i = 0; i < nins; i++) {
		ixe n = ix_of(&ins[i], j + i);
		size_t b = ix_below(l, n.device, n.born, n.lo);
		if (b && l->ix[b - 1].device == n.device && l->ix[b - 1].born == n.born && l->ix[b - 1].lo == n.lo &&
			l->ix[b - 1].j == (size_t)-1) {
			l->ix[b - 1] = n;
			continue;
		}
		if (l->nix == l->roomix) {
			size_t room = l->roomix ? 2 * l->roomix : 8;
			ixe *x = tp_grow(l->mem, l->ix, l->roomix * sizeof *x, room * sizeof *x);
			if (!x) {
				ix_drop(l);
				return;
			}
			l->ix = x, l->roomix = room;
		}
		memmove(l->ix + b + 1, l->ix + b, (l->nix - b) * sizeof *l->ix);
		l->ix[b] = n, l->nix++;
	}
	for (size_t k = 0; k < del; k++) {
		size_t b = ix_below(l, gone[k].device, gone[k].born, gone[k].lo) - 1;
		if (l->ix[b].j != (size_t)-1) continue;
		memmove(l->ix + b, l->ix + b + 1, (l->nix - b - 1) * sizeof *l->ix);
		l->nix--;
	}
}
static void edit(el_list *l, size_t j, size_t del, const run *ins, size_t nins) {
	live_before(l, j);
	if (l->ix) ix_edit(l, j, del, ins, nins);
	memmove(l->runs + j + nins, l->runs + j + del, (l->n - j - del) * sizeof *l->runs);
	if (nins) memcpy(l->runs + j, ins, nins * sizeof *ins);
	l->n = l->n + nins - del;
}
// runs[j - 1] and runs[j] as one, if they go on from each other: numbers one on (or one down), each
// after (or before) the one before, lamports evenly
static void join(el_list *l, size_t j) {
	if (j == 0 || j >= l->n) return;
	run a = l->runs[j - 1], b = l->runs[j];
	if (a.device != b.device || a.born != b.born || a.gone != b.gone || (uint64_t)a.len + b.len > MOST) return;
	el_id last = id_at(l, &a, a.len - 1), first = id_at(l, &b, 0);
	int on = (a.len == 1 || !a.back) && (b.len == 1 || !b.back) && a.c + a.len == b.c &&
		org_is(b.left, org_of(&last)) && org_is(a.right, b.right);
	int down = !on && !a.born && (a.len == 1 || a.back) && (b.len == 1 || b.back) && a.c >= a.len &&
		a.c - a.len == b.c && org_is(a.right, org_of(&first)) && org_is(a.left, b.left);
	if ((!on && !down) || (on ? b.lamport < a.lamport : a.lamport < b.lamport)) return;
	uint64_t step = on ? b.lamport - a.lamport : a.lamport - b.lamport;
	uint64_t rate = a.len > 1 ? a.rate : b.len > 1 ? b.rate : step;
	if (rate > UINT32_MAX || step != rate * a.len || (b.len > 1 && b.rate != rate)) return;
	a.len += b.len, a.rate = (uint32_t)rate, a.back = (uint32_t)!!down;
	if (down) a.right = b.right;
	edit(l, j - 1, 2, &a, 1);
}
// run r's elements [o, o + n)
static run part(const el_list *l, const run *r, uint64_t o, uint64_t n) {
	run p = *r;
	p.len = (uint32_t)n;
	if (r->back) {
		p.c = r->c - o, p.lamport = r->lamport - (uint64_t)r->rate * o;
		el_id x = id_at(l, r, o + n);
		if (o + n < r->len) p.right = org_of(&x);
	} else {
		p.c = r->c + o, p.lamport = r->lamport + (uint64_t)r->rate * o;
		el_id x = id_at(l, r, o ? o - 1 : 0);
		if (o) p.left = org_of(&x);
	}
	return p;
}
// run j's elements [o, o + n) a run of their own: its index
static size_t cut(el_list *l, size_t j, uint64_t o, uint64_t n) {
	run r = l->runs[j], parts[3];
	size_t k = 0;
	if (o) parts[k++] = part(l, &r, 0, o);
	parts[k++] = part(l, &r, o, n);
	if (o + n < r.len) parts[k++] = part(l, &r, o + n, r.len - o - n);
	edit(l, j, 1, parts, k);
	return j + (o ? 1 : 0);
}
static void mark(el_list *l, size_t j, uint64_t o, uint64_t n, int gone) {
	size_t i = cut(l, j, o, n);
	l->runs[i].gone = (uint32_t)gone;
	l->count = gone ? l->count - n : l->count + n;
	join(l, i + 1), join(l, i);
}

// paths are cbor arrays, canonical: one is a prefix of another when its items are the other's first
// items, byte for byte. the prefix's length in items, or -1
static long prefix_of(tp_span a, tp_span b) {
	tp_in x = {a.p, a.p + a.n}, y = {b.p, b.p + b.n};
	uint64_t m, k;
	if (tp_array(&x, &m) || tp_array(&y, &k) || m > k) return -1;
	size_t bytes = (size_t)(x.end - x.p);
	if ((size_t)(y.end - y.p) < bytes || memcmp(x.p, y.p, bytes)) return -1;
	return (long)m;
}
static int under(tp_span prefix, const uint8_t *key, size_t keyn) {
	return prefix_of(prefix, (tp_span){key, keyn}) >= 0;
}

static int is_seq(const op_value *v) { return v && (v->type == OP_LIST || v->type == OP_STR); }
// a sequence's length, or -1: counted once, when its elements are made, and for what a splice inserts
static long units(const op_value *v) {
	if (!v) return -1;
	if (v->type == OP_LIST) return (long)v->count;
	if (v->type != OP_STR) return -1;
	long n = 0;
	for (size_t i = 0; i < v->bytes; i++) n += (((unsigned char)v->str[i]) & 0xc0) != 0x80;
	return n;
}

// what is at the target's path, NULL if nothing
static const op_value *at_path(const op_value *v, const op_target *t) {
	for (size_t i = 0; i < t->length; i++) {
		const op_key *k = &t->path[i];
		if (!v) return NULL;
		if (v->type == OP_LIST) {
			if (k->type != OP_NUM_KEY || k->n < 0 || (size_t)k->n >= v->count) return NULL;
			v = v->items[k->n];
		} else if (v->type == OP_MAP) {
			char digits[32];
			const char *name = k->s;
			if (k->type == OP_NUM_KEY) snprintf(digits, sizeof digits, "%ld", k->n), name = digits;
			v = op_get(v, name);
		} else return NULL;
	}
	return v;
}

static tp_span move_path(tp_span move) {
	tp_in in = {move.p, move.p + move.n};
	uint64_t k;
	tp_span key, v = {NULL, 0};
	tp_map(&in, &k);
	for (uint64_t i = 0; i < k; i++) {
		tp_text(&in, &key), tp_skip(&in, &v);
		if (tp_is(key, "path")) return v;
	}
	return v;
}



typedef struct {
	const el_ctx *c;
	el_state *st;
	el_back *back;
	el_ref ref;
	int late;
} work;

static int devcmp(const el_ctx *c, uint32_t x, uint32_t y) {
	if (x == y) return 0;
	if (x == EL_NONE) return -1;
	if (y == EL_NONE) return 1;
	return memcmp(c->bytes(c->self, x), c->bytes(c->self, y), 32);
}
// a step after this one
static int newer(const work *w, const el_ref *a) {
	if (a->lamport != w->ref.lamport) return a->lamport > w->ref.lamport;
	return devcmp(w->c, a->device, w->ref.device) > 0;
}
// late: a step after this one made where or above it new
static int covered(const work *w, tp_span where) {
	for (size_t i = 0; i < w->st->nborn; i++) {
		const el_born *b = &w->st->born[i];
		if (prefix_of((tp_span){b->key, b->keyn}, where) >= 0 && newer(w, &b->r)) return 1;
	}
	return 0;
}
// late: a step after this one made new or spliced what is under where (self: or where)
static int touched(const work *w, tp_span where, int self) {
	for (size_t i = 0; i < w->st->nborn; i++) {
		const el_born *b = &w->st->born[i];
		if (under(where, b->key, b->keyn) && newer(w, &b->r)) return 1;
	}
	for (size_t i = 0; i < w->st->n; i++) {
		const el_list *l = w->st->lists[i];
		int at = l->keyn == where.n && !memcmp(l->key, where.p, where.n);
		if (under(where, l->key, l->keyn) && (self || !at) && newer(w, &l->last)) return 1;
	}
	return 0;
}
// the element at runs[j], place o, sorts after one of this step's at seq c: by lamport, device, seq
// (a born one before what its step inserts)
static int sorts_after(const work *w, const el_list *l, size_t j, uint64_t o, uint64_t c) {
	const run *r = &l->runs[j];
	uint64_t at = r->born ? l->by.lamport : r->back ? r->lamport - (uint64_t)r->rate * o : r->lamport + (uint64_t)r->rate * o;
	if (at != w->ref.lamport) return at > w->ref.lamport;
	int d = devcmp(w->c, r->born ? l->by.device : r->device, w->ref.device);
	return d ? d > 0 : !r->born && id_at(l, r, o).c > c;
}

typedef struct {
	size_t j;
	uint64_t o;
} pos;
static int ahead(pos a, pos b) { return a.j < b.j || (a.j == b.j && a.o < b.o); }
static pos next_pos(const el_list *l, pos p) {
	return p.o + 1 < l->runs[p.j].len ? (pos){p.j, p.o + 1} : (pos){p.j + 1, 0};
}
// the elements from a scan's start on, by id: their places. ends: a piece's first and last (where
// an element's left and right mostly are), hashed; ranges: the rest, sorted when looked in
typedef struct {
	el_id id;
	pos at;
	int used;
} tip;
typedef struct {
	el_id id; // the lowest
	uint64_t n;
	pos at;
	int back;
} range;
typedef struct {
	const tp_mem *mem;
	tip *ends;
	size_t nends, room;
	range *ranges;
	size_t nranges, roomranges;
	int sorted;
} seen;

static uint64_t id_hash(const el_id *i) {
	uint64_t h = ((uint64_t)i->device << 1 | i->born) * 0x9e3779b97f4a7c15u ^ i->c * 0xbf58476d1ce4e5b9u ^
		i->k * 0x94d049bb133111ebu;
	return h ^ h >> 31;
}
static int end_put(seen *s, const el_id *id, pos at) {
	if (2 * (s->nends + 1) > s->room) {
		size_t room = s->room ? 2 * s->room : 64;
		tip *e = tp_alloc(s->mem, room * sizeof *e);
		if (!e) return -1;
		memset(e, 0, room * sizeof *e);
		for (size_t i = 0; i < s->room; i++) {
			if (!s->ends[i].used) continue;
			size_t k = id_hash(&s->ends[i].id) & (room - 1);
			while (e[k].used) k = (k + 1) & (room - 1);
			e[k] = s->ends[i];
		}
		tp_free(s->mem, s->ends, s->room * sizeof *s->ends);
		s->ends = e, s->room = room;
	}
	size_t k = id_hash(id) & (s->room - 1);
	while (s->ends[k].used && !same(&s->ends[k].id, id)) k = (k + 1) & (s->room - 1);
	if (!s->ends[k].used) s->nends++;
	s->ends[k] = (tip){*id, at, 1};
	return 0;
}
static int range_cmp(const void *x, const void *y) {
	const el_id *a = &((const range *)x)->id, *b = &((const range *)y)->id;
	if (a->device != b->device) return a->device < b->device ? -1 : 1;
	if (a->born != b->born) return a->born < b->born ? -1 : 1;
	uint64_t p = a->born ? a->k : a->c, q = b->born ? b->k : b->c;
	if (a->c != b->c && a->born) return a->c < b->c ? -1 : 1;
	return p < q ? -1 : p > q;
}
// run j's [o, o + n) seen
static int see(seen *s, const el_list *l, size_t j, uint64_t o, uint64_t n) {
	const run *r = &l->runs[j];
	el_id first = id_at(l, r, o), last = id_at(l, r, o + n - 1);
	if (end_put(s, &first, (pos){j, o}) || end_put(s, &last, (pos){j, o + n - 1})) return -1;
	if (n < 3) return 0;
	if (s->nranges == s->roomranges) {
		size_t room = s->roomranges ? 2 * s->roomranges : 16;
		range *g = tp_grow(s->mem, s->ranges, s->roomranges * sizeof *g, room * sizeof *g);
		if (!g) return -1;
		s->ranges = g, s->roomranges = room;
	}
	range g = {low(l, r, o, n), n, {j, o}, r->back};
	if (s->nranges && range_cmp(&s->ranges[s->nranges - 1], &g) > 0) s->sorted = 0;
	s->ranges[s->nranges++] = g;
	return 0;
}
// where id is among those seen: 1, *at
static int seen_at(seen *s, const el_id *id, pos *at) {
	if (s->room) {
		for (size_t k = id_hash(id) & (s->room - 1); s->ends[k].used; k = (k + 1) & (s->room - 1)) {
			if (same(&s->ends[k].id, id)) return *at = s->ends[k].at, 1;
		}
	}
	if (!s->nranges) return 0;
	if (!s->sorted) qsort(s->ranges, s->nranges, sizeof *s->ranges, range_cmp), s->sorted = 1;
	// the last whose lowest is id or below
	size_t a = 0, b = s->nranges;
	range probe = {*id, 0, {0, 0}, 0};
	while (a < b) {
		size_t m = (a + b) / 2;
		if (range_cmp(&s->ranges[m], &probe) <= 0) a = m + 1;
		else b = m;
	}
	if (!a) return 0;
	const range *g = &s->ranges[a - 1];
	if (g->id.device != id->device || g->id.born != id->born || (id->born && g->id.c != id->c)) return 0;
	uint64_t x = id->born ? id->k : id->c, lo = g->id.born ? g->id.k : g->id.c;
	if (x - lo >= g->n) return 0;
	*at = (pos){g->at.j, g->at.o + (g->back ? g->n - 1 - (x - lo) : x - lo)};
	return 1;
}
static void seen_free(seen *s) {
	tp_free(s->mem, s->ends, s->room * sizeof *s->ends);
	tp_free(s->mem, s->ranges, s->roomranges * sizeof *s->ranges);
}

// where an insert by ids, its first at seq c, goes, from i (right after its left) to its right (at
// rp): past those inserted there meanwhile, as FugueMax (Gentle's YjsMod): by each one's own left and
// right, then by sort key, greater first. those between are looked up by id as far as the scan has
// looked, so it costs what lies between, at most. 0, *out; or TP_NOMEM
static int scan(const work *w, const el_list *l, pos i, const el_id *left, const el_id *right, const pos *rp,
	uint64_t c, pos *out) {
	seen s = {w->c->mem, NULL, 0, 0, NULL, 0, 0, 1};
#define AT(p) (rp && (p).j == rp->j && (p).o == rp->o)
#define UPTO(p) ((rp && rp->j == (p).j ? rp->o : l->runs[(p).j].len) - (p).o)
	// looked up so far: from i to far
	pos far = i, spot = i, at;
	int scanning = 0, code = 0;
	for (;;) {
		if (!scanning) spot = i;
		if (i.j >= l->n || AT(i)) break;
		while (!ahead(i, far)) {
			uint64_t n = UPTO(far);
			if (see(&s, l, far.j, far.o, n)) {
				code = TP_NOMEM;
				goto done;
			}
			far = far.o + n < l->runs[far.j].len ? (pos){far.j, far.o + n} : (pos){far.j + 1, 0};
		}
		const run *r = &l->runs[i.j];
		el_id ol = left_of(l, r, i.o);
		// its left against ours: before (-1), the same (0), passed (1)
		int x = nowhere(&ol) ? (nowhere(left) ? 0 : -1)
			: nowhere(left) ? 1
			: same(&ol, left) ? 0
			: seen_at(&s, &ol, &at) && ahead(at, i) ? 1 : -1;
		if (x < 0) break;
		int y = 1;
		if (x == 0) {
			// its right against ours: before (-1), the same (0), after (1)
			el_id orr = right_of(l, r, i.o);
			if (nowhere(&orr)) y = nowhere(right) ? 0 : 1;
			else if (nowhere(right)) y = -1;
			else if (same(&orr, right)) y = 0;
			else {
				int found;
				while (!(found = seen_at(&s, &orr, &at)) && far.j < l->n && !AT(far)) {
					uint64_t n = UPTO(far);
					if (see(&s, l, far.j, far.o, n)) {
						code = TP_NOMEM;
						goto done;
					}
					far = far.o + n < l->runs[far.j].len ? (pos){far.j, far.o + n} : (pos){far.j + 1, 0};
				}
				y = found ? -1 : 1;
			}
			if (y == 0 && !sorts_after(w, l, i.j, i.o, c)) break;
			scanning = y < 0;
		}
		// what is passed at once: a run's later elements, each after the one before (forward), or
		// all after ours (back, once one is) and each before the next, nearer than ours
		uint64_t up = UPTO(i), n = !r->back || x > 0 ? up : y < 0 && up > 1 ? up - 1 : 1;
		i = i.o + n < r->len ? (pos){i.j, i.o + n} : (pos){i.j + 1, 0};
	}
	*out = spot;
done:
#undef AT
#undef UPTO
	seen_free(&s);
	return code;
}

static int rec_room(work *w) {
	el_back *b = w->back;
	if (b->n < b->room) return 0;
	size_t room = b->room ? 2 * b->room : 1;
	el_rec *p = tp_grow(w->c->mem, b->p, b->room * sizeof *p, room * sizeof *p);
	if (!p) return -1;
	b->p = p, b->room = room;
	return 0;
}

static el_list *list_at(const el_state *st, tp_span path) {
	for (size_t i = 0; i < st->n; i++) {
		el_list *l = st->lists[i];
		if (l->keyn == path.n && !memcmp(l->key, path.p, path.n)) return l;
	}
	return NULL;
}

// room for one more list in the state
static int lists_room(const tp_mem *mem, el_state *st) {
	if (st->n < st->room) return 0;
	size_t room = st->room ? 2 * st->room : 4;
	el_list **p = tp_grow(mem, st->lists, st->room * sizeof *p, room * sizeof *p);
	if (!p) return -1;
	st->lists = p, st->room = room;
	return 0;
}

// the sequence at the target's path (path, its where: the key), its elements made now: those there
// since the step that made it new
static int elements(work *w, const op_value *cur, const op_target *place, tp_span path, el_list **out) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	if ((*out = list_at(st, path))) return 0;
	long most = -1;
	el_ref by = {0, 0, 0, EL_NONE};
	for (size_t i = 0; i < st->nborn; i++) {
		long m = prefix_of((tp_span){st->born[i].key, st->born[i].keyn}, path);
		if (m > most) most = m, by = st->born[i].r;
	}
	size_t count = (size_t)units(at_path(cur, place)), runs = (count + MOST - 1) / MOST;
	el_list *l = tp_alloc(mem, sizeof *l);
	if (!l) return TP_NOMEM;
	memset(l, 0, sizeof *l);
	l->mem = mem;
	l->key = tp_alloc(mem, path.n), l->keyn = path.n;
	l->room = runs + 4, l->runs = tp_alloc(mem, l->room * sizeof *l->runs);
	if (!l->key || !l->runs || rec_room(w) || lists_room(mem, st)) {
		if (!l->runs) l->room = 0;
		list_free(mem, l);
		return TP_NOMEM;
	}
	memcpy(l->key, path.p, path.n);
	for (size_t k = 0; k < count; k += MOST) {
		uint32_t len = (uint32_t)(count - k < MOST ? count - k : MOST);
		l->runs[l->n++] = (run){.c = k, .device = by.device, .len = len, .born = 1, .left = {.none = 1}, .right = {.none = 1}};
	}
	l->by = by, l->count = count;
	st->lists[st->n++] = l;
	w->back->p[w->back->n++] = (el_rec){.kind = MADE, .splice = {.list = l}};
	*out = l;
	return 0;
}

// the sequences at where and under it made new by this step (a put, a removal, a move there); self
// 0: under it only (a splice into an array without a through)
static int renew(work *w, tp_span prefix, int self) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	size_t nl = 0, nb = 0;
#define GOES(l) (under(prefix, (l)->key, (l)->keyn) && (self || (l)->keyn != prefix.n || memcmp((l)->key, prefix.p, prefix.n)))
	for (size_t i = 0; i < st->n; i++) nl += GOES(st->lists[i]);
	for (size_t i = 0; i < st->nborn; i++) nb += under(prefix, st->born[i].key, st->born[i].keyn);
	el_list **rl = nl ? tp_alloc(mem, nl * sizeof *rl) : NULL;
	el_born *rb = nb ? tp_alloc(mem, nb * sizeof *rb) : NULL;
	uint8_t *key = tp_alloc(mem, prefix.n);
	int bad = (nl && !rl) || (nb && !rb) || !key || rec_room(w);
	if (!bad && st->nborn - nb + 1 > st->roomborn) {
		size_t room = st->roomborn ? 2 * st->roomborn : 4;
		el_born *born = tp_grow(mem, st->born, st->roomborn * sizeof *born, room * sizeof *born);
		if (born) st->born = born, st->roomborn = room;
		else bad = 1;
	}
	if (bad) {
		tp_free(mem, rl, nl * sizeof *rl), tp_free(mem, rb, nb * sizeof *rb);
		tp_free(mem, key, prefix.n);
		return TP_NOMEM;
	}
	size_t k = 0;
	for (size_t i = 0; i < st->n; i++) {
		if (GOES(st->lists[i])) rl[k++] = st->lists[i];
		else st->lists[i - k] = st->lists[i];
	}
#undef GOES
	st->n -= nl, k = 0;
	for (size_t i = 0; i < st->nborn; i++) {
		if (under(prefix, st->born[i].key, st->born[i].keyn)) rb[k++] = st->born[i];
		else st->born[i - k] = st->born[i];
	}
	st->nborn -= nb;
	memcpy(key, prefix.p, prefix.n);
	st->born[st->nborn++] = (el_born){key, prefix.n, w->ref};
	w->back->p[w->back->n++] = (el_rec){.kind = PUT, .put = {rb, nb, rl, nl, key}};
	return 0;
}

// b: a cbor array of n items, then items' bytes
static void keyed(tp_buf *b, size_t n, const tp_buf *items) {
	b->len = 0;
	tp_put_head(b, 4, n), tp_put(b, items->p, items->len);
}
// an element as a where item: [device, c] or [device, n, k]
static void put_id(tp_buf *b, const el_id *e) {
	tp_put_head(b, 4, e->born ? 3 : 2), tp_put_head(b, 0, e->device), tp_put_head(b, 0, e->c);
	if (e->born) tp_put_head(b, 0, e->k);
}

// a path's first upto items, its arrays' items found by the ids by names (NULL: none), wherever they
// are now (one gone or not there: OP_RANGE), or by place as written. out (room for upto): the path
// to apply; where: its key, each array item as its element; ids (room for upto, or NULL) those
// elements, *found how many (-1: one not there)
static int locate(work *w, const op_value *cur, const op_target *t, tp_span path, const el_id *by,
	size_t upto, op_key *out, tp_buf *where, el_id *ids, long *found) {
	const tp_mem *mem = w->c->mem;
	tp_in in = {path.p, path.p + path.n};
	uint64_t k;
	tp_array(&in, &k);
	tp_buf items = {NULL, 0, 0, (size_t)-1, mem, 0}, key = {NULL, 0, 0, (size_t)-1, mem, 0};
	if (upto) memcpy(out, t->path, upto * sizeof *out);
	*found = 0;
	size_t x = 0;
	int code = 0;
	for (size_t i = 0; i < upto && !code; i++) {
		const uint8_t *from = in.p;
		tp_span item;
		tp_skip(&in, &item);
		if (out[i].type != OP_NUM_KEY) {
			tp_put(&items, from, (size_t)(in.p - from));
			continue;
		}
		const el_id *id = by ? &by[x++] : NULL;
		op_target up = {out, i, 0, 0, 0};
		const op_value *a = at_path(cur, &up);
		el_id e = {0};
		int has = 0;
		if (a && a->type == OP_LIST) {
			el_list *l;
			keyed(&key, i, &items);
			if ((code = tp_buf_why(&key)) || (code = elements(w, cur, &up, (tp_span){key.p, key.len}, &l))) break;
			size_t j;
			uint64_t o;
			if (id) {
				if (!find(l, id, &j, &o) || l->runs[j].gone) code = OP_RANGE;
				else e = *id, has = 1, out[i].n = (long)(live_before(l, j) + (size_t)o);
			} else if (w->late && newer(w, &l->last)) code = TP_LATE;
			else if (out[i].n >= 0 && (size_t)out[i].n < l->count) {
				j = live_at(l, (size_t)out[i].n, &o);
				e = id_at(l, &l->runs[j], o), has = 1;
			}
		} else if (id) code = OP_RANGE;
		if (has) put_id(&items, &e);
		else tp_put(&items, from, (size_t)(in.p - from));
		if (ids && has && *found >= 0) ids[(*found)++] = e;
		else if (!has) *found = -1;
	}
	if (!code) keyed(where, upto, &items), code = tp_buf_why(&items) ? TP_NOMEM : tp_buf_why(where);
	tp_buf_free(&items), tp_buf_free(&key);
	return code;
}

// a target at an index of an array (no range): 1; else 0
static int in_array(const op_value *cur, const op_target *t) {
	if (t->has_range || !t->length || t->path[t->length - 1].type != OP_NUM_KEY) return 0;
	op_target up = *t;
	up.length--;
	const op_value *a = at_path(cur, &up);
	return a && a->type == OP_LIST;
}

// what a move makes new at one end, by place: the sequence a range is in, or the array an index is
// in, or what is at the path
static int end(work *w, const op_value *cur, const op_target *t, tp_span path, op_key *keys) {
	tp_buf where = {NULL, 0, 0, (size_t)-1, w->c->mem, 0};
	long found;
	int code = locate(w, cur, t, path, NULL, t->length - (size_t)in_array(cur, t), keys, &where, NULL, &found);
	if (!code) code = renew(w, (tp_span){where.p, where.len}, 1);
	tp_buf_free(&where);
	return code;
}

// room for one more in a growing array of size each
static int more(const tp_mem *mem, void **p, size_t n, size_t *room, size_t each) {
	if (n < *room) return 0;
	size_t r = *room ? 2 * *room : 4;
	void *q = tp_grow(mem, *p, *room * each, r * each);
	if (!q) return -1;
	*p = q, *room = r;
	return 0;
}

// a splice, its inserted ones counted from c, by its ids (anchor) or its range, as the patches to
// apply by position (*qs, *nq)
static int splice(work *w, const op_value *cur, const op_patch *p, tp_span key, uint64_t c,
	const el_anchor *anchor, int name, op_patch **qs, size_t *nq, size_t *qcap, el_anchor *named) {
	const tp_mem *mem = w->c->mem;
	// an insert of another kind than the sequence (a list into a text): doesn't apply, as apply refuses
	const op_value *into = at_path(cur, &p->place);
	if (p->has_value && (!p->value || p->value->type != into->type)) return OP_WRONG_KIND;
	el_list *l;
	int code = elements(w, cur, &p->place, key, &l);
	if (code) return code;
	// by its range, late: only as it was, unspliced since
	if (w->late && !anchor && newer(w, &l->last)) return TP_LATE;
	uint64_t a = (uint64_t)p->place.from, b = (uint64_t)p->place.to, o;
	long m = p->has_value ? units(p->value) : 0;
	size_t j, ngone = 0, roomgone = 0, nout = 0, qroom = 0;
	el_gone *gone = NULL;
	const el_gone *names;
	size_t nnames;
	op_patch *out = NULL;
	el_id first = {0}, right = NOWHERE;
	int has_first = 0;
	// what it names: the element it goes after, and those it takes away, as runs
	if (anchor) {
		has_first = anchor->has_after, first = anchor->after, j = 0, o = 0;
		if (has_first && !find(l, &first, &j, &o)) return OP_RANGE;
		for (size_t r = 0; r < anchor->ngone; r++) {
			if (!there(l, &anchor->gone[r])) return OP_RANGE;
		}
		// its before: there, and after its after
		if (anchor->has_before && anchor->same && !has_first) return OP_RANGE;
		if (anchor->has_before && anchor->same) right = right_of(l, &l->runs[j], o);
		else if (anchor->has_before) right = anchor->before;
		pos f = {j, o}, at;
		if (!nowhere(&right) && (!find(l, &right, &at.j, &at.o) || (has_first && !ahead(f, at)))) return OP_RANGE;
		names = anchor->gone, nnames = anchor->ngone;
	} else {
		if (a > b || b > l->count) return OP_RANGE;
		if (a) j = live_at(l, (size_t)a - 1, &o), first = id_at(l, &l->runs[j], o), has_first = 1;
		for (uint64_t x = a; x < b;) {
			j = live_at(l, (size_t)x, &o);
			const run *r = &l->runs[j];
			uint64_t n = r->len - o < b - x ? r->len - o : b - x;
			el_id i = low(l, r, o, n), next = ngone ? plus(gone[ngone - 1].id, gone[ngone - 1].count) : i;
			if (ngone && same(&next, &i)) gone[ngone - 1].count += n;
			else if (more(mem, (void **)&gone, ngone, &roomgone, sizeof *gone)) {
				code = TP_NOMEM;
				goto done;
			} else gone[ngone++] = (el_gone){i, n};
			x += n;
		}
		names = gone, nnames = ngone;
	}
	// its record first, so a failure from here is undone with the rest
	if (rec_room(w)) {
		code = TP_NOMEM;
		goto done;
	}
	size_t ri = w->back->n++;
	w->back->p[ri] = (el_rec){.kind = SPLICE, .splice = {.list = l, .was = l->last}};
	if (!newer(w, &l->last)) l->last = w->ref;
#define REC (w->back->p[ri].splice)
	// the gone ones still there taken away, each once however often named, by position
	for (size_t r = 0; r < nnames; r++) {
		for (uint64_t x = 0; x < names[r].count;) {
			el_id id = plus(names[r].id, x);
			find(l, &id, &j, &o);
			uint64_t m = span(l, j, o, names[r].count - x, &o);
			x += m;
			if (l->runs[j].gone) continue;
			if (grow(mem, l) || more(mem, (void **)&REC.taken, REC.ntaken, &REC.roomtaken, sizeof *REC.taken) ||
				more(mem, (void **)&out, nout + 1, &qroom, sizeof *out)) {
				code = TP_NOMEM;
				goto done;
			}
			size_t from = live_before(l, j) + (size_t)o;
			mark(l, j, o, m, 1);
			REC.taken[REC.ntaken++] = (el_gone){id, m};
			op_patch *last = nout ? &out[nout - 1] : NULL;
			if (last && (size_t)last->place.from == from) last->place.to += (int64_t)m;
			else if (last && from + m == (size_t)last->place.from) last->place.from = (int64_t)from;
			else {
				out[nout] = (op_patch){0}, out[nout].place = p->place;
				out[nout].place.from = (int64_t)from, out[nout++].place.to = (int64_t)(from + m);
			}
		}
	}
	// where the inserted go: right after its element; by ids, past those put there meanwhile
	pos lp = {0, 0}, rp = {0, 0}, spot = {0, 0};
	el_id left = has_first ? first : NOWHERE;
	int same_before = 0;
	if (has_first) find(l, &first, &lp.j, &lp.o), spot = next_pos(l, lp);
	if (anchor) {
		int has_rp = !nowhere(&right) && find(l, &right, &rp.j, &rp.o);
		if ((code = scan(w, l, spot, &left, &right, has_rp ? &rp : NULL, c, &spot))) goto done;
	} else if (name && m > 0 && spot.j < l->n) {
		right = id_at(l, &l->runs[spot.j], spot.o);
		el_id after_right = has_first ? right_of(l, &l->runs[lp.j], lp.o) : NOWHERE;
		same_before = has_first && same(&after_right, &right);
	}
	j = spot.j, o = spot.o;
	size_t to = live_before(l, j) + (j < l->n && !l->runs[j].gone ? (size_t)o : 0);
	if (more(mem, (void **)&out, nout + 1, &qroom, sizeof *out)) {
		code = TP_NOMEM;
		goto done;
	}
	if (m > 0) {
		if ((uint64_t)m > MOST || grow(mem, l)) {
			code = (uint64_t)m > MOST ? OP_RANGE : TP_NOMEM;
			goto done;
		}
		if (o) j = cut(l, j, o, l->runs[j].len - o);
		run made = {.c = c, .lamport = w->ref.lamport, .device = w->ref.device, .len = (uint32_t)m,
			.left = org_of(&left), .right = org_of(&right)};
		edit(l, j, 0, &made, 1);
		l->count += (size_t)m;
		join(l, j + 1), join(l, j);
		REC.device = w->ref.device, REC.c = c, REC.m = (uint64_t)m;
	}
	if (m > 0 || !nout) {
		out[nout] = (op_patch){0};
		out[nout].place = p->place;
		out[nout].place.from = out[nout].place.to = (int64_t)to;
		if (m > 0) out[nout].has_value = 1, out[nout].value = p->value;
		nout++;
	}
#undef REC
	if (name && named) {
		// not named: one of them made by no step (no put made its sequence), so it goes by its range
		int none = (has_first && first.device == EL_NONE) || (!nowhere(&right) && !same_before && right.device == EL_NONE);
		for (size_t r = 0; r < ngone; r++) none |= gone[r].id.device == EL_NONE;
		el_gone *g = ngone ? tp_grow(mem, gone, roomgone * sizeof *g, ngone * sizeof *g) : NULL;
		if (ngone && !g) {
			code = TP_NOMEM;
			goto done;
		}
		if (ngone) gone = g, roomgone = ngone;
		if (!none) {
			*named = (el_anchor){1, has_first, first, gone, ngone, !nowhere(&right), same_before, right, NULL, 0, 0};
			gone = NULL, roomgone = 0;
		}
	}
	*qs = out, *nq = nout, *qcap = qroom, out = NULL;
done:
	tp_free(mem, gone, roomgone * sizeof *gone), tp_free(mem, out, qroom * sizeof *out);
	return code;
}

// a patch but a move, its path's array items found (by ids or by place): a splice, a removal at an
// index of an array (a splice of that one) or a put. keys: room for its path; *qs (made) the
// patches to apply; named (NULL: not naming) its ids
static int patch(work *w, const op_value *cur, const op_patch *p, tp_span path, uint64_t c,
	const el_anchor *given, op_key *keys, el_anchor *named, op_patch **qs, size_t *nq, size_t *qcap) {
	const tp_mem *mem = w->c->mem;
	const el_id *by = given && given->has_through ? given->through : NULL;
	size_t len = p->place.length;
	int one = !p->place.has_range && !p->has_value && len && p->place.path[len - 1].type == OP_NUM_KEY;
	tp_buf where = {NULL, 0, 0, (size_t)-1, mem, 0};
	el_id *ids = named ? tp_alloc(mem, (len ? len : 1) * sizeof *ids) : NULL;
	el_anchor sp = {0};
	long found = 0;
	int list = 0, empty = 0;
	if (named && !ids) return TP_NOMEM;
	int code = locate(w, cur, &p->place, path, by, len - (size_t)one, keys, &where, ids, &found);
	if (!code && w->late && covered(w, (tp_span){where.p, where.len})) code = TP_LATE;
	op_patch q = *p;
	q.place.path = keys, q.place.length = len - (size_t)one;
	const op_value *at = code ? NULL : at_path(cur, &q.place);
	if (!code && one && at && at->type == OP_LIST) {
		// by its id: taken away wherever it is now, once
		el_gone g = {by ? by[given->nthrough - 1] : (el_id){0, 0, 0, 0}, 1};
		el_anchor gone = {1, 0, {0, 0, 0, 0}, &g, 1, 0, 0, {0, 0, 0, 0}, NULL, 0, 0};
		long k = p->place.path[len - 1].n;
		q.place.has_range = 1, q.place.from = k, q.place.to = k + 1, list = 1;
		if (w->late && !by && touched(w, (tp_span){where.p, where.len}, 0)) code = TP_LATE;
		else code = splice(w, cur, &q, (tp_span){where.p, where.len}, c, by ? &gone : NULL, !!named, qs, nq, qcap,
			named ? &sp : NULL);
		if (!code && named && sp.named && found >= 0) ids[found++] = sp.gone[0].id;
		else found = -1;
	} else {
		// not into an array: the whole path, as any
		if (!code && one) code = locate(w, cur, &p->place, path, by, len, keys, &where, ids, &found);
		if (!code && one && w->late && covered(w, (tp_span){where.p, where.len})) code = TP_LATE;
		q.place.length = len, at = code ? NULL : at_path(cur, &q.place);
		if (!code && p->place.has_range && is_seq(at)) {
			list = at->type == OP_LIST;
			if (w->late && list && !by && touched(w, (tp_span){where.p, where.len}, 0)) code = TP_LATE;
			else code = splice(w, cur, &q, (tp_span){where.p, where.len}, c, given && given->named ? given : NULL,
				!!named, qs, nq, qcap, named);
			// a splice into an array named says through, empty when its path has no whole
			empty = list && named && named->named;
		} else if (!code && w->late && touched(w, (tp_span){where.p, where.len}, 1)) {
			code = TP_LATE;
		} else if (!code && !(code = renew(w, (tp_span){where.p, where.len}, 1))) {
			if (!(*qs = tp_alloc(mem, sizeof **qs))) code = TP_NOMEM;
			else **qs = q, *nq = 1, *qcap = 1;
		}
	}
	// named only when all are, each made by a step
	for (long i = 0; i < found; i++) {
		if (ids[i].device == EL_NONE) found = -1;
	}
	if (!code && named && (found > 0 || (found == 0 && empty))) {
		el_id *t = found ? tp_grow(mem, ids, (len ? len : 1) * sizeof *ids, (size_t)found * sizeof *ids) : NULL;
		if (found && !t) code = TP_NOMEM;
		else if (found) named->through = t, ids = NULL;
		if (!code) named->nthrough = (size_t)found, named->has_through = 1;
	}
	// into an array without a through (by place, or from before through): what is under it new
	int keeps = named ? named->has_through : given && given->has_through;
	if (!code && list && !keeps) code = renew(w, (tp_span){where.p, where.len}, 0);
	tp_free(mem, sp.gone, sp.ngone * sizeof *sp.gone);
	tp_free(mem, ids, (len ? len : 1) * sizeof *ids), tp_buf_free(&where);
	return code;
}

// undoes one record
static void undo_rec(const tp_mem *mem, el_state *st, el_rec *r) {
	if (r->kind == MADE) {
		for (size_t i = 0; i < st->n; i++) {
			if (st->lists[i] != r->splice.list) continue;
			memmove(st->lists + i, st->lists + i + 1, (st->n - i - 1) * sizeof *st->lists);
			st->n--;
			list_free(mem, r->splice.list);
			break;
		}
	} else if (r->kind == SPLICE) {
		el_list *l = r->splice.list;
		size_t j;
		uint64_t o;
		el_id id = {r->splice.device, 0, r->splice.c, 0};
		for (uint64_t x = 0, m = r->splice.m; x < m;) {
			el_id at = plus(id, x);
			find(l, &at, &j, &o);
			uint64_t n = span(l, j, o, m - x, &o);
			size_t i = cut(l, j, o, n);
			edit(l, i, 1, NULL, 0);
			l->count -= (size_t)n, x += n;
			join(l, i);
		}
		for (size_t g = r->splice.ntaken; g-- > 0;) {
			const el_gone *taken = &r->splice.taken[g];
			for (uint64_t x = 0; x < taken->count;) {
				el_id at = plus(taken->id, x);
				find(l, &at, &j, &o);
				uint64_t n = span(l, j, o, taken->count - x, &o);
				mark(l, j, o, n, 0), x += n;
			}
		}
		l->last = r->splice.was;
		tp_free(mem, r->splice.taken, r->splice.roomtaken * sizeof *r->splice.taken);
	} else {
		for (size_t i = 0; i < st->nborn; i++) {
			if (st->born[i].key != r->put.pushed) continue;
			tp_free(mem, st->born[i].key, st->born[i].keyn);
			memmove(st->born + i, st->born + i + 1, (st->nborn - i - 1) * sizeof *st->born);
			st->nborn--;
			break;
		}
		for (size_t i = 0; i < r->put.nborn; i++) st->born[st->nborn++] = r->put.born[i];
		for (size_t i = 0; i < r->put.nlists; i++) st->lists[st->n++] = r->put.lists[i];
		tp_free(mem, r->put.born, r->put.nborn * sizeof *r->put.born);
		tp_free(mem, r->put.lists, r->put.nlists * sizeof *r->put.lists);
	}
}

static void drop_rec(const tp_mem *mem, el_rec *r) {
	if (r->kind == SPLICE) tp_free(mem, r->splice.taken, r->splice.roomtaken * sizeof *r->splice.taken);
	if (r->kind != PUT) return;
	for (size_t i = 0; i < r->put.nborn; i++) tp_free(mem, r->put.born[i].key, r->put.born[i].keyn);
	for (size_t i = 0; i < r->put.nlists; i++) list_free(mem, r->put.lists[i]);
	tp_free(mem, r->put.born, r->put.nborn * sizeof *r->put.born);
	tp_free(mem, r->put.lists, r->put.nlists * sizeof *r->put.lists);
}

void el_back_undo(const tp_mem *mem, el_state *st, el_back *back) {
	while (back->n) undo_rec(mem, st, &back->p[--back->n]);
	tp_free(mem, back->p, back->room * sizeof *back->p);
	*back = (el_back){0};
}

void el_back_free(const tp_mem *mem, el_back *back) {
	for (size_t i = 0; i < back->n; i++) drop_rec(mem, &back->p[i]);
	tp_free(mem, back->p, back->room * sizeof *back->p);
	*back = (el_back){0};
}

int el_seed(const tp_mem *mem, el_state *st, const el_ref *ref) {
	uint8_t *key = tp_alloc(mem, 1);
	st->born = tp_alloc(mem, 4 * sizeof *st->born);
	if (!key || !st->born) {
		tp_free(mem, key, 1), tp_free(mem, st->born, 4 * sizeof *st->born);
		st->born = NULL;
		return TP_NOMEM;
	}
	*key = 0x80;
	st->roomborn = 4, st->nborn = 1;
	st->born[0] = (el_born){key, 1, *ref};
	return 0;
}

void el_state_free(const tp_mem *mem, el_state *st) {
	for (size_t i = 0; i < st->n; i++) list_free(mem, st->lists[i]);
	for (size_t i = 0; i < st->nborn; i++) tp_free(mem, st->born[i].key, st->born[i].keyn);
	tp_free(mem, st->lists, st->room * sizeof *st->lists);
	tp_free(mem, st->born, st->roomborn * sizeof *st->born);
	*st = (el_state){0};
}

// undoes the records past marks (a step that failed)
static void rollback(work *w, size_t marks) {
	el_back *b = w->back;
	while (b->n > marks) undo_rec(w->c->mem, w->st, &b->p[--b->n]);
}

int el_step(const el_ctx *c, el_state *st, op_value **value, const el_ref *ref, tp_span patches,
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int name, int late,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named) {
	work w = {c, st, back, *ref, late};
	size_t marks = back->n, at = 0, nout = 0, roomout = 0, nus = 0, roomus = 0;
	op_value *cur = *value;
	int owned = 0, code = 0;
	op_patch *out = NULL, *cat = NULL;
	op_undo *us = NULL;
	el_anchor *nm = NULL;
	size_t total = 0, room = 0, from = 0;
	uint64_t made = 0; // the step's elements so far: the next is its seq + made
	for (size_t i = 0; i < n; i++) {
		size_t m = ps[i].has_move && ps[i].move.length > ps[i].place.length ? ps[i].move.length : ps[i].place.length;
		room += m;
	}
	// the paths as applied, each patch's from its own place in it
	op_key *pool = tp_alloc(c->mem, (room ? room : 1) * sizeof *pool);
	if (!pool) return TP_NOMEM;
	if (name && named && n && !(nm = tp_alloc(c->mem, n * sizeof *nm))) {
		tp_free(c->mem, pool, (room ? room : 1) * sizeof *pool);
		return TP_NOMEM;
	}
	if (nm) memset(nm, 0, n * sizeof *nm);
	tp_patch tp;
	for (size_t i = 0; i < n && !code; i++) {
		if (tp_patch_next(patches, &at, &tp)) {
			code = OP_NOT_A_PATCH;
			break;
		}
		uint64_t counter = ref->seq + made;
		made += tp_patch_made(&tp);
		const op_patch *p = &ps[i];
		op_key *keys = pool + from;
		from += p->has_move && p->move.length > p->place.length ? p->move.length : p->place.length;
		if (keep && !keep[i]) continue;
		op_patch *qs = (op_patch *)p, *made_qs = NULL;
		size_t nq = 1, qcap = 0;
		if (p->has_move && late) code = TP_LATE;
		else if (p->has_move) {
			// by place
			code = end(&w, cur, &p->place, tp.path, keys);
			if (!code) code = end(&w, cur, &p->move, move_path(tp.move), keys);
		} else {
			code = patch(&w, cur, p, tp.path, counter, !name && ids ? &ids[i] : NULL, keys, nm ? &nm[i] : NULL,
				&made_qs, &nq, &qcap);
			if (!code) qs = made_qs;
		}
		for (size_t q = 0; q < nq && !code; q++) {
			op_value *next = NULL;
			size_t failed;
			op_undo u = {NULL, 0, 0};
			op_apply_options ao = {.undo = &u};
			if ((code = op_apply(cur, &qs[q], 1, undo ? &ao : NULL, &next, &failed))) break;
			if (owned) op_free(cur);
			cur = next, owned = 1;
			if (nout == roomout) {
				size_t room = roomout ? 2 * roomout : 8;
				op_patch *o = realloc(out, room * sizeof *o);
				if (!o) {
					op_undo_free(&u);
					code = TP_NOMEM;
					break;
				}
				out = o, roomout = room;
			}
			if (undo && nus == roomus) {
				size_t room = roomus ? 2 * roomus : 8;
				op_undo *t = tp_grow(c->mem, us, roomus * sizeof *t, room * sizeof *t);
				if (!t) {
					op_undo_free(&u);
					code = TP_NOMEM;
					break;
				}
				us = t, roomus = room;
			}
			out[nout++] = qs[q];
			if (undo) us[nus++] = u;
		}
		tp_free(c->mem, made_qs, qcap * sizeof *made_qs);
	}
	if (!code && undo) {
		for (size_t i = 0; i < nus; i++) total += us[i].n;
		if (total && !(cat = malloc(total * sizeof *cat))) code = TP_NOMEM;
	}
	// the patches as applied, their paths after them
	op_patch *whole = NULL;
	if (!code && applied && nout && !(whole = malloc(nout * sizeof *whole + room * sizeof *pool))) {
		free(cat);
		code = TP_NOMEM;
	}
	if (whole) {
		op_key *k = (op_key *)(whole + nout);
		uintptr_t lo = (uintptr_t)pool, hi = (uintptr_t)(pool + room);
		if (room) memcpy(k, pool, room * sizeof *k);
		for (size_t i = 0; i < nout; i++) {
			whole[i] = out[i];
			uintptr_t at = (uintptr_t)out[i].place.path;
			if (at >= lo && at < hi) whole[i].place.path = k + (out[i].place.path - pool);
		}
	}
	tp_free(c->mem, pool, (room ? room : 1) * sizeof *pool);
	if (code) {
		for (size_t i = 0; i < nus; i++) op_undo_free(&us[i]);
		tp_free(c->mem, us, roomus * sizeof *us);
		free(out);
		if (nm) el_anchors_free(c->mem, nm, n);
		if (owned) op_free(cur);
		rollback(&w, marks);
		return code;
	}
	if (undo) {
		size_t k = 0;
		for (size_t i = nus; i-- > 0;) {
			if (us[i].n) memcpy(cat + k, us[i].patches, us[i].n * sizeof *cat);
			k += us[i].n;
			free(us[i].patches);
		}
		*undo = (op_undo){cat, total, total};
	}
	tp_free(c->mem, us, roomus * sizeof *us);
	if (owned) op_free(*value), *value = cur;
	free(out);
	if (applied) *applied = whole, *napplied = nout;
	if (named) *named = nm;
	return 0;
}

void el_anchors_free(const tp_mem *mem, el_anchor *a, size_t n) {
	if (!a) return;
	for (size_t i = 0; i < n; i++) {
		tp_free(mem, a[i].gone, a[i].ngone * sizeof *a[i].gone);
		tp_free(mem, a[i].through, a[i].nthrough * sizeof *a[i].through);
	}
	tp_free(mem, a, n * sizeof *a);
}

int el_named(const el_anchor *a, size_t n) {
	for (size_t i = 0; a && i < n; i++) {
		if (a[i].named || a[i].has_through) return 1;
	}
	return 0;
}

// an element id as written: this device's x (seq - x; past seq, none) or [x, k] (step n - x),
// another's [device, seq] or [device, n, k]
static int read_id(const el_ctx *c, tp_in *in, const tp_step *s, uint64_t seq, uint32_t me, el_id *id) {
	uint64_t k, a, b = 0;
	int64_t x;
	tp_span key;
	if (in->p < in->end && *in->p >> 5 <= 1) {
		if (tp_int(in, &x)) return -1;
		uint64_t back = x >= 0 ? (uint64_t)x : 0, on = x < 0 ? (uint64_t)-x : 0;
		*id = (el_id){back > seq ? EL_UNKNOWN : me, 0, seq - (back > seq ? 0 : back) + on, 0};
		return 0;
	}
	if (tp_array(in, &k)) return -1;
	if (in->p < in->end && *in->p >> 5 == 0) {
		if (tp_whole(in, &a) || tp_whole(in, &b) || a >= s->n) return -1;
		*id = (el_id){me, 1, s->n - a, b};
		return 0;
	}
	if (tp_bytes(in, 32, &key) || tp_whole(in, &a) || (k == 3 && tp_whole(in, &b))) return -1;
	// a device not known has no elements: nothing is named by it, and it is not made known
	long d = c->find(c->self, key.p);
	*id = (el_id){d < 0 ? EL_UNKNOWN : (uint32_t)d, k == 3, a, b};
	return 0;
}

int el_read(const el_ctx *c, const tp_step *s, uint64_t seq, el_anchor **out) {
	*out = NULL;
	if (!s->ids.p) return 0;
	tp_in in = {s->ids.p, s->ids.p + s->ids.n};
	uint64_t k;
	long me = c->index(c->self, s->device);
	if (me < 0) return TP_NOMEM;
	if (tp_array(&in, &k)) return TP_NOTSTEP;
	el_anchor *a = k ? tp_alloc(c->mem, (size_t)k * sizeof *a) : NULL;
	if (k && !a) return TP_NOMEM;
	if (k) memset(a, 0, (size_t)k * sizeof *a);
	int code = 0;
	for (uint64_t i = 0; i < k && !code; i++) {
		uint64_t two, g = 0, t = 0;
		if (tp_null(&in)) continue;
		if (tp_array(&in, &two)) code = TP_NOTSTEP;
		else if (two > 1 && !tp_null(&in)) {
			code = read_id(c, &in, s, seq, (uint32_t)me, &a[i].after), a[i].has_after = 1;
		}
		if (!code && two > 1 && tp_array(&in, &g)) code = TP_NOTSTEP;
		if (!code && g && !(a[i].gone = tp_alloc(c->mem, (size_t)g * sizeof *a[i].gone))) code = TP_NOMEM;
		if (!code) a[i].ngone = (size_t)g;
		for (uint64_t j = 0; j < g && !code; j++) {
			uint64_t pair;
			if (tp_array(&in, &pair) || read_id(c, &in, s, seq, (uint32_t)me, &a[i].gone[j].id) ||
				tp_whole(&in, &a[i].gone[j].count))
				code = TP_NOTSTEP;
		}
		if (!code && two > 2 && !tp_null(&in)) {
			a[i].has_before = 1;
			if (in.p < in.end && *in.p == 0xf5) in.p++, a[i].same = 1;
			else code = read_id(c, &in, s, seq, (uint32_t)me, &a[i].before) ? TP_NOTSTEP : 0;
		}
		a[i].named = !code && two > 1;
		// through: the last of one or four
		if (!code && (two == 1 || two == 4) && tp_array(&in, &t)) code = TP_NOTSTEP;
		if (!code && t && !(a[i].through = tp_alloc(c->mem, (size_t)t * sizeof *a[i].through))) code = TP_NOMEM;
		if (!code) a[i].nthrough = (size_t)t, a[i].has_through = two == 1 || two == 4;
		for (uint64_t j = 0; j < t && !code; j++) {
			if (read_id(c, &in, s, seq, (uint32_t)me, &a[i].through[j])) code = TP_NOTSTEP;
		}
	}
	if (code) return el_anchors_free(c->mem, a, (size_t)k), code;
	*out = a;
	return 0;
}

static void write_id(tp_buf *b, const el_ctx *c, const el_id *id, uint32_t me, uint64_t n, uint64_t seq) {
	if (id->device == me && id->born) tp_put_head(b, 4, 2), tp_put_head(b, 0, n - id->c);
	else if (id->device == me) {
		if (id->c <= seq) tp_put_head(b, 0, seq - id->c);
		else tp_put_head(b, 1, id->c - seq - 1);
	} else {
		tp_put_head(b, 4, id->born ? 3 : 2), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, id->device), 32);
		tp_put_head(b, 0, id->c);
	}
	if (id->born) tp_put_head(b, 0, id->k);
}

void el_write(tp_buf *b, const el_ctx *c, const el_anchor *a, size_t count, uint32_t me, uint64_t n,
	uint64_t seq) {
	tp_put_head(b, 4, count);
	for (size_t i = 0; i < count; i++) {
		if (!a[i].named && !a[i].has_through) {
			tp_put(b, "\xf6", 1);
			continue;
		}
		if (!a[i].named) {
			tp_put_head(b, 4, 1), tp_put_head(b, 4, a[i].nthrough);
			for (size_t j = 0; j < a[i].nthrough; j++) write_id(b, c, &a[i].through[j], me, n, seq);
			continue;
		}
		tp_put_head(b, 4, a[i].has_through ? 4 : a[i].has_before ? 3 : 2);
		if (a[i].has_after) write_id(b, c, &a[i].after, me, n, seq);
		else tp_put(b, "\xf6", 1);
		tp_put_head(b, 4, a[i].ngone);
		for (size_t j = 0; j < a[i].ngone; j++) {
			tp_put_head(b, 4, 2), write_id(b, c, &a[i].gone[j].id, me, n, seq);
			tp_put_head(b, 0, a[i].gone[j].count);
		}
		if (a[i].has_before && a[i].same) tp_put(b, "\xf5", 1);
		else if (a[i].has_before) write_id(b, c, &a[i].before, me, n, seq);
		else if (a[i].has_through) tp_put(b, "\xf6", 1);
		if (a[i].has_through) tp_put_head(b, 4, a[i].nthrough);
		for (size_t j = 0; j < a[i].nthrough; j++) write_id(b, c, &a[i].through[j], me, n, seq);
	}
}

