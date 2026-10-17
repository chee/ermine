// Squishing patches, and patches as columns, in C. The rules: squish.ts; this follows it step for
// step, merges reaching back included. Joined values are the squisher's own, a buffer per patch
// that grows in place, so typing one character at a time is amortised linear.
#include "squish.h"

#include <stdlib.h>
#include <string.h>

static void *grow(void *p, size_t *cap, size_t want, size_t each) {
	if (want <= *cap) return p;
	size_t c = *cap ? *cap : 8;
	while (c < want) c *= 2;
	p = realloc(p, c * each);
	if (!p) abort();
	*cap = c;
	return p;
}

// a string's positions: code points. a lone surrogate is held as WTF-8 (three bytes, ED A0..BF
// xx): a position of its own
sq_value sq_str(const char *s, size_t size) {
	size_t n = 0;
	int lone = 0;
	for (size_t i = 0; i < size; i++) {
		unsigned char b = (unsigned char)s[i];
		if ((b & 0xC0) == 0x80) continue;
		n++;
		if (b == 0xED && i + 1 < size && (unsigned char)s[i + 1] >= 0xA0) lone = 1;
	}
	return (sq_value){SQ_STR, n, size, s, lone};
}
sq_value sq_list(const void *const *e, size_t n) {
	return (sq_value){SQ_LIST, n, n * sizeof(void *), (const void *)e, 0};
}
sq_value sq_any(const void *v) { return (sq_value){SQ_ANY, 0, 0, v, 0}; }

// the byte offset of position i (element for the rest): code points for strings
static size_t offset(const sq_value *v, size_t i) {
	if (v->kind == SQ_LIST) return i * sizeof(void *);
	const unsigned char *s = v->data;
	size_t total = v->n;
	if (i >= total) return v->size;
	// the back half from the end: where typing and backspacing happen
	if (i > total / 2) {
		size_t at = v->size, seen = total;
		while (seen > i) {
			do at--;
			while ((s[at] & 0xC0) == 0x80);
			seen--;
		}
		return at;
	}
	size_t at = 0, seen = 0;
	while (seen < i) {
		seen++;
		do at++;
		while (at < v->size && (s[at] & 0xC0) == 0x80);
	}
	return at;
}

static int same_key(const sq_key *a, const sq_key *b) {
	if (a->s && b->s) return strcmp(a->s, b->s) == 0;
	return !a->s && !b->s && a->n == b->n;
}
static int same(const sq_key *p, size_t pn, const sq_key *q, size_t qn) {
	if (pn != qn) return 0;
	for (size_t i = 0; i < pn; i++)
		if (!same_key(&p[i], &q[i])) return 0;
	return 1;
}
// q is at or above p
static int under(const sq_key *p, size_t pn, const sq_key *q, size_t qn) {
	return qn <= pn && same(p, qn, q, qn);
}

// a patch's own buffer: its value's data, made here; no one else points into it
typedef struct {
	void *p;
	size_t cap;
} own;

struct sq {
	sq_patch *buf;
	// one per patch: its own buffer, or none (p NULL)
	own *own;
	size_t n, cap;
	// where a lone surrogate was put: nothing at or under is merged again
	struct {
		const sq_key *keys;
		size_t depth;
	} *fouled;
	size_t nfouled, capfouled;
};

sq *sq_new(void) {
	sq *s = calloc(1, sizeof *s);
	if (!s) abort();
	return s;
}

static int is_fouled(const sq *s, const sq_key *path, size_t depth) {
	for (size_t i = 0; i < s->nfouled; i++)
		if (under(path, depth, s->fouled[i].keys, s->fouled[i].depth)) return 1;
	return 0;
}

// the last patch is going: its own buffer with it
static void drop_tail(sq *s) {
	s->n--;
	free(s->own[s->n].p);
	s->own[s->n] = (own){NULL, 0};
}

// patch i's value's [x, y) (positions) replaced by w's data; w NULL: removed. 0: the kinds differ
static int splice(sq *s, size_t i, size_t x, size_t y, const sq_value *w) {
	sq_value *v = &s->buf[i].value;
	if (w && w->kind != v->kind) return 0;
	size_t bx = offset(v, x), by = offset(v, y), wsize = w ? w->size : 0;
	size_t n = v->n - (y - x) + (w ? w->n : 0);
	size_t size = bx + wsize + (v->size - by);
	own *o = &s->own[i];
	// its own buffer: in place
	if (o->p) {
		if (size > o->cap) {
			size_t c = o->cap * 2 > size ? o->cap * 2 : size;
			o->p = realloc(o->p, c);
			if (!o->p) abort();
			o->cap = c;
		}
		unsigned char *p = o->p;
		if (by < v->size) memmove(p + bx + wsize, p + by, v->size - by);
		if (wsize) memcpy(p + bx, w->data, wsize);
		v->data = p, v->size = size, v->n = n;
		return 1;
	}
	size_t cap = size * 2 ? size * 2 : 1;
	unsigned char *p = malloc(cap);
	if (!p) abort();
	memcpy(p, v->data, bx);
	if (wsize) memcpy(p + bx, w->data, wsize);
	memcpy(p + bx + wsize, (const unsigned char *)v->data + by, v->size - by);
	*o = (own){p, cap};
	v->data = p, v->size = size, v->n = n;
	return 1;
}

// patch i made to do what it and next do; 0: it cannot
static int merge(sq *s, size_t i, const sq_patch *next) {
	sq_patch *prev = &s->buf[i];
	if (!prev->has_range || !next->has_range || prev->move || next->move) return 0;
	if (!same(prev->path, prev->depth, next->path, next->depth)) return 0;
	int64_t a = prev->from, b = prev->to, c = next->from, d = next->to;
	const sq_value *w = next->has_value ? &next->value : NULL;
	if (prev->has_value) {
		if (prev->value.kind == SQ_ANY) return 0;
		int64_t n = (int64_t)prev->value.n;
		if (a <= c && d <= a + n) return splice(s, i, (size_t)(c - a), (size_t)(d - a), w);
		if (c == a + n && d > c) {
			if (w && !splice(s, i, (size_t)n, (size_t)n, w)) return 0;
			prev->to = b + (d - c);
			return 1;
		}
		return 0;
	}
	// prev removed [a, b)
	if (!w) {
		if (c <= a && a <= d) {
			prev->from = c, prev->to = b + (d - a);
			return 1;
		}
		return 0;
	}
	if (c == a && d == a) {
		prev->has_value = 1, prev->value = *w;
		return 1;
	}
	return 0;
}

// prev and next might merge, by their ranges alone: cheaper than a merge that fails
static int could(const sq_patch *prev, const sq_patch *next) {
	if (!prev->has_range || !next->has_range) return 0;
	int64_t a = prev->from, c = next->from, d = next->to;
	if (!prev->has_value) return next->has_value ? c == a && d == a : c <= a && a <= d;
	int64_t n = (int64_t)prev->value.n;
	return prev->value.kind != SQ_ANY && ((a <= c && d <= a + n) || (c == a + n && d > c));
}

// merges reach back: the last patch, just merged, merged into the one before it, while they do.
// at the path just merged, so never fouled
static void back(sq *s) {
	while (s->n > 1 && could(&s->buf[s->n - 2], &s->buf[s->n - 1])) {
		if (!merge(s, s->n - 2, &s->buf[s->n - 1])) return;
		// the last's own buffer: the one before's now, if its value is it (an insert after a removal)
		own *last = &s->own[s->n - 1];
		if (last->p && s->buf[s->n - 2].value.data == last->p) s->own[s->n - 2] = *last;
		else free(last->p);
		*last = (own){NULL, 0};
		s->n--;
	}
}

// the patches taken back, the lone surrogates seen still kept
static void reset(sq *s) {
	while (s->n) drop_tail(s);
}

void sq_push(sq *s, const sq_patch *p) {
	if (p->depth == 0 && !p->has_range && !p->move) {
		reset(s);
	} else {
		while (s->n) {
			const sq_patch *t = &s->buf[s->n - 1];
			if (p->has_range || p->move || t->move || !under(t->path, t->depth, p->path, p->depth)) break;
			// t removing a list element (a number last) moves the ones after it: p at the same place
			// is at another element
			if (!t->has_value && !t->has_range && t->depth == p->depth && !t->path[t->depth - 1].s) break;
			drop_tail(s);
		}
	}
	// a lone surrogate makes positions depend on what is around it (a lone high meeting a lone low
	// is one pair, a position fewer): never merged, nor what is at or under where it went
	if ((p->has_value && p->value.lone) || (p->move && is_fouled(s, p->move_path, p->move_depth))) {
		s->fouled = grow(s->fouled, &s->capfouled, s->nfouled + 1, sizeof *s->fouled);
		s->fouled[s->nfouled].keys = p->path, s->fouled[s->nfouled++].depth = p->depth;
	} else if (s->n && !is_fouled(s, p->path, p->depth) && merge(s, s->n - 1, p)) {
		back(s);
		return;
	}
	if (s->n == s->cap) {
		size_t cap = s->cap;
		s->buf = grow(s->buf, &cap, s->n + 1, sizeof *s->buf);
		s->own = realloc(s->own, cap * sizeof *s->own);
		if (!s->own) abort();
		s->cap = cap;
	}
	s->buf[s->n] = *p;
	s->own[s->n++] = (own){NULL, 0};
}

const sq_patch *sq_patches(const sq *s, size_t *n) {
	*n = s->n;
	return s->buf;
}

void sq_clear(sq *s) {
	reset(s);
	s->nfouled = 0;
}

void sq_free(sq *s) {
	if (!s) return;
	sq_clear(s);
	free(s->own);
	free(s->fouled);
	free(s->buf);
	free(s);
}

// columns

typedef struct {
	sq_runs r;
	size_t cap;
} runs;

static void run(runs *r, int64_t x) {
	if (r->r.n && r->r.v[r->r.n - 2] == x) {
		r->r.v[r->r.n - 1]++;
		return;
	}
	r->r.v = grow(r->r.v, &r->cap, r->r.n + 2, sizeof *r->r.v);
	r->r.v[r->r.n++] = x;
	r->r.v[r->r.n++] = 1;
}

static uint64_t hash(const sq_key *k, size_t depth) {
	uint64_t h = 1469598103934665603u;
#define MIX(byte) (h = (h ^ (unsigned char)(byte)) * 1099511628211u)
	for (size_t i = 0; i < depth; i++) {
		if (k[i].s) {
			MIX('s');
			for (const char *c = k[i].s; *c; c++) MIX(*c);
			MIX(0);
		} else {
			MIX('n');
			uint64_t n = (uint64_t)(int64_t)k[i].n;
			for (int j = 0; j < 8; j++) MIX(n >> (8 * j));
		}
	}
#undef MIX
	return h;
}

sq_columns sq_encode(const sq_patch *ps, size_t n) {
	sq_columns c = {0};
	runs path = {0}, shape = {0}, from = {0}, size = {0};
	size_t mask = 15;
	while (mask < n * 2) mask = mask * 2 + 1;
	long *table = malloc((mask + 1) * sizeof(long));
	if (!table) abort();
	memset(table, -1, (mask + 1) * sizeof(long));
	if (n) {
		c.paths = malloc(n * sizeof *c.paths);
		c.value = malloc(n * sizeof *c.value);
		c.move = malloc(n * sizeof *c.move);
		if (!c.paths || !c.value || !c.move) abort();
	}
	int64_t last = 0;
	for (size_t i = 0; i < n; i++) {
		const sq_patch *p = &ps[i];
		size_t at = (size_t)hash(p->path, p->depth) & mask;
		for (; table[at] != -1; at = (at + 1) & mask) {
			const sq_path *q = &c.paths[table[at]];
			if (same(q->keys, q->depth, p->path, p->depth)) break;
		}
		if (table[at] == -1) {
			table[at] = (long)c.npaths;
			c.paths[c.npaths++] = (sq_path){p->path, p->depth};
		}
		run(&path, table[at]);
		run(&shape, (p->has_range ? 1 : 0) | (p->has_value ? 2 : 0) | (p->move ? 4 : 0));
		if (p->has_range) {
			run(&from, p->from - last);
			run(&size, p->to - p->from);
			last = p->from;
		}
		if (p->has_value) c.value[c.nvalue++] = p->value;
		if (p->move) c.move[c.nmove++] = p->move;
	}
	free(table);
	c.path = path.r, c.shape = shape.r, c.from = from.r, c.size = size.r;
	return c;
}

void sq_columns_free(sq_columns *c) {
	free(c->paths);
	free(c->path.v);
	free(c->shape.v);
	free(c->from.v);
	free(c->size.v);
	free(c->value);
	free(c->move);
	*c = (sq_columns){0};
}

typedef struct {
	const sq_runs *r;
	size_t i;
	int64_t left;
} cursor;

// 0: the runs are used up
static int next(cursor *k, int64_t *out) {
	while (k->left <= 0) {
		if (k->i + 1 >= k->r->n) return 0;
		k->left = k->r->v[k->i + 1];
		k->i += 2;
	}
	k->left--;
	*out = k->r->v[k->i - 2];
	return 1;
}

static size_t count(const sq_runs *r) {
	size_t n = 0;
	for (size_t i = 1; i < r->n; i += 2)
		if (r->v[i] > 0) n += (size_t)r->v[i];
	return n;
}

sq_patch *sq_decode(const sq_columns *c, size_t *n) {
	*n = count(&c->shape);
	if (!*n) return NULL;
	sq_patch *out = calloc(*n, sizeof *out);
	if (!out) abort();
	cursor path = {&c->path, 0, 0}, shape = {&c->shape, 0, 0}, from = {&c->from, 0, 0},
	       size = {&c->size, 0, 0};
	int64_t last = 0, s, x;
	size_t v = 0, m = 0;
	for (size_t i = 0; i < *n; i++) {
		sq_patch *p = &out[i];
		if (!next(&shape, &s) || !next(&path, &x) || x < 0 || (size_t)x >= c->npaths) goto bad;
		p->path = c->paths[x].keys, p->depth = c->paths[x].depth;
		if (s & 1) {
			int64_t f, z;
			if (!next(&from, &f) || !next(&size, &z)) goto bad;
			last += f;
			p->has_range = 1, p->from = last, p->to = last + z;
		}
		if (s & 2) {
			if (v >= c->nvalue) goto bad;
			p->has_value = 1, p->value = c->value[v++];
		}
		if (s & 4) {
			if (m >= c->nmove) goto bad;
			p->move = c->move[m++];
		}
	}
	return out;
bad:
	free(out);
	*n = (size_t)-1;
	return NULL;
}
