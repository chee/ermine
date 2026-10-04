// basic.c: the optype the conformance suite uses. core/docs/protocol.tex, "The optype basic".
//
// Values are any JSON. { set: v } replaces the whole value and applies to an
// empty node too; { splice: [from, to, s] } edits a string by code points.
// Anything else is not an op. Two values are the same when both are the same
// null, boolean, number or string; an array or an object is never the same as
// anything, so nothing is compared deeply. It is here and not in the core
// because the core has no optypes of its own: this is the code a graph is
// given for the optype node "basic", mounted at its root by the driver.

#include "basic.h"

#include <stdlib.h>
#include <string.h>

static bool basicHolds(const Json *value) {
	(void)value;
	return true;
}

/** the same null, boolean, number (numerically) or string (byte for byte, NULs included); never an array or an object */
static bool basicEqual(const Json *a, const Json *b) {
	if (a->type != b->type) return false;
	switch (a->type) {
		case JSON_NULL:
			return true;
		case JSON_BOOLEAN:
			return a->boolean == b->boolean;
		case JSON_NUMBER:
			return a->number == b->number;
		case JSON_STRING:
			return a->stringLength == b->stringLength && memcmp(a->string, b->string, a->stringLength) == 0;
		case JSON_ARRAY:
		case JSON_OBJECT:
			return false;
	}
	return false;
}

/** how many code points a UTF-8 string holds: one per byte that is not a continuation byte */
static int64_t codePointCount(const char *text, size_t length) {
	int64_t count = 0;
	for (size_t i = 0; i < length; i++) {
		if (((unsigned char)text[i] & 0xc0) != 0x80) count++;
	}
	return count;
}

/** the byte offset at which the nth code point starts (the end of the string for n = count) */
static size_t byteOffsetOf(const char *text, size_t length, int64_t codePoint) {
	int64_t seen = 0;
	for (size_t offset = 0; offset < length; offset++) {
		if (((unsigned char)text[offset] & 0xc0) != 0x80) {
			if (seen == codePoint) return offset;
			seen++;
		}
	}
	return length;
}

static Refusal notAnOp(const Json *op) {
	char *text = jsonPrint(op);
	Refusal why = refuse("not an op: %s", text);
	free(text);
	return why;
}

/** the new value after every op, or the first refusal; the ops are applied to a copy, so a refusal changes nothing */
static Refusal basicApply(Held held, const Json *ops, Json **result) {
	Json *current = held.present ? jsonClone(held.value) : NULL;
	for (int i = 0; i < ops->array.count; i++) {
		const Json *op = ops->array.items[i];
		if (!jsonIsObject(op) || op->object.count != 1) {
			jsonFree(current);
			return notAnOp(op);
		}
		const JsonMember *member = &op->object.members[0];
		const Json *inside = member->value;
		if (jsonKeyIs(member, "set")) {
			jsonFree(current);
			current = jsonClone(inside);
			continue;
		}
		if (!jsonKeyIs(member, "splice")) {
			jsonFree(current);
			return notAnOp(op);
		}
		int64_t from, to;
		if (!jsonIsArray(inside) || inside->array.count != 3 || !jsonIsInteger(inside->array.items[0], &from) || !jsonIsInteger(inside->array.items[1], &to) || !jsonIsString(inside->array.items[2])) {
			jsonFree(current);
			return notAnOp(op);
		}
		if (!current || current->type != JSON_STRING) {
			char *text = current ? jsonPrint(current) : copyString("an empty node");
			Refusal why = refuse("splice applies only to a string, not %s", text);
			free(text);
			jsonFree(current);
			return why;
		}
		int64_t length = codePointCount(current->string, current->stringLength);
		if (from < 0 || to < from || to > length) {
			Refusal why = refuse("splice [%lld, %lld) is outside a string of %lld code points", (long long)from, (long long)to, (long long)length);
			jsonFree(current);
			return why;
		}
		const Json *insert = inside->array.items[2];
		size_t start = byteOffsetOf(current->string, current->stringLength, from);
		size_t end = byteOffsetOf(current->string, current->stringLength, to);
		size_t afterLength = current->stringLength - end;
		char *spliced = malloc(start + insert->stringLength + afterLength + 1);
		if (!spliced) abort();
		memcpy(spliced, current->string, start);
		memcpy(spliced + start, insert->string, insert->stringLength);
		memcpy(spliced + start + insert->stringLength, current->string + end, afterLength);
		spliced[start + insert->stringLength + afterLength] = 0;
		free(current->string);
		current->string = spliced;
		current->stringLength = start + insert->stringLength + afterLength;
	}
	if (!current) return refuse("the ops leave no value");
	*result = current;
	return NULL;
}

const Implementation basic = { basicHolds, basicApply, basicEqual };
