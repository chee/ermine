// cbor.h: a value (json.h) in CBOR and back, in one deterministic form.
//
// ENCODING.tex: values are encoded as CBOR
// (RFC 8949) in its deterministic form, typed arrays as RFC 8746 has them.
// These are the details this codec fixes (conformance/encoding/vectors.json holds
// the same bytes for other codecs to check against):
//
// - RFC 8949 4.2.1 core deterministic encoding: every head in its shortest
//   form, definite lengths only.
// - A map's keys sorted bytewise lexicographic by their encodings (RFC 8949
//   4.2.1), so a shorter key first, keys of one length in byte order.
// - Every number as the shortest float that holds it exactly (RFC 8949 4.2.2
//   rule 2): a half (0xf9), else a single (0xfa), else a double (0xfb). Never
//   an integer (major types 0 and 1): 1 is 0xf93c00. -0 is kept (0xf98000).
//   The one NaN is 0xf97e00.
// - null 0xf6, false 0xf4, true 0xf5; no other simple value.
// - A string as a text string (major type 3), in plain UTF-8: U+0000, which
//   json.h holds as C0 80, is the byte 00. A string holding a lone surrogate
//   (WTF-8, json.h) is not UTF-8 and has no encoding.
// - Bytes as a byte string (major type 2).
// - A typed array as an RFC 8746 tag over a byte string of its elements,
//   little-endian: uint8 64, uint16 69, uint32 70, uint64 71, int8 72,
//   int16 77, int32 78, int64 79, float32 85, float64 86. A float element
//   that is NaN is written as the one quiet NaN of its width (float32
//   0x7fc00000, float64 0x7ff8000000000000), since all NaNs are one NaN.
// - A stand-in (what a live value is sent as) as tag 11111111 (da00a98ac7)
//   over its kind, any value; json.h holds it as JSON_STAND. C has no live
//   values: it carries stand-ins as data.
//
// Decoding accepts exactly what the encoder writes and nothing else: an
// integer, a head longer than it need be, an indefinite length, an unknown
// tag (the stand-in's only in its head da00a98ac7) or simple value, a number in a longer float than holds it, any other
// NaN, a map whose keys are not text strings in strictly increasing order,
// text that is not UTF-8, a typed array whose byte string is not a whole
// number of elements, a NaN element other than the one above, or bytes left
// over, is rejected.
//
// MEMORY: encoding writes into the caller's buffer and allocates only the
// stack of containers being written (as jsonPrint does); a map's keys are
// put in order by finding the next one each time, with no scratch. Decoding
// makes the value with json.h's constructors and keeps its own stack of
// containers. NOTHING RECURSES: a value may nest as deep as memory allows.

#ifndef CBOR_H
#define CBOR_H

#include "json.h"

#include <stdbool.h>
#include <stddef.h>

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

#endif
