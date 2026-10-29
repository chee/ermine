// cbor_test.c: checks cbor.c (cbor.h). c/build.sh builds it as cbor-test.
//
// The fixed vectors are newcore/encoding/conformance/cbor/vectors.json, a list of
// {"value": <its JSON form, json_text.h>, "cbor": "<hex>"}, so every codec checks
// against the same bytes: each value encodes to exactly its bytes, and the
// bytes decode to a value equal to it; {"cbor", "refused"}: bytes no value
// encodes as; {"form", "refused"}: a JSON form that is no value. Each value written by pieces (the
// cborPut* writer, keys sorted by cborKeyCompare) and into a buffer that grows: the same bytes. Then
// round trips, rejected inputs, values with no encoding, a short buffer, numbers by pieces, and values
// as deep as CBOR_DEPTH and deeper.

#include "cbor.h"
#include "json.h"
#include "json_text.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures = 0;

static void expectTrue(const char *what, bool ok) {
	if (!ok) {
		printf("FAIL %s\n", what);
		failures++;
	}
}

static char *hexOf(const unsigned char *data, size_t length) {
	char *hex = allocate(length * 2 + 1);
	for (size_t i = 0; i < length; i++) snprintf(hex + 2 * i, 3, "%02x", data[i]);
	return hex;
}

static unsigned char *bytesOfHex(const char *hex, size_t *length) {
	*length = strlen(hex) / 2;
	unsigned char *data = allocate(*length);
	for (size_t i = 0; i < *length; i++) {
		unsigned byte;
		sscanf(hex + 2 * i, "%2x", &byte);
		data[i] = (unsigned char)byte;
	}
	return data;
}

/** the value's encoding, fresh, or NULL with *why */
static unsigned char *encode(const Json *value, size_t *length, const char **why) {
	if (!cborEncode(value, NULL, 0, length, why)) return NULL;
	unsigned char *out = allocate(*length);
	size_t again;
	cborEncode(value, out, *length, &again, why);
	return out;
}

/** the value written by pieces, as a writer of values of its own would (recursing: the vectors are shallow); false when it has none */
static bool byPieces(const Json *v, CborOut *o) {
	switch (v->type) {
		case JSON_NULL: cborPutNull(o); return true;
		case JSON_BOOLEAN: cborPutBoolean(o, v->boolean); return true;
		case JSON_NUMBER:
			if (v->big) cborPutWhole(o, v->bigNegative, v->big, v->bigLength);
			else cborPutNumber(o, v->number);
			return true;
		case JSON_STRING: return cborPutText(o, v->string, v->stringLength);
		case JSON_BYTES: cborPutBytes(o, v->bytes.data, v->bytes.length); return true;
		case JSON_TYPED: cborPutTyped(o, v->typed.kind, v->typed.data, v->typed.count); return true;
		case JSON_STAND: cborPutStand(o); return v->stand.kind && byPieces(v->stand.kind, o);
		case JSON_ARRAY:
			cborPutHead(o, 4, (uint64_t)v->array.count);
			for (int i = 0; i < v->array.count; i++)
				if (!byPieces(v->array.items[i], o)) return false;
			return true;
		case JSON_OBJECT: {
			cborPutHead(o, 5, (uint64_t)v->object.count);
			const JsonMember *last = NULL;
			for (int k = 0; k < v->object.count; k++) {
				const JsonMember *next = NULL;
				for (int i = 0; i < v->object.count; i++) {
					const JsonMember *m = &v->object.members[i];
					if (last && cborKeyCompare(m->key, m->keyLength, last->key, last->keyLength) <= 0) continue;
					if (!next || cborKeyCompare(m->key, m->keyLength, next->key, next->keyLength) < 0) next = m;
				}
				if (!next || !cborPutText(o, next->key, next->keyLength) || !byPieces(next->value, o)) return false;
				last = next;
			}
			return true;
		}
	}
	return false;
}

/** written by pieces and by cborPut into a buffer that grows, the value is the bytes cborEncode writes */
static void expectPieces(const char *name, const Json *value, const unsigned char *bytes, size_t length) {
	CborOut pieces = { NULL, 0, 0, true }, grown = { NULL, 0, 0, true };
	if (!byPieces(value, &pieces) || pieces.length != length || memcmp(pieces.data, bytes, length) != 0) {
		printf("FAIL %s: written by pieces, other bytes\n", name);
		failures++;
	}
	if (!cborPut(&grown, value, NULL) || grown.length != length || memcmp(grown.data, bytes, length) != 0) {
		printf("FAIL %s: written into a buffer that grows, other bytes\n", name);
		failures++;
	}
	free(pieces.data);
	free(grown.data);
}

/** the value encodes to the bytes, and the bytes decode to it */
static void expectBoth(const char *name, const Json *value, const char *hex) {
	size_t length;
	const char *why = NULL;
	unsigned char *out = encode(value, &length, &why);
	if (!out) {
		printf("FAIL %s: no encoding: %s\n", name, why);
		failures++;
		return;
	}
	expectPieces(name, value, out, length);
	char *got = hexOf(out, length);
	if (strcmp(got, hex) != 0) {
		printf("FAIL %s: encodes to %s, want %s\n", name, got, hex);
		failures++;
	}
	size_t at = 0, n;
	unsigned char *bytes = bytesOfHex(hex, &n);
	Json *back = cborDecode(bytes, n, &why, &at);
	if (!back) {
		printf("FAIL %s: %s does not decode: %s at %zu\n", name, hex, why, at);
		failures++;
	} else if (!jsonEqual(back, value)) {
		char *printed = jsonPrint(back);
		printf("FAIL %s: %s decodes to %s\n", name, hex, printed);
		free(printed);
		failures++;
	}
	jsonFree(back);
	free(bytes);
	free(got);
	free(out);
}

static void expectRejected(const char *hex, const char *what);
static void expectNoForm(Json *form, const char *what);

static int argc_default;

static void vectors(const char *path) {
	FILE *file = fopen(path, "rb");
	// run from newcore/encoding/c, or from newcore
	if (!file && argc_default) file = fopen("encoding/conformance/cbor/vectors.json", "rb");
	if (!file) {
		printf("FAIL cannot open %s\n", path);
		failures++;
		return;
	}
	char *text = NULL;
	size_t size = 0;
	FILE *memory = open_memstream(&text, &size);
	int c;
	while ((c = fgetc(file)) != EOF) fputc(c, memory);
	fclose(memory);
	fclose(file);
	char *why = NULL;
	Json *list = jsonParse(text, size, &why);
	if (!jsonIsArray(list)) {
		printf("FAIL %s is not a JSON list: %s\n", path, why ? why : "");
		failures++;
		return;
	}
	for (int i = 0; i < list->array.count; i++) {
		Json *vector = list->array.items[i];
		Json *value = jsonGet(vector, "value");
		const char *hex = jsonText(jsonGet(vector, "cbor"));
		Json *form = jsonGet(vector, "form");
		if (form && !value && !hex && jsonGet(vector, "refused")) {
			// a JSON form that stands for no value
			expectNoForm(form, jsonText(jsonGet(vector, "refused")));
			continue;
		}
		if (!value && hex && jsonGet(vector, "refused")) {
			// no value: the bytes are no encoding
			expectRejected(hex, jsonText(jsonGet(vector, "refused")));
			continue;
		}
		char *name = jsonPrint(value);
		Json *back = jsonGet(vector, "back");
		if (!value || !hex || !jsonDecode(&value) || (back && !jsonDecode(&back))) {
			printf("FAIL vector %d (%s) is malformed\n", i, name);
			failures++;
		} else {
			expectBoth(name, value, hex);
			// what it reads back as, when the vector says
			if (back) expectBoth(name, back, hex);
		}
		free(name);
	}
	printf("%d vectors\n", list->array.count);
	jsonFree(list);
	free(text);
}

/** the hex is rejected by the decoder */
static void expectRejected(const char *hex, const char *what) {
	size_t n, at = 0;
	const char *why = NULL;
	unsigned char *bytes = bytesOfHex(hex, &n);
	Json *value = cborDecode(bytes, n, &why, &at);
	if (value) {
		char *printed = jsonPrint(value);
		printf("FAIL %s (%s) decodes to %s\n", hex, what, printed);
		free(printed);
		failures++;
		jsonFree(value);
	}
	free(bytes);
}

/** the JSON form is no value: jsonDecode refuses it (in place, as the values are decoded) */
static void expectNoForm(Json *form, const char *what) {
	if (jsonDecode(&form)) {
		char *printed = jsonPrint(form);
		printf("FAIL %s (%s) is a value\n", printed, what);
		free(printed);
		failures++;
	}
}

static void expectNoEncoding(const char *what, const Json *value) {
	size_t length;
	const char *why = NULL;
	expectTrue(what, !cborEncode(value, NULL, 0, &length, &why) && why);
}

/** encode, then decode: the same value, and its encoding the same bytes */
static void roundTrip(const char *what, const Json *value) {
	size_t length, again;
	const char *why = NULL;
	unsigned char *out = encode(value, &length, &why);
	if (!out) {
		printf("FAIL %s: no encoding: %s\n", what, why);
		failures++;
		return;
	}
	Json *back = cborDecode(out, length, &why, NULL);
	if (!back || !jsonEqual(back, value)) {
		printf("FAIL %s: does not come back (%s)\n", what, back ? "unequal" : why);
		failures++;
	} else {
		unsigned char *twice = encode(back, &again, &why);
		expectTrue(what, twice && again == length && memcmp(out, twice, length) == 0);
		free(twice);
	}
	jsonFree(back);
	free(out);
}

static uint64_t state = 0x9e3779b97f4a7c15u;
static uint64_t random64(void) {
	state ^= state << 13;
	state ^= state >> 7;
	state ^= state << 17;
	return state;
}

/** the bytes of a whole number as cbor.h has it: the shortest head, a bignum past 64 bits */
static bool isInteger(const unsigned char *out, size_t length) {
	unsigned major = out[0] >> 5, info = out[0] & 31;
	if (major <= 1) return info < 24 ? length == 1 : length == 1 + (1u << (info - 24));
	return out[0] == 0xc2 || out[0] == 0xc3;
}

static void numbers(void) {
	// every half decodes and encodes back to itself, but whole ones (integers) and NaNs not 7e00
	for (unsigned h = 0; h < 0x10000; h++) {
		unsigned char bytes[3] = { 0xf9, (unsigned char)(h >> 8), (unsigned char)h };
		bool nan = (h & 0x7c00) == 0x7c00 && (h & 0x3ff);
		bool inf = (h & 0x7fff) == 0x7c00;
		int e = (h >> 10) & 31;
		// whole: zero, or a normal half with no fraction bits below its point
		bool whole = (h & 0x7fff) == 0 || (!nan && !inf && e >= 15 && (e >= 25 || !((h & 0x3ff) & ((1u << (25 - e)) - 1))));
		Json *value = cborDecode(bytes, 3, NULL, NULL);
		if (nan && h != 0x7e00) {
			expectTrue("a half NaN other than 7e00 is rejected", !value);
			continue;
		}
		if (whole) {
			expectTrue("a whole half is rejected: whole numbers are integers", !value);
			jsonFree(value);
			continue;
		}
		size_t length;
		unsigned char out[16];
		expectTrue("a half decodes", value != NULL);
		if (!value) continue;
		expectTrue("a half encodes to itself", cborEncode(value, out, sizeof out, &length, NULL) && length == 3 && memcmp(out, bytes, 3) == 0);
		jsonFree(value);
	}
	// singles and doubles: each comes back, in the width the value needs; a whole one an integer
	for (int i = 0; i < 200000; i++) {
		uint64_t bits = random64();
		uint32_t word = (uint32_t)bits;
		float f;
		double d;
		memcpy(&f, &word, 4);
		memcpy(&d, &bits, 8);
		double each[] = { f, d, ldexp((double)(bits >> 40), -(int)(bits & 63)), (double)(int64_t)(bits >> 20) - (double)(1 << 22) };
		for (int k = 0; k < 4; k++) {
			Json *value = jsonNumber(each[k]);
			unsigned char out[160];
			size_t length;
			cborEncode(value, out, sizeof out, &length, NULL);
			bool whole = isfinite(each[k]) && floor(each[k]) == each[k];
			bool wide = !whole && !isnan(each[k]) && !isinf(each[k]) && (fabs(each[k]) > 3.4028234663852886e+38 || (double)(float)each[k] != each[k]);
			if (whole) expectTrue("a whole number is an integer", isInteger(out, length));
			expectTrue("a number not a single holds is a double", !wide || length == 9);
			if (k == 0 && !isnan(f) && !whole) expectTrue("a single is at most 5 bytes", length <= 5);
			roundTrip("a number", value);
			jsonFree(value);
		}
	}
	// whole numbers at the edges: the integer, the same from int64, uint64 and bytes, back as made
	struct {
		bool negative;
		const char *magnitude; // hex
		const char *cbor;
	} edges[] = {
		{ false, "", "00" },
		{ false, "17", "17" },
		{ false, "18", "1818" },
		{ true, "18", "37" },
		{ true, "19", "3818" },
		{ false, "ffffffff", "1affffffff" },
		{ false, "0100000000", "1b0000000100000000" },
		{ false, "1fffffffffffff", "1b001fffffffffffff" },
		{ false, "20000000000001", "1b0020000000000001" },
		{ true, "20000000000001", "3b0020000000000000" },
		{ false, "ffffffffffffffff", "1bffffffffffffffff" },
		{ true, "010000000000000000", "3bffffffffffffffff" },
		{ false, "010000000000000000", "c249010000000000000000" },
		{ true, "010000000000000001", "c349010000000000000000" },
		{ false, "10000000000000000000000000", "c24d10000000000000000000000000" },
	};
	for (size_t i = 0; i < sizeof edges / sizeof *edges; i++) {
		size_t n;
		unsigned char *m = bytesOfHex(edges[i].magnitude, &n);
		Json *value = jsonWhole(edges[i].negative, m, n);
		expectBoth(edges[i].cbor, value, edges[i].cbor);
		int64_t i64;
		if (jsonInt64(value, &i64)) {
			Json *again = jsonInteger(i64);
			expectTrue("int64 the same", jsonEqual(again, value));
			jsonFree(again);
		}
		jsonFree(value);
		free(m);
	}
	Json *max = jsonUnsigned(UINT64_MAX), *min = jsonInteger(INT64_MIN), *five = jsonInteger(5);
	expectBoth("2^64 - 1", max, "1bffffffffffffffff");
	expectBoth("-2^63", min, "3b7fffffffffffffff");
	int64_t got;
	expectTrue("as int64: 2^64 - 1 is past it", !jsonInt64(max, &got));
	expectTrue("as int64: -2^63", jsonInt64(min, &got) && got == INT64_MIN);
	expectTrue("as int64: 5", jsonInt64(five, &got) && got == 5);
	Json *half = jsonNumber(1.5), *minus = jsonNumber(-0.0);
	expectTrue("as int64: 1.5 is a fraction", !jsonInt64(half, &got));
	expectBoth("-0 is 0", minus, "00");
	double near;
	expectTrue("as double: 2^64 - 1 is 2^64", jsonDouble(max, &near) && near == 18446744073709551616.0);
	jsonFree(max), jsonFree(min), jsonFree(five), jsonFree(half), jsonFree(minus);
	// a NaN with a payload is the one NaN
	double payload;
	uint64_t bits = UINT64_C(0xfff8000000000123);
	memcpy(&payload, &bits, 8);
	Json *nan = jsonNumber(payload);
	unsigned char out[16];
	size_t length;
	expectTrue("a NaN is f97e00", cborEncode(nan, out, sizeof out, &length, NULL) && length == 3 && out[0] == 0xf9 && out[1] == 0x7e && out[2] == 0);
	jsonFree(nan);
	// a float typed array's NaNs are the one NaN of the width
	uint32_t nans32[2] = { 0xffc00001u, 0x7f800001u };
	Json *typed = jsonTyped(JSON_FLOAT32, nans32, 2);
	expectTrue("float32 NaNs", cborEncode(typed, out, sizeof out, &length, NULL) && length == 11 &&
	                               memcmp(out, "\xd8\x55\x48\x00\x00\xc0\x7f\x00\x00\xc0\x7f", 11) == 0);
	jsonFree(typed);
}

static void rejected(void) {
	expectRejected("", "nothing");
	expectRejected("1817", "23 in a longer head");
	expectRejected("3817", "-24 in a longer head");
	expectRejected("1b00000000ffffffff", "an eight-byte head a four-byte one holds");
	expectRejected("1f", "an indefinite integer");
	expectRejected("1a0001", "an integer that ends early");
	expectRejected("f90000", "0 as a half");
	expectRejected("f98000", "-0 as a half");
	expectRejected("f93c00", "1 as a half");
	expectRejected("fa5a000000", "2^53 as a single");
	expectRejected("fb7e37e43c8800759c", "1e300 as a double");
	expectRejected("c2480100000000000000", "a bignum a plain integer holds");
	expectRejected("c240", "a bignum of nothing");
	expectRejected("c34a00010000000000000000", "a bignum with a leading zero");
	expectRejected("c26a61616161616161616161", "a bignum over text");
	expectRejected("c249010000000000", "a bignum that ends early");
	expectRejected("fa3f800000", "1 as a single");
	expectRejected("fb3ff0000000000000", "1 as a double");
	expectRejected("fb3ff8000000000000", "1.5 as a double");
	expectRejected("1a000186a0" "00", "bytes after the value");
	expectRejected("fb40f86a0000000000", "100000 as a double");
	expectRejected("fa47c35000", "100000 as a single");
	expectRejected("f97e01", "a NaN with a payload");
	expectRejected("f9fe00", "a negative NaN");
	expectRejected("fa7fc00000", "NaN as a single");
	expectRejected("fb7ff8000000000000", "NaN as a double");
	expectRejected("f7", "undefined");
	expectRejected("f8ff", "a simple value");
	expectRejected("e0", "simple value 0");
	expectRejected("f93c", "a short half");
	expectRejected("780161", "a head longer than it need be");
	expectRejected("590001" "00", "a byte string with a long head");
	expectRejected("9800", "an empty list with a long head");
	expectRejected("b800", "an empty map with a long head");
	expectRejected("9fff", "an indefinite list");
	expectRejected("5fff", "an indefinite byte string");
	expectRejected("7f6161ff", "an indefinite text string");
	expectRejected("bfff", "an indefinite map");
	expectRejected("ff", "a break");
	expectRejected("81", "a list that ends early");
	expectRejected("9a7fffffff", "a list longer than the input");
	expectRejected("6261", "a string longer than the input");
	expectRejected("62c080", "an overlong U+0000");
	expectRejected("63eda080", "a surrogate");
	expectRejected("61ff", "not UTF-8");
	expectRejected("64f4908080", "past U+10FFFF");
	expectRejected("a26162f66161f6", "keys out of order");
	expectRejected("a2626161f66162f6", "a longer key before a shorter");
	expectRejected("a26161f66161f6", "a key twice");
	expectRejected("a101f6", "an integer key");
	expectRejected("a1f6f6", "a null key");
	expectRejected("a14161f6", "a bytes key");
	expectRejected("a16161", "a map that ends after a key");
	expectRejected("c0" "6161", "tag 0");
	expectRejected("d84161", "an unknown tag");
	expectRejected("d840420102", "tag 64: no uint8 kind, bytes are that");
	expectRejected("d84040", "tag 64 over nothing");
	expectRejected("d8456161", "a typed array over text");
	expectRejected("d9004540", "a tag with a long head");
	expectRejected("d8454100", "a uint16 array of an odd length");
	expectRejected("d855440100c0ff", "a float32 NaN other than the one");
	expectRejected("d85648010000000000f87f", "a float64 NaN other than the one");
	expectRejected("d845", "a tag with nothing after it");
	expectRejected("db0000000012345678f6", "the stand-in's tag in an eight-byte head");
	expectRejected("da12345678", "a stand-in with no kind");
	expectRejected("da12345678f6f6", "bytes after a stand-in");
	expectRejected("da00a98ac6f6", "the tag one below the stand-in's");
}

static void unencodable(void) {
	char *why = NULL;
	Json *lone = jsonParse("\"\\ud800\"", strlen("\"\\ud800\""), &why);
	expectNoEncoding("a lone surrogate", lone);
	jsonFree(lone);
	Json *twice = jsonObject();
	jsonAdd(twice, "a", jsonNull());
	jsonAdd(twice, "a", jsonNull());
	expectNoEncoding("a key twice", twice);
	jsonFree(twice);
	Json *key = jsonParse("{\"\\udfff\": 1}", strlen("{\"\\udfff\": 1}"), &why);
	expectNoEncoding("a lone surrogate key", key);
	jsonFree(key);
}

static void stands(void) {
	// a stand-in holding a stand-in, in a list: it comes back, equal and in the same bytes
	Json *list = jsonArray();
	jsonPush(list, jsonStand(jsonString("canvas")));
	jsonPush(list, jsonStand(jsonStand(jsonNull())));
	roundTrip("stand-ins in a list", list);
	jsonFree(list);
	Json *kind = jsonObject();
	jsonAdd(kind, "url", jsonString("x"));
	Json *one = jsonStand(kind);
	Json *same = jsonShallow(one), *other = jsonStand(jsonNull());
	expectTrue("stand-ins of equal kinds are equal", jsonEqual(one, same));
	expectTrue("stand-ins of other kinds are not", !jsonEqual(one, other));
	expectTrue("a stand-in is not its kind", !jsonEqual(one, kind));
	jsonFree(same);
	jsonFree(other);
	jsonFree(one);
}

static void shortBuffer(void) {
	Json *value = jsonParse("{\"b\": [1, 2], \"a\": \"xyz\"}", strlen("{\"b\": [1, 2], \"a\": \"xyz\"}"), NULL);
	unsigned char whole[64], part[5];
	size_t length, cut;
	expectTrue("the whole", cborEncode(value, whole, sizeof whole, &length, NULL));
	expectTrue("a short buffer gets the start and the whole length", cborEncode(value, part, sizeof part, &cut, NULL) && cut == length && memcmp(part, whole, sizeof part) == 0);
	jsonFree(value);
}

/** a number by pieces as its Json writes it */
static void expectNumber(const char *name, Json *value, void (*put)(CborOut *o, const void *given), const void *given) {
	size_t length;
	unsigned char *want = encode(value, &length, NULL);
	CborOut o = { NULL, 0, 0, true };
	put(&o, given);
	if (!want || o.length != length || memcmp(o.data, want, length) != 0) {
		printf("FAIL %s: by pieces, other bytes\n", name);
		failures++;
	}
	free(o.data);
	free(want);
	jsonFree(value);
}
static void putInteger(CborOut *o, const void *given) { cborPutInteger(o, *(const int64_t *)given); }
static void putDouble(CborOut *o, const void *given) { cborPutNumber(o, *(const double *)given); }
typedef struct { bool negative; unsigned char m[140]; size_t n; } Magnitude;
static void putMagnitude(CborOut *o, const void *given) {
	const Magnitude *w = given;
	cborPutWhole(o, w->negative, w->m, w->n);
}

static void pieces(void) {
	static const int64_t ints[] = { 0, 1, -1, 23, 24, -24, -25, 255, 256, -256, -257, 65535, 65536, INT64_MAX, INT64_MIN, INT64_MIN + 1, (int64_t)1 << 53, -((int64_t)1 << 53) - 1 };
	for (size_t i = 0; i < sizeof ints / sizeof *ints; i++) expectNumber("an integer", jsonInteger(ints[i]), putInteger, &ints[i]);
	static const double ds[] = { 0.0, -0.0, 0.5, -1.5, 1e300, 5e-324, 65504, 65505, 0x1p-24, 1e15, 9007199254740993.0, 1.8446744073709552e19, -1.8446744073709552e19, INFINITY, -INFINITY, NAN };
	for (size_t i = 0; i < sizeof ds / sizeof *ds; i++) expectNumber("a double", jsonNumber(ds[i]), putDouble, &ds[i]);
	// magnitudes: leading zeros, 0 and -0, 2^64 and past, exact in a double, past 128 bytes
	Magnitude w[8];
	memset(w, 0, sizeof w);
	w[0] = (Magnitude){ true, { 0 }, 1 };
	w[1] = (Magnitude){ false, { 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0 }, 11 };
	w[2] = (Magnitude){ true, { 1, 0, 0, 0, 0, 0, 0, 0, 0 }, 9 };
	w[3] = (Magnitude){ true, { 1, 0, 0, 0, 0, 0, 0, 0, 1 }, 9 };
	w[4] = (Magnitude){ false, { 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }, 10 };
	w[5].n = 129, w[5].m[0] = 1, w[5].m[128] = 3;
	w[6].n = 128, w[6].m[0] = 0x80, w[6].m[127] = 1, w[6].negative = true;
	w[7] = (Magnitude){ true, { 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }, 8 };
	for (size_t i = 0; i < 8; i++) expectNumber("a whole number", jsonWhole(w[i].negative, w[i].m, w[i].n), putMagnitude, &w[i]);
}

static void keys(void) {
	// U+0000 in a key is the byte 00, and sorts first among keys of its length
	char *why = NULL;
	Json *value = jsonParse("{\"b\": 1, \"\\u0000\": 2, \"a\\u0000\": 3}", strlen("{\"b\": 1, \"\\u0000\": 2, \"a\\u0000\": 3}"), &why);
	expectBoth("U+0000 in keys", value, "a361000261620162610003");
	jsonFree(value);
	value = jsonParse("[\"a\\u0000b\"]", strlen("[\"a\\u0000b\"]"), &why);
	expectBoth("U+0000 in text", value, "8163610062");
	jsonFree(value);
}

// n containers, one in another, a map among them halfway
static Json *nest(int n) {
	Json *root = jsonArray(), *at = root;
	for (int i = 1; i < n; i++) {
		Json *inner = i == n / 2 ? jsonObject() : jsonArray();
		if (at->type == JSON_OBJECT) jsonAdd(at, "k", inner);
		else jsonPush(at, inner);
		at = inner;
	}
	return root;
}

// n lists, one in another, as bytes: 81 n - 1 times, then 80
static void expectNestedRejected(const char *what, size_t n) {
	unsigned char *bytes = allocate(n);
	memset(bytes, 0x81, n - 1);
	bytes[n - 1] = 0x80;
	const char *why = NULL;
	Json *value = cborDecode(bytes, n, &why, NULL);
	expectTrue(what, value == NULL && why != NULL && strstr(why, "nested deeper than") != NULL);
	jsonFree(value);
	free(bytes);
}

static void deep(void) {
	// CBOR_DEPTH containers, one in another: the deepest a value goes, nothing recursing
	Json *most = nest(CBOR_DEPTH);
	roundTrip("CBOR_DEPTH deep", most);
	jsonFree(most);
	// one more, or a million: no encoding, and their bytes are not one
	Json *over = nest(CBOR_DEPTH + 1), *million = nest(1000000);
	expectNoEncoding("CBOR_DEPTH + 1 deep", over);
	expectNoEncoding("a million deep", million);
	jsonFree(over);
	jsonFree(million);
	expectNestedRejected("CBOR_DEPTH + 1 deep, as bytes", CBOR_DEPTH + 1);
	expectNestedRejected("a million deep, as bytes", 1000000);
}

int main(int argc, char **argv) {
	argc_default = argc <= 1;
	vectors(argc > 1 ? argv[1] : "../conformance/cbor/vectors.json");
	numbers();
	rejected();
	unencodable();
	stands();
	shortBuffer();
	pieces();
	keys();
	deep();
	if (failures) {
		printf("%d failed\n", failures);
		return 1;
	}
	printf("cbor ok\n");
	return 0;
}
