// cbor.h: a json.h value in deterministic CBOR (RFC 8949 4.2.1) and back. The encoding rules are
// in encoding/typescript/cbor.ts; encoding/conformance/cbor/vectors.json has bytes for other codecs.
// Nothing recurses; containers nest at most CBOR_DEPTH deep.

#ifndef CBOR_H
#define CBOR_H

#include "json.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** How many containers a value may nest. */
#define CBOR_DEPTH 1024
#define CBOR_DEPTH_TEXT "1024"

/**
 * Writes the encoding into out[0 .. capacity) and its full length into *length, even when that
 * exceeds capacity (then call again with more room; out may be NULL if capacity is 0). False when
 * the value has no encoding (a non-UTF-8 string, a repeated map key), with a static reason in *why.
 */
bool cborEncode(const Json *value, unsigned char *out, size_t capacity, size_t *length, const char **why);

// Writing by pieces: the same bytes cborEncode writes. A list or map is its head (cborPutHead),
// then its items; a map's items are key (cborPutText) and value pairs, keys in cborKeyCompare order.
// The caller keeps that order; nothing checks it.

/**
 * Bytes being written. Without `grows`, they go into the caller's data[0 .. capacity) and length
 * counts every byte, past capacity too. With `grows`, data is malloc'd (or NULL to begin) and
 * enlarged as needed; free it. Out of memory aborts.
 */
typedef struct CborOut {
	unsigned char *data;
	size_t capacity, length;
	bool grows;
} CborOut;

/** A head in its shortest form; major is 0..6 as in RFC 8949. */
void cborPutHead(CborOut *out, unsigned major, uint64_t argument);
void cborPutNull(CborOut *out);
void cborPutBoolean(CborOut *out, bool value);
/** A number as jsonNumber holds it: whole ones as integers, -0 as 0, else the shortest float. */
void cborPutNumber(CborOut *out, double value);
void cborPutInteger(CborOut *out, int64_t value);
/** A whole number from sign and big-endian magnitude (leading zeros allowed). */
void cborPutWhole(CborOut *out, bool negative, const unsigned char *magnitude, size_t length);
/** Text as json.h holds it; false, writing nothing, when it is not UTF-8. */
bool cborPutText(CborOut *out, const char *text, size_t length);
void cborPutBytes(CborOut *out, const void *data, size_t length);
/** A typed array of `count` elements of the kind's C type. */
void cborPutTyped(CborOut *out, JsonKind kind, const void *data, size_t count);
/** A stand-in's tag; its kind and then one value follow. */
void cborPutStand(CborOut *out);
/** A whole value, as cborEncode; false with a reason in *why (may be NULL) when it has none. */
bool cborPut(CborOut *out, const Json *value, const char **why);
/** Compares two keys by their encodings (shorter first, then bytewise): <0, 0, >0. */
int cborKeyCompare(const char *a, size_t aLength, const char *b, size_t bLength);

/**
 * Decodes exactly one encoding into a fresh value the caller owns. NULL when the bytes are not
 * one, with a static reason in *why and the offending offset in *at (either may be NULL).
 */
Json *cborDecode(const unsigned char *data, size_t length, const char **why, size_t *at);

/** Whether cborDecode would accept the bytes, with the same *why and *at, making no value. */
bool cborCheck(const unsigned char *data, size_t length, const char **why, size_t *at);

// Reading into values of another kind: cborDecode's walk and rules, each item handed to a maker.

typedef enum { CBOR_NULL, CBOR_BOOLEAN, CBOR_FLOAT, CBOR_UNSIGNED, CBOR_WHOLE, CBOR_TEXT, CBOR_BYTES, CBOR_TYPED, CBOR_LIST, CBOR_MAP, CBOR_STAND } CborWhat;

/** One item read, as handed to a maker; only the fields for its kind are set. */
typedef struct CborItem {
	CborWhat what;
	bool boolean; // CBOR_BOOLEAN
	bool negative; // CBOR_WHOLE: its sign
	double number; // CBOR_FLOAT
	uint64_t argument; // CBOR_UNSIGNED
	char *text; // CBOR_TEXT, NUL-terminated, malloc'd; the maker takes it
	const unsigned char *data; // CBOR_WHOLE magnitude (big-endian), CBOR_BYTES, CBOR_TYPED elements (little-endian)
	size_t length; // bytes in data or text
	JsonKind kind; // CBOR_TYPED
	size_t count; // CBOR_TYPED elements; CBOR_LIST items; CBOR_MAP pairs
	unsigned char room[9]; // private to the reader
	unsigned char *own; // private to the reader
} CborItem;

/**
 * What a reading makes values with. make: a fresh value from an item (containers start empty).
 * place: puts an item into a container (a list's next, a map's value under a borrowed key, or a
 * stand-in's kind). drop: frees a value made, with everything in it.
 */
typedef struct CborMaker {
	void *(*make)(void *self, const CborItem *item);
	void (*place)(void *self, void *container, const char *key, size_t keyLength, void *item);
	void (*drop)(void *self, void *value);
	void *self;
} CborMaker;

/** As cborDecode, with values made by maker. With a NULL maker it only checks. */
void *cborRead(const unsigned char *data, size_t length, const CborMaker *maker, const char **why, size_t *at);

/** Whether the text can be written as a CBOR string: UTF-8, no lone surrogates. */
bool cborText(const char *text, size_t length);

#endif
