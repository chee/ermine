// apply (apply.h), in C, on op_value contents. Same rules, same order of checks as apply.ts.
// Memory: what a patch touches is a copy made here (the "made" set), changed in place for the
// rest of the call; everything else is shared and never freed. Values made here and dropped
// again within the call are freed; values given are never. Once the call is good, the new value
// takes its references (hold): a made value has its one holder, its parent; a shared one an op_ref.
#include "apply.h"

#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char *op_code_name(int code) {
	switch (code) {
	case OP_OK: return "ok";
	case OP_NOT_A_PATCH: return "not-a-patch";
	case OP_NO_KEY: return "no-key";
	case OP_RANGE: return "range";
	case OP_WRONG_KIND: return "wrong-kind";
	case OP_INTO_ITSELF: return "into-itself";
	}
	return "?";
}

// memory

static void *grab(void *p, size_t n) {
	void *q = realloc(p, n ? n : 1);
	if (q == NULL) {
		fputs("mutate: out of memory\n", stderr);
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
	op_value *root; // NULL: absent
	pset made;
	int list; // the value is a list: nothing there starts as [], and a list left empty is nothing
	jmp_buf jump;
	int code;
	int tell; // facts wanted
	op_fact seq; // the last splice's sequence, as it was
} work;

static void fail(work *w, int code) {
	w->code = code;
	longjmp(w->jump, 1);
}

// frees one made value, not what it holds that is shared
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
// a value made here that is let go of, and what it holds that was made here
static void drop(work *w, op_value *v) {
	if (!pset_del(&w->made, v)) return;
	for (size_t i = 0; i < v->count; i++) drop(w, v->items[i]);
	shell_free(v);
}
// a made list that only carried its items elsewhere
static void drop_shell(work *w, op_value *v) {
	if (pset_del(&w->made, v)) shell_free(v);
}

static int is_list(const op_value *v) { return v != NULL && v->type == OP_LIST; }
static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

static op_value *made(work *w, op_value *v) {
	pset_add(&w->made, v);
	return v;
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
static op_value *made_list(work *w, size_t count) {
	op_value *l = made(w, op_list());
	if (count) {
		l->items = grab(NULL, count * sizeof *l->items);
		l->capacity = count;
	}
	return l;
}
// a new string of these bytes
static op_value *made_str(work *w, const char *a, size_t na, const char *b, size_t nb,
	const char *c, size_t nc) {
	char *buf = grab(NULL, na + nb + nc + 1);
	memcpy(buf, a, na);
	memcpy(buf + na, b, nb);
	memcpy(buf + na + nb, c, nc);
	buf[na + nb + nc] = 0;
	return made(w, op_str_take(buf, na + nb + nc));
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

// strings: position -> byte offset, the one place the unit is known: code points. A lone
// surrogate is held as WTF-8 (ED A0..BF xx, three bytes): a position of its own
static size_t next(const unsigned char *t, size_t i, size_t end) {
	i++;
	while (i < end && (t[i] & 0xC0) == 0x80) i++;
	return i;
}
// a walk along a string: byte i is at position k
typedef struct {
	size_t i;
	long k;
} finger;
// to position t: 0 when past the end
static int walk_to(const op_value *s, finger *f, long t, size_t *at) {
	const unsigned char *u = (const unsigned char *)s->str;
	while (f->k < t) {
		if (f->i >= s->bytes) return 0;
		f->k++, f->i = next(u, f->i, s->bytes);
	}
	*at = f->i;
	return 1;
}
// the bytes where positions a and b start, and, when total is given, how many positions there
// are; 0 when b is past the end
static int span_bytes(const op_value *s, long a, long b, size_t *x, size_t *y, long *total) {
	if (s->ascii) {
		if ((size_t)a > s->bytes || (size_t)b > s->bytes) return 0;
		*x = (size_t)a, *y = (size_t)b;
		if (total) *total = (long)s->bytes;
		return 1;
	}
	finger f = {0, 0};
	if (!walk_to(s, &f, a, x) || !walk_to(s, &f, b, y)) return 0;
	if (total) {
		const unsigned char *u = (const unsigned char *)s->str;
		for (; f.i < s->bytes; f.i = next(u, f.i, s->bytes)) f.k++;
		*total = f.k;
	}
	return 1;
}
static long str_len(const op_value *s) {
	size_t x, y;
	long n = 0;
	span_bytes(s, 0, 0, &x, &y, &n);
	return n;
}
// a lone high before a lone low at p[j] is one character: joined, the bytes it leaves cut
static void join(char *p, size_t *size, size_t j) {
	unsigned char *u = (unsigned char *)p;
	if (j < 3 || j + 3 > *size) return;
	if (u[j - 3] != 0xED || (u[j - 2] & 0xF0) != 0xA0 || u[j] != 0xED || (u[j + 1] & 0xF0) != 0xB0) return;
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

// keys

static int same_key(op_key a, op_key b) {
	if (a.type != b.type) return 0;
	return a.type == OP_NUM_KEY ? a.n == b.n : strcmp(a.s, b.s) == 0;
}
// where the key of a map is, or -1
static long map_at(const op_value *m, const char *key) {
	op_value *p = op_get(m, key);
	if (p == NULL) return -1;
	for (size_t i = 0; i < m->count; i++)
		if (m->items[i] == p && strcmp(m->keys[i], key) == 0) return (long)i;
	return -1;
}
// the child pointer at k in v, which must be there
static op_value **slot(work *w, op_value *v, op_key k) {
	if (is_list(v)) {
		if (k.type != OP_NUM_KEY) fail(w, OP_WRONG_KIND);
		if ((size_t)k.n >= v->count) fail(w, OP_NO_KEY);
		return &v->items[k.n];
	}
	if (is_map(v)) {
		if (k.type != OP_STR_KEY) fail(w, OP_WRONG_KIND);
		long i = map_at(v, k.s);
		if (i < 0) fail(w, OP_NO_KEY);
		return &v->items[i];
	}
	fail(w, OP_WRONG_KIND);
	return NULL;
}
// what is at path, unchanged
static op_value *get(work *w, const op_key *path, size_t n) {
	op_value *v = w->root;
	if (v == NULL && n) fail(w, OP_NO_KEY);
	for (size_t i = 0; i < n; i++) v = *slot(w, v, path[i]);
	return v;
}
static op_value *copy_in(work *w, op_value *v) {
	if (v == NULL) fail(w, OP_NO_KEY);
	if (!is_list(v) && !is_map(v)) fail(w, OP_WRONG_KIND);
	return own(w, v);
}
// the container holding path's last key, made own along the way
static op_value *parent(work *w, const op_key *path, size_t n) {
	op_value *v = w->root = copy_in(w, w->root);
	for (size_t i = 0; i + 1 < n; i++) {
		op_value **s = slot(w, v, path[i]);
		v = *s = copy_in(w, *s);
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

// what is at path becomes v (NULL: removed, absent at []); the old one is let go of when drop_old
static void set(work *w, const op_key *path, size_t n, op_value *v, int drop_old) {
	if (n == 0) {
		op_value *old = w->root;
		w->root = v;
		if (drop_old && old != v) drop(w, old);
		return;
	}
	op_value *at = parent(w, path, n);
	op_key k = path[n - 1];
	if (is_list(at)) {
		if (k.type != OP_NUM_KEY) fail(w, OP_WRONG_KIND);
		if ((size_t)k.n >= at->count) fail(w, OP_NO_KEY);
		op_value *old = at->items[k.n];
		if (v == NULL) list_splice(at, (size_t)k.n, (size_t)k.n + 1, NULL, 0);
		else at->items[k.n] = v;
		if (drop_old && old != v) drop(w, old);
		return;
	}
	if (k.type != OP_STR_KEY) fail(w, OP_WRONG_KIND);
	long i = map_at(at, k.s);
	if (v != NULL && i < 0) {
		op_set(at, k.s, v);
		return;
	}
	if (i < 0) return;
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
	if (drop_old && old != v) drop(w, old);
}

// the span [a, b) of what is at path replaced by v (NULL: removed). taken: what was there, made,
// when asked for; else it is let go of. count: a string's positions are counted, for seq
static void splice(work *w, const op_key *path, size_t n, long a, long b, op_value *v,
	op_value **taken, int count) {
	op_value *s = get(w, path, n);
	if (a > b) fail(w, OP_RANGE);
	if (s == NULL || (s->type != OP_STR && s->type != OP_LIST && s->type != OP_TYPED))
		fail(w, OP_WRONG_KIND);
	op_value *out;
	if (s->type == OP_STR) {
		size_t x, y;
		long total = 0;
		if (!span_bytes(s, a, b, &x, &y, count ? &total : NULL)) fail(w, OP_RANGE);
		if (v != NULL && v->type != OP_STR) fail(w, OP_WRONG_KIND);
		w->seq = (op_fact){0, (size_t)total, 1};
		if (taken) *taken = made_str(w, "", 0, s->str + x, y - x, "", 0);
		size_t nv = v ? v->bytes : 0, post = s->bytes - y;
		char *buf = grab(NULL, x + nv + post + 1);
		memcpy(buf, s->str, x);
		if (nv) memcpy(buf + x, v->str, nv);
		memcpy(buf + x + nv, s->str + y, post);
		size_t size = x + nv + post;
		// a lone high met by a lone low at either edge: one character again
		join(buf, &size, x + nv);
		if (nv) join(buf, &size, x);
		buf[size] = 0;
		out = made(w, op_str_take(buf, size));
		set(w, path, n, out, 0);
		drop(w, s);
		if (v) drop(w, v);
		return;
	}
	if (s->type == OP_TYPED) {
		size_t z = op_size(s->kind), x = (size_t)a * z, y = (size_t)b * z;
		if ((size_t)b > op_length(s)) fail(w, OP_RANGE);
		w->seq = (op_fact){0, op_length(s), 1};
		if (v != NULL && (v->type != OP_TYPED || v->kind != s->kind)) fail(w, OP_WRONG_KIND);
		if (taken) *taken = made_typed(w, s->kind, s->data + x, y - x, NULL, 0, NULL, 0);
		out = made_typed(w, s->kind, s->data, x, v ? v->data : NULL, v ? v->bytes : 0, s->data + y,
			s->bytes - y);
		set(w, path, n, out, 0);
		drop(w, s);
		if (v) drop(w, v);
		return;
	}
	if ((size_t)b > s->count) fail(w, OP_RANGE);
	if (v != NULL && v->type != OP_LIST) fail(w, OP_WRONG_KIND);
	w->seq = (op_fact){1, s->count, 1};
	out = own(w, s);
	size_t gone = (size_t)(b - a);
	if (taken) {
		*taken = made_list(w, gone);
		memcpy((*taken)->items, out->items + a, gone * sizeof *out->items);
		(*taken)->count = gone;
	} else {
		for (size_t i = 0; i < gone; i++) drop(w, out->items[a + i]);
	}
	list_splice(out, (size_t)a, (size_t)b, v ? v->items : NULL, v ? v->count : 0);
	if (v) drop_shell(w, v);
	set(w, path, n, out, 0);
}

// what notify reads at an unranged place, as the content is now; nothing checked
static op_fact fact(work *w, const op_key *path, size_t n) {
	if (n == 0) return (op_fact){0, 0, w->root != NULL && !(w->list && is_list(w->root) && !w->root->count)};
	const op_value *v = w->root;
	for (size_t i = 0; i + 1 < n && v != NULL; i++) {
		op_key k = path[i];
		if (is_list(v)) v = k.type == OP_NUM_KEY && (size_t)k.n < v->count ? v->items[k.n] : NULL;
		else if (is_map(v)) v = k.type == OP_STR_KEY ? op_get(v, k.s) : NULL;
		else v = NULL;
	}
	op_key k = path[n - 1];
	if (is_list(v)) return (op_fact){1, v->count, k.type == OP_NUM_KEY && (size_t)k.n < v->count};
	return (op_fact){0, 0, is_map(v) && k.type == OP_STR_KEY && op_get(v, k.s) != NULL};
}

// takes what is at a place out; what it was. the sequence a ranged one left is seq
static op_value *take(work *w, const op_target *p, int count) {
	if (p->has_range) {
		op_value *t;
		splice(w, p->path, p->length, p->from, p->to, NULL, &t, count);
		return t;
	}
	op_value *v = get(w, p->path, p->length);
	set(w, p->path, p->length, NULL, 0);
	return v;
}

static int same_path(const op_target *a, const op_target *b) {
	if (a->length != b->length) return 0;
	for (size_t i = 0; i < a->length; i++)
		if (!same_key(a->path[i], b->path[i])) return 0;
	return 1;
}

// p's place lies inside what from takes: under its path, or in its span
static int under(const op_target *p, const op_target *from) {
	if (p->length < from->length) return 0;
	for (size_t i = 0; i < from->length; i++)
		if (!same_key(from->path[i], p->path[i])) return 0;
	if (!from->has_range) return p->length > from->length;
	if (p->length == from->length) return 0;
	op_key k = p->path[from->length];
	return k.type == OP_NUM_KEY && k.n >= from->from && k.n < from->to;
}

static void step(work *w, const op_patch *p, op_facts *out) {
	const op_target *pl = &p->place;
	if (w->root == NULL && (pl->length || pl->has_range || !p->has_value)) fail(w, OP_NO_KEY);
	if (p->has_move) {
		const op_target *from = &p->move;
		if (under(pl, from)) fail(w, OP_INTO_ITSELF);
		// onto itself, a key or an element or the whole: nothing changes, once it is there
		if (!pl->has_range && !from->has_range && same_path(pl, from)) {
			(void)get(w, from->path, from->length);
			if (w->tell) {
				op_fact here = fact(w, pl->path, pl->length);
				*out = (op_facts){.place = here, .has_from = 1, .from = here};
			}
			return;
		}
		op_fact was = {0};
		if (w->tell && !from->has_range) was = fact(w, from->path, from->length);
		op_value *moved = take(w, from, w->tell);
		if (w->tell && from->has_range) was = w->seq;
		if (!pl->has_range) {
			op_fact place = {0};
			if (w->tell) place = fact(w, pl->path, pl->length);
			set(w, pl->path, pl->length, moved, 1);
			if (w->tell) *out = (op_facts){.place = place, .has_from = 1, .from = was};
			return;
		}
		op_value *v = get(w, pl->path, pl->length);
		// one element into a list's span: as a list of one
		op_value *wv = moved;
		int listy = is_list(v);
		// a string moved into a string: its positions, before it is let go of
		size_t size = from->has_range ? (size_t)(from->to - from->from)
			: listy ? 1
			: moved != NULL && moved->type == OP_STR ? (size_t)str_len(moved)
			: moved != NULL && moved->type == OP_TYPED ? op_length(moved) : 0;
		if (listy && !from->has_range) {
			wv = made_list(w, 1);
			wv->items[0] = moved;
			wv->count = 1;
		}
		splice(w, pl->path, pl->length, pl->from, pl->to, wv, NULL, w->tell);
		if (!w->tell) return;
		*out = (op_facts){.place = w->seq, .has_from = 1, .from = was, .has_size = 1, .size = size};
		return;
	}
	op_value *v = p->has_value ? (op_value *)p->value : NULL;
	if (pl->has_range) {
		splice(w, pl->path, pl->length, pl->from, pl->to, v, NULL, w->tell);
		if (w->tell) *out = (op_facts){.place = w->seq};
		return;
	}
	if (w->tell) *out = (op_facts){.place = fact(w, pl->path, pl->length)};
	if (v == NULL && p->has_value) fail(w, OP_NOT_A_PATCH);
	// removing a missing map key: nothing
	if (v == NULL && pl->length) {
		op_value *at = get(w, pl->path, pl->length - 1);
		op_key k = pl->path[pl->length - 1];
		if (is_map(at) && k.type == OP_STR_KEY && op_get(at, k.s) == NULL) return;
	}
	set(w, pl->path, pl->length, v, 1);
}

static int place_ok(const op_target *p) {
	for (size_t i = 0; i < p->length; i++) {
		op_key k = p->path[i];
		if (k.type == OP_NUM_KEY ? k.n < 0 : k.type != OP_STR_KEY || k.s == NULL) return 0;
	}
	return !p->has_range || (p->from >= 0 && p->to >= 0);
}
static int shape(const op_patch *p) {
	if (!place_ok(&p->place)) return 0;
	if (p->has_move) return !p->has_value && place_ok(&p->move);
	return 1;
}

// the new content takes its references: a made value is held by its parent, a shared one gets
// one more holder
static void hold(work *w, op_value *v) {
	if (v == NULL) return;
	if (!pset_has(&w->made, v)) {
		op_ref(v);
		return;
	}
	for (size_t i = 0; i < v->count; i++) hold(w, v->items[i]);
}

static void let_go(work *w) {
	for (size_t j = 0; j < w->made.cap; j++)
		if (w->made.slots[j] != NULL && w->made.slots[j] != GONE) shell_free((op_value *)w->made.slots[j]);
	free(w->made.slots);
}

int op_apply(const op_value *value, const op_patch *patches, size_t n,
	const op_apply_options *options, op_value **out, size_t *failed) {
	int list = options != NULL && options->list;
	int tell = options != NULL && options->each != NULL;
	work w = {.root = (op_value *)value, .list = list, .tell = tell};
	op_facts *seen = tell && n ? grab(NULL, n * sizeof *seen) : NULL;
	volatile size_t i = 0;
	if (setjmp(w.jump)) {
		// what was made here is left to go
		let_go(&w);
		free(seen);
		if (failed) *failed = i;
		return w.code;
	}
	// a list starts as []
	if (list && w.root == NULL) w.root = made_list(&w, 0);
	for (; i < n; i++) {
		if (!shape(&patches[i])) fail(&w, OP_NOT_A_PATCH);
		op_facts f = {0};
		step(&w, &patches[i], &f);
		if (list && w.root != NULL && !is_list(w.root)) fail(&w, OP_WRONG_KIND);
		if (seen) seen[i] = f;
	}
	// nothing there: none; a list left empty is that too
	int gone = w.root == NULL || (list && is_list(w.root) && w.root->count == 0);
	if (gone) {
		// what is left of the made is let go of
		*out = NULL;
		let_go(&w);
	} else {
		hold(&w, w.root);
		*out = w.root;
		free(w.made.slots);
	}
	if (tell) {
		for (size_t j = 0; j < n; j++) options->each(options->ctx, &patches[j], &seen[j]);
	}
	free(seen);
	return OP_OK;
}
