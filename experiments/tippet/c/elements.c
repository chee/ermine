// Elements (see elements.h). A sequence is a list of runs in order: elements one after another of
// one device, numbered one on (or one down), all gone or none, held as one (typing is one run,
// forward or back). With them how many are not gone, and a cursor (j, and live: how many before
// runs[j] are not gone) that typing and edits near the last move from (an element is found near the
// cursor, else from the first). State is keyed by container: a node is the bytes of cbor items one
// after another (the device's index, n, the patch, then the place in the patch's value), so one is
// under another when its bytes start with the other's.
#include "elements.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MADE, SPLICE, ADD, TAKE, DROP, HOLD, BIN, BINADD, BINTAKE, LANDED, REG, ORG };

// a run's most elements
#define MOST ((1u << 29) - 1)

// an element as a run holds it: made, its device and seq; born, its place (its step the list's); none,
// the start or the end. device EL_NONE as ORG_NONE
#define ORG_NONE ((1u << 30) - 1)
typedef struct {
	uint32_t device : 30, born : 1, none : 1;
	uint32_t lo, hi;
} org;

// an element a run's first links to, the rest one on each; set 0: none
typedef struct {
	uint32_t device : 30, born : 1, set : 1;
	uint32_t lo, hi;
} olink;

// made: numbered c on (back: c down); born (there
// since the list's step): places c on. left: what the first goes after (back: each), right: what each
// goes before (back: the last); none the start, the end
typedef struct {
	uint64_t c;
	uint32_t device;
	uint32_t len : 29, gone : 1, born : 1, back : 1;
	org left, right;
} run;

// the origin of len elements a move made, c on (of device): the item each is a move of, one on each
typedef struct {
	uint64_t c;
	uint32_t device, len;
	olink org;
} orgent;

// a move's or a removal's place in the order: lamport, device, n, patch
typedef struct {
	uint64_t lamport, n;
	uint32_t device, i;
} stamp;
// the register of items with origins (device, born, lo) one on, len of them: the event with the
// greatest stamp wins; el is the element that shows, for the first, one on each, or not set when a
// removal won
typedef struct {
	uint64_t lo;
	uint32_t device : 31, born : 1;
	uint32_t len;
	olink el;
	stamp st;
} reg;

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
static olink link_of(const el_id *i) {
	uint64_t x = i->born ? i->k : i->c;
	return (olink){i->device, i->born, 1, (uint32_t)x, (uint32_t)(x >> 32)};
}
static olink link_plus(olink g, uint64_t n) {
	uint64_t x = ((uint64_t)g.hi << 32 | g.lo) + n;
	g.lo = (uint32_t)x, g.hi = (uint32_t)(x >> 32);
	return g;
}
static int link_is(olink a, olink b) {
	return a.set == b.set && (!a.set || (a.device == b.device && a.born == b.born && a.lo == b.lo && a.hi == b.hi));
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
	struct {
		uint32_t device;
		uint64_t n;
	} by; // the step that made the container: its born ones are since
	int text; // a string
	size_t count, j, live;
	reg *regs; // the registers of the array's items, sorted by their origins, none overlapping
	size_t nreg, roomreg;
	orgent *orgs; // the origins of the elements moves made, sorted by their ids
	size_t norg, roomorg;
};


static void list_free(const tp_mem *mem, el_list *l) {
	tp_free(mem, l->regs, l->roomreg * sizeof *l->regs);
	tp_free(mem, l->orgs, l->roomorg * sizeof *l->orgs);
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
static el_id link_id(const el_list *l, olink g) {
	uint64_t x = (uint64_t)g.hi << 32 | g.lo;
	return g.born ? (el_id){g.device, 1, l->by.n, x} : (el_id){g.device, 0, x, 0};
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
// after (or before) the one before
static void join(el_list *l, size_t j) {
	if (j == 0 || j >= l->n) return;
	run a = l->runs[j - 1], b = l->runs[j];
	if (a.device != b.device || a.born != b.born || a.gone != b.gone || (uint64_t)a.len + b.len > MOST) return;
	el_id last = id_at(l, &a, a.len - 1), first = id_at(l, &b, 0);
	int on = (a.len == 1 || !a.back) && (b.len == 1 || !b.back) && a.c + a.len == b.c &&
		org_is(b.left, org_of(&last)) && org_is(a.right, b.right);
	int down = !on && !a.born && (a.len == 1 || a.back) && (b.len == 1 || b.back) &&
		a.c >= a.len && a.c - a.len == b.c && org_is(a.right, org_of(&first)) && org_is(a.left, b.left);
	if (!on && !down) return;
	a.len += b.len, a.back = (uint32_t)!!down;
	if (down) a.right = b.right;
	edit(l, j - 1, 2, &a, 1);
}
// run r's elements [o, o + n)
static run part(const el_list *l, const run *r, uint64_t o, uint64_t n) {
	run p = *r;
	p.len = (uint32_t)n;
	if (r->back) {
		p.c = r->c - o;
		el_id x = id_at(l, r, o + n);
		if (o + n < r->len) p.right = org_of(&x);
	} else {
		p.c = r->c + o;
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


static int is_seq(const op_value *v) { return v && (v->type == OP_LIST || v->type == OP_STR); }
static int is_map(const op_value *v) { return v && v->type == OP_MAP; }
// a node: a map, an array or a string
static int is_container(const op_value *v) { return v && (v->type == OP_MAP || v->type == OP_LIST || v->type == OP_STR); }
// a sequence's length, or -1: counted once, when its elements are made, and for what a splice inserts
static long units(const op_value *v) {
	if (!v) return -1;
	if (v->type == OP_LIST) return (long)v->count;
	if (v->type != OP_STR) return -1;
	long n = 0;
	for (size_t i = 0; i < v->bytes; i++) n += (((unsigned char)v->str[i]) & 0xc0) != 0x80;
	return n;
}

// what is at the first len keys of the target's path, NULL if nothing
static const op_value *at_keys(const op_value *v, const op_key *path, size_t len) {
	for (size_t i = 0; i < len; i++) {
		const op_key *k = &path[i];
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

// a path found by id, as op keys and their strings, that lives on until the step is done
typedef struct {
	void *p;
	size_t size, nkeys, chars;
} block;

typedef struct {
	const el_ctx *c;
	el_state *st;
	el_back *back;
	el_ref ref;
	int late;
	// the patch of the step in hand: its index; the block its path is in; the cell whose held value
	// its patches are for (its buffer), NULL: the graph's
	uint64_t i;
	long last;
	const uint8_t *host;
	block *blocks;
	size_t nblocks, roomblocks;
	// the values made for the patches (lists of items brought back)
	op_value **made;
	size_t nmade, roommade;
} work;

static int devcmp(const el_ctx *c, uint32_t x, uint32_t y) {
	if (x == y) return 0;
	if (x == EL_NONE) return -1;
	if (y == EL_NONE) return 1;
	return memcmp(c->bytes(c->self, x), c->bytes(c->self, y), 32);
}

// the element at runs[j], place o, sorts after one of this step's at seq c: by device, seq
// (a born one before what its step inserts)
static int sorts_after(const work *w, const el_list *l, size_t j, uint64_t o, uint64_t c) {
	const run *r = &l->runs[j];
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
// the next piece from far on, to the right's at most, looked up
static int more_seen(seen *s, const el_list *l, pos *far, const pos *rp) {
	uint64_t n = (rp && rp->j == far->j ? rp->o : l->runs[far->j].len) - far->o;
	if (see(s, l, far->j, far->o, n)) return TP_NOMEM;
	*far = far->o + n < l->runs[far->j].len ? (pos){far->j, far->o + n} : (pos){far->j + 1, 0};
	return 0;
}

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
			if ((code = more_seen(&s, l, &far, rp))) goto done;
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
					if ((code = more_seen(&s, l, &far, rp))) goto done;
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


// room for one more in a growing array of size each
static int more(const tp_mem *mem, void **p, size_t n, size_t *room, size_t each) {
	if (n < *room) return 0;
	size_t r = *room ? 2 * *room : 4;
	void *q = tp_grow(mem, *p, *room * each, r * each);
	if (!q) return -1;
	*p = q, *room = r;
	return 0;
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


// room for k runs more in the list, and 4 for the cuts around
static int grow_n(const tp_mem *mem, el_list *l, size_t k) {
	if (l->n + k + 4 <= l->room) return 0;
	size_t room = l->room ? l->room : 4;
	while (room < l->n + k + 4) room *= 2;
	run *r = tp_grow(mem, l->runs, l->room * sizeof *r, room * sizeof *r);
	if (!r) return -1;
	l->runs = r, l->room = room;
	return 0;
}

// an item's origin: the element it was inserted as. the elements a move made link to it
static size_t orgs_below(const el_list *l, uint32_t device, uint64_t c) {
	size_t a = 0, b = l->norg;
	while (a < b) {
		size_t m = (a + b) / 2;
		const orgent *e = &l->orgs[m];
		if (e->device != device ? e->device < device : e->c <= c) a = m + 1;
		else b = m;
	}
	return a;
}
static el_id origin_of(const el_list *l, el_id e) {
	if (e.born || !l->norg) return e;
	size_t b = orgs_below(l, e.device, e.c);
	if (!b) return e;
	const orgent *g = &l->orgs[b - 1];
	if (g->device != e.device || e.c - g->c >= g->len) return e;
	return plus(link_id(l, g->org), e.c - g->c);
}
static el_id origin_at(const el_list *l, size_t j, uint64_t o) { return origin_of(l, id_at(l, &l->runs[j], o)); }

// the registers (WIRE.md, list moves): per origin the event with the greatest stamp
static int stamp_later(const el_ctx *c, const stamp *a, const stamp *b) {
	if (a->lamport != b->lamport) return a->lamport > b->lamport;
	int d = devcmp(c, a->device, b->device);
	if (d) return d > 0;
	return a->n != b->n ? a->n > b->n : a->i > b->i;
}
static int stamp_is(const stamp *a, const stamp *b) {
	return a->lamport == b->lamport && a->n == b->n && a->device == b->device && a->i == b->i;
}
// how many registers sort at or before (device, born, x)
static size_t reg_below(const el_list *l, uint32_t device, uint32_t born, uint64_t x) {
	size_t a = 0, b = l->nreg;
	while (a < b) {
		size_t m = (a + b) / 2;
		const reg *e = &l->regs[m];
		int le = e->device != device ? e->device < device : e->born != born ? e->born < born : e->lo <= x;
		if (le) a = m + 1;
		else b = m;
	}
	return a;
}
// the run and place of the element that shows the item with origin *org: 1, or 0 when it is gone or
// not known
static int shown(el_list *l, const el_id *org, size_t *j, uint64_t *o) {
	uint64_t x = org->born ? org->k : org->c;
	size_t b = reg_below(l, org->device, org->born, x);
	el_id id = *org;
	if (b) {
		const reg *e = &l->regs[b - 1];
		if (e->device == org->device && e->born == org->born && x < e->lo + e->len) {
			if (!e->el.set) return 0;
			id = plus(link_id(l, e->el), x - e->lo);
		}
	}
	return find(l, &id, j, o) && !l->runs[*j].gone;
}
// registers [at, at + del) put in place by ins, and undone
static int reg_edit(work *w, el_list *l, size_t at, size_t del, const reg *ins, size_t nins) {
	const tp_mem *mem = w->c->mem;
	if (rec_room(w)) return TP_NOMEM;
	if (l->nreg - del + nins > l->roomreg) {
		size_t room = l->roomreg ? 2 * l->roomreg : 4;
		while (room < l->nreg - del + nins) room *= 2;
		reg *p = tp_grow(mem, l->regs, l->roomreg * sizeof *p, room * sizeof *p);
		if (!p) return TP_NOMEM;
		l->regs = p, l->roomreg = room;
	}
	reg *old = del ? tp_alloc(mem, del * sizeof *old) : NULL;
	if (del && !old) return TP_NOMEM;
	if (del) memcpy(old, l->regs + at, del * sizeof *old);
	memmove(l->regs + at + nins, l->regs + at + del, (l->nreg - at - del) * sizeof *l->regs);
	if (nins) memcpy(l->regs + at, ins, nins * sizeof *ins);
	l->nreg = l->nreg - del + nins;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = REG};
	r->reg.list = l, r->reg.at = at, r->reg.nins = nins, r->reg.nold = del, r->reg.old = old;
	return 0;
}
// registers i - 1 and i as one, when one goes on from the other with the same stamp
static int reg_join(work *w, el_list *l, size_t i, int *joined) {
	*joined = 0;
	if (i == 0 || i >= l->nreg) return 0;
	reg a = l->regs[i - 1], b = l->regs[i];
	if (a.device != b.device || a.born != b.born || a.lo + a.len != b.lo || !stamp_is(&a.st, &b.st) ||
		(uint64_t)a.len + b.len > UINT32_MAX || a.el.set != b.el.set ||
		(a.el.set && !link_is(link_plus(a.el, a.len), b.el)))
		return 0;
	a.len += b.len;
	*joined = 1;
	return reg_edit(w, l, i - 1, 2, &a, 1);
}

// ranges of elements, to hide or show
typedef struct {
	el_gone *p;
	size_t n, room;
} rlist;
static int rl_push(const tp_mem *mem, rlist *r, el_id id, uint64_t n) {
	if (more(mem, (void **)&r->p, r->n, &r->room, sizeof *r->p)) return TP_NOMEM;
	r->p[r->n++] = (el_gone){id, n};
	return 0;
}
// an event at stamp *st for the items with origins org on, len of them: a move (el: the elements it
// made for them) or a removal (NULL). each register it is after is taken by it; the elements that
// stop showing and start showing are added to hide and show
static int event(work *w, el_list *l, el_id org, uint64_t len, const stamp *st, const el_id *el, rlist *hide, rlist *show) {
	const tp_mem *mem = w->c->mem;
	uint64_t lo = org.born ? org.k : org.c;
	int code;
	for (uint64_t x = 0; x < len;) {
		uint64_t v = lo + x;
		size_t i = reg_below(l, org.device, org.born, v);
		reg e = i ? l->regs[i - 1] : (reg){0};
		if (i && e.device == org.device && e.born == org.born && v < e.lo + e.len) {
			uint64_t m = len - x < e.lo + e.len - v ? len - x : e.lo + e.len - v;
			if (stamp_later(w->c, st, &e.st)) {
				reg ps[3];
				size_t np = 0;
				if (v > e.lo) ps[np] = e, ps[np++].len = (uint32_t)(v - e.lo);
				ps[np++] = (reg){.lo = v, .device = org.device, .born = org.born, .len = (uint32_t)m,
					.el = el ? link_plus(link_of(el), x) : (olink){0}, .st = *st};
				uint64_t rest = e.lo + e.len - v - m;
				if (rest) {
					reg t = e;
					t.lo = v + m, t.len = (uint32_t)rest;
					if (e.el.set) t.el = link_plus(e.el, v + m - e.lo);
					ps[np++] = t;
				}
				if ((code = reg_edit(w, l, i - 1, 1, ps, np))) return code;
				if (e.el.set && (code = rl_push(mem, hide, link_id(l, link_plus(e.el, v - e.lo)), m))) return code;
				if (el && (code = rl_push(mem, show, plus(*el, x), m))) return code;
			}
			x += m;
		} else {
			uint64_t m = len - x;
			if (i < l->nreg && l->regs[i].device == org.device && l->regs[i].born == org.born &&
				l->regs[i].lo - v < m)
				m = l->regs[i].lo - v;
			reg g = {.lo = v, .device = org.device, .born = org.born, .len = (uint32_t)m,
				.el = el ? link_plus(link_of(el), x) : (olink){0}, .st = *st};
			if ((code = reg_edit(w, l, i, 0, &g, 1))) return code;
			if ((code = rl_push(mem, hide, plus(org, x), m))) return code;
			if (el && (code = rl_push(mem, show, plus(*el, x), m))) return code;
			x += m;
		}
	}
	size_t i = reg_below(l, org.device, org.born, lo);
	i = i > 1 ? i - 1 : 1;
	while (i < l->nreg && (l->regs[i - 1].device != org.device || l->regs[i - 1].lo <= lo + len)) {
		int joined;
		if ((code = reg_join(w, l, i, &joined))) return code;
		if (!joined) i++;
	}
	return 0;
}

static el_list *list_at(const el_state *st, tp_span node) {
	for (size_t i = 0; i < st->n; i++) {
		el_list *l = st->lists[i];
		if (l->keyn == node.n && !memcmp(l->key, node.p, node.n)) return l;
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
static int slots_room(const tp_mem *mem, el_state *st) {
	if (st->nslots < st->roomslots) return 0;
	size_t room = st->roomslots ? st->roomslots + st->roomslots / 2 + 1 : 4;
	el_slot *p = tp_grow(mem, st->slots, st->roomslots * sizeof *p, room * sizeof *p);
	if (!p) return -1;
	st->slots = p, st->roomslots = room;
	return 0;
}

static uint8_t *dup(const tp_mem *mem, const uint8_t *p, size_t n) {
	if (!n) return NULL;
	uint8_t *q = tp_alloc(mem, n);
	if (q) memcpy(q, p, n);
	return q;
}
static size_t sl_idn(const el_slot *s) { return s->idn & EL_CELL_LEN; }
static int sl_ghost(const el_slot *s) { return !!(s->idn & EL_CELL_GHOST); }
static int sl_holds(const el_slot *s) { return !!(s->idn & EL_CELL_NODE); }
static int sl_trash(const el_slot *s) { return !!(s->idn & EL_CELL_TRASH); }
// not visible: a ghost or trash
static int sl_hidden(const el_slot *s) { return !!(s->idn & (EL_CELL_GHOST | EL_CELL_TRASH)); }
static void slot_free(const tp_mem *mem, el_slot *s) {
	tp_free(mem, s->buf, (size_t)s->parentn + s->slotn + sl_idn(s));
	if (s->value) op_free(s->value);
}
static const uint8_t *sl_parent(const el_slot *s) { return s->buf; }
static const uint8_t *sl_slot(const el_slot *s) { return s->buf + s->parentn; }
static const uint8_t *sl_id(const el_slot *s) { return s->buf + s->parentn + s->slotn; }
static tp_span sl_idspan(const el_slot *s) { return (tp_span){sl_id(s), sl_idn(s)}; }
// the container a cell holds: its id; none (n 0) for a scalar
static tp_span sl_nodespan(const el_slot *s) { return sl_holds(s) ? sl_idspan(s) : (tp_span){NULL, 0}; }
static el_ref sl_at(const el_slot *s) { return (el_ref){s->lamport, 0, 0, s->device}; }
// the element a slot is, if it is one: [device, born, c, k]
static int sl_el(const el_slot *s, el_id *e) {
	if (!s->slotn || *sl_slot(s) >> 5 != 4) return 0;
	tp_in in = {sl_slot(s), sl_slot(s) + s->slotn};
	uint64_t k, d, b;
	if (tp_array(&in, &k) || tp_whole(&in, &d) || tp_whole(&in, &b) || tp_whole(&in, &e->c) || tp_whole(&in, &e->k)) return 0;
	e->device = (uint32_t)d, e->born = (uint32_t)b;
	return 1;
}
// the step and patch a cell's id begins with
static void sl_head(const el_slot *s, uint64_t *n, uint64_t *i) {
	tp_in in = {sl_id(s), sl_id(s) + sl_idn(s)};
	uint64_t d;
	*n = *i = 0;
	if (tp_whole(&in, &d) || tp_whole(&in, n) || tp_whole(&in, i)) *n = *i = 0;
}
// a cell shows over another: by its step's place (lamport, device, n), then its patch
static int cell_greater(const el_ctx *c, const el_slot *a, const el_slot *b) {
	if (a->lamport != b->lamport) return a->lamport > b->lamport;
	int d = devcmp(c, a->device, b->device);
	if (d) return d > 0;
	uint64_t an, ai, bn, bi;
	sl_head(a, &an, &ai), sl_head(b, &bn, &bi);
	return an != bn ? an > bn : ai > bi;
}

// a node: the device's index, n, the patch, then the place in the patch's value (rel items)
static void node_make(tp_buf *b, uint32_t device, uint64_t n, uint64_t i) {
	tp_put_head(b, 0, device), tp_put_head(b, 0, n), tp_put_head(b, 0, i);
}
// a key text as the wire has it: the op layer holds a NUL as the two bytes c0 80
static void rel_text(tp_buf *b, const char *s) {
	size_t n = strlen(s), m = 0;
	for (size_t i = 0; i < n; i++, m++) {
		if ((unsigned char)s[i] == 0xc0 && (unsigned char)s[i + 1] == 0x80) i++;
	}
	tp_put_head(b, 3, m);
	for (size_t i = 0; i < n; i++) {
		if ((unsigned char)s[i] == 0xc0 && (unsigned char)s[i + 1] == 0x80) tp_put(b, "", 1), i++;
		else tp_put(b, s + i, 1);
	}
}
static void rel_num(tp_buf *b, uint64_t x) { tp_put_head(b, 0, x); }
// the device and n a node was made by
static int node_head(tp_span node, uint32_t *device, uint64_t *n) {
	tp_in in = {node.p, node.p + node.n};
	uint64_t d;
	if (tp_whole(&in, &d) || tp_whole(&in, n)) return -1;
	*device = (uint32_t)d;
	return 0;
}
// a record's slot: a key of a map as cbor text, an element of an array as [device, born, c, k]
static void slot_key(tp_buf *b, const char *s) { rel_text(b, s); }
static void slot_el(tp_buf *b, const el_id *e) {
	tp_put_head(b, 4, 4), tp_put_head(b, 0, e->device), tp_put_head(b, 0, e->born);
	tp_put_head(b, 0, e->c), tp_put_head(b, 0, e->born ? e->k : 0);
}

static int slot_match(const el_slot *s, tp_span parent, tp_span slot) {
	return s->parentn == parent.n && s->slotn == slot.n && (!parent.n || !memcmp(sl_parent(s), parent.p, parent.n)) &&
		(!slot.n || !memcmp(sl_slot(s), slot.p, slot.n));
}
// the cell that shows at (parent, slot), or -1; *count: how many are visible there (ghosts are not)
static long shown_at(const el_ctx *c, const el_state *st, tp_span parent, tp_span slot, size_t *count) {
	long best = -1;
	size_t n = 0;
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		if (!slot_match(s, parent, slot) || sl_hidden(s)) continue;
		n++;
		if (best < 0 || cell_greater(c, s, &st->slots[best])) best = (long)i;
	}
	if (count) *count = n;
	return best;
}
// the cell that holds node (a container), or -1
static long cell_of(const el_state *st, tp_span node) {
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		if (sl_holds(s) && sl_idn(s) == node.n && node.n && !memcmp(sl_id(s), node.p, node.n)) return (long)i;
	}
	return -1;
}
static long cell_by(const el_state *st, const uint8_t *buf) {
	for (size_t i = 0; i < st->nslots; i++) {
		if (st->slots[i].buf == buf) return (long)i;
	}
	return -1;
}
// the cell at (parent, slot) whose id is id (a ghost too), or -1
static long cell_named(const el_state *st, tp_span parent, tp_span slot, tp_span id) {
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		if (slot_match(s, parent, slot) && sl_idn(s) == id.n && !memcmp(sl_id(s), id.p, id.n)) return (long)i;
	}
	return -1;
}
// the cell that holds node, or the longest id of one that is a prefix of it (a node made inside)
static long cell_enclosing(const el_state *st, tp_span node) {
	size_t ne = 0;
	tp_in in = {node.p, node.p + node.n};
	tp_span item;
	while (in.p < in.end && !tp_skip(&in, &item)) ne++;
	for (size_t m = ne; m >= 3; m--) {
		tp_in x = {node.p, node.p + node.n};
		for (size_t k = 0; k < m; k++) tp_skip(&x, &item);
		long i = cell_of(st, (tp_span){node.p, (size_t)(x.p - node.p)});
		if (i >= 0) return i;
	}
	return -1;
}
// has the step that made the node (a cell, a container) landed here
static int landed(const el_state *st, tp_span node) {
	uint32_t d;
	uint64_t n;
	if (node_head(node, &d, &n)) return 1;
	for (size_t i = 0; i < st->nlanded; i++) {
		if (st->landed[i].device == d) return st->landed[i].n >= n;
	}
	return 0;
}
// is the key under the node
static int under(const uint8_t *key, size_t keyn, tp_span node) {
	return keyn >= node.n && !memcmp(key, node.p, node.n);
}

// a cell added, owned by the state (the record knows it by its buffer), and undone
static int add_cell(work *w, el_slot cell) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	if (rec_room(w) || slots_room(mem, st)) return slot_free(mem, &cell), TP_NOMEM;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = ADD};
	r->slot.cell = cell;
	st->slots[st->nslots++] = cell;
	return 0;
}
// the cell i taken out of the state, the record owning it, and undone
static int take_cell(work *w, size_t i) {
	el_state *st = w->st;
	if (rec_room(w)) return TP_NOMEM;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = TAKE};
	r->slot.cell = st->slots[i];
	st->slots[i] = st->slots[--st->nslots];
	return 0;
}
// the value of the cell at buf set (v owned by the cell now); what it held is noted for undo. v
// is given up on a failure
static int hold(work *w, const uint8_t *buf, op_value *v) {
	el_state *st = w->st;
	long i = cell_by(st, buf);
	if (i < 0 || rec_room(w)) return op_free(v), TP_NOMEM;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = HOLD};
	r->hold.buf = buf, r->hold.was = st->slots[i].value;
	st->slots[i].value = v;
	return 0;
}
// the cell at buf, its container let go of: hidden, with v its value (owned by the cell now; given up
// on a failure), and undone
static int bin_cell(work *w, const uint8_t *buf, op_value *v) {
	el_state *st = w->st;
	long i = cell_by(st, buf);
	if (i < 0 || rec_room(w)) return op_free(v), TP_NOMEM;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = BIN};
	r->hold.buf = buf, r->hold.was = st->slots[i].value;
	st->slots[i].value = v;
	st->slots[i].idn |= EL_CELL_TRASH;
	return 0;
}
// a cell made: buf = parent, slot, id; id's flags
static int make_cell(work *w, tp_span parent, tp_span slot, tp_span id, unsigned flags, el_ref at, el_slot *out) {
	size_t total = parent.n + slot.n + id.n;
	el_slot s = {0};
	s.buf = tp_alloc(w->c->mem, total ? total : 1);
	if (!s.buf) return TP_NOMEM;
	if (parent.n) memcpy(s.buf, parent.p, parent.n);
	if (slot.n) memcpy(s.buf + parent.n, slot.p, slot.n);
	if (id.n) memcpy(s.buf + parent.n + slot.n, id.p, id.n);
	s.parentn = (uint32_t)parent.n, s.slotn = (uint32_t)slot.n, s.idn = (uint32_t)id.n | flags;
	s.lamport = at.lamport, s.device = at.device;
	*out = s;
	return 0;
}
// the device's newest step landed here, n; what it was is noted for undo
static int landed_set(work *w, uint32_t device, uint64_t n) {
	el_state *st = w->st;
	size_t i = 0;
	for (; i < st->nlanded && st->landed[i].device != device; i++) {}
	uint64_t was = i < st->nlanded ? st->landed[i].n : 0;
	if (was >= n) return 0;
	if (rec_room(w)) return TP_NOMEM;
	if (i == st->nlanded) {
		if (st->nlanded == st->roomlanded) {
			size_t room = st->roomlanded ? 2 * st->roomlanded : 4;
			void *p = tp_grow(w->c->mem, st->landed, st->roomlanded * sizeof *st->landed, room * sizeof *st->landed);
			if (!p) return TP_NOMEM;
			st->landed = p, st->roomlanded = room;
		}
		st->landed[st->nlanded++].device = device;
	}
	st->landed[i].n = n;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = LANDED};
	r->landed.device = device, r->landed.n = was;
	return 0;
}

// a cell in trash made: a container named before it landed, replaced, or at an element gone (id is
// its node)
static int bury_cell(work *w, tp_span parent, tp_span slot, tp_span id, const op_value *value, el_ref at) {
	if (w->st->quiet) return 0;
	el_slot s;
	int code = make_cell(w, parent, slot, id, EL_CELL_NODE | EL_CELL_TRASH, at, &s);
	if (code) return code;
	s.value = value ? op_ref((op_value *)value) : NULL;
	return add_cell(w, s);
}

// the container of an element gone, from the pieces of its list, taken from them (the record owns
// the piece's reference, the caller gets one); NULL: none
static op_value *bin_take(work *w, tp_span list, const el_id *e) {
	el_state *st = w->st;
	for (size_t i = 0; i < st->nbins; i++) {
		el_bin *b = st->bins[i];
		if (b->listn != list.n || memcmp(b->list, list.p, list.n) || b->id.device != e->device || b->id.born != e->born) continue;
		uint64_t x = UINT64_MAX;
		if (e->born ? e->c == b->id.c && e->k >= b->id.k : e->c >= b->id.c) x = e->born ? e->k - b->id.k : e->c - b->id.c;
		if (x >= b->n || !b->values[x] || rec_room(w)) continue;
		el_rec *r = &w->back->p[w->back->n++];
		*r = (el_rec){.kind = BINTAKE};
		r->bintake.bin = b, r->bintake.x = x, r->bintake.v = b->values[x];
		b->values[x] = NULL;
		return op_ref(r->bintake.v);
	}
	return NULL;
}
// the value of an element gone in the pieces of its list, left there; NULL: none
static const op_value *bin_peek(const el_state *st, tp_span list, const el_id *e) {
	for (size_t i = 0; i < st->nbins; i++) {
		const el_bin *b = st->bins[i];
		if (b->listn != list.n || memcmp(b->list, list.p, list.n) || b->id.device != e->device || b->id.born != e->born) continue;
		uint64_t x = UINT64_MAX;
		if (e->born ? e->c == b->id.c && e->k >= b->id.k : e->c >= b->id.c) x = e->born ? e->k - b->id.k : e->c - b->id.c;
		if (x < b->n) return b->values[x];
	}
	return NULL;
}
static void bin_free(const tp_mem *mem, el_bin *b) {
	for (uint64_t x = 0; x < b->n; x++) {
		if (b->values[x]) op_free(b->values[x]);
	}
	tp_free(mem, b->values, b->n * sizeof *b->values);
	tp_free(mem, b->list, b->listn);
	tp_free(mem, b, sizeof *b);
}

// bytes of a value in memory, each allocation rounded up to 16 as malloc does
static size_t blk(size_t n) { return n ? (n + 15) & ~(size_t)15 : 0; }
static size_t weigh(const op_value *v) {
	if (!v) return 0;
	size_t n = blk(sizeof *v);
	if (v->type == OP_STR || v->type == OP_BYTES || v->type == OP_TYPED) n += blk(v->bytes + 1);
	else if (v->type == OP_LIST) {
		n += blk(v->capacity * sizeof *v->items);
		for (size_t i = 0; i < v->count; i++) n += weigh(v->items[i]);
	} else if (v->type == OP_MAP) {
		n += blk(v->capacity * sizeof *v->items) + blk(v->capacity * sizeof *v->keys) + blk(v->slots * sizeof *v->index);
		for (size_t i = 0; i < v->count; i++) n += blk(strlen(v->keys[i]) + 1) + weigh(v->items[i]);
	}
	return n;
}

// a node gone for good, with its sequences and cells, and what they hold, in turn
static int drop_node(work *w, tp_span node) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	size_t nl = st->n, ns = st->nslots, ngl = 0, ngs = 0, nt = 0, rt = 0;
	uint8_t *ml = NULL, *ms = NULL;
	tp_span *todo = NULL;
	el_list **dl = NULL;
	el_slot *ds = NULL;
	int code = 0;
	if (!nl && !ns) return 0;
	if (rec_room(w)) return TP_NOMEM;
	ml = tp_alloc(mem, nl ? nl : 1), ms = tp_alloc(mem, ns ? ns : 1);
	if (!ml || !ms) {
		code = TP_NOMEM;
		goto done;
	}
	memset(ml, 0, nl), memset(ms, 0, ns);
	if (more(mem, (void **)&todo, nt, &rt, sizeof *todo)) {
		code = TP_NOMEM;
		goto done;
	}
	todo[nt++] = node;
	while (nt) {
		tp_span x = todo[--nt];
		for (size_t i = 0; i < nl; i++) {
			if (!ml[i] && under(st->lists[i]->key, st->lists[i]->keyn, x)) ml[i] = 1;
		}
		for (size_t i = 0; i < ns; i++) {
			if (ms[i] || !under(sl_parent(&st->slots[i]), st->slots[i].parentn, x)) continue;
			ms[i] = 1;
			if (!sl_holds(&st->slots[i])) continue;
			if (more(mem, (void **)&todo, nt, &rt, sizeof *todo)) {
				code = TP_NOMEM;
				goto done;
			}
			todo[nt++] = sl_nodespan(&st->slots[i]);
		}
	}
	for (size_t i = 0; i < nl; i++) ngl += ml[i];
	for (size_t i = 0; i < ns; i++) ngs += ms[i];
	if (!ngl && !ngs) goto done;
	dl = ngl ? tp_alloc(mem, ngl * sizeof *dl) : NULL;
	ds = ngs ? tp_alloc(mem, ngs * sizeof *ds) : NULL;
	if ((ngl && !dl) || (ngs && !ds)) {
		code = TP_NOMEM;
		goto done;
	}
	size_t a = 0, b = 0;
	for (size_t i = 0; i < nl; i++) {
		if (ml[i]) dl[a++] = st->lists[i];
		else st->lists[i - a] = st->lists[i];
	}
	st->n -= a;
	for (size_t i = 0; i < ns; i++) {
		if (ms[i]) ds[b++] = st->slots[i];
		else st->slots[i - b] = st->slots[i];
	}
	st->nslots -= b;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = DROP};
	r->drop.lists = dl, r->drop.nlists = ngl, r->drop.slots = ds, r->drop.nslots = ngs;
	dl = NULL, ds = NULL;
done:
	tp_free(mem, ml, nl ? nl : 1), tp_free(mem, ms, ns ? ns : 1);
	tp_free(mem, todo, rt * sizeof *todo);
	tp_free(mem, dl, ngl * sizeof *dl), tp_free(mem, ds, ngs * sizeof *ds);
	return code;
}

// the sequence node's elements, made now: those there since the step that made it
static int elements(work *w, tp_span node, const op_value *v, el_list **out) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	if ((*out = list_at(st, node))) return 0;
	if (!is_seq(v)) return OP_WRONG_KIND;
	uint32_t dev;
	uint64_t n;
	if (node_head(node, &dev, &n)) return OP_RANGE;
	size_t count = (size_t)units(v), runs = (count + MOST - 1) / MOST;
	el_list *l = tp_alloc(mem, sizeof *l);
	if (!l) return TP_NOMEM;
	memset(l, 0, sizeof *l);
	l->mem = mem;
	l->key = tp_alloc(mem, node.n), l->keyn = node.n;
	l->room = runs + 4, l->runs = tp_alloc(mem, l->room * sizeof *l->runs);
	if (!l->key || !l->runs || rec_room(w) || lists_room(mem, st)) {
		if (!l->runs) l->room = 0;
		list_free(mem, l);
		return TP_NOMEM;
	}
	memcpy(l->key, node.p, node.n);
	for (size_t k = 0; k < count; k += MOST) {
		uint32_t len = (uint32_t)(count - k < MOST ? count - k : MOST);
		l->runs[l->n++] = (run){.c = k, .device = dev, .len = len, .born = 1, .left = {.none = 1}, .right = {.none = 1}};
	}
	l->by.device = dev, l->by.n = n, l->count = count, l->text = v->type == OP_STR;
	st->lists[st->n++] = l;
	w->back->p[w->back->n++] = (el_rec){.kind = MADE, .splice = {.list = l}};
	*out = l;
	return 0;
}

// the containers among the items one run of a splice takes away: their elements from id on
typedef struct {
	el_id id;
	uint64_t n;
	op_value **values;
} piece;
static void pieces_free(const tp_mem *mem, piece *ps, size_t n, size_t room) {
	for (size_t i = 0; i < n; i++) {
		for (uint64_t x = 0; ps[i].values && x < ps[i].n; x++) {
			if (ps[i].values[x]) op_free(ps[i].values[x]);
		}
		tp_free(mem, ps[i].values, ps[i].n * sizeof *ps[i].values);
	}
	tp_free(mem, ps, room * sizeof *ps);
}
static int piece_has(const piece *ps, size_t n, const el_id *e) {
	for (size_t i = 0; i < n; i++) {
		if (ps[i].id.device != e->device || ps[i].id.born != e->born) continue;
		uint64_t x = UINT64_MAX;
		if (e->born ? e->c == ps[i].id.c && e->k >= ps[i].id.k : e->c >= ps[i].id.c) {
			x = e->born ? e->k - ps[i].id.k : e->c - ps[i].id.c;
		}
		if (x < ps[i].n && ps[i].values[x]) return 1;
	}
	return 0;
}

// the items of the array node a splice or move left gone, by origin (lost): the values of those
// with no cell are held as pieces (they become the state's, pieces[].values NULL), for a move to
// bring back. quiet: let go with what is under them
static int away(work *w, tp_span node, el_list *l, const el_gone *lost, size_t nlost, piece *pieces, size_t npieces) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	for (size_t i = 0; st->quiet && i < st->nslots;) {
		el_slot *s = &st->slots[i];
		size_t j;
		uint64_t o;
		el_id e;
		if (s->parentn != node.n || memcmp(sl_parent(s), node.p, node.n) || sl_trash(s) || !sl_el(s, &e) ||
			!find(l, &e, &j, &o) || shown(l, &e, &j, &o)) {
			i++;
			continue;
		}
		int code;
		if (sl_holds(s)) {
			// the cell goes after: dropping packs the cells
			tp_span held = sl_nodespan(s);
			const uint8_t *buf = s->buf;
			if ((code = drop_node(w, held))) return code;
			long at = cell_by(st, buf);
			if (at >= 0 && (code = take_cell(w, (size_t)at))) return code;
			i = 0;
			continue;
		}
		if ((code = take_cell(w, i))) return code;
	}
	if (st->quiet) {
		// the items born with the array have no cell: what is under them goes by their place
		for (size_t r = 0; r < nlost; r++) {
			for (uint64_t x = 0; x < lost[r].count; x++) {
				el_id e = plus(lost[r].id, x);
				if (!e.born) continue;
				tp_buf cb = {NULL, 0, 0, (size_t)-1, mem, 0};
				tp_put(&cb, node.p, node.n), rel_num(&cb, e.k);
				int code = tp_buf_why(&cb) ? TP_NOMEM : drop_node(w, (tp_span){cb.p, cb.len});
				tp_buf_free(&cb);
				if (code) return code;
			}
		}
		return 0;
	}
	if (!npieces) return 0;
	if (rec_room(w)) return TP_NOMEM;
	size_t ri = w->back->n++;
	w->back->p[ri] = (el_rec){.kind = BINADD};
	for (size_t q = 0; q < npieces; q++) {
		el_bin *b = tp_alloc(mem, sizeof *b);
		if (!b) return TP_NOMEM;
		b->list = dup(mem, node.p, node.n), b->listn = node.n;
		if ((node.n && !b->list) || more(mem, (void **)&st->bins, st->nbins, &st->roombins, sizeof *st->bins)) {
			tp_free(mem, b->list, b->listn);
			tp_free(mem, b, sizeof *b);
			return TP_NOMEM;
		}
		b->id = pieces[q].id, b->n = pieces[q].n, b->values = pieces[q].values;
		pieces[q].values = NULL;
		st->bins[st->nbins++] = b;
		w->back->p[ri].binadd.count++;
	}
	return 0;
}

// what a patch's assignment leaves of the value at the slot: nothing to do, the patch's own, the key
// taken away, or the value a cell held put there
typedef enum { A_NONE, A_OWN, A_REMOVE, A_PUT } shape;

// a patch assigns at a slot (a key of the map parent, an element of the array parent, the root:
// parent empty): a put (cell: its id, container whether it makes one, cellvalue its value) or a
// removal (cell NULL). pred names the cells it replaces (all: every one visible, for a move); a name
// whose cell has not landed is held at the slot until it does. old is the value at the slot now,
// derived the container there if no cell says (made with its parent's value). The cells replaced
// go, with what is under them; the cell made is visible unless named already; the greatest visible
// shows. *out: what the value there is to be; *put: the value of a cell now showing, valid until
// the step's records are let go
static int assign(work *w, tp_span parent, tp_span slot, int is_el, tp_span derived, const op_value *old,
	const tp_span *pred, size_t npred, int all, const tp_span *cell, int container, const op_value *cellvalue,
	shape *out, const op_value **put) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	int code = 0;
	size_t nvis;
	const uint8_t **gone = NULL, *topbuf = NULL, *madebuf = NULL;
	size_t ngone = 0, nall = 0;
	*out = A_NONE, *put = NULL;
	shown_at(w->c, st, parent, slot, &nvis);
	// a key whose value its parent's put made, with no cell of its own, is a cell: held now
	if (!is_el && parent.n && old && !nvis) {
		long from = cell_enclosing(st, parent);
		if (from >= 0) {
			tp_buf id = {NULL, 0, 0, (size_t)-1, mem, 0};
			tp_put(&id, parent.p, parent.n), tp_put(&id, slot.p, slot.n);
			el_slot s;
			el_ref at = sl_at(&st->slots[from]);
			code = tp_buf_why(&id) ? TP_NOMEM
				: make_cell(w, parent, slot, (tp_span){id.p, id.len}, is_container(old) ? EL_CELL_NODE : 0, at, &s);
			tp_buf_free(&id);
			if (!code) code = add_cell(w, s);
			if (code) return code;
		}
	}
	for (size_t i = 0; i < st->nslots; i++) nall += slot_match(&st->slots[i], parent, slot);
	gone = nall + npred ? tp_alloc(mem, (nall + npred) * sizeof *gone) : NULL;
	if (nall + npred && !gone) return TP_NOMEM;
	long ti = shown_at(w->c, st, parent, slot, NULL);
	if (ti >= 0) topbuf = st->slots[ti].buf;
	if (all) {
		for (size_t i = 0; i < st->nslots; i++) {
			if (slot_match(&st->slots[i], parent, slot) && !sl_hidden(&st->slots[i])) gone[ngone++] = st->slots[i].buf;
		}
	} else {
		for (size_t k = 0; k < npred && !code; k++) {
			long r = cell_named(st, parent, slot, pred[k]);
			if (r >= 0 && !sl_hidden(&st->slots[r])) {
				size_t g = 0;
				while (g < ngone && gone[g] != st->slots[r].buf) g++;
				if (g == ngone) gone[ngone++] = st->slots[r].buf;
			} else if (r < 0 && !landed(st, pred[k])) {
				el_slot s;
				el_ref at = w->ref;
				code = make_cell(w, parent, slot, pred[k], EL_CELL_GHOST, at, &s);
				if (!code) code = add_cell(w, s);
			}
		}
	}
	el_slot made = {0};
	int has_made = 0;
	if (!code && cell) {
		long g = cell_named(st, parent, slot, *cell);
		if (g >= 0 && sl_ghost(&st->slots[g])) {
			code = take_cell(w, (size_t)g);
			if (!code && container) code = bury_cell(w, parent, slot, *cell, cellvalue, w->ref);
		} else code = make_cell(w, parent, slot, *cell, container ? EL_CELL_NODE : 0, w->ref, &made), has_made = !code;
	}
	if (!code && !nvis && derived.n && is_el && old && is_container(old) && cell_of(st, derived) < 0) {
		long from = cell_enclosing(st, parent);
		code = bury_cell(w, parent, slot, derived, old, from >= 0 ? sl_at(&st->slots[from]) : w->ref);
	}
	for (size_t g = 0; g < ngone && !code; g++) {
		long i = cell_by(st, gone[g]);
		if (i < 0) continue;
		const el_slot *s = &st->slots[i];
		const op_value *v = gone[g] == topbuf ? old : s->value;
		if (sl_holds(s) && !st->quiet) code = bin_cell(w, gone[g], v ? op_ref((op_value *)v) : NULL);
		else {
			if (sl_holds(s)) code = drop_node(w, sl_nodespan(s));
			i = cell_by(st, gone[g]);
			if (!code && i >= 0) code = take_cell(w, (size_t)i);
		}
	}
	tp_free(mem, gone, (nall + npred) * sizeof *gone);
	if (code) {
		if (has_made) slot_free(mem, &made);
		return code;
	}
	if (has_made) {
		madebuf = made.buf;
		if ((code = add_cell(w, made))) return code;
	}
	long si = shown_at(w->c, st, parent, slot, NULL);
	const uint8_t *showbuf = si >= 0 ? st->slots[si].buf : NULL;
	long tsi = topbuf ? cell_by(st, topbuf) : -1;
	int top_stays = tsi >= 0 && !sl_trash(&st->slots[tsi]);
	if (has_made && showbuf == madebuf) {
		if (top_stays && old && (code = hold(w, topbuf, op_ref((op_value *)old)))) return code;
		*out = A_OWN;
		return 0;
	}
	if (has_made && (code = hold(w, madebuf, cellvalue ? op_ref((op_value *)cellvalue) : NULL))) return code;
	if (!showbuf) *out = old ? A_REMOVE : A_NONE;
	else if (showbuf == topbuf) *out = A_NONE;
	else {
		si = cell_by(st, showbuf);
		*put = st->slots[si].value;
		if ((code = hold(w, showbuf, NULL))) return code;
		*out = *put ? A_PUT : A_REMOVE;
	}
	return 0;
}

// a path as hops, the first at the end: a key (its text) or a place
typedef struct {
	int num;
	long n;
	tp_span s;
} hop;
typedef struct {
	hop *p;
	size_t n, room;
} hops;

// the hops from held through the node's tail: its rel items. no hops (*ok 0) when a patch put over one
static int inside(work *w, tp_span held, tp_span tail, hops *out, int *ok) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	tp_in in = {tail.p, tail.p + tail.n};
	size_t start = out->n;
	// the key so far: held then the rel items taken
	size_t at = held.n;
	*ok = 1;
	while (in.p < in.end) {
		const uint8_t *from = in.p;
		int major = (int)(*in.p >> 5);
		tp_span key;
		uint64_t x;
		tp_buf slot = {NULL, 0, 0, (size_t)-1, mem, 0};
		hop h = {0};
		int code = 0;
		size_t seen = 0;
		tp_span ck = {held.p, at};
		if (major == 3) {
			if (tp_text(&in, &key)) return OP_RANGE;
			tp_put(&slot, from, (size_t)(in.p - from));
			shown_at(w->c, st, ck, (tp_span){slot.p, slot.len}, &seen);
			if (seen) *ok = 0;
			h.s = key;
		} else {
			if (tp_whole(&in, &x)) return OP_RANGE;
			uint32_t dev;
			uint64_t n;
			if (node_head(ck, &dev, &n)) return OP_RANGE;
			el_id e = {dev, 1, n, x};
			slot_el(&slot, &e);
			shown_at(w->c, st, ck, (tp_span){slot.p, slot.len}, &seen);
			if (seen) *ok = 0;
			el_list *l = list_at(st, ck);
			size_t j;
			uint64_t o;
			h.num = 1;
			if (l && *ok) {
				if (!shown(l, &e, &j, &o)) *ok = 0;
				else h.n = (long)(live_before(l, j) + (size_t)o);
			} else if (x > (uint64_t)LONG_MAX) *ok = 0;
			else h.n = (long)x;
		}
		code = tp_buf_why(&slot);
		tp_buf_free(&slot);
		if (code) return TP_NOMEM;
		if (!*ok) return 0;
		if (more(mem, (void **)&out->p, out->n, &out->room, sizeof *out->p)) return TP_NOMEM;
		out->p[out->n++] = h;
		at += (size_t)(in.p - from);
	}
	// the tail's hops were pushed first to last; the path is read last to first, so turn them
	for (size_t a = start, b = out->n; a + 1 < b; a++, b--) {
		hop t = out->p[a];
		out->p[a] = out->p[b - 1], out->p[b - 1] = t;
	}
	return 0;
}

// the bytes of the first m items of a node
static size_t item_end(tp_span node, size_t m) {
	tp_in in = {node.p, node.p + node.n};
	tp_span item;
	while (m--) tp_skip(&in, &item);
	return (size_t)(in.p - node.p);
}

// the path to the container node as it is now, root first, in hops (turned at the end); *ok 0: not
// held, replaced, or gone. *host: the buffer of the cell whose held value it is in, when that cell
// is not the one showing (the path is in that value), else NULL
static int revive(work *w, tp_span node);
static int where(work *w, tp_span node, hops *out, int *ok, const uint8_t **host) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	tp_span cur = node;
	*ok = 1;
	*host = NULL;
	{
		int code = revive(w, node);
		if (code) return code;
	}
	for (;;) {
		// the node some cell holds that cur is, or is made inside: longest first
		size_t ne = 0;
		tp_in in = {cur.p, cur.p + cur.n};
		while (in.p < in.end) {
			tp_span item;
			if (tp_skip(&in, &item)) return OP_RANGE;
			if (++ne > 1024) return OP_RANGE;
		}
		long si = -1;
		size_t m = ne, end = cur.n;
		for (; m >= 3; m--) {
			end = item_end(cur, m);
			si = cell_of(st, (tp_span){cur.p, end});
			if (si >= 0) break;
		}
		if (si < 0) return *ok = 0, 0;
		tp_span held = {cur.p, end}, tail = {cur.p + end, cur.n - end};
		const el_slot *rec = &st->slots[si];
		int good;
		int code = inside(w, held, tail, out, &good);
		if (code || !good) return code ? code : (*ok = 0, 0);
		// an item gone: its cell holds the value its patches are for
		el_id ee;
		int item_gone = 0;
		if (sl_el(rec, &ee) && !sl_trash(rec) && !sl_ghost(rec)) {
			el_list *ll = list_at(st, (tp_span){sl_parent(rec), rec->parentn});
			size_t jj;
			uint64_t oo;
			item_gone = ll && find(ll, &ee, &jj, &oo) && !shown(ll, &ee, &jj, &oo);
		}
		if (item_gone || shown_at(w->c, st, (tp_span){sl_parent(rec), rec->parentn}, (tp_span){sl_slot(rec), rec->slotn}, NULL) != si) {
			*host = rec->buf;
			break;
		}
		if (!rec->parentn) break;
		hop h = {0};
		el_id e;
		if (sl_el(rec, &e)) {
			el_list *l = list_at(st, (tp_span){sl_parent(rec), rec->parentn});
			size_t j;
			uint64_t o;
			if (!l || !shown(l, &e, &j, &o)) return *ok = 0, 0;
			h.num = 1, h.n = (long)(live_before(l, j) + (size_t)o);
		} else {
			tp_in s = {sl_slot(rec), sl_slot(rec) + rec->slotn};
			if (tp_text(&s, &h.s)) return OP_RANGE;
		}
		if (more(mem, (void **)&out->p, out->n, &out->room, sizeof *out->p)) return TP_NOMEM;
		out->p[out->n++] = h;
		cur = (tp_span){sl_parent(rec), rec->parentn};
	}
	// hops so far: innermost first; the path is root first
	for (size_t a = 0, b = out->n; a + 1 < b; a++, b--) {
		hop t = out->p[a];
		out->p[a] = out->p[b - 1], out->p[b - 1] = t;
	}
	return 0;
}

// the cell of a container in the item an element gone had, made when a patch names it: by its
// derived id (born with the array)
static int revive(work *w, tp_span node) {
	el_state *st = w->st;
	size_t ne = 0, end = node.n, m;
	tp_in in = {node.p, node.p + node.n};
	tp_span item;
	long si = -1;
	while (in.p < in.end) {
		if (tp_skip(&in, &item) || ++ne > 1024) return OP_RANGE;
	}
	for (m = ne; m >= 3; m--) {
		end = item_end(node, m);
		si = cell_of(st, (tp_span){node.p, end});
		if (si >= 0) break;
	}
	if (si < 0 || !st->nbins) return 0;
	tp_in t = {node.p + end, node.p + node.n};
	while (t.p < t.end) {
		const uint8_t *from = t.p;
		int major = *t.p >> 5;
		if (tp_skip(&t, &item)) return OP_RANGE;
		tp_span ck = {node.p, end}, next = {node.p, (size_t)(t.p - node.p)};
		el_list *l = major == 0 ? list_at(st, ck) : NULL;
		if (l && cell_of(st, next) < 0) {
			uint32_t dev;
			uint64_t n, x;
			tp_in xi = {from, t.p};
			if (tp_whole(&xi, &x) || node_head(ck, &dev, &n)) return OP_RANGE;
			el_id e = {dev, 1, n, x};
			size_t j;
			uint64_t o;
			if (find(l, &e, &j, &o) && !shown(l, &e, &j, &o)) {
				op_value *v = bin_take(w, ck, &e);
				if (v) {
					tp_buf sb = {NULL, 0, 0, (size_t)-1, w->c->mem, 0};
					slot_el(&sb, &e);
					long fr = cell_enclosing(st, ck);
					el_slot cellv;
					int code = tp_buf_why(&sb) ? TP_NOMEM
						: make_cell(w, ck, (tp_span){sb.p, sb.len}, next, EL_CELL_NODE, fr >= 0 ? sl_at(&st->slots[fr]) : w->ref, &cellv);
					tp_buf_free(&sb);
					if (!code) cellv.value = v, code = add_cell(w, cellv);
					else op_free(v);
					if (code) return code;
				}
			}
		}
		end = next.n;
	}
	return 0;
}

// what a list move names, from where the writer has the array: the gap's element, and the items'
// elements in order, as runs of ids (the items of a run that goes back, one by one)
static int moved_from(el_list *l, const op_patch *p, el_anchor *out) {
	const tp_mem *mem = l->mem;
	const op_target *F = &p->move;
	uint64_t a = F->has_range ? (uint64_t)F->from : (uint64_t)F->path[F->length - 1].n;
	uint64_t b = F->has_range ? (uint64_t)F->to : a + 1, g = (uint64_t)p->place.from, n = b - a, o;
	size_t j, room = 0;
	if (b > l->count || g > l->count - n) return OP_RANGE;
	out->gone = NULL, out->ngone = 0;
	for (uint64_t x = a; x < b;) {
		j = live_at(l, (size_t)x, &o);
		const run *r = &l->runs[j];
		uint64_t k = r->back ? 1 : (r->len - o < b - x ? r->len - o : b - x);
		el_id id = id_at(l, r, o), next = out->ngone ? plus(out->gone[out->ngone - 1].id, out->gone[out->ngone - 1].count) : id;
		if (out->ngone && same(&next, &id)) out->gone[out->ngone - 1].count += k;
		else if (more(mem, (void **)&out->gone, out->ngone, &room, sizeof *out->gone)) {
			tp_free(mem, out->gone, room * sizeof *out->gone);
			return out->gone = NULL, out->ngone = 0, TP_NOMEM;
		} else out->gone[out->ngone++] = (el_gone){id, k};
		x += k;
	}
	if (room != out->ngone) {
		el_gone *t = tp_grow(mem, out->gone, room * sizeof *t, out->ngone * sizeof *t);
		if (!t) return tp_free(mem, out->gone, room * sizeof *out->gone), out->gone = NULL, out->ngone = 0, TP_NOMEM;
		out->gone = t;
	}
	if (g) {
		j = live_at(l, (size_t)(g - 1 < a ? g - 1 : g - 1 + n), &o);
		out->after = id_at(l, &l->runs[j], o), out->has_after = 1;
	}
	pos lp = {0, 0}, spot = {0, 0};
	if (out->has_after) find(l, &out->after, &lp.j, &lp.o), spot = next_pos(l, lp);
	if (spot.j < l->n) {
		el_id right = id_at(l, &l->runs[spot.j], spot.o);
		el_id after_right = out->has_after ? right_of(l, &l->runs[lp.j], lp.o) : NOWHERE;
		out->has_before = 1, out->before = right, out->same = out->has_after && same(&after_right, &right);
	}
	return 0;
}

// the items named, by origin: len of them from org on, and what each holds while it shows (the
// reference is the segment's)
typedef struct {
	el_id org;
	uint64_t len;
	op_value **vals;
} seg;
static void segs_free(const tp_mem *mem, seg *sg, size_t n, size_t room) {
	for (size_t i = 0; i < n; i++) {
		for (uint64_t x = 0; sg[i].vals && x < sg[i].len; x++) {
			if (sg[i].vals[x]) op_free(sg[i].vals[x]);
		}
		tp_free(mem, sg[i].vals, sg[i].len * sizeof *sg[i].vals);
	}
	tp_free(mem, sg, room * sizeof *sg);
}

// the origin of elements a move made, put in order, and undone
static int org_put(work *w, el_list *l, orgent g) {
	const tp_mem *mem = w->c->mem;
	if (rec_room(w)) return TP_NOMEM;
	if (l->norg == l->roomorg) {
		size_t room = l->roomorg ? 2 * l->roomorg : 4;
		orgent *p = tp_grow(mem, l->orgs, l->roomorg * sizeof *p, room * sizeof *p);
		if (!p) return TP_NOMEM;
		l->orgs = p, l->roomorg = room;
	}
	size_t at = orgs_below(l, g.device, g.c);
	memmove(l->orgs + at + 1, l->orgs + at, (l->norg - at) * sizeof *l->orgs);
	l->orgs[at] = g, l->norg++;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = ORG};
	r->org.list = l, r->org.at = at;
	return 0;
}

// a splice or list move in hand: the patches it makes, and its record
typedef struct {
	work *w;
	el_list *l;
	const op_patch *p;
	tp_span node;
	size_t ri;
	op_patch *out;
	size_t nout, qroom;
} spl;
#define REC(s) ((s)->w->back->p[(s)->ri].splice)

// the elements from id on, n of them, taken away, by position
static int spl_hide(spl *s, el_id id, uint64_t n) {
	el_list *l = s->l;
	const tp_mem *mem = s->w->c->mem;
	for (uint64_t x = 0; x < n;) {
		el_id at = plus(id, x);
		size_t j;
		uint64_t o;
		find(l, &at, &j, &o);
		uint64_t k = span(l, j, o, n - x, &o);
		x += k;
		if (l->runs[j].gone) continue;
		if (grow(mem, l) || more(mem, (void **)&REC(s).taken, REC(s).ntaken, &REC(s).roomtaken, sizeof *REC(s).taken) ||
			more(mem, (void **)&s->out, s->nout + 1, &s->qroom, sizeof *s->out))
			return TP_NOMEM;
		size_t from = live_before(l, j) + (size_t)o;
		mark(l, j, o, k, 1);
		REC(s).taken[REC(s).ntaken++] = (el_gone){at, k};
		op_patch *last = s->nout ? &s->out[s->nout - 1] : NULL;
		if (last && (size_t)last->place.from == from) last->place.to += (int64_t)k;
		else if (last && from + k == (size_t)last->place.from) last->place.from = (int64_t)from;
		else {
			s->out[s->nout] = (op_patch){0}, s->out[s->nout].place = s->p->place;
			s->out[s->nout].place.from = (int64_t)from, s->out[s->nout++].place.to = (int64_t)(from + k);
		}
	}
	return 0;
}

// the value an item gone held, for a move to bring back: the cell that shows (it stops holding it),
// else its piece. NULL: none
static int unbin(work *w, tp_span node, const el_id *org, op_value **out) {
	el_state *st = w->st;
	tp_buf sb = {NULL, 0, 0, (size_t)-1, w->c->mem, 0};
	*out = NULL;
	slot_el(&sb, org);
	if (tp_buf_why(&sb)) return tp_buf_free(&sb), TP_NOMEM;
	long ti = shown_at(w->c, st, node, (tp_span){sb.p, sb.len}, NULL);
	tp_buf_free(&sb);
	if (ti < 0) return *out = bin_take(w, node, org), 0;
	const uint8_t *buf = st->slots[ti].buf;
	*out = st->slots[ti].value ? op_ref(st->slots[ti].value) : NULL;
	return hold(w, buf, NULL);
}

// the elements from id on, n of them, start to show, each with the value of its item: held by a
// segment (it was showing), or brought back. an item with no value stays gone
static int spl_show(spl *s, el_id id, uint64_t n, const seg *sg, size_t nsg) {
	work *w = s->w;
	el_list *l = s->l;
	const tp_mem *mem = w->c->mem;
	int code = 0;
	op_value **vv = tp_alloc(mem, n * sizeof *vv);
	if (!vv) return TP_NOMEM;
	memset(vv, 0, n * sizeof *vv);
	for (uint64_t x = 0; x < n && !code; x++) {
		el_id e = plus(id, x), org = origin_of(l, e);
		uint64_t ob = org.born ? org.k : org.c;
		for (size_t k = 0; k < nsg && !vv[x]; k++) {
			if (sg[k].org.device != org.device || sg[k].org.born != org.born) continue;
			uint64_t oa = sg[k].org.born ? sg[k].org.k : sg[k].org.c;
			if (ob >= oa && ob - oa < sg[k].len && sg[k].vals[ob - oa]) vv[x] = op_ref(sg[k].vals[ob - oa]);
		}
		if (!vv[x]) code = unbin(w, s->node, &org, &vv[x]);
	}
	for (uint64_t x = 0; x < n && !code;) {
		if (!vv[x]) {
			x++;
			continue;
		}
		uint64_t y = x;
		while (y < n && vv[y]) y++;
		for (uint64_t z = x; z < y && !code;) {
			el_id at = plus(id, z);
			size_t j;
			uint64_t o;
			find(l, &at, &j, &o);
			uint64_t k = span(l, j, o, y - z, &o);
			if (grow(mem, l) || more(mem, (void **)&REC(s).shown, REC(s).nshown, &REC(s).roomshown, sizeof *REC(s).shown) ||
				more(mem, (void **)&s->out, s->nout + 1, &s->qroom, sizeof *s->out) ||
				more(mem, (void **)&w->made, w->nmade, &w->roommade, sizeof *w->made)) {
				code = TP_NOMEM;
				break;
			}
			op_value *lst = op_list();
			if (!lst) {
				code = TP_NOMEM;
				break;
			}
			w->made[w->nmade++] = lst;
			for (uint64_t q = 0; q < k; q++) op_push(lst, vv[z + q]), vv[z + q] = NULL;
			size_t to = live_before(l, j);
			mark(l, j, o, k, 0);
			REC(s).shown[REC(s).nshown++] = (el_gone){at, k};
			s->out[s->nout] = (op_patch){0}, s->out[s->nout].place = s->p->place;
			s->out[s->nout].place.from = s->out[s->nout].place.to = (int64_t)to;
			s->out[s->nout].has_value = 1, s->out[s->nout++].value = lst;
			z += k;
		}
		x = y;
	}
	for (uint64_t x = 0; x < n; x++) {
		if (vv[x]) op_free(vv[x]);
	}
	tp_free(mem, vv, n * sizeof *vv);
	return code;
}

// a splice or a list move into the sequence node (v its value, p->place.path where it is now), patch
// w->i of its step, its inserted ones counted from c, by its ids (anchor) or its range, as the patches
// to apply by position (*qs, *nq). an array's items taken away or moved are events on their origins'
// registers (WIRE.md, list moves): the elements that stop showing come out of the value, those that
// start go in with the value the item had
static int splice(work *w, const op_patch *p, tp_span node, const op_value *v, uint64_t c,
	const el_anchor *anchor, op_patch **qs, size_t *nq, size_t *qcap, el_anchor *named) {
	const tp_mem *mem = w->c->mem;
	int mv = p->has_move, owned_anchor = !anchor;
	// an insert of another kind than the sequence (a list into a text): doesn't apply, as apply refuses
	if (p->has_value && (!p->value || p->value->type != v->type)) return OP_WRONG_KIND;
	if (mv && v->type != OP_LIST) return OP_WRONG_KIND;
	el_list *l;
	int code = elements(w, node, v, &l);
	if (code) return code;
	uint64_t a = (uint64_t)p->place.from, b = (uint64_t)p->place.to, o;
	long m = mv ? (long)(p->move.has_range ? p->move.to - p->move.from : 1) : p->has_value ? units(p->value) : 0;
	size_t j, ngone = 0, roomgone = 0, nsg = 0, roomsg = 0;
	el_gone *gone = NULL;
	seg *sg = NULL;
	piece *pieces = NULL;
	size_t npieces = 0, roompieces = 0;
	rlist hide = {0}, show = {0};
	el_gone *lost = NULL;
	size_t nlost = 0, roomlost = 0;
	const el_gone *names;
	size_t nnames;
	el_anchor mine = {0};
	el_id first = {0}, right = NOWHERE;
	int has_first = 0, same_before = 0;
	stamp st = {w->ref.lamport, w->ref.n, w->ref.device, (uint32_t)w->i};
	spl s = {w, l, p, node, 0, NULL, 0, 0};
	if (mv && !anchor) {
		if ((code = moved_from(l, p, &mine))) goto done;
		anchor = &mine;
	}
	// what it names: the element it goes after, and those it takes away or moves, as runs
	if (anchor) {
		has_first = anchor->has_after, first = anchor->after, j = 0, o = 0;
		if (has_first && !find(l, &first, &j, &o)) {
			code = OP_RANGE;
			goto done;
		}
		for (size_t r = 0; r < anchor->ngone; r++) {
			if (!there(l, &anchor->gone[r])) {
				code = OP_RANGE;
				goto done;
			}
		}
		// its before: there, and after its after
		if (anchor->has_before && anchor->same && !has_first) {
			code = OP_RANGE;
			goto done;
		}
		if (anchor->has_before && anchor->same) right = right_of(l, &l->runs[j], o);
		else if (anchor->has_before) right = anchor->before;
		pos f = {j, o}, at;
		if (!nowhere(&right) && (!find(l, &right, &at.j, &at.o) || (has_first && !ahead(f, at)))) {
			code = OP_RANGE;
			goto done;
		}
		names = anchor->gone, nnames = anchor->ngone;
	} else {
		if (a > b || b > l->count) {
			code = OP_RANGE;
			goto done;
		}
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
	s.ri = w->back->n++;
	w->back->p[s.ri] = (el_rec){.kind = SPLICE, .splice = {.list = l, .moved = mv}};
	// an array's items named, by origin, and what each holds now
	if (!l->text) {
		for (size_t r = 0; r < nnames; r++) {
			size_t from = nsg;
			for (uint64_t x = 0; x < names[r].count; x++) {
				el_id org = origin_of(l, plus(names[r].id, x));
				if (nsg > from) {
					el_id nx = plus(sg[nsg - 1].org, sg[nsg - 1].len);
					if (same(&nx, &org)) {
						sg[nsg - 1].len++;
						continue;
					}
				}
				if (more(mem, (void **)&sg, nsg, &roomsg, sizeof *sg)) {
					code = TP_NOMEM;
					goto done;
				}
				sg[nsg++] = (seg){org, 1, NULL};
			}
		}
		for (size_t k = 0; k < nsg; k++) {
			sg[k].vals = tp_alloc(mem, sg[k].len * sizeof(op_value *));
			if (!sg[k].vals) {
				code = TP_NOMEM;
				goto done;
			}
			memset(sg[k].vals, 0, sg[k].len * sizeof(op_value *));
			for (uint64_t q = 0; q < sg[k].len; q++) {
				el_id e = plus(sg[k].org, q);
				size_t jj;
				uint64_t oo;
				if (shown(l, &e, &jj, &oo)) sg[k].vals[q] = op_ref(v->items[live_before(l, jj) + (size_t)oo]);
			}
		}
	}
	pos lp = {0, 0}, rp = {0, 0}, spot = {0, 0};
	el_id left = has_first ? first : NOWHERE;
	if (!mv) {
		if (l->text) {
			for (size_t r = 0; r < nnames && !code; r++) code = spl_hide(&s, names[r].id, names[r].count);
		} else {
			for (size_t k = 0; k < nsg && !code; k++) {
				hide.n = show.n = 0;
				code = event(w, l, sg[k].org, sg[k].len, &st, NULL, &hide, &show);
				for (size_t r = 0; r < hide.n && !code; r++) code = spl_hide(&s, hide.p[r].id, hide.p[r].count);
			}
		}
		if (code) goto done;
		// where the inserted go: right after its element; by ids, past those put there meanwhile
		if (has_first) find(l, &first, &lp.j, &lp.o), spot = next_pos(l, lp);
		if (anchor) {
			int has_rp = !nowhere(&right) && find(l, &right, &rp.j, &rp.o);
			if ((code = scan(w, l, spot, &left, &right, has_rp ? &rp : NULL, c, &spot))) goto done;
		} else if (m > 0 && spot.j < l->n) {
			right = id_at(l, &l->runs[spot.j], spot.o);
			el_id after_right = has_first ? right_of(l, &l->runs[lp.j], lp.o) : NOWHERE;
			same_before = has_first && same(&after_right, &right);
		}
		j = spot.j, o = spot.o;
		size_t to = live_before(l, j) + (j < l->n && !l->runs[j].gone ? (size_t)o : 0);
		if (more(mem, (void **)&s.out, s.nout + 1, &s.qroom, sizeof *s.out)) {
			code = TP_NOMEM;
			goto done;
		}
		if (m > 0) {
			if ((uint64_t)m > MOST || grow(mem, l)) {
				code = (uint64_t)m > MOST ? OP_RANGE : TP_NOMEM;
				goto done;
			}
			if (o) j = cut(l, j, o, l->runs[j].len - o);
			run made = {.c = c, .device = w->ref.device, .len = (uint32_t)m,
				.left = org_of(&left), .right = org_of(&right)};
			edit(l, j, 0, &made, 1);
			l->count += (size_t)m;
			join(l, j + 1), join(l, j);
			REC(&s).device = w->ref.device, REC(&s).c = c, REC(&s).m = (uint64_t)m;
			// the items it inserts that are containers are nodes, each put at its element
			if (p->value->type == OP_LIST) {
				for (long x = 0; x < m && !code; x++) {
					if (!is_container(p->value->items[x])) continue;
					tp_buf nb = {NULL, 0, 0, (size_t)-1, mem, 0}, sb = {NULL, 0, 0, (size_t)-1, mem, 0};
					el_id e = {w->ref.device, 0, c + (uint64_t)x, 0};
					node_make(&nb, w->ref.device, w->ref.n, w->i), rel_num(&nb, (uint64_t)x), slot_el(&sb, &e);
					el_slot cellv;
					code = tp_buf_why(&nb) || tp_buf_why(&sb) ? TP_NOMEM
						: make_cell(w, node, (tp_span){sb.p, sb.len}, (tp_span){nb.p, nb.len}, EL_CELL_NODE, w->ref, &cellv);
					if (!code) code = add_cell(w, cellv);
					tp_buf_free(&nb), tp_buf_free(&sb);
				}
				if (code) goto done;
			}
		}
		if (m > 0 || !s.nout) {
			s.out[s.nout] = (op_patch){0};
			s.out[s.nout].place = p->place;
			s.out[s.nout].place.from = s.out[s.nout].place.to = (int64_t)to;
			if (m > 0) s.out[s.nout].has_value = 1, s.out[s.nout].value = p->value;
			s.nout++;
		}
	} else {
		if (has_first) find(l, &first, &lp.j, &lp.o), spot = next_pos(l, lp);
		int has_rp = !nowhere(&right) && find(l, &right, &rp.j, &rp.o);
		if ((code = scan(w, l, spot, &left, &right, has_rp ? &rp : NULL, c, &spot))) goto done;
		// a run of new elements for each run of items, their origins one on
		if (grow_n(mem, l, nsg)) {
			code = TP_NOMEM;
			goto done;
		}
		run *news = tp_alloc(mem, (nsg ? nsg : 1) * sizeof *news);
		if (!news) {
			code = TP_NOMEM;
			goto done;
		}
		uint64_t at = c;
		for (size_t k = 0; k < nsg; k++) {
			el_id before = {w->ref.device, 0, at ? at - 1 : 0, 0};
			news[k] = (run){.c = at, .device = w->ref.device, .len = (uint32_t)sg[k].len, .gone = 1,
				.left = k ? org_of(&before) : org_of(&left), .right = org_of(&right)};
			at += sg[k].len;
		}
		j = spot.j, o = spot.o;
		if (o) j = cut(l, j, o, l->runs[j].len - o);
		edit(l, j, 0, news, nsg);
		tp_free(mem, news, (nsg ? nsg : 1) * sizeof *news);
		for (size_t k = nsg + 1; k-- > 0;) join(l, j + k);
		REC(&s).device = w->ref.device, REC(&s).c = c, REC(&s).m = (uint64_t)m;
		at = c;
		for (size_t k = 0; k < nsg; k++) {
			if ((code = org_put(w, l, (orgent){at, w->ref.device, (uint32_t)sg[k].len, link_of(&sg[k].org)}))) goto done;
			at += sg[k].len;
		}
		rlist shows = {0};
		at = c;
		for (size_t k = 0; k < nsg && !code; k++) {
			el_id el = {w->ref.device, 0, at, 0};
			hide.n = show.n = 0;
			code = event(w, l, sg[k].org, sg[k].len, &st, &el, &hide, &show);
			for (size_t r = 0; r < hide.n && !code; r++) code = spl_hide(&s, hide.p[r].id, hide.p[r].count);
			for (size_t r = 0; r < show.n && !code; r++) code = rl_push(mem, &shows, show.p[r].id, show.p[r].count);
			at += sg[k].len;
		}
		for (size_t r = 0; r < shows.n && !code; r++) code = spl_show(&s, shows.p[r].id, shows.p[r].count, sg, nsg);
		tp_free(mem, shows.p, shows.room * sizeof *shows.p);
		if (code) goto done;
	}
	// the items now gone, by origin: their values are held as pieces, for a patch to name or a move to
	// bring back
	for (size_t k = 0; k < nsg; k++) {
		for (uint64_t x = 0; x < sg[k].len; x++) {
			el_id e = plus(sg[k].org, x), nx = nlost ? plus(lost[nlost - 1].id, lost[nlost - 1].count) : e;
			size_t jj;
			uint64_t oo;
			if (shown(l, &e, &jj, &oo)) continue;
			int dup_e = 0;
			for (size_t r = 0; r < nlost && !dup_e; r++) {
				el_id d = lost[r].id;
				dup_e = d.device == e.device && d.born == e.born && (e.born ? e.c == d.c && e.k >= d.k && e.k - d.k < lost[r].count
					: e.c >= d.c && e.c - d.c < lost[r].count);
			}
			if (dup_e) continue;
			if (nlost && same(&nx, &e)) lost[nlost - 1].count++;
			else if (more(mem, (void **)&lost, nlost, &roomlost, sizeof *lost)) {
				code = TP_NOMEM;
				goto done;
			} else lost[nlost++] = (el_gone){e, 1};
		}
	}
	if (!w->st->quiet) {
		// an item with a cell at its slot has its value held by the cell that shows
		for (size_t k = 0; k < nsg; k++) {
			for (uint64_t x = 0; x < sg[k].len; x++) {
				el_id e = plus(sg[k].org, x);
				size_t jj;
				uint64_t oo;
				if (!sg[k].vals[x] || shown(l, &e, &jj, &oo)) continue;
				tp_buf sb = {NULL, 0, 0, (size_t)-1, mem, 0};
				slot_el(&sb, &e);
				long ti = tp_buf_why(&sb) ? -2 : shown_at(w->c, w->st, node, (tp_span){sb.p, sb.len}, NULL);
				tp_buf_free(&sb);
				if (ti == -2) {
					code = TP_NOMEM;
					goto done;
				}
				if (ti < 0) continue;
				if ((code = hold(w, w->st->slots[ti].buf, op_ref(sg[k].vals[x])))) goto done;
				op_free(sg[k].vals[x]), sg[k].vals[x] = NULL;
			}
		}
		for (size_t k = 0; k < nsg; k++) {
			for (uint64_t x = 0; x < sg[k].len;) {
				el_id e = plus(sg[k].org, x);
				size_t jj;
				uint64_t oo;
				if (!sg[k].vals[x] || shown(l, &e, &jj, &oo) || piece_has(pieces, npieces, &e)) {
					x++;
					continue;
				}
				uint64_t y = x;
				while (y < sg[k].len) {
					el_id f = plus(sg[k].org, y);
					if (!sg[k].vals[y] || shown(l, &f, &jj, &oo) || piece_has(pieces, npieces, &f)) break;
					y++;
				}
				piece pc = {e, y - x, tp_alloc(mem, (y - x) * sizeof(op_value *))};
				if (!pc.values || more(mem, (void **)&pieces, npieces, &roompieces, sizeof *pieces)) {
					pieces_free(mem, &pc, 1, 0);
					code = TP_NOMEM;
					goto done;
				}
				for (uint64_t q = x; q < y; q++) pc.values[q - x] = sg[k].vals[q], sg[k].vals[q] = NULL;
				pieces[npieces++] = pc;
				x = y;
			}
		}
	}
	if (!l->text && nlost && (code = away(w, node, l, lost, nlost, pieces, npieces))) goto done;
	if (mv && !s.nout) {
		// nothing shows or goes: no patch
	}
	if (owned_anchor && named) {
		if (mv) {
			named->kind = 3, named->has_after = mine.has_after, named->after = mine.after, named->gone = mine.gone,
			named->ngone = mine.ngone, named->has_before = mine.has_before, named->same = mine.same,
			named->before = mine.before;
			mine.gone = NULL, mine.ngone = 0;
		} else {
			el_gone *g = ngone ? tp_grow(mem, gone, roomgone * sizeof *g, ngone * sizeof *g) : NULL;
			if (ngone && !g) {
				code = TP_NOMEM;
				goto done;
			}
			if (ngone) gone = g, roomgone = ngone;
			named->kind = 3, named->has_after = has_first, named->after = first, named->gone = gone, named->ngone = ngone;
			named->has_before = !nowhere(&right), named->same = same_before, named->before = right;
			gone = NULL, roomgone = 0;
		}
	}
	*qs = s.out, *nq = s.nout, *qcap = s.qroom, s.out = NULL;
done:
	pieces_free(mem, pieces, npieces, roompieces);
	segs_free(mem, sg, nsg, roomsg);
	tp_free(mem, gone, roomgone * sizeof *gone), tp_free(mem, s.out, s.qroom * sizeof *s.out);
	tp_free(mem, hide.p, hide.room * sizeof *hide.p), tp_free(mem, show.p, show.room * sizeof *show.p);
	tp_free(mem, lost, roomlost * sizeof *lost);
	tp_free(mem, mine.gone, mine.ngone ? mine.ngone * sizeof *mine.gone : 0);
	return code;
}

// the node at the first len keys of the path, found by place in value (a write here, a move), its
// arrays' elements made as it goes; *found 0 when a scalar or nothing is there. its bytes in out
static int node_at(work *w, const op_value *value, const op_key *path, size_t len, tp_buf *out, int *found) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	*found = 0;
	long ri = shown_at(w->c, st, (tp_span){NULL, 0}, (tp_span){NULL, 0}, NULL);
	if (ri < 0 || !sl_holds(&st->slots[ri])) return 0;
	out->len = 0;
	tp_put(out, sl_id(&st->slots[ri]), sl_idn(&st->slots[ri]));
	const op_value *v = value;
	for (size_t h = 0; h < len; h++) {
		const op_key *k = &path[h];
		tp_buf slot = {NULL, 0, 0, (size_t)-1, mem, 0};
		long si;
		if (k->type == OP_NUM_KEY) {
			el_list *l;
			int code;
			if (!v || v->type != OP_LIST) return 0;
			if ((code = elements(w, (tp_span){out->p, out->len}, v, &l))) return code;
			if (k->n < 0 || (size_t)k->n >= l->count) return 0;
			uint64_t o;
			size_t j = live_at(l, (size_t)k->n, &o);
			el_id e = origin_at(l, j, o);
			slot_el(&slot, &e);
			si = tp_buf_why(&slot) ? -2 : shown_at(w->c, st, (tp_span){out->p, out->len}, (tp_span){slot.p, slot.len}, NULL);
			if (si == -2) return tp_buf_free(&slot), TP_NOMEM;
			if (si >= 0) {
				if (!sl_holds(&st->slots[si])) return tp_buf_free(&slot), 0;
				out->len = 0, tp_put(out, sl_id(&st->slots[si]), sl_idn(&st->slots[si]));
			} else if (e.born) rel_num(out, e.k);
			else return tp_buf_free(&slot), 0;
			v = v->items[k->n];
		} else {
			if (!is_map(v)) return 0;
			slot_key(&slot, k->s);
			si = tp_buf_why(&slot) ? -2 : shown_at(w->c, st, (tp_span){out->p, out->len}, (tp_span){slot.p, slot.len}, NULL);
			if (si == -2) return tp_buf_free(&slot), TP_NOMEM;
			const op_value *c = op_get(v, k->s);
			if (si >= 0) {
				if (!sl_holds(&st->slots[si])) return tp_buf_free(&slot), 0;
				out->len = 0, tp_put(out, sl_id(&st->slots[si]), sl_idn(&st->slots[si]));
			} else if (is_container(c)) rel_text(out, k->s);
			else return tp_buf_free(&slot), 0;
			v = c;
		}
		tp_buf_free(&slot);
		if (tp_buf_why(out)) return TP_NOMEM;
	}
	if (len && !is_container(v)) return 0;
	*found = 1;
	return 0;
}

// a path as op keys in a block: the hops, then room more keys (the caller fills them); its strings after
static int block_make(work *w, const hops *h, size_t more_keys, op_key **keys) {
	const tp_mem *mem = w->c->mem;
	size_t nk = h->n + more_keys, chars = 0;
	for (size_t i = 0; i < h->n; i++) {
		if (h->p[i].num) continue;
		chars += h->p[i].s.n + 1;
		for (size_t x = 0; x < h->p[i].s.n; x++) chars += h->p[i].s.p[x] == 0;
	}
	size_t size = nk * sizeof(op_key) + chars;
	op_key *k = tp_alloc(mem, size ? size : 1);
	if (!k) return TP_NOMEM;
	char *s = (char *)(k + nk);
	for (size_t i = 0; i < h->n; i++) {
		if (h->p[i].num) k[i] = (op_key){.type = OP_NUM_KEY, .n = h->p[i].n};
		else {
			char *start = s;
			for (size_t x = 0; x < h->p[i].s.n; x++) {
				if (h->p[i].s.p[x]) *s++ = (char)h->p[i].s.p[x];
				else *s++ = (char)0xc0, *s++ = (char)0x80;
			}
			*s++ = 0;
			k[i] = (op_key){.type = OP_STR_KEY, .s = start};
		}
	}
	if (w->nblocks == w->roomblocks) {
		size_t room = w->roomblocks ? 2 * w->roomblocks : 8;
		block *b = tp_grow(mem, w->blocks, w->roomblocks * sizeof *b, room * sizeof *b);
		if (!b) return tp_free(mem, k, size ? size : 1), TP_NOMEM;
		w->blocks = b, w->roomblocks = room;
	}
	w->blocks[w->nblocks++] = (block){k, size ? size : 1, nk, chars};
	*keys = k;
	return 0;
}


// named->pred: the ids of the cells visible at (parent, slot), oldest first; a key with none and a
// value now has the cell its parent's value made, named by its place in it
static int name_preds(work *w, tp_span parent, tp_span slot, int is_el, int present, el_anchor *named) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	size_t n = 0, bytes = 0;
	for (size_t i = 0; i < st->nslots; i++) n += slot_match(&st->slots[i], parent, slot) && !sl_hidden(&st->slots[i]);
	if (!n && present && !is_el && parent.n) {
		named->predbuf = tp_alloc(mem, parent.n + slot.n), named->pred = tp_alloc(mem, sizeof *named->pred);
		if (!named->predbuf || !named->pred) return TP_NOMEM;
		memcpy(named->predbuf, parent.p, parent.n), memcpy(named->predbuf + parent.n, slot.p, slot.n);
		named->predbufn = parent.n + slot.n, named->npred = 1;
		named->pred[0] = (tp_span){named->predbuf, named->predbufn};
		return 0;
	}
	if (!n) return 0;
	size_t *idx = tp_alloc(mem, n * sizeof *idx);
	if (!idx) return TP_NOMEM;
	for (size_t i = 0, k = 0; i < st->nslots; i++) {
		if (!slot_match(&st->slots[i], parent, slot) || sl_hidden(&st->slots[i])) continue;
		size_t j = k++;
		for (; j > 0 && cell_greater(w->c, &st->slots[idx[j - 1]], &st->slots[i]); j--) idx[j] = idx[j - 1];
		idx[j] = i;
	}
	for (size_t k = 0; k < n; k++) bytes += sl_idn(&st->slots[idx[k]]);
	named->predbuf = tp_alloc(mem, bytes), named->pred = tp_alloc(mem, n * sizeof *named->pred);
	if (!named->predbuf || !named->pred) {
		tp_free(mem, idx, n * sizeof *idx);
		return TP_NOMEM;
	}
	size_t at = 0;
	for (size_t k = 0; k < n; k++) {
		const el_slot *s = &st->slots[idx[k]];
		memcpy(named->predbuf + at, sl_id(s), sl_idn(s));
		named->pred[k] = (tp_span){named->predbuf + at, sl_idn(s)};
		at += sl_idn(s);
	}
	named->predbufn = bytes, named->npred = n;
	tp_free(mem, idx, n * sizeof *idx);
	return 0;
}

// the patch an assignment's outcome comes to: *qs one patch (made), *nq how many
static int outcome(work *w, shape sh, const op_patch *p, const op_value *put, op_patch **qs, size_t *nq, size_t *qcap) {
	if (sh == A_NONE) return *nq = 0, 0;
	if (!(*qs = tp_alloc(w->c->mem, sizeof **qs))) return TP_NOMEM;
	**qs = *p;
	*nq = 1, *qcap = 1;
	if (sh == A_REMOVE) (*qs)->has_value = 0, (*qs)->value = NULL, (*qs)->has_move = 0;
	else if (sh == A_PUT) (*qs)->has_value = 1, (*qs)->value = put, (*qs)->has_move = 0;
	return 0;
}

// a put at an item gone, assigned as at one that shows but with its value held by the cell that
// shows, not written to the graph
static int gone_put(work *w, tp_span node, const el_id *e, const tp_span *cell, int container, const op_value *cellvalue,
	const tp_span *pred, size_t npred) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	tp_buf sb = {NULL, 0, 0, (size_t)-1, mem, 0}, db = sb;
	slot_el(&sb, e);
	if (e->born) tp_put(&db, node.p, node.n), rel_num(&db, e->k);
	int code = tp_buf_why(&sb) || tp_buf_why(&db) ? TP_NOMEM : 0;
	if (!code) {
		tp_span slot = {sb.p, sb.len};
		long ti = shown_at(w->c, st, node, slot, NULL);
		const op_value *had = ti >= 0 ? st->slots[ti].value : bin_peek(st, node, e);
		shape sh;
		const op_value *put;
		code = assign(w, node, slot, 1, e->born ? (tp_span){db.p, db.len} : (tp_span){NULL, 0}, had, pred, npred, 0, cell,
			container, cellvalue, &sh, &put);
		long si = code ? -1 : shown_at(w->c, st, node, slot, NULL);
		if (si >= 0) {
			const uint8_t *buf = st->slots[si].buf;
			if (sh == A_OWN) code = hold(w, buf, cellvalue ? op_ref((op_value *)cellvalue) : NULL);
			else if (sh == A_PUT) code = hold(w, buf, put ? op_ref((op_value *)put) : NULL);
			if (!code) {
				op_value *t = bin_take(w, node, e);
				if (t) op_free(t);
			}
		}
	}
	tp_buf_free(&sb), tp_buf_free(&db);
	return code;
}
static int same_keys(const op_key *a, const op_key *b, size_t n) {
	for (size_t i = 0; i < n; i++) {
		if (a[i].type != b[i].type) return 0;
		if (a[i].type == OP_NUM_KEY ? a[i].n != b[i].n : strcmp(a[i].s, b[i].s)) return 0;
	}
	return 1;
}
// a list move: one item, or a range of items, of an array to a gap in the same array, at most
// 4096 of them (WIRE.md, list moves)
int el_list_move(const op_patch *p) {
	if (!p->has_move || !p->place.has_range || p->place.from != p->place.to || p->has_value) return 0;
	const op_target *F = &p->move;
	if (F->has_range) {
		return F->to > F->from && F->to - F->from <= 4096 && F->length == p->place.length &&
			same_keys(F->path, p->place.path, F->length);
	}
	return F->length == p->place.length + 1 && F->path[F->length - 1].type == OP_NUM_KEY &&
		same_keys(F->path, p->place.path, p->place.length);
}

// a patch, its container found by its id (given) or by place (named non-NULL: a write here, and
// named): a splice, a list move, a removal at an index of an array (a splice of that one), a put at
// an index, a put or removal at a key, or of the whole value. *qs (made) the patches to apply, their
// path in w->last (a block, if made); w->host, the buffer of the cell whose held value they are
// for, when it is not the one showing. a container named that has landed and is not held is gone:
// the patch is passed over (no patches)
static int patch(work *w, const op_value *cur, const op_patch *p, uint64_t c, const el_anchor *given,
	el_anchor *named, op_patch **qs, size_t *nq, size_t *qcap) {
	const tp_mem *mem = w->c->mem;
	int reading = !named, code = 0, has_value = p->has_value && p->value;
	size_t len = p->place.length;
	if (p->has_move && !el_list_move(p)) return OP_RANGE;
	int spliced = p->place.has_range;
	const op_key *last = len ? &p->place.path[len - 1] : NULL;
	int index = !spliced && len && last->type == OP_NUM_KEY;
	tp_buf cn = {NULL, 0, 0, (size_t)-1, mem, 0}, nb = {NULL, 0, 0, (size_t)-1, mem, 0},
	       sb = {NULL, 0, 0, (size_t)-1, mem, 0};
	hops hp = {0};
	op_key *keys = NULL;
	size_t nup = 0;
	tp_span node = {0}, none = {0};
	const uint8_t *host = NULL;
	const tp_span *pred = NULL;
	size_t npred = 0;
	shape sh = A_NONE;
	const op_value *put = NULL, *base = cur;
	int passed = 0;
	w->last = -1;
	w->host = NULL;
	*nq = 0, *qcap = 0;
	if (reading && !given) return OP_NOT_A_PATCH;
	if (reading) pred = given->pred, npred = given->npred;
	// the cell a put makes has the id of the step and patch
	node_make(&nb, w->ref.device, w->ref.n, w->i);
	tp_span cellid = {nb.p, nb.len};
	int container = has_value && is_container(p->value);
	const tp_span *cell = has_value ? &cellid : NULL;
	if (!spliced && !len) {
		// the whole value
		long ri = shown_at(w->c, w->st, none, none, NULL);
		if (named) {
			named->kind = 1;
			if (ri >= 0 && sl_holds(&w->st->slots[ri])) {
				named->node = dup(mem, sl_id(&w->st->slots[ri]), sl_idn(&w->st->slots[ri])), named->noden = sl_idn(&w->st->slots[ri]);
				if (!named->node) code = TP_NOMEM;
			}
			if (!code) code = name_preds(w, none, none, 1, 0, named);
			if (!code) pred = named->pred, npred = named->npred;
		}
		if (!code) code = assign(w, none, none, 1, none, cur, pred, npred, 0, cell, container, p->value, &sh, &put);
		if (!code) code = outcome(w, sh, p, put, qs, nq, qcap);
		goto done;
	}
	size_t nlen = spliced ? len : len - 1;
	if (reading) {
		int ok;
		if (!given->noden) code = w->late ? TP_LATE : OP_RANGE;
		else if (!(code = where(w, (tp_span){given->node, given->noden}, &hp, &ok, &host)) && !ok) {
			if (landed(w->st, (tp_span){given->node, given->noden})) passed = 1, w->st->passed++;
			else code = w->late ? TP_LATE : OP_RANGE;
		}
		if (code || passed) goto done;
		node = (tp_span){given->node, given->noden};
		if ((code = block_make(w, &hp, 1, &keys))) goto done;
		w->last = (long)w->nblocks - 1;
		nup = hp.n;
		if (host) {
			long hi = cell_by(w->st, host);
			base = hi >= 0 ? w->st->slots[hi].value : NULL;
			w->host = host;
		}
	} else {
		int found;
		if ((code = node_at(w, cur, p->place.path, nlen, &cn, &found))) goto done;
		if (!found) {
			code = w->late ? TP_LATE : OP_RANGE;
			goto done;
		}
		node = (tp_span){cn.p, cn.len}, keys = (op_key *)p->place.path, nup = nlen;
	}
	const op_value *v = at_keys(base, keys, nup);
	// the path leads to nothing (a key its parent's put made, taken away): gone
	if (reading && !v) {
		w->st->passed++;
		goto done;
	}
	op_patch t = *p;
	t.place.path = keys, t.place.length = nup;
	if (named) {
		named->node = dup(mem, node.p, node.n), named->noden = node.n;
		if (!named->node) {
			code = TP_NOMEM;
			goto done;
		}
	}
	if (spliced) {
		if (!is_seq(v)) code = OP_WRONG_KIND;
		else if (reading && given->kind != 3) code = OP_RANGE;
		else code = splice(w, &t, node, v, c, reading ? given : NULL, qs, nq, qcap, named);
		goto done;
	}
	if (index && !has_value) {
		// a removal: taken away wherever it is now, once
		el_anchor sp = {0};
		if (!v || v->type != OP_LIST) code = OP_WRONG_KIND;
		else if (reading && given->kind != 3) code = OP_RANGE;
		else {
			t.place.has_range = 1, t.place.from = last->n, t.place.to = last->n + 1;
			code = splice(w, &t, node, v, c, reading ? given : NULL, qs, nq, qcap, named ? &sp : NULL);
			if (!code && named) {
				named->kind = 3, named->gone = sp.gone, named->ngone = sp.ngone;
				sp.gone = NULL;
			}
		}
		tp_free(mem, sp.gone, sp.ngone * sizeof *sp.gone);
		goto done;
	}
	if (index) {
		// a put at an index: the item is replaced, its element stays
		el_list *l;
		el_id e = {0};
		long x = 0;
		if (!v || v->type != OP_LIST) code = OP_WRONG_KIND;
		else if (!(code = elements(w, node, v, &l))) {
			if (!reading) {
				if (last->n < 0 || (size_t)last->n >= l->count) code = OP_NO_KEY;
				else {
					uint64_t o;
					size_t j = live_at(l, (size_t)last->n, &o);
					e = origin_at(l, j, o), x = last->n;
				}
			} else if (given->kind != 2) code = OP_RANGE;
			else {
				size_t j;
				uint64_t o;
				if (!find(l, &given->element, &j, &o)) code = OP_RANGE;
				else {
					e = origin_at(l, j, o);
					// an item gone: the put is a cell there, its value held, the graph not written
					if (!shown(l, &e, &j, &o)) {
						code = gone_put(w, node, &e, cell, container, p->value, pred, npred);
						passed = 1;
					} else x = (long)(live_before(l, j) + (size_t)o);
				}
			}
		}
		if (!code && !passed) {
			tp_buf db = {NULL, 0, 0, (size_t)-1, mem, 0};
			slot_el(&sb, &e);
			if (e.born) db.len = 0, tp_put(&db, node.p, node.n), rel_num(&db, e.k);
			code = tp_buf_why(&sb) || tp_buf_why(&db) ? TP_NOMEM : 0;
			if (!code && named) {
				code = name_preds(w, node, (tp_span){sb.p, sb.len}, 1, 0, named);
				pred = named->pred, npred = named->npred;
			}
			if (!code) {
				code = assign(w, node, (tp_span){sb.p, sb.len}, 1, e.born ? (tp_span){db.p, db.len} : none, v->items[x], pred, npred, 0,
					cell, container, p->value, &sh, &put);
			}
			tp_buf_free(&db);
			if (!code) code = outcome(w, sh, p, put, qs, nq, qcap);
			if (!code) {
				if (*nq) {
					(*qs)->place.path = keys;
					keys[nup] = (op_key){.type = OP_NUM_KEY, .n = x};
					(*qs)->place.length = nup + 1;
				}
				if (named) named->kind = 2, named->element = e;
			}
		}
	} else {
		// a put or removal at a key
		if (!is_map(v)) code = OP_WRONG_KIND;
		else {
			const op_value *old = op_get(v, last->s);
			tp_buf db = {NULL, 0, 0, (size_t)-1, mem, 0};
			slot_key(&sb, last->s);
			if (is_container(old)) tp_put(&db, node.p, node.n), rel_text(&db, last->s);
			code = tp_buf_why(&sb) || tp_buf_why(&db) ? TP_NOMEM : 0;
			if (!code && named) {
				code = name_preds(w, node, (tp_span){sb.p, sb.len}, 0, old != NULL, named);
				pred = named->pred, npred = named->npred;
			}
			if (!code) {
				code = assign(w, node, (tp_span){sb.p, sb.len}, 0, is_container(old) ? (tp_span){db.p, db.len} : none, old, pred,
					npred, 0, cell, container, p->value, &sh, &put);
			}
			tp_buf_free(&db);
			if (!code) code = outcome(w, sh, p, put, qs, nq, qcap);
			if (!code) {
				if (*nq) {
					(*qs)->place.path = keys;
					keys[nup] = *last;
					(*qs)->place.length = nup + 1;
				}
				if (named) named->kind = 1;
			}
		}
	}
done:
	tp_buf_free(&cn), tp_buf_free(&nb), tp_buf_free(&sb);
	tp_free(mem, hp.p, hp.room * sizeof *hp.p);
	return code;
}

// the elements a splice or move inserted, taken out again
static void unmake(el_list *l, const el_rec *r) {
	el_id id = {r->splice.device, 0, r->splice.c, 0};
	size_t j;
	uint64_t o;
	for (uint64_t x = 0, m = r->splice.m; x < m;) {
		el_id at = plus(id, x);
		find(l, &at, &j, &o);
		uint64_t n = span(l, j, o, m - x, &o);
		size_t i = cut(l, j, o, n);
		edit(l, i, 1, NULL, 0);
		if (!r->splice.moved) l->count -= (size_t)n;
		x += n;
		join(l, i);
	}
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
		// a splice's inserted elements came last, a move's first (gone at first)
		if (!r->splice.moved) unmake(l, r);
		for (size_t g = r->splice.nshown; g-- > 0;) {
			const el_gone *sh = &r->splice.shown[g];
			for (uint64_t x = 0; x < sh->count;) {
				el_id at = plus(sh->id, x);
				find(l, &at, &j, &o);
				uint64_t n = span(l, j, o, sh->count - x, &o);
				mark(l, j, o, n, 1), x += n;
			}
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
		if (r->splice.moved) unmake(l, r);
		tp_free(mem, r->splice.taken, r->splice.roomtaken * sizeof *r->splice.taken);
		tp_free(mem, r->splice.shown, r->splice.roomshown * sizeof *r->splice.shown);
	} else if (r->kind == ADD) {
		long i = cell_by(st, r->slot.cell.buf);
		if (i >= 0) {
			slot_free(mem, &st->slots[i]);
			st->slots[i] = st->slots[--st->nslots];
		}
	} else if (r->kind == TAKE) {
		st->slots[st->nslots++] = r->slot.cell;
	} else if (r->kind == HOLD) {
		long i = cell_by(st, r->hold.buf);
		if (i >= 0) {
			if (st->slots[i].value) op_free(st->slots[i].value);
			st->slots[i].value = r->hold.was;
		} else if (r->hold.was) op_free(r->hold.was);
	} else if (r->kind == BIN) {
		long i = cell_by(st, r->hold.buf);
		if (i >= 0) {
			if (st->slots[i].value) op_free(st->slots[i].value);
			st->slots[i].value = r->hold.was;
			st->slots[i].idn &= ~EL_CELL_TRASH;
		} else if (r->hold.was) op_free(r->hold.was);
	} else if (r->kind == BINADD) {
		while (r->binadd.count--) bin_free(mem, st->bins[--st->nbins]);
	} else if (r->kind == BINTAKE) {
		r->bintake.bin->values[r->bintake.x] = r->bintake.v;
	} else if (r->kind == LANDED) {
		for (size_t i = 0; i < st->nlanded; i++) {
			if (st->landed[i].device != r->landed.device) continue;
			if (r->landed.n) st->landed[i].n = r->landed.n;
			else st->landed[i] = st->landed[--st->nlanded];
			break;
		}
	} else if (r->kind == REG) {
		el_list *l = r->reg.list;
		reg *old = r->reg.old;
		memmove(l->regs + r->reg.at + r->reg.nold, l->regs + r->reg.at + r->reg.nins,
			(l->nreg - r->reg.at - r->reg.nins) * sizeof *l->regs);
		if (r->reg.nold) memcpy(l->regs + r->reg.at, old, r->reg.nold * sizeof *old);
		l->nreg = l->nreg - r->reg.nins + r->reg.nold;
		tp_free(mem, old, r->reg.nold * sizeof *old);
	} else if (r->kind == ORG) {
		el_list *l = r->org.list;
		memmove(l->orgs + r->org.at, l->orgs + r->org.at + 1, (l->norg - r->org.at - 1) * sizeof *l->orgs);
		l->norg--;
	} else {
		for (size_t i = 0; i < r->drop.nlists; i++) st->lists[st->n++] = r->drop.lists[i];
		for (size_t i = 0; i < r->drop.nslots; i++) st->slots[st->nslots++] = r->drop.slots[i];
		tp_free(mem, r->drop.lists, r->drop.nlists * sizeof *r->drop.lists);
		tp_free(mem, r->drop.slots, r->drop.nslots * sizeof *r->drop.slots);
	}
}

static void drop_rec(const tp_mem *mem, el_rec *r) {
	if (r->kind == SPLICE) {
		tp_free(mem, r->splice.taken, r->splice.roomtaken * sizeof *r->splice.taken);
		tp_free(mem, r->splice.shown, r->splice.roomshown * sizeof *r->splice.shown);
	} else if (r->kind == REG) tp_free(mem, r->reg.old, r->reg.nold * sizeof(reg));
	else if (r->kind == TAKE) slot_free(mem, &r->slot.cell);
	else if (r->kind == BINTAKE) op_free(r->bintake.v);
	else if (r->kind == HOLD || r->kind == BIN) {
		if (r->hold.was) op_free(r->hold.was);
	} else if (r->kind == DROP) {
		for (size_t i = 0; i < r->drop.nlists; i++) list_free(mem, r->drop.lists[i]);
		for (size_t i = 0; i < r->drop.nslots; i++) slot_free(mem, &r->drop.slots[i]);
		tp_free(mem, r->drop.lists, r->drop.nlists * sizeof *r->drop.lists);
		tp_free(mem, r->drop.slots, r->drop.nslots * sizeof *r->drop.slots);
	}
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

int el_seed(const tp_mem *mem, el_state *st, const el_ref *ref, int container) {
	tp_buf nb = {NULL, 0, 0, (size_t)-1, mem, 0};
	node_make(&nb, ref->device, ref->n, 0);
	el_slot s = {0};
	s.buf = dup(mem, nb.p, nb.len), s.idn = (uint32_t)nb.len | (container ? EL_CELL_NODE : 0);
	s.lamport = ref->lamport, s.device = ref->device;
	size_t idn = nb.len;
	int bad = tp_buf_why(&nb) || !s.buf || slots_room(mem, st);
	if (!bad && !st->roomlanded) {
		st->landed = tp_alloc(mem, 4 * sizeof *st->landed);
		bad = !st->landed;
		if (!bad) st->roomlanded = 4;
	}
	if (bad) return tp_buf_free(&nb), tp_free(mem, s.buf, idn), TP_NOMEM;
	tp_buf_free(&nb);
	st->landed[st->nlanded].device = ref->device, st->landed[st->nlanded++].n = ref->n;
	st->slots[st->nslots++] = s;
	return 0;
}

int el_cells(const el_ctx *c, el_state *st, const op_value *value, const op_key *path, size_t length,
	el_version **out, size_t *count) {
	const tp_mem *mem = c->mem;
	el_back back = {NULL, 0, 0};
	work w = {.c = c, .st = st, .back = &back, .last = -1};
	tp_buf nb = {NULL, 0, 0, (size_t)-1, mem, 0}, sb = nb;
	tp_span parent = {NULL, 0}, slot = {NULL, 0};
	size_t n = 0, *idx = NULL;
	int code = 0, found = 1;
	*out = NULL, *count = 0;
	if (length) {
		const op_value *up = at_keys(value, path, length - 1);
		const op_key *k = &path[length - 1];
		if ((code = node_at(&w, value, path, length - 1, &nb, &found)) || !found) goto done;
		if (k->type == OP_NUM_KEY) {
			el_list *l;
			if (!up || up->type != OP_LIST) goto done;
			if ((code = elements(&w, (tp_span){nb.p, nb.len}, up, &l))) goto done;
			if (k->n < 0 || (size_t)k->n >= l->count) goto done;
			uint64_t o;
			size_t j = live_at(l, (size_t)k->n, &o);
			el_id e = origin_at(l, j, o);
			slot_el(&sb, &e);
		} else slot_key(&sb, k->s);
		if (tp_buf_why(&nb) || tp_buf_why(&sb)) {
			code = TP_NOMEM;
			goto done;
		}
		parent = (tp_span){nb.p, nb.len}, slot = (tp_span){sb.p, sb.len};
	}
	for (size_t i = 0; i < st->nslots; i++) n += slot_match(&st->slots[i], parent, slot) && !sl_hidden(&st->slots[i]);
	if (!n) {
		// a key its parent's put made, with no cell of its own: that put's
		const op_value *x = length ? at_keys(value, path, length) : NULL;
		long from = x && parent.n ? cell_enclosing(st, parent) : -1;
		if (from < 0) goto done;
		el_version *one = tp_alloc(mem, sizeof *one);
		if (!one) {
			code = TP_NOMEM;
			goto done;
		}
		uint64_t dn, di;
		sl_head(&st->slots[from], &dn, &di);
		tp_in in = {sl_id(&st->slots[from]), sl_id(&st->slots[from]) + sl_idn(&st->slots[from])};
		uint64_t d = 0;
		tp_whole(&in, &d);
		*one = (el_version){op_ref((op_value *)x), (uint32_t)d, dn};
		*out = one, *count = 1;
		goto done;
	}
	idx = tp_alloc(mem, n * sizeof *idx);
	if (!idx) {
		code = TP_NOMEM;
		goto done;
	}
	// the greatest first
	for (size_t i = 0, m = 0; i < st->nslots; i++) {
		if (!slot_match(&st->slots[i], parent, slot) || sl_hidden(&st->slots[i])) continue;
		size_t j = m++;
		for (; j > 0 && cell_greater(c, &st->slots[i], &st->slots[idx[j - 1]]); j--) idx[j] = idx[j - 1];
		idx[j] = i;
	}
	el_version *v = tp_alloc(mem, n * sizeof *v);
	if (!v) {
		code = TP_NOMEM;
		goto done;
	}
	for (size_t i = 0; i < n; i++) {
		const el_slot *s = &st->slots[idx[i]];
		uint64_t dn, di;
		tp_in in = {sl_id(s), sl_id(s) + sl_idn(s)};
		uint64_t d = 0;
		tp_whole(&in, &d);
		sl_head(s, &dn, &di);
		const op_value *x = i ? s->value : at_keys(value, path, length);
		v[i] = (el_version){x ? op_ref((op_value *)x) : NULL, (uint32_t)d, dn};
	}
	*out = v, *count = n;
done:
	tp_free(mem, idx, n * sizeof *idx);
	tp_buf_free(&nb), tp_buf_free(&sb);
	el_back_undo(mem, st, &back);
	return code;
}
void el_cells_free(const tp_mem *mem, el_version *v, size_t count) {
	for (size_t i = 0; i < count; i++) {
		if (v[i].value) op_free(v[i].value);
	}
	tp_free(mem, v, count * sizeof *v);
}

int el_lone(const el_state *st, const el_ref *ref) {
	if (st->nslots != 1 || st->n || st->nlanded != 1 || st->landed[0].device != ref->device) return 0;
	const el_slot *s = &st->slots[0];
	uint64_t n, i;
	if (s->parentn || s->slotn || sl_hidden(s) || s->value || s->device != ref->device) return 0;
	sl_head(s, &n, &i);
	return n == ref->n && i == 0;
}

// whether the cell is the cell of an item gone
static int cell_gone(const el_state *st, const el_slot *s) {
	el_id e;
	size_t j;
	uint64_t o;
	if (sl_trash(s) || sl_ghost(s) || !sl_el(s, &e)) return 0;
	el_list *l = list_at(st, (tp_span){sl_parent(s), s->parentn});
	return l && find(l, &e, &j, &o) && !shown(l, &e, &j, &o);
}

void el_trash(const el_state *st, size_t *count, size_t *bytes) {
	*count = *bytes = 0;
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		if (!sl_trash(s) && !(s->value && cell_gone(st, s))) continue;
		(*count)++, *bytes += sizeof *s + s->parentn + s->slotn + sl_idn(s) + weigh(s->value);
	}
	for (size_t i = 0; i < st->nbins; i++) {
		const el_bin *b = st->bins[i];
		*bytes += sizeof *b + b->listn + b->n * sizeof *b->values;
		for (uint64_t x = 0; x < b->n; x++) {
			if (b->values[x]) (*count)++, *bytes += weigh(b->values[x]);
		}
	}
}

long el_empty(const tp_mem *mem, el_state *st) {
	el_ctx c = {.mem = mem};
	el_back back = {NULL, 0, 0};
	work w = {.c = &c, .st = st, .back = &back, .last = -1};
	size_t count, bytes;
	el_trash(st, &count, &bytes);
	int code = 0;
	for (; !code;) {
		long i = 0;
		while ((size_t)i < st->nslots && !sl_trash(&st->slots[i]) && !cell_gone(st, &st->slots[i])) i++;
		if ((size_t)i == st->nslots) break;
		const uint8_t *buf = st->slots[i].buf;
		code = sl_holds(&st->slots[i]) ? drop_node(&w, sl_nodespan(&st->slots[i])) : 0;
		i = cell_by(st, buf);
		if (!code && i >= 0) code = take_cell(&w, (size_t)i);
	}
	el_back_free(mem, &back);
	for (size_t i = 0; i < st->nbins; i++) bin_free(mem, st->bins[i]);
	tp_free(mem, st->bins, st->roombins * sizeof *st->bins);
	st->bins = NULL, st->nbins = st->roombins = 0;
	return code ? code : (long)count;
}

void el_state_free(const tp_mem *mem, el_state *st) {
	for (size_t i = 0; i < st->n; i++) list_free(mem, st->lists[i]);
	for (size_t i = 0; i < st->nslots; i++) slot_free(mem, &st->slots[i]);
	for (size_t i = 0; i < st->nbins; i++) bin_free(mem, st->bins[i]);
	tp_free(mem, st->bins, st->roombins * sizeof *st->bins);
	tp_free(mem, st->lists, st->room * sizeof *st->lists);
	tp_free(mem, st->slots, st->roomslots * sizeof *st->slots);
	tp_free(mem, st->landed, st->roomlanded * sizeof *st->landed);
	*st = (el_state){0};
}

// undoes the records past marks (a step that failed)
static void rollback(work *w, size_t marks) {
	el_back *b = w->back;
	while (b->n > marks) undo_rec(w->c->mem, w->st, &b->p[--b->n]);
}

int el_step(const el_ctx *c, el_state *st, op_value **value, const el_ref *ref, tp_span patches,
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int late,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named,
	el_made *made_out) {
	work w = {.c = c, .st = st, .back = back, .ref = *ref, .late = late, .last = -1};
	size_t marks, at = 0, nout = 0, roomout = 0, nus = 0, roomus = 0;
	op_value *cur = *value;
	int owned = 0, code = 0;
	op_patch *out = NULL, *cat = NULL;
	long *outblk = NULL;
	op_undo *us = NULL;
	el_anchor *nm = NULL;
	size_t total = 0;
	uint64_t made = 0; // the step's elements so far: the next is its seq + made
	// this step has landed, whether or not it applies: noted before the mark a failure goes back to
	if ((code = landed_set(&w, ref->device, ref->n))) return code;
	marks = back->n;
	if (!ids && named && n && !(nm = tp_alloc(c->mem, n * sizeof *nm))) return TP_NOMEM;
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
		w.i = i;
		if (keep && !keep[i]) continue;
		op_patch *qs = (op_patch *)p, *made_qs = NULL;
		size_t nq = 1, qcap = 0;
		w.last = -1, w.host = NULL;
		code = patch(&w, cur, p, counter, ids ? &ids[i] : NULL, nm ? &nm[i] : NULL, &made_qs, &nq, &qcap);
		if (!code) qs = made_qs;
		for (size_t q = 0; q < nq && !code; q++) {
			op_value *next = NULL;
			size_t failed;
			op_undo u = {NULL, 0, 0};
			op_apply_options ao = {.undo = &u};
			if (w.host) {
				// into a cell that is not showing: its held value
				long hi = cell_by(st, w.host);
				if (hi < 0 || !st->slots[hi].value) {
					code = OP_NO_KEY;
					break;
				}
				if ((code = op_apply(st->slots[hi].value, &qs[q], 1, NULL, &next, &failed))) break;
				if ((code = hold(&w, w.host, next))) break;
				continue;
			}
			if ((code = op_apply(cur, &qs[q], 1, undo ? &ao : NULL, &next, &failed))) break;
			if (owned) op_free(cur);
			cur = next, owned = 1;
			if (nout == roomout) {
				size_t room = roomout ? 2 * roomout : 8;
				op_patch *o = realloc(out, room * sizeof *o);
				long *ob = realloc(outblk, room * sizeof *ob);
				if (o) out = o;
				if (ob) outblk = ob;
				if (!o || !ob) {
					op_undo_free(&u);
					code = TP_NOMEM;
					break;
				}
				roomout = room;
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
			outblk[nout] = qs == p ? -1 : w.last;
			out[nout++] = qs[q];
			if (undo) us[nus++] = u;
		}
		tp_free(c->mem, made_qs, qcap * sizeof *made_qs);
	}
	if (!code && undo) {
		for (size_t i = 0; i < nus; i++) total += us[i].n;
		if (total && !(cat = malloc(total * sizeof *cat))) code = TP_NOMEM;
	}
	// the patches as applied, their paths after them: keys, then the strings of those found by id
	op_patch *whole = NULL;
	if (!code && applied && nout) {
		size_t bytes = nout * sizeof *whole;
		for (size_t i = 0; i < nout; i++) bytes += out[i].place.length * sizeof(op_key);
		for (size_t b = 0; b < w.nblocks; b++) bytes += w.blocks[b].chars;
		if (!(whole = malloc(bytes))) {
			free(cat);
			code = TP_NOMEM;
		} else {
			op_key *k = (op_key *)(whole + nout);
			char *chars = (char *)(k);
			for (size_t i = 0; i < nout; i++) chars += out[i].place.length * sizeof(op_key);
			char **base = w.nblocks ? calloc(w.nblocks, sizeof *base) : NULL;
			for (size_t i = 0; i < nout; i++) {
				whole[i] = out[i];
				size_t m = out[i].place.length;
				if (outblk[i] >= 0 && base) {
					const block *b = &w.blocks[outblk[i]];
					const char *old = (const char *)((op_key *)b->p + b->nkeys);
					if (!base[outblk[i]]) memcpy(chars, old, b->chars), base[outblk[i]] = chars, chars += b->chars;
					for (size_t x = 0; x < m; x++) {
						k[x] = out[i].place.path[x];
						if (k[x].type == OP_STR_KEY && k[x].s >= old && k[x].s < old + b->chars) {
							k[x].s = base[outblk[i]] + (k[x].s - old);
						}
					}
				} else if (m) memcpy(k, out[i].place.path, m * sizeof *k);
				whole[i].place.path = k;
				k += m;
			}
			free(base);
		}
	}
	for (size_t b = 0; b < w.nblocks; b++) tp_free(c->mem, w.blocks[b].p, w.blocks[b].size);
	tp_free(c->mem, w.blocks, w.roomblocks * sizeof *w.blocks);
	if (code) {
		for (size_t i = 0; i < nus; i++) op_undo_free(&us[i]);
		tp_free(c->mem, us, roomus * sizeof *us);
		free(out), free(outblk);
		if (nm) el_anchors_free(c->mem, nm, n);
		if (owned) op_free(cur);
		el_made_free(c->mem, &(el_made){w.made, w.nmade, w.roommade});
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
	free(out), free(outblk);
	if (applied) *applied = whole, *napplied = nout;
	else free(whole);
	if (made_out) *made_out = (el_made){w.made, w.nmade, w.roommade};
	else el_made_free(c->mem, &(el_made){w.made, w.nmade, w.roommade});
	if (named) *named = nm;
	return 0;
}

void el_made_free(const tp_mem *mem, el_made *m) {
	for (size_t i = 0; i < m->n; i++) op_free(m->p[i]);
	tp_free(mem, m->p, m->room * sizeof *m->p);
	*m = (el_made){0};
}

void el_anchors_free(const tp_mem *mem, el_anchor *a, size_t n) {
	if (!a) return;
	for (size_t i = 0; i < n; i++) {
		tp_free(mem, a[i].gone, a[i].ngone * sizeof *a[i].gone);
		tp_free(mem, a[i].node, a[i].noden);
		tp_free(mem, a[i].predbuf, a[i].predbufn);
		tp_free(mem, a[i].pred, a[i].npred * sizeof *a[i].pred);
	}
	tp_free(mem, a, n * sizeof *a);
}

int el_named(const el_anchor *a, size_t n) {
	for (size_t i = 0; a && i < n; i++) {
		if (a[i].kind) return 1;
	}
	return 0;
}

// an element id as written: this device's x (seq - x; past seq, none) or [x, k] (step n - x),
// another's [device, seq] or [device, n, k]; in a through (abs) this device's seq c or [c, k]
static int read_id(const el_ctx *c, tp_in *in, const tp_step *s, uint64_t seq, uint32_t me, int abs, el_id *id) {
	uint64_t k, a, b = 0;
	int64_t x;
	tp_span key;
	if (in->p < in->end && *in->p >> 5 <= 1) {
		if (tp_int(in, &x)) return -1;
		if (abs) return *id = (el_id){me, 0, (uint64_t)x, 0}, 0;
		uint64_t back = x >= 0 ? (uint64_t)x : 0, on = x < 0 ? (uint64_t)-x : 0;
		*id = (el_id){back > seq ? EL_UNKNOWN : me, 0, seq - (back > seq ? 0 : back) + on, 0};
		return 0;
	}
	if (tp_array(in, &k)) return -1;
	if (in->p < in->end && *in->p >> 5 == 0) {
		if (tp_whole(in, &a) || tp_whole(in, &b) || (abs ? a < 1 || a > s->n : a >= s->n)) return -1;
		*id = (el_id){me, 1, abs ? a : s->n - a, b};
		return 0;
	}
	if (tp_bytes(in, 32, &key) || tp_whole(in, &a) || (k == 3 && tp_whole(in, &b))) return -1;
	// a device not known has no elements: nothing is named by it, and it is not made known
	long d = c->find(c->self, key.p);
	*id = (el_id){d < 0 ? EL_UNKNOWN : (uint32_t)d, k == 3, a, b};
	return 0;
}


// a node as written: this device's [n, i, rel…] or another's [device, n, i, rel…]; its bytes (cbor
// items one after another) put in out
static int read_node(const el_ctx *c, tp_in *in, uint32_t me, tp_buf *out) {
	uint64_t k, a, i;
	tp_span key;
	if (tp_array(in, &k) || k < 2) return -1;
	if (in->p < in->end && *in->p >> 5 == 0) {
		if (tp_whole(in, &a) || tp_whole(in, &i)) return -1;
		node_make(out, me, a, i), k -= 2;
	} else {
		if (k < 3 || tp_bytes(in, 32, &key) || tp_whole(in, &a) || tp_whole(in, &i)) return -1;
		long d = c->find(c->self, key.p);
		node_make(out, d < 0 ? EL_UNKNOWN : (uint32_t)d, a, i), k -= 3;
	}
	for (; k; k--) {
		const uint8_t *from = in->p;
		tp_span item;
		if (tp_skip(in, &item)) return -1;
		tp_put(out, from, (size_t)(in->p - from));
	}
	return 0;
}

// a node as written, a device in it made known: this device's [n, i, rel…] or another's [device, n, i, rel…]; its bytes (cbor
// items one after another) put in out
static int read_node_known(const el_ctx *c, tp_in *in, uint32_t me, tp_buf *out) {
	uint64_t k, a, i;
	tp_span key;
	if (tp_array(in, &k) || k < 2) return -1;
	if (in->p < in->end && *in->p >> 5 == 0) {
		if (tp_whole(in, &a) || tp_whole(in, &i)) return -1;
		node_make(out, me, a, i), k -= 2;
	} else {
		if (k < 3 || tp_bytes(in, 32, &key) || tp_whole(in, &a) || tp_whole(in, &i)) return -1;
		long d = c->index(c->self, key.p);
		if (d < 0) return -2;
		node_make(out, (uint32_t)d, a, i), k -= 3;
	}
	for (; k; k--) {
		const uint8_t *from = in->p;
		tp_span item;
		if (tp_skip(in, &item)) return -1;
		tp_put(out, from, (size_t)(in->p - from));
	}
	return 0;
}

// the pred of a patch: an array of nodes, their bytes after one another in a.predbuf, each a span
static int read_pred(const el_ctx *c, tp_in *in, uint32_t me, el_anchor *a) {
	uint64_t k;
	tp_buf pb = {NULL, 0, 0, (size_t)-1, c->mem, 0};
	size_t *ends = NULL;
	int code = 0;
	if (tp_array(in, &k)) return TP_NOTSTEP;
	if (!k) return 0;
	if (k > (uint64_t)(in->end - in->p)) return TP_NOTSTEP;
	ends = tp_alloc(c->mem, (size_t)k * sizeof *ends);
	if (!ends) return TP_NOMEM;
	for (uint64_t j = 0; j < k && !code; j++) {
		int bad = read_node_known(c, in, me, &pb);
		if (bad) code = bad == -2 ? TP_NOMEM : TP_NOTSTEP;
		else ends[j] = pb.len;
	}
	if (!code && tp_buf_why(&pb)) code = TP_NOMEM;
	if (!code) {
		a->predbuf = dup(c->mem, pb.p, pb.len), a->predbufn = pb.len;
		a->pred = tp_alloc(c->mem, (size_t)k * sizeof *a->pred);
		if (!a->predbuf || !a->pred) code = TP_NOMEM;
		else {
			size_t from = 0;
			for (uint64_t j = 0; j < k; j++) a->pred[j] = (tp_span){a->predbuf + from, ends[j] - from}, from = ends[j];
			a->npred = (size_t)k;
		}
	}
	tp_buf_free(&pb);
	tp_free(c->mem, ends, (size_t)k * sizeof *ends);
	return code;
}

int el_read(const el_ctx *c, const tp_step *s, el_anchor **out) {
	uint64_t seq = s->seq;
	*out = NULL;
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
		uint64_t two, g = 0;
		tp_buf nb = {NULL, 0, 0, (size_t)-1, c->mem, 0};
		if (tp_null(&in)) continue;
		if (tp_array(&in, &two) || two < 2 || two > 4) {
			code = TP_NOTSTEP;
			break;
		}
		if (!tp_null(&in)) {
			if (read_node(c, &in, (uint32_t)me, &nb) || tp_buf_why(&nb)) code = tp_buf_why(&nb) ? TP_NOMEM : TP_NOTSTEP;
			else if (!(a[i].node = dup(c->mem, nb.p, nb.len))) code = TP_NOMEM;
			else a[i].noden = nb.len;
		}
		tp_buf_free(&nb);
		if (code) break;
		a[i].kind = (int)two - 1;
		if (two <= 3) {
			code = read_pred(c, &in, (uint32_t)me, &a[i]);
			if (!code && two == 3 && read_id(c, &in, s, seq, (uint32_t)me, 0, &a[i].element)) code = TP_NOTSTEP;
			continue;
		}
		if (!tp_null(&in)) {
			code = read_id(c, &in, s, seq, (uint32_t)me, 0, &a[i].after) ? TP_NOTSTEP : 0, a[i].has_after = 1;
		}
		if (!code && tp_array(&in, &g)) code = TP_NOTSTEP;
		if (!code && g && !(a[i].gone = tp_alloc(c->mem, (size_t)g * sizeof *a[i].gone))) code = TP_NOMEM;
		if (!code) a[i].ngone = (size_t)g;
		for (uint64_t j = 0; j < g && !code; j++) {
			uint64_t pair;
			if (tp_array(&in, &pair) || read_id(c, &in, s, seq, (uint32_t)me, 0, &a[i].gone[j].id) ||
				tp_whole(&in, &a[i].gone[j].count))
				code = TP_NOTSTEP;
		}
		if (!code && !tp_null(&in)) {
			a[i].has_before = 1;
			if (in.p < in.end && *in.p == 0xf5) in.p++, a[i].same = 1;
			else code = read_id(c, &in, s, seq, (uint32_t)me, 0, &a[i].before) ? TP_NOTSTEP : 0;
		}
	}
	if (code) return el_anchors_free(c->mem, a, (size_t)k), code;
	*out = a;
	return 0;
}

static void write_id(tp_buf *b, const el_ctx *c, const el_id *id, uint32_t me, uint64_t n, uint64_t seq, int abs) {
	if (id->device == me && id->born) tp_put_head(b, 4, 2), tp_put_head(b, 0, abs ? id->c : n - id->c);
	else if (id->device == me) {
		if (abs) tp_put_head(b, 0, id->c);
		else if (id->c <= seq) tp_put_head(b, 0, seq - id->c);
		else tp_put_head(b, 1, id->c - seq - 1);
	} else {
		tp_put_head(b, 4, id->born ? 3 : 2), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, id->device), 32);
		tp_put_head(b, 0, id->c);
	}
	if (id->born) tp_put_head(b, 0, id->k);
}

// a node as written: this device's [n, i, rel…], another's [device, n, i, rel…]
static void write_node(tp_buf *b, const el_ctx *c, const uint8_t *node, size_t noden, uint32_t me) {
	tp_in in = {node, node + noden};
	uint64_t k = 0, dev;
	tp_span item;
	if (tp_whole(&in, &dev)) return;
	while (in.p < in.end && !tp_skip(&in, &item)) k++;
	in = (tp_in){node, node + noden};
	tp_whole(&in, &dev);
	if (dev == me) tp_put_head(b, 4, k);
	else tp_put_head(b, 4, k + 1), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, (uint32_t)dev), 32);
	tp_put(b, in.p, (size_t)(in.end - in.p));
}

void el_write(tp_buf *b, const el_ctx *c, const el_anchor *a, size_t count, uint32_t me, uint64_t n,
	uint64_t seq) {
	tp_put_head(b, 4, count);
	for (size_t i = 0; i < count; i++) {
		if (!a[i].kind) {
			tp_put(b, "\xf6", 1);
			continue;
		}
		tp_put_head(b, 4, a[i].kind == 1 ? 2 : a[i].kind == 2 ? 3 : 4);
		if (a[i].noden) write_node(b, c, a[i].node, a[i].noden, me);
		else tp_put(b, "\xf6", 1);
		if (a[i].kind <= 2) {
			tp_put_head(b, 4, a[i].npred);
			for (size_t j = 0; j < a[i].npred; j++) write_node(b, c, a[i].pred[j].p, a[i].pred[j].n, me);
			if (a[i].kind == 2) write_id(b, c, &a[i].element, me, n, seq, 0);
		} else {
			if (a[i].has_after) write_id(b, c, &a[i].after, me, n, seq, 0);
			else tp_put(b, "\xf6", 1);
			tp_put_head(b, 4, a[i].ngone);
			for (size_t j = 0; j < a[i].ngone; j++) {
				tp_put_head(b, 4, 2), write_id(b, c, &a[i].gone[j].id, me, n, seq, 0);
				tp_put_head(b, 0, a[i].gone[j].count);
			}
			if (a[i].has_before && a[i].same) tp_put(b, "\xf5", 1);
			else if (a[i].has_before) write_id(b, c, &a[i].before, me, n, seq, 0);
			else tp_put(b, "\xf6", 1);
		}
	}
}

// a state's sequences and cells as cbor, for a snapshot (the value is the graph's): [lists, cells,
// landed, moved], a list [node, text, runs], a run [device, c, len, flags, left, right], an element's
// origin null or [device, born, number], a node [device, n, patch, rel…], a cell [parent or null,
// key or an element [device, born, c, k], id, flags (1 holds a container, 2 a ghost, 4 trash), a step's place
// [lamport, device, n, seq], its held value as cbor bytes or null], landed [[device, n], …], moved a
// step's place or null
static void save_ref(tp_buf *b, const el_ctx *c, const el_ref *r, int none) {
	if (none) {
		tp_put(b, "\xf6", 1);
		return;
	}
	tp_put_head(b, 4, 4), tp_put_head(b, 0, r->lamport);
	tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, r->device), 32);
	tp_put_head(b, 0, r->n), tp_put_head(b, 0, r->seq);
}
static void save_org(tp_buf *b, const el_ctx *c, org g) {
	if (g.none) {
		tp_put(b, "\xf6", 1);
		return;
	}
	tp_put_head(b, 4, 3);
	if (g.device == ORG_NONE) tp_put_head(b, 2, 0);
	else tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, g.device), 32);
	tp_put_head(b, 0, g.born), tp_put_head(b, 0, (uint64_t)g.hi << 32 | g.lo);
}
static void save_link(tp_buf *b, const el_ctx *c, olink g) {
	if (!g.set) {
		tp_put(b, "\xf6", 1);
		return;
	}
	tp_put_head(b, 4, 3), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, g.device), 32);
	tp_put_head(b, 0, g.born), tp_put_head(b, 0, (uint64_t)g.hi << 32 | g.lo);
}
static void save_node(tp_buf *b, const el_ctx *c, const uint8_t *node, size_t noden) {
	if (!noden) {
		tp_put(b, "\xf6", 1);
		return;
	}
	write_node(b, c, node, noden, UINT32_MAX);
}
void el_save(tp_buf *b, const el_ctx *c, const el_state *st) {
	tp_put_head(b, 4, 5), tp_put_head(b, 4, st->n);
	for (size_t i = 0; i < st->n; i++) {
		const el_list *l = st->lists[i];
		tp_put_head(b, 4, 5), save_node(b, c, l->key, l->keyn), tp_put_head(b, 0, (uint64_t)l->text);
		tp_put_head(b, 4, l->n);
		for (size_t j = 0; j < l->n; j++) {
			const run *r = &l->runs[j];
			tp_put_head(b, 4, 6), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, r->device), 32);
			tp_put_head(b, 0, r->c), tp_put_head(b, 0, r->len), tp_put_head(b, 0, (uint64_t)r->gone | r->born << 1 | r->back << 2);
			save_org(b, c, r->left), save_org(b, c, r->right);
		}
		tp_put_head(b, 4, l->nreg);
		for (size_t j = 0; j < l->nreg; j++) {
			const reg *g = &l->regs[j];
			tp_put_head(b, 4, 7), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, g->device), 32);
			tp_put_head(b, 0, g->born), tp_put_head(b, 0, g->lo), tp_put_head(b, 0, g->len), save_link(b, c, g->el);
			tp_put_head(b, 4, 4), tp_put_head(b, 0, g->st.lamport);
			tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, g->st.device), 32);
			tp_put_head(b, 0, g->st.n), tp_put_head(b, 0, g->st.i);
		}
		tp_put_head(b, 4, l->norg);
		for (size_t j = 0; j < l->norg; j++) {
			const orgent *g = &l->orgs[j];
			tp_put_head(b, 4, 4), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, g->device), 32);
			tp_put_head(b, 0, g->c), tp_put_head(b, 0, g->len), save_link(b, c, g->org);
		}
	}
	tp_put_head(b, 4, st->nslots);
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		el_id e;
		el_ref at = sl_at(s);
		tp_put_head(b, 4, 6), save_node(b, c, sl_parent(s), s->parentn);
		if (sl_el(s, &e)) {
			tp_put_head(b, 4, 4), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, e.device), 32);
			tp_put_head(b, 0, e.born), tp_put_head(b, 0, e.c), tp_put_head(b, 0, e.k);
		} else if (s->slotn) tp_put(b, sl_slot(s), s->slotn);
		else tp_put(b, "\xf6", 1);
		save_node(b, c, sl_id(s), sl_idn(s));
		tp_put_head(b, 0, (uint64_t)sl_holds(s) | (uint64_t)sl_ghost(s) << 1 | (uint64_t)sl_trash(s) << 2);
		save_ref(b, c, &at, 0);
		if (s->value && c->put_value) {
			tp_buf vb = {NULL, 0, 0, (size_t)-1, b->mem, 0};
			if (c->put_value(c->self, &vb, s->value) || tp_buf_why(&vb)) tp_put(b, "\xf6", 1);
			else tp_put_head(b, 2, vb.len), tp_put(b, vb.p, vb.len);
			tp_buf_free(&vb);
		} else tp_put(b, "\xf6", 1);
	}
	tp_put_head(b, 4, st->nlanded);
	for (size_t i = 0; i < st->nlanded; i++) {
		tp_put_head(b, 4, 2), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, st->landed[i].device), 32);
		tp_put_head(b, 0, st->landed[i].n);
	}
	tp_put(b, "\xf6", 1);
	tp_put_head(b, 4, st->nbins);
	for (size_t i = 0; i < st->nbins; i++) {
		const el_bin *g = st->bins[i];
		tp_put_head(b, 4, 4), save_node(b, c, g->list, g->listn);
		tp_put_head(b, 4, 4), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, g->id.device), 32);
		tp_put_head(b, 0, g->id.born), tp_put_head(b, 0, g->id.c), tp_put_head(b, 0, g->id.k);
		tp_put_head(b, 0, g->n), tp_put_head(b, 4, g->n);
		for (uint64_t x = 0; x < g->n; x++) {
			if (g->values[x] && c->put_value) {
				tp_buf vb = {NULL, 0, 0, (size_t)-1, b->mem, 0};
				if (c->put_value(c->self, &vb, g->values[x]) || tp_buf_why(&vb)) tp_put(b, "\xf6", 1);
				else tp_put_head(b, 2, vb.len), tp_put(b, vb.p, vb.len);
				tp_buf_free(&vb);
			} else tp_put(b, "\xf6", 1);
		}
	}
}

static int load_ref(const el_ctx *c, tp_in *in, el_ref *r, int maybe_none) {
	uint64_t k;
	tp_span key;
	if (maybe_none && tp_null(in)) return *r = (el_ref){0}, 0;
	if (tp_array(in, &k) || k != 4 || tp_whole(in, &r->lamport) || tp_bytes(in, 32, &key) || tp_whole(in, &r->n) ||
		tp_whole(in, &r->seq))
		return -1;
	long d = c->index(c->self, key.p);
	if (d < 0) return TP_NOMEM;
	r->device = (uint32_t)d;
	return 0;
}
static int load_link(const el_ctx *c, tp_in *in, olink *g) {
	uint64_t k, born, x;
	tp_span key;
	if (tp_null(in)) return *g = (olink){0}, 0;
	if (tp_array(in, &k) || k != 3 || tp_bytes(in, 32, &key) || tp_whole(in, &born) || born > 1 || tp_whole(in, &x))
		return -1;
	long i = c->index(c->self, key.p);
	if (i < 0) return TP_NOMEM;
	*g = (olink){(uint32_t)i, (uint32_t)born, 1, (uint32_t)x, (uint32_t)(x >> 32)};
	return 0;
}
static int load_org(const el_ctx *c, tp_in *in, org *g) {
	uint64_t k, born, x;
	tp_span key;
	if (tp_null(in)) return *g = (org){0, 0, 1, 0, 0}, 0;
	if (tp_array(in, &k) || k != 3 || tp_bytes(in, 0, &key) || tp_whole(in, &born) || born > 1 || tp_whole(in, &x))
		return -1;
	uint32_t d = ORG_NONE;
	if (key.n) {
		long i = key.n == 32 ? c->index(c->self, key.p) : -1;
		if (i < 0) return i == -1 && key.n != 32 ? -1 : TP_NOMEM;
		d = (uint32_t)i;
	}
	*g = (org){d, (uint32_t)born, 0, (uint32_t)x, (uint32_t)(x >> 32)};
	return 0;
}
// a node as saved: null (out empty), or [device, n, patch, rel…]
static int load_node(const el_ctx *c, tp_in *in, tp_buf *out) {
	uint64_t k, n, i;
	tp_span key;
	if (tp_null(in)) return 0;
	if (tp_array(in, &k) || k < 3 || tp_bytes(in, 32, &key) || tp_whole(in, &n) || tp_whole(in, &i)) return -1;
	long d = c->index(c->self, key.p);
	if (d < 0) return TP_NOMEM;
	node_make(out, (uint32_t)d, n, i);
	for (k -= 3; k; k--) {
		const uint8_t *from = in->p;
		tp_span item;
		int major = in->p < in->end ? *in->p >> 5 : -1;
		if (major != 0 && major != 3) return -1;
		if (tp_skip(in, &item)) return -1;
		tp_put(out, from, (size_t)(in->p - from));
	}
	return 0;
}
// st, empty, made from what el_save wrote
int el_load(const el_ctx *c, el_state *st, tp_span bytes) {
	const tp_mem *mem = c->mem;
	tp_in in = {bytes.p, bytes.p + bytes.n};
	uint64_t k, nl, ns = 0;
	int code = 0;
	*st = (el_state){0};
	if (tp_array(&in, &k) || (k != 4 && k != 5) || tp_array(&in, &nl)) return TP_NOTSTEP;
	uint64_t top = k;
	for (uint64_t i = 0; i < nl && !code; i++) {
		uint64_t nr, text;
		tp_buf nb = {NULL, 0, 0, (size_t)-1, mem, 0};
		el_list *l = tp_alloc(mem, sizeof *l);
		if (!l) return code = TP_NOMEM, el_state_free(mem, st), code;
		memset(l, 0, sizeof *l);
		l->mem = mem;
		if (lists_room(mem, st)) tp_free(mem, l, sizeof *l), code = TP_NOMEM;
		else st->lists[st->n++] = l;
		if (code) break;
		if (tp_array(&in, &k) || k != 5) code = TP_NOTSTEP;
		if (!code && (code = load_node(c, &in, &nb))) code = code < 0 ? TP_NOTSTEP : code;
		if (!code && (tp_buf_why(&nb) || nb.len < 3)) code = tp_buf_why(&nb) ? TP_NOMEM : TP_NOTSTEP;
		if (!code && (tp_whole(&in, &text) || text > 1)) code = TP_NOTSTEP;
		if (!code && tp_array(&in, &nr)) code = TP_NOTSTEP;
		// a run takes 40 bytes at least: no room is made for more than the bytes can hold
		if (!code && nr > (uint64_t)(in.end - in.p) / 40) code = TP_NOTSTEP;
		if (code) {
			tp_buf_free(&nb);
			break;
		}
		l->key = dup(mem, nb.p, nb.len), l->keyn = nb.len;
		l->room = (size_t)nr + 4, l->runs = tp_alloc(mem, l->room * sizeof *l->runs);
		if (!l->key || !l->runs) {
			tp_buf_free(&nb);
			code = TP_NOMEM;
			break;
		}
		{
			tp_in h = {nb.p, nb.p + nb.len};
			uint64_t d, nn;
			tp_whole(&h, &d), tp_whole(&h, &nn);
			l->by.device = (uint32_t)d, l->by.n = nn;
		}
		l->text = (int)text;
		tp_buf_free(&nb);
		for (uint64_t j = 0; j < nr && !code; j++) {
			run *r = &l->runs[l->n];
			uint64_t flags, len;
			tp_span dev;
			*r = (run){0};
			if (tp_array(&in, &k) || k != 6 || tp_bytes(&in, 32, &dev) || tp_whole(&in, &r->c) || tp_whole(&in, &len) ||
				tp_whole(&in, &flags) || len < 1 || len > MOST || flags > 7) {
				code = TP_NOTSTEP;
				break;
			}
			long d = c->index(c->self, dev.p);
			if (d < 0) code = TP_NOMEM;
			else if ((code = load_org(c, &in, &r->left)) || (code = load_org(c, &in, &r->right))) code = code < 0 && code != TP_NOMEM ? TP_NOTSTEP : code;
			if (code) break;
			r->device = (uint32_t)d, r->len = (uint32_t)len;
			r->gone = flags & 1, r->born = (flags >> 1) & 1, r->back = (flags >> 2) & 1;
			if (!r->gone) l->count += len;
			l->n++;
		}
		uint64_t ng = 0;
		if (!code && (tp_array(&in, &ng) || ng > (uint64_t)(in.end - in.p) / 8)) code = TP_NOTSTEP;
		if (!code && ng) {
			l->roomreg = (size_t)ng;
			if (!(l->regs = tp_alloc(mem, l->roomreg * sizeof *l->regs))) code = TP_NOMEM;
		}
		for (uint64_t j = 0; j < ng && !code; j++) {
			reg *g = &l->regs[l->nreg];
			uint64_t born, lo, len, sk;
			tp_span dev, sdev;
			*g = (reg){0};
			if (tp_array(&in, &k) || k != 7 || tp_bytes(&in, 32, &dev) || tp_whole(&in, &born) || born > 1 ||
				tp_whole(&in, &lo) || tp_whole(&in, &len) || len < 1 || len > UINT32_MAX) {
				code = TP_NOTSTEP;
				break;
			}
			long d = c->index(c->self, dev.p);
			if (d < 0) code = TP_NOMEM;
			else if ((code = load_link(c, &in, &g->el))) code = code < 0 && code != TP_NOMEM ? TP_NOTSTEP : code;
			if (code) break;
			if (tp_array(&in, &sk) || sk != 4 || tp_whole(&in, &g->st.lamport) || tp_bytes(&in, 32, &sdev) ||
				tp_whole(&in, &g->st.n) || tp_whole(&in, &sk)) {
				code = TP_NOTSTEP;
				break;
			}
			long sd = c->index(c->self, sdev.p);
			if (sd < 0) {
				code = TP_NOMEM;
				break;
			}
			g->device = (uint32_t)d, g->born = (uint32_t)born, g->lo = lo, g->len = (uint32_t)len;
			g->st.device = (uint32_t)sd, g->st.i = (uint32_t)sk;
			l->nreg++;
		}
		uint64_t no = 0;
		if (!code && (tp_array(&in, &no) || no > (uint64_t)(in.end - in.p) / 8)) code = TP_NOTSTEP;
		if (!code && no) {
			l->roomorg = (size_t)no;
			if (!(l->orgs = tp_alloc(mem, l->roomorg * sizeof *l->orgs))) code = TP_NOMEM;
		}
		for (uint64_t j = 0; j < no && !code; j++) {
			orgent *g = &l->orgs[l->norg];
			tp_span dev;
			uint64_t len;
			*g = (orgent){0};
			if (tp_array(&in, &k) || k != 4 || tp_bytes(&in, 32, &dev) || tp_whole(&in, &g->c) || tp_whole(&in, &len) ||
				len < 1 || len > UINT32_MAX) {
				code = TP_NOTSTEP;
				break;
			}
			long d = c->index(c->self, dev.p);
			if (d < 0) code = TP_NOMEM;
			else if ((code = load_link(c, &in, &g->org)) || !g->org.set) code = code < 0 && code != TP_NOMEM ? TP_NOTSTEP : code ? code : TP_NOTSTEP;
			if (code) break;
			g->device = (uint32_t)d, g->len = (uint32_t)len;
			l->norg++;
		}
	}
	if (!code && tp_array(&in, &ns)) code = TP_NOTSTEP;
	for (uint64_t i = 0; i < ns && !code; i++) {
		tp_buf pb = {NULL, 0, 0, (size_t)-1, mem, 0}, sb = pb, nb = pb;
		el_slot s = {0};
		tp_span key, held = {NULL, 0};
		uint64_t b, cc, kk, flags;
		if (tp_array(&in, &k) || k != 6) code = TP_NOTSTEP;
		if (!code && (code = load_node(c, &in, &pb))) code = code < 0 ? TP_NOTSTEP : code;
		if (!code && tp_null(&in)) {
			// the root: no slot
		} else if (!code && in.p < in.end && *in.p >> 5 == 4) {
			// an element
			tp_span dev;
			if (tp_array(&in, &k) || k != 4 || tp_bytes(&in, 32, &dev) || tp_whole(&in, &b) || b > 1 || tp_whole(&in, &cc) ||
				tp_whole(&in, &kk))
				code = TP_NOTSTEP;
			else {
				long d = c->index(c->self, dev.p);
				if (d < 0) code = TP_NOMEM;
				else {
					el_id e = {(uint32_t)d, (uint32_t)b, cc, kk};
					slot_el(&sb, &e);
				}
			}
		} else if (!code) {
			if (tp_text(&in, &key)) code = TP_NOTSTEP;
			else tp_put_head(&sb, 3, key.n), tp_put(&sb, key.p, key.n);
		}
		if (!code && (code = load_node(c, &in, &nb))) code = code < 0 ? TP_NOTSTEP : code;
		if (!code && (nb.len < 3 || tp_whole(&in, &flags) || flags > 7)) code = TP_NOTSTEP;
		el_ref at = {0};
		if (!code && (code = load_ref(c, &in, &at, 0))) code = code < 0 ? TP_NOTSTEP : code;
		if (!code && !tp_null(&in) && (tp_bytes(&in, 0, &held) || !held.n)) code = TP_NOTSTEP;
		if (!code && (tp_buf_why(&pb) || tp_buf_why(&sb) || tp_buf_why(&nb))) code = TP_NOMEM;
		if (!code && slots_room(mem, st)) code = TP_NOMEM;
		if (!code && held.n && (!c->get_value || !(s.value = c->get_value(c->self, held)))) code = TP_NOTSTEP;
		if (!code) {
			size_t total = pb.len + sb.len + nb.len;
			s.buf = tp_alloc(mem, total);
			if (!s.buf) code = TP_NOMEM;
			else {
				if (pb.len) memcpy(s.buf, pb.p, pb.len);
				if (sb.len) memcpy(s.buf + pb.len, sb.p, sb.len);
				memcpy(s.buf + pb.len + sb.len, nb.p, nb.len);
				s.parentn = (uint32_t)pb.len, s.slotn = (uint32_t)sb.len;
				s.idn = (uint32_t)nb.len | ((flags & 1) ? EL_CELL_NODE : 0) | ((flags & 2) ? EL_CELL_GHOST : 0) | ((flags & 4) ? EL_CELL_TRASH : 0);
				s.lamport = at.lamport, s.device = at.device;
				st->slots[st->nslots++] = s;
			}
		}
		if (code && s.value) op_free(s.value);
		tp_buf_free(&pb), tp_buf_free(&sb), tp_buf_free(&nb);
	}
	if (!code && tp_array(&in, &ns)) code = TP_NOTSTEP;
	for (uint64_t i = 0; i < ns && !code; i++) {
		tp_span dev;
		uint64_t n;
		if (tp_array(&in, &k) || k != 2 || tp_bytes(&in, 32, &dev) || tp_whole(&in, &n)) code = TP_NOTSTEP;
		else {
			long d = c->index(c->self, dev.p);
			if (d < 0) code = TP_NOMEM;
			else if (st->nlanded == st->roomlanded) {
				size_t room = st->roomlanded ? 2 * st->roomlanded : 4;
				void *p = tp_grow(mem, st->landed, st->roomlanded * sizeof *st->landed, room * sizeof *st->landed);
				if (!p) code = TP_NOMEM;
				else st->landed = p, st->roomlanded = room;
			}
			if (!code) st->landed[st->nlanded].device = (uint32_t)d, st->landed[st->nlanded++].n = n;
		}
	}
	if (!code && !tp_null(&in)) code = TP_NOTSTEP;
	uint64_t nb = 0;
	if (!code && top == 5 && tp_array(&in, &nb)) code = TP_NOTSTEP;
	for (uint64_t i = 0; i < nb && !code; i++) {
		tp_buf lb = {NULL, 0, 0, (size_t)-1, mem, 0};
		tp_span dev;
		uint64_t born = 0, ec = 0, ek = 0, bn = 0, cnt = 0;
		el_bin *g = NULL;
		if (tp_array(&in, &k) || k != 4) code = TP_NOTSTEP;
		if (!code && (code = load_node(c, &in, &lb))) code = code < 0 ? TP_NOTSTEP : code;
		if (!code && (tp_array(&in, &k) || k != 4 || tp_bytes(&in, 32, &dev) || tp_whole(&in, &born) || born > 1 ||
			tp_whole(&in, &ec) || tp_whole(&in, &ek) || tp_whole(&in, &bn) || tp_array(&in, &cnt) || cnt != bn || bn < 1 || bn > MOST))
			code = TP_NOTSTEP;
		if (!code && (tp_buf_why(&lb) || !(g = tp_alloc(mem, sizeof *g)))) code = TP_NOMEM;
		if (!code) {
			memset(g, 0, sizeof *g);
			long d = c->index(c->self, dev.p);
			g->list = dup(mem, lb.p, lb.len), g->listn = lb.len;
			g->values = tp_alloc(mem, bn * sizeof *g->values);
			if (d < 0 || (lb.len && !g->list) || !g->values) code = TP_NOMEM;
			else {
				memset(g->values, 0, bn * sizeof *g->values);
				g->id = (el_id){(uint32_t)d, (uint32_t)born, ec, ek}, g->n = bn;
			}
			if (!code && more(mem, (void **)&st->bins, st->nbins, &st->roombins, sizeof *st->bins)) code = TP_NOMEM;
			if (!code) st->bins[st->nbins++] = g;
			else {
				tp_free(mem, g->list, g->listn);
				tp_free(mem, g->values, bn * sizeof *g->values);
				tp_free(mem, g, sizeof *g);
				g = NULL;
			}
		}
		for (uint64_t x = 0; x < bn && !code; x++) {
			tp_span held;
			if (tp_null(&in)) continue;
			if (tp_bytes(&in, 0, &held) || !held.n || !c->get_value || !(g->values[x] = c->get_value(c->self, held))) code = TP_NOTSTEP;
		}
		tp_buf_free(&lb);
	}
	if (!code && in.p != in.end) code = TP_NOTSTEP;
	if (code) el_state_free(mem, st);
	return code;
}
