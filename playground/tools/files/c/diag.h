// CBOR's diagnostic notation for .text files (newcore/files/FILES.tex), in C. Same rules as
// diag.ts (the header there has them): write gives two-space indentation, a map's keys in code
// point order, bytes as h'...', a typed array as its tag on its bytes, and each number as the
// shortest decimal that reads back as it; read takes what RFC 8949 Section 8 and RFC 8610
// Appendix G allow, and refuses a tag other than a typed array's, undefined, other simple
// values, a key that is not text, and a key twice. Values are json.h's.
//
// Text is UTF-8 as json.h holds strings: U+0000 may be 00 or C0 80, a lone surrogate its 3-byte
// form (and is refused inside a string). A fault's position is as diag.ts has it: the offset in
// UTF-16 code units, the line and the column from 1.
#ifndef DIAG_H
#define DIAG_H

#include "../../../../ermine/encoding/c/json.h"

#include <stddef.h>

// where a read went wrong; why is a static string
typedef struct {
	size_t at;
	size_t line;
	size_t column;
	const char *why;
} diag_error;

// the value as text, a new NUL-terminated string (free it): no final newline. NULL when the value
// has no diagnostic notation (a lone surrogate in a string or key), with a reason, a
// static string, in *why when it is not NULL
char *diag_write(const Json *value, const char **why);
// the value the text gives, a new value (jsonFree it). NULL on any other text, with *error
// filled. A value nested deeper than 4096 is refused (diag.ts refuses at the engine's stack)
Json *diag_read(const char *text, size_t length, diag_error *error);

#endif
