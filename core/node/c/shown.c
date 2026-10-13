// Shown nodes on the line protocol, for the C harnesses (shown.h): reading JSON as spans of the
// line, values as op_values (with typed arrays and bytes), changes and patches, and writing them.
#include "shown.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) fail("out of memory");
	return p;
}

void fail(const char *why) {
	fprintf(stderr, "harness: %s\n", why);
	exit(1);
}

// everything one line allocates, freed when its answer is written
void **arena;
size_t arena_length, arena_capacity;
void *take(size_t size) {
	void *p = malloc(size ? size : 1);
	if (p == NULL) fail("out of memory");
	if (arena_length == arena_capacity) {
		arena_capacity = arena_capacity ? arena_capacity * 2 : 64;
		arena = realloc(arena, arena_capacity * sizeof *arena);
		if (arena == NULL) fail("out of memory");
	}
	return arena[arena_length++] = p;
}
void clear(void) {
	for (size_t i = 0; i < arena_length; i++) free(arena[i]);
	arena_length = 0;
}

void finish(void) {
	clear();
	free(arena);
}

// --- reading JSON: values as spans of the line ---

const char *space(const char *p) {
	while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
	return p;
}

// past one value
const char *skip(const char *p) {
	p = space(p);
	if (*p == '"') {
		for (p++; *p && *p != '"'; p++)
			if (*p == '\\' && p[1]) p++;
		if (*p != '"') fail("bad string");
		return p + 1;
	}
	if (*p == '{' || *p == '[') {
		char close = *p == '{' ? '}' : ']';
		p = space(p + 1);
		if (*p == close) return p + 1;
		for (;;) {
			p = skip(p);
			p = space(p);
			if (close == '}' && *p == ':') p = space(skip(p + 1));
			if (*p == ',') p++;
			else if (*p == close) return p + 1;
			else fail("bad object or array");
		}
	}
	const char *start = p;
	while (*p && !strchr(",:]} \t\r\n", *p)) p++;
	if (p == start) fail("no value");
	return p;
}

void utf8(char **out, unsigned long c) {
	char *o = *out;
	// U+0000 held as C0 80, as json.h holds it
	if (c == 0) *o++ = (char)0xC0, *o++ = (char)0x80;
	else if (c < 0x80) *o++ = (char)c;
	else if (c < 0x800) *o++ = (char)(0xC0 | c >> 6), *o++ = (char)(0x80 | (c & 0x3F));
	else if (c < 0x10000)
		*o++ = (char)(0xE0 | c >> 12), *o++ = (char)(0x80 | (c >> 6 & 0x3F)),
		*o++ = (char)(0x80 | (c & 0x3F));
	else
		*o++ = (char)(0xF0 | c >> 18), *o++ = (char)(0x80 | (c >> 12 & 0x3F)),
		*o++ = (char)(0x80 | (c >> 6 & 0x3F)), *o++ = (char)(0x80 | (c & 0x3F));
	*out = o;
}

// a JSON string at p, decoded
char *string(const char *p) {
	p = space(p);
	if (*p != '"') fail("not a string");
	const char *end = skip(p);
	char *s = take((size_t)(end - p)), *o = s;
	for (p++; *p != '"'; p++) {
		if (*p != '\\') {
			*o++ = *p;
			continue;
		}
		switch (*++p) {
		case 'b': *o++ = '\b'; break;
		case 'f': *o++ = '\f'; break;
		case 'n': *o++ = '\n'; break;
		case 'r': *o++ = '\r'; break;
		case 't': *o++ = '\t'; break;
		case 'u': {
			unsigned long c = strtoul((char[5]){p[1], p[2], p[3], p[4], 0}, NULL, 16);
			p += 4;
			if (c >= 0xD800 && c < 0xDC00 && p[1] == '\\' && p[2] == 'u') {
				unsigned long low = strtoul((char[5]){p[3], p[4], p[5], p[6], 0}, NULL, 16);
				c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00);
				p += 6;
			}
			utf8(&o, c);
			break;
		}
		default: *o++ = *p;
		}
	}
	*o = 0;
	return s;
}

// a value's JSON text, as written
char *raw(const char *p) {
	p = space(p);
	const char *end = skip(p);
	char *s = take((size_t)(end - p) + 1);
	memcpy(s, p, (size_t)(end - p));
	s[end - p] = 0;
	return s;
}

// the value at key in the object at p; NULL when absent
const char *field(const char *p, const char *key) {
	p = space(p);
	if (*p != '{') fail("not an object");
	p = space(p + 1);
	while (*p == '"') {
		char *name = string(p);
		p = space(skip(p));
		if (*p != ':') fail("no colon");
		const char *value = space(p + 1);
		if (strcmp(name, key) == 0) return value;
		p = space(skip(value));
		if (*p == ',') p = space(p + 1);
	}
	return NULL;
}

// the items of the array at p: count, then each start
size_t items(const char *p, const char ***out) {
	p = space(p);
	if (*p != '[') fail("not an array");
	size_t n = 0;
	for (const char *q = space(p + 1); *q != ']'; n++) {
		q = space(skip(q));
		if (*q == ',') q = space(q + 1);
	}
	const char **xs = take(n * sizeof *xs);
	const char *q = space(p + 1);
	for (size_t i = 0; i < n; i++) {
		xs[i] = q;
		q = space(skip(q));
		if (*q == ',') q = space(q + 1);
	}
	*out = xs;
	return n;
}


// json in

typedef struct {
	const char *p;
	const char *why;
} parser;

static void jspace(parser *s) {
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
static size_t put8(char *out, unsigned c) {
	// U+0000 held as C0 80
	if (c == 0) return out[0] = (char)0xC0, out[1] = (char)0x80, 2;
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
			// a high and a low are one character; on their own, each is held as WTF-8
			if (u >= 0xD800 && u < 0xDC00 && s->p[0] == '\\' && s->p[1] == 'u') {
				const char *at = s->p;
				s->p += 2;
				if (!hex4(s, &lo)) goto bad;
				if (lo >= 0xDC00 && lo < 0xE000) u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
				else s->p = at;
			}
			n += put8(out + n, u);
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
static op_value *revive(op_value *m);
static op_value *jvalue(parser *s) {
	jspace(s);
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
		jspace(s);
		if (*s->p == (map ? '}' : ']')) return s->p++, v;
		for (;;) {
			char *key = NULL;
			if (map) {
				jspace(s);
				if (*s->p++ != '"' || (key = literal(s)) == NULL) goto bad;
				jspace(s);
				if (*s->p++ != ':') goto bad_key;
			}
			op_value *item = jvalue(s);
			if (item == NULL) goto bad_key;
			if (map) op_set(v, key, item);
			else op_push(v, item);
			free(key);
			jspace(s);
			if (*s->p == ',') {
				s->p++;
				continue;
			}
			if (*s->p++ == (map ? '}' : ']')) return map ? revive(v) : v;
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

void text(const char *s) {
	putchar('"');
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == 0xC0 && (unsigned char)s[1] == 0x80) fputs("\\u0000", stdout), s++;
		else if (c == '"' || c == '\\') printf("\\%c", c);
		else if (c == '\n') fputs("\\n", stdout);
		else if (c == '\r') fputs("\\r", stdout);
		else if (c == '\t') fputs("\\t", stdout);
		else if (c == '\b') fputs("\\b", stdout);
		else if (c == '\f') fputs("\\f", stdout);
		else if (c < 0x20) printf("\\u%04x", c);
		// a lone surrogate, held as WTF-8 (ED A0..BF xx), is written as the escape
		else if (c == 0xED && ((unsigned char)s[1] & 0xE0) == 0xA0 && s[2]) {
			printf("\\u%04x", 0xD000 | (((unsigned char)s[1] & 63) << 6) | ((unsigned char)s[2] & 63));
			s += 2;
		} else putchar(c);
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
static uint64_t bits(const op_value *t, size_t i) {
	size_t z = op_size(t->kind);
	uint64_t u = 0;
	for (size_t j = 0; j < z; j++) u |= (uint64_t)t->data[i * z + j] << (8 * j);
	return u;
}
// an element as a number (64-bit integers: raw)
static double element(const op_value *t, size_t i) {
	uint64_t u = bits(t, i);
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
		if (v->kind == OP_INT64) printf("\"%lld\"", (long long)(int64_t)bits(v, i));
		else if (v->kind == OP_UINT64) printf("\"%llu\"", (unsigned long long)bits(v, i));
		else if (isnan(d)) fputs("\"NaN\"", stdout);
		else if (isinf(d)) fputs(d > 0 ? "\"Infinity\"" : "\"-Infinity\"", stdout);
		else number(d);
	}
	putchar(']');
}
// the suite's own form (harness.ts): {"$Int8Array": [...]}, and the four other kinds it knows, in
// op_elements' order; bytes, a Uint8Array there, in ENCODING.tex's form
static const char *dollars[] = {"$Int8Array", "$Int16Array", "$Uint16Array", "$Int32Array",
	"$Uint32Array"};
static op_value *revive(op_value *m) {
	if (m->count == 1 && m->items[0]->type == OP_LIST) {
		for (size_t k = 0; k < sizeof dollars / sizeof *dollars; k++) {
			if (strcmp(m->keys[0], dollars[k]) == 0) {
				op_value *v = typed_of((op_elements)k, m->items[0]);
				op_free(m);
				return v;
			}
		}
	}
	return beyond(m);
}
// a typed array as the reference writes it back: a kind it knows as {"$Kind": [...]}, else as read
static void print_typed(const op_value *v) {
	if (v->kind <= OP_UINT32) printf("{\"%s\":", dollars[v->kind]);
	else printf("{\"/\":{\"%s\":", kinds[v->kind]);
	print_elements(v);
	fputs(v->kind <= OP_UINT32 ? "}" : "}}", stdout);
}
void print_value(const op_value *v) {
	switch (v->type) {
	case OP_NULL: fputs("null", stdout); break;
	case OP_BOOL: fputs(v->bool_ ? "true" : "false", stdout); break;
	case OP_NUM: number(v->num); break;
	case OP_STR: text(v->str); break;
	case OP_LIST:
		putchar('[');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			print_value(v->items[i]);
		}
		putchar(']');
		break;
	case OP_MAP:
		putchar('{');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			text(v->keys[i]);
			putchar(':');
			print_value(v->items[i]);
		}
		putchar('}');
		break;
	case OP_STAND:
		fputs("{\"/\":{\"live\":", stdout);
		print_value(v->items[0]);
		fputs("}}", stdout);
		break;
	case OP_BYTES: print_bytes(v); break;
	case OP_TYPED: print_typed(v); break;
	}
}

// a JSON span as a value (revived); op_free it
op_value *read_value(const char *p) {
	parser s = {p, NULL};
	op_value *v = jvalue(&s);
	if (v == NULL) fail(s.why ? s.why : "bad json");
	return v;
}

// --- changes ---

ch_site site(const char *p) {
	const char *column = field(p, "column"), *function = field(p, "function");
	return (ch_site){
		string(field(p, "file")),
		strtol(field(p, "line"), NULL, 10),
		column ? strtol(column, NULL, 10) : 0,
		function ? string(function) : NULL,
		column != NULL,
	};
}

ch_header parse_header(const char *p) {
	ch_header h = {0};
	const char *time = field(p, "time"), *actor = field(p, "actor"), *reader = field(p, "reader"),
		   *at = field(p, "external"), *meta = field(p, "metadata");
	if (time) h.has_time = 1, h.time = strtoll(time, NULL, 10);
	if (actor) h.actor = raw(actor);
	if (reader) h.reader = string(reader);
	if (at) {
		const char **xs;
		size_t n = items(at, &xs);
		ch_site *ss = take((n ? n : 1) * sizeof *ss);
		for (size_t i = 0; i < n; i++) ss[i] = site(xs[i]);
		h.external = ss;
		h.external_length = n;
	}
	if (meta) {
		const char **xs;
		size_t n = items(meta, &xs);
		ch_entry *es = take((n ? n : 1) * sizeof *es);
		for (size_t i = 0; i < n; i++) {
			const char **kv;
			if (items(xs[i], &kv) != 2) fail("bad metadata entry");
			es[i] = (ch_entry){string(kv[0]), raw(kv[1])};
		}
		h.metadata = es;
		h.metadata_length = n;
	}
	return h;
}

// --- patches ---

// a patch place; anything malformed is one no patch can be: a negative key (not-a-patch)
static const op_key bad_key = {.type = OP_NUM_KEY, .n = -1};
static int whole(const op_value *x, long *out) {
	if (x->type != OP_NUM || x->num != floor(x->num) || fabs(x->num) > 1e15) return 0;
	*out = (long)x->num;
	return 1;
}
static void place_of(const op_value *m, op_target *p) {
	memset(p, 0, sizeof *p);
	const op_value *path = m && m->type == OP_MAP ? op_get(m, "path") : NULL;
	if (path == NULL || path->type != OP_LIST) goto bad;
	op_key *ks = take((path->count + 1) * sizeof *ks);
	for (size_t i = 0; i < path->count; i++) {
		const op_value *x = path->items[i];
		ks[i] = (op_key){0};
		if (x->type == OP_STR) ks[i] = (op_key){.type = OP_STR_KEY, .s = x->str};
		else if (x->type == OP_NUM && whole(x, &ks[i].n)) ks[i].type = OP_NUM_KEY;
		else goto bad;
	}
	p->path = ks;
	p->length = path->count;
	const op_value *r = op_get(m, "range");
	if (r != NULL) {
		if (r->type != OP_LIST || r->count != 2 || !whole(r->items[0], &p->from) ||
				!whole(r->items[1], &p->to)) goto bad;
		p->has_range = 1;
	}
	return;
bad:
	memset(p, 0, sizeof *p);
	p->path = &bad_key;
	p->length = 1;
}

op_value *read_patch(const char *p, op_patch *out) {
	op_value *m = read_value(p);
	memset(out, 0, sizeof *out);
	place_of(m, &out->place);
	if (m->type != OP_MAP) return m;
	out->value = op_get(m, "value");
	out->has_value = out->value != NULL;
	const op_value *mv = op_get(m, "move");
	if (mv != NULL) {
		out->has_move = 1;
		place_of(mv, &out->move);
	}
	return m;
}

static void print_target(const op_target *t) {
	fputs("\"path\":[", stdout);
	for (size_t i = 0; i < t->length; i++) {
		if (i) putchar(',');
		if (t->path[i].type == OP_STR_KEY) text(t->path[i].s);
		else printf("%ld", t->path[i].n);
	}
	putchar(']');
	if (t->has_range) printf(",\"range\":[%ld,%ld]", t->from, t->to);
}

static void print_patch(const op_patch *p) {
	putchar('{');
	print_target(&p->place);
	if (p->has_value) {
		fputs(",\"value\":", stdout);
		print_value(p->value);
	}
	if (p->has_move) {
		fputs(",\"move\":{", stdout);
		print_target(&p->move);
		putchar('}');
	}
	putchar('}');
}

static void print_patches(const op_patch *ps, size_t n) {
	putchar('[');
	for (size_t i = 0; i < n; i++) {
		if (i) putchar(',');
		print_patch(&ps[i]);
	}
	putchar(']');
}

void print_header(const ch_header *h) {
	const char *comma = "";
	putchar('{');
	if (h->has_time) printf("\"time\":%lld", (long long)h->time), comma = ",";
	if (h->actor) printf("%s\"actor\":%s", comma, (const char *)h->actor), comma = ",";
	if (h->reader) printf("%s\"reader\":", comma), text(h->reader), comma = ",";
	if (h->external) {
		printf("%s\"external\":[", comma);
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			if (i) putchar(',');
			fputs("{\"file\":", stdout);
			text(s->file ? s->file : "");
			printf(",\"line\":%ld", s->line);
			if (s->has_column) printf(",\"column\":%ld", s->column);
			if (s->function) fputs(",\"function\":", stdout), text(s->function);
			putchar('}');
		}
		putchar(']');
		comma = ",";
	}
	if (h->metadata) {
		printf("%s\"metadata\":[", comma);
		for (size_t i = 0; i < h->metadata_length; i++) {
			if (i) putchar(',');
			putchar('[');
			text(h->metadata[i].key);
			printf(",%s]", (const char *)h->metadata[i].value);
		}
		putchar(']');
		comma = ",";
	}
	if (h->has_op) {
		printf("%s\"op\":{\"patches\":", comma);
		print_patches(h->patches, h->patches_length);
		fputs(",\"undo\":", stdout);
		print_patches(h->undo, h->undo_length);
		putchar('}');
	}
	putchar('}');
}

void show_node(const nd_node *n) {
	putchar('{');
	if (n->value) {
		fputs("\"value\":", stdout);
		print_value(n->value);
		putchar(',');
	}
	fputs("\"change\":", stdout);
	print_header(&n->change);
	putchar('}');
}

nd_node *parse_node(const char *p, op_value **value) {
	const char *v = field(p, "value"), *given = field(p, "header");
	*value = v ? read_value(v) : NULL;
	ch_header h = given ? parse_header(given) : (ch_header){0};
	nd_node *n = nd_make(*value, &h);
	if (n == NULL) fail("out of memory");
	return n;
}
