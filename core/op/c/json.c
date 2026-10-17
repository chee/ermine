// op's value in JSON (json.h), in C.
#include "json.h"
#include "whole.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) {
		fputs("op: out of memory\n", stderr);
		abort();
	}
	return p;
}

// --- reading ---

typedef struct {
	const char *p;
	const char *why;
} reader;

static const char *kinds[] = {"int8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
	"float32", "float64"};
static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static void blank(reader *r) {
	while (*r->p == ' ' || *r->p == '\t' || *r->p == '\r' || *r->p == '\n') r->p++;
}
static int hex4(reader *r, unsigned *out) {
	unsigned x = 0;
	for (int i = 0; i < 4; i++) {
		char c = r->p[i];
		x <<= 4;
		if (c >= '0' && c <= '9') x |= (unsigned)(c - '0');
		else if (c >= 'a' && c <= 'f') x |= (unsigned)(c - 'a' + 10);
		else if (c >= 'A' && c <= 'F') x |= (unsigned)(c - 'A' + 10);
		else return 0;
	}
	r->p += 4;
	*out = x;
	return 1;
}
// one code point as UTF-8; U+0000 as C0 80, a lone surrogate as its 3 bytes
static size_t put8(char *out, unsigned c) {
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
// a string literal, after its opening quote: malloc'd, its length in *length; NULL when bad
static char *literal(reader *r, size_t *length) {
	// room for the literal as written, up to its closing quote (an escape never grows): not the
	// rest of the line, which made reading a line quadratic in its length
	const char *end = r->p;
	while (*end && *end != '"') end += *end == '\\' && end[1] ? 2 : 1;
	char *out = grab((size_t)(end - r->p) + 1);
	size_t n = 0;
	while (*r->p != '"') {
		unsigned char c = (unsigned char)*r->p;
		if (c < 0x20) goto bad;
		r->p++;
		if (c != '\\') {
			out[n++] = (char)c;
			continue;
		}
		char e = *r->p++;
		switch (e) {
		case '"': case '\\': case '/': out[n++] = e; break;
		case 'b': out[n++] = '\b'; break;
		case 'f': out[n++] = '\f'; break;
		case 'n': out[n++] = '\n'; break;
		case 'r': out[n++] = '\r'; break;
		case 't': out[n++] = '\t'; break;
		case 'u': {
			unsigned u, lo;
			if (!hex4(r, &u)) goto bad;
			// a high and a low are one character; on their own, each is held as WTF-8
			if (u >= 0xD800 && u < 0xDC00 && r->p[0] == '\\' && r->p[1] == 'u') {
				const char *at = r->p;
				r->p += 2;
				if (!hex4(r, &lo)) goto bad;
				if (lo >= 0xDC00 && lo < 0xE000) u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
				else r->p = at;
			}
			n += put8(out + n, u);
			break;
		}
		default: goto bad;
		}
	}
	r->p++;
	out[n] = 0;
	*length = n;
	return out;
bad:
	free(out);
	r->why = "bad string";
	return NULL;
}

static op_value *plain(reader *r, int depth);

static op_value *number(reader *r) {
	const char *s = r->p, *q = s;
	if (*q == '-') q++;
	if (*q == '0') q++;
	else if (*q >= '1' && *q <= '9') while (*q >= '0' && *q <= '9') q++;
	else goto bad;
	if (*q == '.') {
		q++;
		if (!(*q >= '0' && *q <= '9')) goto bad;
		while (*q >= '0' && *q <= '9') q++;
	}
	if (*q == 'e' || *q == 'E') {
		q++;
		if (*q == '+' || *q == '-') q++;
		if (!(*q >= '0' && *q <= '9')) goto bad;
		while (*q >= '0' && *q <= '9') q++;
	}
	r->p = q;
	// digits alone: a whole number, exactly
	size_t length = (size_t)(q - s);
	int negative = *s == '-';
	if (length - (size_t)negative > 15 && !memchr(s, '.', length) && !memchr(s, 'e', length) &&
	    !memchr(s, 'E', length)) {
		size_t n;
		unsigned char *m = whole_parse(s + negative, length - (size_t)negative, &n);
		op_value *v = op_whole(negative, m, n);
		free(m);
		return v;
	}
	char *text = grab(length + 1);
	memcpy(text, s, length);
	text[length] = 0;
	double d = strtod(text, NULL);
	free(text);
	return op_num(d);
bad:
	r->why = "bad json";
	return NULL;
}

// JSON as it is, "/" forms and all
static op_value *plain(reader *r, int depth) {
	blank(r);
	char c = *r->p;
	if (depth > 4000) return r->why = "too deep", NULL;
	if (c == '"') {
		r->p++;
		size_t n;
		char *s = literal(r, &n);
		return s ? op_str_take(s, n) : NULL;
	}
	if (c == '[' || c == '{') {
		int map = c == '{';
		op_value *v = map ? op_map() : op_list();
		r->p++;
		blank(r);
		if (*r->p == (map ? '}' : ']')) return r->p++, v;
		for (;;) {
			char *key = NULL;
			if (map) {
				size_t n;
				blank(r);
				if (*r->p++ != '"' || (key = literal(r, &n)) == NULL) goto bad;
				blank(r);
				if (*r->p++ != ':') goto bad_key;
			}
			op_value *item = plain(r, depth + 1);
			if (item == NULL) goto bad_key;
			if (map) op_set(v, key, item);
			else op_push(v, item);
			free(key);
			blank(r);
			if (*r->p == ',') {
				r->p++;
				continue;
			}
			if (*r->p++ == (map ? '}' : ']')) return v;
			goto bad;
		bad_key:
			free(key);
		bad:
			op_free(v);
			if (r->why == NULL) r->why = "bad json";
			return NULL;
		}
	}
	if (strncmp(r->p, "null", 4) == 0) return r->p += 4, op_null();
	if (strncmp(r->p, "true", 4) == 0) return r->p += 4, op_bool(1);
	if (strncmp(r->p, "false", 5) == 0) return r->p += 5, op_bool(0);
	return number(r);
}

// the "/" forms, from the top: v is let go of, what it stands for returned; NULL (all let go of)
// when a form is malformed
static op_value *revive(reader *r, op_value *v);
static op_value *bigint_of(const op_value *body);

static int is_form(const op_value *v) {
	return v->type == OP_MAP && v->count == 1 && strcmp(v->keys[0], "/") == 0;
}
static int is_word(const op_value *x, double *out) {
	if (x->type != OP_STR) return 0;
	if (strcmp(x->str, "NaN") == 0) *out = NAN;
	else if (strcmp(x->str, "Infinity") == 0) *out = INFINITY;
	else if (strcmp(x->str, "-Infinity") == 0) *out = -INFINITY;
	else return 0;
	return 1;
}
// one element of a typed array, little-endian at `at`, from the JSON it is written as: a whole
// number in range; 64-bit, a decimal string; a float, a number or a word. 0 when it is not one
static int element(op_elements kind, const op_value *x, unsigned char *at) {
	static const double lo[] = {-128, -32768, 0, -2147483648.0, 0};
	static const double hi[] = {127, 32767, 65535, 2147483647.0, 4294967295.0};
	uint64_t u = 0;
	double d;
	if (kind == OP_INT64 || kind == OP_UINT64) {
		if (x->type != OP_STR || !*x->str || (kind == OP_UINT64 && x->str[0] == '-')) return 0;
		char *end;
		errno = 0;
		u = kind == OP_INT64 ? (uint64_t)strtoll(x->str, &end, 10) : strtoull(x->str, &end, 10);
		if (errno || *end || isspace((unsigned char)*x->str)) return 0;
	} else if (kind == OP_FLOAT32 || kind == OP_FLOAT64) {
		if (x->type == OP_NUM) d = x->num;
		else if (!is_word(x, &d)) return 0;
		if (kind == OP_FLOAT32) {
			float f = (float)d;
			uint32_t b;
			memcpy(&b, &f, 4);
			u = b;
		} else memcpy(&u, &d, 8);
	} else {
		if (x->type != OP_NUM || x->num != floor(x->num) || x->num < lo[kind] || x->num > hi[kind]) return 0;
		u = (uint64_t)(int64_t)x->num;
	}
	for (size_t i = 0; i < op_size(kind); i++) at[i] = (unsigned char)(u >> (8 * i));
	return 1;
}
static op_value *typed_of(op_elements kind, const op_value *list) {
	if (list->type != OP_LIST) return NULL;
	unsigned char *buf = grab(list->count * 8);
	for (size_t i = 0; i < list->count; i++) {
		if (!element(kind, list->items[i], buf + i * op_size(kind))) return free(buf), NULL;
	}
	op_value *t = op_typed(kind, buf, list->count);
	free(buf);
	return t;
}
// bytes from base64, standard alphabet, no padding, in the one spelling of them: the bits past the
// last byte zero
static op_value *bytes_of(const op_value *x) {
	if (x->type != OP_STR || x->bytes % 4 == 1) return NULL;
	unsigned char *buf = grab(x->bytes);
	size_t n = 0;
	uint32_t acc = 0;
	int held = 0;
	for (const char *c = x->str; *c; c++) {
		const char *d = strchr(b64, *c);
		if (d == NULL) return free(buf), NULL;
		acc = (acc << 6) | (uint32_t)(d - b64);
		held += 6;
		if (held >= 8) held -= 8, buf[n++] = (unsigned char)(acc >> held);
		acc &= (1u << held) - 1;
	}
	op_value *v = acc ? NULL : op_bytes(buf, n);
	free(buf);
	return v;
}

static op_value *revive(reader *r, op_value *v) {
	if (v->type == OP_LIST || (v->type == OP_MAP && !is_form(v))) {
		for (size_t i = 0; i < v->count; i++) {
			if ((v->items[i] = revive(r, v->items[i])) == NULL) {
				// the item that failed is let go of already: v is, with a null in its place
				v->items[i] = op_null();
				op_free(v);
				return NULL;
			}
		}
		return v;
	}
	if (v->type != OP_MAP) return v;
	const op_value *form = v->items[0];
	if (form->type != OP_MAP || form->count != 1) return r->why = "bad form", op_free(v), NULL;
	const char *tag = form->keys[0];
	op_value *body = form->items[0], *made = NULL;
	double word;
	if (strcmp(tag, "map") == 0) {
		// a map whose one key is "/", as data: its value is revived in turn
		if (is_form(body)) {
			made = op_ref(body);
			op_free(v);
			if ((made->items[0] = revive(r, made->items[0])) == NULL) {
				made->items[0] = op_null();
				op_free(made);
				return NULL;
			}
			return made;
		}
	} else if (strcmp(tag, "live") == 0) {
		made = op_ref(body);
		op_free(v);
		if ((made = revive(r, made)) == NULL) return NULL;
		return op_stand(made);
	} else if (strcmp(tag, "bytes") == 0) made = bytes_of(body);
	else if (strcmp(tag, "bigint") == 0) made = bigint_of(body);
	else if (strcmp(tag, "number") == 0) made = is_word(body, &word) ? op_num(word) : NULL;
	else {
		for (size_t k = 0; made == NULL && k < sizeof kinds / sizeof *kinds; k++)
			if (strcmp(tag, kinds[k]) == 0) made = typed_of((op_elements)k, body);
	}
	if (made == NULL) r->why = "bad form";
	op_free(v);
	return made;
}

// a whole number past 2^53 - 1 either way, in decimal, no leading zero: the one spelling of the
// "bigint" form (a safe one is plain digits); NULL otherwise
static op_value *bigint_of(const op_value *body) {
	if (body == NULL || body->type != OP_STR) return NULL;
	const char *s = body->str;
	int negative = *s == '-';
	const char *d = s + negative;
	size_t n = strlen(d);
	if (n == 0 || (n > 1 && d[0] == '0')) return NULL;
	for (size_t i = 0; i < n; i++)
		if (d[i] < '0' || d[i] > '9') return NULL;
	size_t bytes;
	unsigned char *m = whole_parse(d, n, &bytes);
	op_value *v = op_whole(negative, m, bytes);
	free(m);
	if (v->big == NULL && fabs(v->num) <= 9007199254740991.0) {
		op_free(v);
		return NULL;
	}
	return v;
}

op_value *op_json_read(const char *text, const char **why) {
	reader r = {text, NULL};
	op_value *v = plain(&r, 0);
	if (v != NULL) {
		blank(&r);
		if (*r.p) op_free(v), v = NULL, r.why = "bad json";
	}
	if (v != NULL) v = revive(&r, v);
	if (v == NULL && why) *why = r.why ? r.why : "bad json";
	return v;
}

// --- writing ---

void op_json_string(FILE *out, const char *s) {
	putc('"', out);
	for (; *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == 0xC0 && (unsigned char)s[1] == 0x80) fputs("\\u0000", out), s++;
		else if (c == '"' || c == '\\') fprintf(out, "\\%c", c);
		else if (c == '\n') fputs("\\n", out);
		else if (c == '\r') fputs("\\r", out);
		else if (c == '\t') fputs("\\t", out);
		else if (c == '\b') fputs("\\b", out);
		else if (c == '\f') fputs("\\f", out);
		else if (c < 0x20) fprintf(out, "\\u%04x", c);
		// a lone surrogate, held as WTF-8 (ED A0..BF xx), is written as its escape
		else if (c == 0xED && ((unsigned char)s[1] & 0xE0) == 0xA0 && s[2]) {
			fprintf(out, "\\u%04x", 0xD000 | (((unsigned char)s[1] & 63) << 6) | ((unsigned char)s[2] & 63));
			s += 2;
		} else putc(c, out);
	}
	putc('"', out);
}
// a number: the fewest digits that read back the same; -0 as -0. before and after go around the
// words NaN and Infinity, which JSON has no number for
static void put_number(FILE *out, double d, const char *before, const char *after) {
	if (isnan(d) || isinf(d)) {
		fprintf(out, "%s%s%s", before, isnan(d) ? "NaN" : d > 0 ? "Infinity" : "-Infinity", after);
	} else if (d == 0) fputs(signbit(d) ? "-0" : "0", out);
	else if (d == floor(d) && fabs(d) < 1e21) fprintf(out, "%.0f", d);
	else {
		char buf[40];
		for (int p = 1; p <= 17; p++) {
			snprintf(buf, sizeof buf, "%.*g", p, d);
			if (strtod(buf, NULL) == d) break;
		}
		fputs(buf, out);
	}
}
static uint64_t bits(const op_value *t, size_t i) {
	size_t z = op_size(t->kind);
	uint64_t u = 0;
	for (size_t j = 0; j < z; j++) u |= (uint64_t)t->data[i * z + j] << (8 * j);
	return u;
}
static void put_elements(FILE *out, const op_value *v) {
	putc('[', out);
	for (size_t i = 0; i < op_length(v); i++) {
		uint64_t u = bits(v, i);
		if (i) putc(',', out);
		switch (v->kind) {
		case OP_INT8: fprintf(out, "%d", (int8_t)u); break;
		case OP_INT16: fprintf(out, "%d", (int16_t)u); break;
		case OP_UINT16: fprintf(out, "%u", (uint16_t)u); break;
		case OP_INT32: fprintf(out, "%d", (int32_t)u); break;
		case OP_UINT32: fprintf(out, "%u", (uint32_t)u); break;
		case OP_INT64: fprintf(out, "\"%lld\"", (long long)(int64_t)u); break;
		case OP_UINT64: fprintf(out, "\"%llu\"", (unsigned long long)u); break;
		case OP_FLOAT32: {
			uint32_t b = (uint32_t)u;
			float f;
			memcpy(&f, &b, 4);
			put_number(out, f, "\"", "\"");
			break;
		}
		case OP_FLOAT64: {
			double d;
			memcpy(&d, &u, 8);
			put_number(out, d, "\"", "\"");
			break;
		}
		}
	}
	putc(']', out);
}

void op_json_write(FILE *out, const op_value *v) {
	switch (v->type) {
	case OP_NULL: fputs("null", out); break;
	case OP_BOOL: fputs(v->bool_ ? "true" : "false", out); break;
	case OP_NUM:
		// a whole number past 2^53 - 1: its digits, in the bigint form
		if (v->big != NULL || (isfinite(v->num) && v->num == floor(v->num) && fabs(v->num) > 9007199254740991.0)) {
			unsigned char m[128];
			const unsigned char *at = v->big != NULL ? v->big : m;
			size_t n = v->big != NULL ? v->bigLength : whole_of_double(v->num, m);
			char *digits = grab(3 * n + 3);
			whole_decimal(v->big != NULL ? v->bigNegative : v->num < 0, at, n, digits);
			fprintf(out, "{\"/\":{\"bigint\":\"%s\"}}", digits);
			free(digits);
		} else put_number(out, v->num, "{\"/\":{\"number\":\"", "\"}}");
		break;
	case OP_STR: op_json_string(out, v->str); break;
	case OP_LIST:
		putc('[', out);
		for (size_t i = 0; i < v->count; i++) {
			if (i) putc(',', out);
			op_json_write(out, v->items[i]);
		}
		putc(']', out);
		break;
	case OP_MAP: {
		// a map whose one key is "/" is data, not a form: it is escaped
		int escaped = is_form(v);
		if (escaped) fputs("{\"/\":{\"map\":", out);
		putc('{', out);
		for (size_t i = 0; i < v->count; i++) {
			if (i) putc(',', out);
			op_json_string(out, v->keys[i]);
			putc(':', out);
			op_json_write(out, v->items[i]);
		}
		putc('}', out);
		if (escaped) fputs("}}", out);
		break;
	}
	case OP_STAND:
		fputs("{\"/\":{\"live\":", out);
		op_json_write(out, v->items[0]);
		fputs("}}", out);
		break;
	case OP_BYTES:
		fputs("{\"/\":{\"bytes\":\"", out);
		for (size_t i = 0; i < v->bytes; i += 3) {
			uint32_t acc = (uint32_t)v->data[i] << 16;
			if (i + 1 < v->bytes) acc |= (uint32_t)v->data[i + 1] << 8;
			if (i + 2 < v->bytes) acc |= v->data[i + 2];
			size_t n = v->bytes - i < 3 ? v->bytes - i + 1 : 4;
			for (size_t j = 0; j < n; j++) putc(b64[(acc >> (18 - 6 * j)) & 63], out);
		}
		fputs("\"}}", out);
		break;
	case OP_TYPED:
		fprintf(out, "{\"/\":{\"%s\":", kinds[v->kind]);
		put_elements(out, v);
		fputs("}}", out);
		break;
	}
}

char *op_json_text(const op_value *v) {
	char *text = NULL;
	size_t size = 0;
	FILE *out = open_memstream(&text, &size);
	if (out == NULL) {
		fputs("op: out of memory\n", stderr);
		abort();
	}
	op_json_write(out, v);
	fclose(out);
	return text;
}
