// libFuzzer target (fuzz.sh deflate): the input's first byte picks. Odd: the rest inflated, with a
// small limit; what comes out deflates and inflates back to itself. Even: the rest deflated, twice
// the same bytes, and inflated back to the rest, refused under a limit one short of it. Checked
// too: a refusal leaves *out NULL; nothing leaks, ASan and UBSan quiet.
#include "deflate.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

// in deflated and inflated back is in
static void back(const uint8_t *in, size_t n) {
	uint8_t *z, *z2, *out;
	size_t zn, zn2, outn;
	df_deflate(in, n, &z, &zn);
	df_deflate(in, n, &z2, &zn2);
	if (zn != zn2 || memcmp(z, z2, zn) != 0) die("deflate twice, other bytes");
	if (df_inflate(z, zn, n, &out, &outn) != DF_OK) die("its own deflate is refused");
	if (outn != n || memcmp(out, in, n) != 0) die("inflated back, other bytes");
	free(out);
	if (n > 0) {
		out = (uint8_t *)1;
		if (df_inflate(z, zn, n - 1, &out, &outn) != DF_OVER_THE_LIMIT) die("over the limit, taken");
		if (out != NULL) die("refused, and *out set");
	}
	free(z), free(z2);
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	if (size == 0) return 0;
	size_t n = size - 1;
	uint8_t *in = malloc(n ? n : 1);
	memcpy(in, data + 1, n);
	if (data[0] & 1) {
		uint8_t *out = (uint8_t *)1;
		size_t outn;
		df_code code = df_inflate(in, n, 1 << 16, &out, &outn);
		if (code != DF_OK) {
			if (out != NULL) die("refused, and *out set");
		} else {
			if (outn > 1 << 16) die("more than the limit");
			back(out, outn);
			free(out);
		}
	} else {
		back(in, n);
	}
	free(in);
	return 0;
}
