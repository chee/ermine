// json_text.h: a value's JSON text: the parser, jsonDecode's "/" forms and the printer (json.h
// has what they are: VALUES BEYOND JSON, STRINGS). Apart from json.h, so what never reads or
// writes text (a commit, a pack, CBOR) links none of it.
#ifndef JSON_TEXT_H
#define JSON_TEXT_H

#include "json.h"

/**
 * Parses exactly one JSON value from the bytes (whitespace around it is
 * allowed; a CR is whitespace). A repeated key keeps the last value, as
 * JSON.parse does. On failure returns NULL and puts a reason in *why (a
 * fresh C string).
 */
Json *jsonParse(const char *text, size_t length, char **why);
/**
 * the JSON form (conformance/typescript/form.ts): turns the "/" forms in a value read from a line
 * into the values they stand for, in place (the value must be fresh, not yet
 * shared): bytes, typed arrays, numbers JSON cannot write, a map whose only
 * key is "/", and a stand-in (its kind decoded in turn). False when a form
 * is malformed or a string or a key holds a lone surrogate: wrong-field.
 * *value stays the same value, now what its form stands for.
 */
bool jsonDecode(Json **value);

/** the value in its JSON form (conformance/typescript/form.ts), as JSON.stringify writes the rest: one line, a fresh C string */
char *jsonPrint(const Json *value);

/**
 * A number as the fewest digits, from 15, that read back as the same double,
 * in %g's layout ("0.1", "100", "1e+21", "1e-07"), which JSON's grammar takes:
 * all JSON asks of a number. -0 as 0; NaN and infinities are
 * "null". `out` holds at least 32 bytes.
 */
void jsonNumberText(double number, char out[32]);

#endif
