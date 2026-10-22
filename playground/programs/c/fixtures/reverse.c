// A native compiler (native.h), for conformance/native: its output its input's bytes reversed.
// Built by the root Makefile into reverse.so beside this file; never checked in.
#include <stdlib.h>

#include "../native.h"

native_compile compile;

int compile(const uint8_t *in, size_t n, uint8_t **out, size_t *outn) {
	uint8_t *o = malloc(n > 0 ? n : 1);
	if (o == NULL) return 1;
	for (size_t i = 0; i < n; i++) o[i] = in[n - 1 - i];
	*out = o;
	*outn = n;
	return 0;
}
