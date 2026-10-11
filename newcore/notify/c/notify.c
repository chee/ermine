// notify (newcore/notify/ts/notify.ts), in C. Same shape, same names where C allows.
// Only listened places are walked: reads sit in a trie of their paths.
#include "notify.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// memory

static void *xrealloc(void *p, size_t n) {
	void *q = realloc(p, n);
	if (q == NULL && n != 0) {
		fputs("notify: out of memory\n", stderr);
		abort();
	}
	return q;
}
static char *xdup(const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(xrealloc(NULL, n), s, n);
}
// room for one more at index count
#define GROW(p, count, capacity) \
	do { \
		if ((count) == (capacity)) { \
			(capacity) = (capacity) ? (capacity) * 2 : 4; \
			(p) = xrealloc((p), (capacity) * sizeof *(p)); \
		} \
	} while (0)

// values

static nt_value *make(nt_type type) {
	nt_value *v = xrealloc(NULL, sizeof *v);
	*v = (nt_value){.type = type};
	return v;
}
nt_value *nt_null(void) { return make(NT_NULL); }
nt_value *nt_bool(int b) {
	nt_value *v = make(NT_BOOL);
	v->bool_ = b != 0;
	return v;
}
nt_value *nt_num(double n) {
	nt_value *v = make(NT_NUM);
	v->num = n;
	return v;
}
static nt_value *strn(const char *s, size_t n) {
	nt_value *v = make(NT_STR);
	v->str = xrealloc(NULL, n + 1);
	memcpy(v->str, s, n);
	v->str[n] = 0;
	v->bytes = n;
	v->ascii = 1;
	for (size_t i = 0; i < n; i++)
		if ((unsigned char)s[i] >= 0x80) v->ascii = 0;
	return v;
}
nt_value *nt_str(const char *s) { return strn(s, strlen(s)); }
nt_value *nt_list(void) { return make(NT_LIST); }
nt_value *nt_bytes(const void *data, size_t n) {
	nt_value *v = make(NT_BYTES);
	v->data = xrealloc(NULL, n ? n : 1);
	if (n) memcpy(v->data, data, n);
	v->bytes = n;
	return v;
}
nt_value *nt_stand(nt_value *kind) {
	nt_value *v = make(NT_STAND);
	nt_push(v, kind);
	return v;
}
size_t nt_size(nt_elements kind) {
	static const unsigned char sizes[] = {1, 1, 2, 2, 4, 4, 8, 8, 4, 8};
	return (unsigned)kind < sizeof sizes ? sizes[kind] : 1;
}
nt_value *nt_typed(nt_elements kind, const void *data, size_t count) {
	nt_value *v = nt_bytes(data, count * nt_size(kind));
	v->type = NT_TYPED;
	v->kind = kind;
	return v;
}
size_t nt_length(const nt_value *t) { return t->bytes / nt_size(t->kind); }
nt_value *nt_map(void) { return make(NT_MAP); }
void nt_push(nt_value *list, nt_value *v) {
	GROW(list->items, list->count, list->capacity);
	list->items[list->count++] = v;
}
static size_t hash(const char *s) {
	size_t h = 5381;
	for (; *s; s++) h = h * 33 + (unsigned char)*s;
	return h;
}
static void slot(nt_value *m, size_t i) {
	size_t h = hash(m->keys[i]) & (m->slots - 1);
	while (m->index[h]) h = (h + 1) & (m->slots - 1);
	m->index[h] = i + 1;
}
// a map with many keys is found by hash
static nt_value *lookup(const nt_value *map, const char *key, size_t *at) {
	if (map->count <= 16) {
		for (size_t i = 0; i < map->count; i++) {
			if (strcmp(map->keys[i], key) == 0) {
				if (at) *at = i;
				return map->items[i];
			}
		}
		return NULL;
	}
	nt_value *m = (nt_value *)map;
	if (m->index == NULL) {
		m->slots = 64;
		while (m->slots < 4 * m->count) m->slots *= 2;
		m->index = xrealloc(NULL, m->slots * sizeof *m->index);
		memset(m->index, 0, m->slots * sizeof *m->index);
		for (size_t i = 0; i < m->count; i++) slot(m, i);
	}
	for (size_t h = hash(key) & (m->slots - 1); m->index[h]; h = (h + 1) & (m->slots - 1)) {
		size_t i = m->index[h] - 1;
		if (strcmp(m->keys[i], key) == 0) {
			if (at) *at = i;
			return m->items[i];
		}
	}
	return NULL;
}
nt_value *nt_get(const nt_value *map, const char *key) {
	if (map == NULL || map->type != NT_MAP) return NULL;
	return lookup(map, key, NULL);
}
void nt_set(nt_value *map, const char *key, nt_value *v) {
	size_t at;
	if (lookup(map, key, &at) != NULL) {
		nt_free(map->items[at]);
		map->items[at] = v;
		return;
	}
	if (map->count == map->capacity) {
		map->capacity = map->capacity ? map->capacity * 2 : 4;
		map->items = xrealloc(map->items, map->capacity * sizeof *map->items);
		map->keys = xrealloc(map->keys, map->capacity * sizeof *map->keys);
	}
	map->keys[map->count] = xdup(key);
	map->items[map->count++] = v;
	if (map->index != NULL) {
		if (map->slots >= 2 * map->count) {
			slot(map, map->count - 1);
		} else {
			free(map->index);
			map->index = NULL;
		}
	}
}
nt_value *nt_ref(nt_value *v) {
	if (v != NULL) v->refs++;
	return v;
}
void nt_free(nt_value *v) {
	if (v == NULL) return;
	if (v->refs) {
		v->refs--;
		return;
	}
	for (size_t i = 0; i < v->count; i++) {
		nt_free(v->items[i]);
		if (v->type == NT_MAP) free(v->keys[i]);
	}
	free(v->items);
	free(v->keys);
	free(v->index);
	free(v->str);
	free(v->data);
	free(v);
}
static nt_value *copy(const nt_value *v) {
	if (v == NULL) return NULL;
	if (v->type == NT_BYTES || v->type == NT_TYPED) {
		nt_value *c = nt_bytes(v->data, v->bytes);
		c->type = v->type;
		c->kind = v->kind;
		return c;
	}
	nt_value *c = make(v->type);
	c->bool_ = v->bool_;
	c->num = v->num;
	if (v->str) {
		c->str = xdup(v->str);
		c->bytes = v->bytes;
		c->ascii = v->ascii;
	}
	for (size_t i = 0; i < v->count; i++) {
		if (v->type == NT_MAP) nt_set(c, v->keys[i], copy(v->items[i]));
		else nt_push(c, copy(v->items[i]));
	}
	return c;
}

// strings count code points

static size_t cps(const char *s) {
	size_t n = 0;
	for (; *s; s++)
		if (((unsigned char)*s & 0xC0) != 0x80) n++;
	return n;
}
// the byte where the k-th code point starts, or the end
static const char *cp_at(const char *s, long k) {
	while (k > 0 && *s) {
		s++;
		while (((unsigned char)*s & 0xC0) == 0x80) s++;
		k--;
	}
	return s;
}
static long len(const nt_value *v) {
	if (v == NULL) return 0;
	if (v->type == NT_STR) return v->ascii ? (long)v->bytes : (long)cps(v->str);
	if (v->type == NT_LIST) return (long)v->count;
	if (v->type == NT_TYPED) return (long)nt_length(v);
	return 0;
}
// slice's [a, b) in 0..size, as Array.slice would have it
static void clamp(long size, long *a, long *b) {
	if (*a < 0) *a = *a + size < 0 ? 0 : *a + size;
	if (*a > size) *a = size;
	if (*b < 0) *b = *b + size < 0 ? 0 : *b + size;
	if (*b > size) *b = size;
	if (*b < *a) *b = *a;
}
static nt_value *slice(const nt_value *v, long a, long b) {
	if (v == NULL) return NULL;
	if (v->type == NT_STR) {
		// walks no further than b
		if (a < 0) a = 0;
		if (b < a) b = a;
		const char *p, *q;
		if (v->ascii) {
			p = v->str + ((size_t)a < v->bytes ? (size_t)a : v->bytes);
			q = v->str + ((size_t)b < v->bytes ? (size_t)b : v->bytes);
		} else {
			p = cp_at(v->str, a);
			q = cp_at(p, b - a);
		}
		return strn(p, (size_t)(q - p));
	}
	if (v->type == NT_LIST) {
		clamp(len(v), &a, &b);
		nt_value *l = nt_list();
		for (long i = a; i < b; i++) nt_push(l, copy(v->items[i]));
		return l;
	}
	if (v->type == NT_TYPED) {
		clamp(len(v), &a, &b);
		size_t z = nt_size(v->kind);
		return nt_typed(v->kind, v->data + (size_t)a * z, (size_t)(b - a));
	}
	return NULL;
}

// what is at a key; a number key and a string key meet on a map by its text
static const nt_value *child(const nt_value *v, nt_key k) {
	if (v == NULL) return NULL;
	if (v->type == NT_MAP) {
		char buf[32];
		const char *s = k.s;
		if (k.type == NT_NUM_KEY) {
			snprintf(buf, sizeof buf, "%ld", k.n);
			s = buf;
		}
		return nt_get(v, s);
	}
	if (v->type == NT_LIST) {
		long i = -1;
		if (k.type == NT_NUM_KEY) i = k.n;
		else if (k.s[0] >= '0' && k.s[0] <= '9' && (k.s[0] != '0' || k.s[1] == 0)) {
			char *end;
			i = strtol(k.s, &end, 10);
			if (*end) i = -1;
		}
		return i >= 0 && (size_t)i < v->count ? v->items[i] : NULL;
	}
	return NULL;
}
static const nt_value *at(const nt_value *v, const nt_key *keys, size_t m) {
	for (size_t i = 0; i < m && v != NULL; i++) v = child(v, keys[i]);
	return v;
}
static int same_key(nt_key a, nt_key b) {
	if (a.type != b.type) return 0;
	return a.type == NT_NUM_KEY ? a.n == b.n : strcmp(a.s, b.s) == 0;
}
static int same_keys(const nt_key *a, size_t n, const nt_key *b, size_t m) {
	if (n != m) return 0;
	for (size_t i = 0; i < n; i++)
		if (!same_key(a[i], b[i])) return 0;
	return 1;
}
// as map keys: 3 and "3" are one there
static int same_map_key(nt_key a, nt_key b) {
	char x[32], y[32];
	const char *s = a.s, *t = b.s;
	if (a.type == NT_NUM_KEY) snprintf(x, sizeof x, "%ld", a.n), s = x;
	if (b.type == NT_NUM_KEY) snprintf(y, sizeof y, "%ld", b.n), t = y;
	return strcmp(s, t) == 0;
}

// the content with what is at a place taken out, without making it: where the walk gets to,
// and the part of the sequence or the key that is cut there
typedef struct {
	const nt_value *v;
	long cut_from, cut_count;
	const nt_key *dropped;
} view;

static view view_at(const nt_value *base, const nt_place *rm, const nt_key *keys, size_t m) {
	view w = {base, 0, 0, NULL};
	if (rm == NULL) {
		w.v = at(base, keys, m);
		return w;
	}
	size_t pl = rm->length;
	if (pl == 0 && !rm->has_range) {
		w.v = NULL;
		return w;
	}
	const nt_value *v = base;
	int on = 1;
	for (size_t i = 0; i < m; i++) {
		if (v == NULL || (v->type != NT_LIST && v->type != NT_MAP)) return (view){NULL, 0, 0, NULL};
		nt_key k = keys[i];
		if (on && !rm->has_range && i == pl - 1) {
			if (v->type == NT_LIST) {
				if (k.type == NT_NUM_KEY && k.n >= rm->path[i].n) k.n++;
			} else if (same_map_key(k, rm->path[i])) {
				return (view){NULL, 0, 0, NULL};
			}
			on = 0;
		} else if (on && rm->has_range && i == pl) {
			if (v->type == NT_LIST && k.type == NT_NUM_KEY) {
				if (k.n >= rm->from) k.n += rm->to - rm->from;
			}
			on = 0;
		} else if (on) {
			on = i < pl && same_key(k, rm->path[i]);
		}
		v = child(v, k);
	}
	w.v = v;
	if (on && v != NULL) {
		if (!rm->has_range && m + 1 == pl) {
			if (v->type == NT_LIST) {
				w.cut_from = rm->path[m].n;
				w.cut_count = 1;
			} else if (v->type == NT_MAP) {
				w.dropped = &rm->path[m];
			}
		} else if (rm->has_range && m == pl) {
			w.cut_from = rm->from;
			w.cut_count = rm->to - rm->from;
		}
	}
	return w;
}
static int is_list(view w) { return w.v != NULL && w.v->type == NT_LIST; }
// a map has the key; a typed array the index (as Object.hasOwn)
static int view_has(view w, nt_key k) {
	if (w.v != NULL && w.v->type == NT_TYPED)
		return k.type == NT_NUM_KEY && k.n >= 0 && k.n < len(w.v) - w.cut_count;
	if (w.v == NULL || w.v->type != NT_MAP) return 0;
	if (w.dropped != NULL && same_map_key(*w.dropped, k)) return 0;
	return child(w.v, k) != NULL;
}


// the trie of listened places

typedef struct T T;
typedef struct nt_read R;
// numeric kids sorted by number, string kids sorted by text: a patch finds the first it reaches
struct T {
	T *up;
	nt_key key;
	T **nk;
	size_t nnk, cnk;
	T **sk;
	size_t nsk, csk;
	R **reads;
	size_t nreads, creads;
	R **spans;
	size_t nspans, cspans;
};

typedef struct {
	void (*f)(nt_kind, void *);
	void *user;
} handler;

struct nt_read {
	nt_notify *n;
	nt_key *keys;
	size_t nkeys, ckeys;
	int has_span;
	long sa, sb;
	int deep, chase, edge_in[2], drop;
	// where it sits in the trie; NULL: not in it
	T *at;
	handler *handlers;
	size_t nhandlers, chandlers;
	int live;
	// this patch's, kept on the read: the patch it last heard and what it heard then, and the
	// step that carried it
	long tick;
	nt_kind kinds[5];
	int nkinds;
	long held;
	// in a move, where it was: its whole path, or one key of it (d, k) when only shifted
	long marked;
	nt_key *was;
	size_t nwas;
	size_t was_d;
	nt_key was_k;
	int was_has_span;
	long was_a, was_b;
};

// a chased read carried by a move: where it is inside what moved
typedef struct {
	R *r;
	nt_key *rel;
	size_t nrel;
	int single;
} carried_t;

typedef struct {
	R *r;
	long a, b;
} spanned_t;

// the kids of a sequence node, past a splice, that hold chased reads, in order; plain: reads by
// position are there too
typedef struct {
	T *kid;
	long k;
	int plain;
} go_t;
typedef struct {
	T *t;
	size_t d;
	long from, delta;
	go_t *go;
	size_t ngo;
} shift_t;

struct nt_notify {
	const nt_value *(*get)(void *);
	void *ctx;
	T root;
	R **all;
	size_t nall, call;
	char **table;
	size_t ntable, ctable;
	R **fired;
	size_t nfired, cfired;
	spanned_t *spans;
	size_t nspans, cspans;
	shift_t *shifts;
	size_t nshifts, cshifts;
	carried_t *carried;
	size_t ncarried, ccarried;
	long tick, step;
	int still, moving;
};

// strings in keys live as long as the notifier
static const char *intern(nt_notify *n, const char *s) {
	if (n->ntable * 2 >= n->ctable) {
		char **old = n->table;
		size_t oc = n->ctable;
		n->ctable = oc ? oc * 2 : 64;
		n->table = xrealloc(NULL, n->ctable * sizeof *n->table);
		memset(n->table, 0, n->ctable * sizeof *n->table);
		for (size_t i = 0; i < oc; i++) {
			if (old[i] == NULL) continue;
			size_t h = hash(old[i]) & (n->ctable - 1);
			while (n->table[h]) h = (h + 1) & (n->ctable - 1);
			n->table[h] = old[i];
		}
		free(old);
	}
	size_t h = hash(s) & (n->ctable - 1);
	while (n->table[h]) {
		if (strcmp(n->table[h], s) == 0) return n->table[h];
		h = (h + 1) & (n->ctable - 1);
	}
	n->ntable++;
	return n->table[h] = xdup(s);
}
static nt_key own(nt_notify *n, nt_key k) {
	if (k.type == NT_STR_KEY) k.s = intern(n, k.s);
	return k;
}
static nt_key numkey(long n) { return (nt_key){.type = NT_NUM_KEY, .n = n}; }

// kids

// the first index in a sorted run of numeric kids holding k or more
static size_t lower(T *const *xs, size_t n, long k) {
	size_t lo = 0, hi = n;
	while (lo < hi) {
		size_t m = (lo + hi) / 2;
		if (xs[m]->key.n < k) lo = m + 1;
		else hi = m;
	}
	return lo;
}
static size_t slower(T *const *xs, size_t n, const char *s) {
	size_t lo = 0, hi = n;
	while (lo < hi) {
		size_t m = (lo + hi) / 2;
		if (strcmp(xs[m]->key.s, s) < 0) lo = m + 1;
		else hi = m;
	}
	return lo;
}
static T *kid_of(const T *t, nt_key k) {
	if (k.type == NT_NUM_KEY) {
		size_t i = lower(t->nk, t->nnk, k.n);
		return i < t->nnk && t->nk[i]->key.n == k.n ? t->nk[i] : NULL;
	}
	size_t i = slower(t->sk, t->nsk, k.s);
	return i < t->nsk && strcmp(t->sk[i]->key.s, k.s) == 0 ? t->sk[i] : NULL;
}
static size_t kids_count(const T *t) { return t->nnk + t->nsk; }
static T *new_t(T *up, nt_key key) {
	T *t = xrealloc(NULL, sizeof *t);
	*t = (T){.up = up, .key = key};
	return t;
}
static void adopt(T *t, nt_key k, T *kid) {
	kid->up = t;
	kid->key = k;
	if (k.type == NT_NUM_KEY) {
		size_t i = lower(t->nk, t->nnk, k.n);
		GROW(t->nk, t->nnk, t->cnk);
		memmove(t->nk + i + 1, t->nk + i, (t->nnk - i) * sizeof *t->nk);
		t->nk[i] = kid;
		t->nnk++;
	} else {
		size_t i = slower(t->sk, t->nsk, k.s);
		GROW(t->sk, t->nsk, t->csk);
		memmove(t->sk + i + 1, t->sk + i, (t->nsk - i) * sizeof *t->sk);
		t->sk[i] = kid;
		t->nsk++;
	}
}
static void disown(T *t, T *kid) {
	if (kid->key.type == NT_NUM_KEY) {
		size_t i = lower(t->nk, t->nnk, kid->key.n);
		if (i < t->nnk && t->nk[i] == kid) {
			memmove(t->nk + i, t->nk + i + 1, (t->nnk - i - 1) * sizeof *t->nk);
			t->nnk--;
		}
	} else {
		size_t i = slower(t->sk, t->nsk, kid->key.s);
		if (i < t->nsk && t->sk[i] == kid) {
			memmove(t->sk + i, t->sk + i + 1, (t->nsk - i - 1) * sizeof *t->sk);
			t->nsk--;
		}
	}
}
static void free_t(T *t) {
	free(t->nk);
	free(t->sk);
	free(t->reads);
	free(t->spans);
	free(t);
}
static void erase(void **a, size_t *count, void *x) {
	for (size_t i = 0; i < *count; i++) {
		if (a[i] == x) {
			memmove(a + i, a + i + 1, (*count - i - 1) * sizeof *a);
			(*count)--;
			return;
		}
	}
}
static int empty(const T *t) { return kids_count(t) == 0 && t->nreads == 0 && t->nspans == 0; }
static T *place(const nt_key *keys, size_t m, T *from) {
	T *t = from;
	for (size_t i = 0; i < m; i++) {
		T *kid = kid_of(t, keys[i]);
		if (kid == NULL) {
			kid = new_t(t, keys[i]);
			adopt(t, keys[i], kid);
		}
		t = kid;
	}
	return t;
}
static void prune(T *t) {
	while (t && t->up && empty(t)) {
		T *up = t->up;
		disown(up, t);
		free_t(t);
		t = up;
	}
}
// the empty nodes under t, gone; 1 when t is empty too
static int clean(T *t) {
	for (size_t i = 0; i < t->nnk;) {
		T *k = t->nk[i];
		if (clean(k)) {
			disown(t, k);
			free_t(k);
		} else i++;
	}
	for (size_t i = 0; i < t->nsk;) {
		T *k = t->sk[i];
		if (clean(k)) {
			disown(t, k);
			free_t(k);
		} else i++;
	}
	return empty(t);
}
static void add_read(T *t, R *r) {
	if (r->has_span) {
		GROW(t->spans, t->nspans, t->cspans);
		t->spans[t->nspans++] = r;
	} else {
		GROW(t->reads, t->nreads, t->creads);
		t->reads[t->nreads++] = r;
	}
	r->at = t;
}
// all of src into dst; src is freed
static void merge(T *src, T *dst) {
	for (size_t i = 0; i < src->nreads; i++) add_read(dst, src->reads[i]);
	for (size_t i = 0; i < src->nspans; i++) add_read(dst, src->spans[i]);
	T **ks = xrealloc(NULL, (kids_count(src) + 1) * sizeof *ks);
	size_t c = 0;
	for (size_t i = 0; i < src->nnk; i++) ks[c++] = src->nk[i];
	for (size_t i = 0; i < src->nsk; i++) ks[c++] = src->sk[i];
	for (size_t i = 0; i < c; i++) {
		T *there = kid_of(dst, ks[i]->key);
		if (there) {
			merge(ks[i], there);
		} else {
			adopt(dst, ks[i]->key, ks[i]);
		}
	}
	free(ks);
	free_t(src);
}
static void attach(R *r) { add_read(place(r->keys, r->nkeys, &r->n->root), r); }
// once only: a second prune could take a newer node at the same key
static void detach(R *r) {
	T *t = r->at;
	if (t == NULL) return;
	if (r->has_span) erase((void **)t->spans, &t->nspans, r);
	else erase((void **)t->reads, &t->nreads, r);
	r->at = NULL;
	prune(t);
}
// root and each listened node along the path, as far as they go; ts has room for m + 1
static size_t line(nt_notify *n, const nt_key *path, size_t m, T **ts) {
	size_t c = 0;
	ts[c++] = &n->root;
	for (size_t i = 0; i < m; i++) {
		T *next = kid_of(ts[c - 1], path[i]);
		if (next == NULL) break;
		ts[c++] = next;
	}
	return c;
}
static void each(T *t, void (*f)(R *, void *), void *ctx) {
	for (size_t i = 0; i < t->nreads; i++) f(t->reads[i], ctx);
	for (size_t i = 0; i < t->nspans; i++) f(t->spans[i], ctx);
	for (size_t i = 0; i < t->nnk; i++) each(t->nk[i], f, ctx);
	for (size_t i = 0; i < t->nsk; i++) each(t->sk[i], f, ctx);
}

// one patched(): what fires, and where chased reads go, kept until the walk is done

static int held(const nt_notify *n, const R *r) { return r->held == n->step; }
// in a move: remember where r was, to know if it ended there. shifted: only key d changes
static void shifted(nt_notify *n, R *r, size_t d) {
	if (!n->moving) return;
	if (r->marked != n->tick) {
		r->marked = n->tick;
		free(r->was);
		r->was = NULL;
		r->was_d = d;
		r->was_k = r->keys[d];
		r->was_has_span = r->has_span;
		r->was_a = r->sa;
		r->was_b = r->sb;
	} else if (r->was == NULL && r->was_d != d) {
		r->was = xrealloc(NULL, (r->nkeys + 1) * sizeof *r->was);
		memcpy(r->was, r->keys, r->nkeys * sizeof *r->was);
		r->was[r->was_d] = r->was_k;
		r->nwas = r->nkeys;
	}
}
static void mark(nt_notify *n, R *r) {
	if (!n->moving) return;
	if (r->marked != n->tick) {
		r->marked = n->tick;
		free(r->was);
		r->was = xrealloc(NULL, (r->nkeys + 1) * sizeof *r->was);
		memcpy(r->was, r->keys, r->nkeys * sizeof *r->was);
		r->nwas = r->nkeys;
		r->was_has_span = r->has_span;
		r->was_a = r->sa;
		r->was_b = r->sb;
	} else if (r->was == NULL) {
		r->was = xrealloc(NULL, (r->nkeys + 1) * sizeof *r->was);
		memcpy(r->was, r->keys, r->nkeys * sizeof *r->was);
		r->was[r->was_d] = r->was_k;
		r->nwas = r->nkeys;
	}
}
// back where it was, it did not move
static int back(const nt_notify *n, const R *r) {
	if (r->marked != n->tick) return 0;
	if (r->was_has_span != r->has_span) return 0;
	if (r->has_span && (r->was_a != r->sa || r->was_b != r->sb)) return 0;
	if (r->was == NULL) return same_key(r->keys[r->was_d], r->was_k);
	return same_keys(r->was, r->nwas, r->keys, r->nkeys);
}
static void fire(nt_notify *n, R *r) {
	GROW(n->fired, n->nfired, n->cfired);
	n->fired[n->nfired++] = r;
}
static void hit(nt_notify *n, R *r, nt_kind kind) {
	if (held(n, r)) return;
	if (r->tick != n->tick) {
		r->tick = n->tick;
		r->kinds[0] = kind;
		r->nkinds = 1;
		fire(n, r);
		return;
	}
	for (int i = 0; i < r->nkinds; i++)
		if (r->kinds[i] == kind) return;
	r->kinds[r->nkinds++] = kind;
}
// what it hears is only this
static void only(nt_notify *n, R *r, nt_kind kind) {
	if (r->tick != n->tick) {
		r->tick = n->tick;
		fire(n, r);
	}
	r->kinds[0] = kind;
	r->nkinds = 1;
}
static void gone(nt_notify *n, R *r) {
	hit(n, r, NT_GONE);
	r->live = 0;
}
// takes rel
static void carry(nt_notify *n, R *r, nt_key *rel, size_t nrel, int single) {
	if (held(n, r)) {
		free(rel);
		return;
	}
	GROW(n->carried, n->ncarried, n->ccarried);
	n->carried[n->ncarried++] = (carried_t){r, rel, nrel, single};
	r->held = n->step;
}

static int inside(const R *r, nt_key k) {
	return r->has_span && k.type == NT_NUM_KEY && k.n >= r->sa && k.n < r->sb;
}
// deep reads above the path, and deep spans above holding the next key
static void above(nt_notify *n, T **ts, size_t tsn, const nt_key *path, size_t m) {
	for (size_t i = 0; i < tsn && i < m; i++) {
		for (size_t j = 0; j < ts[i]->nreads; j++)
			if (ts[i]->reads[j]->deep) hit(n, ts[i]->reads[j], NT_VALUE);
		for (size_t j = 0; j < ts[i]->nspans; j++) {
			R *r = ts[i]->spans[j];
			if (r->deep && inside(r, path[i])) hit(n, r, NT_VALUE);
		}
	}
}
static void hear_value(R *r, void *ctx) { hit(ctx, r, NT_VALUE); }

// the content at the path is new; a key came or went when keyed
static void put(nt_notify *n, const nt_key *path, size_t d, int keyed) {
	T *small[8];
	T **ts = d < 8 ? small : xrealloc(NULL, (d + 1) * sizeof *ts);
	size_t tsn = line(n, path, d, ts);
	above(n, ts, tsn, path, d);
	if (d > 0 && tsn >= d) {
		T *parent = ts[d - 1];
		for (size_t i = 0; i < parent->nspans; i++)
			if (inside(parent->spans[i], path[d - 1])) hit(n, parent->spans[i], NT_VALUE);
		if (keyed)
			for (size_t i = 0; i < parent->nreads; i++) hit(n, parent->reads[i], NT_KEYS);
	}
	if (tsn > d) each(ts[d], hear_value, n);
	if (ts != small) free(ts);
}

// a copy of what r holds from key index from on, the span last
static nt_key *rest(const R *r, size_t from, size_t *count) {
	size_t c = r->nkeys - from + (r->has_span ? 1 : 0);
	nt_key *out = xrealloc(NULL, (c + 1) * sizeof *out);
	size_t i = 0;
	for (size_t k = from; k < r->nkeys; k++) out[i++] = r->keys[k];
	if (r->has_span) out[i++] = (nt_key){.type = NT_SPAN, .a = r->sa, .b = r->sb};
	*count = c;
	return out;
}

typedef struct {
	nt_notify *n;
	size_t d;
	int moved;
} unkey_ctx;
static void unkey_each(R *r, void *p) {
	unkey_ctx *c = p;
	if (!r->chase) hit(c->n, r, NT_VALUE);
	else if (c->moved) {
		size_t m;
		nt_key *rel = rest(r, c->d, &m);
		carry(c->n, r, rel, m, 1);
	} else gone(c->n, r);
}
// a map's key removed: chased reads under it are gone, or carried by a move
static void unkey(nt_notify *n, const nt_key *path, size_t d, int moved) {
	T *small[8];
	T **ts = d < 8 ? small : xrealloc(NULL, (d + 1) * sizeof *ts);
	size_t tsn = line(n, path, d, ts);
	above(n, ts, tsn, path, d);
	if (tsn >= d)
		for (size_t i = 0; i < ts[d - 1]->nreads; i++) hit(n, ts[d - 1]->reads[i], NT_KEYS);
	if (tsn > d) {
		unkey_ctx c = {n, d, moved};
		each(ts[d], unkey_each, &c);
	}
	if (ts != small) free(ts);
}

// a point through [f, f + r) becoming n: ProseMirror's map with assoc
static long map_point(long p, long f, long r, long n, int side) {
	if (p < f) return p;
	if (p > f + r) return p + n - r;
	if (r > 0 && p == f) return f;
	if (r > 0 && p == f + r) return f + n;
	return side < 0 ? f : f + n;
}

typedef struct {
	nt_notify *n;
	size_t d;
	long k, f, r, n_;
	int fires, past, moved, single;
	int chased, plain;
} kid_ctx;
static void kid_each(R *rd, void *p) {
	kid_ctx *c = p;
	nt_notify *n = c->n;
	if (!rd->chase || !rd->live) {
		c->plain = 1;
		if (!rd->chase && c->fires) hit(n, rd, NT_VALUE);
	} else if (c->past) {
		c->chased = 1;
		hit(n, rd, NT_MOVED);
	} else if (c->moved) {
		size_t m;
		nt_key *rel = rest(rd, c->d + 1, &m);
		if (!c->single) {
			rel = xrealloc(rel, (m + 2) * sizeof *rel);
			memmove(rel + 1, rel, m * sizeof *rel);
			rel[0] = numkey(c->k - c->f);
			m++;
		}
		carry(n, rd, rel, m, c->single);
	} else if (c->k - c->f < c->n_) hit(n, rd, NT_VALUE);
	else gone(n, rd);
}

// the sequence at the path: [f, f + r) becomes n long; atomic: no path goes into it
// v, less: what it was, less what a move took out, for knowing if it had more than k elements
// moved: what left is carried; single: one element left
// length: how long the sequence was (its fact's)
static void splice(nt_notify *nf, const nt_key *path, size_t d, long length, long f,
		long r, long n, int atomic, int moved, int single) {
	T *small[8];
	T **ts = d < 8 ? small : xrealloc(NULL, (d + 1) * sizeof *ts);
	size_t tsn = line(nf, path, d, ts);
	above(nf, ts, tsn, path, d);
	T *t = tsn > d ? ts[d] : NULL;
	if (ts != small) free(ts);
	if (t == NULL) return;
	int even = r == n;
	for (size_t i = 0; i < t->nreads; i++) {
		R *rd = t->reads[i];
		if (atomic || rd->deep) hit(nf, rd, NT_VALUE);
		if (!even && !nf->still) hit(nf, rd, NT_LENGTH);
	}
	// by position: what is touched; past the longer of the two lengths nothing was or is
#define REACHES(k) (even ? (k) < f + r : length > (k) || length > (k) - n + r)
	size_t to = even ? lower(t->nk, t->nnk, f + r) : t->nnk;
	go_t *go = NULL;
	size_t ngo = 0, cgo = 0;
	for (size_t i = lower(t->nk, t->nnk, f); i < to; i++) {
		T *kid = t->nk[i];
		long k = kid->key.n;
		kid_ctx c = {.n = nf, .d = d, .k = k, .f = f, .r = r, .n_ = n, .fires = REACHES(k),
			.past = k >= f + r, .moved = moved, .single = single};
		each(kid, kid_each, &c);
		if (c.past && c.chased) {
			GROW(go, ngo, cgo);
			go[ngo++] = (go_t){kid, k, c.plain};
		}
	}
	if (ngo > 0) {
		GROW(nf->shifts, nf->nshifts, nf->cshifts);
		nf->shifts[nf->nshifts++] = (shift_t){t, d, f + r, n - r, go, ngo};
	} else free(go);
	for (size_t i = 0; i < t->nspans; i++) {
		R *sp = t->spans[i];
		long a = sp->sa, b = sp->sb;
		if (!sp->chase) {
			if (a == b ? a >= f && REACHES(a) : f < b && REACHES(a)) hit(nf, sp, NT_VALUE);
			continue;
		}
		// all it holds moves: it goes along, as a span over what moved
		if (moved && a >= f && b <= f + r && b > a) {
			nt_key *rel = xrealloc(NULL, sizeof *rel);
			rel[0] = (nt_key){.type = NT_SPAN, .a = a - f, .b = b - f};
			carry(nf, sp, rel, 1, 0);
			continue;
		}
		long a2 = map_point(a, f, r, n, sp->edge_in[0] ? -1 : 1);
		long b2 = map_point(b, f, r, n, sp->edge_in[1] ? 1 : -1);
		// a caret with both edges out: it stays with its start
		if (b2 < a2) b2 = a2;
		int lost = r > 0 && b > a && a < f + r && f < b;
		if (lost || (n > 0 && a2 < f + n && f < b2)) hit(nf, sp, NT_VALUE);
		if (b > a && a2 == b2 && sp->drop) {
			gone(nf, sp);
			continue;
		}
		if (a2 != a || b2 != b) {
			GROW(nf->spans, nf->nspans, nf->cspans);
			nf->spans[nf->nspans++] = (spanned_t){sp, a2, b2};
			hit(nf, sp, NT_MOVED);
		}
	}
#undef REACHES
}

typedef struct {
	nt_notify *n;
	size_t d;
	long to;
} rekey_ctx;
static void rekey(R *r, void *p) {
	rekey_ctx *c = p;
	shifted(c->n, r, c->d);
	r->keys[c->d] = numkey(c->to);
}
typedef struct {
	R **rs;
	size_t n, c;
} reads_t;
static void chased_live(R *r, void *p) {
	reads_t *l = p;
	if (!r->chase || !r->live) return;
	GROW(l->rs, l->n, l->c);
	l->rs[l->n++] = r;
}

// the kids of t holding chased reads move by delta; reads by position stay where they are
static void shift(nt_notify *n, shift_t *s) {
	T *t = s->t;
	size_t d = s->d;
	long delta = s->delta;
	long low = s->from < s->from + delta ? s->from : s->from + delta;
	size_t lo = lower(t->nk, t->nnk, low);
	size_t ntail = t->nnk - lo;
	T **tail = xrealloc(NULL, (ntail + 1) * sizeof *tail);
	if (ntail) memcpy(tail, t->nk + lo, ntail * sizeof *tail);
	t->nnk = lo;
	// what stays: the tail but for the kids that wholly go
	T **stay = xrealloc(NULL, (ntail + 1) * sizeof *stay);
	size_t nstay = 0, g = 0;
	for (size_t i = 0; i < ntail; i++) {
		long k = tail[i]->key.n;
		while (g < s->ngo && s->go[g].k < k) g++;
		if (g < s->ngo && s->go[g].k == k && !s->go[g].plain) continue;
		stay[nstay++] = tail[i];
	}
	T **out = xrealloc(NULL, (s->ngo + 1) * sizeof *out);
	for (size_t i = 0; i < s->ngo; i++) {
		go_t *o = &s->go[i];
		T *mover = o->kid;
		if (o->plain) {
			// some go, some stay: the chased ones into a node of their own
			mover = new_t(NULL, numkey(0));
			reads_t l = {0};
			each(o->kid, chased_live, &l);
			for (size_t j = 0; j < l.n; j++) {
				R *r = l.rs[j];
				if (r->has_span) erase((void **)r->at->spans, &r->at->nspans, r);
				else erase((void **)r->at->reads, &r->at->nreads, r);
				add_read(place(r->keys + d + 1, r->nkeys - d - 1, mover), r);
			}
			free(l.rs);
			clean(o->kid);
		}
		rekey_ctx c = {n, d, o->k + delta};
		each(mover, rekey, &c);
		out[i] = mover;
	}
	T **landed = xrealloc(NULL, (s->ngo + 1) * sizeof *landed);
	size_t nland = 0;
	for (size_t i = 0; i < s->ngo; i++) {
		long k = s->go[i].k + delta;
		T *there = NULL;
		size_t lo2 = 0, hi = nstay;
		while (lo2 < hi) {
			size_t m = (lo2 + hi) / 2;
			if (stay[m]->key.n < k) lo2 = m + 1;
			else hi = m;
		}
		if (lo2 < nstay && stay[lo2]->key.n == k) there = stay[lo2];
		if (there) {
			merge(out[i], there);
			continue;
		}
		out[i]->up = t;
		out[i]->key = numkey(k);
		landed[nland++] = out[i];
	}
	// both in order: one pass puts them together
	while (t->cnk < lo + nstay + nland) {
		t->cnk = t->cnk ? t->cnk * 2 : 4;
		t->nk = xrealloc(t->nk, t->cnk * sizeof *t->nk);
	}
	size_t a = 0, b = 0;
	while (a < nstay || b < nland) {
		if (b == nland || (a < nstay && stay[a]->key.n < landed[b]->key.n)) t->nk[t->nnk++] = stay[a++];
		else t->nk[t->nnk++] = landed[b++];
	}
	free(tail);
	free(stay);
	free(out);
	free(landed);
	free(s->go);
}

static void whole_each(R *r, void *p) {
	if (r->chase) gone(p, r);
	else hit(p, r, NT_VALUE);
}
// one place, removed (no value) or put (a value n long); f: its fact (nt_facts).
// moved: chased reads in what leaves are carried
static void act(nt_notify *n, const nt_fact *f, const nt_place *p, int has_value, long vn, int moved) {
	if (p->has_range) {
		splice(n, p->path, p->length, f->length, p->from, p->to - p->from, has_value ? vn : 0,
			!f->list, moved, 0);
		return;
	}
	if (p->length == 0) {
		// the whole: put keeps chases; removed, they are gone
		if (has_value) put(n, p->path, 0, 0);
		else each(&n->root, whole_each, n);
		return;
	}
	nt_key k = p->path[p->length - 1];
	if (f->list) {
		if (has_value) put(n, p->path, p->length, 0);
		else splice(n, p->path, p->length - 1, f->length, k.n, 1, 0, 0, moved, 1);
		return;
	}
	if (has_value) put(n, p->path, p->length, !f->had);
	else if (f->had) unkey(n, p->path, p->length, moved);
}

// relink what moved, before the next step walks the trie
static void settle(nt_notify *n) {
	for (size_t i = 0; i < n->nshifts; i++) shift(n, &n->shifts[i]);
	n->nshifts = 0;
	for (size_t i = 0; i < n->nspans; i++) {
		R *r = n->spans[i].r;
		if (!r->live || held(n, r)) continue;
		mark(n, r);
		r->sa = n->spans[i].a;
		r->sb = n->spans[i].b;
	}
	n->nspans = 0;
}

void nt_patched_facts(nt_notify *n, const nt_patch *patch, const nt_facts *facts) {
	n->tick++;
	n->step++;
	n->nfired = 0;
	n->nspans = 0;
	for (size_t i = 0; i < n->nshifts; i++) free(n->shifts[i].go);
	n->nshifts = 0;
	for (size_t i = 0; i < n->ncarried; i++) free(n->carried[i].rel);
	n->ncarried = 0;
	n->still = 0;
	n->moving = patch->has_move;
	const nt_place *pl = &patch->place;
	if (patch->has_move) {
		const nt_place *from = &patch->move;
		// a move inside one sequence: its length stays
		size_t fl = from->has_range ? from->length : from->length ? from->length - 1 : 0;
		size_t pk = pl->has_range ? pl->length : pl->length ? pl->length - 1 : 0;
		int from_list = from->has_range || facts->from.list;
		n->still = from_list && pl->has_range && same_keys(from->path, fl, pl->path, pk);
		act(n, &facts->from, from, 0, 0, 1);
		settle(n);
		for (size_t i = 0; i < n->ncarried; i++) detach(n->carried[i].r);
		int dest = pl->has_range && facts->place.list;
		long count = pl->has_range ? (long)facts->size : 0;
		n->step++;
		act(n, &facts->place, pl, 1, count, 0);
		settle(n);
		// carried reads land inside what arrived
		for (size_t i = 0; i < n->ncarried; i++) {
			carried_t *c = &n->carried[i];
			nt_key *rel = c->rel;
			size_t nrel = c->nrel;
			R *r = c->r;
			// a span over one thing that moved with no range: the thing is a value there
			if (!pl->has_range && !from->has_range && !c->single && nrel == 1) {
				r->live = 0;
				only(n, r, NT_GONE);
				continue;
			}
			if (pl->has_range) {
				long g = pl->from;
				if (c->single) {
					if (dest) {
						rel = xrealloc(rel, (nrel + 2) * sizeof *rel);
						memmove(rel + 1, rel, nrel * sizeof *rel);
						rel[0] = numkey(0);
						nrel++;
					} else if (nrel == 0) {
						rel = xrealloc(rel, 2 * sizeof *rel);
						rel[0] = (nt_key){.type = NT_SPAN, .a = 0, .b = count};
						nrel = 1;
					}
				}
				if (nrel > 0) {
					if (rel[0].type == NT_NUM_KEY) rel[0].n += g;
					else if (rel[0].type == NT_SPAN) rel[0].a += g, rel[0].b += g;
				}
				c->rel = rel;
			}
			int span = nrel > 0 && rel[nrel - 1].type == NT_SPAN;
			size_t nk = span ? nrel - 1 : nrel;
			mark(n, r);
			free(r->keys);
			r->nkeys = pl->length + nk;
			r->ckeys = r->nkeys + 1;
			r->keys = xrealloc(NULL, r->ckeys * sizeof *r->keys);
			for (size_t j = 0; j < pl->length; j++) r->keys[j] = own(n, pl->path[j]);
			for (size_t j = 0; j < nk; j++) r->keys[pl->length + j] = rel[j];
			r->has_span = span;
			if (span) r->sa = rel[nrel - 1].a, r->sb = rel[nrel - 1].b;
			attach(r);
			only(n, r, NT_MOVED);
			c->rel = rel;
		}
	} else {
		int has = patch->has_value;
		long vn = has && pl->has_range ? len(patch->value) : 0;
		act(n, &facts->place, pl, has, vn, 0);
		settle(n);
	}
	for (size_t i = 0; i < n->nfired; i++) {
		R *r = n->fired[i];
		for (int j = 0; j < r->nkinds; j++) {
			if (r->kinds[j] == NT_MOVED && back(n, r)) {
				memmove(r->kinds + j, r->kinds + j + 1, (size_t)(r->nkinds - j - 1) * sizeof r->kinds[0]);
				r->nkinds--;
				break;
			}
		}
		if (!r->live) detach(r);
		for (int j = 0; j < r->nkinds; j++) {
			nt_kind kind = r->kinds[j];
			if (r->nhandlers == 1) {
				handler h = r->handlers[0];
				h.f(kind, h.user);
			} else if (r->nhandlers > 1) {
				// a handler may add or stop others: each kind goes to the ones there when it began
				handler *hs = xrealloc(NULL, r->nhandlers * sizeof *hs);
				size_t nh = r->nhandlers;
				memcpy(hs, r->handlers, nh * sizeof *hs);
				for (size_t h = 0; h < nh; h++) hs[h].f(kind, hs[h].user);
				free(hs);
			}
		}
	}
	n->nfired = 0;
}

nt_notify *nt_create(const nt_value *(*get)(void *), void *ctx) {
	nt_notify *n = xrealloc(NULL, sizeof *n);
	*n = (nt_notify){.get = get, .ctx = ctx};
	return n;
}
static void free_kids(T *t) {
	for (size_t i = 0; i < t->nnk; i++) free_kids(t->nk[i]), free_t(t->nk[i]);
	for (size_t i = 0; i < t->nsk; i++) free_kids(t->sk[i]), free_t(t->sk[i]);
}
void nt_destroy(nt_notify *n) {
	for (size_t i = 0; i < n->nall; i++) {
		R *r = n->all[i];
		free(r->keys);
		free(r->was);
		free(r->handlers);
		free(r);
	}
	free(n->all);
	free_kids(&n->root);
	free(n->root.nk);
	free(n->root.sk);
	free(n->root.reads);
	free(n->root.spans);
	for (size_t i = 0; i < n->ctable; i++) free(n->table ? n->table[i] : NULL);
	free(n->table);
	free(n->fired);
	free(n->spans);
	for (size_t i = 0; i < n->nshifts; i++) free(n->shifts[i].go);
	free(n->shifts);
	for (size_t i = 0; i < n->ncarried; i++) free(n->carried[i].rel);
	free(n->carried);
	free(n);
}

nt_read *nt_open(nt_notify *n, const nt_key *path, size_t length, const nt_options *options) {
	R *r = xrealloc(NULL, sizeof *r);
	*r = (R){.n = n, .live = 1};
	size_t nk = length;
	if (length > 0 && path[length - 1].type == NT_SPAN) {
		r->has_span = 1;
		r->sa = path[length - 1].a;
		r->sb = path[length - 1].b;
		nk--;
	}
	r->ckeys = nk + 1;
	r->keys = xrealloc(NULL, r->ckeys * sizeof *r->keys);
	for (size_t i = 0; i < nk; i++) r->keys[i] = own(n, path[i]);
	r->nkeys = nk;
	if (options != NULL) {
		r->deep = options->deep != 0;
		r->chase = options->chase != 0;
		r->edge_in[0] = options->edges[0] == NT_IN;
		r->edge_in[1] = options->edges[1] == NT_IN;
		r->drop = options->empty == NT_DROP;
	}
	GROW(n->all, n->nall, n->call);
	n->all[n->nall++] = r;
	attach(r);
	return r;
}
void nt_on(nt_read *r, void (*f)(nt_kind, void *), void *user) {
	GROW(r->handlers, r->nhandlers, r->chandlers);
	r->handlers[r->nhandlers++] = (handler){f, user};
}
void nt_off(nt_read *r, void (*f)(nt_kind, void *), void *user) {
	for (size_t i = 0; i < r->nhandlers; i++) {
		if (r->handlers[i].f == f && r->handlers[i].user == user) {
			memmove(r->handlers + i, r->handlers + i + 1, (r->nhandlers - i - 1) * sizeof *r->handlers);
			r->nhandlers--;
			return;
		}
	}
}
void nt_stop(nt_read *r) {
	if (!r->live) return;
	r->live = 0;
	detach(r);
}
const nt_key *nt_keys(const nt_read *r, size_t *length) {
	*length = r->nkeys;
	return r->keys;
}
int nt_span(const nt_read *r, long *a, long *b) {
	if (r->has_span) *a = r->sa, *b = r->sb;
	return r->has_span;
}
// one typed array element as a number (a 64-bit integer: as the nearest double; notify.ts has a bigint)
static nt_value *element(const nt_value *t, size_t i) {
	size_t z = nt_size(t->kind);
	uint64_t u = 0;
	for (size_t j = 0; j < z; j++) u |= (uint64_t)t->data[i * z + j] << (8 * j);
	switch (t->kind) {
	case NT_INT8: return nt_num((int8_t)u);
	case NT_UINT8: return nt_num((uint8_t)u);
	case NT_INT16: return nt_num((int16_t)u);
	case NT_UINT16: return nt_num((uint16_t)u);
	case NT_INT32: return nt_num((int32_t)u);
	case NT_UINT32: return nt_num((uint32_t)u);
	case NT_INT64: return nt_num((double)(int64_t)u);
	case NT_UINT64: return nt_num((double)u);
	case NT_FLOAT32: {
		uint32_t b = (uint32_t)u;
		float f;
		memcpy(&f, &b, 4);
		return nt_num(f);
	}
	default: {
		double d;
		memcpy(&d, &u, 8);
		return nt_num(d);
	}
	}
}
nt_value *nt_value_of(const nt_read *r) {
	const nt_value *v = at(r->n->get(r->n->ctx), r->keys, r->nkeys);
	// a typed array's one element, as notify.ts's v[k]: a number key, or a string of one
	if (v == NULL && r->nkeys && !r->has_span) {
		const nt_value *t = at(r->n->get(r->n->ctx), r->keys, r->nkeys - 1);
		nt_key k = r->keys[r->nkeys - 1];
		long i = -1;
		if (k.type == NT_NUM_KEY) i = k.n;
		else if (k.s[0] >= '0' && k.s[0] <= '9' && (k.s[0] != '0' || k.s[1] == 0)) {
			char *end;
			i = strtol(k.s, &end, 10);
			if (*end) i = -1;
		}
		if (t != NULL && t->type == NT_TYPED && i >= 0 && (size_t)i < nt_length(t)) return element(t, (size_t)i);
	}
	return r->has_span ? slice(v, r->sa, r->sb) : copy(v);
}

// a place's fact, as the base with rm taken out is seen (as notify.ts's fact)
static nt_fact fact_of(const nt_value *base, const nt_place *rm, const nt_place *p) {
	nt_fact f = {0, 0, 0};
	if (p->has_range) {
		view w = view_at(base, rm, p->path, p->length);
		f.list = is_list(w);
		f.length = (size_t)(len(w.v) - w.cut_count);
		f.had = w.v != NULL;
		return f;
	}
	if (p->length == 0) {
		f.had = rm == NULL ? base != NULL : view_at(base, rm, NULL, 0).v != NULL;
		return f;
	}
	view w = view_at(base, rm, p->path, p->length - 1);
	nt_key k = p->path[p->length - 1];
	f.list = is_list(w);
	f.length = (size_t)(len(w.v) - w.cut_count);
	// a list's: the index is in it
	f.had = f.list ? k.type == NT_NUM_KEY && k.n >= 0 && (size_t)k.n < f.length : view_has(w, k);
	return f;
}

nt_facts nt_facts_of(const nt_patch *patch, const nt_value *before) {
	nt_facts fs = {0};
	const nt_place *pl = &patch->place;
	if (!patch->has_move) {
		fs.place = fact_of(before, NULL, pl);
		return fs;
	}
	const nt_place *from = &patch->move;
	fs.place = fact_of(before, from, pl);
	fs.has_from = 1;
	fs.from = fact_of(before, NULL, from);
	if (pl->has_range) {
		fs.has_size = 1;
		if (from->has_range) fs.size = (size_t)(from->to - from->from);
		else if (fs.place.list) fs.size = 1;
		else fs.size = (size_t)len(at(before, from->path, from->length));
	}
	return fs;
}

void nt_patched(nt_notify *n, const nt_patch *patch, const nt_value *before) {
	nt_facts fs = nt_facts_of(patch, before);
	nt_patched_facts(n, patch, &fs);
}
