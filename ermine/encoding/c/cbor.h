// cbor.h: a value (json.h) in CBOR and back, in one deterministic form (RFC 8949 4.2.1, typed
// arrays as RFC 8746). conformance/encoding/vectors.json holds the bytes for other codecs.
//
// - shortest heads, definite lengths; map keys sorted bytewise by their encodings
// - numbers: the shortest float that holds them exactly (f9, fa, fb); never an integer. 1 is
//   f93c00, -0 f98000, the one NaN f97e00
// - null f6, false f4, true f5; no other simple value
// - strings: text, plain UTF-8 (json.h's C0 80 is 00); a lone surrogate has no encoding
// - bytes: byte string
// - typed arrays: tag over a byte string, little-endian: uint16 69, uint32 70, uint64 71, int8 72,
//   int16 77, int32 78, int64 79, float32 85, float64 86; no uint8 (tag 64 never written); NaN
//   elements as 0x7fc00000 / 0x7ff8000000000000
// - stand-ins (JSON_STAND): tag 0x12345678 (da12345678) over its kind
//
// decoding accepts exactly what the encoder writes; anything else is rejected.
// memory: encoding writes into the caller's buffer; decoding builds with json.h's constructors.
// nothing recurses; at most CBOR_DEPTH nested containers (cbor.ts's DEPTH).

#ifndef CBOR_H
#define CBOR_H

#include "json.h"

#include <stdbool.h>
#include <stddef.h>

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

/**
 * Whether the text is one cborEncode can write as a string: UTF-8, with U+0000 as json.h holds
 * it (C0 80). A lone surrogate (WTF-8) is not.
 */
bool cborText(const char *text, size_t length);

#endif
