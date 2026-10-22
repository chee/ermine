// libFuzzer target (fuzz.sh hash): the input bytes decoded as one value with cborDecode
// (ermine/encoding); taken, hashValue names it as BLAKE3 of the input (a value's encoding is its
// one canonical form, so the input). nothing leaks, ASan and UBSan quiet.
#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "hash.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	unsigned char *input = malloc(size ? size : 1);
	memcpy(input, data, size);
	const char *why = NULL;
	size_t at = 0;
	Json *value = cborDecode(input, size, &why, &at);
	if (value) {
		uint8_t name[32], want[32];
		if (!hashValue(value, name, &why)) die("no hash");
		blake3_hasher h;
		blake3_hasher_init(&h);
		blake3_hasher_update(&h, input, size);
		blake3_hasher_finalize(&h, want, 32);
		if (memcmp(name, want, 32) != 0) die("the hash is not BLAKE3 of the encoding");
		jsonFree(value);
	}
	free(input);
	return 0;
}
