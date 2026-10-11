// The C squish library on the line protocol: one JSON request per line in, one answer per line
// out, in order. Same as ../conformance/harness.ts. List elements, moves and other values are
// kept as parsed JSON, which squish never reads; {"$bytes": [...]} is bytes.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "squish.h"

// a parsed JSON value. scalar: its text as written; string: decoded, UTF-8
typedef struct node node;
struct node {
	char type; // 'v' scalar, 's' string, 'a' array, 'o' object
	char *text;
	size_t len;
	node **kids;
	char **keys;
	size_t n;
};

// everything one request made, freed after its answer
static void **pool;
static size_t npool, cappool;
static void *keep(void *p) {
	if (!p) abort();
	if (npool == cappool) {
		cappool = cappool ? cappool * 2 : 64;
		pool = realloc(pool, cappool * sizeof *pool);
		if (!pool) abort();
	}
	return pool[npool++] = p;
}
static void *alloc(size_t n) { return keep(calloc(1, n ? n : 1)); }
static void release(void) {
	while (npool) free(pool[--npool]);
}

static const char *p; // the scanner's place in the line

static void ws(void) {
	while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
}

static int put8(char *o, unsigned long c) {
	if (c < 0x80) { o[0] = (char)c; return 1; }
	if (c < 0x800) { o[0] = (char)(0xC0 | c >> 6); o[1] = (char)(0x80 | (c & 63)); return 2; }
	if (c < 0x10000) {
		o[0] = (char)(0xE0 | c >> 12); o[1] = (char)(0x80 | ((c >> 6) & 63)); o[2] = (char)(0x80 | (c & 63));
		return 3;
	}
	o[0] = (char)(0xF0 | c >> 18); o[1] = (char)(0x80 | ((c >> 12) & 63));
	o[2] = (char)(0x80 | ((c >> 6) & 63)); o[3] = (char)(0x80 | (c & 63));
	return 4;
}

static unsigned long hex4(const char *s) {
	char b[5] = {s[0], s[1], s[2], s[3], 0};
	return strtoul(b, NULL, 16);
}

// at the opening quote: p after the closing one
static char *str(size_t *len) {
	const char *s = ++p;
	while (*p && *p != '"') p += *p == '\\' && p[1] ? 2 : 1;
	char *out = alloc((size_t)(p - s) + 1), *o = out;
	while (s < p) {
		if (*s != '\\') { *o++ = *s++; continue; }
		s++;
		switch (*s) {
		case 'n': *o++ = '\n'; s++; break;
		case 't': *o++ = '\t'; s++; break;
		case 'r': *o++ = '\r'; s++; break;
		case 'b': *o++ = '\b'; s++; break;
		case 'f': *o++ = '\f'; s++; break;
		case 'u': {
			unsigned long c = hex4(s + 1);
			s += 5;
			if (c >= 0xD800 && c < 0xDC00 && s[0] == '\\' && s[1] == 'u') {
				unsigned long d = hex4(s + 2);
				c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
				s += 6;
			}
			o += put8(o, c);
			break;
		}
		default: *o++ = *s++; // " \ /
		}
	}
	*o = 0;
	if (*p == '"') p++;
	*len = (size_t)(o - out);
	return out;
}

static node *parse(void) {
	ws();
	node *v = alloc(sizeof *v);
	if (*p == '"') {
		v->type = 's';
		v->text = str(&v->len);
		return v;
	}
	if (*p == '[' || *p == '{') {
		v->type = *p == '[' ? 'a' : 'o';
		char close = *p++ == '[' ? ']' : '}';
		size_t cap = 0;
		for (ws(); *p && *p != close; ws()) {
			if (v->n == cap) {
				cap = cap ? cap * 2 : 4;
				node **k = alloc(cap * sizeof *k);
				char **ks = alloc(cap * sizeof *ks);
				if (v->n) memcpy(k, v->kids, v->n * sizeof *k), memcpy(ks, v->keys, v->n * sizeof *ks);
				v->kids = k, v->keys = ks;
			}
			if (v->type == 'o') {
				size_t l;
				v->keys[v->n] = str(&l);
				ws();
				if (*p == ':') p++;
			}
			v->kids[v->n++] = parse();
			ws();
			if (*p == ',') p++;
		}
		if (*p) p++;
		return v;
	}
	const char *s = p;
	while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\r' && *p != '\n') p++;
	v->type = 'v';
	v->len = (size_t)(p - s);
	v->text = alloc(v->len + 1);
	memcpy(v->text, s, v->len);
	return v;
}

static node *get(const node *o, const char *k) {
	if (!o || o->type != 'o') return NULL;
	for (size_t i = 0; i < o->n; i++)
		if (!strcmp(o->keys[i], k)) return o->kids[i];
	return NULL;
}
static long num(const node *v) { return v && v->type == 'v' ? strtol(v->text, NULL, 10) : 0; }

// out

static void out_str(const char *s, size_t n) {
	putchar('"');
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		if (c == '"' || c == '\\') printf("\\%c", c);
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}

static void out_node(const node *v) {
	if (v->type == 's') { out_str(v->text, v->len); return; }
	if (v->type == 'v') { fwrite(v->text, 1, v->len, stdout); return; }
	putchar(v->type == 'a' ? '[' : '{');
	for (size_t i = 0; i < v->n; i++) {
		if (i) putchar(',');
		if (v->type == 'o') out_str(v->keys[i], strlen(v->keys[i])), putchar(':');
		out_node(v->kids[i]);
	}
	putchar(v->type == 'a' ? ']' : '}');
}

static void out_value(const sq_value *v) {
	switch (v->kind) {
	case SQ_STR: out_str(v->data, v->size); return;
	case SQ_ANY: out_node(v->data); return;
	case SQ_LIST:
		putchar('[');
		for (size_t i = 0; i < v->n; i++) {
			if (i) putchar(',');
			out_node(((node *const *)v->data)[i]);
		}
		putchar(']');
		return;
	case SQ_BYTES:
		fputs("{\"$bytes\":[", stdout);
		for (size_t i = 0; i < v->n; i++) printf(i ? ",%u" : "%u", ((const uint8_t *)v->data)[i]);
		fputs("]}", stdout);
		return;
	}
}

static void out_path(const sq_key *k, size_t depth) {
	putchar('[');
	for (size_t i = 0; i < depth; i++) {
		if (i) putchar(',');
		if (k[i].s) out_str(k[i].s, strlen(k[i].s));
		else printf("%ld", k[i].n);
	}
	putchar(']');
}

static void out_patches(const sq_patch *ps, size_t n) {
	putchar('[');
	for (size_t i = 0; i < n; i++) {
		const sq_patch *q = &ps[i];
		if (i) putchar(',');
		fputs("{\"path\":", stdout);
		out_path(q->path, q->depth);
		if (q->has_range) printf(",\"range\":[%ld,%ld]", q->from, q->to);
		if (q->has_value) fputs(",\"value\":", stdout), out_value(&q->value);
		if (q->move) fputs(",\"move\":", stdout), out_node(q->move);
		putchar('}');
	}
	putchar(']');
}

static void out_runs(const char *name, const sq_runs *r) {
	printf(",\"%s\":[", name);
	for (size_t i = 0; i < r->n; i++) printf(i ? ",%ld" : "%ld", r->v[i]);
	putchar(']');
}

// in

static sq_path path_of(const node *a) {
	sq_path out = {NULL, 0};
	if (!a || a->type != 'a') return out;
	sq_key *k = alloc(a->n * sizeof *k);
	for (size_t i = 0; i < a->n; i++) {
		if (a->kids[i]->type == 's') k[i].s = a->kids[i]->text;
		else k[i].n = num(a->kids[i]);
	}
	return (sq_path){k, a->n};
}

static sq_value value_of(const node *v) {
	if (v->type == 's') return sq_str(v->text, v->len);
	if (v->type == 'a') return sq_list((const void *const *)v->kids, v->n);
	const node *b = v->n == 1 ? get(v, "$bytes") : NULL;
	if (b && b->type == 'a') {
		uint8_t *bytes = alloc(b->n);
		for (size_t i = 0; i < b->n; i++) bytes[i] = (uint8_t)num(b->kids[i]);
		return sq_bytes(bytes, b->n);
	}
	return sq_any(v);
}

static sq_patch *patches_of(const node *a, size_t *n) {
	*n = a && a->type == 'a' ? a->n : 0;
	sq_patch *ps = alloc(*n * sizeof *ps);
	for (size_t i = 0; i < *n; i++) {
		const node *o = a->kids[i], *range = get(o, "range"), *value = get(o, "value");
		sq_path path = path_of(get(o, "path"));
		ps[i].path = path.keys, ps[i].depth = path.depth;
		if (range && range->type == 'a' && range->n == 2) {
			ps[i].has_range = 1, ps[i].from = num(range->kids[0]), ps[i].to = num(range->kids[1]);
		}
		if (value) ps[i].has_value = 1, ps[i].value = value_of(value);
		ps[i].move = get(o, "move");
	}
	return ps;
}

static sq_runs runs_of(const node *a) {
	sq_runs r = {NULL, a && a->type == 'a' ? a->n : 0};
	r.v = alloc(r.n * sizeof *r.v);
	for (size_t i = 0; i < r.n; i++) r.v[i] = num(a->kids[i]);
	return r;
}

static sq_columns columns_of(const node *o) {
	sq_columns c = {0};
	const node *paths = get(o, "paths"), *value = get(o, "value"), *move = get(o, "move");
	c.npaths = paths && paths->type == 'a' ? paths->n : 0;
	c.paths = alloc(c.npaths * sizeof *c.paths);
	for (size_t i = 0; i < c.npaths; i++) c.paths[i] = path_of(paths->kids[i]);
	c.path = runs_of(get(o, "path"));
	c.shape = runs_of(get(o, "shape"));
	c.from = runs_of(get(o, "from"));
	c.size = runs_of(get(o, "size"));
	c.nvalue = value && value->type == 'a' ? value->n : 0;
	c.value = alloc(c.nvalue * sizeof *c.value);
	for (size_t i = 0; i < c.nvalue; i++) c.value[i] = value_of(value->kids[i]);
	c.nmove = move && move->type == 'a' ? move->n : 0;
	c.move = alloc(c.nmove * sizeof *c.move);
	for (size_t i = 0; i < c.nmove; i++) c.move[i] = move->kids[i];
	return c;
}

static void answer(void) {
	node *r = parse();
	const node *op = get(r, "op");
	const char *o = op && op->type == 's' ? op->text : "";
	size_t n;
	if (!strcmp(o, "squish")) {
		sq_patch *ps = patches_of(get(r, "patches"), &n);
		sq *s = sq_new();
		for (size_t i = 0; i < n; i++) sq_push(s, &ps[i]);
		const sq_patch *out = sq_patches(s, &n);
		fputs("{\"patches\":", stdout);
		out_patches(out, n);
		puts("}");
		sq_free(s);
	} else if (!strcmp(o, "encode")) {
		sq_patch *ps = patches_of(get(r, "patches"), &n);
		sq_columns c = sq_encode(ps, n);
		fputs("{\"columns\":{\"paths\":[", stdout);
		for (size_t i = 0; i < c.npaths; i++) {
			if (i) putchar(',');
			out_path(c.paths[i].keys, c.paths[i].depth);
		}
		putchar(']');
		out_runs("path", &c.path);
		out_runs("shape", &c.shape);
		out_runs("from", &c.from);
		out_runs("size", &c.size);
		fputs(",\"value\":[", stdout);
		for (size_t i = 0; i < c.nvalue; i++) {
			if (i) putchar(',');
			out_value(&c.value[i]);
		}
		fputs("],\"move\":[", stdout);
		for (size_t i = 0; i < c.nmove; i++) {
			if (i) putchar(',');
			out_node(c.move[i]);
		}
		puts("]}}");
		sq_columns_free(&c);
	} else if (!strcmp(o, "decode")) {
		sq_columns c = columns_of(get(r, "columns"));
		sq_patch *ps = sq_decode(&c, &n);
		if (!ps && n) {
			puts("{\"error\":\"bad columns\"}");
		} else {
			fputs("{\"patches\":", stdout);
			out_patches(ps, n);
			puts("}");
		}
		free(ps);
	} else {
		fputs("{\"error\":", stdout);
		out_str("unknown op ", 11);
		puts("}");
	}
}

int main(void) {
	char *line = NULL;
	size_t cap = 0;
	while (getline(&line, &cap, stdin) > 0) {
		p = line;
		ws();
		if (!*p) continue;
		answer();
		release();
		fflush(stdout);
	}
	free(line);
	free(pool);
	return 0;
}
