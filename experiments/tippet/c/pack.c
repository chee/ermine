// pack: a run's steps, small (../WIRE.md pack, columns). tp_pack reads each step and patch once,
// then writes each column from them; tp_unpack checks every column's length before it makes
// anything, then makes each step's bytes again, exactly, so chain and signature check as ever
#include <string.h>

#include "wire.h"

// the columns, in the order they are written
enum { LAMPORT, WHEN, NODE, PART, WHO, COUNT, PATH, SHAPE, FROM, SIZE, VALUE, MOVE };

// an item of a column: a number, text, null, an item's bytes as they are, or a node relative to the
// device ([text])
enum { NUM, TEXT, NUL, RAW, NEAR };
typedef struct {
	int kind;
	int64_t num;
	tp_span span;
} item;

static int same(const item *a, const item *b) {
	if (a->kind != b->kind) return 0;
	if (a->kind == NUM) return a->num == b->num;
	return a->span.n == b->span.n && (!a->span.n || !memcmp(a->span.p, b->span.p, a->span.n));
}

static void put(tp_buf *b, const item *x) {
	if (x->kind == NUM) tp_put_int(b, x->num);
	else if (x->kind == TEXT || x->kind == NEAR) {
		if (x->kind == NEAR) tp_put_head(b, 4, 1);
		tp_put_head(b, 3, x->span.n), tp_put(b, x->span.p, x->span.n);
	}
	else if (x->kind == NUL) tp_put(b, "\xf6", 1);
	else tp_put(b, x->span.p, x->span.n);
}

void tp_span_free(const tp_mem *mem, tp_span *s) {
	tp_free(mem, (void *)(uintptr_t)s->p, s->n);
	s->p = NULL, s->n = 0;
}

void tp_steps_free(const tp_mem *mem, tp_steps *s) {
	tp_free(mem, s->bytes, s->size);
	tp_free(mem, s->at, s->room * sizeof *s->at);
	memset(s, 0, sizeof *s);
}

// ---- pack

// the steps, decoded, and every later step's patches, each with its path's index into paths
typedef struct {
	tp_patch p;
	uint32_t path;
} patched;
// prior: the step before the first, which it is packed against (NULL: the first goes whole)
typedef struct {
	const tp_step *steps;
	size_t n, patches;
	const patched *ps;
	const tp_prior *prior;
} packing;

// a column's i-th item (per step in the columns, or per patch) in *x; 0: a patch without one.
// last: the last ranged patch's from
static int get(const packing *k, int column, size_t i, uint64_t *last, item *x) {
	x->kind = NUM;
	if (column <= COUNT) {
		size_t at = k->prior ? i : i + 1;
		const tp_step *s = &k->steps[at];
		uint64_t lamport = at ? k->steps[at - 1].lamport : k->prior->lamport,
			 when = at ? k->steps[at - 1].when : k->prior->when;
		switch (column) {
			case LAMPORT: x->num = (int64_t)s->lamport - (int64_t)lamport; break;
			case WHEN: x->num = (int64_t)s->when - (int64_t)when; break;
			case NODE: x->kind = s->relative ? NEAR : TEXT, x->span = s->node; break;
			case PART: x->kind = TEXT, x->span = s->part; break;
			case WHO: x->kind = s->who.p ? TEXT : NUL, x->span = s->who; break;
			default: x->num = (int64_t)s->count;
		}
		return 1;
	}
	const tp_patch *p = &k->ps[i].p;
	switch (column) {
		case PATH: x->num = k->ps[i].path; return 1;
		case SHAPE: x->num = (p->ranged ? 1 : 0) | (p->value.p ? 2 : 0) | (p->move.p ? 4 : 0); return 1;
		case FROM:
			if (!p->ranged) return 0;
			x->num = (int64_t)p->from - (int64_t)*last;
			*last = p->from;
			return 1;
		case SIZE:
			if (!p->ranged) return 0;
			x->num = (int64_t)p->to - (int64_t)p->from;
			return 1;
		case VALUE: x->kind = RAW, x->span = p->value; return p->value.p != NULL;
		default: x->kind = RAW, x->span = p->move; return p->move.p != NULL;
	}
}

// how many items a column has room for
static size_t length(const packing *k, int column) {
	return column <= COUNT ? k->n - (k->prior ? 0 : 1) : k->patches;
}

// a column as runs: counted, then written
static void runs(tp_buf *b, const packing *k, int column) {
	item x, prev = {0};
	uint64_t last = 0, count = 0, many = 0;
	for (size_t i = 0; i < length(k, column); i++) {
		if (!get(k, column, i, &last, &x)) continue;
		if (!count || !same(&x, &prev)) many++;
		prev = x, count = 1;
	}
	tp_put_head(b, 4, 2 * many);
	last = 0, count = 0;
	for (size_t i = 0; i < length(k, column); i++) {
		if (!get(k, column, i, &last, &x)) continue;
		if (count && !same(&x, &prev)) put(b, &prev), tp_put_head(b, 0, count), count = 0;
		prev = x, count++;
	}
	if (count) put(b, &prev), tp_put_head(b, 0, count);
}

// a column as a plain array of its items
static void items(tp_buf *b, const packing *k, int column, uint64_t n) {
	item x;
	uint64_t last = 0;
	tp_put_head(b, 4, n);
	for (size_t i = 0; i < length(k, column); i++) {
		if (get(k, column, i, &last, &x)) put(b, &x);
	}
}

static uint32_t fnv(tp_span s) {
	uint32_t h = 2166136261u;
	for (size_t i = 0; i < s.n; i++) h = (h ^ s.p[i]) * 16777619u;
	return h;
}

int tp_prior_of(const uint8_t *bytes, size_t length, tp_prior *p) {
	tp_step s;
	if (tp_step_decode(bytes, length, &s)) return TP_NOTSTEP;
	memcpy(p->device, s.device, 32), p->n = s.n, p->lamport = s.lamport, p->when = s.when;
	tp_step_hash(bytes, length, p->hash);
	return 0;
}

int tp_pack(const tp_mem *mem, const tp_span *bytes, size_t n, size_t max, tp_span *pack) {
	return tp_pack_after(mem, NULL, bytes, n, max, pack);
}

int tp_pack_after(const tp_mem *mem, const tp_prior *prior, const tp_span *bytes, size_t n, size_t max,
	tp_span *pack) {
	int why = 0;
	size_t patches = 0, npaths = 0, slots = 16, values = 0, moves = 0;
	tp_step *steps = NULL;
	patched *ps = NULL;
	uint32_t *table = NULL;
	tp_span *paths = NULL;
	tp_buf b = {NULL, 0, 0, max, mem, 0};
	pack->p = NULL, pack->n = 0;
	if (n < 1 || n - 1 >= TP_STEPS) return TP_BOUND;
	if (!(steps = tp_alloc(mem, n * sizeof *steps))) return TP_NOMEM;
	for (size_t i = 0; i < n; i++) {
		if (tp_step_decode(bytes[i].p, bytes[i].n, &steps[i])) {
			why = TP_NOTSTEP;
			goto done;
		}
		if (i || prior) patches += steps[i].count;
	}
	// the first at n = 1 goes whole; else the step before it, or none
	if (steps[0].n == 1) prior = NULL;
	if (prior && (prior->n + 1 != steps[0].n || memcmp(prior->device, steps[0].device, 32))) {
		why = TP_NOTSTEP;
		goto done;
	}
	if (patches > TP_PATCHES) {
		why = TP_BOUND;
		goto done;
	}
	// each patch read once; each distinct path once, in first-seen order: by its bytes (canonical:
	// the same path, the same bytes)
	while (slots < 2 * patches) slots *= 2;
	ps = tp_alloc(mem, (patches ? patches : 1) * sizeof *ps);
	paths = tp_alloc(mem, (patches ? patches : 1) * sizeof *paths);
	table = tp_alloc(mem, slots * sizeof *table);
	if (!ps || !paths || !table) {
		why = TP_NOMEM;
		goto done;
	}
	memset(table, 0xff, slots * sizeof *table);
	size_t id = 0;
	for (size_t i = prior ? 0 : 1; i < n; i++) {
		tp_patch p;
		for (size_t at = 0; !tp_patch_next(steps[i].patches, &at, &p); id++) {
			tp_span path = p.path;
			uint32_t h = fnv(path) & (uint32_t)(slots - 1);
			while (table[h] != 0xffffffffu &&
				(paths[table[h]].n != path.n || memcmp(paths[table[h]].p, path.p, path.n)))
				h = (h + 1) & (uint32_t)(slots - 1);
			if (table[h] == 0xffffffffu) table[h] = (uint32_t)npaths, paths[npaths++] = path;
			ps[id].p = p, ps[id].path = table[h];
			values += p.value.p != NULL, moves += p.move.p != NULL;
		}
	}
	packing k = {steps, n, patches, ps, prior};
	tp_put_head(&b, 4, 8);
	if (prior) tp_put_head(&b, 0, steps[0].n);
	else tp_put_head(&b, 2, bytes[0].n), tp_put(&b, bytes[0].p, bytes[0].n);
	for (int c = LAMPORT; c <= COUNT; c++) runs(&b, &k, c);
	tp_put_head(&b, 5, 7);
	tp_put_text(&b, "from"), runs(&b, &k, FROM);
	tp_put_text(&b, "move"), items(&b, &k, MOVE, moves);
	tp_put_text(&b, "path"), runs(&b, &k, PATH);
	tp_put_text(&b, "size"), runs(&b, &k, SIZE);
	tp_put_text(&b, "paths"), tp_put_head(&b, 4, npaths);
	for (size_t i = 0; i < npaths; i++) tp_put(&b, paths[i].p, paths[i].n);
	tp_put_text(&b, "shape"), runs(&b, &k, SHAPE);
	tp_put_text(&b, "value"), items(&b, &k, VALUE, values);
	why = tp_buf_why(&b);
done:
	tp_free(mem, steps, n * sizeof *steps);
	tp_free(mem, ps, (patches ? patches : 1) * sizeof *ps);
	tp_free(mem, paths, (patches ? patches : 1) * sizeof *paths);
	tp_free(mem, table, slots * sizeof *table);
	if (why) {
		tp_buf_free(&b);
		return why;
	}
	// the bytes, in an allocation just their size
	uint8_t *p = b.len == b.cap ? b.p : tp_grow(mem, b.p, b.cap, b.len);
	if (!p) {
		tp_buf_free(&b);
		return TP_NOMEM;
	}
	pack->p = p, pack->n = b.len;
	return 0;
}

// ---- unpack

// what a column's values are: whole or negative, text, text or null, whole, a shape (0 to 7), an
// index into paths, text or [text] (a node)
enum { K_INT, K_TEXT, K_WHO, K_WHOLE, K_SHAPE, K_INDEX, K_NODE };

// a column of runs, each value of its kind, each count from 1: how many items it makes (no more
// than most); for shape, the patches with a range, a value, a move; for count, their sum (no more
// than TP_PATCHES)
static int column(tp_span c, int kind, uint64_t limit, uint64_t most, uint64_t *total,
	uint64_t sums[3]) {
	tp_in in = {c.p, c.p + c.n};
	uint64_t k;
	*total = 0;
	if (tp_array(&in, &k) || k % 2) return -1;
	for (uint64_t i = 0; i < k; i += 2) {
		int64_t v = 0;
		uint64_t count;
		tp_span s;
		uint64_t one;
		int bad = kind == K_TEXT ? tp_text(&in, &s)
			: kind == K_WHO  ? !tp_null(&in) && tp_text(&in, &s)
			: kind == K_NODE ? (in.p < in.end && *in.p == 0x81 ? tp_array(&in, &one) || tp_text(&in, &s)
									   : tp_text(&in, &s))
					 : tp_int(&in, &v);
		if (bad || tp_whole(&in, &count) || count < 1 || count > most - *total) return -1;
		*total += count;
		if ((kind == K_WHOLE || kind == K_INDEX) && v < 0) return -1;
		if (kind == K_INDEX && (uint64_t)v >= limit) return -1;
		if (kind == K_SHAPE) {
			if (v < 0 || v > 7) return -1;
			if (v & 1) sums[0] += count;
			if (v & 2) sums[1] += count;
			if (v & 4) sums[2] += count;
		}
		if (kind == K_WHOLE) {
			if (v && count > (TP_PATCHES - sums[0]) / (uint64_t)v) return -1;
			sums[0] += (uint64_t)v * count;
		}
	}
	return in.p == in.end ? 0 : -1;
}

// a column's runs read one item at a time: a number, or the item's bytes
typedef struct {
	tp_in in;
	uint64_t left;
	int64_t num;
	tp_span span;
} cursor;

static cursor at(tp_span c) {
	cursor r = {{c.p, c.p + c.n}, 0, 0, {0}};
	uint64_t k;
	tp_array(&r.in, &k);
	return r;
}

static void step(cursor *c, int numbers) {
	if (!c->left) {
		if (numbers) tp_int(&c->in, &c->num);
		else tp_skip(&c->in, &c->span);
		tp_whole(&c->in, &c->left);
	}
	c->left--;
}

// an array's items, one at a time
static tp_span one(tp_in *in) {
	tp_span s = {0};
	tp_skip(in, &s);
	return s;
}

// a sum still a whole number
static int add(uint64_t a, int64_t d, uint64_t *out) {
	if (d < 0 ? (uint64_t)(-d) > a : (uint64_t)d > TP_WHOLE - a) return -1;
	*out = d < 0 ? a - (uint64_t)(-d) : a + (uint64_t)d;
	return 0;
}

int tp_pack_first(tp_span pack, uint64_t *n, int *after) {
	tp_in in = {pack.p, pack.p + pack.n};
	uint64_t k;
	tp_span first;
	tp_step s;
	if (tp_array(&in, &k) || k != 8) return TP_NOTSTEP;
	*after = in.p < in.end && *in.p >> 5 == 0;
	if (*after) return tp_whole(&in, n) || *n < 2 ? TP_NOTSTEP : 0;
	if (tp_bytes(&in, 0, &first) || tp_step_decode(first.p, first.n, &s)) return TP_NOTSTEP;
	*n = s.n;
	return 0;
}

size_t tp_pack_count(tp_span pack) {
	tp_in in = {pack.p, pack.p + pack.n};
	uint64_t k, n, count, all = 0;
	int64_t v;
	if (tp_array(&in, &k) || k != 8 || in.p >= in.end) return 0;
	int after = *in.p >> 5 == 0;
	if (tp_skip(&in, NULL) || tp_array(&in, &k) || k % 2) return 0;
	for (uint64_t i = 0; i < k; i += 2) {
		if (tp_int(&in, &v) || tp_whole(&in, &count)) return 0;
		all += count;
	}
	n = all + !after;
	return (size_t)n;
}

int tp_unpack(const tp_mem *mem, tp_span pack, size_t max, tp_steps *out) {
	return tp_unpack_after(mem, pack, max, NULL, out);
}

int tp_unpack_after(const tp_mem *mem, tp_span pack, size_t max, const tp_prior *prior, tp_steps *out) {
	tp_in in = {pack.p, pack.p + pack.n};
	tp_span first = {0}, col[6], map[7] = {{0}};
	uint64_t n0 = 0;
	static const char *const names[7] = {"paths", "path", "shape", "from", "size", "value", "move"};
	uint64_t k, steps, patches, n, sums[3] = {0}, counted[3] = {0};
	memset(out, 0, sizeof *out);
	if (!tp_canonical(pack.p, pack.n) || tp_array(&in, &k) || k != 8) return TP_NOTSTEP;
	// first: the first step whole, or its n, packed against the step before (at n = 1, never)
	int after = in.p < in.end && *in.p >> 5 == 0;
	if (after ? tp_whole(&in, &n0) || n0 < 2 : tp_bytes(&in, 0, &first)) return TP_NOTSTEP;
	for (int i = 0; i < 6; i++) tp_skip(&in, &col[i]);
	if (tp_map(&in, &k)) return TP_NOTSTEP;
	for (uint64_t i = 0; i < k; i++) {
		tp_span key, v;
		if (tp_text(&in, &key) || tp_skip(&in, &v)) return TP_NOTSTEP;
		for (int j = 0; j < 7; j++) {
			if (tp_is(key, names[j])) map[j] = v;
		}
	}
	for (int j = 0; j < 7; j++) {
		if (!map[j].p) return TP_NOTSTEP;
	}
	// paths, value and move: arrays; how many paths (each a patch's, at most)
	tp_in paths = {map[0].p, map[0].p + map[0].n}, values = {map[5].p, map[5].p + map[5].n},
	      moves = {map[6].p, map[6].p + map[6].n};
	uint64_t npaths, nvalues, nmoves;
	if (tp_array(&paths, &npaths) || npaths > TP_PATCHES || tp_array(&values, &nvalues) ||
		tp_array(&moves, &nmoves))
		return TP_NOTSTEP;
	// the steps after the first, and the patches: every column as long as they say
	static const int kinds[6] = {K_INT, K_INT, K_NODE, K_TEXT, K_WHO, K_WHOLE};
	if (column(col[0], K_INT, 0, TP_STEPS - 1, &steps, sums)) return TP_NOTSTEP;
	for (int i = 1; i < 6; i++) {
		if (column(col[i], kinds[i], 0, steps, &n, sums) || n != steps) return TP_NOTSTEP;
	}
	if (column(map[2], K_SHAPE, 0, TP_PATCHES, &patches, counted)) return TP_NOTSTEP;
	if (sums[0] != patches || column(map[1], K_INDEX, npaths, patches, &n, NULL) || n != patches)
		return TP_NOTSTEP;
	if (column(map[3], K_INT, 0, counted[0], &n, NULL) || n != counted[0]) return TP_NOTSTEP;
	if (column(map[4], K_INT, 0, counted[0], &n, NULL) || n != counted[0]) return TP_NOTSTEP;
	if (nvalues != counted[1] || nmoves != counted[2]) return TP_NOTSTEP;
	if (after && !steps) return TP_NOTSTEP;
	// what each step is worked out from: the first whole, or the step before it
	tp_step prev;
	uint8_t device[32], hash[32];
	uint64_t pn, plamport, pwhen;
	if (after) {
		if (!prior || prior->n + 1 != n0) return TP_BEFORE;
		memcpy(device, prior->device, 32), memcpy(hash, prior->hash, 32);
		pn = prior->n, plamport = prior->lamport, pwhen = prior->when;
	} else {
		if (tp_step_decode(first.p, first.n, &prev)) return TP_NOTSTEP;
		memcpy(device, prev.device, 32), tp_step_hash(first.p, first.n, hash);
		pn = prev.n, plamport = prev.lamport, pwhen = prev.when;
	}

	// each path's bytes, by index
	int why = 0;
	size_t room = (size_t)npaths ? (size_t)npaths : 1;
	tp_span *path = tp_alloc(mem, room * sizeof *path);
	tp_buf b = {NULL, 0, 0, max, mem, 0};
	out->room = (size_t)steps + 2 - (size_t)after;
	out->at = tp_alloc(mem, out->room * sizeof *out->at);
	if (!path || !out->at) {
		why = TP_NOMEM;
		goto done;
	}
	for (uint64_t i = 0; i < npaths; i++) path[i] = one(&paths);
	cursor lamport = at(col[0]), when = at(col[1]), node = at(col[2]), part = at(col[3]),
	       who = at(col[4]), count = at(col[5]), pathed = at(map[1]), shape = at(map[2]),
	       from = at(map[3]), size = at(map[4]);
	// at[j]: where step j starts (the first whole: step 0)
	size_t j = 0;
	out->at[0] = 0;
	if (!after) tp_put(&b, first.p, first.n), out->at[++j] = b.len;
	uint64_t last = 0;
	for (uint64_t i = 0; i < steps && !why; i++) {
		uint64_t l, w;
		step(&lamport, 1), step(&when, 1), step(&node, 0), step(&part, 0), step(&who, 0);
		step(&count, 1);
		if (pn >= TP_WHOLE || add(plamport, lamport.num, &l) || add(pwhen, when.num, &w)) {
			why = TP_NOTSTEP;
			break;
		}
		int named = *who.span.p != 0xf6;
		tp_put_head(&b, 4, named ? 9 : 8);
		tp_put_head(&b, 2, 32), tp_put(&b, device, 32);
		tp_put_head(&b, 0, pn + 1);
		tp_put_head(&b, 2, 32), tp_put(&b, hash, 32);
		tp_put(&b, node.span.p, node.span.n);
		tp_put(&b, part.span.p, part.span.n);
		tp_put_head(&b, 4, (uint64_t)count.num);
		for (int64_t j = 0; j < count.num; j++) {
			step(&shape, 1), step(&pathed, 1);
			int s = (int)shape.num;
			tp_put_head(&b, 5, 1 + (s & 1) + !!(s & 2) + !!(s & 4));
			if (s & 4) {
				tp_span m = one(&moves);
				tp_put_text(&b, "move"), tp_put(&b, m.p, m.n);
			}
			tp_put_text(&b, "path");
			tp_put(&b, path[pathed.num].p, path[pathed.num].n);
			if (s & 1) {
				uint64_t to;
				step(&from, 1), step(&size, 1);
				if (add(last, from.num, &last) || add(last, size.num, &to)) {
					why = TP_NOTSTEP;
					break;
				}
				tp_put_text(&b, "range"), tp_put_head(&b, 4, 2);
				tp_put_head(&b, 0, last), tp_put_head(&b, 0, to);
			}
			if (s & 2) {
				tp_span v = one(&values);
				tp_put_text(&b, "value"), tp_put(&b, v.p, v.n);
			}
		}
		tp_put_head(&b, 0, l), tp_put_head(&b, 0, w);
		if (named) tp_put(&b, who.span.p, who.span.n);
		if (!why && !(why = tp_buf_why(&b))) {
			out->at[j + 1] = b.len;
			// what it makes is a step, or the pack is none
			if (tp_step_decode(b.p + out->at[j], b.len - out->at[j], &prev)) why = TP_NOTSTEP;
			else {
				tp_step_hash(b.p + out->at[j], b.len - out->at[j], hash);
				pn = prev.n, plamport = prev.lamport, pwhen = prev.when, j++;
			}
		}
	}
done:
	tp_free(mem, path, room * sizeof *path);
	if (why) {
		tp_buf_free(&b);
		tp_free(mem, out->at, out->room * sizeof *out->at);
		memset(out, 0, sizeof *out);
		return why;
	}
	out->bytes = b.p, out->size = b.cap, out->count = j;
	return 0;
}
