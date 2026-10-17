// json.h: a value (cbor.h), value equality, and code point helpers; parser and printer are
// json_text.h. nothing here knows about graphs.
//
// values: JSON plus bytes, typed arrays (each in its own buffer; no uint8 kind) and stand-ins.
// numbers: any binary64 but -0 (it is 0: whole numbers are integers), and every whole number, of
// any size: one no double holds exactly (past 2^53) is `big` beside the double nearest it.
// jsonDecode turns "/" forms into these; the printer writes them back (base64, no padding; typed
// arrays little-endian; one NaN per width; a whole number past 2^53 - 1 as {"/":{"bigint":...}}).
// holders: a value is immutable once shared. whoever made it holds it; jsonRef adds a hold,
// jsonFree drops one (the last frees). a function borrows what it is given; jsonPush, jsonAdd,
// jsonSet, jsonStand take the caller's hold. to change, jsonShallow and change the copy.
// nothing recurses: parse, print, free and equality keep heap stacks.
// absent: a NULL `Json *`; a present null is JSON_NULL.
// strings: UTF-8, NUL-terminated, `stringLength` bytes. U+0000 is held as C0 80 (one code point,
// sorts first). a lone surrogate is held as WTF-8 and printed back as \udxxx; jsonDecode rejects
// it, so none reaches the graph.
// order: utf8Compare or textCompare, never strcmp.

#ifndef JSON_H
#define JSON_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum { JSON_NULL, JSON_BOOLEAN, JSON_NUMBER, JSON_STRING, JSON_ARRAY, JSON_OBJECT, JSON_BYTES, JSON_TYPED, JSON_STAND } JsonType;

/** a typed array's kind, in cbor.h's order; each held as its C type. No uint8: bytes are that */
typedef enum { JSON_INT8, JSON_INT16, JSON_UINT16, JSON_INT32, JSON_UINT32, JSON_INT64, JSON_UINT64, JSON_FLOAT32, JSON_FLOAT64, JSON_KINDS } JsonKind;

typedef struct Json Json;

/** one key of an object, in the order the keys were given; a key is `keyLength` bytes and may hold NUL */
typedef struct JsonMember {
	char *key;
	size_t keyLength;
	Json *value;
} JsonMember;

struct Json {
	JsonType type;
	union {
		bool boolean;
		struct {
			double number; // the number; a big one's, the double nearest it
			// a whole number no double holds exactly: its magnitude, big-endian, no leading zero
			// (whole.h), and its sign. NULL for every other number
			unsigned char *big;
			size_t bigLength;
			bool bigNegative;
		};
		struct {
			char *string; // UTF-8 (WTF-8 for lone surrogates), NUL-terminated, `stringLength` bytes
			size_t stringLength;
		};
		struct {
			unsigned char *data;
			size_t length;
		} bytes;
		struct {
			JsonKind kind;
			void *data; // `count` elements of the kind's C type: int8_t ... uint64_t, float, double
			size_t count;
		} typed;
		struct {
			Json *kind; // any value, informational
		} stand;
		struct {
			Json **items;
			int count;
			int capacity;
		} array;
		struct {
			JsonMember *members;
			int count;
			int capacity;
		} object;
	};
	// holders past the first: jsonRef adds one, jsonFree lets one go
	size_t refs;
};

// making values ----------------------------------------------------------------
// Every constructor returns a fresh value the caller may change until it
// hands it on.

Json *jsonNull(void);
Json *jsonBoolean(bool value);
/** a number: -0 is 0 */
Json *jsonNumber(double value);
Json *jsonInteger(int64_t value);
Json *jsonUnsigned(uint64_t value);
/** a whole number from its sign and magnitude, big-endian (leading zeros allowed): a double when one holds it exactly */
Json *jsonWhole(bool negative, const unsigned char *magnitude, size_t length);
/** copies the text (up to its NUL) */
Json *jsonString(const char *text);
/** copies `length` bytes, NUL included */
Json *jsonStringOfLength(const char *text, size_t length);
/** takes `text`, a heap buffer of `length` bytes and a NUL after them, as the string's own */
Json *jsonStringTaking(char *text, size_t length);
Json *jsonArray(void);
Json *jsonObject(void);
/** bytes: copies `length` octets */
Json *jsonBytes(const void *data, size_t length);
/** a typed array: copies `count` elements of the kind's C type */
Json *jsonTyped(JsonKind kind, const void *data, size_t count);
/** a stand-in of a kind, any value: takes the kind; data, equal to another with an equal kind */
Json *jsonStand(Json *kind);
/** the size of one element of a kind */
size_t jsonKindSize(JsonKind kind);
/** appends to an array; takes the item */
void jsonPush(Json *array, Json *item);
/** appends a key to an object, without checking for one already there; takes the value; copies the key */
void jsonAdd(Json *object, const char *key, Json *value);
void jsonAddOfLength(Json *object, const char *key, size_t length, Json *value);
/** as jsonAddOfLength, taking `key`, a heap buffer of `length` bytes and a NUL after them, as the member's own */
void jsonAddTaking(Json *object, char *key, size_t length, Json *value);
/** sets a key of an object: replaces the value where the key is (letting go of the one there), or appends it (JS's o[k] = v); takes the value */
void jsonSet(Json *object, const char *key, size_t length, Json *value);
/** removes a key of an object, letting go of its value; false if it was not there (the object is unchanged) */
bool jsonRemove(Json *object, const char *key, size_t length);
/** a shallow copy: a new array or object holding the same items/values (shared, a hold on each), or a copy of a scalar */
Json *jsonShallow(const Json *value);
/** one more holder of value, and so of all it holds; value. NULL: NULL. Not thread-safe */
Json *jsonRef(Json *value);
/** lets one hold of value go: the last frees it, and lets go of what it holds (see the header comment). NULL: nothing */
void jsonFree(Json *value);

// reading values ---------------------------------------------------------------

/** the member under the key, or NULL when absent or when `object` is not an object */
Json *jsonGet(const Json *object, const char *key);
Json *jsonGetOfLength(const Json *object, const char *key, size_t length);
bool jsonIsObject(const Json *value);
bool jsonIsArray(const Json *value);
bool jsonIsString(const Json *value);
bool jsonIsNumber(const Json *value);
/** a string's C text (every string is one, see STRINGS), or NULL when the value is not a string */
const char *jsonText(const Json *value);
/**
 * a whole number (Number.isInteger), of any size: puts it in *out when out
 * is not NULL, held at INT64_MIN or INT64_MAX past them (no list, slot or
 * string is that long, so comparing it with a length or an index still
 * answers right)
 */
bool jsonIsWhole(const Json *value, int64_t *out);
/** a whole number from INT64_MIN to INT64_MAX into *out; false for anything else (a fraction, past them) */
bool jsonInt64(const Json *value, int64_t *out);
/** a number as a double into *out (a big whole one: the double nearest it); false when not a number */
bool jsonDouble(const Json *value, double *out);
/** a whole number's sign and magnitude (big-endian, no leading zero; out has 128 bytes of room); false when not a whole number */
bool jsonMagnitude(const Json *value, bool *negative, unsigned char out[128], size_t *length);
/**
 * Value equality: of the same kind with equal parts. Numbers by value, NaN
 * equal to NaN (no -0 is made: 0 and -0 are equal, as are whole numbers by value);
 * strings and bytes byte for byte; typed arrays only of the same kind,
 * element by element as numbers are; lists element by element in order;
 * objects with the same keys holding equal values in any key order;
 * stand-ins with equal kinds. Two NULLs (absent) are equal;
 * NULL and a value are not.
 */
bool jsonEqual(const Json *a, const Json *b);

// code points ------------------------------------------------------------------
// Strings are counted and sliced by code point (as patches count them).

/** how many code points the bytes hold */
size_t utf8Count(const char *text, size_t length);
/** code point order: <0, 0, >0 */
int utf8Compare(const char *a, size_t aLength, const char *b, size_t bLength);
/** code point order of two C texts (ids, names) */
int textCompare(const char *a, const char *b);
/** whether the bytes hold a lone surrogate (its WTF-8, ED A0..BF xx), which makes them no string */
bool utf8Surrogate(const char *text, size_t length);

// small shared helpers ---------------------------------------------------------

/** zeroed memory; aborts when memory is out, as every allocation here does */
void *allocate(size_t size);
/** a copy of a C string */
char *copyString(const char *text);
/** a copy of `length` bytes, NUL-terminated */
char *copyStringOfLength(const char *text, size_t length);
/** printf into a fresh C string */
char *formatString(const char *format, ...) __attribute__((format(printf, 1, 2)));
/** room for one more item in an array of `count` items of `size` bytes each; returns the (maybe moved) array */
void *growArray(void *items, int count, int *capacity, size_t size);

#endif
