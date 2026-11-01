// libFuzzer target (fuzz.sh cbor): decodes the input with cborDecode. cborCheck must agree. When
// taken, re-encoding must give the input exactly (also into a short or growing buffer), and the
// value read again must be equal. Leaks, out-of-bounds access and undefined behaviour are caught
// by the sanitizers.
#include "cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	// the input in a buffer of its own size, so a read past it is caught
	unsigned char *input = malloc(size ? size : 1);
	memcpy(input, data, size);
	const char *why = NULL, *whyCheck = NULL;
	size_t at = 0, atCheck = 0;
	Json *value = cborDecode(input, size, &why, &at);
	bool checked = cborCheck(input, size, &whyCheck, &atCheck);
	if (checked != (value != NULL)) die("cborCheck and cborDecode disagree");
	if (!value) {
		if (!why || why != whyCheck || at != atCheck) die("cborCheck gives another reason");
		if (at > size) die("a reason past the input");
		free(input);
		return 0;
	}
	size_t length = 0;
	if (!cborEncode(value, NULL, 0, &length, &why)) die("a value read has no encoding");
	if (length != size) die("encoded again, another length");
	unsigned char *out = malloc(length + 1);
	size_t again = 0;
	if (!cborEncode(value, out, length, &again, &why) || again != length) die("encoding twice differs");
	if (memcmp(out, input, size) != 0) die("encoded again, other bytes: not canonical");
	// a short buffer: its first bytes, the whole length
	if (length > 1) {
		size_t half = length / 2, whole = 0;
		unsigned char *some = malloc(half);
		if (!cborEncode(value, some, half, &whole, &why) || whole != length) die("a short buffer, another length");
		if (memcmp(some, input, half) != 0) die("a short buffer, other bytes");
		free(some);
	}
	CborOut grown = { NULL, 0, 0, true };
	if (!cborPut(&grown, value, &why) || grown.length != size || memcmp(grown.data, input, size) != 0) die("a buffer that grows, other bytes");
	free(grown.data);
	Json *back = cborDecode(out, length, &why, &at);
	if (!back) die("its own encoding is refused");
	if (!jsonEqual(back, value)) die("read again, another value");
	jsonFree(back);
	jsonFree(value);
	free(out);
	free(input);
	return 0;
}
