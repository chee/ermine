// The C mutate on the line protocol (newcore/conformance/mutate/harness.ts): one JSON request per
// line in, one answer per line out. Parses and prints the JSON itself (as notify/c/harness.c).
// Typed arrays: the suite's {"$Int8Array": [...]} (and its four other kinds), and ENCODING.tex's
// JSON form ({"/": {"bytes": b64}}, {"/": {kind: [...]}}), as the reference would write them back.
// which ["children", name] mutates a children list; start and node have none, as the reference.
#include "mutate.h"

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
			// a high and a low are one character; on their own, each is held as WTF-8
			if (u >= 0xD800 && u < 0xDC00 && s->p[0] == '\\' && s->p[1] == 'u') {
				const char *at = s->p;
				s->p += 2;
				if (!hex4(s, &lo)) goto bad;
				if (lo >= 0xDC00 && lo < 0xE000) u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
				else s->p = at;
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
static nt_value *revive(nt_value *m);
static nt_value *value(parser *s) {
	skip(s);
	char c = *s->p;
	if (c == '"') {
		s->p++;
		char *t = literal(s);
		if (t == NULL) return NULL;
		nt_value *v = nt_str(t);
		free(t);
		return v;
	}
	if (c == '[' || c == '{') {
		int map = c == '{';
		nt_value *v = map ? nt_map() : nt_list();
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
			nt_value *item = value(s);
			if (item == NULL) goto bad_key;
			if (map) nt_set(v, key, item);
			else nt_push(v, item);
			free(key);
			skip(s);
			if (*s->p == ',') {
				s->p++;
				continue;
			}
			if (*s->p++ == (map ? '}' : ']')) return map ? revive(v) : v;
			goto bad;
		bad_key:
			free(key);
		bad:
			nt_free(v);
			if (s->why == NULL) s->why = "bad json";
			return NULL;
		}
	}
	if (strncmp(s->p, "null", 4) == 0) return s->p += 4, nt_null();
	if (strncmp(s->p, "true", 4) == 0) return s->p += 4, nt_bool(1);
	if (strncmp(s->p, "false", 5) == 0) return s->p += 5, nt_bool(0);
	char *end;
	double d = strtod(s->p, &end);
	if (end == s->p || c == 'n' || c == 'i' || c == 'I' || c == 'N' || c == '+') {
		s->why = "bad json";
		return NULL;
	}
	s->p = end;
	return nt_num(d);
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
static void put(unsigned char *at, nt_elements kind, const nt_value *x) {
	double d = 0;
	uint64_t u = 0;
	int big = kind == NT_INT64 || kind == NT_UINT64;
	if (x->type == NT_STR) {
		if (strcmp(x->str, "NaN") == 0) d = NAN;
		else if (strcmp(x->str, "Infinity") == 0) d = INFINITY;
		else if (strcmp(x->str, "-Infinity") == 0) d = -INFINITY;
		else if (big) u = x->str[0] == '-' ? (uint64_t)strtoll(x->str, NULL, 10) : strtoull(x->str, NULL, 10);
		else d = strtod(x->str, NULL);
	} else if (x->type == NT_NUM) d = x->num;
	if (kind == NT_FLOAT32) {
		float f = (float)d;
		uint32_t b;
		memcpy(&b, &f, 4);
		u = b;
	} else if (kind == NT_FLOAT64) memcpy(&u, &d, 8);
	else if (!(big && x->type == NT_STR)) {
		d = isfinite(d) ? trunc(d) : 0;
		if (!big) {
			double r = fmod(d, 4294967296.0);
			u = (uint64_t)(r < 0 ? r + 4294967296.0 : r);
		} else if (d < 0) u = d > -9.2e18 ? (uint64_t)(int64_t)d : 0;
		else u = d < 1.8e19 ? (uint64_t)d : 0;
	}
	for (size_t i = 0; i < nt_size(kind); i++) at[i] = (unsigned char)(u >> (8 * i));
}
static uint64_t raw(const nt_value *t, size_t i) {
	size_t z = nt_size(t->kind);
	uint64_t u = 0;
	for (size_t j = 0; j < z; j++) u |= (uint64_t)t->data[i * z + j] << (8 * j);
	return u;
}
// an element as a number (64-bit integers: raw)
static double element(const nt_value *t, size_t i) {
	uint64_t u = raw(t, i);
	switch (t->kind) {
	case NT_INT8: return (int8_t)u;
	case NT_INT16: return (int16_t)u;
	case NT_UINT16: return (uint16_t)u;
	case NT_INT32: return (int32_t)u;
	case NT_UINT32: return (uint32_t)u;
	case NT_FLOAT32: {
		uint32_t b = (uint32_t)u;
		float f;
		memcpy(&f, &b, 4);
		return f;
	}
	case NT_FLOAT64: {
		double d;
		memcpy(&d, &u, 8);
		return d;
	}
	default: return (double)u;
	}
}
static nt_value *typed_of(nt_elements kind, const nt_value *list) {
	unsigned char *buf = grab(list->count * 8);
	for (size_t i = 0; i < list->count; i++) put(buf + i * nt_size(kind), kind, list->items[i]);
	nt_value *t = nt_typed(kind, buf, list->count);
	free(buf);
	return t;
}
// a map in ENCODING.tex's JSON form: the value it stands for, m let go of; else m
static nt_value *beyond(nt_value *m) {
	const nt_value *in = m->count == 1 && strcmp(m->keys[0], "/") == 0 ? m->items[0] : NULL;
	if (in == NULL || in->type != NT_MAP || in->count != 1) return m;
	const nt_value *x = in->items[0];
	nt_value *v = NULL;
	if (strcmp(in->keys[0], "live") == 0) {
		// the kind is kept, m's other holds let go of
		nt_ref((nt_value *)x);
		v = nt_stand((nt_value *)x);
		nt_free(m);
		return v;
	}
	if (strcmp(in->keys[0], "bytes") == 0 && x->type == NT_STR) {
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
		v = nt_bytes(buf, n);
		free(buf);
	}
	for (size_t k = 0; v == NULL && k < sizeof kinds / sizeof *kinds; k++)
		if (strcmp(in->keys[0], kinds[k]) == 0 && x->type == NT_LIST) v = typed_of((nt_elements)k, x);
	if (v == NULL) return m;
	nt_free(m);
	return v;
}
static void print_bytes(const nt_value *v) {
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
static void print_elements(const nt_value *v) {
	putchar('[');
	for (size_t i = 0; i < nt_length(v); i++) {
		if (i) putchar(',');
		double d = element(v, i);
		if (v->kind == NT_INT64) printf("\"%lld\"", (long long)(int64_t)raw(v, i));
		else if (v->kind == NT_UINT64) printf("\"%llu\"", (unsigned long long)raw(v, i));
		else if (isnan(d)) fputs("\"NaN\"", stdout);
		else if (isinf(d)) fputs(d > 0 ? "\"Infinity\"" : "\"-Infinity\"", stdout);
		else number(d);
	}
	putchar(']');
}
// the suite's own form (harness.ts): {"$Int8Array": [...]}, and the four other kinds it knows, in
// nt_elements' order; bytes, a Uint8Array there, in ENCODING.tex's form
static const char *dollars[] = {"$Int8Array", "$Int16Array", "$Uint16Array", "$Int32Array",
	"$Uint32Array"};
static nt_value *revive(nt_value *m) {
	if (m->count == 1 && m->items[0]->type == NT_LIST) {
		for (size_t k = 0; k < sizeof dollars / sizeof *dollars; k++) {
			if (strcmp(m->keys[0], dollars[k]) == 0) {
				nt_value *v = typed_of((nt_elements)k, m->items[0]);
				nt_free(m);
				return v;
			}
		}
	}
	return beyond(m);
}
// a typed array as the reference writes it back: a kind it knows as {"$Kind": [...]}, else as read
static void print_typed(const nt_value *v) {
	if (v->kind <= NT_UINT32) printf("{\"%s\":", dollars[v->kind]);
	else printf("{\"/\":{\"%s\":", kinds[v->kind]);
	print_elements(v);
	fputs(v->kind <= NT_UINT32 ? "}" : "}}", stdout);
}
static void print(const nt_value *v) {
	switch (v->type) {
	case NT_NULL: fputs("null", stdout); break;
	case NT_BOOL: fputs(v->bool_ ? "true" : "false", stdout); break;
	case NT_NUM: number(v->num); break;
	case NT_STR: string(v->str); break;
	case NT_LIST:
		putchar('[');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			print(v->items[i]);
		}
		putchar(']');
		break;
	case NT_MAP:
		putchar('{');
		for (size_t i = 0; i < v->count; i++) {
			if (i) putchar(',');
			string(v->keys[i]);
			putchar(':');
			print(v->items[i]);
		}
		putchar('}');
		break;
	case NT_STAND:
		fputs("{\"/\":{\"live\":", stdout);
		print(v->items[0]);
		fputs("}}", stdout);
		break;
	case NT_BYTES: print_bytes(v); break;
	case NT_TYPED: print_typed(v); break;
	}
}
static void error(const char *why) {
	fputs("{\"error\":", stdout);
	string(why);
	puts("}");
}

// the protocol

static nd_node node;
static nt_value *keep_all[1 << 16];
static size_t kept;

static nt_value *clone(const nt_value *v) {
	nt_value *c;
	switch (v->type) {
	case NT_NULL: return nt_null();
	case NT_BOOL: return nt_bool(v->bool_);
	case NT_NUM: return nt_num(v->num);
	case NT_STR: return nt_str(v->str);
	case NT_BYTES: return nt_bytes(v->data, v->bytes);
	case NT_TYPED: return nt_typed(v->kind, v->data, nt_length(v));
	case NT_STAND: return nt_stand(clone(v->items[0]));
	case NT_LIST:
		c = nt_list();
		for (size_t i = 0; i < v->count; i++) nt_push(c, clone(v->items[i]));
		return c;
	default:
		c = nt_map();
		for (size_t i = 0; i < v->count; i++) nt_set(c, v->keys[i], clone(v->items[i]));
		return c;
	}
}

// [{content, change, because?}] to versions; the values stay the request's, which is kept
static nd_object versions_of(const nt_value *a) {
	nd_object o = {0};
	if (a == NULL || a->type != NT_LIST || a->count == 0) return o;
	nd_version *vs = grab(a->count * sizeof *vs);
	for (size_t i = 0; i < a->count; i++) {
		const nt_value *v = a->items[i];
		vs[i] = (nd_version){nt_get(v, "content"), nt_get(v, "change"), nt_get(v, "because")};
	}
	o.versions = vs;
	o.length = a->count;
	return o;
}

static void print_versions(nd_object o) {
	putchar('[');
	for (size_t i = 0; i < o.length; i++) {
		if (i) putchar(',');
		fputs("{\"content\":", stdout);
		print(o.versions[i].content);
		fputs(",\"change\":", stdout);
		print(o.versions[i].change);
		if (o.versions[i].because) {
			fputs(",\"because\":", stdout);
			print(o.versions[i].because);
		}
		putchar('}');
	}
	putchar(']');
}

// a patch place; anything malformed is one no patch can be: a negative key (not-a-patch)
static const nt_key bad_key = {.type = NT_NUM_KEY, .n = -1};
static int whole(const nt_value *x, long *out) {
	if (x->type != NT_NUM || x->num != floor(x->num) || fabs(x->num) > 1e15) return 0;
	*out = (long)x->num;
	return 1;
}
static void place_of(const nt_value *m, nt_place *p) {
	memset(p, 0, sizeof *p);
	const nt_value *path = m && m->type == NT_MAP ? nt_get(m, "path") : NULL;
	if (path == NULL || path->type != NT_LIST) goto bad;
	nt_key *ks = grab((path->count + 1) * sizeof *ks);
	for (size_t i = 0; i < path->count; i++) {
		const nt_value *x = path->items[i];
		ks[i] = (nt_key){0};
		if (x->type == NT_STR) ks[i] = (nt_key){.type = NT_STR_KEY, .s = x->str};
		else if (x->type == NT_NUM && whole(x, &ks[i].n)) ks[i].type = NT_NUM_KEY;
		else {
			free(ks);
			goto bad;
		}
	}
	p->path = ks;
	p->length = path->count;
	const nt_value *r = nt_get(m, "range");
	if (r != NULL) {
		if (r->type != NT_LIST || r->count != 2 || !whole(r->items[0], &p->from) ||
				!whole(r->items[1], &p->to)) goto bad_range;
		p->has_range = 1;
	}
	return;
bad_range:
	free((void *)p->path);
bad:
	memset(p, 0, sizeof *p);
	p->path = &bad_key;
	p->length = 1;
}
static void patch_of(const nt_value *m, nt_patch *p) {
	memset(p, 0, sizeof *p);
	place_of(m, &p->place);
	if (m == NULL || m->type != NT_MAP) return;
	p->value = nt_get(m, "value");
	p->has_value = p->value != NULL;
	const nt_value *mv = nt_get(m, "move");
	if (mv != NULL) {
		p->has_move = 1;
		place_of(mv, &p->move);
	}
}
static void free_patch(nt_patch *p) {
	if (p->place.path != &bad_key) free((void *)p->place.path);
	if (p->has_move && p->move.path != &bad_key) free((void *)p->move.path);
}

static void *plain(void *ctx, size_t n) {
	(void)ctx;
	return grab(n);
}

typedef struct {
	mu_facts *facts;
	size_t count;
} told;
static void hear(void *ctx, const nt_patch *patch, const mu_facts *f, const char *id, mu_which which) {
	(void)patch, (void)id, (void)which;
	told *t = ctx;
	t->facts[t->count++] = *f;
}
static void print_fact(const mu_fact *f) {
	printf("{\"list\":%s,\"length\":%zu,\"had\":%s}", f->list ? "true" : "false", f->length,
		f->had ? "true" : "false");
}

static void answer(nt_value *q) {
	const nt_value *op = nt_get(q, "op");
	if (q->type != NT_MAP || op == NULL || op->type != NT_STR) { error("unknown op undefined"); return; }
	if (strcmp(op->str, "start") == 0) {
		const nt_value *id = nt_get(q, "id"), *info = nt_get(q, "info");
		node = (nd_node){.id = id && id->type == NT_STR ? id->str : "a"};
		node.value = versions_of(nt_get(q, "value"));
		node.info_length = info && info->type == NT_LIST ? info->count : 0;
		node.info = node.info_length ? grab(node.info_length * sizeof *node.info) : NULL;
		for (size_t i = 0; i < node.info_length; i++) {
			const nt_value *e = info->items[i];
			node.info[i] = (nd_entry){e->items[0]->str, versions_of(e->items[1])};
		}
		puts("{}");
	} else if (strcmp(op->str, "node") == 0) {
		printf("{\"node\":{\"id\":");
		string(node.id);
		fputs(",\"value\":", stdout);
		print_versions(node.value);
		fputs(",\"info\":[", stdout);
		for (size_t i = 0; i < node.info_length; i++) {
			if (i) putchar(',');
			putchar('[');
			string(node.info[i].name);
			putchar(',');
			print_versions(node.info[i].object);
			putchar(']');
		}
		puts("]}}");
	} else if (strcmp(op->str, "mutate") == 0) {
		mu_which which = {MU_VALUE, NULL};
		const nt_value *wh = nt_get(q, "which");
		if (wh && wh->type == NT_LIST && wh->count == 2) {
			const nt_value *part = wh->items[0];
			int kids = part->type == NT_STR && strcmp(part->str, "children") == 0;
			which = (mu_which){kids ? MU_CHILDREN : MU_INFO, wh->items[1]->str};
		}
		const nt_value *ps = nt_get(q, "patches"), *hd = nt_get(q, "header");
		size_t n = ps && ps->type == NT_LIST ? ps->count : 0;
		nt_patch *patches = grab((n + 1) * sizeof *patches);
		for (size_t i = 0; i < n; i++) patch_of(ps->items[i], &patches[i]);
		nt_value *change;
		if (hd && hd->type == NT_MAP) change = clone(hd);
		else {
			change = nt_map();
			nt_set(change, "time", nt_num(1));
			nt_set(change, "actor", nt_str("me"));
		}
		nt_set(change, "node", nt_str(node.id));
		const nt_value *tell = nt_get(q, "patched");
		int telling = tell && tell->type == NT_BOOL && tell->bool_;
		told t = {grab((n + 1) * sizeof *t.facts), 0};
		mu_patched hearing = {hear, &t};
		mu_alloc alloc = {plain, NULL};
		size_t at = 0;
		int code = mu_mutate(&node, which, patches, n, change, &alloc, telling ? &hearing : NULL, &at);
		if (code != MU_OK) {
			nt_free(change);
			printf("{\"fail\":\"%s\",\"patch\":%zu}\n", mu_code_name(code), at);
		} else {
			fputs("{\"change\":", stdout);
			print(change);
			if (telling) {
				fputs(",\"facts\":[", stdout);
				for (size_t i = 0; i < t.count; i++) {
					const mu_facts *f = &t.facts[i];
					if (i) putchar(',');
					fputs("{\"place\":", stdout);
					print_fact(&f->place);
					if (f->has_from) {
						fputs(",\"from\":", stdout);
						print_fact(&f->from);
					}
					if (f->has_size) printf(",\"size\":%zu", f->size);
					putchar('}');
				}
				putchar(']');
			}
			puts("}");
		}
		for (size_t i = 0; i < n; i++) free_patch(&patches[i]);
		free(patches);
		free(t.facts);
	} else {
		char why[256];
		snprintf(why, sizeof why, "unknown op %s", op->str);
		error(why);
	}
}

int main(void) {
	char *line = NULL;
	size_t size = 0;
	while (getline(&line, &size, stdin) > 0) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		parser s = {line, NULL};
		nt_value *q = value(&s);
		if (q != NULL) skip(&s);
		if (q == NULL || *s.p != 0) {
			error(s.why ? s.why : "bad json");
			nt_free(q);
		} else {
			answer(q);
			// what the node holds may be the request's: kept
			if (kept == sizeof keep_all / sizeof *keep_all) fail("too many requests");
			keep_all[kept++] = q;
		}
		fflush(stdout);
	}
	free(line);
	return 0;
}
