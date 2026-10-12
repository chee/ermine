// mutate (newcore/opstreams/ts/mutate.ts), in C, on nt_value contents. Same rules, same order of checks.
// Memory: what a patch touches is a copy made here (the "made" set), changed in place for the
// rest of the call; everything else is shared and never freed. Values made here and dropped
// again within the call are freed; values given are never. Once the call is good, the new content
// takes its references (hold): a made value has its one holder, its parent; a shared one an nt_ref.
// A children list is made into nt_values (its items: the "given" set) and back.
#include "mutate.h"

#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

const char *mu_code_name(int code) {
	switch (code) {
	case MU_OK: return "ok";
	case MU_NOT_A_PATCH: return "not-a-patch";
	case MU_NO_KEY: return "no-key";
	case MU_RANGE: return "range";
	case MU_WRONG_KIND: return "wrong-kind";
	case MU_INTO_ITSELF: return "into-itself";
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
	nt_value *root; // NULL: absent
	pset made;
	int list; // a children list
	pset given; // a children list's items as given, each num its place there
	jmp_buf jump;
	int code;
	int tell; // facts wanted
	mu_fact seq; // the last splice's sequence, as it was
} work;

static void fail(work *w, int code) {
	w->code = code;
	longjmp(w->jump, 1);
}

// frees one made value, not what it holds that is shared
static void shell_free(nt_value *v) {
	if (v->type == NT_MAP)
		for (size_t i = 0; i < v->count; i++) free(v->keys[i]);
	free(v->items);
	free(v->keys);
	free(v->index);
	free(v->str);
	free(v->data);
	free(v);
}
// a value made here that is let go of, and what it holds that was made here
static void drop(work *w, nt_value *v) {
	if (!pset_del(&w->made, v)) return;
	for (size_t i = 0; i < v->count; i++) drop(w, v->items[i]);
	shell_free(v);
}
// a made list that only carried its items elsewhere
static void drop_shell(work *w, nt_value *v) {
	if (pset_del(&w->made, v)) shell_free(v);
}

static int is_list(const nt_value *v) { return v != NULL && v->type == NT_LIST; }
static int is_map(const nt_value *v) { return v != NULL && v->type == NT_MAP; }

static nt_value *made(work *w, nt_value *v) {
	pset_add(&w->made, v);
	return v;
}
// a new typed array of these bytes
static nt_value *made_typed(work *w, nt_elements kind, const unsigned char *a, size_t na,
	const unsigned char *b, size_t nb, const unsigned char *c, size_t nc) {
	nt_value *t = made(w, nt_typed(kind, NULL, 0));
	t->data = grab(t->data, na + nb + nc);
	if (na) memcpy(t->data, a, na);
	if (nb) memcpy(t->data + na, b, nb);
	if (nc) memcpy(t->data + na + nb, c, nc);
	t->bytes = na + nb + nc;
	return t;
}
static nt_value *made_list(work *w, size_t count) {
	nt_value *l = made(w, nt_list());
	if (count) {
		l->items = grab(NULL, count * sizeof *l->items);
		l->capacity = count;
	}
	return l;
}
// a new string of these bytes
static nt_value *made_str(work *w, const char *a, size_t na, const char *b, size_t nb,
	const char *c, size_t nc) {
	char *buf = grab(NULL, na + nb + nc + 1);
	memcpy(buf, a, na);
	memcpy(buf + na, b, nb);
	memcpy(buf + na + nb, c, nc);
	buf[na + nb + nc] = 0;
	nt_value *s = made(w, nt_str(buf));
	free(buf);
	return s;
}

// a copy to change in place: v itself when it was made here
static nt_value *own(work *w, nt_value *v) {
	if (pset_has(&w->made, v)) return v;
	nt_value *c = made(w, v->type == NT_MAP ? nt_map() : nt_list());
	if (v->count) {
		c->items = grab(NULL, v->count * sizeof *c->items);
		memcpy(c->items, v->items, v->count * sizeof *c->items);
		c->capacity = c->count = v->count;
		if (v->type == NT_MAP) {
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
static int walk_to(const nt_value *s, finger *f, long t, size_t *at) {
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
static int span_bytes(const nt_value *s, long a, long b, size_t *x, size_t *y, long *total) {
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
static long str_len(const nt_value *s) {
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

static int same_key(nt_key a, nt_key b) {
	if (a.type != b.type) return 0;
	return a.type == NT_NUM_KEY ? a.n == b.n : strcmp(a.s, b.s) == 0;
}
// where the key of a map is, or -1
static long map_at(const nt_value *m, const char *key) {
	nt_value *p = nt_get(m, key);
	if (p == NULL) return -1;
	for (size_t i = 0; i < m->count; i++)
		if (m->items[i] == p && strcmp(m->keys[i], key) == 0) return (long)i;
	return -1;
}
// the child pointer at k in v, which must be there
static nt_value **slot(work *w, nt_value *v, nt_key k) {
	if (is_list(v)) {
		if (k.type != NT_NUM_KEY) fail(w, MU_WRONG_KIND);
		if ((size_t)k.n >= v->count) fail(w, MU_NO_KEY);
		return &v->items[k.n];
	}
	if (is_map(v)) {
		if (k.type != NT_STR_KEY) fail(w, MU_WRONG_KIND);
		long i = map_at(v, k.s);
		if (i < 0) fail(w, MU_NO_KEY);
		return &v->items[i];
	}
	fail(w, MU_WRONG_KIND);
	return NULL;
}
// what is at path, unchanged
static nt_value *get(work *w, const nt_key *path, size_t n) {
	nt_value *v = w->root;
	if (v == NULL && n) fail(w, MU_NO_KEY);
	for (size_t i = 0; i < n; i++) v = *slot(w, v, path[i]);
	return v;
}
static nt_value *copy_in(work *w, nt_value *v) {
	if (v == NULL) fail(w, MU_NO_KEY);
	if (!is_list(v) && !is_map(v)) fail(w, MU_WRONG_KIND);
	return own(w, v);
}
// the container holding path's last key, made own along the way
static nt_value *parent(work *w, const nt_key *path, size_t n) {
	nt_value *v = w->root = copy_in(w, w->root);
	for (size_t i = 0; i + 1 < n; i++) {
		nt_value **s = slot(w, v, path[i]);
		v = *s = copy_in(w, *s);
	}
	return v;
}

static void list_splice(nt_value *l, size_t a, size_t b, nt_value *const *ws, size_t wn) {
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
static void set(work *w, const nt_key *path, size_t n, nt_value *v, int drop_old) {
	if (n == 0) {
		nt_value *old = w->root;
		w->root = v;
		if (drop_old && old != v) drop(w, old);
		return;
	}
	nt_value *at = parent(w, path, n);
	nt_key k = path[n - 1];
	if (is_list(at)) {
		if (k.type != NT_NUM_KEY) fail(w, MU_WRONG_KIND);
		if ((size_t)k.n >= at->count) fail(w, MU_NO_KEY);
		nt_value *old = at->items[k.n];
		if (v == NULL) list_splice(at, (size_t)k.n, (size_t)k.n + 1, NULL, 0);
		else at->items[k.n] = v;
		if (drop_old && old != v) drop(w, old);
		return;
	}
	if (k.type != NT_STR_KEY) fail(w, MU_WRONG_KIND);
	long i = map_at(at, k.s);
	if (v != NULL && i < 0) {
		nt_set(at, k.s, v);
		return;
	}
	if (i < 0) return;
	nt_value *old = at->items[i];
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
static void splice(work *w, const nt_key *path, size_t n, long a, long b, nt_value *v,
	nt_value **taken, int count) {
	nt_value *s = get(w, path, n);
	if (s == NULL || (s->type != NT_STR && s->type != NT_LIST && s->type != NT_TYPED))
		fail(w, MU_WRONG_KIND);
	if (a > b) fail(w, MU_RANGE);
	nt_value *out;
	if (s->type == NT_STR) {
		if (v != NULL && v->type != NT_STR) fail(w, MU_WRONG_KIND);
		size_t x, y;
		long total = 0;
		if (!span_bytes(s, a, b, &x, &y, count ? &total : NULL)) fail(w, MU_RANGE);
		w->seq = (mu_fact){0, (size_t)total, 1};
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
		out = made(w, nt_str(buf));
		free(buf);
		set(w, path, n, out, 0);
		drop(w, s);
		if (v) drop(w, v);
		return;
	}
	if (s->type == NT_TYPED) {
		size_t z = nt_size(s->kind), x = (size_t)a * z, y = (size_t)b * z;
		if ((size_t)b > nt_length(s)) fail(w, MU_RANGE);
		w->seq = (mu_fact){0, nt_length(s), 1};
		if (v != NULL && (v->type != NT_TYPED || v->kind != s->kind)) fail(w, MU_WRONG_KIND);
		if (taken) *taken = made_typed(w, s->kind, s->data + x, y - x, NULL, 0, NULL, 0);
		out = made_typed(w, s->kind, s->data, x, v ? v->data : NULL, v ? v->bytes : 0, s->data + y,
			s->bytes - y);
		set(w, path, n, out, 0);
		drop(w, s);
		if (v) drop(w, v);
		return;
	}
	if ((size_t)b > s->count) fail(w, MU_RANGE);
	if (v != NULL && v->type != NT_LIST) fail(w, MU_WRONG_KIND);
	w->seq = (mu_fact){1, s->count, 1};
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
static mu_fact fact(work *w, const nt_key *path, size_t n) {
	if (n == 0) return (mu_fact){0, 0, w->root != NULL && !(w->list && is_list(w->root) && !w->root->count)};
	const nt_value *v = w->root;
	for (size_t i = 0; i + 1 < n && v != NULL; i++) {
		nt_key k = path[i];
		if (is_list(v)) v = k.type == NT_NUM_KEY && (size_t)k.n < v->count ? v->items[k.n] : NULL;
		else if (is_map(v)) v = k.type == NT_STR_KEY ? nt_get(v, k.s) : NULL;
		else v = NULL;
	}
	nt_key k = path[n - 1];
	if (is_list(v)) return (mu_fact){1, v->count, k.type == NT_NUM_KEY && (size_t)k.n < v->count};
	return (mu_fact){0, 0, is_map(v) && k.type == NT_STR_KEY && nt_get(v, k.s) != NULL};
}

// takes what is at a place out; what it was. the sequence a ranged one left is seq
static nt_value *take(work *w, const nt_place *p, int count) {
	if (p->has_range) {
		nt_value *t;
		splice(w, p->path, p->length, p->from, p->to, NULL, &t, count);
		return t;
	}
	nt_value *v = get(w, p->path, p->length);
	set(w, p->path, p->length, NULL, 0);
	return v;
}

// p's place lies inside what from takes: under its path, or in its span
static int under(const nt_place *p, const nt_place *from) {
	if (p->length < from->length) return 0;
	for (size_t i = 0; i < from->length; i++)
		if (!same_key(from->path[i], p->path[i])) return 0;
	if (!from->has_range) return p->length > from->length;
	if (p->length == from->length) return 0;
	nt_key k = p->path[from->length];
	return k.type == NT_NUM_KEY && k.n >= from->from && k.n < from->to;
}

static void apply(work *w, const nt_patch *p, mu_facts *out) {
	const nt_place *pl = &p->place;
	if (w->root == NULL && (pl->length || pl->has_range || !p->has_value)) fail(w, MU_NO_KEY);
	if (p->has_move) {
		const nt_place *from = &p->move;
		if (under(pl, from)) fail(w, MU_INTO_ITSELF);
		mu_fact was = {0};
		if (w->tell && !from->has_range) was = fact(w, from->path, from->length);
		nt_value *moved = take(w, from, w->tell);
		if (w->tell && from->has_range) was = w->seq;
		if (!pl->has_range) {
			// the whole onto itself: notify does not see the take, so the place is as it was
			mu_fact place = {0};
			if (w->tell) place = !pl->length && !from->length ? was : fact(w, pl->path, pl->length);
			set(w, pl->path, pl->length, moved, 1);
			if (w->tell) *out = (mu_facts){.place = place, .has_from = 1, .from = was};
			return;
		}
		nt_value *v = get(w, pl->path, pl->length);
		// one element into a list's span: as a list of one
		nt_value *wv = moved;
		int listy = is_list(v);
		// a string moved into a string: its positions, before it is let go of
		size_t size = from->has_range ? (size_t)(from->to - from->from)
			: listy ? 1
			: moved != NULL && moved->type == NT_STR ? (size_t)str_len(moved)
			: moved != NULL && moved->type == NT_TYPED ? nt_length(moved) : 0;
		if (listy && !from->has_range) {
			wv = made_list(w, 1);
			wv->items[0] = moved;
			wv->count = 1;
		}
		splice(w, pl->path, pl->length, pl->from, pl->to, wv, NULL, w->tell);
		if (!w->tell) return;
		*out = (mu_facts){.place = w->seq, .has_from = 1, .from = was, .has_size = 1, .size = size};
		return;
	}
	nt_value *v = p->has_value ? (nt_value *)p->value : NULL;
	if (pl->has_range) {
		splice(w, pl->path, pl->length, pl->from, pl->to, v, NULL, w->tell);
		if (w->tell) *out = (mu_facts){.place = w->seq};
		return;
	}
	if (w->tell) *out = (mu_facts){.place = fact(w, pl->path, pl->length)};
	if (v == NULL && p->has_value) fail(w, MU_NOT_A_PATCH);
	// removing a missing map key: nothing
	if (v == NULL && pl->length) {
		nt_value *at = get(w, pl->path, pl->length - 1);
		nt_key k = pl->path[pl->length - 1];
		if (is_map(at) && k.type == NT_STR_KEY && nt_get(at, k.s) == NULL) return;
	}
	set(w, pl->path, pl->length, v, 1);
}

static int place_ok(const nt_place *p) {
	for (size_t i = 0; i < p->length; i++) {
		nt_key k = p->path[i];
		if (k.type == NT_NUM_KEY ? k.n < 0 : k.type != NT_STR_KEY || k.s == NULL) return 0;
	}
	return !p->has_range || (p->from >= 0 && p->to >= 0);
}
static int shape(const nt_patch *p) {
	if (!place_ok(&p->place)) return 0;
	if (p->has_move) return !p->has_value && place_ok(&p->move);
	return 1;
}

// the new content takes its references: a made value is held by its parent, a shared one gets
// one more holder
static void hold(work *w, nt_value *v) {
	if (v == NULL) return;
	if (!pset_has(&w->made, v)) {
		nt_ref(v);
		return;
	}
	for (size_t i = 0; i < v->count; i++) hold(w, v->items[i]);
}

// An item that is neither an id nor a symbol (mutate.h) is a symbol item named by this text:
// \x01, then the value: n; t; f; d + 16 hex digits of the double; s<len>:<bytes>; l<count>:<items>;
// m<count>:<<keylen>:<key><value>...>; b<len>:<hex>; x<kind> (a stand-in over its kind's text); y<kind>:<len>:<hex> (a typed array, len bytes)
static const char hexd[] = "0123456789abcdef";
typedef struct {
	char *p;
	size_t n, cap;
} text;
static void put(text *t, const void *data, size_t n) {
	if (t->n + n + 1 > t->cap) t->p = grab(t->p, t->cap = (t->n + n + 1) * 2);
	memcpy(t->p + t->n, data, n);
	t->n += n;
}
// tag (if any), n, and a colon
static void put_size(text *t, char tag, size_t n) {
	char buf[32];
	size_t k = (size_t)snprintf(buf, sizeof buf, "%zu:", n);
	if (tag) put(t, &tag, 1);
	put(t, buf, k);
}
static void put_hex(text *t, const unsigned char *d, size_t n) {
	for (size_t i = 0; i < n; i++) put(t, &hexd[d[i] >> 4], 1), put(t, &hexd[d[i] & 15], 1);
}
static void encode(text *t, const nt_value *v) {
	switch (v->type) {
	case NT_NULL: put(t, "n", 1); break;
	case NT_BOOL: put(t, v->bool_ ? "t" : "f", 1); break;
	case NT_NUM: {
		uint64_t u;
		char buf[20];
		memcpy(&u, &v->num, 8);
		put(t, buf, (size_t)snprintf(buf, sizeof buf, "d%016llx", (unsigned long long)u));
		break;
	}
	case NT_STR:
		put_size(t, 's', v->bytes);
		put(t, v->str, v->bytes);
		break;
	case NT_LIST:
		put_size(t, 'l', v->count);
		for (size_t i = 0; i < v->count; i++) encode(t, v->items[i]);
		break;
	case NT_MAP:
		put_size(t, 'm', v->count);
		for (size_t i = 0; i < v->count; i++) {
			put_size(t, 0, strlen(v->keys[i]));
			put(t, v->keys[i], strlen(v->keys[i]));
			encode(t, v->items[i]);
		}
		break;
	case NT_STAND:
		put(t, "x", 1);
		encode(t, v->items[0]);
		break;
	case NT_BYTES:
		put_size(t, 'b', v->bytes);
		put_hex(t, v->data, v->bytes);
		break;
	case NT_TYPED: {
		char buf[32];
		put(t, buf, (size_t)snprintf(buf, sizeof buf, "y%d:%zu:", (int)v->kind, v->bytes));
		put_hex(t, v->data, v->bytes);
		break;
	}
	}
}
// the text of a non-id item, made with the alloc
static char *item_text(const nt_value *v, const mu_alloc *alloc) {
	text t = {0};
	put(&t, "\x01", 1);
	encode(&t, v);
	char *r = alloc->alloc(alloc->ctx, t.n + 1);
	memcpy(r, t.p, t.n);
	r[t.n] = 0;
	free(t.p);
	return r;
}
// reading it back; NULL when it is no such text. every value made is in the made set (what a
// failed read made is let go of with the rest at the end)
static int size_in(const char **s, const char *end, size_t *n) {
	if (*s >= end || **s < '0' || **s > '9') return 0;
	size_t x = 0;
	for (; *s < end && **s >= '0' && **s <= '9'; (*s)++) x = x * 10 + (size_t)(**s - '0');
	if (*s >= end || **s != ':') return 0;
	(*s)++;
	*n = x;
	return 1;
}
static int hex_in(const char **s, const char *end, size_t n, unsigned char *out) {
	if ((size_t)(end - *s) / 2 < n) return 0;
	for (size_t i = 0; i < n; i++, *s += 2) {
		const char *a = memchr(hexd, (*s)[0], 16), *b = memchr(hexd, (*s)[1], 16);
		if (!a || !b) return 0;
		out[i] = (unsigned char)((a - hexd) << 4 | (b - hexd));
	}
	return 1;
}
static nt_value *decode(work *w, const char **s, const char *end) {
	if (*s >= end) return NULL;
	char c = *(*s)++;
	size_t n;
	switch (c) {
	case 'n': return made(w, nt_null());
	case 't': return made(w, nt_bool(1));
	case 'f': return made(w, nt_bool(0));
	case 'd': {
		unsigned char b[8];
		double d;
		if (!hex_in(s, end, 8, b)) return NULL;
		uint64_t u = 0;
		for (int i = 0; i < 8; i++) u = u << 8 | b[i];
		memcpy(&d, &u, 8);
		return made(w, nt_num(d));
	}
	case 's': {
		if (!size_in(s, end, &n) || (size_t)(end - *s) < n) return NULL;
		char *buf = grab(NULL, n + 1);
		memcpy(buf, *s, n);
		buf[n] = 0;
		*s += n;
		nt_value *v = made(w, nt_str(buf));
		free(buf);
		return v;
	}
	case 'l':
	case 'm': {
		if (!size_in(s, end, &n)) return NULL;
		nt_value *v = made(w, c == 'l' ? nt_list() : nt_map());
		for (size_t i = 0; i < n; i++) {
			char *key = NULL;
			if (c == 'm') {
				size_t k;
				if (!size_in(s, end, &k) || (size_t)(end - *s) < k) return NULL;
				key = grab(NULL, k + 1);
				memcpy(key, *s, k);
				key[k] = 0;
				*s += k;
			}
			nt_value *item = decode(w, s, end);
			if (item == NULL) return free(key), NULL;
			if (c == 'l') nt_push(v, item);
			else nt_set(v, key, item), free(key);
		}
		return v;
	}
	case 'x': {
		nt_value *kind = decode(w, s, end);
		return kind == NULL ? NULL : made(w, nt_stand(kind));
	}
	case 'b': {
		if (!size_in(s, end, &n) || (size_t)(end - *s) / 2 < n) return NULL;
		unsigned char *buf = grab(NULL, n);
		if (!hex_in(s, end, n, buf)) return free(buf), NULL;
		nt_value *v = made(w, nt_bytes(buf, n));
		free(buf);
		return v;
	}
	case 'y': {
		if (*s >= end || **s < '0' || **s > '9') return NULL;
		int kind = *(*s)++ - '0';
		if (*s >= end || *(*s)++ != ':' || !size_in(s, end, &n) || (size_t)(end - *s) / 2 < n) return NULL;
		size_t z = nt_size((nt_elements)kind);
		unsigned char *buf = grab(NULL, n);
		if (n % z || !hex_in(s, end, n, buf)) return free(buf), NULL;
		nt_value *v = made(w, nt_typed((nt_elements)kind, buf, n / z));
		free(buf);
		return v;
	}
	}
	return NULL;
}
// the value a non-id item stands for, made fresh (in w's made set when w is given: the call's
// own to hold or drop); NULL when it is a plain symbol
static nt_value *item_of(work *w, const char *symbol) {
	if (symbol == NULL || symbol[0] != '\x01') return NULL;
	const char *s = symbol + 1, *end = symbol + strlen(symbol);
	work t = {0};
	nt_value *v = decode(&t, &s, end);
	int ok = v != NULL && s == end;
	for (size_t j = 0; j < t.made.cap; j++) {
		nt_value *m = (nt_value *)t.made.slots[j];
		if (m == NULL || m == GONE) continue;
		if (ok && w) pset_add(&w->made, m);
		else if (!ok) shell_free(m);
	}
	free(t.made.slots);
	return ok ? v : NULL;
}

// a children list's content, as nt_values: an id a string, a symbol a null of its own, any other
// item (its text above) the value it stands for
static nt_value *list_in(work *w, const nd_list *l) {
	size_t n = l ? l->length : 0;
	nt_value *r = made_list(w, n);
	for (size_t i = 0; i < n; i++) {
		nt_value *v = l->items[i].id ? nt_str(l->items[i].id) : item_of(w, l->items[i].symbol);
		if (v != NULL && !l->items[i].id) {
			r->items[r->count++] = v;
			continue;
		}
		if (v == NULL) v = nt_null();
		v->num = (double)i;
		pset_add(&w->given, v);
		r->items[r->count++] = v;
	}
	return r;
}
// still a list
static void list_ok(work *w) {
	if (w->root != NULL && !is_list(w->root)) fail(w, MU_WRONG_KIND);
}
// an item not given: a string an id, else its text
static nd_item item_out(const nt_value *v, const mu_alloc *alloc) {
	if (v->type != NT_STR) return (nd_item){NULL, item_text(v, alloc)};
	char *id = alloc->alloc(alloc->ctx, v->bytes + 1);
	memcpy(id, v->str, v->bytes + 1);
	return (nd_item){id, NULL};
}
// and back, with the alloc; an item kept keeps its pointers
static nd_list *list_out(work *w, const nd_list *was, const mu_alloc *alloc) {
	nd_list *l = alloc->alloc(alloc->ctx, sizeof *l);
	size_t n = w->root->count;
	nd_item *items = n ? alloc->alloc(alloc->ctx, n * sizeof *items) : NULL;
	for (size_t i = 0; i < n; i++) {
		nt_value *v = w->root->items[i];
		if (pset_has(&w->given, v)) items[i] = was->items[(size_t)v->num];
		else items[i] = item_out(v, alloc);
	}
	*l = (nd_list){items, n};
	return l;
}
nd_list *mu_list_to(const nt_value *list, const mu_alloc *alloc) {
	nd_list *l = alloc->alloc(alloc->ctx, sizeof *l);
	size_t n = list->count;
	nd_item *items = n ? alloc->alloc(alloc->ctx, n * sizeof *items) : NULL;
	for (size_t i = 0; i < n; i++) items[i] = item_out(list->items[i], alloc);
	*l = (nd_list){items, n};
	return l;
}
nt_value *mu_list_of(const nd_list *l) {
	nt_value *r = nt_list();
	for (size_t i = 0; l && i < l->length; i++) {
		nt_value *v = l->items[i].id ? nt_str(l->items[i].id) : item_of(NULL, l->items[i].symbol);
		nt_push(r, v ? v : nt_null());
	}
	return r;
}
// what the call made, and a children list's items as given, let go of; values given never
static void let_go(work *w) {
	for (size_t j = 0; j < w->made.cap; j++)
		if (w->made.slots[j] != NULL && w->made.slots[j] != GONE) shell_free((nt_value *)w->made.slots[j]);
	for (size_t j = 0; j < w->given.cap; j++)
		if (w->given.slots[j] != NULL && w->given.slots[j] != GONE) nt_free((nt_value *)w->given.slots[j]);
	free(w->made.slots);
	free(w->given.slots);
}

int mu_mutate(nd_node *node, mu_which which, const nt_patch *patches, size_t n, const void *change,
	const mu_alloc *alloc, const mu_patched *patched, size_t *failed) {
	// the object's versions on the node
	int list = which.kind == MU_CHILDREN;
	nd_entry **entries = list ? &node->children : &node->info;
	size_t *entries_length = list ? &node->children_length : &node->info_length;
	nd_object *obj = &node->value;
	nd_entry *entry = NULL;
	if (which.kind != MU_VALUE) {
		for (size_t i = 0; i < *entries_length; i++)
			if (strcmp((*entries)[i].name, which.name) == 0) entry = &(*entries)[i];
		obj = entry ? &entry->object : NULL;
	}
	size_t had = obj ? obj->length : 0;
	const nd_version *before = obj ? obj->versions : NULL;

	work w = {.root = had && !list ? (nt_value *)before[0].content : NULL, .list = list,
		.tell = patched != NULL};
	mu_facts *seen = patched && n ? grab(NULL, n * sizeof *seen) : NULL;
	volatile size_t i = 0;
	if (setjmp(w.jump)) {
		// what was made here is left to go
		let_go(&w);
		free(seen);
		if (failed) *failed = i;
		return w.code;
	}
	// a list starts as []
	if (list) w.root = list_in(&w, had ? before[0].content : NULL);
	for (; i < n; i++) {
		if (!shape(&patches[i])) fail(&w, MU_NOT_A_PATCH);
		mu_facts f = {0};
		apply(&w, &patches[i], &f);
		if (list) list_ok(&w);
		if (seen) seen[i] = f;
	}

	// the new versions: the first becomes the new content, the rest as they were. a list left
	// with nothing: its first removed
	int gone = w.root == NULL || (list && w.root->count == 0);
	const void *content = NULL;
	if (!gone && list) content = list_out(&w, had ? before[0].content : NULL, alloc);
	else if (!gone) hold(&w, w.root);
	size_t rest = had ? had - 1 : 0;
	size_t count = rest + !gone;
	nd_version *vs = NULL;
	if (count) {
		vs = alloc->alloc(alloc->ctx, count * sizeof *vs);
		size_t at = 0;
		if (!gone) {
			vs[0] = (nd_version){.content = content ? content : w.root, .change = change,
				.because = had ? before[0].because : NULL};
			at = 1;
		}
		if (rest) memcpy(vs + at, before + 1, rest * sizeof *vs);
		// the new array's own holds of the contents it shares
		for (size_t j = at; !list && j < count; j++) nt_ref((nt_value *)vs[j].content);
	}
	if (list) let_go(&w);
	else {
		free(w.made.slots);
		free(w.given.slots);
	}
	if (which.kind == MU_VALUE) {
		node->value = (nd_object){vs, count};
	} else if (entry != NULL || count) {
		// the entries array is made again, the old one left as it was
		size_t at = entry ? (size_t)(entry - *entries) : *entries_length;
		size_t total = *entries_length + (entry == NULL) - (count == 0);
		nd_entry *es = total ? alloc->alloc(alloc->ctx, total * sizeof *es) : NULL;
		size_t m = 0;
		for (size_t j = 0; j < *entries_length; j++) {
			if (j != at) es[m++] = (*entries)[j];
			else if (count) es[m++] = (nd_entry){(*entries)[j].name, {vs, count}};
		}
		if (entry == NULL) {
			char *name = alloc->alloc(alloc->ctx, strlen(which.name) + 1);
			es[m++] = (nd_entry){strcpy(name, which.name), {vs, count}};
		}
		*entries = es;
		*entries_length = total;
	}
	if (patched != NULL && patched->fn != NULL) {
		for (size_t j = 0; j < n; j++) patched->fn(patched->ctx, &patches[j], &seen[j], node->id, which);
	}
	free(seen);
	return MU_OK;
}
