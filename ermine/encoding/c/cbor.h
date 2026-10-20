// cbor.h: a value (json.h) in CBOR and back, in one deterministic form (RFC 8949 4.2.1, typed
// arrays as RFC 8746). ermine/encoding/conformance/cbor/vectors.json holds the bytes for other codecs.
//
// - shortest heads, definite lengths; map keys sorted bytewise by their encodings
// - whole numbers: integers, major type 0 or 1 in the shortest head; past 64 bits a bignum, tag 2
//   or 3 over its bytes, big-endian, no leading zero. 1 is 01, -0 is 0 (00)
// - other numbers: the shortest float that holds them exactly (f9, fa, fb); the one NaN f97e00
// - null f6, false f4, true f5; no other simple value
// - strings: text, plain UTF-8 (json.h's C0 80 is 00); a lone surrogate has no encoding
// - bytes: byte string
// - typed arrays: tag over a byte string, little-endian: uint16 69, uint32 70, uint64 71, int8 72,
//   int16 77, int32 78, int64 79, float32 85, float64 86; no uint8 (tag 64 never written); NaN
//   elements as 0x7fc00000 / 0x7ff8000000000000; -0 elements kept
// - stand-ins (JSON_STAND): tag 0x12345678 (da12345678) over its kind
//
// decoding accepts exactly what the encoder writes (never a whole number as a float, a longer head,
// a bignum a plain integer holds); anything else is rejected. ermine/encoding/typescript/cbor.ts's
// header is the rule.
// memory: encoding writes into the caller's buffer (or one it grows, CborOut); decoding builds with json.h's constructors (or a maker's, cborRead).
// nothing recurses; at most CBOR_DEPTH nested containers (cbor.ts's DEPTH).

#ifndef CBOR_H
#define CBOR_H

#include "json.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** how many containers a value nests at most, one inside the next */
#define CBOR_DEPTH 1024
#define CBOR_DEPTH_TEXT "1024"

/**
 * Writes the value's encoding into out[0 .. capacity) and puts its whole
 * length in *length, even when that is more than `capacity` (then only the
 * first `capacity` bytes are written: call again with room for *length; out
 * may be NULL when capacity is 0). False when the value has no encoding (a
 * string that is not UTF-8, a map holding a key twice), with a
 * reason, a static string, in *why; *length is then meaningless.
 */
bool cborEncode(const Json *value, unsigned char *out, size_t capacity, size_t *length, const char **why);

// writing by pieces: a value's encoding item by item, the same bytes cborEncode writes for the same
// value (cborEncode is these). A list or map is its head (cborPutHead, major 4 or 5, how many items
// or pairs), then its items, a map's each a key (cborPutText) and its value, the keys in
// cborKeyCompare's order, each once: the writer's to keep, nothing checks

/**
 * Bytes being written. Without `grows`, into the caller's data[0 .. capacity): length counts every
 * byte, past capacity too (only the first capacity are written: write again with room for length;
 * data may be NULL when capacity is 0). With `grows`, data is malloc'd (or NULL to begin) and made
 * bigger to hold them all: free it. Out of memory aborts
 */
typedef struct CborOut {
	unsigned char *data;
	size_t capacity, length;
	bool grows;
} CborOut;

/** a head in its shortest form: major 0 a whole number, 1 a negative one (-1 - argument), 2 bytes and 3 text (their length), 4 a list, 5 a map (items, pairs), 6 a tag */
void cborPutHead(CborOut *out, unsigned major, uint64_t argument);
void cborPutNull(CborOut *out);
void cborPutBoolean(CborOut *out, bool value);
/** a number as jsonNumber holds it: a whole one an integer, -0 as 0, else the shortest float */
void cborPutNumber(CborOut *out, double value);
void cborPutInteger(CborOut *out, int64_t value);
/** a whole number from its sign and magnitude, big-endian (leading zeros allowed), as jsonWhole holds it */
void cborPutWhole(CborOut *out, bool negative, const unsigned char *magnitude, size_t length);
/** text as json.h holds it (C0 80 is 00); false, nothing written, when it is not UTF-8 (cborText) */
bool cborPutText(CborOut *out, const char *text, size_t length);
void cborPutBytes(CborOut *out, const void *data, size_t length);
/** a typed array: `count` elements of the kind's C type */
void cborPutTyped(CborOut *out, JsonKind kind, const void *data, size_t count);
/** a stand-in's tag: its kind, one value, next */
void cborPutStand(CborOut *out);
/** a whole value, as cborEncode; false when it has none, with a reason in *why (may be NULL) */
bool cborPut(CborOut *out, const Json *value, const char **why);
/** two keys in the order of their encodings (the shorter first, then byte by byte): <0, 0, >0 */
int cborKeyCompare(const char *a, size_t aLength, const char *b, size_t bLength);

/**
 * The value `length` bytes encode, as cborEncode writes it, a fresh value
 * the caller owns. NULL when they are not exactly one such encoding, with a
 * reason, a static string, in *why and the offset of the byte where it was
 * found in *at (either may be NULL).
 */
Json *cborDecode(const unsigned char *data, size_t length, const char **why, size_t *at);

/**
 * Whether cborDecode would take them: the same rules, the same *why and *at on
 * a no, and no value made.
 */
bool cborCheck(const unsigned char *data, size_t length, const char **why, size_t *at);

// reading into values of another kind: cborDecode's walk and rules, each item handed to a maker

typedef enum { CBOR_NULL, CBOR_BOOLEAN, CBOR_FLOAT, CBOR_UNSIGNED, CBOR_WHOLE, CBOR_TEXT, CBOR_BYTES, CBOR_TYPED, CBOR_LIST, CBOR_MAP, CBOR_STAND } CborWhat;

/** one item read, as a maker is given it; the fields of its kind */
typedef struct CborItem {
	CborWhat what;
	bool boolean; // CBOR_BOOLEAN
	bool negative; // CBOR_WHOLE: its sign
	double number; // CBOR_FLOAT: no whole number, -0 or NaN but the one
	uint64_t argument; // CBOR_UNSIGNED
	char *text; // CBOR_TEXT: as json.h holds it (00 as C0 80), length bytes and a NUL, malloc'd: the maker's to take
	const unsigned char *data; // CBOR_WHOLE: the magnitude, big-endian (leading zeros may be); CBOR_BYTES; CBOR_TYPED: the elements, little-endian
	size_t length; // data's bytes; text's
	JsonKind kind; // CBOR_TYPED
	size_t count; // CBOR_TYPED: elements; CBOR_LIST, CBOR_MAP: items, pairs; CBOR_STAND: 1
	unsigned char room[9]; // the reader's
	unsigned char *own; // the reader's
} CborItem;

/** what a reading makes values with. make: a fresh value of an item (a list, map or stand-in empty);
 * place: an item made into a container, a list's next, a map's under key (as json.h holds it, keyLength
 * bytes and a NUL, borrowed), a stand-in's kind; drop: frees a value made, all it holds */
typedef struct CborMaker {
	void *(*make)(void *self, const CborItem *item);
	void (*place)(void *self, void *container, const char *key, size_t keyLength, void *item);
	void (*drop)(void *self, void *value);
	void *self;
} CborMaker;

/** as cborDecode, made by maker (NULL: as cborCheck, a value that is no value but not NULL) */
void *cborRead(const unsigned char *data, size_t length, const CborMaker *maker, const char **why, size_t *at);

/**
 * Whether the text is one cborEncode can write as a string: UTF-8, with U+0000 as json.h holds
 * it (C0 80). A lone surrogate (WTF-8) is not.
 */
bool cborText(const char *text, size_t length);

#endif
