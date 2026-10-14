// op's value in JSON (json.c): the text a harness line is, and the text it answers with, in the JSON
// form of ENCODING.tex. plain JSON for what JSON holds; the rest under "/":
//   {"/": {"bytes": b64}}                    bytes, base64 of the standard alphabet, no padding
//   {"/": {"int8": [...]}}                   a typed array, by its kind (int8 int16 uint16 int32
//                                            uint32 int64 uint64 float32 float64); 64-bit elements
//                                            as decimal strings, a float's NaN and infinities as
//                                            the words "NaN", "Infinity", "-Infinity"
//   {"/": {"number": "NaN"}}                 a number JSON cannot write (and "Infinity", "-Infinity");
//                                            -0 is written -0
//   {"/": {"live": kind}}                    a stand-in
//   {"/": {"map": {"/": x}}}                 a map whose one key is "/"
// a string may hold lone surrogates (\ud800): they are held as WTF-8, and printed back as escapes.
// U+0000 is held as C0 80, so that every string is C text
#ifndef OP_JSON_H
#define OP_JSON_H

#include <stdio.h>

#include "value.h"

// the value the text is: one JSON value, spaces around it allowed, its "/" forms the values they
// stand for. NULL when it is not, or a form is malformed; *why (may be NULL) then says what, in
// static text
op_value *op_json_read(const char *text, const char **why);
// the value's JSON form, one line
void op_json_write(FILE *out, const op_value *v);
// the C text s as a JSON string
void op_json_string(FILE *out, const char *s);
// the value's JSON form as a fresh C string (free it)
char *op_json_text(const op_value *v);

#endif
