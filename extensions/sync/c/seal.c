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

// Ed25519: the multicodec code of ed25519-pub (0xed, varint 0xed 0x01), and the varsig (v1, the
// version UCAN 1.0 uses) header: 0x34 0x01 (varsig, version 1), then EdDSA 0xed 0x01 with its curve
// 0xed 0x01 (ed25519-pub) and its hash 0x13 (sha2-512; RFC 8032), then the payload encoding 0x5f
// (byte-identical): what is signed is our own bytes ("ermine/v0/commit" then a name), no DAG-CBOR
// (0x71) or other codec to render, so the one that says the payload is used as it is
#define ED25519 0xed
static const uint8_t ED25519_HEADER[8] = {0x34, 0x01, 0xed, 0x01, 0xed, 0x01, 0x13, 0x5f};

static bool ed25519_verify(void *context, const uint8_t *signature, const uint8_t *key, size_t key_length,
	const uint8_t *m, size_t length) {
	(void)context;
	return key_length == 32 && ermEd25519Verify(key, m, length, signature);
}
static const sl_verifier BUILT_IN = {ED25519_HEADER, sizeof ED25519_HEADER, ED25519, 64, ed25519_verify, NULL};

size_t sl_header_length(const uint8_t *s, size_t length) {
	size_t at = 2;
	if (length < 2 || s[0] != 0x34 || s[1] != 0x01) return 0;
	uint64_t v[4];
	for (int i = 0; i < 4; i++) {
		// 3 more, and the fourth is the encoding; each a varint of 7 bytes at most
		v[i] = 0;
		size_t k = 0;
		for (;; k++) {
			if (k >= 7 || at >= length) return 0;
			uint8_t byte = s[at++];
			v[i] += (uint64_t)(byte & 0x7f) << (7 * k);
			if (byte < 0x80) break;
		}
	}
	bool algorithm = v[0] == 0xb1 || v[0] == 0xec || v[0] == 0xed || v[0] == 0x1205;
	bool encoding = v[3] == 0x5f || v[3] == 0x71 || v[3] == 0x0129;
	return algorithm && encoding ? at : 0;
}

static size_t seeded_sign(void *context, const uint8_t *m, size_t length, uint8_t signature[SL_RAW_MAX]) {
	ermEd25519Sign(((sl_seeded *)context)->seed, m, length, signature);
	return 64;
}

void sl_seeded_init(sl_seeded *s, const uint8_t seed[32]) {
	memcpy(s->seed, seed, 32);
	uint8_t raw[32];
	ermEd25519Public(s->seed, raw);
	s->signer.key_length = cm_key_join(ED25519, raw, 32, s->signer.key);
	s->signer.header = ED25519_HEADER;
	s->signer.header_length = sizeof ED25519_HEADER;
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
	bool same = c == NULL ||
		(c->signer_length == signer->key_length && memcmp(c->signer, signer->key, signer->key_length) == 0);
	cm_free(&decoded);
	if (!same) return SL_SIGNATURE;
	uint8_t m[48], *signature = allocate(signer->header_length + SL_RAW_MAX);
	message(name, m);
	size_t raw = signer->sign(signer->context, m, 48, signature + signer->header_length);
	if (raw == 0 || raw > SL_RAW_MAX) return free(signature), SL_SHAPE;
	memcpy(signature, signer->header, signer->header_length);
	Json *sealed = jsonObject();
	jsonAdd(sealed, "commit", jsonBytes(commit, length));
	jsonAdd(sealed, "signature", jsonBytes(signature, signer->header_length + raw));
	free(signature);
	size_t n = 0;
	cborEncode(sealed, NULL, 0, &n, NULL);
	uint8_t *bytes = allocate(n);
	cborEncode(sealed, bytes, n, &n, NULL);
	jsonFree(sealed);
	*out = bytes;
	*out_length = n;
	return SL_OK;
}

sl_code sl_unseal(const uint8_t *sealed, size_t length, sl_unsealed *out, const sl_verifiers *more) {
	memset(out, 0, sizeof *out);
	Json *x = cborDecode(sealed, length, NULL, NULL);
	if (x == NULL || x->type != JSON_OBJECT || x->object.count != 2) return jsonFree(x), SL_SHAPE;
	const Json *commit = jsonGet(x, "commit"), *signature = jsonGet(x, "signature");
	if (commit == NULL || commit->type != JSON_BYTES || signature == NULL || signature->type != JSON_BYTES) {
		jsonFree(x);
		return SL_SHAPE;
	}
	cm_commit c;
	if (cm_decode(commit->bytes.data, commit->bytes.length, &c, NULL) != CM_OK) return jsonFree(x), SL_SHAPE;
	uint8_t m[48], name[32];
	cm_name(commit->bytes.data, commit->bytes.length, name);
	message(name, m);
	// the built in, then more: the first whose header the signature begins with
	const sl_verifier *v = NULL;
	for (size_t i = 0; v == NULL && i < 1 + (more != NULL ? more->count : 0); i++) {
		const sl_verifier *w = i == 0 ? &BUILT_IN : &more->items[i - 1];
		if (signature->bytes.length >= w->header_length && memcmp(signature->bytes.data, w->header, w->header_length) == 0) v = w;
	}
	uint64_t code;
	const uint8_t *key;
	size_t key_length;
	// c was decoded, so its signer is a multikey
	cm_key_split(c.signer, c.signer_length, &code, &key, &key_length);
	const char *reason = NULL;
	if (v == NULL) reason = "no verifier for this signature header";
	else if (code != v->code) reason = "the header and the signer's key differ";
	else if (signature->bytes.length != v->header_length + v->size) {
		cm_free(&c);
		jsonFree(x);
		return SL_SHAPE;
	} else if (!v->verify(v->context, signature->bytes.data + v->header_length, key, key_length, m, 48)) reason = "";
	if (reason != NULL) {
		cm_free(&c);
		jsonFree(x);
		out->reason = reason[0] ? reason : NULL;
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
