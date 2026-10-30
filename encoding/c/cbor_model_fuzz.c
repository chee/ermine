// libFuzzer target (fuzz.sh cbor-model): builds a value from the input bytes (odd numbers, strings,
// lone surrogates, NaN payloads, repeated keys, deep nesting) and encodes it. Encoding must be
// refused exactly when the model says so. Otherwise decoding must give an equal value, with the
// same bytes again, also with map keys reversed and into a growing buffer. Numbers alone are
// checked against the model of the shortest encoding.
#include "cbor.h"

#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

typedef struct {
	const unsigned char *data;
	size_t size, at;
} Bytes;

static unsigned byte(Bytes *b) {
	return b->at < b->size ? b->data[b->at++] : 0;
}

static uint64_t bits(Bytes *b, int n) {
	uint64_t x = 0;
	for (int i = 0; i < n; i++) x = x << 8 | byte(b);
	return x;
}

// pieces of text: UTF-8 of one to four bytes, U+0000 as json.h holds it, lone surrogates, a
// surrogate pair as two WTF-8 halves (not a string), and non-UTF-8 bytes
static const char *const pieces[] = {
	"a", "\xc3\xa9", "\xe4\xb8\xad", "\xf0\x9f\x98\x80", "\xf0\x9f\x91\x8d\xf0\x9f\x8f\xbd", "\xc0\x80",
	"\xef\xbf\xbf", "\x7f", "\xc2\x80", "\xdf\xbf", "\xe0\xa0\x80", "\xf4\x8f\xbf\xbf",
	"\xed\xa0\xbd", "\xed\xb8\x80", "\xed\xa0\x80", "\xed\xb0\x80", "\xed\xa0\xbd\xed\xb8\x80", "\xff",
	"\xc1\xbf", "\xe0\x80\x80", "\xf4\x90\x80\x80", "\x80", "\xc3",
};
#define GOOD_PIECES 12
#define PIECES (sizeof pieces / sizeof *pieces)

static const char *const keys[] = { "", "a", "b", "0", "10", "01", "__proto__", "/", "\xc0\x80", "a\xc0\x80", "\xef\xbf\xbf" "a", "\xf0\x9f\x98\x80" };
#define KEYS (sizeof keys / sizeof *keys)

static bool utf8(const unsigned char *s, size_t n) {
	for (size_t i = 0; i < n;) {
		unsigned c = s[i], more = c < 0x80 ? 0 : c >> 5 == 6 ? 1 : c >> 4 == 14 ? 2 : c >> 3 == 30 ? 3 : 9;
		if (more == 9 || n - i <= more) return false;
		if (c == 0xc0 && more == 1 && s[i + 1] == 0x80) {
			i += 2;
			continue;
		}
		uint32_t code = more ? c & (0x3f >> more) : c;
		for (unsigned k = 1; k <= more; k++) {
			if ((s[i + k] & 0xc0) != 0x80) return false;
			code = code << 6 | (s[i + k] & 0x3f);
		}
		static const uint32_t least[] = { 0, 0x80, 0x800, 0x10000 };
		if (code < least[more] || code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) return false;
		i += more + 1;
	}
	return true;
}

static char *text(Bytes *b, size_t *length, bool *good) {
	char buf[256];
	size_t n = 0;
	*good = true;
	unsigned count = byte(b) % 8;
	if (count == 7) count = 40 + byte(b) % 20; // longer: past 23 and 255 bytes, heads grow
	for (unsigned i = 0; i < count; i++) {
		unsigned k = byte(b) % (byte(b) % 4 ? GOOD_PIECES : PIECES);
		size_t m = strlen(pieces[k]);
		if (n + m >= sizeof buf) break;
		memcpy(buf + n, pieces[k], m);
		n += m;
	}
	*good = utf8((const unsigned char *)buf, n);
	*length = n;
	return copyStringOfLength(buf, n);
}

static double number(Bytes *b) {
	switch (byte(b) % 5) {
		case 0: {
			uint64_t x = bits(b, 8);
			double d;
			memcpy(&d, &x, 8);
			return d;
		}
		case 1: {
			uint32_t x = (uint32_t)bits(b, 4);
			float f;
			memcpy(&f, &x, 4);
			return f;
		}
		case 2: {
			uint16_t x = (uint16_t)bits(b, 2);
			_Float16 h;
			memcpy(&h, &x, 2);
			return (double)h;
		}
		case 3: {
			static const double edges[] = { 0, -0.0, 1, -1, 65504, 65505, 65520, 0x1p-24, 0x1p-25, 0x1p-14,
				0x1p-149, 0x1p-150, 0x1p-1074, 0x1p53, 0x1p53 + 2, 0x1p64, -0x1p64, 0x1p63, -0x1p63, 1e300, FLT_MAX, DBL_MAX, 0.1,
				INFINITY, -INFINITY, NAN };
			return edges[byte(b) % (sizeof edges / sizeof *edges)];
		}
		default: return (double)(int32_t)bits(b, 4) * ldexp(1, (int)(byte(b) % 80) - 40);
	}
}

typedef struct {
	bool good;
} Model;

static int plainCompare(const char *a, size_t al, const char *b, size_t bl);

static Json *make(Bytes *b, int depth, Model *m) {
	unsigned k = byte(b) % (depth > 6 ? 7 : 10);
	switch (k) {
		case 0: return byte(b) % 3 ? jsonBoolean(byte(b) & 1) : jsonNull();
		case 1: return jsonNumber(number(b));
		case 2: {
			bool negative = byte(b) & 1;
			unsigned char d[20];
			size_t n = byte(b) % sizeof d;
			for (size_t i = 0; i < n; i++) d[i] = (unsigned char)byte(b);
			return jsonWhole(negative, d, n);
		}
		case 3: {
			size_t n;
			bool good;
			char *s = text(b, &n, &good);
			if (!good) m->good = false;
			return jsonStringTaking(s, n);
		}
		case 4: {
			unsigned char d[300];
			size_t n = byte(b) % 4 == 0 ? 256 + byte(b) % 40 : byte(b) % 30;
			for (size_t i = 0; i < n; i++) d[i] = (unsigned char)byte(b);
			return jsonBytes(d, n);
		}
		case 5: {
			JsonKind kind = (JsonKind)(byte(b) % JSON_KINDS);
			size_t size = jsonKindSize(kind), count = byte(b) % 6;
			unsigned char d[6 * 8];
			for (size_t i = 0; i < count * size; i++) d[i] = (unsigned char)byte(b);
			return jsonTyped(kind, d, count);
		}
		case 6: {
			if (byte(b) % 8) return jsonNull();
			int n = CBOR_DEPTH - 2 + (int)(byte(b) % 5) - depth;
			Json *v = jsonNull();
			for (int i = 0; i < n; i++) {
				Json *c = jsonArray();
				jsonPush(c, v);
				v = c;
			}
			if (depth + n > CBOR_DEPTH) m->good = false;
			return v;
		}
		case 7: {
			Json *l = jsonArray();
			for (unsigned n = byte(b) % 5; n > 0; n--) jsonPush(l, make(b, depth + 1, m));
			return l;
		}
		case 8: {
			Json *o = jsonObject();
			unsigned n = byte(b) % 4 == 0 ? 17 + byte(b) % 20 : byte(b) % 6;
			for (unsigned i = 0; i < n; i++) {
				size_t length;
				bool good = true;
				char *key;
				if (byte(b) % 2) key = copyString(keys[byte(b) % KEYS]), length = strlen(key);
				else key = text(b, &length, &good);
				if (!good) m->good = false;
				for (int j = 0; j < o->object.count; j++) {
					JsonMember *x = &o->object.members[j];
					if (plainCompare(x->key, x->keyLength, key, length) == 0) m->good = false;
				}
				jsonAddTaking(o, key, length, make(b, depth + 1, m));
			}
			return o;
		}
		default: return jsonStand(make(b, depth + 1, m));
	}
}

static int plainCompare(const char *a, size_t al, const char *b, size_t bl) {
	size_t i = 0, j = 0;
	while (i < al && j < bl) {
		unsigned x = (unsigned char)a[i++], y = (unsigned char)b[j++];
		if (x == 0xc0 && i < al && (unsigned char)a[i] == 0x80) x = 0, i++;
		if (y == 0xc0 && j < bl && (unsigned char)b[j] == 0x80) y = 0, j++;
		if (x != y) return x < y ? -1 : 1;
	}
	return (i < al) - (j < bl);
}

static Json *reversed(const Json *v) {
	if (v->type == JSON_ARRAY) {
		Json *l = jsonArray();
		for (int i = 0; i < v->array.count; i++) jsonPush(l, reversed(v->array.items[i]));
		return l;
	}
	if (v->type == JSON_OBJECT) {
		Json *o = jsonObject();
		for (int i = v->object.count - 1; i >= 0; i--) {
			const JsonMember *x = &v->object.members[i];
			jsonAddOfLength(o, x->key, x->keyLength, reversed(x->value));
		}
		return o;
	}
	if (v->type == JSON_STAND) return jsonStand(reversed(v->stand.kind));
	return jsonRef((Json *)v);
}

static unsigned char *encoded(const Json *v, size_t *length, bool *ok) {
	const char *why;
	*ok = cborEncode(v, NULL, 0, length, &why);
	if (!*ok) {
		CborOut refused = { NULL, 0, 0, true };
		if (cborPut(&refused, v, &why)) die("a buffer that grows takes what has no encoding");
		free(refused.data);
		return NULL;
	}
	unsigned char *out = malloc(*length + 1);
	size_t again;
	if (!cborEncode(v, out, *length, &again, &why) || again != *length) die("encoding twice differs");
	CborOut grown = { NULL, 0, 0, true };
	if (!cborPut(&grown, v, &why) || grown.length != *length || memcmp(grown.data, out, *length) != 0) die("a buffer that grows, other bytes");
	free(grown.data);
	return out;
}

// a whole number's bytes: n = (negative ? -1 - a : a), a the argument, big-endian bytes m (no
// leading zero) of a; a head when they fit 64 bits, else tag 2 or 3 over them
static void modelWhole(bool negative, const unsigned char *a, size_t n, unsigned char *out, size_t *length) {
	unsigned major = negative ? 0x20 : 0;
	if (n <= 8) {
		uint64_t u = 0;
		for (size_t i = 0; i < n; i++) u = u << 8 | a[i];
		int w = u < 24 ? 0 : u <= 0xff ? 1 : u <= 0xffff ? 2 : u <= 0xffffffffu ? 4 : 8;
		out[0] = (unsigned char)(major | (w == 0 ? (unsigned)u : w == 1 ? 24u : w == 2 ? 25u : w == 4 ? 26u : 27u));
		for (int i = 0; i < w; i++) out[1 + i] = (unsigned char)(u >> (8 * (w - 1 - i)));
		*length = 1 + (size_t)w;
		return;
	}
	out[0] = negative ? 0xc3 : 0xc2;
	size_t h;
	if (n < 24) out[1] = (unsigned char)(0x40 | n), h = 2;
	else out[1] = 0x58, out[2] = (unsigned char)n, h = 3;
	memcpy(out + h, a, n);
	*length = h + n;
}

static size_t argument(double x, unsigned char *a) {
	unsigned char rev[160];
	size_t n = 0;
	long double m = fabsl((long double)x);
	while (m >= 1) {
		long double q = floorl(m / 256);
		rev[n++] = (unsigned char)(m - q * 256);
		m = q;
	}
	if (x < 0) {
		for (size_t i = 0; i < n; i++) {
			if (rev[i]--) break;
		}
	}
	while (n && !rev[n - 1]) n--;
	for (size_t i = 0; i < n; i++) a[i] = rev[n - 1 - i];
	return n;
}

static void model(double x, unsigned char *out, size_t *length) {
	if (isfinite(x) && floor(x) == x) {
		unsigned char a[160];
		size_t n = argument(x, a);
		modelWhole(x < 0, a, n, out, length);
		return;
	}
	if (isnan(x)) {
		out[0] = 0xf9, out[1] = 0x7e, out[2] = 0, *length = 3;
		return;
	}
	if (fabs(x) <= 65504 || isinf(x)) {
		_Float16 h = (_Float16)x;
		if ((double)h == x && signbit((double)h) == signbit(x)) {
			uint16_t u;
			memcpy(&u, &h, 2);
			out[0] = 0xf9, out[1] = (unsigned char)(u >> 8), out[2] = (unsigned char)u, *length = 3;
			return;
		}
	}
	if (fabs(x) <= FLT_MAX) {
		float f = (float)x;
		if ((double)f == x) {
			uint32_t u;
			memcpy(&u, &f, 4);
			out[0] = 0xfa;
			for (int i = 0; i < 4; i++) out[1 + i] = (unsigned char)(u >> (24 - 8 * i));
			*length = 5;
			return;
		}
	}
	uint64_t u;
	memcpy(&u, &x, 8);
	out[0] = 0xfb;
	for (int i = 0; i < 8; i++) out[1 + i] = (unsigned char)(u >> (56 - 8 * i));
	*length = 9;
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	Bytes b = { data, size, 0 };
	{
		double x = number(&b);
		Json *n = jsonNumber(x);
		size_t length, want;
		bool ok;
		unsigned char *out = encoded(n, &length, &ok), shortest[200];
		model(x, shortest, &want);
		if (!ok || length != want || memcmp(out, shortest, want) != 0) die("a number not the integer or its shortest float");
		free(out);
		jsonFree(n);
	}
	{
		bool negative = byte(&b) & 1;
		unsigned char m[24];
		size_t k = byte(&b) % sizeof m;
		for (size_t i = 0; i < k; i++) m[i] = (unsigned char)byte(&b);
		Json *n = jsonWhole(negative, m, k);
		unsigned char a[25];
		size_t i = 0, an;
		while (i < k && !m[i]) i++;
		an = k - i;
		memcpy(a, m + i, an);
		if (negative && an) {
			for (size_t j = an; j-- > 0;) {
				if (a[j]--) break;
			}
			size_t z = 0;
			while (z < an && !a[z]) z++;
			memmove(a, a + z, an - z), an -= z;
		}
		size_t length, want;
		bool ok;
		unsigned char *out = encoded(n, &length, &ok), model2[40];
		modelWhole(negative && k > i, a, an, model2, &want);
		if (!ok || length != want || memcmp(out, model2, want) != 0) die("a whole number not as modelled");
		Json *back = cborDecode(out, length, NULL, NULL);
		if (!back || !jsonEqual(back, n)) die("a whole number read back another");
		jsonFree(back);
		free(out);
		jsonFree(n);
	}
	Model m = { true };
	Json *v = make(&b, 0, &m);
	size_t length;
	bool ok;
	unsigned char *out = encoded(v, &length, &ok);
	if (ok != m.good) die(ok ? "taken, and the model says no encoding" : "refused, and the model says it has one");
	if (ok) {
		const char *why = NULL;
		size_t at;
		Json *back = cborDecode(out, length, &why, &at);
		if (!back) die("its own encoding is refused");
		if (!jsonEqual(back, v)) die("read back, another value");
		size_t again;
		bool ok2;
		unsigned char *twice = encoded(back, &again, &ok2);
		if (!ok2 || again != length || memcmp(twice, out, length) != 0) die("read back and encoded, other bytes");
		Json *r = reversed(v);
		unsigned char *other = encoded(r, &again, &ok2);
		if (!ok2 || again != length || memcmp(other, out, length) != 0) die("keys in another order, other bytes");
		free(other), free(twice);
		jsonFree(r), jsonFree(back);
	}
	free(out);
	jsonFree(v);
	return 0;
}
