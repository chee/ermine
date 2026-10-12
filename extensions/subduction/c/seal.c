#include "seal.h"

#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "ed25519/ed25519.h"
#include "../../../ermine/encoding/c/blop.h"
#include "../../../ermine/encoding/c/cbor.h"

#include <stdlib.h>
#include <string.h>

// "ermine/v0/change": 16 bytes, then the blop's name
static void message(const uint8_t *blop, size_t length, uint8_t m[48]) {
	memcpy(m, "ermine/v0/change", 16);
	blop_name(blop, length, m + 16);
}

// ed25519.c checks all of SEAL.tex's Strict rule: S < L, A and R canonical and not of small order,
// the equation without the cofactor
bool seal_good(const uint8_t signature[64], const uint8_t key[32], const uint8_t *m, size_t length) {
	return ermEd25519Verify(key, m, length, signature);
}

// the blop in bytes decoded; any fault in it is a shape fault
static seal_code blop_of(const uint8_t *bytes, size_t length, Json **blop) {
	blop_error e = blop_decode(bytes, length, blop);
	free(e.field);
	return e.code == BLOP_OK ? SEAL_OK : SEAL_SHAPE;
}

static int signed_by(const Json *blop, const uint8_t key[32]) {
	const Json *s = jsonGet(blop, "signer");
	return s->bytes.length == 32 && memcmp(s->bytes.data, key, 32) == 0;
}

seal_code seal_seal(const uint8_t *blop, size_t length, const seal_signer *signer, const seal_made *made, uint8_t **out, size_t *out_length) {
	*out = NULL;
	Json *b = NULL;
	if (made == NULL && blop_of(blop, length, &b) != SEAL_OK) return SEAL_SHAPE;
	int same = signed_by(made ? made->blop : b, signer->key);
	jsonFree(b);
	if (!same) return SEAL_SIGNATURE;
	uint8_t m[48], signature[64];
	if (made) memcpy(m, "ermine/v0/change", 16), memcpy(m + 16, made->name, 32);
	else message(blop, length, m);
	if (signer->sign(signer->context, m, 48, signature) != 64) return SEAL_SHAPE;
	if (!seal_good(signature, signer->key, m, 48)) return SEAL_SIGNATURE;
	Json *sealed = jsonObject();
	jsonAdd(sealed, "change", jsonBytes(blop, length));
	jsonAdd(sealed, "signer", jsonBytes(signer->key, 32));
	jsonAdd(sealed, "signature", jsonBytes(signature, 64));
	size_t n = 0;
	const char *why;
	cborEncode(sealed, NULL, 0, &n, &why);
	uint8_t *bytes = malloc(n);
	if (bytes == NULL) abort();
	cborEncode(sealed, bytes, n, &n, &why);
	jsonFree(sealed);
	*out = bytes;
	*out_length = n;
	return SEAL_OK;
}

static int is_bytes(const Json *x, size_t n) {
	return x != NULL && x->type == JSON_BYTES && x->bytes.length == n;
}

seal_code seal_unseal(const uint8_t *bytes, size_t length, seal_unsealed *out) {
	memset(out, 0, sizeof *out);
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL || !jsonIsObject(x) || x->object.count != 3) return jsonFree(x), SEAL_SHAPE;
	const Json *change = jsonGet(x, "change"), *signer = jsonGet(x, "signer"),
		*signature = jsonGet(x, "signature");
	if (change == NULL || change->type != JSON_BYTES || !is_bytes(signer, 32) || !is_bytes(signature, 64))
		return jsonFree(x), SEAL_SHAPE;
	Json *blop;
	if (blop_of(change->bytes.data, change->bytes.length, &blop) != SEAL_OK) return jsonFree(x), SEAL_SHAPE;
	uint8_t m[48];
	message(change->bytes.data, change->bytes.length, m);
	if (!signed_by(blop, signer->bytes.data) || !seal_good(signature->bytes.data, signer->bytes.data, m, 48)) {
		jsonFree(blop);
		jsonFree(x);
		return SEAL_SIGNATURE;
	}
	out->blop = blop;
	memcpy(out->name, m + 16, 32);
	seal_stored(bytes, length, out->stored);
	memcpy(out->signer, signer->bytes.data, 32);
	jsonFree(x);
	return SEAL_OK;
}

void seal_free(seal_unsealed *u) {
	jsonFree(u->blop);
	u->blop = NULL;
}

void seal_stored(const uint8_t *bytes, size_t length, uint8_t stored[32]) {
	blop_name(bytes, length, stored);
}
