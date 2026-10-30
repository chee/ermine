// Squishing patches and patches as columns, in C. The rules are squish.ts's, followed step for
// step. Joined values are the squisher's own buffers, so typing one character at a time is linear.
#include "squish.h"

#include <stdint.h>
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

// A string's positions are code points. A lone surrogate is held as WTF-8 (three bytes,
// ED A0..BF xx) and is a position of its own.
sq_value sq_str(const char *s, size_t size) {
	size_t n = 0;
	int lone = 0;
	for (size_t i = 0; i < size; i++) {
		unsigned char b = (unsigned char)s[i];
		if ((b & 0xC0) == 0x80) continue;
		n++;
		if (b == 0xED && i + 1 < size && (unsigned char)s[i + 1] >= 0xA0) lone = 1;
	}
	return (sq_value){SQ_STR, n, size, s, lone, 0, 0};
}
sq_value sq_list(const void *const *e, size_t n) {
	return (sq_value){SQ_LIST, n, n * sizeof(void *), (const void *)e, 0, 0, sizeof(void *)};
}
sq_value sq_typed(int of, size_t each, const void *data, size_t n) {
	return (sq_value){SQ_TYPED, n, n * each, data, 0, of, each};
}
sq_value sq_any(const void *v) { return (sq_value){SQ_ANY, 0, 0, v, 0, 0, 0}; }

static size_t offset(const sq_value *v, size_t i) {
	size_t total = v->n;
	if (i >= total) return v->size;
	if (v->kind != SQ_STR) return i * v->each;
	const unsigned char *s = v->data;
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
static int under(const sq_key *p, size_t pn, const sq_key *q, size_t qn) {
	return qn <= pn && same(p, qn, q, qn);
}

// x + y or x - y in *out. Returns 0 past what an int64_t holds (a range there is never joined).
static int add(int64_t x, int64_t y, int64_t *out) {
	if (y > 0 ? x > INT64_MAX - y : x < INT64_MIN - y) return 0;
	*out = x + y;
	return 1;
}
static int sub(int64_t x, int64_t y, int64_t *out) {
	if (y < 0 ? x > INT64_MAX + y : x < INT64_MIN + y) return 0;
	*out = x - y;
	return 1;
}

typedef struct {
	void *p;
	size_t cap;
} own;

typedef struct {
	const sq_key *keys;
	size_t depth;
	sq_key *made;
} place;

struct sq {
	sq_patch *buf;
	own *own;
	size_t n, cap;
	place *fouled;
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
static void foul(sq *s, const sq_key *keys, size_t depth, sq_key *made) {
	s->fouled = grow(s->fouled, &s->capfouled, s->nfouled + 1, sizeof *s->fouled);
	s->fouled[s->nfouled++] = (place){keys, depth, made};
}
static void unfoul(sq *s) {
	for (size_t i = 0; i < s->nfouled; i++) free(s->fouled[i].made);
	s->nfouled = 0;
}

static int moved(sq *s, const sq_patch *p) {
	if (is_fouled(s, p->move_path, p->move_depth)) return 1;
	for (size_t i = 0, n = s->nfouled; i < n; i++) {
		place f = s->fouled[i];
		if (f.depth <= p->move_depth || !under(f.keys, f.depth, p->move_path, p->move_depth)) continue;
		if (p->has_range || p->move_has_range) return 1;
		size_t depth = p->depth + f.depth - p->move_depth;
		sq_key *k = malloc(depth * sizeof *k);
		if (!k) abort();
		if (p->depth) memcpy(k, p->path, p->depth * sizeof *k);
		if (f.depth > p->move_depth) memcpy(k + p->depth, f.keys + p->move_depth, (f.depth - p->move_depth) * sizeof *k);
		foul(s, k, depth, k);
	}
	return 0;
}

static void drop_tail(sq *s) {
	s->n--;
	free(s->own[s->n].p);
	s->own[s->n] = (own){NULL, 0};
}

static int splice(sq *s, size_t i, size_t x, size_t y, const sq_value *w) {
	sq_value *v = &s->buf[i].value;
	if (w && (w->kind != v->kind || w->of != v->of)) return 0;
	size_t bx = offset(v, x), by = offset(v, y), wsize = w ? w->size : 0;
	size_t n = v->n - (y - x) + (w ? w->n : 0);
	size_t size = bx + wsize + (v->size - by);
	own *o = &s->own[i];
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
	if (bx) memcpy(p, v->data, bx);
	if (wsize) memcpy(p + bx, w->data, wsize);
	if (v->size > by) memcpy(p + bx + wsize, (const unsigned char *)v->data + by, v->size - by);
	*o = (own){p, cap};
	v->data = p, v->size = size, v->n = n;
	return 1;
}

static int merge(sq *s, size_t i, const sq_patch *next) {
	sq_patch *prev = &s->buf[i];
	if (!prev->has_range || !next->has_range || prev->move || next->move) return 0;
	if (!same(prev->path, prev->depth, next->path, next->depth)) return 0;
	int64_t a = prev->from, b = prev->to, c = next->from, d = next->to;
	const sq_value *w = next->has_value ? &next->value : NULL;
	int64_t x, y, to;
	if (prev->has_value) {
		if (prev->value.kind == SQ_ANY) return 0;
		int64_t n = (int64_t)prev->value.n, end;
		if (!add(a, n, &end)) return 0;
		if (a <= c && d <= end) {
			if (!sub(c, a, &x) || !sub(d, a, &y)) return 0;
			return splice(s, i, (size_t)x, (size_t)y, w);
		}
		if (c == end && d > c) {
			if (!sub(d, c, &y) || !add(b, y, &to)) return 0;
			if (w && !splice(s, i, (size_t)n, (size_t)n, w)) return 0;
			prev->to = to;
			return 1;
		}
		return 0;
	}
	if (!w) {
		if (c <= a && a <= d) {
			if (!sub(d, a, &y) || !add(b, y, &to)) return 0;
			prev->from = c, prev->to = to;
			return 1;
		}
		return 0;
	}
	if (c == a && d == a && w->kind != SQ_ANY) {
		prev->has_value = 1, prev->value = *w;
		return 1;
	}
	return 0;
}

static int could(const sq_patch *prev, const sq_patch *next) {
	if (!prev->has_range || !next->has_range) return 0;
	int64_t a = prev->from, c = next->from, d = next->to, end;
	if (!prev->has_value) {
		return next->has_value ? c == a && d == a && next->value.kind != SQ_ANY : c <= a && a <= d;
	}
	return prev->value.kind != SQ_ANY && add(a, (int64_t)prev->value.n, &end) &&
	       ((a <= c && d <= end) || (c == end && d > c));
}

static void back(sq *s) {
	while (s->n > 1 && could(&s->buf[s->n - 2], &s->buf[s->n - 1])) {
		if (!merge(s, s->n - 2, &s->buf[s->n - 1])) return;
		own *last = &s->own[s->n - 1];
		if (last->p && s->buf[s->n - 2].value.data == last->p) s->own[s->n - 2] = *last;
		else free(last->p);
		*last = (own){NULL, 0};
		s->n--;
	}
}

static void reset(sq *s) {
	while (s->n) drop_tail(s);
}

void sq_push(sq *s, const sq_patch *p) {
	if (p->depth == 0 && !p->has_range && !p->move) {
		reset(s);
		unfoul(s);
	} else {
		while (s->n) {
			const sq_patch *t = &s->buf[s->n - 1];
			if (p->has_range || p->move || t->move || !under(t->path, t->depth, p->path, p->depth)) break;
			if (!t->has_value && !t->has_range && t->depth == p->depth && !t->path[t->depth - 1].s) break;
			drop_tail(s);
		}
	}
	// A lone surrogate makes positions depend on what surrounds it, so it is never merged, nor is
	// anything at or under where it went.
	if ((p->has_value && p->value.lone) || (p->move && moved(s, p))) {
		foul(s, p->path, p->depth, NULL);
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
	unfoul(s);
}

void sq_free(sq *s) {
	if (!s) return;
	sq_clear(s);
	free(s->own);
	free(s->fouled);
	free(s->buf);
	free(s);
}


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

// x + y, wrapping past the ends, so a column's steps and sizes come back as they went.
static int64_t wrap(int64_t x, uint64_t y) { return (int64_t)((uint64_t)x + y); }

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
			run(&from, wrap(p->from, -(uint64_t)last));
			run(&size, wrap(p->to, -(uint64_t)p->from));
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

static int count(const sq_runs *r, size_t *n) {
	*n = 0;
	for (size_t i = 1; i < r->n; i += 2) {
		if (r->v[i] <= 0) continue;
		if ((uint64_t)r->v[i] > SIZE_MAX - *n) return 0;
		*n += (size_t)r->v[i];
	}
	return 1;
}

static int count_bit(const sq_runs *r, int bit, size_t *n) {
	*n = 0;
	for (size_t i = 1; i < r->n; i += 2) {
		if (r->v[i] <= 0 || !(r->v[i - 1] & bit)) continue;
		if ((uint64_t)r->v[i] > SIZE_MAX - *n) return 0;
		*n += (size_t)r->v[i];
	}
	return 1;
}

static int covers(const sq_columns *c, size_t n) {
	size_t path, from, size, ranged, values, moves;
	if (!count(&c->path, &path) || !count(&c->from, &from) || !count(&c->size, &size)) return 0;
	if (!count_bit(&c->shape, 1, &ranged) || !count_bit(&c->shape, 2, &values) ||
	    !count_bit(&c->shape, 4, &moves))
		return 0;
	return path >= n && from >= ranged && size >= ranged && c->nvalue >= values && c->nmove >= moves;
}

sq_patch *sq_decode(const sq_columns *c, size_t *n) {
	if (!count(&c->shape, n) || !covers(c, *n)) return *n = (size_t)-1, NULL;
	if (!*n) return NULL;
	sq_patch *out = calloc(*n, sizeof *out);
	if (!out) return *n = (size_t)-1, NULL;
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
			last = wrap(last, (uint64_t)f);
			p->has_range = 1, p->from = last, p->to = wrap(last, (uint64_t)z);
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
