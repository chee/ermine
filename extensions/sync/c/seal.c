// A sealed commit (seal.h), in C
#include "seal.h"

#include "../../../ermine/encoding/c/cbor.h"
#include "ed25519/ed25519.h"

#include <stdlib.h>
#include <string.h>

const char *sl_code_name(sl_code code) {
	switch (code) {
	case SL_SHAPE: return "shape";
	case SL_SIGNATURE: return "signature";
	case SL_OK:
	case SL_COMMIT: break;
	}
	return "";
}

// "ermine/v0/commit", then the commit's name
static void message(const uint8_t name[32], uint8_t m[48]) {
	memcpy(m, "ermine/v0/commit", 16);
	memcpy(m + 16, name, 32);
}

bool sl_good(const uint8_t signature[64], const uint8_t key[32], const uint8_t *m, size_t length) {
	return ermEd25519Verify(key, m, length, signature);
}

static size_t seeded_sign(void *context, const uint8_t *m, size_t length, uint8_t signature[64]) {
	ermEd25519Sign(((sl_seeded *)context)->seed, m, length, signature);
	return 64;
}

void sl_seeded_init(sl_seeded *s, const uint8_t seed[32]) {
	memcpy(s->seed, seed, 32);
	ermEd25519Public(s->seed, s->signer.key);
	s->signer.sign = seeded_sign;
	s->signer.context = s;
}

void sl_stored(const uint8_t *sealed, size_t length, uint8_t stored[32]) {
	cm_name(sealed, length, stored);
}

sl_code sl_seal(const uint8_t *commit, size_t length, const sl_signer *signer, const sl_made *made,
	uint8_t **out, size_t *out_length, cm_code *why, char **field) {
	*out = NULL;
	if (why != NULL) *why = CM_OK;
	if (field != NULL) *field = NULL;
	uint8_t name[32];
	cm_commit decoded = {0};
	const cm_commit *c = NULL;
	if (made != NULL) c = made->commit, memcpy(name, made->name, 32);
	else {
		cm_code code = cm_decode(commit, length, &decoded, field);
		if (code != CM_OK) {
			if (why != NULL) *why = code;
			return SL_COMMIT;
		}
		c = &decoded;
		cm_name(commit, length, name);
	}
	bool same = c == NULL || memcmp(c->signer, signer->key, 32) == 0;
	cm_free(&decoded);
	if (!same) return SL_SIGNATURE;
	uint8_t m[48], signature[64];
	message(name, m);
	if (signer->sign(signer->context, m, 48, signature) != 64) return SL_SHAPE;
	Json *sealed = jsonObject();
	jsonAdd(sealed, "commit", jsonBytes(commit, length));
	jsonAdd(sealed, "signature", jsonBytes(signature, 64));
	size_t n = 0;
	cborEncode(sealed, NULL, 0, &n, NULL);
	uint8_t *bytes = allocate(n);
	cborEncode(sealed, bytes, n, &n, NULL);
	jsonFree(sealed);
	*out = bytes;
	*out_length = n;
	return SL_OK;
}

sl_code sl_unseal(const uint8_t *sealed, size_t length, sl_unsealed *out) {
	memset(out, 0, sizeof *out);
	Json *x = cborDecode(sealed, length, NULL, NULL);
	if (x == NULL || x->type != JSON_OBJECT || x->object.count != 2) return jsonFree(x), SL_SHAPE;
	const Json *commit = jsonGet(x, "commit"), *signature = jsonGet(x, "signature");
	if (commit == NULL || commit->type != JSON_BYTES || signature == NULL ||
		signature->type != JSON_BYTES || signature->bytes.length != 64) {
		jsonFree(x);
		return SL_SHAPE;
	}
	cm_commit c;
	if (cm_decode(commit->bytes.data, commit->bytes.length, &c, NULL) != CM_OK) return jsonFree(x), SL_SHAPE;
	uint8_t m[48], name[32];
	cm_name(commit->bytes.data, commit->bytes.length, name);
	message(name, m);
	if (!sl_good(signature->bytes.data, c.signer, m, 48)) {
		cm_free(&c);
		jsonFree(x);
		return SL_SIGNATURE;
	}
	out->commit = c;
	out->bytes = allocate(commit->bytes.length + 1);
	memcpy(out->bytes, commit->bytes.data, commit->bytes.length);
	out->length = commit->bytes.length;
	memcpy(out->name, name, 32);
	sl_stored(sealed, length, out->stored);
	jsonFree(x);
	return SL_OK;
}

void sl_free(sl_unsealed *u) {
	cm_free(&u->commit);
	free(u->bytes);
	*u = (sl_unsealed){0};
}
