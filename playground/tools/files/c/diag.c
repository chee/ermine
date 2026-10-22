// diag.c: CBOR's diagnostic notation. See diag.h; the rules are diag.ts's.

#include "diag.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "a typed array's bytes are its elements as the machine holds them: little-endian only"
#endif

// growing text ---------------------------------------------------------------------

typedef struct {
	char *data;
	size_t length;
	size_t capacity;
} Text;

static void put(Text *text, const void *bytes, size_t n) {
	if (text->length + n + 1 > text->capacity) {
		size_t grown = text->capacity ? text->capacity * 2 : 64;
		while (grown < text->length + n + 1) grown *= 2;
		text->data = realloc(text->data, grown);
		if (!text->data) abort();
		text->capacity = grown;
	}
	if (n) memcpy(text->data + text->length, bytes, n);
	text->length += n;
	text->data[text->length] = 0;
}

static void putText(Text *text, const char *s) {
	put(text, s, strlen(s));
}

// writing --------------------------------------------------------------------------

/** a stand-in's tag (ENCODING.tex) */
#define STAND 0x12345678u

/** a typed array's tag (RFC 8746), by kind; no uint8, so never 64 */
static const unsigned kindTags[JSON_KINDS] = { 72, 77, 69, 78, 70, 79, 71, 85, 86 };

/** the shortest decimal that reads back as x, with a point or an exponent, as Number#toString and diag.ts have it */
static void decimal(Text *out, double x) {
	if (isnan(x) || isinf(x) || x == 0) {
		putText(out, isnan(x) ? "NaN" : isinf(x) ? (x < 0 ? "-Infinity" : "Infinity") : "0.0"); // zero has no sign
		return;
	}
	char buffer[40];
	int precision;
	// the fewest digits that read back: %e rounds right at each length
	for (precision = 0; precision < 16; precision++) {
		snprintf(buffer, sizeof buffer, "%.*e", precision, x);
		if (strtod(buffer, NULL) == x) break;
	}
	if (precision == 16) snprintf(buffer, sizeof buffer, "%.16e", x);
	// [-]d[.ddd]e[+-]xx: the digits, and where the point goes
	char digits[20];
	int k = 0;
	const char *c = buffer;
	if (*c == '-') c++;
	for (; *c && *c != 'e'; c++)
		if (*c != '.') digits[k++] = *c;
	int n = atoi(c + 1) + 1; // the value is 0.digits * 10^n
	while (k > 1 && digits[k - 1] == '0') k--;
	Text s = { NULL, 0, 0 };
	if (x < 0) put(&s, "-", 1);
	if (k <= n && n <= 21) {
		put(&s, digits, (size_t)k);
		for (int i = k; i < n; i++) put(&s, "0", 1);
	} else if (0 < n && n <= 21) {
		put(&s, digits, (size_t)n);
		put(&s, ".", 1);
		put(&s, digits + n, (size_t)(k - n));
	} else if (-6 < n && n <= 0) {
		put(&s, "0.", 2);
		for (int i = 0; i < -n; i++) put(&s, "0", 1);
		put(&s, digits, (size_t)k);
	} else {
		char exponent[16];
		put(&s, digits, 1);
		if (k > 1) {
			put(&s, ".", 1);
			put(&s, digits + 1, (size_t)(k - 1));
		}
		snprintf(exponent, sizeof exponent, "e%c%d", n - 1 < 0 ? '-' : '+', abs(n - 1));
		putText(&s, exponent);
	}
	put(out, s.data, s.length);
	if (!strpbrk(s.data, ".e")) put(out, ".0", 2);
	free(s.data);
}

static void hex(Text *out, const unsigned char *bytes, size_t n) {
	static const char digits[] = "0123456789abcdef";
	put(out, "h'", 2);
	for (size_t i = 0; i < n; i++) {
		char two[2] = { digits[bytes[i] >> 4], digits[bytes[i] & 15] };
		put(out, two, 2);
	}
	put(out, "'", 1);
}

static void quote(Text *out, const char *s, size_t n) {
	put(out, "\"", 1);
	for (size_t i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		const char *escape = c == '"' ? "\\\"" : c == '\\' ? "\\\\" : c == '\b' ? "\\b" : c == '\f' ? "\\f" : c == '\n' ? "\\n" : c == '\r' ? "\\r" : c == '\t' ? "\\t" : NULL;
		if (escape) {
			putText(out, escape);
		} else if (c == 0xc0 && i + 1 < n && (unsigned char)s[i + 1] == 0x80) { // U+0000, as json.h holds it
			putText(out, "\\u0000");
			i++;
		} else if (c < 0x20 || c == 0x7f) {
			char u[8];
			snprintf(u, sizeof u, "\\u%04x", c);
			putText(out, u);
		} else {
			put(out, &c, 1);
		}
	}
	put(out, "\"", 1);
}

/** a typed array's elements as bytes, each NaN the one NaN of its width */
static unsigned char *elements(const Json *x, size_t *n) {
	size_t size = jsonKindSize(x->typed.kind);
	*n = x->typed.count * size;
	unsigned char *bytes = allocate(*n);
	if (*n) memcpy(bytes, x->typed.data, *n);
	for (size_t i = 0; x->typed.kind >= JSON_FLOAT32 && i < x->typed.count; i++) {
		if (size == 4) {
			float f;
			memcpy(&f, bytes + i * 4, 4);
			if (isnan(f)) memcpy(bytes + i * 4, &(uint32_t){ 0x7fc00000 }, 4);
		} else {
			double d;
			memcpy(&d, bytes + i * 8, 8);
			if (isnan(d)) memcpy(bytes + i * 8, &(uint64_t){ 0x7ff8000000000000 }, 8);
		}
	}
	return bytes;
}

typedef struct {
	const char *key;
	size_t length;
	const Json *value;
} Entry;

static int byKey(const void *a, const void *b) {
	const Entry *x = a, *y = b;
	return utf8Compare(x->key, x->length, y->key, y->length);
}

/** a string or key a lone surrogate would make no value */
static bool whole(const char *s, size_t n, const char **why) {
	if (!utf8Surrogate(s, n)) return true;
	if (why) *why = "a string with a lone surrogate";
	return false;
}

static bool show(Text *out, const Json *x, int indent, const char **why) {
	switch (x->type) {
		case JSON_NULL: putText(out, "null"); return true;
		case JSON_BOOLEAN: putText(out, x->boolean ? "true" : "false"); return true;
		case JSON_NUMBER: decimal(out, x->number); return true;
		case JSON_STRING:
			if (!whole(x->string, x->stringLength, why)) return false;
			quote(out, x->string, x->stringLength);
			return true;
		case JSON_BYTES: hex(out, x->bytes.data, x->bytes.length); return true;
		case JSON_TYPED: {
			size_t n;
			unsigned char *bytes = elements(x, &n);
			char tag[8];
			snprintf(tag, sizeof tag, "%u(", kindTags[x->typed.kind]);
			putText(out, tag);
			hex(out, bytes, n);
			put(out, ")", 1);
			free(bytes);
			return true;
		}
		case JSON_STAND: {
			// its tag (ENCODING.tex) on its kind
			char tag[16];
			snprintf(tag, sizeof tag, "%u(", STAND);
			putText(out, tag);
			if (x->stand.kind == NULL) putText(out, "null");
			else if (!show(out, x->stand.kind, indent, why)) return false;
			put(out, ")", 1);
			return true;
		}
		case JSON_ARRAY:
			if (x->array.count == 0) {
				putText(out, "[]");
				return true;
			}
			putText(out, "[\n");
			for (int i = 0; i < x->array.count; i++) {
				for (int j = 0; j <= indent; j++) putText(out, "  ");
				if (!show(out, x->array.items[i], indent + 1, why)) return false;
				putText(out, i + 1 < x->array.count ? ",\n" : "\n");
			}
			break;
		case JSON_OBJECT: {
			int count = x->object.count;
			if (count == 0) {
				putText(out, "{}");
				return true;
			}
			Entry *entries = allocate((size_t)count * sizeof *entries);
			for (int i = 0; i < count; i++) {
				const JsonMember *m = &x->object.members[i];
				entries[i] = (Entry){ m->key, m->keyLength, m->value };
			}
			qsort(entries, (size_t)count, sizeof *entries, byKey);
			putText(out, "{\n");
			bool ok = true;
			for (int i = 0; ok && i < count; i++) {
				for (int j = 0; j <= indent; j++) putText(out, "  ");
				ok = whole(entries[i].key, entries[i].length, why);
				if (ok) {
					quote(out, entries[i].key, entries[i].length);
					putText(out, ": ");
					ok = show(out, entries[i].value, indent + 1, why);
				}
				if (ok) putText(out, i + 1 < count ? ",\n" : "\n");
			}
			free(entries);
			if (!ok) return false;
			break;
		}
	}
	for (int j = 0; j < indent; j++) putText(out, "  ");
	put(out, x->type == JSON_ARRAY ? "]" : "}", 1);
	return true;
}

char *diag_write(const Json *value, const char **why) {
	Text out = { NULL, 0, 0 };
	put(&out, "", 0);
	if (!show(&out, value, 0, why)) {
		free(out.data);
		return NULL;
	}
	return out.data;
}

// reading --------------------------------------------------------------------------

#define DEPTH 4096

typedef struct {
	const char *t;
	size_t n;
	size_t at;
	const char *why;
	size_t failed; // where the fault is
	int depth;
} Reader;

/** false, noting the fault; the callers return it or NULL */
static bool fail(Reader *r, const char *why, size_t at) {
	if (!r->why) {
		r->why = why;
		r->failed = at;
	}
	return false;
}

static bool isDigit(int c) {
	return c >= '0' && c <= '9';
}

static bool isHex(int c) {
	return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

static bool isLetter(int c) {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/** the byte at the reader plus k, or -1 past the end */
static int peek(const Reader *r, size_t k) {
	return r->at + k < r->n ? (unsigned char)r->t[r->at + k] : -1;
}

/** skips spacing and comments, / to / */
static bool space(Reader *r) {
	while (r->at < r->n) {
		char c = r->t[r->at];
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
			r->at++;
		} else if (c == '/') {
			const char *end = memchr(r->t + r->at + 1, '/', r->n - r->at - 1);
			if (!end) return fail(r, "a comment with no end", r->at);
			r->at = (size_t)(end - r->t) + 1;
		} else {
			break;
		}
	}
	return true;
}

/** skips an encoding indicator, _0 to _3, or _ alone where open allows it */
static bool indicator(Reader *r, bool open) {
	if (peek(r, 0) != '_') return true;
	int next = peek(r, 1);
	if (next >= '0' && next <= '3') r->at += 2;
	else if (open) r->at++;
	else return fail(r, "an encoding indicator that is not _0 to _3", r->at);
	return true;
}

static Json *value(Reader *r);

/** items up to close, separated by commas, a last comma allowed; item gets the reader and its own state */
static bool items(Reader *r, char close, bool (*item)(Reader *, void *), void *state) {
	if (!space(r)) return false;
	while (peek(r, 0) != close) {
		if (!item(r, state) || !space(r)) return false;
		if (peek(r, 0) == ',') {
			r->at++;
			if (!space(r)) return false;
		} else if (peek(r, 0) != close) {
			return fail(r, close == ']' ? "no , or ] where one should be" : close == '}' ? "no , or } where one should be" : "no , or ) where one should be", r->at);
		}
	}
	r->at++;
	return true;
}

// code points, as the text holds them ------------------------------------------------

/** the code point at s, its length in bytes in *length; C0 80 is U+0000, an invalid byte is U+FFFD */
static uint32_t decode(const char *s, size_t n, size_t *length) {
	unsigned char c = (unsigned char)s[0];
	*length = 1;
	if (c < 0x80) return c;
	if (c == 0xc0 && n > 1 && (unsigned char)s[1] == 0x80) {
		*length = 2;
		return 0;
	}
	size_t need = c >= 0xf0 && c < 0xf8 ? 3 : c >= 0xe0 ? 2 : c >= 0xc2 ? 1 : 0;
	if (c >= 0xf8 || need == 0 || need >= n) return 0xfffd;
	uint32_t cp = c & (0x3f >> need);
	for (size_t i = 1; i <= need; i++) {
		if (((unsigned char)s[i] & 0xc0) != 0x80) return 0xfffd;
		cp = (cp << 6) | ((unsigned char)s[i] & 0x3f);
	}
	*length = need + 1;
	return cp;
}

/** UTF-16 code units, which is what a string is made of until it is whole */
typedef struct {
	uint16_t *items;
	size_t count;
	size_t capacity;
} Units;

static void unit(Units *u, uint16_t x) {
	if (u->count == u->capacity) {
		u->capacity = u->capacity ? u->capacity * 2 : 32;
		u->items = realloc(u->items, u->capacity * sizeof *u->items);
		if (!u->items) abort();
	}
	u->items[u->count++] = x;
}

static void point(Units *u, uint32_t cp) {
	if (cp >= 0x10000) {
		unit(u, (uint16_t)(0xd800 + ((cp - 0x10000) >> 10)));
		unit(u, (uint16_t)(0xdc00 + ((cp - 0x10000) & 0x3ff)));
	} else {
		unit(u, (uint16_t)cp);
	}
}

/** the units as UTF-8, U+0000 as the byte 00; false for a lone surrogate */
static bool utf8Of(const Units *u, Text *out) {
	put(out, "", 0);
	for (size_t i = 0; i < u->count; i++) {
		uint32_t cp = u->items[i];
		if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < u->count && u->items[i + 1] >= 0xdc00 && u->items[i + 1] < 0xe000) {
			cp = 0x10000 + ((cp - 0xd800) << 10) + (u->items[++i] - 0xdc00);
		} else if (cp >= 0xd800 && cp < 0xe000) {
			return false;
		}
		unsigned char b[4];
		size_t n;
		if (cp < 0x80) b[0] = (unsigned char)cp, n = 1;
		else if (cp < 0x800) b[0] = (unsigned char)(0xc0 | cp >> 6), b[1] = (unsigned char)(0x80 | (cp & 0x3f)), n = 2;
		else if (cp < 0x10000) b[0] = (unsigned char)(0xe0 | cp >> 12), b[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3f)), b[2] = (unsigned char)(0x80 | (cp & 0x3f)), n = 3;
		else b[0] = (unsigned char)(0xf0 | cp >> 18), b[1] = (unsigned char)(0x80 | ((cp >> 12) & 0x3f)), b[2] = (unsigned char)(0x80 | ((cp >> 6) & 0x3f)), b[3] = (unsigned char)(0x80 | (cp & 0x3f)), n = 4;
		put(out, b, n);
	}
	return true;
}

/** text as a json.h string: U+0000 held as C0 80 */
static Json *stringOf(const Text *s) {
	Text m = { NULL, 0, 0 };
	put(&m, "", 0);
	for (size_t i = 0; i < s->length; i++) {
		if (s->data[i] == 0) put(&m, "\xc0\x80", 2);
		else put(&m, s->data + i, 1);
	}
	Json *string = jsonStringOfLength(m.data, m.length);
	free(m.data);
	return string;
}

// strings ------------------------------------------------------------------------------

/** a number from 1 to 6 hex digits in braces, or four hex digits, at the reader plus 2: the code point, or -1 */
static long unicode(Reader *r, size_t *end) {
	size_t i = r->at + 2;
	long cp = 0;
	if (i < r->n && r->t[i] == '{') {
		size_t digits = 0;
		for (i++; i < r->n && isHex(r->t[i]) && digits < 7; i++, digits++) cp = cp * 16 + (isDigit(r->t[i]) ? r->t[i] - '0' : (r->t[i] | 32) - 'a' + 10);
		if (digits < 1 || digits > 6 || i >= r->n || r->t[i] != '}') return -1;
		*end = i + 1;
		return cp <= 0x10ffff ? cp : -1;
	}
	for (size_t digits = 0; digits < 4; digits++, i++) {
		if (i >= r->n || !isHex(r->t[i])) return -1;
		cp = cp * 16 + (isDigit(r->t[i]) ? r->t[i] - '0' : (r->t[i] | 32) - 'a' + 10);
	}
	*end = i;
	return cp;
}

static bool escape(Reader *r, Units *u) {
	int e = peek(r, 1);
	const char *from = "\"'\\/bfnrt", *to = "\"'\\/\b\f\n\r\t";
	const char *found = e > 0 ? strchr(from, e) : NULL;
	if (found) {
		unit(u, (uint16_t)to[found - from]);
		r->at += 2;
		return true;
	}
	size_t end;
	if (e == 'u') {
		long cp = unicode(r, &end);
		if (cp >= 0) {
			point(u, (uint32_t)cp);
			r->at = end;
			return true;
		}
	}
	return fail(r, "an escape that means nothing here", r->at);
}

/** a quoted string, q its quote, with JSON's escapes, \' and \u{...}; its UTF-8 in *out (U+0000 as 00) */
static bool string(Reader *r, char q, Text *out) {
	size_t start = r->at;
	Units u = { NULL, 0, 0 };
	r->at++;
	for (;;) {
		if (r->at >= r->n) {
			free(u.items);
			return fail(r, "a string with no end", start);
		}
		char c = r->t[r->at];
		if (c == q) break;
		if (c == '\\') {
			if (!escape(r, &u)) {
				free(u.items);
				return false;
			}
		} else {
			size_t length;
			point(&u, decode(r->t + r->at, r->n - r->at, &length));
			r->at += length;
		}
	}
	r->at++;
	*out = (Text){ NULL, 0, 0 };
	bool ok = utf8Of(&u, out);
	free(u.items);
	if (!ok) {
		free(out->data);
		return fail(r, "a string with a lone surrogate, which is no value", start);
	}
	return true;
}

// bytes ----------------------------------------------------------------------------------

/** h'...', spacing and comments allowed among its digits; the reader is on the quote */
static Json *hexBytes(Reader *r, size_t start) {
	Text digits = { NULL, 0, 0 };
	put(&digits, "", 0);
	r->at++;
	for (;;) {
		if (!space(r)) goto bad;
		if (r->at >= r->n) {
			fail(r, "bytes with no end", start);
			goto bad;
		}
		char c = r->t[r->at];
		if (c == '\'') break;
		if (!isHex(c)) {
			fail(r, "a character that is no hex digit", r->at);
			goto bad;
		}
		put(&digits, &c, 1);
		r->at++;
	}
	r->at++;
	if (digits.length % 2) {
		fail(r, "hex bytes with an odd number of digits", start);
		goto bad;
	}
	unsigned char *bytes = allocate(digits.length / 2);
	for (size_t i = 0; i < digits.length / 2; i++) {
		unsigned x;
		sscanf(digits.data + 2 * i, "%2x", &x);
		bytes[i] = (unsigned char)x;
	}
	Json *result = jsonBytes(bytes, digits.length / 2);
	free(bytes);
	free(digits.data);
	return result;
bad:
	free(digits.data);
	return NULL;
}

/** whether a code point is what JavaScript's \s has: spacing in base64 bytes */
static bool jsSpace(uint32_t cp) {
	return (cp >= 9 && cp <= 13) || cp == ' ' || cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp == 0x2028 || cp == 0x2029 || cp == 0x202f || cp == 0x205f || cp == 0x3000 || cp == 0xfeff;
}

static int base64Digit(int c) {
	const char *digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const char *at = c > 0 ? strchr(digits, c) : NULL;
	return at ? (int)(at - digits) : -1;
}

/** b64'...', base64 or base64url, padded or not, spacing allowed; the reader is on the quote */
static Json *base64Bytes(Reader *r, size_t start) {
	Text digits = { NULL, 0, 0 };
	put(&digits, "", 0);
	r->at++;
	for (;;) {
		if (r->at >= r->n) {
			fail(r, "bytes with no end", start);
			goto bad;
		}
		size_t length;
		uint32_t cp = decode(r->t + r->at, r->n - r->at, &length);
		if (cp == '\'') break;
		if (!jsSpace(cp)) {
			char c = cp == '-' ? '+' : cp == '_' ? '/' : cp < 0x80 ? (char)cp : 0;
			if (!c || (c != '=' && base64Digit(c) < 0)) {
				fail(r, "a character that is no base64", r->at);
				goto bad;
			}
			put(&digits, &c, 1);
		}
		r->at += length;
	}
	r->at++;
	// Uint8Array.fromBase64, loose: whole chunks, a partial last one of 2 or 3 digits or padded
	unsigned char *bytes = allocate(digits.length / 4 * 3 + 3);
	size_t count = 0, chunk = 0, i = 0;
	uint32_t bits = 0;
	for (; i < digits.length; i++) {
		if (digits.data[i] == '=') {
			if (chunk < 2) goto malformed;
			if (chunk == 2) {
				if (i + 1 >= digits.length || digits.data[i + 1] != '=') goto malformed;
				i++;
			}
			if (i + 1 != digits.length) goto malformed;
			break;
		}
		bits = (bits << 6) | (uint32_t)base64Digit(digits.data[i]);
		if (++chunk == 4) {
			bytes[count++] = (unsigned char)(bits >> 16);
			bytes[count++] = (unsigned char)(bits >> 8);
			bytes[count++] = (unsigned char)bits;
			chunk = 0;
			bits = 0;
		}
	}
	if (chunk == 1) goto malformed;
	if (chunk == 2) bytes[count++] = (unsigned char)(bits >> 4);
	if (chunk == 3) {
		bytes[count++] = (unsigned char)(bits >> 10);
		bytes[count++] = (unsigned char)(bits >> 2);
	}
	Json *result = jsonBytes(bytes, count);
	free(bytes);
	free(digits.data);
	return result;
malformed:
	free(bytes);
	fail(r, "base64 bytes that do not decode", start);
bad:
	free(digits.data);
	return NULL;
}

// numbers and tags -----------------------------------------------------------------------

/** an integer in base 8 or 2, or 16 as it is: the nearest double, from the digits at [from, to) */
static double integerOf(const char *digits, size_t count, int base) {
	Text hexText = { NULL, 0, 0 };
	put(&hexText, "0x", 2);
	if (base == 16) {
		put(&hexText, digits, count);
	} else {
		// bits, most significant first, padded to whole hex digits
		size_t per = base == 8 ? 3 : 1, total = count * per, pad = (4 - total % 4) % 4;
		unsigned nibble = 0;
		size_t held = 0;
		for (size_t i = 0; i < pad + total; i++) {
			unsigned bit = 0;
			if (i >= pad) {
				size_t j = i - pad, d = (unsigned)(digits[j / per] - '0');
				bit = (d >> (per - 1 - j % per)) & 1;
			}
			nibble = nibble * 2 + bit;
			if (++held == 4) {
				char c = "0123456789abcdef"[nibble];
				put(&hexText, &c, 1);
				nibble = 0;
				held = 0;
			}
		}
	}
	double x = strtod(hexText.data, NULL);
	free(hexText.data);
	return x;
}

static Json *tag(Reader *r, double number, size_t start) {
	int kind = -1;
	for (int i = 0; i < JSON_KINDS; i++)
		if (number == kindTags[i]) kind = i;
	if (kind < 0 && number != STAND) {
		fail(r, "a tag that is not a typed array's or a stand-in's", start);
		return NULL;
	}
	r->at++; // the (
	if (!space(r)) return NULL;
	size_t at = r->at;
	Json *bytes = value(r);
	if (!bytes) return NULL;
	if (!space(r)) goto bad;
	if (peek(r, 0) != ')') {
		fail(r, "no ) where one should be", r->at);
		goto bad;
	}
	r->at++;
	if (kind < 0) return jsonStand(bytes);
	if (bytes->type != JSON_BYTES) {
		fail(r, "a typed array's tag over what is not bytes", at);
		goto bad;
	}
	size_t size = jsonKindSize((JsonKind)kind);
	if (bytes->bytes.length % size) {
		fail(r, "a typed array's bytes that are not whole elements", start);
		goto bad;
	}
	size_t count = bytes->bytes.length / size;
	void *data = allocate(bytes->bytes.length);
	if (count) memcpy(data, bytes->bytes.data, bytes->bytes.length);
	for (size_t i = 0; kind >= JSON_FLOAT32 && i < count; i++) {
		if (size == 4) {
			float f;
			memcpy(&f, (char *)data + i * 4, 4);
			if (isnan(f)) memcpy((char *)data + i * 4, &(uint32_t){ 0x7fc00000 }, 4);
		} else {
			double d;
			memcpy(&d, (char *)data + i * 8, 8);
			if (isnan(d)) memcpy((char *)data + i * 8, &(uint64_t){ 0x7ff8000000000000 }, 8);
		}
	}
	Json *typed = jsonTyped((JsonKind)kind, data, count);
	free(data);
	jsonFree(bytes);
	return typed;
bad:
	jsonFree(bytes);
	return NULL;
}

static Json *number(Reader *r) {
	size_t start = r->at, p = start;
	bool negative = r->t[p] == '-';
	if (negative) p++;
	int base = 10;
	size_t from = p, end = p;
	int c1 = p + 1 < r->n ? (unsigned char)r->t[p + 1] : -1, c2 = p + 2 < r->n ? (unsigned char)r->t[p + 2] : -1;
	if (p < r->n && r->t[p] == '0' && (c1 | 32) == 'x' && c2 >= 0 && isHex(c2)) {
		base = 16, from = p + 2;
		for (end = from; end < r->n && isHex(r->t[end]); end++) {}
	} else if (p < r->n && r->t[p] == '0' && (c1 | 32) == 'o' && c2 >= '0' && c2 <= '7') {
		base = 8, from = p + 2;
		for (end = from; end < r->n && r->t[end] >= '0' && r->t[end] <= '7'; end++) {}
	} else if (p < r->n && r->t[p] == '0' && (c1 | 32) == 'b' && (c2 == '0' || c2 == '1')) {
		base = 2, from = p + 2;
		for (end = from; end < r->n && (r->t[end] == '0' || r->t[end] == '1'); end++) {}
	} else {
		if (!(p < r->n && isDigit((unsigned char)r->t[p]))) {
			fail(r, "a - with no number after it", start);
			return NULL;
		}
		for (end = p; end < r->n && isDigit((unsigned char)r->t[end]); end++) {}
		bool decimal = false;
		if (end + 1 < r->n && r->t[end] == '.' && isDigit((unsigned char)r->t[end + 1])) {
			for (end++; end < r->n && isDigit((unsigned char)r->t[end]); end++) {}
			decimal = true;
		}
		size_t e = end + 1;
		if ((e <= r->n) && end < r->n && (r->t[end] | 32) == 'e') {
			if (e < r->n && (r->t[e] == '+' || r->t[e] == '-')) e++;
			if (e < r->n && isDigit((unsigned char)r->t[e])) {
				for (; e < r->n && isDigit((unsigned char)r->t[e]); e++) {}
				end = e;
				decimal = true;
			}
		}
		if (decimal) {
			char *copy = copyStringOfLength(r->t + start, end - start);
			double x = strtod(copy, NULL);
			free(copy);
			r->at = end;
			if (!indicator(r, false)) return NULL;
			return jsonNumber(x == 0 ? 0.0 : x); // zero has no sign: -0.0 is 0
		}
	}
	r->at = end;
	double x;
	if (base == 10) {
		char *copy = copyStringOfLength(r->t + from, end - from);
		x = strtod(copy, NULL);
		free(copy);
	} else {
		x = integerOf(r->t + from, end - from, base);
	}
	if (!indicator(r, false)) return NULL;
	if (!negative) {
		size_t after = r->at;
		if (!space(r)) return NULL;
		if (peek(r, 0) == '(') return tag(r, x, start);
		r->at = after;
		return jsonNumber(x);
	}
	return jsonNumber(x == 0 ? 0.0 : -x); // zero has no sign: -0 is 0
}

// values ---------------------------------------------------------------------------------

static bool pushItem(Reader *r, void *state) {
	Json *item = value(r);
	if (!item) return false;
	jsonPush(state, item);
	return true;
}

static Json *list(Reader *r) {
	r->at++;
	if (!indicator(r, true)) return NULL;
	Json *array = jsonArray();
	if (!items(r, ']', pushItem, array)) {
		jsonFree(array);
		return NULL;
	}
	return array;
}

static bool addMember(Reader *r, void *state) {
	size_t at = r->at;
	Json *key = value(r);
	if (!key) return false;
	if (key->type != JSON_STRING) {
		jsonFree(key);
		return fail(r, "a key that is not text", at);
	}
	if (jsonGetOfLength(state, key->string, key->stringLength)) {
		jsonFree(key);
		return fail(r, "a key twice", at);
	}
	Json *entry = NULL;
	if (!space(r)) goto bad;
	if (peek(r, 0) != ':') {
		fail(r, "no : where one should be", r->at);
		goto bad;
	}
	r->at++;
	if (!space(r)) goto bad;
	entry = value(r);
	if (!entry) goto bad;
	jsonAddOfLength(state, key->string, key->stringLength, entry);
	jsonFree(key);
	return true;
bad:
	jsonFree(key);
	return false;
}

static Json *map(Reader *r) {
	r->at++;
	if (!indicator(r, true)) return NULL;
	Json *object = jsonObject();
	if (!items(r, '}', addMember, object)) {
		jsonFree(object);
		return NULL;
	}
	return object;
}

typedef struct {
	int kind; // 0: no chunk yet, 1: text, 2: bytes
	Text all;
} Chunks;

static bool addChunk(Reader *r, void *state) {
	Chunks *chunks = state;
	size_t at = r->at;
	if (peek(r, 0) == '(') return fail(r, "chunks inside chunks", at);
	Json *part = value(r);
	if (!part) return false;
	int kind = part->type == JSON_STRING ? 1 : part->type == JSON_BYTES ? 2 : 0;
	if (!kind) {
		jsonFree(part);
		return fail(r, "a chunk that is not text or bytes", at);
	}
	if (chunks->kind && chunks->kind != kind) {
		jsonFree(part);
		return fail(r, "text and bytes chunks together", at);
	}
	chunks->kind = kind;
	if (kind == 1) put(&chunks->all, part->string, part->stringLength);
	else put(&chunks->all, part->bytes.data, part->bytes.length);
	jsonFree(part);
	return true;
}

/** an indefinite-length string, (_ chunk, ...), all text or all bytes */
static Json *chunks(Reader *r) {
	size_t start = r->at;
	r->at++;
	if (peek(r, 0) != '_') {
		fail(r, "a ( that does not start (_", start);
		return NULL;
	}
	r->at++;
	Chunks state = { 0, { NULL, 0, 0 } };
	put(&state.all, "", 0);
	Json *result = NULL;
	if (!items(r, ')', addChunk, &state)) {
		// the fault stands
	} else if (state.kind == 0) {
		fail(r, "(_ ) with no chunks; write \"\"_ or ''_", start);
	} else {
		result = state.kind == 1 ? jsonStringOfLength(state.all.data, state.all.length) : jsonBytes(state.all.data, state.all.length);
	}
	free(state.all.data);
	return result;
}

static Json *word(Reader *r) {
	size_t start = r->at, end = start + 1;
	while (end < r->n && (isLetter((unsigned char)r->t[end]) || isDigit((unsigned char)r->t[end]))) end++;
	size_t length = end - start;
	const char *w = r->t + start;
	r->at = end;
	#define IS(s) (length == sizeof(s) - 1 && memcmp(w, s, length) == 0)
	if (peek(r, 0) == '\'') {
		if (!IS("h") && !IS("b64")) {
			fail(r, "bytes as other than h'', b64'' or ''", start);
			return NULL;
		}
		Json *bytes = IS("h") ? hexBytes(r, start) : base64Bytes(r, start);
		if (bytes && !indicator(r, bytes->bytes.length == 0)) {
			jsonFree(bytes);
			return NULL;
		}
		return bytes;
	}
	Json *x = NULL;
	if (IS("false")) return jsonBoolean(false);
	if (IS("true")) return jsonBoolean(true);
	if (IS("null")) return jsonNull();
	if (IS("NaN")) x = jsonNumber(NAN);
	if (IS("Infinity")) x = jsonNumber(INFINITY);
	if (x) {
		if (!indicator(r, false)) {
			jsonFree(x);
			return NULL;
		}
		return x;
	}
	fail(r, IS("undefined") ? "undefined, which is no value" : IS("simple") ? "a simple value other than false, true and null" : "a word that is no value", start);
	#undef IS
	return NULL;
}

static Json *quoted(Reader *r, char q) {
	Text s;
	if (!string(r, q, &s)) return NULL;
	Json *result;
	if (q == '"') result = stringOf(&s);
	else result = jsonBytes(s.data, s.length);
	bool empty = s.length == 0;
	free(s.data);
	if (!indicator(r, empty)) {
		jsonFree(result);
		return NULL;
	}
	return result;
}

static Json *value(Reader *r) {
	size_t start = r->at;
	if (start >= r->n) {
		fail(r, "the end where a value should be", start);
		return NULL;
	}
	if (++r->depth > DEPTH) {
		r->depth--;
		fail(r, "a value nested too deep", r->at);
		return NULL;
	}
	int c = (unsigned char)r->t[start];
	Json *x;
	if (c == '[') x = list(r);
	else if (c == '{') x = map(r);
	else if (c == '(') x = chunks(r);
	else if (c == '"' || c == '\'') x = quoted(r, (char)c);
	else if (c == '-' && r->n - start >= 9 && memcmp(r->t + start, "-Infinity", 9) == 0) {
		r->at += 9;
		x = indicator(r, false) ? jsonNumber(-INFINITY) : NULL;
	} else if (c == '-' || isDigit(c)) x = number(r);
	else if (isLetter(c)) x = word(r);
	else {
		fail(r, "a character that starts no value", start);
		x = NULL;
	}
	r->depth--;
	return x;
}

Json *diag_read(const char *text, size_t length, diag_error *error) {
	Reader r = { text, length, 0, NULL, 0, 0 };
	Json *x = NULL;
	if (space(&r) && (x = value(&r)) != NULL) {
		if (!space(&r)) {
			jsonFree(x);
			x = NULL;
		} else if (r.at < length) {
			jsonFree(x);
			x = NULL;
			fail(&r, "more after the value", r.at);
		}
	}
	if (x) return x;
	// the fault's place: UTF-16 code units from the start, and the line and column from 1
	size_t units = 0, line = 1, newline = (size_t)-1; // newline: the unit index of the last \n, -1 for none
	for (size_t i = 0; i < r.failed && i < length; i++) {
		unsigned char b = (unsigned char)text[i];
		if ((b & 0xc0) == 0x80) continue; // inside a character
		if (b == '\n') line++, newline = units;
		units += b >= 0xf0 ? 2 : 1;
	}
	error->at = units;
	error->line = line;
	error->column = units - (newline + 1) + 1;
	error->why = r.why;
	return NULL;
}
