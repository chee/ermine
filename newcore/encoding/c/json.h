// json.h: a value (ENCODING.tex), its parser and printer, value equality, and
// the code point helpers every other file uses. Nothing here knows about
// graphs.
//
// VALUES BEYOND JSON. A value is also bytes, a typed array or a live value,
// each held as the machine holds it: bytes and typed arrays in a buffer of
// their own, never as strings or lists of numbers. A number is any binary64,
// NaN, the infinities and -0 included. The parser reads plain JSON;
// jsonDecode turns the "/" forms (ENCODING.tex, JSON form) in a value read from a line into these
// kinds, and the printer writes every value in its JSON form (ENCODING.tex,
// in JSON): -0 as -0, NaN and the infinities, bytes, typed arrays and live
// values under "/", and a map whose only key is "/" escaped as {"/": {"map":
// ...}}. Bytes are base64, standard alphabet, no padding; a typed array is
// its elements' bytes, each little-endian, in base64, a NaN element the one
// NaN of its kind (0x7fc00000, 0x7ff8000000000000).
//
// VALUES ARE IMMUTABLE AND NEVER FREED (see NOTES.md, Memory). A Json that
// has been handed to another function, stored, or returned is shared: no one
// may change it or free it. To change a value, build a new one (jsonShallow
// the containers you change, then change the copies before anyone else sees
// them). jsonFree exists only for scratch a function made and never let go of.
//
// NO RECURSION: parsing, printing, freeing and equality keep their own
// stacks on the heap, so a value may nest as deep as memory allows.
//
// ABSENT is a NULL `Json *`. A present null is a JSON_NULL value.
//
// STRINGS are UTF-8 internally, NUL-terminated, `stringLength` bytes long.
// U+0000 is held as the two bytes C0 80 (as Java's modified UTF-8 does), so
// no string or key holds a NUL byte and every string is also C text: an id
// or a name with U+0000 in it is an id like any other. The parser makes C0 80
// from \u0000 and the printer writes it back as \u0000; it counts as one code
// point and sorts first.
// A lone surrogate escape (\ud800) is accepted, as JSON.parse does, and held
// as its 3-byte WTF-8 form (ED A0..BF xx); it counts as one code point and is
// printed back as \udxxx. A string holding one is no string (ENCODING.tex):
// jsonDecode rejects a value holding one, and an id or a name holding one is
// wrong-field (the harness's lines), so none reaches the graph.
//
// CODE POINT ORDER of two strings is utf8Compare, or textCompare for C text.
// It is byte order except for U+0000's C0 80; never order ids with strcmp.

#ifndef JSON_H
#define JSON_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum { JSON_NULL, JSON_BOOLEAN, JSON_NUMBER, JSON_STRING, JSON_ARRAY, JSON_OBJECT, JSON_BYTES, JSON_TYPED, JSON_LIVE } JsonType;

/** a typed array's kind (ENCODING.tex), in ENCODING.tex's order; each held as its C type */
typedef enum { JSON_INT8, JSON_UINT8, JSON_INT16, JSON_UINT16, JSON_INT32, JSON_UINT32, JSON_INT64, JSON_UINT64, JSON_FLOAT32, JSON_FLOAT64, JSON_KINDS } JsonKind;

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
		double number;
		struct {
			char *string; // UTF-8 (WTF-8 for lone surrogates), NUL-terminated, `stringLength` bytes; a live value's kind
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
};

// making values ----------------------------------------------------------------
// Every constructor returns a fresh value the caller may change until it
// hands it on.

Json *jsonNull(void);
Json *jsonBoolean(bool value);
Json *jsonNumber(double value);
Json *jsonInteger(int64_t value);
/** copies the text (up to its NUL) */
Json *jsonString(const char *text);
/** copies `length` bytes, NUL included */
Json *jsonStringOfLength(const char *text, size_t length);
Json *jsonArray(void);
Json *jsonObject(void);
/** bytes: copies `length` octets */
Json *jsonBytes(const void *data, size_t length);
/** a typed array: copies `count` elements of the kind's C type */
Json *jsonTyped(JsonKind kind, const void *data, size_t count);
/** a live value's stand-in, of a kind: a thing of its own, equal only to itself */
Json *jsonLive(const char *kind);
/** the size of one element of a kind */
size_t jsonKindSize(JsonKind kind);
/** appends to an array; takes the item */
void jsonPush(Json *array, Json *item);
/** appends a key to an object, without checking for one already there; takes the value; copies the key */
void jsonAdd(Json *object, const char *key, Json *value);
void jsonAddOfLength(Json *object, const char *key, size_t length, Json *value);
/** sets a key of an object: replaces the value where the key is, or appends it (JS's o[k] = v) */
void jsonSet(Json *object, const char *key, size_t length, Json *value);
/** removes a key of an object; false if it was not there (the object is unchanged) */
bool jsonRemove(Json *object, const char *key, size_t length);
/** a shallow copy: a new array or object holding the same items/values (shared), or a copy of a scalar */
Json *jsonShallow(const Json *value);
/** frees scratch only (see the header comment) */
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
/**
 * Value equality (ENCODING.tex): of the same kind with equal parts. Numbers as
 * JavaScript's Object.is tells them apart (0 and -0 differ, NaN equals NaN);
 * strings and bytes byte for byte; typed arrays only of the same kind,
 * element by element as numbers are; lists element by element in order;
 * objects with the same keys holding equal values in any key order; live
 * values only when they are the same thing. Two NULLs (absent) are equal;
 * NULL and a value are not.
 */
bool jsonEqual(const Json *a, const Json *b);
/** whether two numbers are the same as Object.is has it */
bool jsonSameNumber(double a, double b);

// text -------------------------------------------------------------------------

/**
 * Parses exactly one JSON value from the bytes (whitespace around it is
 * allowed; a CR is whitespace). A repeated key keeps the last value, as
 * JSON.parse does. On failure returns NULL and puts a reason in *why (a
 * fresh C string).
 */
Json *jsonParse(const char *text, size_t length, char **why);
/**
 * ENCODING.tex, JSON form: turns the "/" forms in a value read from a line
 * into the values they stand for, in place (the value must be fresh, not yet
 * shared): bytes, typed arrays, numbers JSON cannot write, a map whose only
 * key is "/", and, only where `live` says (the whole value), a live value's
 * new stand-in. False when a form is malformed, a live value is anywhere
 * else, or a string or a key holds a lone surrogate: wrong-field. *value may
 * be replaced.
 */
bool jsonDecode(Json **value, bool live);

/** the value in its JSON form (ENCODING.tex, JSON form), as JSON.stringify writes the rest: one line, a fresh C string */
char *jsonPrint(const Json *value);

/**
 * A number as the fewest digits, from 15, that read back as the same double,
 * in %g's layout ("0.1", "100", "1e+21", "1e-07"), which JSON's grammar takes:
 * all JSON asks of a number. -0 as 0; NaN and infinities are
 * "null". `out` holds at least 32 bytes.
 */
void jsonNumberText(double number, char out[32]);

// code points ------------------------------------------------------------------
// Strings are counted and sliced by code point (as patches count them).

/** how many code points the bytes hold */
size_t utf8Count(const char *text, size_t length);
/** the byte offset of code point `index` (0..count); `length` when index >= count */
size_t utf8Offset(const char *text, size_t length, size_t index);
/** code point order: <0, 0, >0 */
int utf8Compare(const char *a, size_t aLength, const char *b, size_t bLength);
/** code point order of two C texts (ids, names) */
int textCompare(const char *a, const char *b);
/** whether the bytes hold a lone surrogate (its WTF-8, ED A0..BF xx), which makes them no string (ENCODING.tex) */
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
