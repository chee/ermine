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
	case SL_ID: return "id";
	case SL_OK:
	case SL_COMMIT: break;
	}
	return "";
}

bool sl_id(const uint8_t *s, size_t n) {
	for (size_t i = 0; i < n;) {
		uint8_t c = s[i];
		// no U+0000: C ids end at it
		if (c == 0) return false;
		size_t k = c < 0x80 ? 1 : c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
		if (k == 0 || i + k > n) return false;
		for (size_t j = 1; j < k; j++)
			if ((s[i + j] & 0xc0) != 0x80) return false;
		// no overlong form, no surrogate, nothing past U+10FFFF
		if (k == 3 && ((c == 0xe0 && s[i + 1] < 0xa0) || (c == 0xed && s[i + 1] >= 0xa0))) return false;
		if (k == 4 && ((c == 0xf0 && s[i + 1] < 0x90) || (c == 0xf4 && s[i + 1] >= 0x90))) return false;
		i += k;
	}
	return true;
}

// what is signed: "ermine/v1/commit", the length of the document's id's UTF-8 (an unsigned varint),
// that UTF-8, the signature's header, then the commit's name (a header and a name each tell their own
// length), malloc'd into *m. 0: the id is not well-formed. MESSAGE: what the built in verifier's
// cache holds on the stack (a sealed message's, said below, with the longest topic); a longer message
// is checked from the heap
#define MESSAGE (17 + 32 + 8 + SL_TOPIC)
#define DOMAIN "ermine/v1/commit"
static size_t message(const uint8_t *doc, size_t n, const uint8_t *header, size_t header_length,
	const uint8_t name[CM_NAME], uint8_t **m) {
	*m = NULL;
	if (doc == NULL || !sl_id(doc, n)) return 0;
	*m = allocate(16 + 10 + n + header_length + CM_NAME);
	size_t at = 16;
	memcpy(*m, DOMAIN, 16);
	size_t v = n;
	do (*m)[at++] = (uint8_t)((v & 0x7f) | (v >= 0x80 ? 0x80 : 0)), v >>= 7;
	while (v > 0);
	memcpy(*m + at, doc, n);
	memcpy(*m + at + n, header, header_length);
	memcpy(*m + at + n + header_length, name, CM_NAME);
	return at + n + header_length + CM_NAME;
}

// Ed25519: the multicodec code of ed25519-pub (0xed, varint 0xed 0x01), and the varsig (v1, the
// version UCAN 1.0 uses) header: 0x34 0x01 (varsig, version 1), then EdDSA 0xed 0x01 with its curve
// 0xed 0x01 (ed25519-pub) and its hash 0x13 (sha2-512; RFC 8032), then the payload encoding 0x5f
// (byte-identical): what is signed is our own bytes ("ermine/v1/commit", an id, then a name), no DAG-CBOR
// (0x71) or other codec to render, so the one that says the payload is used as it is
#define ED25519 0xed
static const uint8_t ED25519_HEADER[8] = {0x34, 0x01, 0xed, 0x01, 0xed, 0x01, 0x13, 0x5f};

// the keys decoded, and the signatures found good, the oldest let go of past CACHED (one a slot): a
// seal is checked again as it is stored, taken in and handed on, and one signer signs most of what
// comes (seal.ts's keys and checked)
#define CACHED 4096
#define KEYS 16
static ermEd25519Key keys[KEYS];
static size_t keys_next;
static struct {
	uint8_t hash[32];
	bool used;
} checked[CACHED];

static bool ed25519_verify(void *context, const uint8_t *signature, const uint8_t *key, size_t key_length,
	const uint8_t *m, size_t length) {
	(void)context;
	if (key_length != 32) return false;
	uint8_t small[32 + 64 + MESSAGE], hash[32];
	uint8_t *all = length > MESSAGE ? allocate(96 + length) : small;
	memcpy(all, key, 32), memcpy(all + 32, signature, 64), memcpy(all + 96, m, length);
	cm_digest(all, 96 + length, hash);
	if (all != small) free(all);
	size_t slot;
	memcpy(&slot, hash, sizeof slot);
	slot %= CACHED;
	if (checked[slot].used && memcmp(checked[slot].hash, hash, 32) == 0) return true;
	const ermEd25519Key *k = NULL;
	for (size_t i = 0; i < KEYS && k == NULL; i++)
		if (memcmp(keys[i].pub, key, 32) == 0 && keys[i].good) k = &keys[i];
	if (k == NULL) {
		ermEd25519Key *fresh = &keys[keys_next++ % KEYS];
		if (!ermEd25519KeyOf(fresh, key)) return false;
		k = fresh;
	}
	if (!ermEd25519VerifyKey(k, m, length, signature)) return false;
	memcpy(checked[slot].hash, hash, 32);
	checked[slot].used = true;
	return true;
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
	ermEd25519SignPair(&((sl_seeded *)context)->pair, m, length, signature);
	return 64;
}

void sl_seeded_init(sl_seeded *s, const uint8_t seed[32]) {
	memcpy(s->seed, seed, 32);
	ermEd25519PairOf(&s->pair, s->seed);
	s->signer.key_length = cm_key_join(ED25519, s->pair.pub, 32, s->signer.key);
	s->signer.header = ED25519_HEADER;
	s->signer.header_length = sizeof ED25519_HEADER;
	s->signer.sign = seeded_sign;
	s->signer.context = s;
}

// one piece of the stored id's: its length (an unsigned varint), then its bytes
static size_t piece(uint8_t *to, const uint8_t *bytes, size_t length) {
	size_t at = 0, v = length;
	do to[at++] = (uint8_t)((v & 0x7f) | (v >= 0x80 ? 0x80 : 0)), v >>= 7;
	while (v > 0);
	memcpy(to + at, bytes, length);
	return at + length;
}

bool sl_stored_id(const uint8_t *id, size_t length, const uint8_t name[CM_NAME], uint8_t stored[32]) {
	if (id == NULL || !sl_id(id, length)) return false;
	uint8_t small[256];
	size_t room = 3 * 10 + 16 + length + CM_NAME;
	uint8_t *all = room > sizeof small ? allocate(room) : small;
	size_t at = piece(all, (const uint8_t *)"ermine/v1/stored", 16);
	at += piece(all + at, id, length);
	at += piece(all + at, name, CM_NAME);
	cm_digest(all, at, stored);
	if (all != small) free(all);
	return true;
}

bool sl_stored(const uint8_t *sealed, size_t length, uint8_t stored[32]) {
	Json *x = cborDecode(sealed, length, NULL, NULL);
	const Json *id = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "id") : NULL;
	const Json *commit = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "commit") : NULL;
	bool ok = id != NULL && id->type == JSON_STRING && commit != NULL && commit->type == JSON_BYTES;
	if (ok) {
		uint8_t name[CM_NAME];
		cm_name(commit->bytes.data, commit->bytes.length, name);
		ok = sl_stored_id((const uint8_t *)id->string, id->stringLength, name, stored);
	}
	jsonFree(x);
	return ok;
}

sl_code sl_seal(const uint8_t *commit, size_t length, const sl_signer *signer, const uint8_t *doc, size_t doc_length,
	const sl_made *made, uint8_t **out, size_t *out_length, cm_code *why, char **field) {
	*out = NULL;
	if (why != NULL) *why = CM_OK;
	if (field != NULL) *field = NULL;
	uint8_t name[CM_NAME];
	cm_commit decoded = {0};
	const cm_commit *c = NULL;
	if (made != NULL) c = made->commit, memcpy(name, made->name, CM_NAME);
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
	uint8_t *m;
	size_t m_length = message(doc, doc_length, signer->header, signer->header_length, name, &m);
	if (m_length == 0) return SL_SHAPE;
	uint8_t *signature = allocate(signer->header_length + SL_RAW_MAX);
	size_t raw = signer->sign(signer->context, m, m_length, signature + signer->header_length);
	free(m);
	if (raw == 0 || raw > SL_RAW_MAX) return free(signature), SL_SHAPE;
	memcpy(signature, signer->header, signer->header_length);
	Json *sealed = jsonObject();
	jsonAdd(sealed, "id", jsonStringOfLength((const char *)doc, doc_length));
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

sl_code sl_unseal(const uint8_t *sealed, size_t length, const uint8_t *doc, size_t doc_length, sl_unsealed *out,
	const sl_verifiers *more) {
	memset(out, 0, sizeof *out);
	Json *x = cborDecode(sealed, length, NULL, NULL);
	if (x == NULL || x->type != JSON_OBJECT || x->object.count != 3) return jsonFree(x), SL_SHAPE;
	const Json *id = jsonGet(x, "id"), *commit = jsonGet(x, "commit"), *signature = jsonGet(x, "signature");
	if (id == NULL || id->type != JSON_STRING || commit == NULL || commit->type != JSON_BYTES || signature == NULL ||
		signature->type != JSON_BYTES || !sl_id((const uint8_t *)id->string, id->stringLength) || doc == NULL ||
		!sl_id(doc, doc_length)) {
		jsonFree(x);
		return SL_SHAPE;
	}
	cm_commit c;
	if (cm_decode(commit->bytes.data, commit->bytes.length, &c, NULL) != CM_OK) return jsonFree(x), SL_SHAPE;
	if (id->stringLength != doc_length || memcmp(id->string, doc, doc_length) != 0) {
		cm_free(&c);
		jsonFree(x);
		out->reason = SL_ELSEWHERE;
		return SL_ID;
	}
	uint8_t name[CM_NAME];
	cm_name(commit->bytes.data, commit->bytes.length, name);
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
	} else {
		uint8_t *m;
		size_t m_length = message(doc, doc_length, v->header, v->header_length, name, &m);
		if (m_length == 0) {
			cm_free(&c);
			jsonFree(x);
			return SL_SHAPE;
		}
		if (!v->verify(v->context, signature->bytes.data + v->header_length, key, key_length, m, m_length)) reason = "";
		free(m);
	}
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
	memcpy(out->name, name, CM_NAME);
	sl_stored_id(doc, doc_length, name, out->stored);
	jsonFree(x);
	return SL_OK;
}

// what a message's seal signs: "ermine/v0/message", the BLAKE3 of the bytes, the signature's header,
// then the topic (the rest). 0: a topic that is not one
static size_t said(const char *topic, const uint8_t *header, size_t header_length, const uint8_t *bytes, size_t length,
	uint8_t **m) {
	size_t t = topic != NULL ? strlen(topic) : 0;
	if (t == 0 || t > SL_TOPIC) return 0;
	*m = allocate(49 + header_length + t);
	memcpy(*m, "ermine/v0/message", 17);
	cm_digest(bytes, length, *m + 17);
	memcpy(*m + 49, header, header_length);
	memcpy(*m + 49 + header_length, topic, t);
	return 49 + header_length + t;
}

sl_code sl_seal_message(const char *topic, const uint8_t *bytes, size_t length, const sl_signer *signer, uint8_t **out,
	size_t *out_length) {
	*out = NULL;
	uint8_t *m;
	size_t m_length = said(topic, signer->header, signer->header_length, bytes, length, &m);
	if (m_length == 0) return SL_SHAPE;
	uint8_t *signature = allocate(signer->header_length + SL_RAW_MAX);
	size_t raw = signer->sign(signer->context, m, m_length, signature + signer->header_length);
	free(m);
	if (raw == 0 || raw > SL_RAW_MAX) return free(signature), SL_SHAPE;
	memcpy(signature, signer->header, signer->header_length);
	// in the canonical order: bytes, signer, signature
	Json *sealed = jsonObject();
	jsonAdd(sealed, "bytes", jsonBytes(bytes, length));
	jsonAdd(sealed, "signer", jsonBytes(signer->key, signer->key_length));
	jsonAdd(sealed, "signature", jsonBytes(signature, signer->header_length + raw));
	free(signature);
	size_t n = 0;
	cborEncode(sealed, NULL, 0, &n, NULL);
	uint8_t *b = allocate(n);
	cborEncode(sealed, b, n, &n, NULL);
	jsonFree(sealed);
	*out = b;
	*out_length = n;
	return SL_OK;
}

sl_code sl_open_message(const uint8_t *sealed, size_t length, const char *topic, sl_message *out, const sl_verifiers *more) {
	memset(out, 0, sizeof *out);
	Json *x = cborDecode(sealed, length, NULL, NULL);
	if (x == NULL || x->type != JSON_OBJECT || x->object.count != 3) return jsonFree(x), SL_SHAPE;
	const Json *bytes = jsonGet(x, "bytes"), *signer = jsonGet(x, "signer"), *signature = jsonGet(x, "signature");
	uint64_t code;
	const uint8_t *key;
	size_t key_length;
	if (bytes == NULL || bytes->type != JSON_BYTES || signer == NULL || signer->type != JSON_BYTES ||
		signature == NULL || signature->type != JSON_BYTES || signer->bytes.length > CM_SIGNER_MAX ||
		!cm_key_split(signer->bytes.data, signer->bytes.length, &code, &key, &key_length)) {
		jsonFree(x);
		return SL_SHAPE;
	}
	const sl_verifier *v = NULL;
	for (size_t i = 0; v == NULL && i < 1 + (more != NULL ? more->count : 0); i++) {
		const sl_verifier *w = i == 0 ? &BUILT_IN : &more->items[i - 1];
		if (signature->bytes.length >= w->header_length && memcmp(signature->bytes.data, w->header, w->header_length) == 0) v = w;
	}
	const char *reason = NULL;
	if (v == NULL) reason = "no verifier for this signature header";
	else if (code != v->code) reason = "the header and the signer's key differ";
	else if (signature->bytes.length != v->header_length + v->size) return jsonFree(x), SL_SHAPE;
	else {
		uint8_t *m;
		size_t m_length = said(topic, v->header, v->header_length, bytes->bytes.data, bytes->bytes.length, &m);
		if (m_length == 0) return jsonFree(x), SL_SHAPE;
		if (!v->verify(v->context, signature->bytes.data + v->header_length, key, key_length, m, m_length)) reason = "";
		free(m);
	}
	if (reason != NULL) {
		jsonFree(x);
		out->reason = reason[0] ? reason : NULL;
		return SL_SIGNATURE;
	}
	memcpy(out->signer, signer->bytes.data, signer->bytes.length);
	out->signer_length = signer->bytes.length;
	out->bytes = allocate(bytes->bytes.length + 1);
	memcpy(out->bytes, bytes->bytes.data, bytes->bytes.length);
	out->length = bytes->bytes.length;
	jsonFree(x);
	return SL_OK;
}

void sl_message_free(sl_message *m) {
	free(m->bytes);
	*m = (sl_message){0};
}

void sl_free(sl_unsealed *u) {
	cm_free(&u->commit);
	free(u->bytes);
	*u = (sl_unsealed){0};
}
