// json.c: the JSON value, parser, printer, equality and code point helpers.
// See json.h. Owner: the skeleton (done).

#include "json.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// memory -----------------------------------------------------------------------

void *allocate(size_t size) {
	void *memory = calloc(1, size ? size : 1);
	if (!memory) {
		fputs("out of memory\n", stderr);
		abort();
	}
	return memory;
}

char *copyStringOfLength(const char *text, size_t length) {
	char *copy = allocate(length + 1);
	memcpy(copy, text, length);
	return copy;
}

char *copyString(const char *text) {
	return copyStringOfLength(text, strlen(text));
}

static char *vformat(const char *format, va_list arguments) {
	va_list again;
	va_copy(again, arguments);
	int length = vsnprintf(NULL, 0, format, arguments);
	char *text = allocate((size_t)length + 1);
	vsnprintf(text, (size_t)length + 1, format, again);
	va_end(again);
	return text;
}

char *formatString(const char *format, ...) {
	va_list arguments;
	va_start(arguments, format);
	char *text = vformat(format, arguments);
	va_end(arguments);
	return text;
}

void *growArray(void *items, int count, int *capacity, size_t size) {
	if (count < *capacity) return items;
	int grown = *capacity ? *capacity * 2 : 4;
	while (grown <= count) grown *= 2;
	void *moved = realloc(items, (size_t)grown * size);
	if (!moved) {
		fputs("out of memory\n", stderr);
		abort();
	}
	memset((char *)moved + (size_t)*capacity * size, 0, (size_t)(grown - *capacity) * size);
	*capacity = grown;
	return moved;
}

// making values ----------------------------------------------------------------

static Json *make(JsonType type) {
	Json *value = allocate(sizeof *value);
	value->type = type;
	return value;
}

Json *jsonNull(void) {
	return make(JSON_NULL);
}

Json *jsonBoolean(bool boolean) {
	Json *value = make(JSON_BOOLEAN);
	value->boolean = boolean;
	return value;
}

Json *jsonNumber(double number) {
	Json *value = make(JSON_NUMBER);
	value->number = number;
	return value;
}

Json *jsonInteger(int64_t number) {
	return jsonNumber((double)number);
}

Json *jsonString(const char *text) {
	return jsonStringOfLength(text, strlen(text));
}

Json *jsonStringOfLength(const char *text, size_t length) {
	Json *value = make(JSON_STRING);
	value->string = copyStringOfLength(text, length);
	value->stringLength = length;
	return value;
}

Json *jsonArray(void) {
	return make(JSON_ARRAY);
}

Json *jsonObject(void) {
	return make(JSON_OBJECT);
}

static const size_t kindSizes[JSON_KINDS] = { 1, 1, 2, 2, 4, 4, 8, 8, 4, 8 };
static const char *const kindNames[JSON_KINDS] = { "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64" };

size_t jsonKindSize(JsonKind kind) {
	return kindSizes[kind];
}

Json *jsonBytes(const void *data, size_t length) {
	Json *value = make(JSON_BYTES);
	value->bytes.data = allocate(length);
	if (length) memcpy(value->bytes.data, data, length);
	value->bytes.length = length;
	return value;
}

Json *jsonTyped(JsonKind kind, const void *data, size_t count) {
	Json *value = make(JSON_TYPED);
	value->typed.kind = kind;
	value->typed.data = allocate(count * kindSizes[kind]);
	if (count) memcpy(value->typed.data, data, count * kindSizes[kind]);
	value->typed.count = count;
	return value;
}

Json *jsonLive(const char *kind) {
	Json *value = jsonString(kind);
	value->type = JSON_LIVE;
	return value;
}

void jsonPush(Json *array, Json *item) {
	array->array.items = growArray(array->array.items, array->array.count, &array->array.capacity, sizeof *array->array.items);
	array->array.items[array->array.count++] = item;
}

void jsonAdd(Json *object, const char *key, Json *value) {
	jsonAddOfLength(object, key, strlen(key), value);
}

void jsonAddOfLength(Json *object, const char *key, size_t length, Json *value) {
	object->object.members = growArray(object->object.members, object->object.count, &object->object.capacity, sizeof *object->object.members);
	JsonMember *member = &object->object.members[object->object.count++];
	member->key = copyStringOfLength(key, length);
	member->keyLength = length;
	member->value = value;
}

/** the index of the member under a key of `length` bytes, or -1 */
static int memberIndex(const Json *object, const char *key, size_t length) {
	if (!object || object->type != JSON_OBJECT) return -1;
	for (int i = 0; i < object->object.count; i++) {
		const JsonMember *member = &object->object.members[i];
		if (member->keyLength == length && memcmp(member->key, key, length) == 0) return i;
	}
	return -1;
}

void jsonSet(Json *object, const char *key, size_t length, Json *value) {
	int at = memberIndex(object, key, length);
	if (at >= 0) object->object.members[at].value = value;
	else jsonAddOfLength(object, key, length, value);
}

bool jsonRemove(Json *object, const char *key, size_t length) {
	int at = memberIndex(object, key, length);
	if (at < 0) return false;
	// the key is not freed: a shallow copy may share it
	memmove(&object->object.members[at], &object->object.members[at + 1], (size_t)(object->object.count - at - 1) * sizeof *object->object.members);
	object->object.count--;
	return true;
}

Json *jsonShallow(const Json *value) {
	Json *copy = make(value->type);
	switch (value->type) {
		case JSON_ARRAY:
			for (int i = 0; i < value->array.count; i++) jsonPush(copy, value->array.items[i]);
			break;
		case JSON_OBJECT:
			for (int i = 0; i < value->object.count; i++) {
				const JsonMember *member = &value->object.members[i];
				jsonAddOfLength(copy, member->key, member->keyLength, member->value);
			}
			break;
		case JSON_STRING:
			copy->string = copyStringOfLength(value->string, value->stringLength);
			copy->stringLength = value->stringLength;
			break;
		case JSON_BYTES:
			jsonFree(copy);
			return jsonBytes(value->bytes.data, value->bytes.length);
		case JSON_TYPED:
			jsonFree(copy);
			return jsonTyped(value->typed.kind, value->typed.data, value->typed.count);
		case JSON_LIVE:
			jsonFree(copy);
			return (Json *)value; // a live value is the one thing it is
		default:
			*copy = *value;
			break;
	}
	return copy;
}

/** a stack of values, for the walks below that would otherwise recurse once per level */
typedef struct Stack {
	const Json **items;
	int count;
	int capacity;
} Stack;

static void push(Stack *stack, const Json *value) {
	stack->items = growArray(stack->items, stack->count, &stack->capacity, sizeof *stack->items);
	stack->items[stack->count++] = value;
}

void jsonFree(Json *value) {
	Stack stack = { NULL, 0, 0 };
	if (value) push(&stack, value);
	while (stack.count) {
		Json *at = (Json *)stack.items[--stack.count];
		if (at->type == JSON_STRING || at->type == JSON_LIVE) {
			free(at->string);
		} else if (at->type == JSON_BYTES) {
			free(at->bytes.data);
		} else if (at->type == JSON_TYPED) {
			free(at->typed.data);
		} else if (at->type == JSON_ARRAY) {
			for (int i = 0; i < at->array.count; i++) push(&stack, at->array.items[i]);
			free(at->array.items);
		} else if (at->type == JSON_OBJECT) {
			for (int i = 0; i < at->object.count; i++) {
				free(at->object.members[i].key);
				push(&stack, at->object.members[i].value);
			}
			free(at->object.members);
		}
		free(at);
	}
	free(stack.items);
}

// reading values ---------------------------------------------------------------

Json *jsonGetOfLength(const Json *object, const char *key, size_t length) {
	int at = memberIndex(object, key, length);
	return at >= 0 ? object->object.members[at].value : NULL;
}

Json *jsonGet(const Json *object, const char *key) {
	return jsonGetOfLength(object, key, strlen(key));
}

bool jsonIsObject(const Json *value) {
	return value && value->type == JSON_OBJECT;
}

bool jsonIsArray(const Json *value) {
	return value && value->type == JSON_ARRAY;
}

bool jsonIsString(const Json *value) {
	return value && value->type == JSON_STRING;
}

bool jsonIsNumber(const Json *value) {
	return value && value->type == JSON_NUMBER;
}

const char *jsonText(const Json *value) {
	if (!jsonIsString(value) || strlen(value->string) != value->stringLength) return NULL;
	return value->string;
}

bool jsonIsWhole(const Json *value, int64_t *out) {
	if (!jsonIsNumber(value)) return false;
	double number = value->number, edge = 9223372036854775808.0; // 2^63
	if (!isfinite(number) || floor(number) != number) return false;
	if (out) *out = number >= edge ? INT64_MAX : number < -edge ? INT64_MIN : (int64_t)number;
	return true;
}

bool jsonSameNumber(double a, double b) {
	if (isnan(a) || isnan(b)) return isnan(a) && isnan(b);
	return a == b && signbit(a) == signbit(b);
}

/** two typed arrays of one kind, element by element as numbers are: floats as Object.is has them, integers by value */
static bool sameElements(const Json *x, const Json *y) {
	if (x->typed.kind != y->typed.kind || x->typed.count != y->typed.count) return false;
	for (size_t i = 0; i < x->typed.count; i++) {
		if (x->typed.kind == JSON_FLOAT32) {
			if (!jsonSameNumber(((float *)x->typed.data)[i], ((float *)y->typed.data)[i])) return false;
		} else if (x->typed.kind == JSON_FLOAT64) {
			if (!jsonSameNumber(((double *)x->typed.data)[i], ((double *)y->typed.data)[i])) return false;
		}
	}
	if (x->typed.kind == JSON_FLOAT32 || x->typed.kind == JSON_FLOAT64) return true;
	return !x->typed.count || memcmp(x->typed.data, y->typed.data, x->typed.count * kindSizes[x->typed.kind]) == 0;
}

bool jsonEqual(const Json *a, const Json *b) {
	// pairs to compare, two entries each
	Stack stack = { NULL, 0, 0 };
	push(&stack, a);
	push(&stack, b);
	bool equal = true;
	while (equal && stack.count) {
		const Json *y = stack.items[--stack.count], *x = stack.items[--stack.count];
		if (!x || !y) {
			equal = x == y;
		} else if (x->type != y->type) {
			equal = false;
		} else if (x->type == JSON_BOOLEAN) {
			equal = x->boolean == y->boolean;
		} else if (x->type == JSON_NUMBER) {
			equal = jsonSameNumber(x->number, y->number);
		} else if (x->type == JSON_BYTES) {
			equal = x->bytes.length == y->bytes.length && (!x->bytes.length || memcmp(x->bytes.data, y->bytes.data, x->bytes.length) == 0);
		} else if (x->type == JSON_TYPED) {
			equal = sameElements(x, y);
		} else if (x->type == JSON_LIVE) {
			equal = x == y;
		} else if (x->type == JSON_STRING) {
			equal = x->stringLength == y->stringLength && memcmp(x->string, y->string, x->stringLength) == 0;
		} else if (x->type == JSON_ARRAY) {
			equal = x->array.count == y->array.count;
			for (int i = 0; equal && i < x->array.count; i++) {
				push(&stack, x->array.items[i]);
				push(&stack, y->array.items[i]);
			}
		} else if (x->type == JSON_OBJECT) {
			equal = x->object.count == y->object.count;
			for (int i = 0; equal && i < x->object.count; i++) {
				const JsonMember *member = &x->object.members[i];
				const Json *other = jsonGetOfLength(y, member->key, member->keyLength);
				equal = other != NULL;
				push(&stack, member->value);
				push(&stack, other);
			}
		}
	}
	free(stack.items);
	return equal;
}

// values in JSON (PROTOCOL Values in JSON) ---------------------------------------

static const char base64Digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int base64Digit(char c) {
	const char *at = c ? strchr(base64Digits, c) : NULL;
	return at ? (int)(at - base64Digits) : -1;
}

/** bytes from base64, standard alphabet, no padding, in the one spelling of those bytes (the bits past the last octet zero); NULL otherwise */
static Json *bytesOf(const Json *text) {
	if (!jsonIsString(text) || text->stringLength % 4 == 1) return NULL;
	size_t n = text->stringLength, k = 0;
	unsigned char *out = allocate(n / 4 * 3 + 2);
	uint32_t bits = 0;
	int held = 0;
	for (size_t i = 0; i < n; i++) {
		int digit = base64Digit(text->string[i]);
		if (digit < 0) {
			free(out);
			return NULL;
		}
		bits = (bits << 6) | (uint32_t)digit;
		held += 6;
		if (held >= 8) {
			held -= 8;
			out[k++] = (unsigned char)(bits >> held);
		}
		bits &= (1u << held) - 1;
	}
	Json *value = bits ? NULL : jsonBytes(out, k);
	free(out);
	return value;
}

/** NaN, Infinity or -Infinity, the words JSON has no number for; false for anything else */
static bool numberWord(const Json *word, double *out) {
	const char *text = jsonText(word);
	if (!text) return false;
	if (strcmp(text, "NaN") == 0) *out = NAN;
	else if (strcmp(text, "Infinity") == 0) *out = INFINITY;
	else if (strcmp(text, "-Infinity") == 0) *out = -INFINITY;
	else return false;
	return true;
}

/** a 64-bit element: a decimal string, -?(0|[1-9][0-9]*), in range for its kind */
static bool decimalOf(const Json *element, bool sign, void *out) {
	const char *text = jsonText(element);
	if (!text) return false;
	bool negative = *text == '-';
	if (negative) text++;
	if (!*text || (text[0] == '0' && text[1])) return false;
	uint64_t magnitude = 0;
	for (; *text; text++) {
		if (*text < '0' || *text > '9') return false;
		unsigned digit = (unsigned)(*text - '0');
		if (magnitude > (UINT64_MAX - digit) / 10) return false;
		magnitude = magnitude * 10 + digit;
	}
	if (!sign) {
		if (negative && magnitude) return false;
		*(uint64_t *)out = magnitude;
		return true;
	}
	if (magnitude > (negative ? (uint64_t)INT64_MAX + 1 : (uint64_t)INT64_MAX)) return false;
	*(int64_t *)out = negative ? (magnitude == (uint64_t)INT64_MAX + 1 ? INT64_MIN : -(int64_t)magnitude) : (int64_t)magnitude;
	return true;
}

/** one element of a typed array of the kind, into *out as the kind's C type; false when it is out of range, a fraction in an integer kind, or of the wrong shape */
static bool elementOf(JsonKind kind, const Json *element, void *out) {
	static const double least[] = { -128, 0, -32768, 0, -2147483648.0, 0 };
	static const double most[] = { 127, 255, 32767, 65535, 2147483647.0, 4294967295.0 };
	if (kind == JSON_INT64 || kind == JSON_UINT64) return decimalOf(element, kind == JSON_INT64, out);
	double number;
	if (jsonIsNumber(element)) number = element->number;
	else if (kind < JSON_FLOAT32 || !numberWord(element, &number)) return false;
	if (kind == JSON_FLOAT64) {
		*(double *)out = number;
	} else if (kind == JSON_FLOAT32) {
		// a float32 out of range rounds to an infinity, which only a word may give
		if (isfinite(number) && fabs(number) >= 0x1.ffffffp+127) return false;
		*(float *)out = (float)number;
	} else {
		if (!isfinite(number) || floor(number) != number || number < least[kind] || number > most[kind]) return false;
		switch (kind) {
			case JSON_INT8: *(int8_t *)out = (int8_t)number; break;
			case JSON_UINT8: *(uint8_t *)out = (uint8_t)number; break;
			case JSON_INT16: *(int16_t *)out = (int16_t)number; break;
			case JSON_UINT16: *(uint16_t *)out = (uint16_t)number; break;
			case JSON_INT32: *(int32_t *)out = (int32_t)number; break;
			default: *(uint32_t *)out = (uint32_t)number; break;
		}
	}
	return true;
}

/** a typed array from its kind's name and its elements; NULL when either is wrong */
static Json *typedOf(const char *name, size_t nameLength, const Json *elements) {
	int kind = 0;
	while (kind < JSON_KINDS && !(strlen(kindNames[kind]) == nameLength && memcmp(kindNames[kind], name, nameLength) == 0)) kind++;
	if (kind == JSON_KINDS || !jsonIsArray(elements)) return NULL;
	Json *value = jsonTyped((JsonKind)kind, NULL, 0);
	free(value->typed.data);
	value->typed.data = allocate((size_t)elements->array.count * kindSizes[kind]);
	value->typed.count = (size_t)elements->array.count;
	for (int i = 0; i < elements->array.count; i++) {
		if (!elementOf((JsonKind)kind, elements->array.items[i], (char *)value->typed.data + (size_t)i * kindSizes[kind])) {
			jsonFree(value);
			return NULL;
		}
	}
	return value;
}

static bool isKey(const JsonMember *member, const char *key) {
	return member->keyLength == strlen(key) && memcmp(member->key, key, member->keyLength) == 0;
}

/** an object whose only key is "/" */
static bool isSlashMap(const Json *value) {
	return jsonIsObject(value) && value->object.count == 1 && isKey(&value->object.members[0], "/");
}

/** the value one "/" form other than map stands for: bytes, a number, a live value (when `live`), or a typed array; NULL when malformed */
static Json *formOf(const JsonMember *form, bool live) {
	double number;
	if (isKey(form, "bytes")) return bytesOf(form->value);
	if (isKey(form, "number")) return numberWord(form->value, &number) ? jsonNumber(number) : NULL;
	if (isKey(form, "live")) return live && jsonIsString(form->value) ? jsonLive(form->value->string) : NULL;
	return typedOf(form->key, form->keyLength, form->value);
}

// No recursion: the places still to decode are kept on a stack of their own.
bool jsonDecode(Json **value, bool live) {
	Json ***stack = NULL;
	int count = 0, capacity = 0;
	stack = growArray(stack, count, &capacity, sizeof *stack);
	stack[count++] = value;
	bool ok = true;
	while (ok && count) {
		Json **at = stack[--count], *here = *at;
		if (jsonIsArray(here)) {
			for (int i = 0; i < here->array.count; i++) {
				stack = growArray(stack, count, &capacity, sizeof *stack);
				stack[count++] = &here->array.items[i];
			}
		} else if (isSlashMap(here)) {
			// one of the forms: a map with one key, the form's name
			Json *form = here->object.members[0].value;
			if (!jsonIsObject(form) || form->object.count != 1) {
				ok = false;
			} else if (isKey(&form->object.members[0], "map")) {
				// a map whose only key is "/", as data: its value is decoded in turn
				Json *map = form->object.members[0].value;
				ok = isSlashMap(map);
				if (ok) {
					*at = map;
					stack = growArray(stack, count, &capacity, sizeof *stack);
					stack[count++] = &map->object.members[0].value;
				}
			} else {
				Json *made = formOf(&form->object.members[0], live && at == value);
				ok = made != NULL;
				if (ok) *at = made;
			}
		} else if (jsonIsObject(here)) {
			for (int i = 0; i < here->object.count; i++) {
				stack = growArray(stack, count, &capacity, sizeof *stack);
				stack[count++] = &here->object.members[i].value;
			}
		}
	}
	free(stack);
	return ok;
}

// code points ------------------------------------------------------------------
// Every code point starts with a byte that is not a continuation byte
// (10xxxxxx), in UTF-8 and in the WTF-8 a lone surrogate is held as.

static bool isContinuation(unsigned char byte) {
	return (byte & 0xc0) == 0x80;
}

size_t utf8Count(const char *text, size_t length) {
	size_t count = 0;
	for (size_t i = 0; i < length; i++) {
		if (!isContinuation((unsigned char)text[i])) count++;
	}
	return count;
}

size_t utf8Offset(const char *text, size_t length, size_t index) {
	size_t seen = 0;
	for (size_t i = 0; i < length; i++) {
		if (!isContinuation((unsigned char)text[i])) {
			if (seen == index) return i;
			seen++;
		}
	}
	return length;
}

/** the byte at text[*at] as it would be in plain UTF-8: U+0000, held as C0 80, is 0 */
static int plainByte(const unsigned char *text, size_t length, size_t *at) {
	if (text[*at] == 0xc0 && *at + 1 < length && text[*at + 1] == 0x80) {
		*at += 2;
		return 0;
	}
	return text[(*at)++];
}

int utf8Compare(const char *a, size_t aLength, const char *b, size_t bLength) {
	// plain UTF-8 byte order is code point order; only the C0 80 of U+0000 differs
	const unsigned char *x = (const unsigned char *)a, *y = (const unsigned char *)b;
	size_t i = 0, j = 0;
	while (i < aLength && j < bLength) {
		int order = plainByte(x, aLength, &i) - plainByte(y, bLength, &j);
		if (order) return order;
	}
	return i < aLength ? 1 : j < bLength ? -1 : 0;
}

int textCompare(const char *a, const char *b) {
	return utf8Compare(a, strlen(a), b, strlen(b));
}

/** the length of the well-formed UTF-8 sequence at text[0], or 0 */
static size_t utf8SequenceLength(const unsigned char *text, size_t available) {
	unsigned char lead = text[0];
	size_t length;
	uint32_t least;
	if (lead < 0x80) return 1;
	if (lead >= 0xc2 && lead <= 0xdf) {
		length = 2;
		least = 0x80;
	} else if (lead >= 0xe0 && lead <= 0xef) {
		length = 3;
		least = 0x800;
	} else if (lead >= 0xf0 && lead <= 0xf4) {
		length = 4;
		least = 0x10000;
	} else {
		return 0;
	}
	if (available < length) return 0;
	uint32_t code = lead & (0xff >> (length + 1));
	for (size_t i = 1; i < length; i++) {
		if (!isContinuation(text[i])) return 0;
		code = (code << 6) | (text[i] & 0x3f);
	}
	if (code < least || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
	return length;
}

/** writes a code point (a surrogate too, as WTF-8) as UTF-8; returns how many bytes */
static int utf8Encode(uint32_t code, char *out) {
	if (code < 0x80) {
		out[0] = (char)code;
		return 1;
	}
	if (code < 0x800) {
		out[0] = (char)(0xc0 | (code >> 6));
		out[1] = (char)(0x80 | (code & 0x3f));
		return 2;
	}
	if (code < 0x10000) {
		out[0] = (char)(0xe0 | (code >> 12));
		out[1] = (char)(0x80 | ((code >> 6) & 0x3f));
		out[2] = (char)(0x80 | (code & 0x3f));
		return 3;
	}
	out[0] = (char)(0xf0 | (code >> 18));
	out[1] = (char)(0x80 | ((code >> 12) & 0x3f));
	out[2] = (char)(0x80 | ((code >> 6) & 0x3f));
	out[3] = (char)(0x80 | (code & 0x3f));
	return 4;
}

// the parser -------------------------------------------------------------------

typedef struct Parser {
	const unsigned char *text;
	size_t length;
	size_t at;
	char *why;
} Parser;

typedef struct Bytes {
	char *text;
	int count;
	int capacity;
} Bytes;

static void putBytes(Bytes *bytes, const char *text, size_t length) {
	bytes->text = growArray(bytes->text, bytes->count + (int)length, &bytes->capacity, 1);
	memcpy(bytes->text + bytes->count, text, length);
	bytes->count += (int)length;
}

static void fail(Parser *parser, const char *why) {
	if (!parser->why) parser->why = formatString("%s at byte %zu", why, parser->at);
}

static void skipWhitespace(Parser *parser) {
	while (parser->at < parser->length) {
		unsigned char c = parser->text[parser->at];
		if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
		parser->at++;
	}
}

static unsigned char peek(Parser *parser) {
	return parser->at < parser->length ? parser->text[parser->at] : 0;
}

static Json *parseWord(Parser *parser, const char *word, Json *value) {
	size_t length = strlen(word);
	if (parser->at + length <= parser->length && memcmp(parser->text + parser->at, word, length) == 0) {
		parser->at += length;
		return value;
	}
	jsonFree(value);
	fail(parser, "unexpected word");
	return NULL;
}

static bool isDigit(unsigned char c) {
	return c >= '0' && c <= '9';
}

static Json *parseNumber(Parser *parser) {
	size_t start = parser->at;
	if (peek(parser) == '-') parser->at++;
	if (peek(parser) == '0') {
		parser->at++;
	} else if (isDigit(peek(parser))) {
		while (isDigit(peek(parser))) parser->at++;
	} else {
		fail(parser, "bad number");
		return NULL;
	}
	if (peek(parser) == '.') {
		parser->at++;
		if (!isDigit(peek(parser))) {
			fail(parser, "bad number");
			return NULL;
		}
		while (isDigit(peek(parser))) parser->at++;
	}
	if (peek(parser) == 'e' || peek(parser) == 'E') {
		parser->at++;
		if (peek(parser) == '+' || peek(parser) == '-') parser->at++;
		if (!isDigit(peek(parser))) {
			fail(parser, "bad number");
			return NULL;
		}
		while (isDigit(peek(parser))) parser->at++;
	}
	char *spelled = copyStringOfLength((const char *)parser->text + start, parser->at - start);
	double number = strtod(spelled, NULL);
	free(spelled);
	if (!isfinite(number)) {
		fail(parser, "a number no binary64 holds");
		return NULL;
	}
	return jsonNumber(number);
}

static int hexValue(unsigned char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	if (c >= 'A' && c <= 'F') return c - 'A' + 10;
	return -1;
}

/** four hex digits at the position, or -1 (the position is then unmoved) */
static int parseHex4(Parser *parser) {
	if (parser->at + 4 > parser->length) return -1;
	int code = 0;
	for (int i = 0; i < 4; i++) {
		int digit = hexValue(parser->text[parser->at + i]);
		if (digit < 0) return -1;
		code = code * 16 + digit;
	}
	parser->at += 4;
	return code;
}

/** the text of a string from its opening quote, NUL-terminated, and its length; NULL on failure */
static char *parseStringText(Parser *parser, size_t *length) {
	parser->at++;
	Bytes out = { NULL, 0, 0 };
	while (true) {
		if (parser->at >= parser->length) {
			fail(parser, "unterminated string");
			free(out.text);
			return NULL;
		}
		unsigned char c = parser->text[parser->at];
		if (c == '"') {
			parser->at++;
			break;
		}
		if (c < 0x20) {
			fail(parser, "a control character in a string");
			free(out.text);
			return NULL;
		}
		char encoded[4];
		int count = 0;
		if (c == '\\') {
			parser->at++;
			unsigned char escape = peek(parser);
			parser->at++;
			switch (escape) {
				case '"': encoded[0] = '"'; count = 1; break;
				case '\\': encoded[0] = '\\'; count = 1; break;
				case '/': encoded[0] = '/'; count = 1; break;
				case 'b': encoded[0] = '\b'; count = 1; break;
				case 'f': encoded[0] = '\f'; count = 1; break;
				case 'n': encoded[0] = '\n'; count = 1; break;
				case 'r': encoded[0] = '\r'; count = 1; break;
				case 't': encoded[0] = '\t'; count = 1; break;
				case 'u': {
					int code = parseHex4(parser);
					if (code < 0) {
						fail(parser, "bad \\u escape");
						free(out.text);
						return NULL;
					}
					if (code >= 0xd800 && code <= 0xdbff && parser->at + 6 <= parser->length && parser->text[parser->at] == '\\' && parser->text[parser->at + 1] == 'u') {
						// a high surrogate followed by a low one is one code point
						size_t before = parser->at;
						parser->at += 2;
						int low = parseHex4(parser);
						if (low >= 0xdc00 && low <= 0xdfff) {
							code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
						} else {
							parser->at = before; // a lone high surrogate; the next escape is its own
						}
					}
					if (code == 0) {
						// U+0000 is held as C0 80, so no string holds a NUL byte
						encoded[0] = (char)0xc0;
						encoded[1] = (char)0x80;
						count = 2;
					} else {
						count = utf8Encode((uint32_t)code, encoded); // a lone surrogate as WTF-8
					}
					break;
				}
				default:
					fail(parser, "bad escape");
					free(out.text);
					return NULL;
			}
		} else {
			size_t step = utf8SequenceLength(parser->text + parser->at, parser->length - parser->at);
			if (!step) {
				fail(parser, "a string that is not UTF-8");
				free(out.text);
				return NULL;
			}
			memcpy(encoded, parser->text + parser->at, step);
			count = (int)step;
			parser->at += step;
		}
		putBytes(&out, encoded, (size_t)count);
	}
	putBytes(&out, "", 1);
	*length = (size_t)out.count - 1;
	return out.text;
}

static Json *parseString(Parser *parser) {
	size_t length;
	char *text = parseStringText(parser, &length);
	if (!text) return NULL;
	Json *value = make(JSON_STRING);
	value->string = text;
	value->stringLength = length;
	return value;
}

/** a string, true, false, null or a number at the position; NULL (and a why) when there is none */
static Json *parseScalar(Parser *parser) {
	unsigned char c = peek(parser);
	switch (c) {
		case '"':
			return parseString(parser);
		case 't':
			return parseWord(parser, "true", jsonBoolean(true));
		case 'f':
			return parseWord(parser, "false", jsonBoolean(false));
		case 'n':
			return parseWord(parser, "null", jsonNull());
		default:
			if (c == '-' || isDigit(c)) return parseNumber(parser);
			fail(parser, parser->at >= parser->length ? "unexpected end" : "unexpected character");
			return NULL;
	}
}

/** a list or object being parsed, and the key of the member whose value comes next */
typedef struct Open {
	Json *container;
	char *key;
	size_t keyLength;
} Open;

/** an object's next key and its colon, into the open object */
static bool parseKey(Parser *parser, Open *open) {
	skipWhitespace(parser);
	if (peek(parser) != '"') {
		fail(parser, "expected a key");
		return false;
	}
	open->key = parseStringText(parser, &open->keyLength);
	if (!open->key) return false;
	skipWhitespace(parser);
	if (peek(parser) != ':') {
		fail(parser, "expected :");
		return false;
	}
	parser->at++;
	return true;
}

/** a whole value into the open list or object; a repeated key keeps the last value, as JSON.parse does */
static void putInto(Open *open, Json *value) {
	Json *container = open->container;
	if (container->type == JSON_ARRAY) {
		jsonPush(container, value);
		return;
	}
	int at = memberIndex(container, open->key, open->keyLength);
	if (at >= 0) {
		jsonFree(container->object.members[at].value);
		container->object.members[at].value = value;
	} else {
		jsonAddOfLength(container, open->key, open->keyLength, value);
	}
	free(open->key);
	open->key = NULL;
}

Json *jsonParse(const char *text, size_t length, char **why) {
	return jsonParseRead(text, length, why, NULL);
}

// No depth limit and no recursion: a line that is one JSON object is a
// request, however deep (JSON.parse takes it too), so the lists and objects
// being parsed are kept on a stack of their own.
Json *jsonParseRead(const char *text, size_t length, char **why, Json **read) {
	if (read) *read = NULL;
	Parser parser = { (const unsigned char *)text, length, 0, NULL };
	Open *opens = NULL;
	int depth = 0, capacity = 0;
	Json *value = NULL;
	for (;;) {
		// a value starts here: a scalar is whole at once, a list or object opens
		skipWhitespace(&parser);
		unsigned char c = peek(&parser);
		if (c == '[' || c == '{') {
			parser.at++;
			opens = growArray(opens, depth, &capacity, sizeof *opens);
			opens[depth++] = (Open){ c == '[' ? jsonArray() : jsonObject(), NULL, 0 };
			skipWhitespace(&parser);
			if (peek(&parser) == (c == '[' ? ']' : '}')) {
				parser.at++;
				value = opens[--depth].container;
			} else {
				if (c == '{' && !parseKey(&parser, &opens[depth - 1])) goto failed;
				continue;
			}
		} else if (!(value = parseScalar(&parser))) {
			goto failed;
		}
		// the value is whole: put it in its container, and close every container that ends after it
		for (;;) {
			if (depth == 0) goto parsed;
			Open *open = &opens[depth - 1];
			bool list = open->container->type == JSON_ARRAY;
			putInto(open, value);
			value = NULL;
			skipWhitespace(&parser);
			c = peek(&parser);
			if (c == ',') {
				parser.at++;
				if (!list && !parseKey(&parser, open)) goto failed;
				break;
			}
			if (c != (list ? ']' : '}')) {
				fail(&parser, list ? "expected , or ]" : "expected , or }");
				goto failed;
			}
			parser.at++;
			value = open->container;
			depth--;
		}
	}
parsed:
	skipWhitespace(&parser);
	if (parser.at == parser.length) {
		free(opens);
		free(parser.why);
		return value;
	}
	fail(&parser, "trailing characters");
failed:
	// the open containers are not yet in each other: each is freed on its own,
	// but for the outermost (or the whole value), when what was read is asked for
	if (read) *read = depth ? opens[0].container : value;
	if (!read || depth) jsonFree(value);
	for (int i = 0; i < depth; i++) {
		if (!read || i) jsonFree(opens[i].container);
		free(opens[i].key);
	}
	free(opens);
	*why = parser.why ? parser.why : copyString("unreadable");
	return NULL;
}

// the printer ------------------------------------------------------------------

void jsonNumberText(double number, char out[32]) {
	if (isnan(number) || isinf(number)) {
		strcpy(out, "null");
		return;
	}
	if (number == 0) {
		strcpy(out, "0"); // -0 too
		return;
	}
	// the fewest significant digits that read back as the same double
	char spelled[40];
	for (int precision = 1; precision <= 17; precision++) {
		snprintf(spelled, sizeof spelled, "%.*e", precision - 1, number);
		if (strtod(spelled, NULL) == number) break;
	}
	// spelled is [-]d[.ddd]e[+-]xx: take the digits and the exponent apart
	const char *at = spelled;
	bool negative = *at == '-';
	if (negative) at++;
	char digits[24];
	int k = 0;
	while (*at && *at != 'e') {
		if (*at != '.') digits[k++] = *at;
		at++;
	}
	while (k > 1 && digits[k - 1] == '0') k--;
	digits[k] = 0;
	int exponent = atoi(at + 1);
	int n = exponent + 1; // the value is 0.digits * 10^n
	char *o = out;
	if (negative) *o++ = '-';
	if (k <= n && n <= 21) {
		memcpy(o, digits, (size_t)k);
		o += k;
		for (int i = 0; i < n - k; i++) *o++ = '0';
	} else if (0 < n && n <= 21) {
		memcpy(o, digits, (size_t)n);
		o += n;
		*o++ = '.';
		memcpy(o, digits + n, (size_t)(k - n));
		o += k - n;
	} else if (-6 < n && n <= 0) {
		*o++ = '0';
		*o++ = '.';
		for (int i = 0; i < -n; i++) *o++ = '0';
		memcpy(o, digits, (size_t)k);
		o += k;
	} else {
		*o++ = digits[0];
		if (k > 1) {
			*o++ = '.';
			memcpy(o, digits + 1, (size_t)(k - 1));
			o += k - 1;
		}
		o += snprintf(o, 8, "e%c%d", n - 1 < 0 ? '-' : '+', abs(n - 1));
	}
	*o = 0;
}

static void putText(Bytes *bytes, const char *text) {
	putBytes(bytes, text, strlen(text));
}

/** as JSON.stringify: " \ and \b \f \n \r \t escaped, other controls as \u00xx, lone surrogates as \udxxx, the rest raw */
static void putString(Bytes *bytes, const char *text, size_t length) {
	putBytes(bytes, "\"", 1);
	const unsigned char *c = (const unsigned char *)text;
	for (size_t i = 0; i < length; i++) {
		unsigned char byte = c[i];
		char escaped[8];
		switch (byte) {
			case '"': putText(bytes, "\\\""); continue;
			case '\\': putText(bytes, "\\\\"); continue;
			case '\b': putText(bytes, "\\b"); continue;
			case '\f': putText(bytes, "\\f"); continue;
			case '\n': putText(bytes, "\\n"); continue;
			case '\r': putText(bytes, "\\r"); continue;
			case '\t': putText(bytes, "\\t"); continue;
			default: break;
		}
		if (byte == 0xc0 && i + 1 < length && c[i + 1] == 0x80) {
			putText(bytes, "\\u0000"); // U+0000, held as C0 80
			i += 1;
		} else if (byte < 0x20) {
			snprintf(escaped, sizeof escaped, "\\u%04x", byte);
			putText(bytes, escaped);
		} else if (byte == 0xed && i + 2 < length && c[i + 1] >= 0xa0 && c[i + 1] <= 0xbf) {
			unsigned code = ((byte & 0x0fu) << 12) | ((c[i + 1] & 0x3fu) << 6) | (c[i + 2] & 0x3fu);
			snprintf(escaped, sizeof escaped, "\\u%04x", code);
			putText(bytes, escaped);
			i += 2;
		} else {
			putBytes(bytes, (const char *)&c[i], 1);
		}
	}
	putBytes(bytes, "\"", 1);
}

/** the shortest number that reads back as the same float32 */
static double shortest32(float element) {
	char spelled[40];
	for (int precision = 1; precision < 10; precision++) {
		snprintf(spelled, sizeof spelled, "%.*e", precision - 1, (double)element);
		double number = strtod(spelled, NULL);
		if ((float)number == element) return number;
	}
	return element;
}

/** a number in its JSON form: -0 as -0, NaN and the infinities as the words `words` puts them in */
static void putNumber(Bytes *bytes, double number, const char *before, const char *after) {
	char spelled[32];
	if (isnan(number) || isinf(number)) {
		putText(bytes, before);
		putText(bytes, isnan(number) ? "NaN" : number > 0 ? "Infinity" : "-Infinity");
		putText(bytes, after);
		return;
	}
	if (number == 0 && signbit(number)) {
		putText(bytes, "-0");
		return;
	}
	jsonNumberText(number, spelled);
	putText(bytes, spelled);
}

static void putBase64(Bytes *bytes, const unsigned char *data, size_t length) {
	putText(bytes, "\"");
	uint32_t bits = 0;
	int held = 0;
	for (size_t i = 0; i < length; i++) {
		bits = (bits << 8) | data[i];
		held += 8;
		while (held >= 6) {
			held -= 6;
			putBytes(bytes, &base64Digits[(bits >> held) & 63], 1);
		}
	}
	if (held) putBytes(bytes, &base64Digits[(bits << (6 - held)) & 63], 1);
	putText(bytes, "\"");
}

/** a typed array's elements: integers as numbers, 64-bit ones as decimal strings, floats as numbers or words */
static void putElements(Bytes *bytes, const Json *value) {
	char spelled[32];
	const char *data = value->typed.data;
	for (size_t i = 0; i < value->typed.count; i++) {
		if (i) putText(bytes, ",");
		const void *at = data + i * kindSizes[value->typed.kind];
		switch (value->typed.kind) {
			case JSON_INT8: putNumber(bytes, *(const int8_t *)at, "", ""); break;
			case JSON_UINT8: putNumber(bytes, *(const uint8_t *)at, "", ""); break;
			case JSON_INT16: putNumber(bytes, *(const int16_t *)at, "", ""); break;
			case JSON_UINT16: putNumber(bytes, *(const uint16_t *)at, "", ""); break;
			case JSON_INT32: putNumber(bytes, *(const int32_t *)at, "", ""); break;
			case JSON_UINT32: putNumber(bytes, *(const uint32_t *)at, "", ""); break;
			case JSON_INT64:
				snprintf(spelled, sizeof spelled, "\"%lld\"", (long long)*(const int64_t *)at);
				putText(bytes, spelled);
				break;
			case JSON_UINT64:
				snprintf(spelled, sizeof spelled, "\"%llu\"", (unsigned long long)*(const uint64_t *)at);
				putText(bytes, spelled);
				break;
			case JSON_FLOAT32: {
				float element = *(const float *)at;
				putNumber(bytes, isfinite(element) && element != 0 ? shortest32(element) : element, "\"", "\"");
				break;
			}
			default: putNumber(bytes, *(const double *)at, "\"", "\""); break;
		}
	}
}

/** a scalar, bytes, a typed array or a live value in its JSON form */
static void putScalar(Bytes *bytes, const Json *value) {
	switch (value->type) {
		case JSON_NULL:
			putText(bytes, "null");
			break;
		case JSON_BOOLEAN:
			putText(bytes, value->boolean ? "true" : "false");
			break;
		case JSON_NUMBER:
			putNumber(bytes, value->number, "{\"/\":{\"number\":\"", "\"}}");
			break;
		case JSON_STRING:
			putString(bytes, value->string, value->stringLength);
			break;
		case JSON_BYTES:
			putText(bytes, "{\"/\":{\"bytes\":");
			putBase64(bytes, value->bytes.data, value->bytes.length);
			putText(bytes, "}}");
			break;
		case JSON_TYPED:
			putText(bytes, "{\"/\":{\"");
			putText(bytes, kindNames[value->typed.kind]);
			putText(bytes, "\":[");
			putElements(bytes, value);
			putText(bytes, "]}}");
			break;
		case JSON_LIVE:
			putText(bytes, "{\"/\":{\"live\":");
			putString(bytes, value->string, value->stringLength);
			putText(bytes, "}}");
			break;
		default:
			break;
	}
}

/** a list or object being printed, and how many of its members are out */
typedef struct Printing {
	const Json *container;
	int next;
} Printing;

// No recursion: the lists and objects being printed are kept on a stack of their own.
char *jsonPrint(const Json *value) {
	Bytes bytes = { NULL, 0, 0 };
	Printing *stack = NULL;
	int depth = 0, capacity = 0;
	while (value) {
		if (value->type == JSON_ARRAY || value->type == JSON_OBJECT) {
			// a map whose only key is "/" is data, not a form: it is escaped
			if (isSlashMap(value)) putText(&bytes, "{\"/\":{\"map\":");
			putBytes(&bytes, value->type == JSON_ARRAY ? "[" : "{", 1);
			stack = growArray(stack, depth, &capacity, sizeof *stack);
			stack[depth++] = (Printing){ value, 0 };
		} else {
			putScalar(&bytes, value);
		}
		// the next value to print, closing every container that is done
		value = NULL;
		while (depth && !value) {
			Printing *top = &stack[depth - 1];
			const Json *container = top->container;
			bool list = container->type == JSON_ARRAY;
			if (top->next == (list ? container->array.count : container->object.count)) {
				putBytes(&bytes, list ? "]" : "}", 1);
				if (isSlashMap(container)) putText(&bytes, "}}");
				depth--;
				continue;
			}
			if (top->next) putBytes(&bytes, ",", 1);
			if (list) {
				value = container->array.items[top->next];
			} else {
				const JsonMember *member = &container->object.members[top->next];
				putString(&bytes, member->key, member->keyLength);
				putBytes(&bytes, ":", 1);
				value = member->value;
			}
			top->next++;
		}
	}
	free(stack);
	putBytes(&bytes, "", 1);
	return bytes.text;
}
