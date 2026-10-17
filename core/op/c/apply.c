// apply (apply.h), in C, on op_value contents. Same rules, same order of checks as apply.ts.
// Memory: what a patch touches is a copy made here (the "made" set), changed in place for the
// rest of the call; everything else is shared and never freed. Values made here and dropped
// again within the call are freed; values given are never. Once the call is good, the new value
// takes its references (hold): a made value has its one holder, its parent; a shared one an op_ref.
// The undo, when wanted, takes its references the same way as each patch lands (push): what it
// holds is made no more, so it is never changed in place again, and nothing put in by a patch is
// dropped (the undo may hold it). Whatever is made and left over at the end is freed then.
// In place (in_place): the containers given are the ones changed, so nothing is copied, and every
// container in the value holds one reference on each item, as op_ref made them. What a patch puts
// is held at once (hold), what leaves a container is let go of at the end of the call (orphans),
// after the undo, which is always built, has taken its own. A call that fails is undone by that
// undo, in place. With owned, a container is changed in place only as owned gives it back: a copy
// it gives (real: one reference on each item) goes in the container's place, and its own hold is
// that place's; till a holder takes it (hold), it is fresh, let go of at the end if none does.
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
// A small one lives in the call's own array (inl) and moves to the heap only if it grows past it.
typedef struct {
	const void **slots;
	size_t cap, used, dead;
	const void **inl;
} pset;
#define PSET_INLINE 32
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
	if (s->cap == 0 && s->inl != NULL) {
		s->cap = PSET_INLINE;
		s->slots = s->inl;
		memset(s->slots, 0, s->cap * sizeof *s->slots);
		return;
	}
	pset old = *s;
	s->cap = old.cap ? old.cap * 2 : 64;
	s->slots = grab(NULL, s->cap * sizeof *s->slots);
	memset(s->slots, 0, s->cap * sizeof *s->slots);
	s->used = s->dead = 0;
	for (size_t i = 0; i < old.cap; i++)
		if (old.slots[i] != NULL && old.slots[i] != GONE) pset_add(s, old.slots[i]);
	if (old.slots != s->inl) free(old.slots);
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
	jmp_buf jump;
	int code;
	int undo; // the undo wanted
	int inplace; // the containers given change, not copies
	// in place: the container to change for one given (apply.h), and its data; NULL: itself
	op_value *(*owned)(op_value *, void *);
	void *data;
	// copies owned gave whose one hold no holder has taken yet
	pset fresh;
	// in place: what left a container, whose reference the container held: let go of at the end
	op_value **orphans;
	size_t orphaned, orphan_capacity;
	// the first of each lives here, not on the heap
	op_value *orphan_small[8];
	const void *made_small[PSET_INLINE];
	const void *fresh_small[PSET_INLINE];
	// in place: a move's take, till its landing is done (a failed landing puts it back)
	op_patch pending;
	int has_pending;
	op_undo undone; // each patch's undo, in the order they land
	size_t patches; // how many patches the call has: the undo's first room
	// the last splice's, for the undo: what the span held, how many positions went in, whether
	// a lone high met a lone low at an edge
	op_value *taken;
	size_t size;
	int joined;
} work;

static void fail(work *w, int code) {
	w->code = code;
	longjmp(w->jump, 1);
}

// frees one made value, not what it holds that is shared
static void shell_free(op_value *v) {
	if (v->type == OP_LIST || v->type == OP_MAP || v->type == OP_STAND) {
		if (v->type == OP_MAP)
			for (size_t i = 0; i < v->count; i++) op_name_free(v->keys[i]);
		free(v->items);
		free(v->keys);
		free(v->index);
		free(v->gaps);
	} else if (v->type == OP_STR || v->type == OP_BYTES || v->type == OP_TYPED) free(v->str);
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
// a list of one, made
static op_value *one_of(work *w, op_value *v) {
	op_value *l = made_list(w, 1);
	l->items[0] = v;
	l->count = 1;
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

static void hold(work *w, op_value *v);
static int real(work *w, const op_value *c);
static void orphan(work *w, op_value *v);
// the container to change in place for the one at *at, in holder (NULL: the root), put there: v
// itself when it was made here, or in place; else a copy. With owned, owned's (a made one held
// first, as any other: owned may copy it)
static op_value *own(work *w, op_value **at, op_value *holder) {
	op_value *v = *at;
	if (w->inplace && w->owned != NULL) {
		if (pset_has(&w->made, v)) {
			// its hold is its place's, unclaimed: a made container is never in a real one
			hold(w, v);
			pset_add(&w->fresh, v);
		}
		op_value *c = w->owned(v, w->data);
		if (c != v) {
			*at = c;
			// a real holder takes the copy's hold now and lets go of v at the end
			if (holder != NULL && real(w, holder)) orphan(w, v);
			else pset_add(&w->fresh, c);
		}
		return c;
	}
	if (w->inplace || pset_has(&w->made, v)) return v;
	op_value *c;
	if (v->type == OP_MAP) c = made(w, op_map_copy(v));
	else {
		c = made(w, op_list());
		if (v->count) {
			c->items = grab(NULL, v->count * sizeof *c->items);
			memcpy(c->items, v->items, v->count * sizeof *c->items);
			c->capacity = c->count = v->count;
		}
	}
	return *at = c;
}
// v is held (by the new value, or the undo): what of it was made here is made no more, its
// holder owns it; a fresh copy's own hold is the holder's; what it shares gets one more holder
static void hold(work *w, op_value *v) {
	if (v == NULL || pset_del(&w->fresh, v)) return;
	if (!pset_del(&w->made, v)) {
		op_ref(v);
		return;
	}
	for (size_t i = 0; i < v->count; i++) hold(w, v->items[i]);
}
// in place, and c is a container given, or one that has been held: its items each have a reference.
// A container still made here (such as one that a patch put at the root from a span it took) holds
// none yet: they are taken when it is held
static int real(work *w, const op_value *c) { return w->inplace && !pset_has(&w->made, c); }
// in place: v left a container, whose reference to it is now the call's
static void orphan(work *w, op_value *v) {
	if (v == NULL) return;
	if (w->orphans == NULL) {
		w->orphans = w->orphan_small;
		w->orphan_capacity = sizeof w->orphan_small / sizeof *w->orphan_small;
	} else if (w->orphaned == w->orphan_capacity) {
		size_t cap = w->orphan_capacity * 2;
		if (w->orphans == w->orphan_small) {
			op_value **big = grab(NULL, cap * sizeof *big);
			memcpy(big, w->orphans, w->orphaned * sizeof *big);
			w->orphans = big;
		} else w->orphans = grab(w->orphans, cap * sizeof *w->orphans);
		w->orphan_capacity = cap;
	}
	w->orphans[w->orphaned++] = v;
}
static void release(work *w) {
	for (size_t i = 0; i < w->orphaned; i++) op_free(w->orphans[i]);
	if (w->orphans != w->orphan_small) free(w->orphans);
	w->orphans = NULL;
	w->orphaned = w->orphan_capacity = 0;
}
// what is still made is let go of, and every hold still fresh
static void let_go(work *w) {
	for (size_t j = 0; j < w->made.cap; j++)
		if (w->made.slots[j] != NULL && w->made.slots[j] != GONE) shell_free((op_value *)w->made.slots[j]);
	if (w->made.slots != w->made.inl) free(w->made.slots);
	for (size_t j = 0; j < w->fresh.cap; j++)
		if (w->fresh.slots[j] != NULL && w->fresh.slots[j] != GONE) op_free((op_value *)w->fresh.slots[j]);
	if (w->fresh.slots != w->fresh.inl) free(w->fresh.slots);
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
	int64_t k;
} finger;
// to position t: 0 when past the end
static int walk_to(const op_value *s, finger *f, int64_t t, size_t *at) {
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
static int span_bytes(const op_value *s, int64_t a, int64_t b, size_t *x, size_t *y,
	int64_t *total) {
	if (s->ascii) {
		if ((uint64_t)a > s->bytes || (uint64_t)b > s->bytes) return 0;
		*x = (size_t)a, *y = (size_t)b;
		if (total) *total = (int64_t)s->bytes;
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
static int64_t str_len(const op_value *s) {
	size_t x, y;
	int64_t n = 0;
	span_bytes(s, 0, 0, &x, &y, &n);
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

// keys

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
// p's place lies inside what from takes: under its path, or in its span
static int under(const op_target *p, const op_target *from) {
	if (!within(from, p)) return 0;
	if (!from->has_range) return p->length > from->length;
	if (p->length == from->length) return 0;
	op_key k = p->path[from->length];
	return k.type == OP_NUM_KEY && k.n >= from->from && k.n < from->to;
}
static op_target target(const op_key *path, size_t n) { return (op_target){path, n, 0, 0, 0}; }
static op_target ranged(const op_key *path, size_t n, int64_t a, int64_t b) {
	return (op_target){path, n, 1, a, b};
}
// the keys of path, then one more (malloc'd: the caller frees them)
static op_key *longer(const op_target *t, op_key last) {
	op_key *ks = grab(NULL, (t->length + 1) * sizeof *ks);
	if (t->length) memcpy(ks, t->path, t->length * sizeof *ks);
	ks[t->length] = last;
	return ks;
}
// path, once n elements are put in at the gap of at, a list's range; NULL: as it is (else
// malloc'd: the caller frees it). the index moved is in a list n long or more: a long holds it
static op_key *shift(const op_target *path, const op_target *at, int64_t n) {
	size_t d = at->length;
	if (!at->has_range || path->length <= d || !within(at, path)) return NULL;
	if (path->path[d].type != OP_NUM_KEY || path->path[d].n < at->from) return NULL;
	op_key *ks = grab(NULL, path->length * sizeof *ks);
	memcpy(ks, path->path, path->length * sizeof *ks);
	ks[d].n = (long)(ks[d].n + n);
	return ks;
}
// where the key of a map is, or -1
static long map_at(const op_value *m, const char *key) {
	return op_find(m, key);
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
// what is at path, unchanged; n: only so far along it
static op_value *get(work *w, const op_key *path, size_t n) {
	op_value *v = w->root;
	if (v == NULL && n) fail(w, OP_NO_KEY);
	for (size_t i = 0; i < n; i++) v = *slot(w, v, path[i]);
	return v;
}
// the container at *at, in holder (NULL: the root), made own
static op_value *copy_in(work *w, op_value **at, op_value *holder) {
	if (*at == NULL) fail(w, OP_NO_KEY);
	if (!is_list(*at) && !is_map(*at)) fail(w, OP_WRONG_KIND);
	return own(w, at, holder);
}
// the container holding path's last key, made own along the way
static op_value *parent(work *w, const op_key *path, size_t n) {
	op_value *v = copy_in(w, &w->root, NULL);
	for (size_t i = 0; i + 1 < n; i++) v = copy_in(w, slot(w, v, path[i]), v);
	return v;
}
// where what is at path is (the root's place for []), its holder in *holder (NULL: the root),
// those above made own
static op_value **place(work *w, const op_key *path, size_t n, op_value **holder) {
	if (n == 0) {
		*holder = NULL;
		return &w->root;
	}
	*holder = parent(w, path, n);
	return slot(w, *holder, path[n - 1]);
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

// what is at path becomes v (NULL: removed, absent at []); what was there (NULL: nothing), let
// go of when drop_old (then not for use): in place, at once, the container's reference with it
static op_value *set(work *w, const op_key *path, size_t n, op_value *v, int drop_old) {
	op_value *old;
	if (n == 0) {
		old = w->root;
		w->root = v;
		if (drop_old && old != v) drop(w, old);
		return old;
	}
	op_value *at = parent(w, path, n);
	op_key k = path[n - 1];
	if (is_list(at)) {
		if (k.type != OP_NUM_KEY) fail(w, OP_WRONG_KIND);
		if ((size_t)k.n >= at->count) fail(w, OP_NO_KEY);
		old = at->items[k.n];
		int kept = real(w, at);
		if (kept) hold(w, v), drop_old ? op_free(old) : orphan(w, old);
		if (v == NULL) list_splice(at, (size_t)k.n, (size_t)k.n + 1, NULL, 0);
		else at->items[k.n] = v;
		if (drop_old && !kept && old != v) drop(w, old);
		return old;
	}
	if (k.type != OP_STR_KEY) fail(w, OP_WRONG_KIND);
	long i = map_at(at, k.s);
	if (i < 0) {
		if (v != NULL) {
			if (real(w, at)) hold(w, v);
			op_set(at, k.s, v);
		}
		return NULL;
	}
	old = at->items[i];
	int kept = real(w, at);
	if (kept) hold(w, v), drop_old ? op_free(old) : orphan(w, old);
	if (v != NULL) at->items[i] = v;
	else {
		op_unset(at, (size_t)i);
	}
	if (drop_old && !kept && old != v) drop(w, old);
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
// room for one more; the first room is first patches
static op_patch *undo_add(op_undo *u, size_t first) {
	if (u->n == u->capacity) {
		u->capacity = u->capacity ? u->capacity * 2 : first;
		u->patches = grab(u->patches, u->capacity * sizeof *u->patches);
	}
	return &u->patches[u->n++];
}
static void push(work *w, const op_patch *p) {
	op_patch *q = undo_add(&w->undone, w->patches ? w->patches : 1);
	*q = *p;
	q->place.path = keys_of(&p->place);
	if (p->has_move) q->move.path = keys_of(&p->move);
	if (p->has_value) hold(w, (op_value *)p->value);
}
// what was undone first, then what was taken put back
static void fall(work *w, const op_patch *undone, const op_patch *untake) {
	if (undone) push(w, undone);
	if (untake) push(w, untake);
}

// the span [a, b) of what is at path replaced by v (NULL: removed; a list's: its items go in).
// taken: what was there is wanted, made (the undo wants it too); else it is let go of. *undo its
// undo; 0 when nothing changed, or none wanted
static int splice(work *w, const op_key *path, size_t n, int64_t a, int64_t b, op_value *v,
	int taken, op_patch *undo) {
	op_value *s = get(w, path, n);
	// the root taken by a move: nothing there, as at a key
	if (s == NULL) fail(w, OP_NO_KEY);
	if (a > b) fail(w, OP_RANGE);
	if ((s->type != OP_STR && s->type != OP_LIST && s->type != OP_TYPED))
		fail(w, OP_WRONG_KIND);
	taken = taken || w->undo;
	int64_t start = a, end = a;
	op_value *back = NULL, *out;
	w->taken = NULL;
	w->joined = 0;
	if (s->type == OP_STR) {
		size_t x, y;
		if (!span_bytes(s, a, b, &x, &y, NULL)) fail(w, OP_RANGE);
		if (v != NULL && v->type != OP_STR) fail(w, OP_WRONG_KIND);
		const unsigned char *u = (const unsigned char *)s->str;
		size_t nv = v ? v->bytes : 0, post = s->bytes - y;
		// a lone high met by a lone low: l at the left edge, r at the right; with nothing put in,
		// both edges are one
		int l = 0, r = 0;
		if (nv) {
			const unsigned char *vu = (const unsigned char *)v->str;
			if (high_before(u, x) && low_at(vu, 0, nv)) l = 1;
			if (high_before(vu, nv) && low_at(u, y, s->bytes)) r = 1;
		} else if (high_before(u, x) && low_at(u, y, s->bytes)) l = r = 1;
		w->joined = l + r > 0;
		if (taken) w->taken = made_str(w, "", 0, s->str + x, y - x, "", 0);
		if (w->undo) {
			w->size = v ? (size_t)str_len(v) : 0;
			// the undo widens over a pair made, and puts its other half back with what was there
			start = a - l;
			end = start + (int64_t)w->size + (nv ? 0 : l);
			back = w->joined
				? made_str(w, "", 0, s->str + x - 3 * (size_t)l, y - x + 3 * (size_t)(l + r), "", 0)
				: w->taken;
		}
		// the string is the call's alone (made here, or in place and held by its container only):
		// spliced where it is, in spare room
		int alone = pset_has(&w->made, s);
		if (!alone && w->inplace && n > 0 && v != s) {
			// with owned, its container own first: a copy of it holds s too
			op_value *up = w->owned != NULL ? parent(w, path, n) : get(w, path, n - 1);
			alone = s->refs == 0 && real(w, up);
		}
		size_t size = x + nv + post;
		if (alone) {
			size_t room = s->capacity ? s->capacity : s->bytes + 1;
			char *buf = s->str;
			if (size + 1 > room) {
				room = room * 2 > size + 1 ? room * 2 : size + 1;
				buf = grab(buf, room);
			}
			if (post && nv != y - x) memmove(buf + x + nv, buf + y, post);
			if (nv) memcpy(buf + x, v->str, nv);
			join(buf, &size, x + nv);
			if (nv) join(buf, &size, x);
			buf[size] = 0;
			int was_ascii = s->ascii && (nv == 0 || v->ascii);
			s->str = buf, s->bytes = size, s->capacity = room;
			if (!was_ascii) {
				s->ascii = 1;
				for (size_t i = 0; i < size; i++)
					if ((unsigned char)buf[i] >= 0x80) s->ascii = 0;
			}
		} else {
			char *buf = grab(NULL, x + nv + post + 1);
			memcpy(buf, s->str, x);
			if (nv) memcpy(buf + x, v->str, nv);
			memcpy(buf + x + nv, s->str + y, post);
			// one character again
			join(buf, &size, x + nv);
			if (nv) join(buf, &size, x);
			buf[size] = 0;
			out = made(w, op_str_take(buf, size));
			set(w, path, n, out, 1);
		}
		if (v && !w->undo) drop(w, v);
	} else if (s->type == OP_TYPED) {
		if ((uint64_t)b > op_length(s)) fail(w, OP_RANGE);
		size_t z = op_size(s->kind), x = (size_t)a * z, y = (size_t)b * z;
		if (v != NULL && (v->type != OP_TYPED || v->kind != s->kind)) fail(w, OP_WRONG_KIND);
		w->size = v ? op_length(v) : 0;
		if (taken) back = w->taken = made_typed(w, s->kind, s->data + x, y - x, NULL, 0, NULL, 0);
		if (w->inplace && w->size * z == y - x) {
			// the length stays: the elements change where they are
			op_value *holder;
			if (w->owned != NULL) s = own(w, place(w, path, n, &holder), holder);
			if (v) memcpy(s->data + x, v->data, v->bytes);
		} else {
			out = made_typed(w, s->kind, s->data, x, v ? v->data : NULL, v ? v->bytes : 0, s->data + y,
				s->bytes - y);
			set(w, path, n, out, 1);
		}
		if (v && !w->undo) drop(w, v);
		end = a + (int64_t)w->size;
	} else {
		if ((uint64_t)b > s->count) fail(w, OP_RANGE);
		if (v != NULL && v->type != OP_LIST) fail(w, OP_WRONG_KIND);
		op_value *holder;
		out = w->inplace && w->owned == NULL ? s : own(w, place(w, path, n, &holder), holder);
		int kept = real(w, out);
		size_t gone = (size_t)(b - a);
		if (taken) {
			back = w->taken = made_list(w, gone);
			memcpy(back->items, out->items + a, gone * sizeof *out->items);
			back->count = gone;
		} else if (!kept) {
			for (size_t i = 0; i < gone; i++) drop(w, out->items[a + i]);
		}
		if (kept)
			for (size_t i = 0; i < gone; i++) orphan(w, out->items[a + i]);
		w->size = v ? v->count : 0;
		list_splice(out, (size_t)a, (size_t)b, v ? v->items : NULL, w->size);
		if (kept)
			for (size_t i = 0; i < w->size; i++) hold(w, out->items[a + i]);
		if (v && !w->undo) drop_shell(w, v);
		end = a + (int64_t)w->size;
	}
	if (!w->undo) return 0;
	int empty = back->type == OP_LIST ? back->count == 0 : back->bytes == 0;
	if (empty && start == end) return 0;
	*undo = (op_patch){.place = ranged(path, n, start, end), .has_value = !empty, .value = back};
	return 1;
}

// in place: a copy of the containers and typed arrays of v, down; the rest (strings, bytes,
// numbers) is never changed in place and is shared. What the undo holds of what moved is such a
// copy, since the tree goes on changing
static op_value *deep(work *w, op_value *v) {
	switch (v->type) {
	case OP_LIST: {
		op_value *l = made_list(w, v->count);
		for (size_t i = 0; i < v->count; i++) l->items[i] = deep(w, v->items[i]);
		l->count = v->count;
		return l;
	}
	case OP_MAP: {
		op_value *m = made(w, op_map());
		for (size_t i = 0; i < v->count; i++) op_set_name(m, v->keys[i], deep(w, v->items[i]));
		return m;
	}
	case OP_TYPED: return made(w, op_typed(v->kind, v->data, op_length(v)));
	default: return v;
	}
}
static void keep_apart(work *w, op_patch *u) {
	if (w->inplace && u->has_value) u->value = deep(w, (op_value *)u->value);
}

// a move's take, for the undo: what moved, the gap it left (back), what puts it back there
// (untake, when has_untake), whether the take joined lone surrogates (taking) or was out of a
// list (listed)
typedef struct {
	op_value *m;
	op_target back;
	op_patch untake;
	int has_untake, taking, listed;
} took;

// a move's undo is the landing's, then the take's. better, one move back, with what the landing
// replaced put beside what moved first: exact unless a path back would be into-itself, a lone
// surrogate met another (a string's), or what moved cannot be moved back whole (the whole, or
// a string or typed array out of a list)

// the landing at P, unranged: old was there (NULL: nothing), listy: in a list
static void unland(work *w, const op_patch *p, const took *t, op_value *old, int listy) {
	const op_target *P = &p->place, *F = &p->move;
	const op_patch *untake = t->has_untake ? &t->untake : NULL;
	op_patch unset = {.place = target(P->path, P->length), .has_value = old != NULL, .value = old};
	if (P->length == 0) {
		fall(w, &unset, untake);
		return;
	}
	if (F->has_range) {
		// the span back, out of the sequence it became, which is then put back
		if (t->taking || within(P, F)) {
			fall(w, &unset, untake);
			return;
		}
		int64_t n = F->to - F->from;
		if (n) {
			op_patch mv = {.place = t->back, .has_move = 1, .move = ranged(P->path, P->length, 0, n)};
			push(w, &mv);
		}
		// P's place moved by the n put back in front of it, if both are in one list
		op_key *moved = n ? shift(P, &t->back, n) : NULL;
		if (moved) unset.place = target(moved, P->length);
		push(w, &unset);
		free(moved);
		return;
	}
	op_patch there = {.place = t->back, .has_move = 1, .move = target(P->path, P->length)};
	if (listy) {
		// what was replaced goes in beside it first
		if (under(&there.place, &there.move)) {
			fall(w, &unset, untake);
			return;
		}
		long k = P->path[P->length - 1].n;
		op_patch beside = {.place = ranged(P->path, P->length - 1, k + 1, k + 1), .has_value = 1,
			.value = one_of(w, old)};
		push(w, &beside);
		push(w, &there);
		return;
	}
	if (old == NULL) {
		if (under(&there.place, &there.move)) fall(w, &unset, untake);
		else push(w, &there);
		return;
	}
	// a map's key: put back once what moved has left it
	if (within(P, &t->back)) {
		fall(w, &unset, untake);
		return;
	}
	push(w, &there);
	op_key *moved = shift(P, &t->back, 1);
	op_patch put = {.place = target(moved ? moved : P->path, P->length), .has_value = 1, .value = old};
	push(w, &put);
	free(moved);
}
// the landing in a span of P; one: one element into a list; unput undoes it (NULL: nothing
// changed). w->taken: what it replaced
static void unfill(work *w, const op_patch *p, const took *t, int one, const op_patch *unput) {
	const op_target *P = &p->place, *F = &p->move;
	const op_patch *untake = t->has_untake ? &t->untake : NULL;
	op_value *m = t->m, *tk = w->taken;
	int64_t a = P->from, size = (int64_t)w->size;
	op_patch there;
	op_key *at = NULL;
	if (one) {
		// one element went in at a: an index in the list
		at = longer(P, (op_key){.type = OP_NUM_KEY, .n = (long)a});
		there = (op_patch){.place = t->back, .has_move = 1, .move = target(at, P->length + 1)};
	} else {
		// a lone high at the end of what moved would meet a lone low that begins what it replaced
		int meets = m->type == OP_STR && tk->bytes && high_before((const unsigned char *)m->str, m->bytes) &&
			low_at((const unsigned char *)tk->str, 0, tk->bytes);
		if (t->listed || t->taking || w->joined || meets) {
			fall(w, unput, untake);
			return;
		}
		there = (op_patch){.place = t->back, .has_move = 1, .move = ranged(P->path, P->length, a, a + size)};
	}
	if (under(&there.place, &there.move)) fall(w, unput, untake);
	else {
		if (tk->type == OP_LIST ? tk->count : tk->bytes) {
			op_patch beside = {.place = ranged(P->path, P->length, a + size, a + size), .has_value = 1,
				.value = tk};
			push(w, &beside);
		}
		if (size || !F->has_range) push(w, &there);
	}
	free(at);
}

// a move is a take, then a landing in what is left
static void move(work *w, const op_patch *p) {
	const op_target *pl = &p->place, *from = &p->move;
	if (under(pl, from)) fail(w, OP_INTO_ITSELF);
	// onto itself, a key or an element or the whole: nothing changes, once it is there
	if (!pl->has_range && !from->has_range && same_path(pl, from)) {
		(void)get(w, from->path, from->length);
		return;
	}
	took t = {0};
	if (from->has_range) {
		t.has_untake = splice(w, from->path, from->length, from->from, from->to, NULL, 1, &t.untake);
		t.m = w->taken, t.taking = w->joined;
		if (w->inplace && t.has_untake) w->pending = t.untake, w->has_pending = 1;
		if (w->undo) t.back = ranged(from->path, from->length, from->from, from->from);
	} else {
		t.m = set(w, from->path, from->length, NULL, 0);
		// a missing map key: nothing to take
		if (t.m == NULL) fail(w, OP_NO_KEY);
		if (w->undo) {
			t.listed = from->length > 0 && is_list(get(w, from->path, from->length - 1));
			if (t.listed) {
				long f = from->path[from->length - 1].n;
				t.back = ranged(from->path, from->length - 1, f, f);
				t.untake = (op_patch){.place = t.back, .has_value = 1, .value = one_of(w, t.m)};
			} else {
				t.back = target(from->path, from->length);
				t.untake = (op_patch){.place = t.back, .has_value = 1, .value = t.m};
			}
			t.has_untake = 1;
			if (w->inplace) w->pending = t.untake, w->has_pending = 1;
		}
	}
	if (w->has_pending) keep_apart(w, &t.untake);
	op_value *moved = t.m;
	if (!pl->has_range) {
		int listy = w->undo && pl->length > 0 && is_list(get(w, pl->path, pl->length - 1));
		op_value *old = set(w, pl->path, pl->length, moved, !w->undo);
		if (w->undo) unland(w, p, &t, old, listy);
		w->has_pending = 0;
		return;
	}
	op_value *v = get(w, pl->path, pl->length);
	// one element into a list's span: as a list of one
	int one = is_list(v) && !from->has_range;
	op_patch unput;
	int has_unput = splice(w, pl->path, pl->length, pl->from, pl->to, one ? one_of(w, moved) : moved,
		0, &unput);
	if (w->undo) unfill(w, p, &t, one, has_unput ? &unput : NULL);
	w->has_pending = 0;
}

// the patch landed: its undo pushed when wanted
static void step(work *w, const op_patch *p) {
	const op_target *pl = &p->place;
	if (w->root == NULL && (pl->length || pl->has_range || !p->has_value)) fail(w, OP_NO_KEY);
	if (p->has_move) {
		move(w, p);
		return;
	}
	op_value *v = p->has_value ? (op_value *)p->value : NULL;
	if (pl->has_range) {
		op_patch u;
		if (splice(w, pl->path, pl->length, pl->from, pl->to, v, 0, &u)) push(w, &u);
		return;
	}
	if (v == NULL && p->has_value) fail(w, OP_NOT_A_PATCH);
	if (v != NULL || pl->length == 0) {
		op_value *old = set(w, pl->path, pl->length, v, !w->undo);
		if (w->undo) {
			op_patch u = {.place = target(pl->path, pl->length), .has_value = old != NULL, .value = old};
			push(w, &u);
		}
		return;
	}
	// removing a missing map key: nothing
	op_value *at = get(w, pl->path, pl->length - 1);
	op_key k = pl->path[pl->length - 1];
	if (is_map(at) && k.type == OP_STR_KEY && op_get(at, k.s) == NULL) return;
	op_value *old = set(w, pl->path, pl->length, NULL, !w->undo);
	if (!w->undo) return;
	op_patch u = is_list(at)
		? (op_patch){.place = ranged(pl->path, pl->length - 1, k.n, k.n), .has_value = 1, .value = one_of(w, old)}
		: (op_patch){.place = target(pl->path, pl->length), .has_value = 1, .value = old};
	push(w, &u);
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

// the patches of the undo so far, the last patch's first, for patches 0 .. last
static op_patch *reversed(work *w, const size_t *marks, size_t last, size_t *count) {
	op_patch *back = grab(NULL, w->undone.n * sizeof *back);
	size_t m = 0;
	for (size_t j = last + 1, e = w->undone.n; j-- > 0; e = marks[j])
		for (size_t k = marks[j]; k < e; k++) back[m++] = w->undone.patches[k];
	*count = m;
	return back;
}

// in place, a call that failed: what it did is undone, in place, by the undo it built
static void roll_back(work *w, const size_t *marks, size_t failed) {
	if (w->has_pending) push(w, &w->pending);
	size_t n;
	op_patch *back = reversed(w, marks, failed, &n);
	// what is still made here stays made: its items have no references yet
	work r = {.root = w->root, .inplace = 1, .made = w->made};
	w->made = (pset){0};
	if (setjmp(r.jump)) abort(); // an undo patch is never refused
	for (size_t i = 0; i < n; i++) step(&r, &back[i]);
	let_go(&r);
	release(&r);
	free(back);
}

int op_apply(const op_value *value, const op_patch *patches, size_t n,
	const op_apply_options *options, op_value **out, size_t *failed) {
	op_undo *undo = options != NULL ? options->undo : NULL;
	int inplace = options != NULL && options->in_place;
	// in place the undo is built even if not asked for: it takes a failed call back
	work w = {.root = (op_value *)value, .undo = undo != NULL || inplace, .inplace = inplace, .patches = n};
	if (inplace) w.owned = options->owned, w.data = options->data;
	w.made.inl = w.made_small;
	w.fresh.inl = w.fresh_small;
	// each patch's undo starts at its mark
	size_t marks_small[16];
	size_t *marks = !w.undo ? NULL : n < 16 ? marks_small : grab(NULL, (n + 1) * sizeof *marks);
	volatile size_t i = 0;
	if (setjmp(w.jump)) {
		if (inplace) roll_back(&w, marks, i);
		// what was made here is left to go, the undo so far with it
		let_go(&w);
		release(&w);
		op_undo_free(&w.undone);
		if (marks != marks_small) free(marks);
		if (failed) *failed = i;
		return w.code;
	}
	for (; i < n; i++) {
		if (marks) marks[i] = w.undone.n;
		if (!shape(&patches[i])) fail(&w, OP_NOT_A_PATCH);
		step(&w, &patches[i]);
	}
	// nothing there: none
	if (w.root == NULL) *out = NULL;
	else {
		hold(&w, w.root);
		*out = w.root;
	}
	// what is made and left over is let go of
	let_go(&w);
	release(&w);
	if (undo) {
		// the undo: the last patch's first
		size_t m = w.undone.n;
		if (m == 0) free(w.undone.patches);
		else if (undo->patches == NULL && undo->n == 0) {
			// nothing there yet: the one made is handed over, its groups reversed where they are
			op_patch *p = w.undone.patches;
			for (size_t a = 0, b = m; a + 1 < b; a++, b--) {
				op_patch t = p[a];
				p[a] = p[b - 1], p[b - 1] = t;
			}
			// each patch's group is now backwards too: [m - end, m - mark)
			for (size_t j = n, e = m; j-- > 0; e = marks[j]) {
				for (size_t a = m - e, b = m - marks[j]; a + 1 < b; a++, b--) {
					op_patch t = p[a];
					p[a] = p[b - 1], p[b - 1] = t;
				}
			}
			*undo = w.undone;
		} else {
			if (undo->n + m > undo->capacity) {
				undo->capacity = undo->n + m;
				undo->patches = grab(undo->patches, undo->capacity * sizeof *undo->patches);
			}
			for (size_t j = n, e = m; j-- > 0; e = marks[j])
				for (size_t k = marks[j]; k < e; k++) undo->patches[undo->n++] = w.undone.patches[k];
			free(w.undone.patches);
		}
	} else op_undo_free(&w.undone);
	if (marks != marks_small) free(marks);
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
