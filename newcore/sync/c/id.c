#include "id.h"

#include "../../c/blake3/blake3.h"
#include "../../encoding/c/cbor.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char prefix[] = "ermine://";
// "ermine/v0/id": 12 bytes
static const char domain[] = "ermine/v0/id";

id_code id_make(const char *lock, const uint8_t *made, size_t made_length, char out[ID_LENGTH + 1]) {
	size_t length = strlen(lock);
	if (utf8Surrogate(lock, length)) return ID_NAME;
	if (made_length != 32) return ID_SIZE;
	// the lock's name as a CBOR text string
	Json *name = jsonStringOfLength(lock, length);
	size_t n = 0;
	const char *why;
	cborEncode(name, NULL, 0, &n, &why);
	unsigned char *text = malloc(n);
	if (text == NULL) abort();
	cborEncode(name, text, n, &n, &why);
	jsonFree(name);
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, domain, 12);
	blake3_hasher_update(&h, text, n);
	blake3_hasher_update(&h, made, 32);
	uint8_t hash[32];
	blake3_hasher_finalize(&h, hash, 32);
	free(text);
	memcpy(out, prefix, 9);
	for (int i = 0; i < 32; i++) snprintf(out + 9 + 2 * i, 3, "%02x", hash[i]);
	return ID_OK;
}

static int digit(char c) {
	return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
}

int id_is(const char *id) {
	if (strlen(id) != ID_LENGTH || memcmp(id, prefix, 9) != 0) return 0;
	for (int i = 9; i < ID_LENGTH; i++)
		if (digit(id[i]) < 0) return 0;
	return 1;
}

id_code id_bytes(const char *id, uint8_t out[32]) {
	if (!id_is(id)) return ID_NOT_AN_ID;
	for (int i = 0; i < 32; i++) out[i] = (uint8_t)(digit(id[9 + 2 * i]) << 4 | digit(id[10 + 2 * i]));
	return ID_OK;
}
