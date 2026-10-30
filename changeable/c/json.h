// op_values in JSON (json.c): the text of a harness line, in the JSON form of
// conformance/typescript/form.ts. Plain JSON for what JSON holds, the rest under "/":
//   {"/": {"bytes": b64}}      bytes, standard base64 without padding
//   {"/": {"int8": [...]}}     a typed array by kind (int8 int16 uint16 int32 uint32 int64 uint64
//                              float32 float64); 64-bit elements are decimal strings, and NaN
//                              and the infinities are the strings "NaN", "Infinity", "-Infinity"
//   {"/": {"number": "NaN"}}   a number JSON cannot write (also "Infinity", "-Infinity")
//   {"/": {"live": kind}}      a stand-in
//   {"/": {"map": {"/": x}}}   a map whose one key is "/"
// -0 is written -0. A string may hold lone surrogates (\ud800), held as WTF-8 and printed back
// as escapes. U+0000 is held as C0 80 so every string is C text.
#ifndef OP_JSON_H
#define OP_JSON_H

#include <stdio.h>

#include "value.h"

// Returns NULL if bad, and then *why (may be NULL) is static text saying what.
op_value *op_json_read(const char *text, const char **why);
void op_json_write(FILE *out, const op_value *v);
void op_json_string(FILE *out, const char *s);
// Returns the value's JSON form as a fresh C string (free it).
char *op_json_text(const op_value *v);

#endif
