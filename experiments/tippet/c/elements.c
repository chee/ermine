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

enum { MADE, SPLICE, SLOT, DROP };

// a run's most elements
#define MOST ((1u << 29) - 1)

// an element as a run holds it: made, its device and seq; born, its place (its step the list's); none,
// the start or the end. device EL_NONE as ORG_NONE
#define ORG_NONE ((1u << 30) - 1)
typedef struct {
	uint32_t device : 30, born : 1, none : 1;
	uint32_t lo, hi;
} org;

// made: numbered c on (back: c down); born (there
// since the list's step): places c on. left: what the first goes after (back: each), right: what each
// goes before (back: the last); none the start, the end
typedef struct {
	uint64_t c;
	uint32_t device;
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
	struct {
		uint32_t device;
		uint64_t n;
	} by; // the step that made the container: its born ones are since
	int text; // a string
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
// after (or before) the one before
static void join(el_list *l, size_t j) {
	if (j == 0 || j >= l->n) return;
	run a = l->runs[j - 1], b = l->runs[j];
	if (a.device != b.device || a.born != b.born || a.gone != b.gone || (uint64_t)a.len + b.len > MOST) return;
	el_id last = id_at(l, &a, a.len - 1), first = id_at(l, &b, 0);
	int on = (a.len == 1 || !a.back) && (b.len == 1 || !b.back) && a.c + a.len == b.c &&
		org_is(b.left, org_of(&last)) && org_is(a.right, b.right);
	int down = !on && !a.born && (a.len == 1 || a.back) && (b.len == 1 || b.back) && a.c >= a.len &&
		a.c - a.len == b.c && org_is(a.right, org_of(&first)) && org_is(a.left, b.left);
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
static const op_value *at_path(const op_value *v, const op_target *t) { return at_keys(v, t->path, t->length); }

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
	// the patch of the step in hand: its index; the block its path is in
	uint64_t i;
	long last;
	block *blocks;
	size_t nblocks, roomblocks;
} work;

static int devcmp(const el_ctx *c, uint32_t x, uint32_t y) {
	if (x == y) return 0;
	if (x == EL_NONE) return -1;
	if (y == EL_NONE) return 1;
	return memcmp(c->bytes(c->self, x), c->bytes(c->self, y), 32);
}
// a step after this one
static int newer_ref(const el_ctx *c, const el_ref *a, const el_ref *b) {
	if (a->lamport != b->lamport) return a->lamport > b->lamport;
	return devcmp(c, a->device, b->device) > 0;
}
static int newer(const work *w, const el_ref *a) { return newer_ref(w->c, a, &w->ref); }

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
	size_t room = st->roomslots ? 2 * st->roomslots : 4;
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
static void slot_free(const tp_mem *mem, el_slot *s) { tp_free(mem, s->buf, (size_t)s->parentn + s->slotn + s->noden); }
static const uint8_t *sl_parent(const el_slot *s) { return s->buf; }
static const uint8_t *sl_slot(const el_slot *s) { return s->buf + s->parentn; }
static const uint8_t *sl_node(const el_slot *s) { return s->buf + s->parentn + s->slotn; }
static tp_span sl_nodespan(const el_slot *s) { return (tp_span){sl_node(s), s->noden}; }
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

// the record at (parent, slot), or -1
static long slot_at(const el_state *st, tp_span parent, tp_span slot) {
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		if (s->parentn == parent.n && s->slotn == slot.n && (!parent.n || !memcmp(sl_parent(s), parent.p, parent.n)) &&
			(!slot.n || !memcmp(sl_slot(s), slot.p, slot.n)))
			return (long)i;
	}
	return -1;
}
// the record that holds node, or -1
static long slot_of(const el_state *st, tp_span node) {
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		if (s->noden == node.n && node.n && !memcmp(sl_node(s), node.p, node.n)) return (long)i;
	}
	return -1;
}
// is the key under the node
static int under(const uint8_t *key, size_t keyn, tp_span node) {
	return keyn >= node.n && !memcmp(key, node.p, node.n);
}

// the record at (parent, slot) put by this step, node its container (none: node.n 0), el its element;
// the record it replaces noted for undo
static int set_rec(work *w, tp_span parent, tp_span slot, tp_span node) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	long i = slot_at(st, parent, slot);
	if (rec_room(w) || (i < 0 && slots_room(mem, st))) return TP_NOMEM;
	el_slot n = {0};
	size_t total = parent.n + slot.n + node.n;
	n.buf = total ? tp_alloc(mem, total) : NULL;
	if (total && !n.buf) return TP_NOMEM;
	if (parent.n) memcpy(n.buf, parent.p, parent.n);
	if (slot.n) memcpy(n.buf + parent.n, slot.p, slot.n);
	if (node.n) memcpy(n.buf + parent.n + slot.n, node.p, node.n);
	n.parentn = (uint32_t)parent.n, n.slotn = (uint32_t)slot.n, n.noden = (uint32_t)node.n;
	n.lamport = w->ref.lamport, n.device = w->ref.device;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = SLOT};
	r->slot.added = n, r->slot.has_added = 1;
	if (i >= 0) r->slot.had = 1, r->slot.was = st->slots[i], st->slots[i] = n;
	else st->slots[st->nslots++] = n;
	return 0;
}
// the record i taken out, noted for undo
static int del_rec(work *w, size_t i) {
	el_state *st = w->st;
	if (rec_room(w)) return TP_NOMEM;
	el_rec *r = &w->back->p[w->back->n++];
	*r = (el_rec){.kind = SLOT};
	r->slot.had = 1, r->slot.was = st->slots[i];
	st->slots[i] = st->slots[--st->nslots];
	return 0;
}

// a node gone, with its sequences and records, and what they hold, in turn. leaf: a string, which holds none
static int drop_node(work *w, tp_span node, int leaf) {
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
	if (leaf) {
		for (size_t i = 0; i < nl; i++) {
			if (st->lists[i]->keyn == node.n && !memcmp(st->lists[i]->key, node.p, node.n)) ml[i] = 1;
		}
	} else {
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
				if (!st->slots[i].noden) continue;
				if (more(mem, (void **)&todo, nt, &rt, sizeof *todo)) {
					code = TP_NOMEM;
					goto done;
				}
				todo[nt++] = sl_nodespan(&st->slots[i]);
			}
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

// the items of the array node taken away by a splice are gone, with what is under them
static int away(work *w, tp_span node, el_list *l, const el_gone *taken, size_t ntaken) {
	el_state *st = w->st;
	for (size_t i = 0; i < st->nslots;) {
		el_slot *s = &st->slots[i];
		size_t j;
		uint64_t o;
		el_id e;
		if (s->parentn != node.n || memcmp(sl_parent(s), node.p, node.n) || !s->noden || !sl_el(s, &e) ||
			!find(l, &e, &j, &o) || !l->runs[j].gone) {
			i++;
			continue;
		}
		// the record goes first: dropping packs the records
		tp_span held = sl_nodespan(s);
		int code = del_rec(w, i);
		if (!code) code = drop_node(w, held, 0);
		if (code) return code;
	}
	// the items born with the array have no record: what is under them goes by their place
	for (size_t r = 0; r < ntaken; r++) {
		for (uint64_t x = 0; x < taken[r].count; x++) {
			el_id e = plus(taken[r].id, x);
			if (!e.born) continue;
			tp_buf cb = {NULL, 0, 0, (size_t)-1, w->c->mem, 0};
			tp_put(&cb, node.p, node.n), rel_num(&cb, e.k);
			int code = tp_buf_why(&cb) ? TP_NOMEM : drop_node(w, (tp_span){cb.p, cb.len}, 0);
			tp_buf_free(&cb);
			if (code) return code;
		}
	}
	return 0;
}

// late: a step after this one spliced or put inside the node, or what a put inside it holds
static int touched(work *w, tp_span node) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	tp_span *todo = NULL;
	size_t nt = 0, rt = 0;
	int hit = 0, bad = 0;
	if (more(mem, (void **)&todo, nt, &rt, sizeof *todo)) return -1;
	todo[nt++] = node;
	while (nt && !hit && !bad) {
		tp_span x = todo[--nt];
		for (size_t i = 0; i < st->n && !hit; i++) {
			if (under(st->lists[i]->key, st->lists[i]->keyn, x) && newer(w, &st->lists[i]->last)) hit = 1;
		}
		for (size_t i = 0; i < st->nslots && !hit && !bad; i++) {
			el_ref at = sl_at(&st->slots[i]);
			if (!under(sl_parent(&st->slots[i]), st->slots[i].parentn, x)) continue;
			if (newer(w, &at)) hit = 1;
			else if (st->slots[i].noden) {
				if (more(mem, (void **)&todo, nt, &rt, sizeof *todo)) bad = 1;
				else todo[nt++] = sl_nodespan(&st->slots[i]);
			}
		}
	}
	tp_free(mem, todo, rt * sizeof *todo);
	return bad ? -1 : hit;
}

// a patch puts at a slot (a key of a map, an element of an array, the root: parent empty): old is
// what was there, derived the node it was if no record says (made with its parent's value), node
// the node now (none: n 0). what was there goes, with what is under it; late: a newer step put there
static int assign(work *w, tp_span parent, tp_span slot, tp_span derived, const op_value *old, tp_span node) {
	long i = slot_at(w->st, parent, slot);
	el_ref at = i >= 0 ? sl_at(&w->st->slots[i]) : (el_ref){0};
	if (w->late && i >= 0 && newer(w, &at)) return TP_LATE;
	tp_span gone = i >= 0 ? sl_nodespan(&w->st->slots[i]) : derived;
	int code = 0;
	if (w->late && gone.n) {
		int t = touched(w, gone);
		if (t) return t < 0 ? TP_NOMEM : TP_LATE;
	}
	if (gone.n) code = drop_node(w, gone, old && old->type == OP_STR);
	return code ? code : set_rec(w, parent, slot, node);
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
		tp_span ck = {held.p, at};
		if (major == 3) {
			if (tp_text(&in, &key)) return OP_RANGE;
			tp_put(&slot, from, (size_t)(in.p - from));
			if (slot_at(st, ck, (tp_span){slot.p, slot.len}) >= 0) *ok = 0;
			h.s = key;
		} else {
			if (tp_whole(&in, &x)) return OP_RANGE;
			uint32_t dev;
			uint64_t n;
			if (node_head(ck, &dev, &n)) return OP_RANGE;
			el_id e = {dev, 1, n, x};
			slot_el(&slot, &e);
			if (slot_at(st, ck, (tp_span){slot.p, slot.len}) >= 0) *ok = 0;
			el_list *l = list_at(st, ck);
			size_t j;
			uint64_t o;
			h.num = 1;
			if (l && *ok) {
				if (!find(l, &e, &j, &o) || l->runs[j].gone) *ok = 0;
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
// held, replaced, or gone
static int where(work *w, tp_span node, hops *out, int *ok) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	tp_span cur = node;
	*ok = 1;
	for (;;) {
		// the node some record holds that cur is, or is made inside: longest first
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
			si = slot_of(st, (tp_span){cur.p, end});
			if (si >= 0) break;
		}
		if (si < 0) return *ok = 0, 0;
		tp_span held = {cur.p, end}, tail = {cur.p + end, cur.n - end};
		const el_slot *rec = &st->slots[si];
		int good;
		int code = inside(w, held, tail, out, &good);
		if (code || !good) return code ? code : (*ok = 0, 0);
		if (!rec->parentn) break;
		hop h = {0};
		el_id e;
		if (sl_el(rec, &e)) {
			el_list *l = list_at(st, (tp_span){sl_parent(rec), rec->parentn});
			size_t j;
			uint64_t o;
			if (!l || !find(l, &e, &j, &o) || l->runs[j].gone) return *ok = 0, 0;
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

// a splice into the sequence node (v its value, p->place.path where it is now), patch w->i of its
// step, its inserted ones counted from c, by its ids (anchor) or its range, as the patches to apply
// by position (*qs, *nq)
static int splice(work *w, const op_patch *p, tp_span node, const op_value *v, uint64_t c,
	const el_anchor *anchor, op_patch **qs, size_t *nq, size_t *qcap, el_anchor *named) {
	const tp_mem *mem = w->c->mem;
	// an insert of another kind than the sequence (a list into a text): doesn't apply, as apply refuses
	if (p->has_value && (!p->value || p->value->type != v->type)) return OP_WRONG_KIND;
	el_list *l;
	int code = elements(w, node, v, &l);
	if (code) return code;
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
	if (!l->text && REC.ntaken && (code = away(w, node, l, REC.taken, REC.ntaken))) goto done;
	// where the inserted go: right after its element; by ids, past those put there meanwhile
	pos lp = {0, 0}, rp = {0, 0}, spot = {0, 0};
	el_id left = has_first ? first : NOWHERE;
	int same_before = 0;
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
		run made = {.c = c, .device = w->ref.device, .len = (uint32_t)m,
			.left = org_of(&left), .right = org_of(&right)};
		edit(l, j, 0, &made, 1);
		l->count += (size_t)m;
		join(l, j + 1), join(l, j);
		REC.device = w->ref.device, REC.c = c, REC.m = (uint64_t)m;
		// the items it inserts that are containers are nodes, each put at its element
		if (p->value->type == OP_LIST) {
			for (long x = 0; x < m && !code; x++) {
				if (!is_container(p->value->items[x])) continue;
				tp_buf nb = {NULL, 0, 0, (size_t)-1, mem, 0}, sb = {NULL, 0, 0, (size_t)-1, mem, 0};
				el_id e = {w->ref.device, 0, c + (uint64_t)x, 0};
				node_make(&nb, w->ref.device, w->ref.n, w->i), rel_num(&nb, (uint64_t)x), slot_el(&sb, &e);
				code = tp_buf_why(&nb) || tp_buf_why(&sb) ? TP_NOMEM
					: set_rec(w, node, (tp_span){sb.p, sb.len}, (tp_span){nb.p, nb.len});
				tp_buf_free(&nb), tp_buf_free(&sb);
			}
			if (code) goto done;
		}
	}
	if (m > 0 || !nout) {
		out[nout] = (op_patch){0};
		out[nout].place = p->place;
		out[nout].place.from = out[nout].place.to = (int64_t)to;
		if (m > 0) out[nout].has_value = 1, out[nout].value = p->value;
		nout++;
	}
#undef REC
	if (!anchor && named) {
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
	*qs = out, *nq = nout, *qcap = qroom, out = NULL;
done:
	tp_free(mem, gone, roomgone * sizeof *gone), tp_free(mem, out, qroom * sizeof *out);
	return code;
}


// the node at the first len keys of the path, found by place in value (a write here, a move), its
// arrays' elements made as it goes; *found 0 when a scalar or nothing is there. its bytes in out
static int node_at(work *w, const op_value *value, const op_key *path, size_t len, tp_buf *out, int *found) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	*found = 0;
	long ri = slot_at(st, (tp_span){NULL, 0}, (tp_span){NULL, 0});
	if (ri < 0 || !st->slots[ri].noden) return 0;
	out->len = 0;
	tp_put(out, sl_node(&st->slots[ri]), st->slots[ri].noden);
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
			el_id e = id_at(l, &l->runs[j], o);
			slot_el(&slot, &e);
			si = tp_buf_why(&slot) ? -2 : slot_at(st, (tp_span){out->p, out->len}, (tp_span){slot.p, slot.len});
			if (si == -2) return tp_buf_free(&slot), TP_NOMEM;
			if (si >= 0) {
				if (!st->slots[si].noden) return tp_buf_free(&slot), 0;
				out->len = 0, tp_put(out, sl_node(&st->slots[si]), st->slots[si].noden);
			} else if (e.born) rel_num(out, e.k);
			else return tp_buf_free(&slot), 0;
			v = v->items[k->n];
		} else {
			if (!is_map(v)) return 0;
			slot_key(&slot, k->s);
			si = tp_buf_why(&slot) ? -2 : slot_at(st, (tp_span){out->p, out->len}, (tp_span){slot.p, slot.len});
			if (si == -2) return tp_buf_free(&slot), TP_NOMEM;
			const op_value *c = op_get(v, k->s);
			if (si >= 0) {
				if (!st->slots[si].noden) return tp_buf_free(&slot), 0;
				out->len = 0, tp_put(out, sl_node(&st->slots[si]), st->slots[si].noden);
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

static void drop_qs(const tp_mem *mem, op_patch *qs, size_t cap) { tp_free(mem, qs, cap * sizeof *qs); }

// a patch but a move, its container found by its id (given) or by place (named non-NULL: a write
// here, and named): a splice, a removal at an index of an array (a splice of that one), a put at an
// index, a put at a key, or of the whole value. *qs (made) the patches to apply, their path in
// w->last (a block, if made)
static int patch(work *w, const op_value *cur, const op_patch *p, uint64_t c, const el_anchor *given,
	el_anchor *named, op_patch **qs, size_t *nq, size_t *qcap) {
	const tp_mem *mem = w->c->mem;
	int reading = !named, code = 0, has_value = p->has_value && p->value;
	size_t len = p->place.length;
	int spliced = p->place.has_range;
	const op_key *last = len ? &p->place.path[len - 1] : NULL;
	int index = !spliced && len && last->type == OP_NUM_KEY;
	tp_buf cn = {NULL, 0, 0, (size_t)-1, mem, 0}, nb = {NULL, 0, 0, (size_t)-1, mem, 0},
	       sb = {NULL, 0, 0, (size_t)-1, mem, 0};
	hops hp = {0};
	op_key *keys = NULL;
	size_t nup = 0;
	tp_span node = {0}, made = {0}, none = {0};
	w->last = -1;
	if (reading && !given) return OP_NOT_A_PATCH;
	if (has_value && is_container(p->value)) node_make(&nb, w->ref.device, w->ref.n, w->i), made = (tp_span){nb.p, nb.len};
	if (!spliced && !len) {
		// the whole value
		long ri = slot_at(w->st, none, none);
		if (named) {
			named->kind = 1;
			if (ri >= 0 && w->st->slots[ri].noden) {
				named->node = dup(mem, sl_node(&w->st->slots[ri]), w->st->slots[ri].noden), named->noden = w->st->slots[ri].noden;
				if (!named->node) code = TP_NOMEM;
			}
		}
		if (!code) code = assign(w, none, none, none, cur, made);
		if (!code && !(*qs = tp_alloc(mem, sizeof **qs))) code = TP_NOMEM;
		if (!code) **qs = *p, *nq = 1, *qcap = 1;
		goto done;
	}
	size_t nlen = spliced ? len : len - 1;
	if (reading) {
		int ok;
		if (!given->noden) code = w->late ? TP_LATE : OP_RANGE;
		else if (!(code = where(w, (tp_span){given->node, given->noden}, &hp, &ok)) && !ok) code = w->late ? TP_LATE : OP_RANGE;
		if (code) goto done;
		node = (tp_span){given->node, given->noden};
		if ((code = block_make(w, &hp, 1, &keys))) goto done;
		w->last = (long)w->nblocks - 1;
		nup = hp.n;
	} else {
		int found;
		if ((code = node_at(w, cur, p->place.path, nlen, &cn, &found))) goto done;
		if (!found) {
			code = w->late ? TP_LATE : OP_RANGE;
			goto done;
		}
		node = (tp_span){cn.p, cn.len}, keys = (op_key *)p->place.path, nup = nlen;
	}
	const op_value *v = at_keys(cur, keys, nup);
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
	if (!(*qs = tp_alloc(mem, sizeof **qs))) {
		code = TP_NOMEM;
		goto done;
	}
	*nq = 1, *qcap = 1;
	**qs = *p;
	(*qs)->place.path = keys;
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
					e = id_at(l, &l->runs[j], o), x = last->n;
				}
			} else if (given->kind != 2) code = OP_RANGE;
			else {
				size_t j;
				uint64_t o;
				e = given->element;
				if (!find(l, &e, &j, &o) || l->runs[j].gone) code = OP_RANGE;
				else x = (long)(live_before(l, j) + (size_t)o);
			}
		}
		if (!code) {
			tp_buf db = {NULL, 0, 0, (size_t)-1, mem, 0};
			slot_el(&sb, &e);
			if (e.born) db.len = 0, tp_put(&db, node.p, node.n), rel_num(&db, e.k);
			code = tp_buf_why(&sb) || tp_buf_why(&db) ? TP_NOMEM
				: assign(w, node, (tp_span){sb.p, sb.len}, e.born ? (tp_span){db.p, db.len} : none, v->items[x], made);
			tp_buf_free(&db);
			if (!code) {
				keys[nup] = (op_key){.type = OP_NUM_KEY, .n = x};
				(*qs)->place.length = nup + 1;
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
			code = tp_buf_why(&sb) || tp_buf_why(&db) ? TP_NOMEM
				: assign(w, node, (tp_span){sb.p, sb.len}, is_container(old) ? (tp_span){db.p, db.len} : none, old, made);
			tp_buf_free(&db);
			if (!code) {
				keys[nup] = *last;
				(*qs)->place.length = nup + 1;
				if (named) named->kind = 1;
			}
		}
	}
done:
	tp_buf_free(&cn), tp_buf_free(&nb), tp_buf_free(&sb);
	tp_free(mem, hp.p, hp.room * sizeof *hp.p);
	return code;
}

// a move, by place: what it moves is taken from where it was and put where it goes, as a new node
// there (a new element for a slot)
static int move(work *w, const op_value *cur, const op_patch *p, uint64_t c) {
	const tp_mem *mem = w->c->mem;
	const op_target *F = &p->move, *T = &p->place;
	int code = 0, found;
	op_value *moved = NULL, *rest = NULL, *wrap = NULL;
	tp_buf nb = {NULL, 0, 0, (size_t)-1, mem, 0}, sb = nb, db = nb, mb = nb;
	op_patch *qs = NULL;
	size_t nq = 0, qcap = 0;
	tp_span none = {0};
	if (!F->length) return OP_RANGE;
	const op_key *fk = &F->path[F->length - 1], *tk = T->length ? &T->path[T->length - 1] : NULL;
	const op_value *src = at_path(cur, F);
	if (F->has_range ? !is_seq(src) : !src) return OP_NO_KEY;
	if (F->has_range) {
		if (F->from > F->to) return OP_RANGE;
		if (src->type == OP_STR) {
			size_t x, y;
			if (!op_string_span(src, F->from, F->to, &x, &y)) return OP_RANGE;
			moved = op_str_n(src->str + x, y - x);
		} else {
			if ((size_t)F->to > src->count) return OP_RANGE;
			moved = op_list();
			for (int64_t i = F->from; i < F->to; i++) op_push(moved, op_ref(src->items[i]));
		}
	} else moved = op_ref((op_value *)src);
	// the source goes
	op_patch cut = {0};
	cut.place = *F;
	size_t failed;
	if ((code = op_apply(cur, &cut, 1, NULL, &rest, &failed))) goto done;
	if (F->has_range) {
		if ((code = node_at(w, cur, F->path, F->length, &nb, &found))) goto done;
		if (!found) {
			code = OP_NO_KEY;
			goto done;
		}
		code = splice(w, &cut, (tp_span){nb.p, nb.len}, src, c, NULL, &qs, &nq, &qcap, NULL);
		drop_qs(mem, qs, qcap), qs = NULL;
	} else {
		const op_value *up = at_keys(cur, F->path, F->length - 1);
		if ((code = node_at(w, cur, F->path, F->length - 1, &nb, &found))) goto done;
		if (!found) {
			code = OP_NO_KEY;
			goto done;
		}
		if (fk->type == OP_NUM_KEY) {
			if (!up || up->type != OP_LIST) code = OP_WRONG_KIND;
			else {
				op_patch one = {0};
				one.place = (op_target){F->path, F->length - 1, 1, fk->n, fk->n + 1};
				code = splice(w, &one, (tp_span){nb.p, nb.len}, up, c, NULL, &qs, &nq, &qcap, NULL);
				drop_qs(mem, qs, qcap), qs = NULL;
			}
		} else if (!is_map(up)) code = OP_WRONG_KIND;
		else {
			const op_value *old = op_get(up, fk->s);
			slot_key(&sb, fk->s);
			if (is_container(old)) tp_put(&db, nb.p, nb.len), rel_text(&db, fk->s);
			code = tp_buf_why(&sb) || tp_buf_why(&db) ? TP_NOMEM
				: assign(w, (tp_span){nb.p, nb.len}, (tp_span){sb.p, sb.len}, is_container(old) ? (tp_span){db.p, db.len} : none, old, none);
		}
	}
	if (code) goto done;
	// it lands where it goes
	tp_buf_free(&nb), tp_buf_free(&sb), tp_buf_free(&db);
	nb = (tp_buf){NULL, 0, 0, (size_t)-1, mem, 0}, sb = nb, db = nb;
	tp_span made = none;
	if (is_container(moved)) {
		node_make(&mb, w->ref.device, w->ref.n, w->i);
		if (tp_buf_why(&mb)) {
			code = TP_NOMEM;
			goto done;
		}
		made = (tp_span){mb.p, mb.len};
	}
	if (T->has_range) {
		const op_value *into = at_path(rest, T);
		if ((code = node_at(w, rest, T->path, T->length, &nb, &found))) goto done;
		if (!found || !is_seq(into)) {
			code = OP_WRONG_KIND;
			goto done;
		}
		op_value *value = moved;
		if (!F->has_range) {
			wrap = op_list();
			op_push(wrap, op_ref(moved));
			value = wrap;
		}
		op_patch q = {0};
		q.place = *T, q.has_value = 1, q.value = value;
		code = splice(w, &q, (tp_span){nb.p, nb.len}, into, c, NULL, &qs, &nq, &qcap, NULL);
		drop_qs(mem, qs, qcap), qs = NULL;
	} else if (!T->length) {
		code = assign(w, none, none, none, rest, made);
	} else {
		const op_value *up = at_keys(rest, T->path, T->length - 1);
		if ((code = node_at(w, rest, T->path, T->length - 1, &nb, &found))) goto done;
		if (!found) {
			code = OP_NO_KEY;
			goto done;
		}
		tp_span parent = {nb.p, nb.len};
		if (tk->type == OP_NUM_KEY) {
			el_list *l;
			if (!up || up->type != OP_LIST) code = OP_WRONG_KIND;
			else if (!(code = elements(w, parent, up, &l))) {
				if (tk->n < 0 || (size_t)tk->n >= l->count) code = OP_NO_KEY;
				else {
					uint64_t o;
					size_t j = live_at(l, (size_t)tk->n, &o);
					el_id e = id_at(l, &l->runs[j], o);
					slot_el(&sb, &e);
					if (e.born) tp_put(&db, parent.p, parent.n), rel_num(&db, e.k);
					tp_span derived = e.born ? (tp_span){db.p, db.len} : none;
					code = tp_buf_why(&sb) || tp_buf_why(&db) ? TP_NOMEM
						: assign(w, parent, (tp_span){sb.p, sb.len}, derived, up->items[tk->n], made);
				}
			}
		} else if (!is_map(up)) code = OP_WRONG_KIND;
		else {
			const op_value *old = op_get(up, tk->s);
			tp_buf eb = {NULL, 0, 0, (size_t)-1, mem, 0};
			slot_key(&sb, tk->s);
			if (is_container(old)) tp_put(&eb, parent.p, parent.n), rel_text(&eb, tk->s);
			code = tp_buf_why(&sb) || tp_buf_why(&eb) ? TP_NOMEM
				: assign(w, parent, (tp_span){sb.p, sb.len}, is_container(old) ? (tp_span){eb.p, eb.len} : none, old, made);
			tp_buf_free(&eb);
		}
	}
done:
	tp_buf_free(&nb), tp_buf_free(&sb), tp_buf_free(&db), tp_buf_free(&mb);
	drop_qs(mem, qs, qcap);
	if (moved) op_free(moved);
	if (rest) op_free(rest);
	if (wrap) op_free(wrap);
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
	} else if (r->kind == SLOT) {
		const el_slot *a = &r->slot.added;
		if (r->slot.has_added) {
			for (size_t i = 0; i < st->nslots; i++) {
				el_slot *s = &st->slots[i];
				if (s->buf != a->buf || s->parentn != a->parentn || s->slotn != a->slotn || s->noden != a->noden) continue;
				slot_free(mem, s);
				if (r->slot.had) *s = r->slot.was;
				else *s = st->slots[--st->nslots];
				break;
			}
		} else if (r->slot.had) st->slots[st->nslots++] = r->slot.was;
	} else {
		for (size_t i = 0; i < r->drop.nlists; i++) st->lists[st->n++] = r->drop.lists[i];
		for (size_t i = 0; i < r->drop.nslots; i++) st->slots[st->nslots++] = r->drop.slots[i];
		tp_free(mem, r->drop.lists, r->drop.nlists * sizeof *r->drop.lists);
		tp_free(mem, r->drop.slots, r->drop.nslots * sizeof *r->drop.slots);
	}
}

static void drop_rec(const tp_mem *mem, el_rec *r) {
	if (r->kind == SPLICE) tp_free(mem, r->splice.taken, r->splice.roomtaken * sizeof *r->splice.taken);
	else if (r->kind == SLOT) {
		if (r->slot.had) slot_free(mem, &r->slot.was);
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

int el_seed(const tp_mem *mem, el_state *st, const el_ref *ref) {
	tp_buf nb = {NULL, 0, 0, (size_t)-1, mem, 0};
	node_make(&nb, ref->device, ref->n, 0);
	el_slot s = {0};
	s.buf = dup(mem, nb.p, nb.len), s.noden = (uint32_t)nb.len, s.lamport = ref->lamport, s.device = ref->device;
	int bad = tp_buf_why(&nb) || !s.buf || slots_room(mem, st);
	tp_buf_free(&nb);
	if (bad) return tp_free(mem, s.buf, s.noden), TP_NOMEM;
	st->slots[st->nslots++] = s;
	return 0;
}

void el_state_free(const tp_mem *mem, el_state *st) {
	for (size_t i = 0; i < st->n; i++) list_free(mem, st->lists[i]);
	for (size_t i = 0; i < st->nslots; i++) slot_free(mem, &st->slots[i]);
	tp_free(mem, st->lists, st->room * sizeof *st->lists);
	tp_free(mem, st->slots, st->roomslots * sizeof *st->slots);
	*st = (el_state){0};
}

// undoes the records past marks (a step that failed)
static void rollback(work *w, size_t marks) {
	el_back *b = w->back;
	while (b->n > marks) undo_rec(w->c->mem, w->st, &b->p[--b->n]);
}

int el_step(const el_ctx *c, el_state *st, op_value **value, const el_ref *ref, tp_span patches,
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int late,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named) {
	work w = {.c = c, .st = st, .back = back, .ref = *ref, .late = late, .last = -1};
	size_t marks = back->n, at = 0, nout = 0, roomout = 0, nus = 0, roomus = 0;
	op_value *cur = *value;
	int owned = 0, code = 0;
	op_patch *out = NULL, *cat = NULL;
	long *outblk = NULL;
	op_undo *us = NULL;
	el_anchor *nm = NULL;
	size_t total = 0;
	uint64_t made = 0; // the step's elements so far: the next is its seq + made
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
		w.last = -1;
		if (p->has_move && late) code = TP_LATE;
		else if (p->has_move) code = move(&w, cur, p, counter);
		else {
			code = patch(&w, cur, p, counter, ids ? &ids[i] : NULL, nm ? &nm[i] : NULL, &made_qs, &nq, &qcap);
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
	if (named) *named = nm;
	return 0;
}

void el_anchors_free(const tp_mem *mem, el_anchor *a, size_t n) {
	if (!a) return;
	for (size_t i = 0; i < n; i++) {
		tp_free(mem, a[i].gone, a[i].ngone * sizeof *a[i].gone);
		tp_free(mem, a[i].node, a[i].noden);
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
		tp_span pred;
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
			if (tp_skip(&in, &pred)) code = TP_NOTSTEP;
			else if (two == 3 && read_id(c, &in, s, seq, (uint32_t)me, 0, &a[i].element)) code = TP_NOTSTEP;
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
		if (a[i].kind == 1) tp_put_head(b, 4, 0);
		else if (a[i].kind == 2) tp_put_head(b, 4, 0), write_id(b, c, &a[i].element, me, n, seq, 0);
		else {
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

// a state's sequences and records as cbor, for a snapshot (the value is the graph's): [lists, slots],
// a list [node, text, runs], a run [device, c, len, flags, left, right], an element's origin null or
// [device, born, number], a node [device, n, patch, rel…], a slot [parent or null, key or an
// element [device, born, c, k], node or null, a step's place [lamport, device, n, seq]]
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
static void save_node(tp_buf *b, const el_ctx *c, const uint8_t *node, size_t noden) {
	if (!noden) {
		tp_put(b, "\xf6", 1);
		return;
	}
	write_node(b, c, node, noden, UINT32_MAX);
}
void el_save(tp_buf *b, const el_ctx *c, const el_state *st) {
	tp_put_head(b, 4, 2), tp_put_head(b, 4, st->n);
	for (size_t i = 0; i < st->n; i++) {
		const el_list *l = st->lists[i];
		tp_put_head(b, 4, 4), save_node(b, c, l->key, l->keyn), tp_put_head(b, 0, (uint64_t)l->text);
		save_ref(b, c, &l->last, !l->last.lamport);
		tp_put_head(b, 4, l->n);
		for (size_t j = 0; j < l->n; j++) {
			const run *r = &l->runs[j];
			tp_put_head(b, 4, 6), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, r->device), 32);
			tp_put_head(b, 0, r->c), tp_put_head(b, 0, r->len), tp_put_head(b, 0, (uint64_t)r->gone | r->born << 1 | r->back << 2);
			save_org(b, c, r->left), save_org(b, c, r->right);
		}
	}
	tp_put_head(b, 4, st->nslots);
	for (size_t i = 0; i < st->nslots; i++) {
		const el_slot *s = &st->slots[i];
		el_id e;
		el_ref at = sl_at(s);
		tp_put_head(b, 4, 4), save_node(b, c, sl_parent(s), s->parentn);
		if (sl_el(s, &e)) {
			tp_put_head(b, 4, 4), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, e.device), 32);
			tp_put_head(b, 0, e.born), tp_put_head(b, 0, e.c), tp_put_head(b, 0, e.k);
		} else if (s->slotn) tp_put(b, sl_slot(s), s->slotn);
		else tp_put(b, "\xf6", 1);
		save_node(b, c, sl_node(s), s->noden);
		save_ref(b, c, &at, 0);
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
	if (tp_array(&in, &k) || k != 2 || tp_array(&in, &nl)) return TP_NOTSTEP;
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
		if (tp_array(&in, &k) || k != 4) code = TP_NOTSTEP;
		if (!code && (code = load_node(c, &in, &nb))) code = code < 0 ? TP_NOTSTEP : code;
		if (!code && (tp_buf_why(&nb) || nb.len < 3)) code = tp_buf_why(&nb) ? TP_NOMEM : TP_NOTSTEP;
		if (!code && (tp_whole(&in, &text) || text > 1)) code = TP_NOTSTEP;
		if (!code && (code = load_ref(c, &in, &l->last, 1))) code = code < 0 ? TP_NOTSTEP : code;
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
	}
	if (!code && tp_array(&in, &ns)) code = TP_NOTSTEP;
	for (uint64_t i = 0; i < ns && !code; i++) {
		tp_buf pb = {NULL, 0, 0, (size_t)-1, mem, 0}, sb = pb, nb = pb;
		el_slot s = {0};
		tp_span key;
		uint64_t b, cc, kk;
		if (tp_array(&in, &k) || k != 4) code = TP_NOTSTEP;
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
		el_ref at = {0};
		if (!code && (code = load_ref(c, &in, &at, 0))) code = code < 0 ? TP_NOTSTEP : code;
		if (!code && (tp_buf_why(&pb) || tp_buf_why(&sb) || tp_buf_why(&nb))) code = TP_NOMEM;
		if (!code && slots_room(mem, st)) code = TP_NOMEM;
		if (!code) {
			size_t total = pb.len + sb.len + nb.len;
			s.buf = total ? tp_alloc(mem, total) : NULL;
			if (total && !s.buf) code = TP_NOMEM;
			else {
				if (pb.len) memcpy(s.buf, pb.p, pb.len);
				if (sb.len) memcpy(s.buf + pb.len, sb.p, sb.len);
				if (nb.len) memcpy(s.buf + pb.len + sb.len, nb.p, nb.len);
				s.parentn = (uint32_t)pb.len, s.slotn = (uint32_t)sb.len, s.noden = (uint32_t)nb.len;
				s.lamport = at.lamport, s.device = at.device;
				st->slots[st->nslots++] = s;
			}
		}
		tp_buf_free(&pb), tp_buf_free(&sb), tp_buf_free(&nb);
	}
	if (!code && in.p != in.end) code = TP_NOTSTEP;
	if (code) el_state_free(mem, st);
	return code;
}
