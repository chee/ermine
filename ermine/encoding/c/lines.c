// The shared loop of the C harnesses (conformance/c/harness.c), reading a line as it does except for
// one form: {"/": {"symbol": name}}, a symbol, which a value in C has no form for (README of the
// sync suites: "for refusals only"). It is read as a string with a lone surrogate, "\ud800": a value
// that can't be carried, which is what a symbol is to the encoding. The runner writes the form
// compactly, and that is the spelling looked for. A harness of the sync group links this in place
// of conformance/c/harness.c
#define _POSIX_C_SOURCE 200809L
#include "../../../core/op/c/json.h"

#include <stdlib.h>
#include <string.h>

// the text with each symbol form written "\ud800"; a fresh C string
static char *without_symbols(const char *text) {
	static const char form[] = "{\"/\":{\"symbol\":\"";
	size_t n = strlen(text);
	char *out = malloc(n + 1), *w = out;
	if (out == NULL) abort();
	for (const char *p = text; *p;) {
		if (strncmp(p, form, sizeof form - 1) == 0) {
			// the name's string, to its closing quote, then }}
			const char *q = p + sizeof form - 1;
			while (*q && *q != '"') q += *q == '\\' && q[1] ? 2 : 1;
			if (q[0] == '"' && q[1] == '}' && q[2] == '}') {
				memcpy(w, "\"\\ud800\"", 8);
				w += 8;
				p = q + 3;
				continue;
			}
		}
		*w++ = *p++;
	}
	*w = 0;
	return out;
}

static op_value *read_with_symbols(const char *text, const char **why) {
	if (strstr(text, "\"symbol\"") == NULL) return op_json_read(text, why);
	char *plain = without_symbols(text);
	op_value *v = op_json_read(plain, why);
	free(plain);
	return v;
}

// the loop reads through the above
#define op_json_read read_with_symbols
#include "../../../conformance/c/harness.c"
