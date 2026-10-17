// libFuzzer target (fuzz.sh blop): the input bytes decoded as a blop with blop_decode. Checked:
// - taken: the bytes are a canonical encoding (cborCheck); encoding the blop again gives them
//   exactly; its name is the same for the same bytes;
// - refused: not-a-blop, nothing else;
// - nothing leaks, ASan and UBSan quiet.
#include "blop.h"
#include "cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	uint8_t *input = malloc(size ? size : 1);
	memcpy(input, data, size);
	Json *b = NULL;
	blop_error e = blop_decode(input, size, &b);
	if (e.code != BLOP_OK) {
		if (e.code != BLOP_NOT_A_BLOP) die("refused, not as not-a-blop");
		if (b) die("refused, and a blop made");
		free(e.field);
		free(input);
		return 0;
	}
	if (!cborCheck(input, size, NULL, NULL)) die("taken, and no canonical encoding");
	uint8_t *out = NULL;
	size_t length = 0;
	blop_error again = blop_encode(b, &out, &length);
	if (again.code != BLOP_OK) die("a blop read is refused when written");
	if (length != size || memcmp(out, input, size) != 0) die("written again, other bytes");
	uint8_t x[32], y[32];
	blop_name(input, size, x);
	blop_name(out, length, y);
	if (memcmp(x, y, 32) != 0) die("one encoding, two names");
	free(out);
	jsonFree(b);
	free(input);
	return 0;
}
