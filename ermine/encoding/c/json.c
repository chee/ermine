// json.c: the JSON value, equality and code point helpers; its text is json_text.c.
// See json.h. Owner: the skeleton (done).

#include "json.h"

#include <ctype.h>
#include <errno.h>
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

Json *jsonStringTaking(char *text, size_t length) {
	Json *value = make(JSON_STRING);
	value->string = text;
	value->stringLength = length;
	return value;
}

Json *jsonArray(void) {
	return make(JSON_ARRAY);
}

Json *jsonObject(void) {
	return make(JSON_OBJECT);
}

static const size_t kindSizes[JSON_KINDS] = { 1, 2, 2, 4, 4, 8, 8, 4, 8 };

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

Json *jsonStand(Json *kind) {
	Json *value = make(JSON_STAND);
	value->stand.kind = kind;
	return value;
}

void jsonPush(Json *array, Json *item) {
	array->array.items = growArray(array->array.items, array->array.count, &array->array.capacity, sizeof *array->array.items);
	array->array.items[array->array.count++] = item;
}

void jsonAdd(Json *object, const char *key, Json *value) {
	jsonAddOfLength(object, key, strlen(key), value);
}

void jsonAddTaking(Json *object, char *key, size_t length, Json *value) {
	object->object.members = growArray(object->object.members, object->object.count, &object->object.capacity, sizeof *object->object.members);
	JsonMember *member = &object->object.members[object->object.count++];
	member->key = key;
	member->keyLength = length;
	member->value = value;
}

void jsonAddOfLength(Json *object, const char *key, size_t length, Json *value) {
	jsonAddTaking(object, copyStringOfLength(key, length), length, value);
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
	if (at >= 0) {
		Json *was = object->object.members[at].value;
		object->object.members[at].value = value;
		jsonFree(was);
	} else jsonAddOfLength(object, key, length, value);
}

bool jsonRemove(Json *object, const char *key, size_t length) {
	int at = memberIndex(object, key, length);
	if (at < 0) return false;
	jsonFree(object->object.members[at].value);
	free(object->object.members[at].key);
	memmove(&object->object.members[at], &object->object.members[at + 1], (size_t)(object->object.count - at - 1) * sizeof *object->object.members);
	object->object.count--;
	return true;
}

Json *jsonShallow(const Json *value) {
	Json *copy = make(value->type);
	switch (value->type) {
		case JSON_ARRAY:
			for (int i = 0; i < value->array.count; i++) jsonPush(copy, jsonRef(value->array.items[i]));
			break;
		case JSON_OBJECT:
			for (int i = 0; i < value->object.count; i++) {
				const JsonMember *member = &value->object.members[i];
				jsonAddOfLength(copy, member->key, member->keyLength, jsonRef(member->value));
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
		case JSON_STAND:
			jsonFree(copy);
			return jsonStand(jsonRef(value->stand.kind));
		default:
			*copy = *value;
			copy->refs = 0;
			break;
	}
	return copy;
}

Json *jsonRef(Json *value) {
	if (value) value->refs++;
	return value;
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
		// held elsewhere too: only this hold goes
		if (at->refs) {
			at->refs--;
			continue;
		}
		if (at->type == JSON_STRING) {
			free(at->string);
		} else if (at->type == JSON_STAND) {
			if (at->stand.kind) push(&stack, at->stand.kind);
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
		} else if (x->type == JSON_STAND) {
			push(&stack, x->stand.kind);
			push(&stack, y->stand.kind);
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

bool utf8Surrogate(const char *text, size_t length) {
	for (size_t i = 0; i + 1 < length; i++) {
		if ((unsigned char)text[i] == 0xed && (unsigned char)text[i + 1] >= 0xa0) return true;
	}
	return false;
}
