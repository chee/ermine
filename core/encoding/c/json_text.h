// json_text.h: the JSON parser and printer, and the "/" forms (bytes, typed arrays, big numbers).
// Separate from json.h so code that never touches text links none of it.
#ifndef JSON_TEXT_H
#define JSON_TEXT_H

#include "json.h"

/** Parses exactly one JSON value (surrounding whitespace allowed). A repeated key keeps the last
 * value. On failure returns NULL with a fresh C string reason in *why. */
Json *jsonParse(const char *text, size_t length, char **why);
/**
 * Turns the "/" forms in a freshly parsed value (not yet shared) into the values they stand for,
 * in place. False when a form is malformed or a string holds a lone surrogate.
 */
bool jsonDecode(Json **value);

/** The value in its JSON form, as JSON.stringify writes it: one line, a fresh C string. */
char *jsonPrint(const Json *value);

/**
 * A number in the fewest digits (15 up) that read back as the same double, in %g's layout. -0 is 0;
 * NaN and infinities are "null". `out` holds at least 32 bytes.
 */
void jsonNumberText(double number, char out[32]);

#endif
