// Tracked paths (paths.h), in C. Two chained hash maps: keys to their roots, and (step, key) to
// the step under it. A step keeps its kids in a list, and its number kids also in an array by key.
#include "paths.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *full(void) {
	fputs("paths: out of memory\n", stderr);
	abort();
}
static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	return p != NULL ? p : full();
}
static void *regrab(void *p, size_t n) {
	p = realloc(p, n ? n : 1);
	return p != NULL ? p : full();
}
static char *copy(const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(grab(n), s, n);
}

// hashing

// MurmurHash3's finalizer: its 64-bit one where a size_t is 64 bits, its 32-bit one where it is 32
static size_t mix(size_t x) {
#if SIZE_MAX > 0xffffffffu
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdULL;
	x ^= x >> 33;
#else
	x ^= x >> 16;
	x *= 0x85ebca6bu;
	x ^= x >> 13;
	x *= 0xc2b2ae35u;
	x ^= x >> 16;
#endif
	return x;
}
// 64-bit FNV-1a, cut to a size_t at the end
static size_t text(const char *s) {
	uint64_t h = 1469598103934665603ULL;
	for (; *s; s++) h = (h ^ (unsigned char)*s) * 1099511628211ULL;
	return (size_t)h;
}
static size_t hash_key(pt_key k) { return k.symbol ? mix((uintptr_t)k.symbol) : text(k.string); }
static int same_key(pt_key a, pt_key b) {
	if (a.symbol || b.symbol) return a.symbol == b.symbol;
	return strcmp(a.string, b.string) == 0;
}

// a chained map; every record starts with its link
typedef struct link {
	struct link *chain;
	size_t hash;
} link;
typedef struct {
	link **slots;
	size_t size, count;
} map;

static link **slot(const map *m, size_t h) { return &m->slots[h & (m->size - 1)]; }
static void add(map *m, link *x) {
	if (m->count >= m->size) {
		size_t size = m->size ? m->size * 2 : 16;
		link **slots = calloc(size, sizeof *slots);
		if (slots == NULL) full();
		map grown = {slots, size, m->count};
		for (size_t i = 0; i < m->size; i++) {
			for (link *y = m->slots[i], *next; y != NULL; y = next) {
				next = y->chain;
				link **at = slot(&grown, y->hash);
				y->chain = *at;
				*at = y;
			}
		}
		free(m->slots);
		*m = grown;
	}
	link **at = slot(m, x->hash);
	x->chain = *at;
	*at = x;
	m->count++;
}
static void del(map *m, link *x) {
	link **at = slot(m, x->hash);
	while (*at != x) at = &(*at)->chain;
	*at = x->chain;
	m->count--;
}

// one path step in a key's trie; at the top: up NULL, no key
struct pt_step {
	link link;
	pt_step *up;
	op_key key;
	// the kids, in the order made, and this one's siblings in up's
	pt_step *first, *last, *next, *prev;
	// the kids with number keys, by key
	pt_step **nums;
	size_t count, capacity;
	pt_spot *spot;
	// the keys spot at this path
	pt_spot *keys;
};
struct pt_root {
	link link;
	pt_key source, id;
	pt_step top;
	pt_spot *change;
};
struct pt_paths {
	map roots, steps;
	pt_held held;
	// every mark call takes the next tick
	uint64_t tick;
	// what the last call marked
	pt_spot **out;
	size_t count, capacity;
};

pt_paths *pt_new(void) {
	pt_paths *p = grab(sizeof *p);
	*p = (pt_paths){0};
	return p;
}

static pt_key keep(pt_key k) { return k.symbol ? k : pt_string(copy(k.string)); }
static size_t hash_root(pt_key source, pt_key id) { return mix(hash_key(source) * 31 + hash_key(id)); }
static pt_root *root(pt_paths *p, pt_key source, pt_key id, int make) {
	size_t h = hash_root(source, id);
	for (link *x = p->roots.size ? *slot(&p->roots, h) : NULL; x != NULL; x = x->chain) {
		pt_root *r = (pt_root *)x;
		if (x->hash == h && same_key(r->source, source) && same_key(r->id, id)) return r;
	}
	if (!make) return NULL;
	pt_root *r = grab(sizeof *r);
	*r = (pt_root){.link.hash = h, .source = keep(source), .id = keep(id)};
	add(&p->roots, &r->link);
	p->held.keys++;
	p->held.steps++;
	return r;
}

static int same(const op_key *a, const op_key *b) {
	if (a->type != b->type) return 0;
	return a->type == OP_NUM_KEY ? a->n == b->n : strcmp(a->s, b->s) == 0;
}
static size_t hash_step(const pt_step *up, const op_key *k) {
	return mix((uintptr_t)up) ^ (k->type == OP_NUM_KEY ? mix((size_t)k->n * 2 + 1) : text(k->s));
}
static pt_step *kid(const pt_paths *p, const pt_step *up, const op_key *k) {
	if (up->first == NULL) return NULL;
	size_t h = hash_step(up, k);
	for (link *x = *slot(&p->steps, h); x != NULL; x = x->chain) {
		pt_step *s = (pt_step *)x;
		if (x->hash == h && s->up == up && same(&s->key, k)) return s;
	}
	return NULL;
}
// the first of up's number kids with key >= a
static size_t from(const pt_step *up, int64_t a) {
	size_t lo = 0, hi = up->count;
	while (lo < hi) {
		size_t mid = (lo + hi) / 2;
		if (up->nums[mid]->key.n < a) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
static pt_step *make_kid(pt_paths *p, pt_step *up, const op_key *k) {
	pt_step *s = grab(sizeof *s);
	*s = (pt_step){.link.hash = hash_step(up, k), .up = up, .key = {.type = k->type}};
	if (k->type == OP_NUM_KEY) s->key.n = k->n;
	else s->key.s = copy(k->s);
	add(&p->steps, &s->link);
	s->prev = up->last;
	if (up->last != NULL) up->last->next = s;
	else up->first = s;
	up->last = s;
	if (k->type == OP_NUM_KEY) {
		// in index order: at the end
		size_t i = up->count && up->nums[up->count - 1]->key.n > k->n ? from(up, k->n) : up->count;
		if (up->count == up->capacity) {
			up->capacity = up->capacity ? up->capacity * 2 : 4;
			up->nums = regrab(up->nums, up->capacity * sizeof *up->nums);
		}
		memmove(up->nums + i + 1, up->nums + i, (up->count - i) * sizeof *up->nums);
		up->nums[i] = s;
		up->count++;
	}
	p->held.steps++;
	return s;
}

static pt_spot *made(pt_paths *p, pt_root *r, pt_step *at, size_t length, int keys) {
	pt_spot *s = grab(sizeof *s);
	*s = (pt_spot){.source = r->source, .id = r->id, .length = length, .keys = keys, .step = at, .root = r};
	// the keys, the steps' own: they outlive the spot
	op_key *path = grab(length * sizeof *path);
	for (pt_step *x = at; x != NULL && x->up != NULL; x = x->up) path[--length] = x->key;
	s->path = path;
	p->held.spots++;
	return s;
}

pt_spot *pt_spot_of(pt_paths *p, pt_key source, pt_key id, const op_key *path, size_t length,
	int keys) {
	pt_root *r = root(p, source, id, 1);
	pt_step *at = &r->top;
	for (size_t i = 0; i < length; i++) {
		pt_step *next = kid(p, at, &path[i]);
		at = next != NULL ? next : make_kid(p, at, &path[i]);
	}
	pt_spot **here = keys ? &at->keys : &at->spot;
	if (*here == NULL) *here = made(p, r, at, length, keys != 0);
	return *here;
}

pt_spot *pt_change_of(pt_paths *p, pt_key source, pt_key id) {
	pt_root *r = root(p, source, id, 1);
	if (r->change == NULL) {
		r->change = made(p, r, NULL, 0, 0);
		r->change->change = 1;
	}
	return r->change;
}

// a place a patch changes: a take, a landing, or the patch itself. put: something lands there (an
// unranged put is a replace, never a shift). n: positions in a ranged place, -1 when not known (a
// value that is not a list: a string or typed array, a leaf)
typedef struct {
	const op_key *path;
	size_t length;
	int ranged;
	int64_t a, b;
	int put;
	int64_t n;
} place;

// a move is its take and its landing; a landing holds the take's count, or 1
static size_t places(const op_patch *p, place out[2]) {
	const op_target *t = &p->place;
	if (p->has_move) {
		const op_target *m = &p->move;
		out[0] = (place){m->path, m->length, m->has_range, m->from, m->to, 0, 0};
		int64_t n = m->has_range ? m->to - m->from : 1;
		out[1] = (place){t->path, t->length, t->has_range, t->from, t->to, 1, n};
		return 2;
	}
	int64_t n = !p->has_value ? 0 : p->value != NULL && p->value->type == OP_LIST ? (int64_t)p->value->count : -1;
	out[0] = (place){t->path, t->length, t->has_range, t->from, t->to, p->has_value, n};
	return 1;
}

// a list's removal at S+[k] shifts the kids of S from k on
static int shifts(const place *q) {
	return !q->ranged && !q->put && q->length > 0 && q->path[q->length - 1].type == OP_NUM_KEY;
}

static int hit(const place *q, const op_key *path, size_t length) {
	size_t n = q->length, i = 0;
	while (i < n && i < length && same(&path[i], &q->path[i])) i++;
	// the read is at Q or above it: the change is inside what it read
	if (i == length) return 1;
	// beside Q: only a list removal's shift reaches it, past Q's last step
	if (i < n) {
		return i == n - 1 && shifts(q) && path[i].type == OP_NUM_KEY && path[i].n > q->path[i].n;
	}
	// under Q: an unranged place replaced it; a ranged one reaches it by its index
	if (!q->ranged) return 1;
	if (path[n].type != OP_NUM_KEY) return 0;
	long k = path[n].n;
	return q->n == q->b - q->a ? k >= q->a && k < q->b : k >= q->a;
}

static int keyed(const place *q, const op_key *path, size_t length) {
	if (q->length <= length) return hit(q, path, length);
	if (q->length != length + 1 || q->ranged) return 0;
	for (size_t i = 0; i < length; i++)
		if (!same(&path[i], &q->path[i])) return 0;
	return 1;
}

int pt_marks(const op_patch *patch, const op_key *path, size_t length, int keys) {
	place q[2];
	size_t n = places(patch, q);
	for (size_t i = 0; i < n; i++)
		if (keys ? keyed(&q[i], path, length) : hit(&q[i], path, length)) return 1;
	return 0;
}

static void give(pt_paths *p, pt_spot *s) {
	if (s == NULL || s->seen == p->tick) return;
	s->seen = p->tick;
	if (p->count == p->capacity) {
		p->capacity = p->capacity ? p->capacity * 2 : 16;
		p->out = regrab(p->out, p->capacity * sizeof *p->out);
	}
	p->out[p->count++] = s;
}
// every spot at or under at
static void all(pt_paths *p, const pt_step *at) {
	give(p, at->spot);
	give(p, at->keys);
	for (pt_step *k = at->first; k != NULL; k = k->next) all(p, k);
}
// at's number kids from a on, up to b
static void span(pt_paths *p, const pt_step *at, int64_t a, int64_t b, int open) {
	for (size_t i = from(at, a); i < at->count; i++) {
		if (!open && at->nums[i]->key.n >= b) return;
		all(p, at->nums[i]);
	}
}
static void mark_place(pt_paths *p, pt_root *r, const place *q) {
	const pt_step *at = &r->top;
	for (size_t i = 0; i < q->length; i++) {
		give(p, at->spot);
		// a keys read one step above an unranged place
		if (i == q->length - 1 && !q->ranged) give(p, at->keys);
		if (i == q->length - 1 && shifts(q)) span(p, at, q->path[i].n + 1, 0, 1);
		const pt_step *next = kid(p, at, &q->path[i]);
		if (next == NULL) return;
		at = next;
	}
	if (!q->ranged) {
		all(p, at);
		return;
	}
	give(p, at->spot);
	give(p, at->keys);
	span(p, at, q->a, q->b, q->n != q->b - q->a);
}

pt_spot *const *pt_mark(pt_paths *p, pt_key source, pt_key id, const op_patch *patches, size_t n,
	size_t *length) {
	p->count = 0;
	pt_root *r = root(p, source, id, 0);
	if (r != NULL) {
		p->tick++;
		give(p, r->change);
		for (size_t i = 0; i < n; i++) {
			place q[2];
			size_t m = places(&patches[i], q);
			for (size_t j = 0; j < m; j++) mark_place(p, r, &q[j]);
		}
	}
	*length = p->count;
	return p->out;
}

pt_spot *const *pt_event(pt_paths *p, pt_key source, pt_key id, size_t *length) {
	op_patch whole = {0};
	return pt_mark(p, source, id, &whole, 1, length);
}

static void free_spot(pt_paths *p, pt_spot *s) {
	free((void *)s->path);
	free(s);
	p->held.spots--;
}
static void free_root(pt_paths *p, pt_root *r) {
	if (r->source.symbol == NULL) free((void *)r->source.string);
	if (r->id.symbol == NULL) free((void *)r->id.string);
	free(r->top.nums);
	free(r);
	p->held.keys--;
	p->held.steps--;
}

void pt_release(pt_paths *p, pt_spot *s) {
	pt_root *r = s->root;
	if (s->change) r->change = NULL;
	else {
		pt_step *at = s->step;
		if (s->keys) at->keys = NULL;
		else at->spot = NULL;
		while (at->up != NULL && at->spot == NULL && at->keys == NULL && at->first == NULL) {
			pt_step *up = at->up;
			if (at->prev != NULL) at->prev->next = at->next;
			else up->first = at->next;
			if (at->next != NULL) at->next->prev = at->prev;
			else up->last = at->prev;
			if (at->key.type == OP_NUM_KEY) {
				size_t i = from(up, at->key.n);
				memmove(up->nums + i, up->nums + i + 1, (up->count - i - 1) * sizeof *up->nums);
				if (--up->count == 0) {
					free(up->nums);
					up->nums = NULL;
					up->capacity = 0;
				}
			} else free((char *)at->key.s);
			del(&p->steps, &at->link);
			free(at->nums);
			free(at);
			p->held.steps--;
			at = up;
		}
	}
	free_spot(p, s);
	if (r->change != NULL || r->top.spot != NULL || r->top.keys != NULL || r->top.first != NULL)
		return;
	del(&p->roots, &r->link);
	free_root(p, r);
}

pt_held pt_held_of(const pt_paths *p) { return p->held; }

static void free_steps(pt_paths *p, pt_step *at) {
	for (pt_step *k = at->first, *next; k != NULL; k = next) {
		next = k->next;
		free_steps(p, k);
		if (k->key.type == OP_STR_KEY) free((char *)k->key.s);
		free(k->nums);
		free(k);
	}
	if (at->spot != NULL) free_spot(p, at->spot);
	if (at->keys != NULL) free_spot(p, at->keys);
}
void pt_free(pt_paths *p) {
	for (size_t i = 0; i < p->roots.size; i++) {
		for (link *x = p->roots.slots[i], *next; x != NULL; x = next) {
			next = x->chain;
			pt_root *r = (pt_root *)x;
			free_steps(p, &r->top);
			if (r->change != NULL) free_spot(p, r->change);
			free_root(p, r);
		}
	}
	free(p->roots.slots);
	free(p->steps.slots);
	free(p->out);
	free(p);
}
