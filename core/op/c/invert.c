// invert (invert.h), in C: the patches walked on a copy of the value, each undone as it lands, as
// invert.ts does it. op_apply has checked them first: nothing is checked here.
// Memory: what a patch touches is a copy made here (the made set), changed in place until the
// undo holds it (hold: no longer made, what it shares op_ref'd); the rest is shared, never freed.
// A string or typed array made here and replaced is freed at once; what is still made at the end,
// its shell.
#include "invert.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// memory

static void *grab(void *p, size_t n) {
	void *q = realloc(p, n ? n : 1);
	if (q == NULL) {
		fputs("invert: out of memory\n", stderr);
		abort();
	}
	return q;
}
static char *dup(const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(grab(NULL, n), s, n);
}

// a set of pointers: the values made in this call
typedef struct {
	const void **slots;
	size_t cap, used, dead;
} pset;
static const char gone_; // a deleted slot
#define GONE ((const void *)&gone_)
static size_t hash_of(const void *p) {
	uint64_t x = (uint64_t)(uintptr_t)p;
	x ^= x >> 17;
	x *= 0x9E3779B97F4A7C15ull;
	return (size_t)(x >> 20);
}
static void pset_add(pset *s, const void *p);
static void pset_grow(pset *s) {
	pset old = *s;
	s->cap = old.cap ? old.cap * 2 : 64;
	s->slots = grab(NULL, s->cap * sizeof *s->slots);
	memset(s->slots, 0, s->cap * sizeof *s->slots);
	s->used = s->dead = 0;
	for (size_t i = 0; i < old.cap; i++)
		if (old.slots[i] != NULL && old.slots[i] != GONE) pset_add(s, old.slots[i]);
	free(old.slots);
}
static void pset_add(pset *s, const void *p) {
	if ((s->used + s->dead + 1) * 2 > s->cap) pset_grow(s);
	size_t h = hash_of(p) & (s->cap - 1);
	while (s->slots[h] != NULL && s->slots[h] != GONE) h = (h + 1) & (s->cap - 1);
	if (s->slots[h] == GONE) s->dead--;
	s->slots[h] = p;
	s->used++;
}
static int pset_has(const pset *s, const void *p) {
	if (s->cap == 0 || p == NULL) return 0;
	for (size_t h = hash_of(p) & (s->cap - 1); s->slots[h] != NULL; h = (h + 1) & (s->cap - 1))
		if (s->slots[h] == p) return 1;
	return 0;
}
// 1 when it was there
static int pset_del(pset *s, const void *p) {
	if (s->cap == 0 || p == NULL) return 0;
	for (size_t h = hash_of(p) & (s->cap - 1); s->slots[h] != NULL; h = (h + 1) & (s->cap - 1)) {
		if (s->slots[h] == p) {
			s->slots[h] = GONE;
			s->used--;
			s->dead++;
			return 1;
		}
	}
	return 0;
}

// the work of one call

typedef struct {
	op_value *root; // NULL: nothing there
	pset made;
	op_undo undo; // each patch's, in the order they land
	// the last splice's: what the span held, how many positions went in, whether a lone high met
	// a lone low at an edge
	op_value *taken;
	size_t size;
	int joined;
} work;

// frees one made value, not what it holds
static void shell_free(op_value *v) {
	if (v->type == OP_MAP)
		for (size_t i = 0; i < v->count; i++) free(v->keys[i]);
	free(v->items);
	free(v->keys);
	free(v->index);
	free(v->str);
	free(v->data);
	free(v);
}

static int is_list(const op_value *v) { return v != NULL && v->type == OP_LIST; }

static op_value *made(work *w, op_value *v) {
	pset_add(&w->made, v);
	return v;
}
static op_value *made_list(work *w, size_t count) {
	op_value *l = made(w, op_list());
	if (count) {
		l->items = grab(NULL, count * sizeof *l->items);
		l->capacity = count;
	}
	return l;
}
// a list of one, made
static op_value *one_of(work *w, op_value *v) {
	op_value *l = made_list(w, 1);
	l->items[0] = v;
	l->count = 1;
	return l;
}
// a new typed array of these bytes
static op_value *made_typed(work *w, op_elements kind, const unsigned char *a, size_t na,
	const unsigned char *b, size_t nb, const unsigned char *c, size_t nc) {
	op_value *t = made(w, op_typed(kind, NULL, 0));
	t->data = grab(t->data, na + nb + nc);
	if (na) memcpy(t->data, a, na);
	if (nb) memcpy(t->data + na, b, nb);
	if (nc) memcpy(t->data + na + nb, c, nc);
	t->bytes = na + nb + nc;
	return t;
}
// a copy to change in place: v itself when it was made here
static op_value *own(work *w, op_value *v) {
	if (pset_has(&w->made, v)) return v;
	op_value *c = made(w, v->type == OP_MAP ? op_map() : op_list());
	if (v->count) {
		c->items = grab(NULL, v->count * sizeof *c->items);
		memcpy(c->items, v->items, v->count * sizeof *c->items);
		c->capacity = c->count = v->count;
		if (v->type == OP_MAP) {
			c->keys = grab(NULL, v->count * sizeof *c->keys);
			for (size_t i = 0; i < v->count; i++) c->keys[i] = dup(v->keys[i]);
		}
	}
	return c;
}
// the undo holds v: what of it was made is made no more, what it shares gets a holder
static void hold(work *w, op_value *v) {
	if (v == NULL) return;
	if (!pset_del(&w->made, v)) {
		op_ref(v);
		return;
	}
	for (size_t i = 0; i < v->count; i++) hold(w, v->items[i]);
}
// a string or typed array made here, let go of
static void drop_leaf(work *w, op_value *v) {
	if (v != NULL && (v->type == OP_STR || v->type == OP_TYPED) && pset_del(&w->made, v)) shell_free(v);
}

// strings: position -> byte offset, as apply.c: code points, a lone surrogate held as WTF-8
// (ED A0..BF xx), a position of its own
static size_t next(const unsigned char *t, size_t i, size_t end) {
	i++;
	while (i < end && (t[i] & 0xC0) == 0x80) i++;
	return i;
}
static void span_bytes(const op_value *s, long a, long b, size_t *x, size_t *y) {
	if (s->ascii) {
		*x = (size_t)a, *y = (size_t)b;
		return;
	}
	const unsigned char *u = (const unsigned char *)s->str;
	size_t i = 0;
	long k = 0;
	for (; k < a && i < s->bytes; k++) i = next(u, i, s->bytes);
	*x = i;
	for (; k < b && i < s->bytes; k++) i = next(u, i, s->bytes);
	*y = i;
}
static size_t str_len(const op_value *s) {
	if (s->ascii) return s->bytes;
	const unsigned char *u = (const unsigned char *)s->str;
	size_t n = 0;
	for (size_t i = 0; i < s->bytes; i = next(u, i, s->bytes)) n++;
	return n;
}
// a lone high ends p[0, j); a lone low begins p[j, end)
static int high_before(const unsigned char *p, size_t j) {
	return j >= 3 && p[j - 3] == 0xED && (p[j - 2] & 0xF0) == 0xA0;
}
static int low_at(const unsigned char *p, size_t j, size_t end) {
	return j + 3 <= end && p[j] == 0xED && (p[j + 1] & 0xF0) == 0xB0;
}
// a lone high before a lone low at p[j] is one character: joined, the bytes it leaves cut
static void join(char *p, size_t *size, size_t j) {
	unsigned char *u = (unsigned char *)p;
	if (!high_before(u, j) || !low_at(u, j, *size)) return;
	unsigned long hi = ((u[j - 2] & 0x0Ful) << 6) | (u[j - 1] & 63ul);
	unsigned long lo = ((u[j + 1] & 0x0Ful) << 6) | (u[j + 2] & 63ul);
	unsigned long cp = 0x10000 + (hi << 10) + lo;
	u[j - 3] = (unsigned char)(0xF0 | cp >> 18);
	u[j - 2] = (unsigned char)(0x80 | ((cp >> 12) & 63));
	u[j - 1] = (unsigned char)(0x80 | ((cp >> 6) & 63));
	u[j] = (unsigned char)(0x80 | (cp & 63));
	memmove(p + j + 1, p + j + 3, *size - j - 3);
	*size -= 2;
}

// paths

static int same_key(op_key a, op_key b) {
	if (a.type != b.type) return 0;
	return a.type == OP_NUM_KEY ? a.n == b.n : strcmp(a.s, b.s) == 0;
}
static int same_path(const op_target *a, const op_target *b) {
	if (a->length != b->length) return 0;
	for (size_t i = 0; i < a->length; i++)
		if (!same_key(a->path[i], b->path[i])) return 0;
	return 1;
}
// b is a, or under it
static int within(const op_target *a, const op_target *b) {
	if (a->length > b->length) return 0;
	for (size_t i = 0; i < a->length; i++)
		if (!same_key(a->path[i], b->path[i])) return 0;
	return 1;
}
// apply's into-itself: p's place lies inside what from takes
static int under(const op_target *p, const op_target *from) {
	if (!within(from, p)) return 0;
	if (!from->has_range) return p->length > from->length;
	if (p->length == from->length) return 0;
	op_key k = p->path[from->length];
	return k.type == OP_NUM_KEY && k.n >= from->from && k.n < from->to;
}
// the keys of path, then one more (malloc'd: the caller frees them)
static op_key *longer(const op_target *t, op_key last) {
	op_key *ks = grab(NULL, (t->length + 1) * sizeof *ks);
	if (t->length) memcpy(ks, t->path, t->length * sizeof *ks);
	ks[t->length] = last;
	return ks;
}
// path, once one element is put in at the gap of at, a list's range; NULL: as it is (else
// malloc'd: the caller frees it)
static op_key *shift(const op_target *path, const op_target *at) {
	size_t n = at->length;
	if (!at->has_range || path->length <= n || !within(at, path)) return NULL;
	if (path->path[n].n < at->from) return NULL;
	op_key *ks = grab(NULL, path->length * sizeof *ks);
	memcpy(ks, path->path, path->length * sizeof *ks);
	ks[n].n++;
	return ks;
}

// where the key of a map is, or -1
static long map_at(const op_value *m, const char *key) {
	op_value *p = op_get(m, key);
	if (p == NULL) return -1;
	for (size_t i = 0; i < m->count; i++)
		if (m->items[i] == p && strcmp(m->keys[i], key) == 0) return (long)i;
	return -1;
}
static op_value *get(work *w, const op_key *path, size_t n) {
	op_value *v = w->root;
	for (size_t i = 0; i < n; i++) v = is_list(v) ? v->items[path[i].n] : op_get(v, path[i].s);
	return v;
}
// the container holding path's last key, made own along the way
static op_value *parent(work *w, const op_key *path, size_t n) {
	op_value *v = w->root = own(w, w->root);
	for (size_t i = 0; i + 1 < n; i++) {
		op_value **s = is_list(v) ? &v->items[path[i].n] : &v->items[map_at(v, path[i].s)];
		v = *s = own(w, *s);
	}
	return v;
}
static void list_splice(op_value *l, size_t a, size_t b, op_value *const *ws, size_t wn) {
	size_t tail = l->count - b, n = l->count - (b - a) + wn;
	if (n > l->capacity) {
		l->capacity = n;
		l->items = grab(l->items, n * sizeof *l->items);
	}
	if (tail && wn != b - a) memmove(l->items + a + wn, l->items + b, tail * sizeof *l->items);
	if (wn) memcpy(l->items + a, ws, wn * sizeof *ws);
	l->count = n;
}
// what is at path becomes v (NULL: removed); what was there (NULL: nothing)
static op_value *set(work *w, const op_key *path, size_t n, op_value *v) {
	if (n == 0) {
		op_value *old = w->root;
		w->root = v;
		return old;
	}
	op_value *at = parent(w, path, n);
	op_key k = path[n - 1];
	if (is_list(at)) {
		op_value *old = at->items[k.n];
		if (v == NULL) list_splice(at, (size_t)k.n, (size_t)k.n + 1, NULL, 0);
		else at->items[k.n] = v;
		return old;
	}
	long i = map_at(at, k.s);
	if (i < 0) {
		if (v != NULL) op_set(at, k.s, v);
		return NULL;
	}
	op_value *old = at->items[i];
	if (v != NULL) at->items[i] = v;
	else {
		free(at->keys[i]);
		memmove(at->keys + i, at->keys + i + 1, (at->count - (size_t)i - 1) * sizeof *at->keys);
		memmove(at->items + i, at->items + i + 1, (at->count - (size_t)i - 1) * sizeof *at->items);
		at->count--;
		free(at->index);
		at->index = NULL;
		at->slots = 0;
	}
	return old;
}

// the undo

// a patch into the undo: its keys copied, its value held
static op_key *keys_of(const op_target *t) {
	op_key *ks = grab(NULL, (t->length + 1) * sizeof *ks);
	for (size_t i = 0; i < t->length; i++) {
		ks[i] = t->path[i];
		if (ks[i].type == OP_STR_KEY) ks[i].s = dup(ks[i].s);
	}
	return ks;
}
static void push(work *w, const op_patch *p) {
	op_undo *u = &w->undo;
	if (u->n == u->capacity) {
		u->capacity = u->capacity ? u->capacity * 2 : 16;
		u->patches = grab(u->patches, u->capacity * sizeof *u->patches);
	}
	op_patch *q = &u->patches[u->n++];
	*q = *p;
	q->place.path = keys_of(&p->place);
	if (p->has_move) q->move.path = keys_of(&p->move);
	if (p->has_value) hold(w, (op_value *)p->value);
}
static op_target target(const op_key *path, size_t n) { return (op_target){path, n, 0, 0, 0}; }
static op_target ranged(const op_key *path, size_t n, long a, long b) {
	return (op_target){path, n, 1, a, b};
}

// the span [a, b) at path becomes v (NULL: nothing; a list's: its items go in); *undo its undo, 0
// when nothing changed
static int splice(work *w, const op_key *path, size_t n, long a, long b, op_value *v,
	op_patch *undo) {
	op_value *s = get(w, path, n);
	long start = a, end;
	op_value *back;
	if (s->type == OP_STR) {
		size_t x, y;
		span_bytes(s, a, b, &x, &y);
		const unsigned char *u = (const unsigned char *)s->str;
		size_t nv = v ? v->bytes : 0;
		// a lone high met by a lone low: l at the left edge, r at the right; with nothing put in,
		// both edges are one
		int l = 0, r = 0;
		if (nv) {
			const unsigned char *vu = (const unsigned char *)v->str;
			if (high_before(u, x) && low_at(vu, 0, nv)) l = 1;
			if (high_before(vu, nv) && low_at(u, y, s->bytes)) r = 1;
		} else if (high_before(u, x) && low_at(u, y, s->bytes)) l = r = 1;
		size_t post = s->bytes - y, size = x + nv + post;
		char *buf = grab(NULL, size + 1);
		memcpy(buf, s->str, x);
		if (nv) memcpy(buf + x, v->str, nv);
		memcpy(buf + x + nv, s->str + y, post);
		join(buf, &size, x + nv);
		if (nv) join(buf, &size, x);
		buf[size] = 0;
		w->taken = made(w, op_str_n(s->str + x, y - x));
		w->size = v ? str_len(v) : 0;
		w->joined = l + r > 0;
		// the undo widens over a pair made, and puts its other half back with what was there
		start = a - l;
		end = start + (long)w->size + (nv ? 0 : l);
		back = made(w, op_str_n(s->str + x - 3 * (size_t)l, y + 3 * (size_t)r - (x - 3 * (size_t)l)));
		set(w, path, n, made(w, op_str_take(buf, size)));
		drop_leaf(w, s);
	} else if (s->type == OP_LIST) {
		op_value *l = own(w, s);
		size_t gone = (size_t)(b - a);
		back = w->taken = made_list(w, gone);
		if (gone) memcpy(back->items, l->items + a, gone * sizeof *l->items);
		back->count = gone;
		w->size = v ? v->count : 0;
		w->joined = 0;
		list_splice(l, (size_t)a, (size_t)b, v ? v->items : NULL, w->size);
		set(w, path, n, l);
		end = a + (long)w->size;
	} else {
		size_t z = op_size(s->kind), x = (size_t)a * z, y = (size_t)b * z;
		w->size = v ? op_length(v) : 0;
		w->joined = 0;
		back = w->taken = made_typed(w, s->kind, s->data + x, y - x, NULL, 0, NULL, 0);
		set(w, path, n, made_typed(w, s->kind, s->data, x, v ? v->data : NULL, v ? v->bytes : 0,
			s->data + y, s->bytes - y));
		drop_leaf(w, s);
		end = a + (long)w->size;
	}
	int empty = back->type == OP_LIST ? back->count == 0 : back->bytes == 0;
	if (empty && start == end) return 0;
	*undo = (op_patch){.place = ranged(path, n, start, end), .has_value = !empty, .value = back};
	return 1;
}

static void fall(work *w, const op_patch *undone, const op_patch *untake) {
	if (undone) push(w, undone);
	if (untake) push(w, untake);
}

// a move is a take, then a landing in what is left: its undo is the landing's, then the take's.
// better, one move back, with what the landing replaced put beside what moved first: as invert.ts
static void move(work *w, const op_patch *p) {
	const op_target *P = &p->place, *F = &p->move;
	// onto itself: nothing changes
	if (!P->has_range && !F->has_range && same_path(P, F)) return;
	op_value *m;
	op_patch untake = {0};
	op_target back;
	int has_untake = 1, taking = 0, listed = 0;
	if (F->has_range) {
		has_untake = splice(w, F->path, F->length, F->from, F->to, NULL, &untake);
		m = w->taken, taking = w->joined;
		back = ranged(F->path, F->length, F->from, F->from);
	} else {
		long f = F->path[F->length - 1].n;
		listed = is_list(get(w, F->path, F->length - 1));
		m = set(w, F->path, F->length, NULL);
		back = listed ? ranged(F->path, F->length - 1, f, f) : target(F->path, F->length);
		untake = (op_patch){.place = back, .has_value = 1, .value = listed ? one_of(w, m) : m};
	}
	// what was undone first, then what was taken put back
#define FALL(undone) fall(w, undone, has_untake ? &untake : NULL)

	if (!P->has_range) {
		int listy = P->length > 0 && is_list(get(w, P->path, P->length - 1));
		long k = listy ? P->path[P->length - 1].n : 0;
		op_value *old = set(w, P->path, P->length, m);
		op_patch unset = {.place = target(P->path, P->length), .has_value = old != NULL, .value = old};
		if (P->length == 0) {
			FALL(&unset);
			return;
		}
		if (F->has_range) {
			// the span back, out of the sequence it became, which is then put back
			if (taking || within(P, F)) {
				FALL(&unset);
				return;
			}
			long n = F->to - F->from;
			if (n) {
				op_patch mv = {.place = back, .has_move = 1, .move = ranged(P->path, P->length, 0, n)};
				push(w, &mv);
			}
			push(w, &unset);
			return;
		}
		op_patch there = {.place = back, .has_move = 1, .move = target(P->path, P->length)};
		if (listy) {
			// what was replaced goes in beside it first
			if (under(&there.place, &there.move)) {
				FALL(&unset);
				return;
			}
			op_patch beside = {.place = ranged(P->path, P->length - 1, k + 1, k + 1), .has_value = 1,
				.value = one_of(w, old)};
			push(w, &beside);
			push(w, &there);
			return;
		}
		if (old == NULL) {
			if (under(&there.place, &there.move)) FALL(&unset);
			else push(w, &there);
			return;
		}
		// a map's key: put back once what moved has left it
		if (within(P, &back)) {
			FALL(&unset);
			return;
		}
		push(w, &there);
		op_key *moved = shift(P, &back);
		op_patch put = {.place = target(moved ? moved : P->path, P->length), .has_value = 1, .value = old};
		push(w, &put);
		free(moved);
		return;
	}

	long a = P->from, b = P->to;
	// one element into a list: as a list of one
	int one = !F->has_range && is_list(get(w, P->path, P->length));
	op_patch unput;
	int has_unput = splice(w, P->path, P->length, a, b, one ? one_of(w, m) : m, &unput);
	op_value *t = w->taken;
	long size = (long)w->size;
	op_patch there;
	op_key *at = NULL;
	if (one) {
		at = longer(P, (op_key){.type = OP_NUM_KEY, .n = a});
		there = (op_patch){.place = back, .has_move = 1, .move = target(at, P->length + 1)};
	} else {
		// a lone high at the end of what moved would meet a lone low that begins what it replaced
		int meets = m->type == OP_STR && t->bytes && high_before((const unsigned char *)m->str, m->bytes) &&
			low_at((const unsigned char *)t->str, 0, t->bytes);
		if (listed || taking || w->joined || meets) {
			FALL(has_unput ? &unput : NULL);
			return;
		}
		there = (op_patch){.place = back, .has_move = 1, .move = ranged(P->path, P->length, a, a + size)};
	}
	if (under(&there.place, &there.move)) FALL(has_unput ? &unput : NULL);
	else {
		if (t->type == OP_LIST ? t->count : t->bytes) {
			op_patch beside = {.place = ranged(P->path, P->length, a + size, a + size), .has_value = 1,
				.value = t};
			push(w, &beside);
		}
		if (size || !F->has_range) push(w, &there);
	}
	free(at);
#undef FALL
}

static void step(work *w, const op_patch *p) {
	const op_target *pl = &p->place;
	if (p->has_move) {
		move(w, p);
		return;
	}
	op_value *v = p->has_value ? (op_value *)p->value : NULL;
	if (pl->has_range) {
		op_patch u;
		if (splice(w, pl->path, pl->length, pl->from, pl->to, v, &u)) push(w, &u);
		return;
	}
	if (p->has_value) {
		op_value *old = set(w, pl->path, pl->length, v);
		op_patch u = {.place = target(pl->path, pl->length), .has_value = old != NULL, .value = old};
		push(w, &u);
		return;
	}
	if (pl->length == 0) {
		op_patch u = {.place = target(pl->path, 0), .has_value = 1, .value = set(w, pl->path, 0, NULL)};
		push(w, &u);
		return;
	}
	long k = pl->path[pl->length - 1].n;
	int listed = is_list(get(w, pl->path, pl->length - 1));
	op_value *old = set(w, pl->path, pl->length, NULL);
	// a missing map key: nothing
	if (old == NULL) return;
	op_patch u = listed
		? (op_patch){.place = ranged(pl->path, pl->length - 1, k, k), .has_value = 1, .value = one_of(w, old)}
		: (op_patch){.place = target(pl->path, pl->length), .has_value = 1, .value = old};
	push(w, &u);
}

static void let_go(work *w) {
	for (size_t j = 0; j < w->made.cap; j++)
		if (w->made.slots[j] != NULL && w->made.slots[j] != GONE) shell_free((op_value *)w->made.slots[j]);
	free(w->made.slots);
}

int op_invert(const op_value *value, const op_patch *patches, size_t n,
	const op_invert_options *options, op_undo *out, size_t *failed) {
	int list = options != NULL && options->list;
	// apply decides what is valid
	op_apply_options o = {.list = list};
	op_value *end = NULL;
	int code = op_apply(value, patches, n, &o, &end, failed);
	if (code != OP_OK) return code;
	op_free(end);
	work w = {.root = (op_value *)value};
	if (list && w.root == NULL) w.root = made_list(&w, 0);
	// each patch's undo starts at its mark
	size_t *marks = grab(NULL, (n + 1) * sizeof *marks);
	for (size_t i = 0; i < n; i++) {
		marks[i] = w.undo.n;
		step(&w, &patches[i]);
	}
	// the last patch's first
	op_undo u = {grab(NULL, (w.undo.n + 1) * sizeof *u.patches), 0, w.undo.n};
	for (size_t i = n, e = w.undo.n; i-- > 0; e = marks[i])
		for (size_t j = marks[i]; j < e; j++) u.patches[u.n++] = w.undo.patches[j];
	free(w.undo.patches);
	free(marks);
	let_go(&w);
	*out = u;
	return OP_OK;
}

static void keys_free(const op_target *t) {
	for (size_t i = 0; i < t->length; i++)
		if (t->path[i].type == OP_STR_KEY) free((char *)t->path[i].s);
	free((op_key *)t->path);
}
void op_undo_free(op_undo *u) {
	for (size_t i = 0; i < u->n; i++) {
		op_patch *p = &u->patches[i];
		keys_free(&p->place);
		if (p->has_move) keys_free(&p->move);
		if (p->has_value) op_free((op_value *)p->value);
	}
	free(u->patches);
	*u = (op_undo){0};
}
