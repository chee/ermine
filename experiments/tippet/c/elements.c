// Elements (see elements.h). A sequence is a list: its elements in order, an index by id, how many
// are not gone, and a cursor (j, and live: how many before items[j] are not gone) that typing and
// edits near the last move from, so they cost nothing.
#include "elements.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { MADE, SPLICE, PUT };

typedef struct {
	el_elem *p;
	size_t n;
} block;

struct el_list {
	uint8_t *key;
	size_t keyn;
	el_elem **items;
	size_t n, room;
	el_elem **table; // by id, open addressing, at most half full
	size_t slots;
	block *blocks;
	size_t nblocks, roomblocks;
	size_t count, j, live;
};

static size_t hash_of(uint32_t device, uint64_t n, uint64_t k) {
	uint64_t x = (n + 0x9e3779b97f4a7c15ull) * 0xbf58476d1ce4e5b9ull;
	x ^= (k + ((uint64_t)device << 32)) * 0x94d049bb133111ebull;
	return (size_t)(x ^ (x >> 31));
}
static size_t home(const el_list *l, const el_elem *e) {
	return hash_of(e->device, e->n, e->k) & (l->slots - 1);
}

static el_elem *find(const el_list *l, const el_id *id) {
	if (!l->slots) return NULL;
	for (size_t s = hash_of(id->device, id->n, id->k) & (l->slots - 1); l->table[s];
		s = (s + 1) & (l->slots - 1)) {
		el_elem *e = l->table[s];
		if (e->device == id->device && e->n == id->n && e->k == id->k) return e;
	}
	return NULL;
}

static void put(el_list *l, el_elem *e) {
	size_t s = home(l, e);
	while (l->table[s]) s = (s + 1) & (l->slots - 1);
	l->table[s] = e;
}

static void unput(el_list *l, const el_elem *e) {
	size_t mask = l->slots - 1, i = home(l, e);
	while (l->table[i] != e) i = (i + 1) & mask;
	for (size_t j = i;;) {
		for (;;) {
			j = (j + 1) & mask;
			if (!l->table[j]) {
				l->table[i] = NULL;
				return;
			}
			size_t h = home(l, l->table[j]);
			if (!(i <= j ? i < h && h <= j : i < h || h <= j)) break;
		}
		l->table[i] = l->table[j], i = j;
	}
}

static void list_free(const tp_mem *mem, el_list *l) {
	for (size_t i = 0; i < l->nblocks; i++) tp_free(mem, l->blocks[i].p, l->blocks[i].n * sizeof(el_elem));
	tp_free(mem, l->blocks, l->roomblocks * sizeof *l->blocks);
	tp_free(mem, l->items, l->room * sizeof *l->items);
	tp_free(mem, l->table, l->slots * sizeof *l->table);
	tp_free(mem, l->key, l->keyn);
	tp_free(mem, l, sizeof *l);
}

// room for extra more elements and one more block, all of it before anything changes
static int reserve(const tp_mem *mem, el_list *l, size_t extra) {
	size_t need = l->n + extra;
	if (need > l->room) {
		size_t room = l->room ? l->room : 8;
		while (room < need) room *= 2;
		el_elem **items = tp_grow(mem, l->items, l->room * sizeof *items, room * sizeof *items);
		if (!items) return -1;
		l->items = items, l->room = room;
	}
	if (2 * need > l->slots) {
		size_t slots = l->slots ? l->slots : 8;
		while (slots < 2 * need) slots *= 2;
		el_elem **table = tp_alloc(mem, slots * sizeof *table);
		if (!table) return -1;
		memset(table, 0, slots * sizeof *table);
		tp_free(mem, l->table, l->slots * sizeof *l->table);
		l->table = table, l->slots = slots;
		for (size_t i = 0; i < l->n; i++) put(l, l->items[i]);
	}
	if (l->nblocks == l->roomblocks) {
		size_t room = l->roomblocks ? 2 * l->roomblocks : 2;
		block *b = tp_grow(mem, l->blocks, l->roomblocks * sizeof *b, room * sizeof *b);
		if (!b) return -1;
		l->blocks = b, l->roomblocks = room;
	}
	return 0;
}

// how many before items[j] are not gone, the cursor moved there
static size_t live_before(el_list *l, size_t j) {
	while (l->j < j) l->live += l->items[l->j++]->gone ? 0 : 1;
	while (l->j > j) l->live -= l->items[--l->j]->gone ? 0 : 1;
	return l->live;
}
// the index of the a-th element not gone (n: past the last), the cursor moved there
static size_t live_at(el_list *l, size_t a) {
	while (l->live > a) {
		if (!l->items[--l->j]->gone) l->live--;
	}
	while (l->j < l->n && (l->live < a || l->items[l->j]->gone)) {
		if (!l->items[l->j++]->gone) l->live++;
	}
	return l->j;
}
// an element's index: looked for near the cursor first
static size_t index_of(const el_list *l, const el_elem *e) {
	for (size_t d = 0; d < 8; d++) {
		if (l->j >= d + 1 && l->items[l->j - 1 - d] == e) return l->j - 1 - d;
		if (l->j + d < l->n && l->items[l->j + d] == e) return l->j + d;
	}
	size_t i = 0;
	while (l->items[i] != e) i++;
	return i;
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

// a sequence's length, or -1
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
	struct {
		el_list *l;
		uint64_t count;
	} *made;
	size_t nmade, roommade;
} work;

static int devcmp(const el_ctx *c, uint32_t x, uint32_t y) {
	if (x == y) return 0;
	if (x == EL_NONE) return -1;
	if (y == EL_NONE) return 1;
	return memcmp(c->bytes(c->self, x), c->bytes(c->self, y), 32);
}
// the step sorts before the one that made e
static int sorts_before(const work *w, const el_elem *e) {
	if (w->ref.lamport != e->lamport) return w->ref.lamport < e->lamport;
	return devcmp(w->c, w->ref.device, e->device) < 0;
}

static int rec_room(work *w) {
	el_back *b = w->back;
	if (b->n < b->room) return 0;
	size_t room = b->room ? 2 * b->room : 4;
	el_rec *p = tp_grow(w->c->mem, b->p, b->room * sizeof *p, room * sizeof *p);
	if (!p) return -1;
	b->p = p, b->room = room;
	return 0;
}

// what this step made at a list, counted: its slot (made if new)
static uint64_t *made_of(work *w, el_list *l) {
	for (size_t i = 0; i < w->nmade; i++) {
		if (w->made[i].l == l) return &w->made[i].count;
	}
	if (w->nmade == w->roommade) {
		size_t room = w->roommade ? 2 * w->roommade : 4;
		void *p = tp_grow(w->c->mem, w->made, w->roommade * sizeof *w->made, room * sizeof *w->made);
		if (!p) return NULL;
		w->made = p, w->roommade = room;
	}
	w->made[w->nmade].l = l, w->made[w->nmade].count = 0;
	return &w->made[w->nmade++].count;
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

// the sequence at the patch's path, its elements made now: those there since the put that made it
static int elements(work *w, const op_value *cur, const op_patch *p, tp_span path, el_list **out) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	if ((*out = list_at(st, path))) return 0;
	long most = -1;
	el_ref by = {0, 0, EL_NONE};
	for (size_t i = 0; i < st->nborn; i++) {
		long m = prefix_of((tp_span){st->born[i].key, st->born[i].keyn}, path);
		if (m > most) most = m, by = st->born[i].r;
	}
	size_t count = (size_t)units(at_path(cur, &p->place));
	el_list *l = tp_alloc(mem, sizeof *l);
	if (!l) return TP_NOMEM;
	memset(l, 0, sizeof *l);
	el_elem *e = count ? tp_alloc(mem, count * sizeof *e) : NULL;
	l->key = tp_alloc(mem, path.n), l->keyn = path.n;
	if (!l->key || (count && !e) || reserve(mem, l, count) || rec_room(w) || lists_room(mem, st)) {
		tp_free(mem, e, count * sizeof *e);
		list_free(mem, l);
		return TP_NOMEM;
	}
	memcpy(l->key, path.p, path.n);
	if (count) {
		l->blocks[l->nblocks++] = (block){e, count};
		for (size_t i = 0; i < count; i++) {
			e[i] = (el_elem){by.lamport, by.n, by.device, (uint32_t)i, 0};
			l->items[l->n++] = &e[i], put(l, &e[i]);
		}
	}
	l->count = count;
	st->lists[st->n++] = l;
	w->back->p[w->back->n++] = (el_rec){.kind = MADE, .splice = {.list = l}};
	*out = l;
	if (by.device == w->ref.device && by.n == w->ref.n) {
		uint64_t *made = made_of(w, l);
		if (!made) return TP_NOMEM;
		*made = count;
	}
	return 0;
}

// the sequences at the path and under it made new by this step (a put, a removal, a move there);
// self 0: under it only (a splice into an array: a position under it now names another element)
static int renew(work *w, tp_span prefix, int self) {
	const tp_mem *mem = w->c->mem;
	el_state *st = w->st;
	size_t nl = 0, nb = 0;
#define SELF(l) (!self && (l)->keyn == prefix.n && !memcmp((l)->key, prefix.p, prefix.n))
	for (size_t i = 0; i < st->n; i++) nl += under(prefix, st->lists[i]->key, st->lists[i]->keyn) && !SELF(st->lists[i]);
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
		if (under(prefix, st->lists[i]->key, st->lists[i]->keyn) && !SELF(st->lists[i])) rl[k++] = st->lists[i];
		else st->lists[i - k] = st->lists[i];
	}
#undef SELF
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

// a put, a removal or a move
static int other(work *w, const op_patch *p, const tp_patch *tp) {
	int code = renew(w, tp->path, 1);
	if (!code && p->has_move) code = renew(w, move_path(tp->move), 1);
	return code;
}

static int by_place_down(const void *a, const void *b) {
	size_t x = *(const size_t *)a, y = *(const size_t *)b;
	return x < y ? 1 : x > y ? -1 : 0;
}

typedef struct {
	el_elem **p;
	size_t n, room;
	const tp_mem *mem;
} elems;
static int push(elems *e, el_elem *x) {
	if (e->n == e->room) {
		size_t room = e->room ? 2 * e->room : 16;
		el_elem **p = tp_grow(e->mem, e->p, e->room * sizeof *p, room * sizeof *p);
		if (!p) return -1;
		e->p = p, e->room = room;
	}
	e->p[e->n++] = x;
	return 0;
}

static int by_pointer(const void *a, const void *b) {
	const el_elem *x = *(el_elem *const *)a, *y = *(el_elem *const *)b;
	return x < y ? -1 : x > y;
}

// each element once, in the order first named
static int dedupe(elems *e) {
	size_t total = e->n;
	if (total < 2) return 0;
	el_elem **sorted = tp_alloc(e->mem, total * sizeof *sorted);
	uint8_t *seen = tp_alloc(e->mem, total);
	if (!sorted || !seen) {
		tp_free(e->mem, sorted, total * sizeof *sorted), tp_free(e->mem, seen, total);
		return -1;
	}
	memcpy(sorted, e->p, total * sizeof *sorted);
	qsort(sorted, total, sizeof *sorted, by_pointer);
	memset(seen, 0, total);
	size_t k = 0;
	for (size_t i = 0; i < total; i++) {
		size_t lo = 0, hi = total;
		while (lo < hi) {
			size_t mid = (lo + hi) / 2;
			if (sorted[mid] < e->p[i]) lo = mid + 1;
			else hi = mid;
		}
		if (!seen[lo]) seen[lo] = 1, e->p[k++] = e->p[i];
	}
	e->n = k;
	tp_free(e->mem, sorted, total * sizeof *sorted), tp_free(e->mem, seen, total);
	return 0;
}

static el_id id_of(const el_elem *e) { return (el_id){e->device, e->n, e->k}; }

// the elements a splice names: the one before it, and its gone ones as runs of one step's, k on.
// not named: one of them made by no step (no put made its sequence), so it goes by its range
static int name_of(const el_ctx *c, const el_list *l, long after, const elems *gone, el_anchor *out) {
	memset(out, 0, sizeof *out);
	if (after >= 0 && l->items[after]->device == EL_NONE) return 0;
	size_t runs = 0;
	for (size_t i = 0; i < gone->n; i++) {
		const el_elem *e = gone->p[i];
		if (e->device == EL_NONE) return 0;
		const el_elem *last = i ? gone->p[i - 1] : NULL;
		runs += !(last && last->device == e->device && last->n == e->n && last->k + 1 == e->k);
	}
	if (runs && !(out->gone = tp_alloc(c->mem, runs * sizeof *out->gone))) return TP_NOMEM;
	for (size_t i = 0, r = 0; i < gone->n; i++) {
		const el_elem *e = gone->p[i], *last = i ? gone->p[i - 1] : NULL;
		if (last && last->device == e->device && last->n == e->n && last->k + 1 == e->k) {
			out->gone[r - 1].count++;
		} else out->gone[r++] = (el_gone){id_of(e), 1};
	}
	out->ngone = runs, out->named = 1;
	if (after >= 0) out->has_after = 1, out->after = id_of(l->items[after]);
	return 0;
}

// a splice, by its ids (anchor) or its range, as the patches to apply by position (*qs, *nq)
static int splice(work *w, const op_value *cur, const op_patch *p, const tp_patch *tp,
	const el_anchor *anchor, int name, op_patch **qs, size_t *nq, size_t *qcap, el_anchor *named) {
	const tp_mem *mem = w->c->mem;
	// an insert of another kind than the sequence (a list into a text): doesn't apply, as apply refuses
	const op_value *into = at_path(cur, &p->place);
	if (p->has_value && (!p->value || p->value->type != into->type)) return OP_WRONG_KIND;
	el_list *l;
	int code = elements(w, cur, p, tp->path, &l);
	if (code) return code;
	uint64_t *made = made_of(w, l);
	if (!made) return TP_NOMEM;
	uint64_t a = (uint64_t)p->place.from, b = (uint64_t)p->place.to;
	long after = -1;
	elems gone = {NULL, 0, 0, mem};
	size_t *where = NULL, *places = NULL;
	op_patch *out = NULL;
	size_t qroom = 0;
	el_elem *block_p = NULL;
	el_anchor made_name;
	int named_here = 0;
	size_t j, mm, nt = 0, nplaces = 0, below = 0, to, nout = 0;
	if (anchor) {
		if (anchor->has_after) {
			el_elem *e = find(l, &anchor->after);
			if (!e) {
				code = OP_RANGE;
				goto done;
			}
			after = (long)index_of(l, e);
		}
		for (size_t r = 0; r < anchor->ngone; r++) {
			for (uint64_t k = 0; k < anchor->gone[r].count; k++) {
				el_id id = anchor->gone[r].id;
				id.k += k;
				el_elem *g = find(l, &id);
				if (!g) {
					code = OP_RANGE;
					goto done;
				}
				if (push(&gone, g)) {
					code = TP_NOMEM;
					goto done;
				}
			}
		}
	} else {
		if (a > b || b > l->count) {
			code = OP_RANGE;
			goto done;
		}
		if (a) after = (long)live_at(l, (size_t)a - 1);
		size_t i = b > a ? live_at(l, (size_t)a) : 0;
		for (; gone.n < b - a; i++) {
			if (!l->items[i]->gone && push(&gone, l->items[i])) {
				code = TP_NOMEM;
				goto done;
			}
		}
	}
	// where the inserted go: after its element, past those made by steps after this one
	j = (size_t)(after + 1);
	if (anchor) {
		while (j < l->n && sorts_before(w, l->items[j])) j++;
	}
	long m = p->has_value ? units(p->value) : 0;
	mm = m > 0 ? (size_t)m : 0;
	// by position: the gone ones that are still there, newest place first, then the insert
	if (dedupe(&gone)) {
		code = TP_NOMEM;
		goto done;
	}
	for (size_t i = 0; i < gone.n; i++) nt += !gone.p[i]->gone;
	where = nt ? tp_alloc(mem, nt * sizeof *where) : NULL;
	places = nt ? tp_alloc(mem, nt * sizeof *places) : NULL;
	nplaces = nt;
	if (nt && (!where || !places)) {
		code = TP_NOMEM;
		goto done;
	}
	nt = 0;
	for (size_t i = 0; i < gone.n; i++) {
		if (!gone.p[i]->gone) where[nt++] = index_of(l, gone.p[i]);
	}
	for (size_t i = 0; i < nt; i++) places[i] = live_before(l, where[i]), below += where[i] < j;
	qsort(places, nt, sizeof *places, by_place_down);
	to = live_before(l, j) - below;
	if (!(out = tp_alloc(mem, (qroom = nt + 2) * sizeof *out))) {
		qroom = 0;
		code = TP_NOMEM;
		goto done;
	}
	for (size_t i = 0; i < nt;) {
		size_t x = places[i], len = 1;
		while (i + len < nt && places[i + len] + len == x) len++;
		out[nout] = (op_patch){0};
		out[nout].place = p->place;
		out[nout].place.from = (int64_t)(x + 1 - len), out[nout].place.to = (int64_t)(x + 1);
		nout++, i += len;
	}
	if (mm > 0 || !nout) {
		out[nout] = (op_patch){0};
		out[nout].place = p->place;
		out[nout].place.from = out[nout].place.to = (int64_t)to;
		if (mm > 0) out[nout].has_value = 1, out[nout].value = p->value;
		nout++;
	}
	if (name && named) {
		code = name_of(w->c, l, after, &gone, &made_name);
		if (code) goto done;
		named_here = 1;
	}
	block_p = mm ? tp_alloc(mem, mm * sizeof *block_p) : NULL;
	if ((mm && !block_p) || reserve(mem, l, mm) || rec_room(w)) {
		code = TP_NOMEM;
		goto done;
	}
	// the elements: gone ones marked, the inserted made, k counted per path for the step
	for (size_t i = 0; i < nt; i++) {
		l->items[where[i]]->gone = 1;
		if (where[i] < l->j) l->live--;
	}
	uint64_t k0 = *made;
	if (mm) {
		memmove(l->items + j + mm, l->items + j, (l->n - j) * sizeof *l->items);
		for (size_t i = 0; i < mm; i++) {
			block_p[i] = (el_elem){w->ref.lamport, w->ref.n, w->ref.device, (uint32_t)(k0 + i), 0};
			l->items[j + i] = &block_p[i];
			put(l, &block_p[i]);
		}
		l->n += mm;
		l->blocks[l->nblocks++] = (block){block_p, mm};
		if (l->j > j) l->j += mm, l->live += mm;
	}
	l->count = l->count + mm - nt;
	*made = k0 + mm;
	w->back->p[w->back->n++] = (el_rec){.kind = SPLICE, .splice = {l, j, mm, where, nt}};
	where = NULL;
	*qs = out, *nq = nout, *qcap = qroom, out = NULL;
	if (named_here) *named = made_name, named_here = 0;
	// into an array: what is under it now is made new (a position names another element)
	const op_value *seq = at_path(cur, &p->place);
	if (seq && seq->type == OP_LIST) code = renew(w, tp->path, 0);
done:
	tp_free(mem, where, nplaces * sizeof *where), tp_free(mem, places, nplaces * sizeof *places);
	tp_free(mem, gone.p, gone.room * sizeof *gone.p), tp_free(mem, out, qroom * sizeof *out);
	if (named_here) tp_free(mem, made_name.gone, made_name.ngone * sizeof *made_name.gone);
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
		size_t j = r->splice.j, m = r->splice.m;
		for (size_t i = 0; i < m; i++) unput(l, l->items[j + i]);
		if (m) {
			block *last = &l->blocks[--l->nblocks];
			memmove(l->items + j, l->items + j + m, (l->n - j - m) * sizeof *l->items);
			l->n -= m;
			tp_free(mem, last->p, last->n * sizeof(el_elem));
		}
		for (size_t i = 0; i < r->splice.nwhere; i++) l->items[r->splice.where[i]]->gone = 0;
		l->count = l->count + r->splice.nwhere - m;
		l->j = l->live = 0;
		tp_free(mem, r->splice.where, r->splice.nwhere * sizeof *r->splice.where);
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
	if (r->kind == SPLICE) tp_free(mem, r->splice.where, r->splice.nwhere * sizeof *r->splice.where);
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
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int name,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named) {
	work w = {c, st, back, *ref, NULL, 0, 0};
	size_t marks = back->n, at = 0, nout = 0, roomout = 0, nus = 0, roomus = 0;
	op_value *cur = *value;
	int owned = 0, code = 0;
	op_patch *out = NULL, *cat = NULL;
	op_undo *us = NULL;
	el_anchor *nm = NULL;
	size_t total = 0;
	if (name && named && n && !(nm = tp_alloc(c->mem, n * sizeof *nm))) return TP_NOMEM;
	if (nm) memset(nm, 0, n * sizeof *nm);
	tp_patch tp;
	for (size_t i = 0; i < n && !code; i++) {
		if (tp_patch_next(patches, &at, &tp)) {
			code = OP_NOT_A_PATCH;
			break;
		}
		if (keep && !keep[i]) continue;
		const op_patch *p = &ps[i];
		op_patch *qs = (op_patch *)p, *made_qs = NULL;
		size_t nq = 1, qcap = 0;
		const el_anchor *anchor = !name && ids && ids[i].named ? &ids[i] : NULL;
		if (p->place.has_range && units(at_path(cur, &p->place)) >= 0) {
			code = splice(&w, cur, p, &tp, anchor, name, &made_qs, &nq, &qcap, nm ? &nm[i] : NULL);
			if (!code) qs = made_qs;
		} else code = other(&w, p, &tp);
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
	if (code) {
		for (size_t i = 0; i < nus; i++) op_undo_free(&us[i]);
		tp_free(c->mem, us, roomus * sizeof *us);
		free(out);
		if (nm) el_anchors_free(c->mem, nm, n);
		if (owned) op_free(cur);
		rollback(&w, marks);
		tp_free(c->mem, w.made, w.roommade * sizeof *w.made);
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
	if (applied) *applied = out, *napplied = nout;
	else free(out);
	if (named) *named = nm;
	tp_free(c->mem, w.made, w.roommade * sizeof *w.made);
	return 0;
}

void el_anchors_free(const tp_mem *mem, el_anchor *a, size_t n) {
	if (!a) return;
	for (size_t i = 0; i < n; i++) tp_free(mem, a[i].gone, a[i].ngone * sizeof *a[i].gone);
	tp_free(mem, a, n * sizeof *a);
}

int el_named(const el_anchor *a, size_t n) {
	for (size_t i = 0; a && i < n; i++) {
		if (a[i].named) return 1;
	}
	return 0;
}

static int read_id(const el_ctx *c, tp_in *in, const tp_step *s, uint32_t me, el_id *id) {
	uint64_t k, a, b;
	tp_span key;
	if (tp_array(in, &k)) return -1;
	if (k == 2) {
		if (tp_whole(in, &a) || tp_whole(in, &b)) return -1;
		*id = (el_id){me, s->n - a, b};
		return 0;
	}
	if (tp_bytes(in, 32, &key) || tp_whole(in, &a) || tp_whole(in, &b)) return -1;
	// a device not known has no elements: nothing is named by it, and it is not made known
	long d = c->find(c->self, key.p);
	*id = (el_id){d < 0 ? EL_UNKNOWN : (uint32_t)d, a, b};
	return 0;
}

int el_read(const el_ctx *c, const tp_step *s, el_anchor **out) {
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
		uint64_t two, g = 0;
		if (tp_null(&in)) continue;
		if (tp_array(&in, &two)) code = TP_NOTSTEP;
		else if (!tp_null(&in)) code = read_id(c, &in, s, (uint32_t)me, &a[i].after), a[i].has_after = 1;
		if (!code && tp_array(&in, &g)) code = TP_NOTSTEP;
		if (!code && g && !(a[i].gone = tp_alloc(c->mem, (size_t)g * sizeof *a[i].gone))) code = TP_NOMEM;
		for (uint64_t j = 0; j < g && !code; j++) {
			uint64_t pair;
			if (tp_array(&in, &pair) || read_id(c, &in, s, (uint32_t)me, &a[i].gone[j].id) ||
				tp_whole(&in, &a[i].gone[j].count))
				code = TP_NOTSTEP;
			else a[i].ngone = j + 1;
		}
		a[i].named = !code;
	}
	if (code) return el_anchors_free(c->mem, a, (size_t)k), code;
	*out = a;
	return 0;
}

static void write_id(tp_buf *b, const el_ctx *c, const el_id *id, uint32_t me, uint64_t mine) {
	if (id->device == me) tp_put_head(b, 4, 2), tp_put_head(b, 0, mine - id->n);
	else {
		tp_put_head(b, 4, 3), tp_put_head(b, 2, 32), tp_put(b, c->bytes(c->self, id->device), 32);
		tp_put_head(b, 0, id->n);
	}
	tp_put_head(b, 0, id->k);
}

void el_write(tp_buf *b, const el_ctx *c, const el_anchor *a, size_t n, uint32_t me, uint64_t mine) {
	tp_put_head(b, 4, n);
	for (size_t i = 0; i < n; i++) {
		if (!a[i].named) {
			tp_put(b, "\xf6", 1);
			continue;
		}
		tp_put_head(b, 4, 2);
		if (a[i].has_after) write_id(b, c, &a[i].after, me, mine);
		else tp_put(b, "\xf6", 1);
		tp_put_head(b, 4, a[i].ngone);
		for (size_t j = 0; j < a[i].ngone; j++) {
			tp_put_head(b, 4, 2), write_id(b, c, &a[i].gone[j].id, me, mine);
			tp_put_head(b, 0, a[i].gone[j].count);
		}
	}
}
