#include "hash.h"

#include <stdlib.h>

#include "blake3/blake3.h"
#include "cbor.h"

bool hashValue(const Json *value, uint8_t out[32], const char **why) {
	size_t length = 0;
	if (!cborEncode(value, NULL, 0, &length, why)) return false;
	unsigned char *bytes = malloc(length ? length : 1);
	if (bytes == NULL) {
		*why = "out of memory";
		return false;
	}
	cborEncode(value, bytes, length, &length, why);
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, length);
	blake3_hasher_finalize(&h, out, 32);
	free(bytes);
	return true;
}
