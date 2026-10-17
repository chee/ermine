// eg-walker kept between merges (egwalker.h), in C: walker.ts, line for line where it can be.
//
// - ids: (commit, n), commits compared by (lamport, name), the order rule 1 ranks them in; the
//   start's below all
// - a commit applied: its version a bitset over the commits applied here, its own follows' and
//   theirs; its patches read in it. A patch that does not apply leaves the commit out whole: what it
//   did is undone from a log (walker.ts's undo closures), what it made stays in the arena unreached
// - every value, write, element and list here is the state's arena's, freed with it. Leaves (null,
//   bools, numbers, bytes, stand-ins) are the values given, held (op_ref) and let go of with it
#include "egwalker.h"

#include <stdlib.h>
#include <string.h>

// --- the arena: blocks handed out in chunks, all freed at once ---

typedef struct chunk chunk;
struct chunk {
	chunk *next;
	size_t used, size;
	_Alignas(16) unsigned char data[];
};
typedef struct {
	chunk *head;
	// leaves held
	op_value **held;
	size_t held_n, held_cap;
} arena;

static void *ar_take(arena *a, size_t n) {
	n = (n + 15) & ~(size_t)15;
	if (n == 0) n = 16;
	if (a->head == NULL || a->head->size - a->head->used < n) {
		size_t size = n > 65536 ? n : 65536;
		chunk *c = malloc(sizeof *c + size);
		if (c == NULL) abort();
		c->next = a->head;
		c->used = 0;
		c->size = size;
		a->head = c;
	}
	void *p = a->head->data + a->head->used;
	a->head->used += n;
	return p;
}
static void *ar_zero(arena *a, size_t n) { return memset(ar_take(a, n), 0, n); }
// a list grown: a new block, the old left in the arena
static void *ar_grow(arena *a, void *p, size_t have, size_t *cap, size_t size) {
	if (have < *cap) return p;
	size_t c = *cap ? *cap * 2 : 4;
	void *q = ar_take(a, c * size);
	if (have) memcpy(q, p, have * size);
	*cap = c;
	return q;
}
static op_value *ar_hold(arena *a, op_value *v) {
	if (a->held_n == a->held_cap) {
		a->held_cap = a->held_cap ? a->held_cap * 2 : 64;
		a->held = realloc(a->held, a->held_cap * sizeof *a->held);
		if (a->held == NULL) abort();
	}
	return a->held[a->held_n++] = op_ref(v);
}
static void ar_free(arena *a) {
	for (chunk *c = a->head, *n; c != NULL; c = n) n = c->next, free(c);
	for (size_t i = 0; i < a->held_n; i++) op_free(a->held[i]);
	free(a->held);
	*a = (arena){0};
}

// --- the replay's values ---

// c: the commit's place here (in the order applied), START the start's; n: its count within
#define START (-1)
typedef struct {
	int c;
	uint32_t n;
} eid;

typedef struct val val;
typedef struct item item;
// what is at a place: every write made there; the latest seen holds it (value NULL: absent)
typedef struct {
	eid id;
	val *value;
} wr;
typedef struct {
	wr *w;
	size_t n, cap;
} slot;
typedef struct {
	const char *name;
	slot slot;
} key;
enum { LEAF, MAP, SEQ };
enum { STRING, LIST, TYPED };
struct val {
	int kind, of;
	op_elements typed;
	op_value *leaf;
	key *keys;
	size_t nkeys, capkeys;
	item **items;
	size_t nitems, capitems;
};
// an element of a sequence: a list's holds a slot, a string's or typed array's an atom (its bytes)
struct item {
	eid id;
	item *origin;
	int *gone;
	size_t ngone, capgone;
	slot slot;
	const unsigned char *atom;
	size_t len;
};

// --- the state ---

// a table: its root slot (rooted: there is one), the commits that applied naming it, the start's
// change when the start has it
typedef struct {
	const char *name;
	bool rooted;
	slot root;
	int *named;
	size_t nnamed, capnamed;
	const ch_header *start;
} table_t;

enum { U_INSERT, U_WRITE, U_GONE, U_KEY, U_ROOT };
typedef struct {
	int kind;
	void *a, *b;
} undo_t;

typedef struct {
	arena ar;
	const hy_history *history;
	uint64_t serial;
	// the start's commit, none for nothing; its tables (what the start's changes refer to)
	const hy_kept *first;
	rp_tables start;
	// the commits applied, by place: each one's kept, version (words long)
	const hy_kept **commits;
	uint32_t **versions;
	size_t *words;
	size_t ncommits, capcommits;
	// kept → place
	const hy_kept **ikeys;
	size_t *ivalues, islots, icount;
	table_t *tables;
	size_t ntables, captables;
	size_t built;
	// reading: the version seen (bits, words), and the commit landing (me), counting ids from count
	const uint32_t *bits;
	size_t nbits;
	int me;
	uint32_t count;
	undo_t *undo;
	size_t nundo, capundo;
} state;

static void put_index(state *s, const hy_kept *k, size_t v);
static size_t islot(const state *s, const hy_kept *k) {
	size_t x = (size_t)(uintptr_t)k;
	x ^= x >> 17;
	x *= (size_t)0x9e3779b97f4a7c15ull;
	return x & (s->islots - 1);
}
static bool index_of(const state *s, const hy_kept *k, size_t *v) {
	if (s->islots == 0 || k == NULL) return false;
	for (size_t i = islot(s, k); s->ikeys[i] != NULL; i = (i + 1) & (s->islots - 1))
		if (s->ikeys[i] == k) return *v = s->ivalues[i], true;
	return false;
}
static void put_index(state *s, const hy_kept *k, size_t v) {
	if (2 * (s->icount + 1) > s->islots) {
		const hy_kept **keys = s->ikeys;
		size_t *values = s->ivalues, n = s->islots;
		s->islots = n ? n * 2 : 64;
		s->ikeys = calloc(s->islots, sizeof *s->ikeys);
		s->ivalues = calloc(s->islots, sizeof *s->ivalues);
		if (s->ikeys == NULL || s->ivalues == NULL) abort();
		s->icount = 0;
		for (size_t i = 0; i < n; i++)
			if (keys[i] != NULL) put_index(s, keys[i], values[i]);
		free(keys), free(values);
	}
	size_t i = islot(s, k);
	while (s->ikeys[i] != NULL) i = (i + 1) & (s->islots - 1);
	s->ikeys[i] = k;
	s->ivalues[i] = v;
	s->icount++;
}

static void state_free(state *s) {
	if (s == NULL) return;
	ar_free(&s->ar);
	rp_free(&s->start);
	free(s->commits), free(s->versions), free(s->words);
	free(s->ikeys), free(s->ivalues);
	free(s->tables);
	free(s->undo);
	free(s);
}

static void log_undo(state *s, int kind, void *a, void *b) {
	if (s->nundo == s->capundo) {
		s->capundo = s->capundo ? s->capundo * 2 : 64;
		s->undo = realloc(s->undo, s->capundo * sizeof *s->undo);
		if (s->undo == NULL) abort();
	}
	s->undo[s->nundo++] = (undo_t){kind, a, b};
}

static bool has(const uint32_t *b, size_t words, int c) {
	return c >= 0 && ((size_t)c >> 5) < words && ((b[c >> 5] >> (c & 31)) & 1);
}
static bool sees(const state *s, int c) { return c == START || c == s->me || has(s->bits, s->nbits, c); }

// a later id: the same commit, the higher n; else the start's below all; else by (lamport, name)
static bool after(const state *s, eid a, eid b) {
	if (a.c == b.c) return a.n > b.n;
	if (a.c == START) return false;
	if (b.c == START) return true;
	const hy_kept *x = s->commits[a.c], *y = s->commits[b.c];
	if (x->lamport != y->lamport) return x->lamport > y->lamport;
	return memcmp(x->name, y->name, 32) > 0;
}

static eid next_id(state *s) { return (eid){s->me, s->count++}; }

// --- making values ---

static item *put(state *s, val *seq, item *it);

static item *new_item(state *s, item *origin) {
	item *it = ar_zero(&s->ar, sizeof *it);
	it->id = next_id(s);
	it->origin = origin;
	return it;
}

static void push_write(state *s, slot *sl, eid id, val *value) {
	sl->w = ar_grow(&s->ar, sl->w, sl->n, &sl->cap, sizeof *sl->w);
	sl->w[sl->n++] = (wr){id, value};
}

static val *make(state *s, const op_value *v);

// a list's element: its id, then its value's
static item *element(state *s, const op_value *x, item *origin) {
	item *it = new_item(s, origin);
	push_write(s, &it->slot, it->id, make(s, x));
	return it;
}

// a string's code points: each lead byte and what continues it
static size_t next_point(const unsigned char *t, size_t i, size_t end) {
	i++;
	while (i < end && (t[i] & 0xC0) == 0x80) i++;
	return i;
}

// a value taken apart, new ids
static val *make(state *s, const op_value *v) {
	val *out = ar_zero(&s->ar, sizeof *out);
	if (v != NULL && v->type == OP_STR) {
		out->kind = SEQ, out->of = STRING;
		unsigned char *text = ar_take(&s->ar, v->bytes + 1);
		memcpy(text, v->str, v->bytes);
		item *origin = NULL;
		for (size_t i = 0; i < v->bytes;) {
			size_t j = next_point(text, i, v->bytes);
			item *it = new_item(s, origin);
			it->atom = text + i, it->len = j - i;
			origin = put(s, out, it);
			i = j;
		}
	} else if (v != NULL && v->type == OP_LIST) {
		out->kind = SEQ, out->of = LIST;
		item *origin = NULL;
		for (size_t i = 0; i < v->count; i++) origin = put(s, out, element(s, v->items[i], origin));
	} else if (v != NULL && v->type == OP_TYPED) {
		out->kind = SEQ, out->of = TYPED, out->typed = v->kind;
		size_t size = op_size(v->kind);
		unsigned char *data = ar_take(&s->ar, v->bytes + 1);
		memcpy(data, v->data, v->bytes);
		item *origin = NULL;
		for (size_t i = 0; i + size <= v->bytes; i += size) {
			item *it = new_item(s, origin);
			it->atom = data + i, it->len = size;
			origin = put(s, out, it);
		}
	} else if (v != NULL && v->type == OP_MAP) {
		out->kind = MAP;
		for (size_t i = 0; i < v->count; i++) {
			out->keys = ar_grow(&s->ar, out->keys, out->nkeys, &out->capkeys, sizeof *out->keys);
			key *k = &out->keys[out->nkeys++];
			size_t n = strlen(v->keys[i]) + 1;
			k->name = memcpy(ar_take(&s->ar, n), v->keys[i], n);
			k->slot = (slot){0};
			eid id = next_id(s);
			push_write(s, &k->slot, id, make(s, v->items[i]));
		}
	} else {
		out->kind = LEAF;
		out->leaf = v != NULL ? ar_hold(&s->ar, (op_value *)v) : NULL;
	}
	return out;
}

// an element into its sequence: after its origin, past every later one there
static item *put(state *s, val *seq, item *it) {
	size_t at = 0;
	if (it->origin != NULL) {
		while (at < seq->nitems && seq->items[at] != it->origin) at++;
		at++;
	}
	while (at < seq->nitems && after(s, seq->items[at]->id, it->id)) at++;
	seq->items = ar_grow(&s->ar, seq->items, seq->nitems, &seq->capitems, sizeof *seq->items);
	memmove(&seq->items[at + 1], &seq->items[at], (seq->nitems - at) * sizeof *seq->items);
	seq->items[at] = it;
	seq->nitems++;
	log_undo(s, U_INSERT, seq, it);
	return it;
}

// --- reading ---

// what a slot holds in the version seen; NULL: absent
static val *read(const state *s, const slot *sl) {
	const wr *top = NULL;
	for (size_t i = 0; sl != NULL && i < sl->n; i++)
		if (sees(s, sl->w[i].id.c) && (top == NULL || after(s, sl->w[i].id, top->id))) top = &sl->w[i];
	return top != NULL ? top->value : NULL;
}
static bool shown(const state *s, const item *it) {
	if (!sees(s, it->id.c)) return false;
	for (size_t i = 0; i < it->ngone; i++)
		if (sees(s, it->gone[i])) return false;
	return true;
}
// the k-th element shown, or NULL
static item *nth(const state *s, const val *seq, long k) {
	if (k < 0) return NULL;
	for (size_t i = 0; i < seq->nitems; i++)
		if (shown(s, seq->items[i]) && k-- == 0) return seq->items[i];
	return NULL;
}
// the elements shown: malloc'd
static item **visible(const state *s, const val *seq, size_t *n) {
	item **out = malloc((seq->nitems + 1) * sizeof *out);
	if (out == NULL) abort();
	*n = 0;
	for (size_t i = 0; i < seq->nitems; i++)
		if (shown(s, seq->items[i])) out[(*n)++] = seq->items[i];
	return out;
}
static void write(state *s, slot *sl, val *value) {
	push_write(s, sl, next_id(s), value);
	log_undo(s, U_WRITE, sl, NULL);
}
static void remove_item(state *s, item *it) {
	it->gone = ar_grow(&s->ar, it->gone, it->ngone, &it->capgone, sizeof *it->gone);
	it->gone[it->ngone++] = s->me;
	log_undo(s, U_GONE, it, NULL);
}
static key *find_key(const val *map, const char *name) {
	for (size_t i = 0; i < map->nkeys; i++)
		if (strcmp(map->keys[i].name, name) == 0) return &map->keys[i];
	return NULL;
}

// canonical order: shorter first, then bytewise, as TextEncoder has the key (U+0000 held as C0 80 is
// the byte 00; a lone surrogate, held as WTF-8, is U+FFFD)
static size_t utf8_of(const char *k, unsigned char *out) {
	const unsigned char *s = (const unsigned char *)k;
	size_t m = 0;
	for (size_t i = 0; s[i];) {
		if (s[i] == 0xC0 && s[i + 1] == 0x80) {
			if (out) out[m] = 0;
			m++, i += 2;
		} else if (s[i] == 0xED && s[i + 1] >= 0xA0 && s[i + 1] <= 0xBF && s[i + 2]) {
			if (out) out[m] = 0xEF, out[m + 1] = 0xBF, out[m + 2] = 0xBD;
			m += 3, i += 3;
		} else {
			if (out) out[m] = s[i];
			m++, i++;
		}
	}
	return m;
}
typedef struct {
	const key *k;
	unsigned char *bytes;
	size_t length, place;
} sorting;
static int by_canonical(const void *x, const void *y) {
	const sorting *a = x, *b = y;
	if (a->length != b->length) return a->length < b->length ? -1 : 1;
	int c = a->length ? memcmp(a->bytes, b->bytes, a->length) : 0;
	if (c != 0) return c;
	return a->place < b->place ? -1 : a->place > b->place;
}

// the value a version shows: a new one
static op_value *show(const state *s, const val *v) {
	if (v->kind == LEAF) return v->leaf != NULL ? op_ref(v->leaf) : op_null();
	if (v->kind == MAP) {
		op_value *out = op_map();
		sorting *keys = malloc((v->nkeys + 1) * sizeof *keys);
		if (keys == NULL) abort();
		for (size_t i = 0; i < v->nkeys; i++) {
			size_t n = utf8_of(v->keys[i].name, NULL);
			keys[i] = (sorting){&v->keys[i], malloc(n + 1), n, i};
			if (keys[i].bytes == NULL) abort();
			utf8_of(v->keys[i].name, keys[i].bytes);
		}
		qsort(keys, v->nkeys, sizeof *keys, by_canonical);
		for (size_t i = 0; i < v->nkeys; i++) {
			const val *x = read(s, &keys[i].k->slot);
			if (x != NULL) op_set(out, keys[i].k->name, show(s, x));
			free(keys[i].bytes);
		}
		free(keys);
		return out;
	}
	size_t n;
	item **items = visible(s, v, &n);
	op_value *out;
	if (v->of == LIST) {
		out = op_list();
		for (size_t i = 0; i < n; i++) op_push(out, show(s, read(s, &items[i]->slot)));
	} else {
		size_t length = 0;
		for (size_t i = 0; i < n; i++) length += items[i]->len;
		unsigned char *b = malloc(length + 1);
		if (b == NULL) abort();
		length = 0;
		for (size_t i = 0; i < n; i++) memcpy(b + length, items[i]->atom, items[i]->len), length += items[i]->len;
		b[length] = 0;
		if (v->of == STRING) out = op_str_take((char *)b, length);
		else {
			out = op_typed(v->typed, b, n);
			free(b);
		}
	}
	free(items);
	return out;
}

// --- one commit's patches, in its version ---

static bool key_is(const op_key *k, int list) { return list ? k->type == OP_NUM_KEY : k->type == OP_STR_KEY; }

// what is at path's first n keys; NULL: nothing there (it does not apply)
static val *at(const state *s, const slot *root, const op_target *t, size_t n) {
	val *v = read(s, root);
	if (v == NULL) return NULL;
	for (size_t i = 0; i < n; i++) {
		const op_key *k = &t->path[i];
		if (v->kind == MAP && key_is(k, 0)) {
			key *x = find_key(v, k->s);
			if ((v = x != NULL ? read(s, &x->slot) : NULL) == NULL) return NULL;
		} else if (v->kind == SEQ && v->of == LIST && key_is(k, 1)) {
			item *it = nth(s, v, k->n);
			if (it == NULL) return NULL;
			v = read(s, &it->slot);
		} else return NULL;
	}
	return v;
}

static bool set(state *s, slot *root, const op_target *t, const op_value *value) {
	if (t->length == 0) {
		val *m = make(s, value);
		write(s, root, m);
		return true;
	}
	val *p = at(s, root, t, t->length - 1);
	const op_key *k = &t->path[t->length - 1];
	if (p == NULL) return false;
	if (p->kind == MAP && key_is(k, 0)) {
		key *x = find_key(p, k->s);
		if (x == NULL) {
			p->keys = ar_grow(&s->ar, p->keys, p->nkeys, &p->capkeys, sizeof *p->keys);
			x = &p->keys[p->nkeys++];
			size_t n = strlen(k->s) + 1;
			x->name = memcpy(ar_take(&s->ar, n), k->s, n);
			x->slot = (slot){0};
			log_undo(s, U_KEY, p, NULL);
		}
		val *m = make(s, value);
		write(s, &x->slot, m);
		return true;
	}
	if (p->kind == SEQ && p->of == LIST && key_is(k, 1)) {
		item *it = nth(s, p, k->n);
		if (it == NULL) return false;
		val *m = make(s, value);
		write(s, &it->slot, m);
		return true;
	}
	return false;
}

static bool unset(state *s, slot *root, const op_target *t) {
	if (t->length == 0) {
		write(s, root, NULL);
		return true;
	}
	val *p = at(s, root, t, t->length - 1);
	const op_key *k = &t->path[t->length - 1];
	if (p == NULL) return false;
	if (p->kind == MAP && key_is(k, 0)) {
		key *x = find_key(p, k->s);
		// removing a missing key: nothing
		if (x != NULL && read(s, &x->slot) != NULL) write(s, &x->slot, NULL);
		return true;
	}
	if (p->kind == SEQ && p->of == LIST && key_is(k, 1)) {
		item *it = nth(s, p, k->n);
		if (it == NULL) return false;
		remove_item(s, it);
		return true;
	}
	return false;
}

// the span [a, b) of the sequence at t taken out, what was there given back (when was is not NULL),
// value's elements put in its place (value NULL: none)
static bool splice(state *s, slot *root, const op_target *t, int64_t a, int64_t b, const op_value *value, op_value **was) {
	val *v = at(s, root, t, t->length);
	if (v == NULL || v->kind != SEQ || a > b || a < 0) return false;
	size_t n;
	item **items = visible(s, v, &n);
	if ((size_t)b > n) return free(items), false;
	if (value != NULL) {
		bool fits = (v->of == STRING && value->type == OP_STR) || (v->of == LIST && value->type == OP_LIST) ||
			(v->of == TYPED && value->type == OP_TYPED && value->kind == v->typed);
		if (!fits) return free(items), false;
	}
	if (was != NULL) {
		val taken = *v;
		taken.items = items + a;
		taken.nitems = (size_t)(b - a);
		// shown already: every one of them
		int me = s->me;
		const uint32_t *bits = s->bits;
		(void)me, (void)bits;
		op_value *out;
		if (v->of == LIST) {
			out = op_list();
			for (int64_t i = a; i < b; i++) op_push(out, show(s, read(s, &items[i]->slot)));
		} else {
			size_t length = 0;
			for (int64_t i = a; i < b; i++) length += items[i]->len;
			unsigned char *bytes = malloc(length + 1);
			if (bytes == NULL) abort();
			length = 0;
			for (int64_t i = a; i < b; i++) memcpy(bytes + length, items[i]->atom, items[i]->len), length += items[i]->len;
			bytes[length] = 0;
			if (v->of == STRING) out = op_str_take((char *)bytes, length);
			else out = op_typed(v->typed, bytes, (size_t)(b - a)), free(bytes);
		}
		*was = out;
	}
	for (int64_t i = a; i < b; i++) remove_item(s, items[i]);
	item *origin = a > 0 ? items[a - 1] : NULL;
	free(items);
	if (value == NULL) return true;
	if (value->type == OP_LIST) {
		for (size_t i = 0; i < value->count; i++) origin = put(s, v, element(s, value->items[i], origin));
	} else if (value->type == OP_STR) {
		unsigned char *text = ar_take(&s->ar, value->bytes + 1);
		memcpy(text, value->str, value->bytes);
		for (size_t i = 0; i < value->bytes;) {
			size_t j = next_point(text, i, value->bytes);
			item *it = new_item(s, origin);
			it->atom = text + i, it->len = j - i;
			origin = put(s, v, it);
			i = j;
		}
	} else {
		size_t size = op_size(value->kind);
		unsigned char *data = ar_take(&s->ar, value->bytes + 1);
		memcpy(data, value->data, value->bytes);
		for (size_t i = 0; i + size <= value->bytes; i += size) {
			item *it = new_item(s, origin);
			it->atom = data + i, it->len = size;
			origin = put(s, v, it);
		}
	}
	return true;
}

static bool key_same(const op_key *a, const op_key *b) {
	if (a->type != b->type) return false;
	return a->type == OP_STR_KEY ? strcmp(a->s, b->s) == 0 : a->n == b->n;
}
static bool same_path(const op_target *a, const op_target *b) {
	if (a->length != b->length) return false;
	for (size_t i = 0; i < a->length; i++)
		if (!key_same(&a->path[i], &b->path[i])) return false;
	return true;
}
// p's place lies inside what from takes: under its path, or in its span (apply.ts's)
static bool under(const op_target *p, const op_target *from) {
	if (p->length < from->length) return false;
	for (size_t i = 0; i < from->length; i++)
		if (!key_same(&from->path[i], &p->path[i])) return false;
	if (!from->has_range) return p->length > from->length;
	if (p->length == from->length) return false;
	const op_key *k = &p->path[from->length];
	return k->type == OP_NUM_KEY && k->n >= from->from && k->n < from->to;
}

static bool move(state *s, slot *root, const op_patch *p) {
	const op_target *from = &p->move, *to = &p->place;
	if (under(to, from)) return false;
	if (!to->has_range && !from->has_range && same_path(to, from)) return at(s, root, from, from->length) != NULL;
	op_value *m = NULL;
	if (from->has_range) {
		if (!splice(s, root, from, from->from, from->to, NULL, &m)) return false;
	} else {
		val *x = at(s, root, from, from->length);
		if (x == NULL) return false;
		m = show(s, x);
		if (!unset(s, root, from)) return op_free(m), false;
	}
	bool ok;
	if (!to->has_range) ok = set(s, root, to, m);
	else {
		val *there = at(s, root, to, to->length);
		if (there == NULL) ok = false;
		else if (there->kind == SEQ && there->of == LIST && !from->has_range) {
			op_value *one = op_list();
			op_push(one, op_ref(m));
			ok = splice(s, root, to, to->from, to->to, one, NULL);
			op_free(one);
		} else ok = splice(s, root, to, to->from, to->to, m, NULL);
	}
	op_free(m);
	return ok;
}

static bool land(state *s, slot *root, const op_patch *patches, size_t n) {
	for (size_t i = 0; i < n; i++) {
		const op_patch *p = &patches[i];
		// nothing there: only a put at the whole
		if (read(s, root) == NULL && (p->place.length || p->place.has_range || !p->has_value)) return false;
		bool ok;
		if (p->has_move) ok = move(s, root, p);
		else if (p->place.has_range)
			ok = splice(s, root, &p->place, p->place.from, p->place.to, p->has_value ? p->value : NULL, NULL);
		else if (p->has_value) ok = set(s, root, &p->place, p->value);
		else ok = unset(s, root, &p->place);
		if (!ok) return false;
	}
	return true;
}

static void undo_all(state *s) {
	for (size_t j = s->nundo; j-- > 0;) {
		undo_t *u = &s->undo[j];
		switch (u->kind) {
		case U_INSERT: {
			val *seq = u->a;
			size_t i = 0;
			while (seq->items[i] != u->b) i++;
			memmove(&seq->items[i], &seq->items[i + 1], (seq->nitems - i - 1) * sizeof *seq->items);
			seq->nitems--;
			break;
		}
		case U_WRITE: ((slot *)u->a)->n--; break;
		case U_GONE: ((item *)u->a)->ngone--; break;
		case U_KEY: ((val *)u->a)->nkeys--; break;
		case U_ROOT: ((table_t *)u->a)->rooted = false; break;
		}
	}
	s->nundo = 0;
}

static table_t *table_of(state *s, const char *name) {
	for (size_t i = 0; i < s->ntables; i++)
		if (strcmp(s->tables[i].name, name) == 0) return &s->tables[i];
	if (s->ntables == s->captables) {
		s->captables = s->captables ? s->captables * 2 : 8;
		s->tables = realloc(s->tables, s->captables * sizeof *s->tables);
		if (s->tables == NULL) abort();
	}
	table_t *t = &s->tables[s->ntables++];
	*t = (table_t){0};
	size_t n = strlen(name) + 1;
	t->name = memcpy(ar_take(&s->ar, n), name, n);
	return t;
}

// one commit, its follows applied here or in the start: in its version
static void apply(state *s, const hy_kept *k) {
	size_t i = s->ncommits;
	if (i == s->capcommits) {
		s->capcommits = s->capcommits ? s->capcommits * 2 : 64;
		s->commits = realloc(s->commits, s->capcommits * sizeof *s->commits);
		s->versions = realloc(s->versions, s->capcommits * sizeof *s->versions);
		s->words = realloc(s->words, s->capcommits * sizeof *s->words);
		if (s->commits == NULL || s->versions == NULL || s->words == NULL) abort();
	}
	size_t words = (i >> 5) + 1;
	uint32_t *version = ar_zero(&s->ar, words * sizeof *version);
	const uint8_t(*up)[32];
	size_t un = hy_follows(k, &up);
	for (size_t p = 0; p < un; p++) {
		size_t j;
		if (!index_of(s, hy_get(s->history, up[p]), &j)) continue;
		for (size_t w = 0; w < s->words[j]; w++) version[w] |= s->versions[j][w];
		version[j >> 5] |= (uint32_t)1 << (j & 31);
	}
	s->commits[i] = k;
	s->versions[i] = version;
	s->words[i] = words;
	s->ncommits++;
	put_index(s, k, i);
	cm_commit c;
	if (cm_decode(k->bytes, k->length, &c, NULL) != CM_OK) return;
	s->me = (int)i, s->count = 0, s->nundo = 0;
	s->bits = version, s->nbits = words;
	table_t *t = table_of(s, c.table);
	if (!t->rooted) {
		t->rooted = true;
		t->root = (slot){0};
		log_undo(s, U_ROOT, t, NULL);
	}
	if (land(s, &t->root, c.patches, c.patches_length)) {
		t->named = ar_grow(&s->ar, t->named, t->nnamed, &t->capnamed, sizeof *t->named);
		t->named[t->nnamed++] = (int)i;
	} else undo_all(s);
	s->nundo = 0;
	s->me = START - 1, s->bits = NULL, s->nbits = 0;
	cm_free(&c);
}

// the state from a start (its commit, none for nothing; its tables, taken)
static state *walker(const hy_history *h, const hy_kept *first, rp_tables *start) {
	state *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	s->history = h;
	s->serial = hy_serial(h);
	s->first = first;
	s->start = *start;
	*start = (rp_tables){0};
	s->me = START, s->count = 0;
	for (size_t i = 0; i < s->start.length; i++) {
		table_t *t = table_of(s, s->start.slots[i].table);
		const nd_entry *e = s->start.slots[i].entry;
		t->rooted = true;
		t->start = &e->change;
		eid id = next_id(s);
		push_write(s, &t->root, id, make(s, e->value));
	}
	s->me = START - 1;
	return s;
}

static int causal(const void *x, const void *y) {
	const hy_kept *a = *(const hy_kept *const *)x, *b = *(const hy_kept *const *)y;
	if (a->lamport != b->lamport) return a->lamport < b->lamport ? -1 : 1;
	return memcmp(a->name, b->name, 32);
}

// the commits heads follow from, since the start, not applied yet, in causal order; NULL: one of them
// doesn't follow from the start. *n how many (malloc'd)
static const hy_kept **missing(const state *s, const hy_kept *const *heads, size_t nh, size_t *n) {
	const hy_kept **stack = malloc((nh + 1) * sizeof *stack), **out = NULL;
	size_t ns = nh, cs = nh + 1, no = 0, co = 0;
	if (stack == NULL) abort();
	memcpy(stack, heads, nh * sizeof *stack);
	// what is out already: a small set by address
	state seen = {0};
	bool ok = true;
	while (ns > 0) {
		const hy_kept *k = stack[--ns];
		size_t j;
		if (index_of(s, k, &j) || k == s->first || index_of(&seen, k, &j)) continue;
		const uint8_t(*up)[32];
		size_t un = hy_follows(k, &up);
		// below the start or beside it: its lamport no higher, or a root
		if (s->first != NULL && (k->lamport <= s->first->lamport || un == 0)) {
			ok = false;
			break;
		}
		put_index(&seen, k, no);
		if (no == co) {
			co = co ? co * 2 : 16;
			out = realloc(out, co * sizeof *out);
			if (out == NULL) abort();
		}
		out[no++] = k;
		for (size_t p = 0; p < un; p++) {
			const hy_kept *q = hy_get(s->history, up[p]);
			if (q == NULL) continue;
			if (ns == cs) {
				cs *= 2;
				stack = realloc(stack, cs * sizeof *stack);
				if (stack == NULL) abort();
			}
			stack[ns++] = q;
		}
	}
	free(stack);
	free(seen.ikeys), free(seen.ivalues);
	if (!ok) return free(out), NULL;
	if (out == NULL) out = malloc(sizeof *out);
	if (out == NULL) abort();
	qsort(out, no, sizeof *out, causal);
	*n = no;
	return out;
}

typedef struct {
	const table_t *t;
	int lo, hi;
} span_t;

// the tables in a version (the commits applied here in it), as the replay ends with
static void tables(state *s, const uint32_t *version, size_t words, rp_tables *out) {
	s->me = START - 1, s->bits = version, s->nbits = words;
	span_t *spans = malloc((s->ntables + 1) * sizeof *spans);
	if (spans == NULL) abort();
	size_t n = 0;
	// the start's tables first, then the rest by the first commit naming them
	for (size_t i = 0; i < s->ntables; i++) {
		const table_t *t = &s->tables[i];
		int lo = -1, hi = -1;
		for (size_t k = 0; k < t->nnamed; k++) {
			int c = t->named[k];
			if (!has(version, words, c)) continue;
			if (lo == -1 || after(s, (eid){lo, 0}, (eid){c, 0})) lo = c;
			if (hi == -1 || after(s, (eid){c, 0}, (eid){hi, 0})) hi = c;
		}
		if (t->start != NULL || lo != -1) spans[n++] = (span_t){t, lo, hi};
	}
	// insertion: the start's in their order, the rest by their first
	for (size_t i = 1; i < n; i++) {
		span_t x = spans[i];
		size_t j = i;
		while (j > 0 && x.t->start == NULL &&
			(spans[j - 1].t->start == NULL && after(s, (eid){spans[j - 1].lo, 0}, (eid){x.lo, 0})))
			spans[j] = spans[j - 1], j--;
		spans[j] = x;
	}
	for (size_t i = 0; i < n; i++) {
		const table_t *t = spans[i].t;
		const val *v = t->rooted ? read(s, &t->root) : NULL;
		if (v == NULL) continue;
		op_value *value = show(s, v);
		if (spans[i].hi == -1) rp_put_copy(out, t->name, value, t->start);
		else {
			cm_commit c;
			const hy_kept *k = s->commits[spans[i].hi];
			if (cm_decode(k->bytes, k->length, &c, NULL) != CM_OK) abort();
			rp_put_copy(out, t->name, value, rp_signed(out, &c.change, c.signer, c.signer_length, k->name));
			cm_free(&c);
		}
		op_free(value);
	}
	free(spans);
	s->bits = NULL, s->nbits = 0;
}

// the heads' tables into out; false: they don't follow from all of the start
static bool merge_state(state *s, const hy_kept *const *heads, size_t nh, rp_tables *out) {
	size_t n;
	const hy_kept **walked = missing(s, heads, nh, &n);
	if (walked == NULL) return false;
	for (size_t i = 0; i < n; i++) apply(s, walked[i]);
	free(walked);
	size_t words = (s->ncommits >> 5) + 1;
	uint32_t *version = calloc(words, sizeof *version);
	if (version == NULL) abort();
	for (size_t i = 0; i < nh; i++) {
		size_t j;
		if (!index_of(s, heads[i], &j)) continue;
		for (size_t w = 0; w < s->words[j]; w++) version[w] |= s->versions[j][w];
		version[j >> 5] |= (uint32_t)1 << (j & 31);
	}
	tables(s, version, words, out);
	free(version);
	return true;
}

// --- building ---

typedef struct {
	rp_get get;
	void *context;
	const hy_kept *at;
	bool got;
	rp_tables tables;
} known_t;

// one commit only: a commit on one of several would not follow from all of them, and the state would
// be built again at once
static bool known(void *context, const hy_kept *const *from, size_t n) {
	known_t *k = context;
	if (n != 1) return false;
	if (k->at != from[0]) {
		if (k->got) rp_free(&k->tables);
		k->at = from[0];
		rp_init(&k->tables);
		k->got = k->get != NULL && k->get(k->context, from, 1, &k->tables);
		if (!k->got) rp_free(&k->tables);
	}
	return k->got;
}

// the state from the start since gives for heads, every commit since applied
static state *build(const hy_history *h, const hy_kept *const *heads, size_t nh, rp_get get, void *context) {
	known_t k = {.get = get, .context = context};
	const hy_kept **from, **commits;
	size_t nf, nc;
	hy_since(h, heads, nh, known, &k, &from, &nf, &commits, &nc);
	rp_tables start;
	if (nf == 0) rp_init(&start);
	else start = k.tables, k.got = false;
	if (k.got) rp_free(&k.tables);
	state *s = walker(h, nf ? from[0] : NULL, &start);
	for (size_t i = 0; i < nc; i++) apply(s, commits[i]);
	s->built = nc;
	free(from), free(commits);
	return s;
}

// the pure rule: built for the one merge, let go of
static void pure(const hy_history *h, const hy_kept *const *heads, size_t nh, rp_get get, void *context,
	rp_tables *out) {
	state *s = build(h, heads, nh, get, context);
	merge_state(s, heads, nh, out);
	state_free(s);
}

// the history's own heads
static bool current(const hy_history *h, const hy_kept *const *heads, size_t nh) {
	const hy_kept **now;
	size_t n = hy_heads(h, &now);
	bool same = n == nh;
	for (size_t i = 0; same && i < n; i++) {
		bool found = false;
		for (size_t j = 0; !found && j < nh; j++) found = heads[j] == now[i];
		same = found;
	}
	free(now);
	return same;
}

typedef struct {
	size_t limit;
	state *state;
} keeping;

static void *create(void) {
	keeping *w = calloc(1, sizeof *w);
	if (w == NULL) abort();
	w->limit = EG_LIMIT;
	return w;
}
static void walker_free(void *p) {
	keeping *w = p;
	if (w == NULL) return;
	state_free(w->state);
	free(w);
}

static void merge(void *p, const hy_history *h, const hy_kept *const *heads, size_t nh, rp_get get, void *context,
	rp_tables *out) {
	keeping *w = p;
	if (w == NULL) {
		pure(h, heads, nh, get, context, out);
		return;
	}
	if (w->state != NULL && w->state->history == h && w->state->serial == hy_serial(h)) {
		bool now = current(h, heads, nh);
		if (!now || w->state->ncommits - w->state->built <= w->limit) {
			if (merge_state(w->state, heads, nh, out)) return;
		}
		if (!now) {
			pure(h, heads, nh, get, context, out);
			return;
		}
	}
	state_free(w->state);
	w->state = build(h, heads, nh, get, context);
	if (!merge_state(w->state, heads, nh, out)) pure(h, heads, nh, get, context, out);
}

const rp_rule eg_rule = {"eg-walker", merge, create, walker_free};
