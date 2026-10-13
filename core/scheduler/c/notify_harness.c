// The C notify on the line protocol (newcore/conformance/notify/harness.ts): one JSON request per
// line in, one answer per line out. Parses and prints the JSON itself.
#include "notify.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail(const char *why) {
	fprintf(stderr, "harness: %s\n", why);
	exit(1);
}
static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) fail("out of memory");
	return p;
}

// json in

typedef struct {
	const char *p;
	const char *why;
} parser;

static void skip(parser *s) {
	while (*s->p == ' ' || *s->p == '\t' || *s->p == '\r' || *s->p == '\n') s->p++;
}
static int hex4(parser *s, unsigned *out) {
	unsigned x = 0;
	for (int i = 0; i < 4; i++) {
		char c = s->p[i];
		x <<= 4;
		if (c >= '0' && c <= '9') x |= (unsigned)(c - '0');
		else if (c >= 'a' && c <= 'f') x |= (unsigned)(c - 'a' + 10);
		else if (c >= 'A' && c <= 'F') x |= (unsigned)(c - 'A' + 10);
		else return 0;
	}
	s->p += 4;
	*out = x;
	return 1;
}
static size_t utf8(char *out, unsigned c) {
	if (c < 0x80) return out[0] = (char)c, 1;
	if (c < 0x800) return out[0] = (char)(0xC0 | c >> 6), out[1] = (char)(0x80 | (c & 63)), 2;
	if (c < 0x10000) {
		out[0] = (char)(0xE0 | c >> 12);
		out[1] = (char)(0x80 | ((c >> 6) & 63));
		out[2] = (char)(0x80 | (c & 63));
		return 3;
	}
	out[0] = (char)(0xF0 | c >> 18);
	out[1] = (char)(0x80 | ((c >> 12) & 63));
	out[2] = (char)(0x80 | ((c >> 6) & 63));
	out[3] = (char)(0x80 | (c & 63));
	return 4;
}
// a string literal, p after the opening quote; malloc'd, or NULL
static char *literal(parser *s) {
	size_t cap = strlen(s->p) + 1, n = 0;
	char *out = grab(cap);
	while (*s->p != '"') {
		unsigned char c = (unsigned char)*s->p;
		if (c == 0 || c < 0x20) goto bad;
		s->p++;
		if (c != '\\') {
			out[n++] = (char)c;
			continue;
		}
		char e = *s->p++;
		switch (e) {
		case '"': case '\\': case '/': out[n++] = e; break;
		case 'b': out[n++] = '\b'; break;
		case 'f': out[n++] = '\f'; break;
		case 'n': out[n++] = '\n'; break;
		case 'r': out[n++] = '\r'; break;
		case 't': out[n++] = '\t'; break;
		case 'u': {
			unsigned u, lo;
			if (!hex4(s, &u)) goto bad;
			if (u >= 0xD800 && u < 0xDC00 && s->p[0] == '\\' && s->p[1] == 'u') {
				s->p += 2;
				if (!hex4(s, &lo)) goto bad;
				u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
			}
			n += utf8(out + n, u);
			break;
		}
		default: goto bad;
		}
	}
	s->p++;
	out[n] = 0;
	return out;
bad:
	free(out);
	s->why = "bad string";
	return NULL;
}
static op_value *beyond(op_value *m);
static op_value *value(parser *s) {
	skip(s);
	char c = *s->p;
	if (c == '"') {
		s->p++;
		char *t = literal(s);
		if (t == NULL) return NULL;
		op_value *v = op_str(t);
		free(t);
		return v;
	}
	if (c == '[' || c == '{') {
		int map = c == '{';
		op_value *v = map ? op_map() : op_list();
		s->p++;
		skip(s);
		if (*s->p == (map ? '}' : ']')) return s->p++, v;
		for (;;) {
			char *key = NULL;
			if (map) {
				skip(s);
				if (*s->p++ != '"' || (key = literal(s)) == NULL) goto bad;
				skip(s);
				if (*s->p++ != ':') goto bad_key;
			}
			op_value *item = value(s);
			if (item == NULL) goto bad_key;
			if (map) op_set(v, key, item);
			else op_push(v, item);
			free(key);
			skip(s);
			if (*s->p == ',') {
				s->p++;
				continue;
			}
			if (*s->p++ == (map ? '}' : ']')) return map ? beyond(v) : v;
			goto bad;
		bad_key:
			free(key);
		bad:
			op_free(v);
			if (s->why == NULL) s->why = "bad json";
			return NULL;
		}
	}
	if (strncmp(s->p, "null", 4) == 0) return s->p += 4, op_null();
	if (strncmp(s->p, "true", 4) == 0) return s->p += 4, op_bool(1);
	if (strncmp(s->p, "false", 5) == 0) return s->p += 5, op_bool(0);
	char *end;
	double d = strtod(s->p, &end);
	if (end == s->p || c == 'n' || c == 'i' || c == 'I' || c == 'N' || c == '+') {
		s->why = "bad json";
		return NULL;
	}
	s->p = end;
	return op_num(d);
}

// json out

static void string(const char *s) {
	putchar('"');
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '"' || c == '\\') printf("\\%c", c);
		else if (c == '\n') fputs("\\n", stdout);
		else if (c == '\r') fputs("\\r", stdout);
		else if (c == '\t') fputs("\\t", stdout);
		else if (c == '\b') fputs("\\b", stdout);
		else if (c == '\f') fputs("\\f", stdout);
		else if (c < 0x20) printf("\\u%04x", c);
		else putchar(c);
	}
	putchar('"');
}
static void number(double d) {
	if (d == 0) { putchar('0'); return; }
	if (d == floor(d) && fabs(d) < 1e21) { printf("%.0f", d); return; }
	char buf[40];
	for (int p = 1; p <= 17; p++) {
		snprintf(buf, sizeof buf, "%.*g", p, d);
		if (strtod(buf, NULL) == d) break;
	}
	fputs(buf, stdout);
}
// values beyond JSON (encoding/ENCODING.tex, in JSON): bytes {"/":{"bytes":b64}}, unpadded; a
// typed array {"/":{kind:[...]}}, 64-bit elements as decimal strings, a float's NaN and
// infinities as words; a stand-in {"/":{"live":kind}}

static const char *kinds[] = {"int8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
	"float32", "float64"};
static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// one element, little-endian, from a JSON number or string (as a typed array takes a number:
// truncated, then wrapped); 0 when it is neither
static void put(unsigned char *at, op_elements kind, const op_value *x) {
	double d = 0;
	uint64_t u = 0;
	int big = kind == OP_INT64 || kind == OP_UINT64;
	if (x->type == OP_STR) {
		if (strcmp(x->str, "NaN") == 0) d = NAN;
		else if (strcmp(x->str, "Infinity") == 0) d = INFINITY;
		else if (strcmp(x->str, "-Infinity") == 0) d = -INFINITY;
		else if (big) u = x->str[0] == '-' ? (uint64_t)strtoll(x->str, NULL, 10) : strtoull(x->str, NULL, 10);
		else d = strtod(x->str, NULL);
	} else if (x->type == OP_NUM) d = x->num;
	if (kind == OP_FLOAT32) {
		float f = (float)d;
		uint32_t b;
		memcpy(&b, &f, 4);
		u = b;
	} else if (kind == OP_FLOAT64) memcpy(&u, &d, 8);
	else if (!(big && x->type == OP_STR)) {
		d = isfinite(d) ? trunc(d) : 0;
		if (!big) {
			double r = fmod(d, 4294967296.0);
			u = (uint64_t)(r < 0 ? r + 4294967296.0 : r);
		} else if (d < 0) u = d > -9.2e18 ? (uint64_t)(int64_t)d : 0;
		else u = d < 1.8e19 ? (uint64_t)d : 0;
	}
	for (size_t i = 0; i < op_size(kind); i++) at[i] = (unsigned char)(u >> (8 * i));
}
static uint64_t raw(const op_value *t, size_t i) {
	size_t z = op_size(t->kind);
	uint64_t u = 0;
	for (size_t j = 0; j < z; j++) u |= (uint64_t)t->data[i * z + j] << (8 * j);
	return u;
}
// an element as a number (64-bit integers: raw)
static double element(const op_value *t, size_t i) {
	uint64_t u = raw(t, i);
	switch (t->kind) {
	case OP_INT8: return (int8_t)u;
	case OP_INT16: return (int16_t)u;
	case OP_UINT16: return (uint16_t)u;
	case OP_INT32: return (int32_t)u;
	case OP_UINT32: return (uint32_t)u;
	case OP_FLOAT32: {
		uint32_t b = (uint32_t)u;
		float f;
		memcpy(&f, &b, 4);
		return f;
	}
	case OP_FLOAT64: {
		double d;
		memcpy(&d, &u, 8);
		return d;
	}
	default: return (double)u;
	}
}
static op_value *typed_of(op_elements kind, const op_value *list) {
	unsigned char *buf = grab(list->count * 8);
	for (size_t i = 0; i < list->count; i++) put(buf + i * op_size(kind), kind, list->items[i]);
	op_value *t = op_typed(kind, buf, list->count);
	free(buf);
	return t;
}
// a map in ENCODING.tex's JSON form: the value it stands for, m let go of; else m
static op_value *beyond(op_value *m) {
	const op_value *in = m->count == 1 && strcmp(m->keys[0], "/") == 0 ? m->items[0] : NULL;
	if (in == NULL || in->type != OP_MAP || in->count != 1) return m;
	const op_value *x = in->items[0];
	op_value *v = NULL;
	if (strcmp(in->keys[0], "live") == 0) {
		// the kind is kept, m's other holds let go of
		op_ref((op_value *)x);
		v = op_stand((op_value *)x);
		op_free(m);
		return v;
	}
	if (strcmp(in->keys[0], "bytes") == 0 && x->type == OP_STR) {
		unsigned char *buf = grab(x->bytes);
		size_t n = 0, bits = 0;
		uint32_t acc = 0;
		for (const char *c = x->str; *c && *c != '='; c++) {
			const char *d = strchr(b64, *c);
			if (d == NULL) {
				free(buf);
				return m;
			}
			acc = acc << 6 | (uint32_t)(d - b64), bits += 6;
			if (bits >= 8) bits -= 8, buf[n++] = (unsigned char)(acc >> bits);
		}
		v = op_bytes(buf, n);
		free(buf);
	}
	for (size_t k = 0; v == NULL && k < sizeof kinds / sizeof *kinds; k++)
		if (strcmp(in->keys[0], kinds[k]) == 0 && x->type == OP_LIST) v = typed_of((op_elements)k, x);
	if (v == NULL) return m;
	op_free(m);
	return v;
}
static void print_bytes(const op_value *v) {
	fputs("{\"/\":{\"bytes\":\"", stdout);
	for (size_t i = 0; i < v->bytes; i += 3) {
		uint32_t acc = (uint32_t)v->data[i] << 16;
		if (i + 1 < v->bytes) acc |= (uint32_t)v->data[i + 1] << 8;
		if (i + 2 < v->bytes) acc |= v->data[i + 2];
		size_t n = v->bytes - i < 3 ? v->bytes - i + 1 : 4;
		for (size_t j = 0; j < n; j++) putchar(b64[(acc >> (18 - 6 * j)) & 63]);
	}
	fputs("\"}}", stdout);
}
static void print_elements(const op_value *v) {
	putchar('[');
	for (size_t i = 0; i < op_length(v); i++) {
		if (i) putchar(',');
		double d = element(v, i);
		if (v->kind == OP_INT64) printf("\"%lld\"", (long long)(int64_t)raw(v, i));
		else if (v->kind == OP_UINT64) printf("\"%llu\"", (unsigned long long)raw(v, i));
		else if (isnan(d)) fputs("\"NaN\"", stdout);
		else if (isinf(d)) fputs(d > 0 ? "\"Infinity\"" : "\"-Infinity\"", stdout);
		else number(d);
	}
	putchar(']');
}
static void print_typed(const op_value *v) {
	printf("{\"/\":{\"%s\":", kinds[v->kind]);
	print_elements(v);
	fputs("}}", stdout);
}
static void print(const op_value *v) {
	switch (v->type) {
	case OP_NULL: fputs("null", stdout); break;
	case OP_BOOL: fputs(v->bool_ ? "true" : "false", stdout); break;
	case OP_NUM: number(v->num); break;
	case OP_STR: string(v->str); break;
	case OP_LIST:
		putchar('[');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			print(v->items[i]);
		}
		putchar(']');
		break;
	case OP_MAP:
		putchar('{');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			string(v->keys[i]);
			putchar(':');
			print(v->items[i]);
		}
		putchar('}');
		break;
	case OP_STAND:
		fputs("{\"/\":{\"live\":", stdout);
		print(v->items[0]);
		fputs("}}", stdout);
		break;
	case OP_BYTES: print_bytes(v); break;
	case OP_TYPED: print_typed(v); break;
	}
}
static void error(const char *why) {
	fputs("{\"error\":", stdout);
	string(why);
	puts("}");
}

// the protocol

static const char *names[] = {"value", "keys", "length", "moved", "gone"};

typedef struct {
	char *name;
	nt_read *r;
	nt_kind heard[5];
	int nheard;
	int live;
} entry;

static const op_value *content;
static nt_notify *notify;
static entry **entries;
static size_t count, capacity;

static const op_value *get(void *ctx) {
	(void)ctx;
	return content;
}
static void listen(nt_kind kind, void *user) {
	entry *e = user;
	for (int i = 0; i < e->nheard; i++)
		if (e->heard[i] == kind) goto known;
	e->heard[e->nheard++] = kind;
known:
	if (kind == NT_GONE) e->live = 0;
}
// the latest read of this name
static entry *find(const char *name) {
	for (size_t i = count; i-- > 0;)
		if (strcmp(entries[i]->name, name) == 0) return entries[i];
	return NULL;
}
static void restart(op_value *v) {
	if (notify) nt_destroy(notify);
	for (size_t i = 0; i < count; i++) {
		free(entries[i]->name);
		free(entries[i]);
	}
	count = 0;
	op_free((op_value *)content);
	content = v;
	notify = nt_create(get, NULL);
}

// a JSON path to keys; strings are borrowed from it. NULL on a bad one
static op_key *keys_of(const op_value *list, size_t *length) {
	if (list == NULL || list->type != OP_LIST) return NULL;
	op_key *ks = grab((list->count + 1) * sizeof *ks);
	for (size_t i = 0; i < list->count; i++) {
		const op_value *x = list->items[i];
		if (x->type == OP_NUM) ks[i] = (op_key){.type = OP_NUM_KEY, .n = (long)x->num};
		else if (x->type == OP_STR) ks[i] = (op_key){.type = OP_STR_KEY, .s = x->str};
		else if (x->type == OP_LIST && x->count == 2 && x->items[0]->type == OP_NUM &&
				x->items[1]->type == OP_NUM && i + 1 == list->count) {
			ks[i] = (op_key){.type = OP_SPAN, .a = (long)x->items[0]->num, .b = (long)x->items[1]->num};
		} else {
			free(ks);
			return NULL;
		}
	}
	*length = list->count;
	return ks;
}
// a place: path and maybe range; path to be freed by the caller
static int place_of(const op_value *m, op_target *p) {
	memset(p, 0, sizeof *p);
	if (m == NULL || m->type != OP_MAP) return 0;
	p->path = keys_of(op_get(m, "path"), &p->length);
	if (p->path == NULL) return 0;
	const op_value *r = op_get(m, "range");
	if (r != NULL) {
		if (r->type != OP_LIST || r->count != 2 || r->items[0]->type != OP_NUM || r->items[1]->type != OP_NUM) return 0;
		p->has_range = 1;
		p->from = (long)r->items[0]->num;
		p->to = (long)r->items[1]->num;
	}
	return 1;
}

static void answer(op_value *q) {
	const op_value *op = op_get(q, "op");
	const op_value *nm = op_get(q, "name");
	const char *name = nm && nm->type == OP_STR ? nm->str : "undefined";
	if (q->type != OP_MAP || op == NULL || op->type != OP_STR) { error("unknown op undefined"); return; }
	if (strcmp(op->str, "start") == 0) {
		op_value *v = op_get(q, "value");
		// the content is kept: taken out of the request
		for (size_t i = 0; v && i < q->count; i++)
			if (q->items[i] == v) q->items[i] = NULL;
		restart(v);
		puts("{}");
	} else if (strcmp(op->str, "read") == 0) {
		size_t n;
		op_key *path = keys_of(op_get(q, "path"), &n);
		if (path == NULL) { error("bad path"); return; }
		nt_options o = {0};
		const op_value *x;
		o.deep = (x = op_get(q, "deep")) && x->type == OP_BOOL && x->bool_;
		o.chase = (x = op_get(q, "chase")) && x->type == OP_BOOL && x->bool_;
		if ((x = op_get(q, "edges")) && x->type == OP_LIST && x->count == 2)
			for (int i = 0; i < 2; i++)
				o.edges[i] = x->items[i]->type == OP_STR && strcmp(x->items[i]->str, "in") == 0 ? NT_IN : NT_OUT;
		o.empty = (x = op_get(q, "empty")) && x->type == OP_STR && strcmp(x->str, "gone") == 0 ? NT_DROP : NT_KEEP;
		entry *e = grab(sizeof *e);
		*e = (entry){.live = 1};
		e->name = grab(strlen(name) + 1);
		strcpy(e->name, name);
		e->r = nt_open(notify, path, n, &o);
		free(path);
		nt_on(e->r, listen, e);
		if (count == capacity) {
			capacity = capacity ? capacity * 2 : 16;
			entries = realloc(entries, capacity * sizeof *entries);
			if (entries == NULL) fail("out of memory");
		}
		entries[count++] = e;
		puts("{}");
	} else if (strcmp(op->str, "patch") == 0) {
		op_patch p = {0};
		const op_value *pm = op_get(q, "patch");
		if (!place_of(pm, &p.place)) { error("bad patch"); return; }
		p.value = op_get(pm, "value");
		p.has_value = p.value != NULL;
		const op_value *mv = op_get(pm, "move");
		if (mv != NULL) {
			p.has_move = 1;
			if (!place_of(mv, &p.move)) { error("bad patch"); return; }
		}
		const op_value *before = content;
		op_value *after = op_get(q, "value");
		for (size_t i = 0; after && i < q->count; i++)
			if (q->items[i] == after) q->items[i] = NULL;
		content = after;
		nt_patched(notify, &p, before);
		free((void *)p.place.path);
		free((void *)p.move.path);
		op_free((op_value *)before);
		fputs("{\"heard\":{", stdout);
		int first = 1;
		for (size_t i = 0; i < count; i++) {
			entry *e = entries[i];
			if (e->nheard == 0 || find(e->name) != e) continue;
			if (!first) putchar(',');
			first = 0;
			string(e->name);
			fputs(":[", stdout);
			for (int j = 0; j < e->nheard; j++) {
				if (j) putchar(',');
				string(names[e->heard[j]]);
			}
			putchar(']');
		}
		puts("}}");
		for (size_t i = 0; i < count; i++) entries[i]->nheard = 0;
	} else if (strcmp(op->str, "where") == 0 || strcmp(op->str, "stop") == 0) {
		entry *e = find(name);
		if (e == NULL) {
			char why[256];
			snprintf(why, sizeof why, "no read %s", name);
			{ error(why); return; }
		}
		if (op->str[0] == 's') {
			nt_stop(e->r);
			e->live = 0;
			puts("{}");
			return;
		}
		size_t n;
		long a, b;
		const op_key *ks = nt_keys(e->r, &n);
		fputs("{\"path\":[", stdout);
		for (size_t i = 0; i < n; i++) {
			if (i) putchar(',');
			if (ks[i].type == OP_NUM_KEY) printf("%ld", ks[i].n);
			else string(ks[i].s);
		}
		if (nt_span(e->r, &a, &b)) printf("%s[%ld,%ld]", n ? "," : "", a, b);
		putchar(']');
		op_value *v = nt_value_of(e->r);
		if (v != NULL) {
			fputs(",\"value\":", stdout);
			print(v);
			op_free(v);
		}
		printf(",\"live\":%s}\n", e->live ? "true" : "false");
	} else {
		char why[256];
		snprintf(why, sizeof why, "unknown op %s", op->str);
		error(why);
	}
}

int main(void) {
	restart(NULL);
	char *line = NULL;
	size_t size = 0;
	while (getline(&line, &size, stdin) > 0) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		parser s = {line, NULL};
		op_value *q = value(&s);
		if (q != NULL) skip(&s);
		if (q == NULL || *s.p != 0) {
			error(s.why ? s.why : "bad json");
		} else {
			answer(q);
		}
		op_free(q);
		fflush(stdout);
	}
	free(line);
	restart(NULL);
	for (size_t i = 0; i < count; i++) free(entries[i]);
	nt_destroy(notify);
	free(entries);
	return 0;
}
