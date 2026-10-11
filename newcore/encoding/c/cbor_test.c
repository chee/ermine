// cbor_test.c: checks cbor.c (ENCODING.tex). c/build.sh builds it as cbor-test.
//
// The fixed vectors are newcore/encoding/conformance/cbor/vectors.json, a list of
// {"value": <its JSON form, ENCODING.tex>, "cbor": "<hex>"}, so every codec checks
// against the same bytes: each value encodes to exactly its bytes, and the
// bytes decode to a value equal to it. Then round trips, rejected inputs,
// values with no encoding, a short buffer and a deep value.

#include "cbor.h"
#include "json.h"

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
		char *name = jsonPrint(value);
		if (!value || !hex || !jsonDecode(&value, false)) {
			printf("FAIL vector %d (%s) is malformed\n", i, name);
			failures++;
		} else {
			expectBoth(name, value, hex);
		}
		free(name);
	}
	printf("%d vectors\n", list->array.count);
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

static void numbers(void) {
	// every half decodes and encodes back to itself; NaN only as 7e00
	for (unsigned h = 0; h < 0x10000; h++) {
		unsigned char bytes[3] = { 0xf9, (unsigned char)(h >> 8), (unsigned char)h };
		bool nan = (h & 0x7c00) == 0x7c00 && (h & 0x3ff);
		Json *value = cborDecode(bytes, 3, NULL, NULL);
		if (nan && h != 0x7e00) {
			expectTrue("a half NaN other than 7e00 is rejected", !value);
			continue;
		}
		size_t length;
		unsigned char out[16];
		expectTrue("a half decodes", value != NULL);
		if (!value) continue;
		expectTrue("a half encodes to itself", cborEncode(value, out, sizeof out, &length, NULL) && length == 3 && memcmp(out, bytes, 3) == 0);
		jsonFree(value);
	}
	// singles and doubles: each comes back, in the width the value needs
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
			unsigned char out[16];
			size_t length;
			cborEncode(value, out, sizeof out, &length, NULL);
			bool wide = !isnan(each[k]) && !isinf(each[k]) && (fabs(each[k]) > 3.4028234663852886e+38 || (double)(float)each[k] != each[k]);
			expectTrue("a number not a single holds is a double", !wide || length == 9);
			if (k == 0 && !isnan(f)) expectTrue("a single is at most 5 bytes", length <= 5);
			roundTrip("a number", value);
			jsonFree(value);
		}
	}
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
	expectRejected("01", "an integer");
	expectRejected("20", "a negative integer");
	expectRejected("fa3f800000", "1 as a single");
	expectRejected("fb3ff0000000000000", "1 as a double");
	expectRejected("fb3ff8000000000000", "1.5 as a double");
	expectRejected("fa47c35000" "00", "bytes after the value");
	expectRejected("fb40f86a0000000000", "100000 as a double");
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
	expectRejected("d8406161", "a typed array over text");
	expectRejected("d9004040", "a tag with a long head");
	expectRejected("d8454100", "a uint16 array of an odd length");
	expectRejected("d855440100c0ff", "a float32 NaN other than the one");
	expectRejected("d85648010000000000f87f", "a float64 NaN other than the one");
	expectRejected("d840", "a tag with nothing after it");
}

static void unencodable(void) {
	expectNoEncoding("a live value", jsonLive("canvas"));
	Json *list = jsonArray();
	jsonPush(list, jsonLive("canvas"));
	expectNoEncoding("a live value in a list", list);
	char *why = NULL;
	expectNoEncoding("a lone surrogate", jsonParse("\"\\ud800\"", strlen("\"\\ud800\""), &why));
	Json *twice = jsonObject();
	jsonAdd(twice, "a", jsonNull());
	jsonAdd(twice, "a", jsonNull());
	expectNoEncoding("a key twice", twice);
	Json *key = jsonParse("{\"\\udfff\": 1}", strlen("{\"\\udfff\": 1}"), &why);
	expectNoEncoding("a lone surrogate key", key);
}

static void shortBuffer(void) {
	Json *value = jsonParse("{\"b\": [1, 2], \"a\": \"xyz\"}", strlen("{\"b\": [1, 2], \"a\": \"xyz\"}"), NULL);
	unsigned char whole[64], part[5];
	size_t length, cut;
	expectTrue("the whole", cborEncode(value, whole, sizeof whole, &length, NULL));
	expectTrue("a short buffer gets the start and the whole length", cborEncode(value, part, sizeof part, &cut, NULL) && cut == length && memcmp(part, whole, sizeof part) == 0);
	jsonFree(value);
}

static void keys(void) {
	// U+0000 in a key is the byte 00, and sorts first among keys of its length
	char *why = NULL;
	Json *value = jsonParse("{\"b\": 1, \"\\u0000\": 2, \"a\\u0000\": 3}", strlen("{\"b\": 1, \"\\u0000\": 2, \"a\\u0000\": 3}"), &why);
	expectBoth("U+0000 in keys", value, "a36100f940006162f93c00626100f94200");
	jsonFree(value);
	value = jsonParse("[\"a\\u0000b\"]", strlen("[\"a\\u0000b\"]"), &why);
	expectBoth("U+0000 in text", value, "8163610062");
	jsonFree(value);
}

static void deep(void) {
	// a million lists, one in another, and a map in the middle: nothing recurses
	int depth = 1000000;
	Json *root = jsonArray(), *at = root;
	for (int i = 0; i < depth; i++) {
		Json *inner;
		if (i == depth / 2) {
			inner = jsonObject();
			Json *list = jsonArray();
			jsonAdd(inner, "k", list);
			jsonPush(at, inner);
			at = list;
		} else {
			inner = jsonArray();
			jsonPush(at, inner);
			at = inner;
		}
	}
	roundTrip("a million deep", root);
	jsonFree(root);
}

int main(int argc, char **argv) {
	argc_default = argc <= 1;
	vectors(argc > 1 ? argv[1] : "../conformance/cbor/vectors.json");
	numbers();
	rejected();
	unencodable();
	shortBuffer();
	keys();
	deep();
	if (failures) {
		printf("%d failed\n", failures);
		return 1;
	}
	printf("cbor ok\n");
	return 0;
}
