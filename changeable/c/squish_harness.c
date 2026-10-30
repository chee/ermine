// The C squish library on the line protocol of changeable/typescript/squish_harness.ts.
#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "squish.h"
#include "../../conformance/c/harness.h"

static int lone(const op_value *v) {
	if (v->type == OP_STR) return sq_str(v->str, v->bytes).lone;
	if (v->type != OP_LIST && v->type != OP_MAP) return 0;
	for (size_t i = 0; i < v->count; i++) {
		if (lone(v->items[i])) return 1;
	}
	return 0;
}

static sq_value value_of(const op_value *v) {
	if (v->type == OP_STR) return sq_str(v->str, v->bytes);
	if (v->type == OP_LIST) {
		sq_value l = sq_list((const void *const *)v->items, v->count);
		return l.lone = lone(v), l;
	}
	if (v->type == OP_TYPED) return sq_typed((int)v->kind, op_size(v->kind), v->data, op_length(v));
	sq_value a = sq_any(v);
	return a.lone = lone(v), a;
}


static void put_value(FILE *out, const sq_value *v) {
	op_value *s;
	switch (v->kind) {
	case SQ_STR:
		s = op_str_n(v->data, v->size);
		op_json_write(out, s);
		op_free(s);
		return;
	case SQ_TYPED:
		s = op_typed((op_elements)v->of, v->data, v->n);
		op_json_write(out, s);
		op_free(s);
		return;
	case SQ_ANY:
		op_json_write(out, v->data);
		return;
	case SQ_LIST:
		putc('[', out);
		for (size_t i = 0; i < v->n; i++) {
			if (i) putc(',', out);
			op_json_write(out, ((op_value *const *)v->data)[i]);
		}
		putc(']', out);
		return;
	}
}

static void put_path(FILE *out, const sq_key *k, size_t depth) {
	putc('[', out);
	for (size_t i = 0; i < depth; i++) {
		if (i) putc(',', out);
		if (k[i].s) op_json_string(out, k[i].s);
		else fprintf(out, "%ld", k[i].n);
	}
	putc(']', out);
}

static void put_patches(FILE *out, const sq_patch *ps, size_t n) {
	putc('[', out);
	for (size_t i = 0; i < n; i++) {
		const sq_patch *q = &ps[i];
		if (i) putc(',', out);
		fputs("{\"path\":", out);
		put_path(out, q->path, q->depth);
		if (q->has_range) fprintf(out, ",\"range\":[%lld,%lld]", (long long)q->from, (long long)q->to);
		if (q->has_value) fputs(",\"value\":", out), put_value(out, &q->value);
		if (q->move) fputs(",\"move\":", out), op_json_write(out, q->move);
		putc('}', out);
	}
	putc(']', out);
}

static void put_runs(FILE *out, const char *name, const sq_runs *r) {
	fprintf(out, ",\"%s\":[", name);
	for (size_t i = 0; i < r->n; i++) fprintf(out, i ? ",%lld" : "%lld", (long long)r->v[i]);
	putc(']', out);
}


static int64_t num(const op_value *v) {
	if (!v || v->type != OP_NUM) return 0;
	int64_t exact;
	if (op_as_int64(v, &exact)) return exact;
	return v->num >= 9e18 ? INT64_MAX : v->num <= -9e18 ? INT64_MIN : (int64_t)v->num;
}
static long index_of(const op_value *v) {
	int64_t n = num(v);
	return n > LONG_MAX ? LONG_MAX : n < LONG_MIN ? LONG_MIN : (long)n;
}

static sq_path path_of(const op_value *a) {
	sq_path out = {NULL, 0};
	if (!a || a->type != OP_LIST) return out;
	sq_key *k = hh_take((a->count + 1) * sizeof *k);
	for (size_t i = 0; i < a->count; i++) {
		k[i] = (sq_key){0};
		if (a->items[i]->type == OP_STR) k[i].s = a->items[i]->str;
		else k[i].n = index_of(a->items[i]);
	}
	return (sq_path){k, a->count};
}

static sq_patch *patches_of(const op_value *a, size_t *n) {
	*n = a && a->type == OP_LIST ? a->count : 0;
	sq_patch *ps = hh_take((*n + 1) * sizeof *ps);
	memset(ps, 0, (*n + 1) * sizeof *ps);
	for (size_t i = 0; i < *n; i++) {
		const op_value *o = a->items[i], *range = op_get(o, "range"), *value = op_get(o, "value");
		sq_path path = path_of(op_get(o, "path"));
		ps[i].path = path.keys, ps[i].depth = path.depth;
		if (range && range->type == OP_LIST && range->count == 2) {
			ps[i].has_range = 1, ps[i].from = num(range->items[0]), ps[i].to = num(range->items[1]);
		}
		if (value) ps[i].has_value = 1, ps[i].value = value_of(value);
		ps[i].move = op_get(o, "move");
		if (ps[i].move) {
			sq_path mp = path_of(op_get(ps[i].move, "path"));
			ps[i].move_path = mp.keys, ps[i].move_depth = mp.depth;
			ps[i].move_has_range = op_get(ps[i].move, "range") != NULL;
		}
	}
	return ps;
}

static sq_runs runs_of(const op_value *a) {
	sq_runs r = {NULL, a && a->type == OP_LIST ? a->count : 0};
	r.v = hh_take((r.n + 1) * sizeof *r.v);
	for (size_t i = 0; i < r.n; i++) r.v[i] = num(a->items[i]);
	return r;
}

static sq_columns columns_of(const op_value *o) {
	sq_columns c = {0};
	const op_value *paths = op_get(o, "paths"), *value = op_get(o, "value"), *move = op_get(o, "move");
	c.npaths = paths && paths->type == OP_LIST ? paths->count : 0;
	c.paths = hh_take((c.npaths + 1) * sizeof *c.paths);
	for (size_t i = 0; i < c.npaths; i++) c.paths[i] = path_of(paths->items[i]);
	c.path = runs_of(op_get(o, "path"));
	c.shape = runs_of(op_get(o, "shape"));
	c.from = runs_of(op_get(o, "from"));
	c.size = runs_of(op_get(o, "size"));
	c.nvalue = value && value->type == OP_LIST ? value->count : 0;
	c.value = hh_take((c.nvalue + 1) * sizeof *c.value);
	for (size_t i = 0; i < c.nvalue; i++) c.value[i] = value_of(value->items[i]);
	c.nmove = move && move->type == OP_LIST ? move->count : 0;
	c.move = hh_take((c.nmove + 1) * sizeof *c.move);
	for (size_t i = 0; i < c.nmove; i++) c.move[i] = move->items[i];
	return c;
}

static int is_list(const op_value *v) { return v && v->type == OP_LIST; }
static int columns_ok(const op_value *c) {
	static const char *fields[] = {"paths", "path", "shape", "from", "size", "value", "move"};
	if (!c || c->type != OP_MAP) return 0;
	for (size_t i = 0; i < sizeof fields / sizeof *fields; i++)
		if (!is_list(op_get(c, fields[i]))) return 0;
	return 1;
}

void hh_answer(const op_value *r, FILE *out) {
	const char *o = hh_str(r, "op");
	size_t n;
	if (o && (!strcmp(o, "squish") || !strcmp(o, "encode")) && !is_list(op_get(r, "patches"))) {
		hh_error(out, "patches: not a list");
	} else if (o && !strcmp(o, "decode") && !columns_ok(op_get(r, "columns"))) {
		hh_error(out, "columns: not a map of lists");
	} else if (o && !strcmp(o, "squish")) {
		sq_patch *ps = patches_of(op_get(r, "patches"), &n);
		sq *s = sq_new();
		for (size_t i = 0; i < n; i++) sq_push(s, &ps[i]);
		const sq_patch *squished = sq_patches(s, &n);
		fputs("{\"patches\":", out);
		put_patches(out, squished, n);
		putc('}', out);
		sq_free(s);
	} else if (o && !strcmp(o, "encode")) {
		sq_patch *ps = patches_of(op_get(r, "patches"), &n);
		sq_columns c = sq_encode(ps, n);
		fputs("{\"columns\":{\"paths\":[", out);
		for (size_t i = 0; i < c.npaths; i++) {
			if (i) putc(',', out);
			put_path(out, c.paths[i].keys, c.paths[i].depth);
		}
		putc(']', out);
		put_runs(out, "path", &c.path);
		put_runs(out, "shape", &c.shape);
		put_runs(out, "from", &c.from);
		put_runs(out, "size", &c.size);
		fputs(",\"value\":[", out);
		for (size_t i = 0; i < c.nvalue; i++) {
			if (i) putc(',', out);
			put_value(out, &c.value[i]);
		}
		fputs("],\"move\":[", out);
		for (size_t i = 0; i < c.nmove; i++) {
			if (i) putc(',', out);
			op_json_write(out, c.move[i]);
		}
		fputs("]}}", out);
		sq_columns_free(&c);
	} else if (o && !strcmp(o, "decode")) {
		sq_columns c = columns_of(op_get(r, "columns"));
		sq_patch *ps = sq_decode(&c, &n);
		if (!ps && n) {
			hh_error(out, "bad columns");
		} else {
			fputs("{\"patches\":", out);
			put_patches(out, ps, n);
			putc('}', out);
		}
		free(ps);
	} else {
		hh_unknown(out, r);
	}
}
