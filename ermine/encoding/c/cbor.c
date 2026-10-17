// cbor.c: values in deterministic CBOR and back. See cbor.h for every choice.

#include "cbor.h"
#include "../../../core/op/c/whole.h"

#include <float.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// shared ----------------------------------------------------------------------

/** RFC 8746 tags, by JsonKind (int8, int16, uint16, int32, uint32, int64, uint64, float32, float64); never 64, uint8: bytes are that */
#define STAND 0x12345678u // the stand-in's tag, in its head da12345678
static const unsigned kindTags[JSON_KINDS] = { 72, 77, 69, 78, 70, 79, 71, 85, 86 };

/** the one NaN of each float width, quiet, no payload */
#define NAN32 UINT32_C(0x7fc00000)
#define NAN64 UINT64_C(0x7ff8000000000000)
#define NAN16 0x7e00u

/**
 * Whether the bytes are UTF-8: shortest forms, no surrogates, nothing past
 * U+10FFFF. With `held`, U+0000 as json.h holds it (C0 80) is one more form.
 */
static bool isUtf8(const unsigned char *s, size_t n, bool held) {
	size_t i = 0;
	while (i < n) {
		unsigned char b = s[i];
		size_t more;
		unsigned char low = 0x80, high = 0xbf; // the range of the second byte
		if (b < 0x80) {
			i++;
			continue;
		} else if (held && b == 0xc0 && i + 1 < n && s[i + 1] == 0x80) {
			i += 2;
			continue;
		} else if (b >= 0xc2 && b <= 0xdf) {
			more = 1;
		} else if (b >= 0xe0 && b <= 0xef) {
			more = 2;
			if (b == 0xe0) low = 0xa0;
			if (b == 0xed) high = 0x9f;
		} else if (b >= 0xf0 && b <= 0xf4) {
			more = 3;
			if (b == 0xf0) low = 0x90;
			if (b == 0xf4) high = 0x8f;
		} else {
			return false;
		}
		if (n - i <= more || s[i + 1] < low || s[i + 1] > high) return false;
		for (size_t k = 2; k <= more; k++)
			if ((s[i + k] & 0xc0) != 0x80) return false;
		i += more + 1;
	}
	return true;
}

/** a double as a half's bits, when a half holds it exactly (not NaN) */
static bool halfOf(double d, uint16_t *out) {
	uint16_t sign = signbit(d) ? 0x8000 : 0;
	double a = fabs(d);
	if (isinf(a)) {
		*out = sign | 0x7c00;
		return true;
	}
	if (a == 0) {
		*out = sign;
		return true;
	}
	if (a < 0x1p-14) {
		// a subnormal half: a whole number of 2^-24
		double steps = ldexp(a, 24);
		if (steps != floor(steps)) return false;
		*out = sign | (uint16_t)steps;
		return true;
	}
	int e;
	frexp(a, &e); // a = m 2^e, m in [0.5, 1): a = (2m) 2^(e-1)
	int exponent = e - 1;
	if (exponent > 15) return false;
	double mantissa = ldexp(a, 10 - exponent); // in [1024, 2048)
	if (mantissa != floor(mantissa)) return false;
	*out = sign | (uint16_t)((exponent + 15) << 10) | (uint16_t)((uint32_t)mantissa - 1024);
	return true;
}

static double halfValue(uint16_t h) {
	int exponent = (h >> 10) & 31;
	unsigned mantissa = h & 1023;
	double a;
	if (exponent == 0) a = ldexp(mantissa, -24);
	else if (exponent == 31) a = mantissa ? NAN : INFINITY;
	else a = ldexp(mantissa + 1024, exponent - 25);
	return (h & 0x8000) ? -a : a;
}

/** whether a single holds the double exactly (not NaN) */
static bool fitsFloat(double d) {
	return isinf(d) || (fabs(d) <= FLT_MAX && (double)(float)d == d);
}

// encoding --------------------------------------------------------------------

typedef struct Out {
	unsigned char *out;
	size_t capacity, length;
} Out;

static void putByte(Out *o, unsigned byte) {
	if (o->length < o->capacity) o->out[o->length] = (unsigned char)byte;
	o->length++;
}

/** `count` bytes of a number, most significant first */
static void putBig(Out *o, uint64_t number, int count) {
	for (int i = count - 1; i >= 0; i--) putByte(o, (unsigned)(number >> (8 * i)) & 0xff);
}

/** a head in its shortest form */
static void putHead(Out *o, unsigned major, uint64_t argument) {
	major <<= 5;
	if (argument < 24) putByte(o, major | (unsigned)argument);
	else if (argument <= 0xff) putByte(o, major | 24), putBig(o, argument, 1);
	else if (argument <= 0xffff) putByte(o, major | 25), putBig(o, argument, 2);
	else if (argument <= 0xffffffffu) putByte(o, major | 26), putBig(o, argument, 4);
	else putByte(o, major | 27), putBig(o, argument, 8);
}

/** a whole number: major type 0 or 1 in the shortest head, a bignum (tag 2 or 3 over its bytes) past 64 bits */
static void putWhole(Out *o, bool negative, const unsigned char *m, size_t n) {
	// a negative's argument is its magnitude less one: -1 - n
	unsigned char less[129];
	if (negative) {
		memcpy(less, m, n);
		for (size_t i = n; i-- > 0;) {
			if (less[i]--) break;
		}
		m = less;
		while (n && !*m) m++, n--;
	}
	uint64_t argument;
	if (whole_u64(m, n, &argument)) {
		putHead(o, negative ? 1 : 0, argument);
		return;
	}
	putByte(o, negative ? 0xc3 : 0xc2);
	putHead(o, 2, n);
	for (size_t i = 0; i < n; i++) putByte(o, m[i]);
}

static void putNumber(Out *o, const Json *value) {
	uint16_t half;
	double d = value->number;
	bool negative;
	unsigned char m[128];
	size_t n;
	if (jsonMagnitude(value, &negative, m, &n)) {
		putWhole(o, negative, m, n);
		return;
	}
	if (isnan(d)) {
		putByte(o, 0xf9), putBig(o, NAN16, 2);
	} else if (halfOf(d, &half)) {
		putByte(o, 0xf9), putBig(o, half, 2);
	} else if (fitsFloat(d)) {
		float f = (float)d;
		uint32_t bits;
		memcpy(&bits, &f, 4);
		putByte(o, 0xfa), putBig(o, bits, 4);
	} else {
		uint64_t bits;
		memcpy(&bits, &d, 8);
		putByte(o, 0xfb), putBig(o, bits, 8);
	}
}

bool cborText(const char *text, size_t length) {
	return isUtf8((const unsigned char *)text, length, true);
}

/** how many bytes the text is in plain UTF-8: each C0 80 is one 00 */
static size_t plainLength(const char *text, size_t length) {
	size_t plain = length;
	for (size_t i = 0; i + 1 < length; i++)
		if ((unsigned char)text[i] == 0xc0 && (unsigned char)text[i + 1] == 0x80) plain--, i++;
	return plain;
}

/** a string or key as a text string; false when it is not UTF-8 */
static bool putText(Out *o, const char *text, size_t length) {
	const unsigned char *s = (const unsigned char *)text;
	if (!isUtf8(s, length, true)) return false;
	putHead(o, 3, plainLength(text, length));
	for (size_t i = 0; i < length; i++) {
		if (s[i] == 0xc0 && i + 1 < length && s[i + 1] == 0x80) {
			putByte(o, 0);
			i++;
		} else {
			putByte(o, s[i]);
		}
	}
	return true;
}

/** the byte at s[*i] in plain UTF-8, moving past it */
static unsigned plainByte(const unsigned char *s, size_t length, size_t *i) {
	if (s[*i] == 0xc0 && *i + 1 < length && s[*i + 1] == 0x80) {
		*i += 2;
		return 0;
	}
	return s[(*i)++];
}

/** two keys in the order of their encodings: the shorter first, then byte by byte */
static int keyCompare(const JsonMember *a, const JsonMember *b) {
	size_t al = plainLength(a->key, a->keyLength), bl = plainLength(b->key, b->keyLength);
	if (al != bl) return al < bl ? -1 : 1;
	const unsigned char *x = (const unsigned char *)a->key, *y = (const unsigned char *)b->key;
	size_t i = 0, j = 0;
	while (i < a->keyLength && j < b->keyLength) {
		unsigned p = plainByte(x, a->keyLength, &i), q = plainByte(y, b->keyLength, &j);
		if (p != q) return p < q ? -1 : 1;
	}
	return 0;
}

/** the member whose key comes next after member `last` (-1: the first), or -1 */
static int nextKey(const Json *object, int last) {
	const JsonMember *members = object->object.members;
	int best = -1;
	for (int i = 0; i < object->object.count; i++) {
		if (last >= 0 && keyCompare(&members[i], &members[last]) <= 0) continue;
		if (best < 0 || keyCompare(&members[i], &members[best]) < 0) best = i;
	}
	return best;
}

/** a typed array element as the unsigned number of its bits, a NaN as the one NaN */
static uint64_t elementBits(JsonKind kind, const unsigned char *at) {
	switch (kind) {
		case JSON_INT8: return at[0];
		case JSON_INT16:
		case JSON_UINT16: {
			uint16_t bits;
			memcpy(&bits, at, 2);
			return bits;
		}
		case JSON_INT32:
		case JSON_UINT32: {
			uint32_t bits;
			memcpy(&bits, at, 4);
			return bits;
		}
		case JSON_FLOAT32: {
			float f;
			uint32_t bits;
			memcpy(&f, at, 4);
			memcpy(&bits, at, 4);
			return isnan(f) ? NAN32 : bits;
		}
		case JSON_FLOAT64: {
			double d;
			uint64_t bits;
			memcpy(&d, at, 8);
			memcpy(&bits, at, 8);
			return isnan(d) ? NAN64 : bits;
		}
		default: {
			uint64_t bits;
			memcpy(&bits, at, 8);
			return bits;
		}
	}
}

static void putTyped(Out *o, const Json *value) {
	JsonKind kind = value->typed.kind;
	size_t size = jsonKindSize(kind);
	const unsigned char *data = value->typed.data;
	putHead(o, 6, kindTags[kind]);
	putHead(o, 2, (uint64_t)value->typed.count * size);
	for (size_t i = 0; i < value->typed.count; i++) {
		uint64_t bits = elementBits(kind, data + i * size);
		for (size_t k = 0; k < size; k++) putByte(o, (unsigned)(bits >> (8 * k)) & 0xff); // little-endian
	}
}

/** a list or map being written: how many of its members are out, and (a map) the last key written.
 * a big map's members in key order, found once (n log n; nextKey is n each, n² in all) */
typedef struct Writing {
	const Json *container;
	int next;
	int last;
	const JsonMember **order;
} Writing;

static int memberCompare(const void *a, const void *b) {
	return keyCompare(*(const JsonMember *const *)a, *(const JsonMember *const *)b);
}

/** a map's members sorted by key, when it is big; NULL when small (nextKey does) or out of memory
 * (nextKey does, slowly). *twice: two members with one key */
static const JsonMember **sortedMembers(const Json *object, bool *twice) {
	int n = object->object.count;
	*twice = false;
	if (n <= 16) return NULL;
	const JsonMember **order = malloc((size_t)n * sizeof *order);
	if (!order) return NULL;
	for (int i = 0; i < n; i++) order[i] = &object->object.members[i];
	qsort(order, (size_t)n, sizeof *order, memberCompare);
	for (int i = 1; i < n; i++) {
		if (keyCompare(order[i - 1], order[i]) == 0) *twice = true;
	}
	return order;
}

// No recursion: the lists and maps being written are kept on a stack of their own.
bool cborEncode(const Json *value, unsigned char *out, size_t capacity, size_t *length, const char **why) {
	Out o = { out, capacity, 0 };
	Writing *stack = NULL;
	int depth = 0, room = 0;
	const char *fault = NULL;
	if (!value) fault = "no value";
	while (value && !fault) {
		switch (value->type) {
			case JSON_NULL: putByte(&o, 0xf6); break;
			case JSON_BOOLEAN: putByte(&o, value->boolean ? 0xf5 : 0xf4); break;
			case JSON_NUMBER: putNumber(&o, value); break;
			case JSON_STRING:
				if (!putText(&o, value->string, value->stringLength)) fault = "a string that is not UTF-8";
				break;
			case JSON_BYTES:
				putHead(&o, 2, value->bytes.length);
				for (size_t i = 0; i < value->bytes.length; i++) putByte(&o, value->bytes.data[i]);
				break;
			case JSON_TYPED: putTyped(&o, value); break;
			case JSON_STAND:
				if (depth >= CBOR_DEPTH) {
					fault = "a value nested deeper than " CBOR_DEPTH_TEXT;
					break;
				}
				putHead(&o, 6, STAND);
				stack = growArray(stack, depth, &room, sizeof *stack);
				stack[depth++] = (Writing){ value, 0, -1, NULL };
				break;
			case JSON_ARRAY:
			case JSON_OBJECT: {
				if (depth >= CBOR_DEPTH) {
					fault = "a value nested deeper than " CBOR_DEPTH_TEXT;
					break;
				}
				bool list = value->type == JSON_ARRAY;
				putHead(&o, list ? 4 : 5, (uint64_t)(list ? value->array.count : value->object.count));
				stack = growArray(stack, depth, &room, sizeof *stack);
				stack[depth++] = (Writing){ value, 0, -1, NULL };
				if (!list) {
					bool twice;
					stack[depth - 1].order = sortedMembers(value, &twice);
					if (twice) fault = "a map holds a key twice";
				}
				break;
			}
		}
		// the next value to write, leaving every container that is done
		value = NULL;
		while (depth && !value && !fault) {
			Writing *top = &stack[depth - 1];
			const Json *container = top->container;
			if (container->type == JSON_STAND) {
				if (top->next) depth--;
				else value = container->stand.kind, top->next++;
			} else if (container->type == JSON_ARRAY) {
				if (top->next == container->array.count) depth--;
				else value = container->array.items[top->next++];
			} else if (top->next == container->object.count) {
				free(top->order);
				depth--;
			} else {
				int at = top->order ? (int)(top->order[top->next] - container->object.members)
				                    : nextKey(container, top->last);
				if (at < 0) {
					fault = "a map holds a key twice";
					break;
				}
				const JsonMember *member = &container->object.members[at];
				if (!putText(&o, member->key, member->keyLength)) {
					fault = "a key that is not UTF-8";
					break;
				}
				top->last = at;
				top->next++;
				value = member->value;
			}
		}
	}
	for (int i = 0; i < depth; i++) free(stack[i].order);
	free(stack);
	*length = o.length;
	if (fault && why) *why = fault;
	return !fault;
}

// decoding --------------------------------------------------------------------

typedef struct In {
	const unsigned char *data;
	size_t length, at;
	const char *why;
	size_t whyAt;
	bool build; // false: the rules are checked and no value is made
} In;

// what stands in for a value that is not made, when only the rules are checked
static Json noValue = { .type = JSON_NULL }, noList = { .type = JSON_ARRAY }, noMap = { .type = JSON_OBJECT }, noStand = { .type = JSON_STAND };
static char noText[1];

static bool fail(In *in, size_t at, const char *why) {
	if (!in->why) in->why = why, in->whyAt = at;
	return false;
}

static size_t left(const In *in) {
	return in->length - in->at;
}

static uint64_t getBig(In *in, int count) {
	uint64_t number = 0;
	for (int i = 0; i < count; i++) number = (number << 8) | in->data[in->at++];
	return number;
}

/** a head of major type 0 to 6, its argument in its shortest form; the initial byte is read */
static bool getArgument(In *in, size_t start, unsigned info, uint64_t *argument) {
	static const int sizes[4] = { 1, 2, 4, 8 };
	static const uint64_t least[4] = { 24, 0x100, 0x10000, UINT64_C(0x100000000) };
	if (info < 24) {
		*argument = info;
		return true;
	}
	if (info == 31) return fail(in, start, "an indefinite length");
	if (info > 27) return fail(in, start, "a reserved additional information");
	int k = (int)info - 24;
	if (left(in) < (size_t)sizes[k]) return fail(in, start, "the input ends in a head");
	*argument = getBig(in, sizes[k]);
	if (*argument < least[k]) return fail(in, start, "a head longer than it need be");
	return true;
}

/** a byte or text string's length, at most what is left */
static bool getLength(In *in, size_t start, unsigned info, size_t *length) {
	uint64_t argument;
	if (!getArgument(in, start, info, &argument)) return false;
	if (argument > left(in)) return fail(in, start, "a string longer than the input");
	*length = (size_t)argument;
	return true;
}

/** a text string's contents (its head read) as json.h holds text: a fresh buffer, 00 as C0 80, a NUL after (noText when nothing is built) */
static char *getText(In *in, size_t start, size_t length, size_t *held) {
	const unsigned char *s = in->data + in->at;
	if (!isUtf8(s, length, false)) {
		fail(in, start, "text that is not UTF-8");
		return NULL;
	}
	if (!in->build) {
		in->at += length;
		*held = length;
		return noText;
	}
	size_t zeros = 0;
	for (size_t i = 0; i < length; i++) zeros += s[i] == 0;
	char *text = allocate(length + zeros + 1);
	size_t o = 0;
	for (size_t i = 0; i < length; i++) {
		if (s[i] == 0) text[o++] = (char)0xc0, text[o++] = (char)0x80;
		else text[o++] = (char)s[i];
	}
	text[o] = 0;
	in->at += length;
	*held = o;
	return text;
}

static Json *getTyped(In *in, size_t start, uint64_t tag) {
	int kind = -1;
	for (int k = 0; k < JSON_KINDS; k++)
		if (kindTags[k] == tag) kind = k;
	if (kind < 0) return fail(in, start, "an unknown tag"), NULL;
	size_t inner = in->at;
	if (!left(in)) return fail(in, inner, "the input ends after a tag"), NULL;
	unsigned initial = in->data[in->at++];
	if (initial >> 5 != 2) return fail(in, inner, "a typed array that is not over a byte string"), NULL;
	size_t length, size = jsonKindSize((JsonKind)kind);
	if (!getLength(in, inner, initial & 31, &length)) return NULL;
	if (length % size) return fail(in, inner, "a typed array that is not whole elements"), NULL;
	size_t count = length / size;
	unsigned char *data = in->build ? allocate(length) : NULL;
	const unsigned char *s = in->data + in->at;
	for (size_t i = 0; i < count; i++) {
		uint64_t bits = 0;
		for (size_t k = 0; k < size; k++) bits |= (uint64_t)s[i * size + k] << (8 * k);
		if ((kind == JSON_FLOAT32 && (bits & 0x7f800000u) == 0x7f800000u && (bits & 0x7fffffu) && bits != NAN32) ||
		    (kind == JSON_FLOAT64 && (bits & UINT64_C(0x7ff0000000000000)) == UINT64_C(0x7ff0000000000000) &&
		     (bits & UINT64_C(0xfffffffffffff)) && bits != NAN64)) {
			free(data);
			return fail(in, in->at + i * size, "a NaN element other than the one NaN"), NULL;
		}
		// the element's bits, as the machine holds that kind
		if (!in->build) continue;
		if (size == 1) data[i] = (unsigned char)bits;
		else if (size == 2) memcpy(data + i * size, &(uint16_t){ (uint16_t)bits }, 2);
		else if (size == 4) memcpy(data + i * size, &(uint32_t){ (uint32_t)bits }, 4);
		else memcpy(data + i * size, &bits, 8);
	}
	in->at += length;
	if (!in->build) return &noValue;
	Json *value = jsonTyped((JsonKind)kind, NULL, 0);
	free(value->typed.data);
	value->typed.data = data;
	value->typed.count = count;
	return value;
}

/** a bignum's byte string (its tag read): more than 8 bytes (a plain integer holds the rest), no leading zero */
static Json *getBignum(In *in, size_t start, bool negative) {
	size_t inner = in->at, length;
	if (!left(in)) return fail(in, inner, "the input ends after a tag"), NULL;
	unsigned initial = in->data[in->at++];
	if (initial >> 5 != 2) return fail(in, inner, "a bignum that is not over a byte string"), NULL;
	if (!getLength(in, inner, initial & 31, &length)) return NULL;
	const unsigned char *m = in->data + in->at;
	if (length <= 8) return fail(in, start, "a bignum a plain integer holds"), NULL;
	if (!m[0]) return fail(in, start, "a bignum with a leading zero"), NULL;
	in->at += length;
	if (!in->build) return &noValue;
	if (!negative) return jsonWhole(false, m, length);
	// -1 - n: the magnitude is n + 1
	unsigned char *more = allocate(length + 1);
	memcpy(more + 1, m, length);
	for (size_t i = length + 1; i-- > 0;) {
		if (++more[i]) break;
	}
	Json *value = jsonWhole(true, more, length + 1);
	free(more);
	return value;
}

static Json *getSimple(In *in, size_t start, unsigned info) {
	if (info == 20) return in->build ? jsonBoolean(false) : &noValue;
	if (info == 21) return in->build ? jsonBoolean(true) : &noValue;
	if (info == 22) return in->build ? jsonNull() : &noValue;
	if (info < 25 || info > 27) return fail(in, start, "a simple value that is not false, true or null"), NULL;
	int size = info == 25 ? 2 : info == 26 ? 4 : 8;
	if (left(in) < (size_t)size) return fail(in, start, "the input ends in a number"), NULL;
	uint64_t bits = getBig(in, size);
	uint16_t half;
	double d;
	if (size == 2) {
		d = halfValue((uint16_t)bits);
		if (isnan(d) && bits != NAN16) return fail(in, start, "a NaN other than f97e00"), NULL;
	} else if (size == 4) {
		float f;
		uint32_t word = (uint32_t)bits;
		memcpy(&f, &word, 4);
		d = f;
		if (isnan(d)) return fail(in, start, "a NaN other than f97e00"), NULL;
		if (halfOf(d, &half)) return fail(in, start, "a single a half holds"), NULL;
	} else {
		memcpy(&d, &bits, 8);
		if (isnan(d)) return fail(in, start, "a NaN other than f97e00"), NULL;
		if (fitsFloat(d)) return fail(in, start, "a double a shorter float holds"), NULL;
	}
	if (isfinite(d) && floor(d) == d) return fail(in, start, "a whole number written as a float"), NULL;
	return in->build ? jsonNumber(d) : &noValue;
}

/**
 * One item, made: a scalar, bytes, a typed array, or a list or map with
 * nothing in it yet, whose count is put in *count (-1 for anything else).
 */
static Json *getItem(In *in, int64_t *count) {
	size_t start = in->at;
	*count = -1;
	if (!left(in)) return fail(in, start, "the input ends where an item should be"), NULL;
	unsigned initial = in->data[in->at++], major = initial >> 5, info = initial & 31;
	uint64_t argument;
	size_t length;
	switch (major) {
		case 0:
		case 1: {
			if (!getArgument(in, start, info, &argument)) return NULL;
			if (!in->build) return &noValue;
			if (major == 0) return jsonUnsigned(argument);
			// -1 - argument: its magnitude is argument + 1, 2^64 at most
			unsigned char m[9];
			size_t n = whole_of_u64(argument, m + 1);
			memmove(m + 1 + (8 - n), m + 1, n); // right-aligned in m[1..8]
			memset(m + 1, 0, 8 - n);
			m[0] = 0;
			for (int i = 8; i >= 0; i--) {
				if (++m[i]) break;
			}
			return jsonWhole(true, m, 9);
		}
		case 2:
			if (!getLength(in, start, info, &length)) return NULL;
			in->at += length;
			return in->build ? jsonBytes(in->data + in->at - length, length) : &noValue;
		case 3: {
			if (!getLength(in, start, info, &length)) return NULL;
			size_t held;
			char *text = getText(in, start, length, &held);
			if (!text) return NULL;
			return in->build ? jsonStringTaking(text, held) : &noValue;
		}
		case 4:
		case 5:
			if (!getArgument(in, start, info, &argument)) return NULL;
			// every item is at least a byte: no more than the input can hold
			if (argument > INT_MAX || argument > left(in) / (major == 5 ? 2 : 1)) return fail(in, start, "more items than the input holds"), NULL;
			*count = (int64_t)argument;
			if (!in->build) return major == 4 ? &noList : &noMap;
			return major == 4 ? jsonArray() : jsonObject();
		case 6:
			if (!getArgument(in, start, info, &argument)) return NULL;
			if (argument == STAND) {
				*count = 1;
				return in->build ? jsonStand(NULL) : &noStand;
			}
			if (argument == 2 || argument == 3) return getBignum(in, start, argument == 3);
			return getTyped(in, start, argument);
		default: return getSimple(in, start, info);
	}
}

/** a list or map being filled: how many members it still wants, the key read for the next, the last key's bytes */
typedef struct Filling {
	Json *container;
	int64_t left;
	char *key;
	size_t keyLength;
	size_t lastStart, lastEnd; // the last key's encoding in the input; lastEnd 0 when none
} Filling;

// No recursion: the lists and maps being filled are kept on a stack of their own.
// One walk for both ways in: with `build` false it holds every rule and makes
// nothing (the root is then noValue, not to be freed).
static Json *decode(const unsigned char *data, size_t length, const char **why, size_t *at, bool build) {
	In in = { data, length, 0, NULL, 0, build };
	Filling *stack = NULL;
	int depth = 0, room = 0;
	Json *root = NULL;
	bool ok = true;
	while (ok) {
		Filling *top = depth ? &stack[depth - 1] : NULL;
		if (top && top->container->type == JSON_OBJECT && !top->key) {
			// a key: a text string after the last key in encoding order
			size_t start = in.at, textLength;
			if (!left(&in)) ok = fail(&in, start, "the input ends where a key should be");
			else if (in.data[in.at] >> 5 != 3) ok = fail(&in, start, "a key that is not a text string");
			else if (in.at++, !getLength(&in, start, in.data[start] & 31, &textLength)) ok = false;
			else if (!(top->key = getText(&in, start, textLength, &top->keyLength))) ok = false;
			if (ok && top->lastEnd) {
				size_t was = top->lastEnd - top->lastStart, is = in.at - start;
				int order = memcmp(in.data + top->lastStart, in.data + start, was < is ? was : is);
				if (order > 0 || (order == 0 && was >= is)) ok = fail(&in, start, "a key not after the key before it");
			}
			if (ok) top->lastStart = start, top->lastEnd = in.at;
			continue;
		}
		int64_t count;
		size_t start = in.at;
		Json *item = getItem(&in, &count);
		if (!item) {
			ok = false;
			break;
		}
		// a container inside CBOR_DEPTH others
		if (depth >= CBOR_DEPTH && (item->type == JSON_ARRAY || item->type == JSON_OBJECT || item->type == JSON_STAND)) {
			if (build) jsonFree(item);
			ok = fail(&in, start, "nested deeper than " CBOR_DEPTH_TEXT);
			break;
		}
		if (!top) {
			root = item;
		} else if (top->container->type == JSON_STAND) {
			if (build) top->container->stand.kind = item;
			top->left--;
		} else if (top->container->type == JSON_ARRAY) {
			if (build) jsonPush(top->container, item);
			top->left--;
		} else {
			if (build) jsonAddTaking(top->container, top->key, top->keyLength, item);
			top->key = NULL;
			top->left--;
		}
		if (count > 0) {
			stack = growArray(stack, depth, &room, sizeof *stack);
			stack[depth++] = (Filling){ item, count, NULL, 0, 0, 0 };
		}
		while (depth && !stack[depth - 1].left) depth--;
		if (!depth) break;
	}
	if (ok && in.at != in.length) ok = fail(&in, in.at, "bytes after the value");
	for (int i = 0; i < depth; i++)
		if (build) free(stack[i].key);
	free(stack);
	if (!ok) {
		if (build) jsonFree(root);
		root = NULL;
		if (why) *why = in.why;
		if (at) *at = in.whyAt;
	}
	return root;
}

Json *cborDecode(const unsigned char *data, size_t length, const char **why, size_t *at) {
	return decode(data, length, why, at, true);
}

bool cborCheck(const unsigned char *data, size_t length, const char **why, size_t *at) {
	return decode(data, length, why, at, false) != NULL;
}
