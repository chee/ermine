// The C seal on the line protocol (conformance/c/harness.h): requests and answers as
// extensions/together/typescript/seal_harness.ts has them. Nothing lasts between lines
#include "seal.h"
#include "ed25519/ed25519.h"

#include "../../../ermine/encoding/c/commit_form_harness.h"
#include "../../../ermine/encoding/c/pack.h"

#include <stdlib.h>
#include <string.h>

static void refuse(FILE *out, sl_code code) {
	fprintf(out, "{\"error\":\"%s\"}", sl_code_name(code));
}

// the document a seal is for: doc (hex), else the default's 32 bytes; refused shape when not 32
// bytes, the answer written
static bool doc_of(const op_value *r, FILE *out, uint8_t doc[32]) {
	const char *hex = hh_str(r, "doc");
	if (hex == NULL) {
		// 2a × 16, then 00 × 16
		memset(doc, 0, 32);
		memset(doc, 0x2a, 16);
		return true;
	}
	uint8_t *b;
	size_t n;
	if (!cf_unhex(hex, &b, &n)) return hh_error(out, "not hex"), false;
	if (n != 32) return refuse(out, SL_SHAPE), false;
	memcpy(doc, b, 32);
	return true;
}

// a seed: hex, 32 bytes; the answer is written when it is not
static bool seed_of(const op_value *r, FILE *out, sl_seeded *s) {
	const char *hex = hh_str(r, "seed");
	uint8_t *b;
	size_t n;
	if (hex == NULL || !cf_unhex(hex, &b, &n)) return hh_error(out, "not hex"), false;
	if (n != 32) return refuse(out, SL_SHAPE), false;
	sl_seeded_init(s, b);
	return true;
}

static void key(const op_value *r, FILE *out) {
	sl_seeded s;
	if (!seed_of(r, out, &s)) return;
	fputs("{\"key\":", out);
	cf_put_hex(out, s.signer.key, s.signer.key_length);
	fputc('}', out);
}

static void seal(const op_value *r, FILE *out) {
	sl_seeded s;
	if (!seed_of(r, out, &s)) return;
	// header: another varsig header to sign under
	const char *header = hh_str(r, "header");
	if (header != NULL) {
		uint8_t *h;
		size_t n;
		if (!cf_unhex(header, &h, &n)) {
			hh_error(out, "not hex");
			return;
		}
		s.signer.header = h, s.signer.header_length = n;
	}
	const op_value *form = op_get(r, "commit");
	uint8_t *commit = NULL;
	size_t length = 0;
	bool made = false;
	if (form != NULL && form->type == OP_STR) {
		if (!cf_unhex(form->str, &commit, &length)) {
			hh_error(out, "not hex");
			return;
		}
	} else {
		const char *bad = NULL;
		Json *j = cf_commit(form, &bad);
		if (j == NULL) {
			hh_error(out, "%s", bad ? bad : "bad commit");
			return;
		}
		char *field;
		cm_code code = cm_encode_json(j, &commit, &length, &field);
		jsonFree(j);
		if (code != CM_OK) {
			cf_put_refusal(out, code, field);
			free(field);
			return;
		}
		made = true;
	}
	uint8_t *sealed;
	size_t sealed_length;
	cm_code why;
	char *field;
	uint8_t doc[32];
	if (!doc_of(r, out, doc)) {
		if (made) free(commit);
		return;
	}
	sl_code code = sl_seal(commit, length, &s.signer, doc, NULL, &sealed, &sealed_length, &why, &field);
	if (made) free(commit);
	if (code == SL_COMMIT) {
		cf_put_refusal(out, why, field);
		free(field);
	} else if (code != SL_OK) refuse(out, code);
	else {
		fputs("{\"sealed\":", out);
		cf_put_hex(out, sealed, sealed_length);
		fputc('}', out);
		free(sealed);
	}
}

// also: more varsig headers, each checked as Ed25519 (strictly)
static bool also_verify(void *context, const uint8_t *signature, const uint8_t *key, size_t key_length,
	const uint8_t *message, size_t length) {
	(void)context;
	return key_length == 32 && ermEd25519Verify(key, message, length, signature);
}

// also's headers into extra (16 at most); the answer is written when one is not hex
static bool also_of(const op_value *r, FILE *out, sl_verifiers *extra) {
	sl_verifier *more = (sl_verifier *)extra->items;
	const op_value *also = op_get(r, "also");
	for (size_t i = 0; also != NULL && also->type == OP_LIST && i < also->count && i < 16; i++) {
		uint8_t *h;
		size_t n;
		if (also->items[i]->type != OP_STR || !cf_unhex(also->items[i]->str, &h, &n)) return hh_error(out, "not hex"), false;
		more[extra->count++] = (sl_verifier){h, n, 0xed, 64, also_verify, NULL};
	}
	return true;
}

// a sealed thing: value (its JSON form, encoded canonically), else sealed (hex); the answer is
// written when neither is
static bool sealed_of(const op_value *r, FILE *out, uint8_t **bytes, size_t *length) {
	const op_value *value = op_get(r, "value");
	const char *hex = hh_str(r, "sealed");
	if (value != NULL) {
		if (!cf_value_bytes(value, bytes, length)) return hh_error(out, "no encoding"), false;
	} else if (hex == NULL || !cf_unhex(hex, bytes, length)) return hh_error(out, "not hex"), false;
	return true;
}

static void seal_message(const op_value *r, FILE *out) {
	sl_seeded s;
	if (!seed_of(r, out, &s)) return;
	const char *header = hh_str(r, "header"), *topic = hh_str(r, "topic"), *hex = hh_str(r, "bytes");
	if (header != NULL) {
		uint8_t *h;
		size_t n;
		if (!cf_unhex(header, &h, &n)) {
		hh_error(out, "not hex");
		return;
	}
		s.signer.header = h, s.signer.header_length = n;
	}
	uint8_t *bytes, *sealed;
	size_t length, sealed_length;
	if (topic == NULL) {
		hh_error(out, "no topic");
		return;
	}
	if (hex == NULL || !cf_unhex(hex, &bytes, &length)) {
		hh_error(out, "not hex");
		return;
	}
	sl_code code = sl_seal_message(topic, bytes, length, &s.signer, &sealed, &sealed_length);
	if (code != SL_OK) {
		refuse(out, code);
		return;
	}
	fputs("{\"sealed\":", out);
	cf_put_hex(out, sealed, sealed_length);
	fputc('}', out);
	free(sealed);
}

static void open_message(const op_value *r, FILE *out) {
	uint8_t *bytes;
	size_t length;
	const char *topic = hh_str(r, "topic");
	if (topic == NULL) {
		hh_error(out, "no topic");
		return;
	}
	if (!sealed_of(r, out, &bytes, &length)) return;
	sl_verifier more[16];
	sl_verifiers extra = {more, 0};
	if (!also_of(r, out, &extra)) return;
	sl_message m;
	sl_code code = sl_open_message(bytes, length, topic, &m, &extra);
	if (code != SL_OK) {
		refuse(out, code);
		return;
	}
	fputs("{\"signer\":", out);
	cf_put_hex(out, m.signer, m.signer_length);
	fputs(",\"bytes\":", out);
	cf_put_hex(out, m.bytes, m.length);
	fputc('}', out);
	sl_message_free(&m);
}

static void unseal(const op_value *r, FILE *out) {
	const op_value *value = op_get(r, "value");
	const char *hex = hh_str(r, "sealed");
	uint8_t *bytes;
	size_t length;
	if (value != NULL) {
		if (!cf_value_bytes(value, &bytes, &length)) {
			hh_error(out, "no encoding");
			return;
		}
	} else if (hex == NULL || !cf_unhex(hex, &bytes, &length)) {
		hh_error(out, "not hex");
		return;
	}
	uint8_t doc[32];
	if (!doc_of(r, out, doc)) return;
	sl_verifier more[16];
	sl_verifiers extra = {more, 0};
	if (!also_of(r, out, &extra)) return;
	sl_unsealed u;
	sl_code code = sl_unseal(bytes, length, doc, &u, &extra);
	if (code != SL_OK) {
		refuse(out, code);
		return;
	}
	fputs("{\"commit\":", out);
	cf_put_commit(out, &u.commit, NULL, NULL);
	fputs(",\"bytes\":", out);
	cf_put_hex(out, u.bytes, u.length);
	fputs(",\"name\":", out);
	cf_put_hex(out, u.name, CM_NAME);
	fputs(",\"stored\":", out);
	cf_put_hex(out, u.stored, 32);
	fputc('}', out);
	sl_free(&u);
}

static void stored(const op_value *r, FILE *out) {
	const char *hex = hh_str(r, "sealed");
	uint8_t *bytes;
	size_t length;
	if (hex == NULL || !cf_unhex(hex, &bytes, &length)) {
		hh_error(out, "not hex");
		return;
	}
	uint8_t id[32];
	sl_stored(bytes, length, id);
	fputs("{\"stored\":", out);
	cf_put_hex(out, id, 32);
	fputc('}', out);
}

// { op: "verify", key, message, signature }: whether the raw signature is the raw key's over the
// message, as strictly as ed25519.h checks
static void verify(const op_value *r, FILE *out) {
	const char *names[3] = {"key", "message", "signature"};
	uint8_t *b[3];
	size_t n[3];
	for (int i = 0; i < 3; i++) {
		const char *hex = hh_str(r, names[i]);
		if (hex == NULL || !cf_unhex(hex, &b[i], &n[i])) {
			hh_error(out, "not hex");
			return;
		}
	}
	bool good = n[0] == 32 && n[2] == 64 && ermEd25519Verify(b[0], b[1], n[1], b[2]);
	fprintf(out, "{\"good\":%s}", good ? "true" : "false");
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) hh_unknown(out, r);
	else if (strcmp(op, "key") == 0) key(r, out);
	else if (strcmp(op, "seal") == 0) seal(r, out);
	else if (strcmp(op, "unseal") == 0) unseal(r, out);
	else if (strcmp(op, "stored") == 0) stored(r, out);
	else if (strcmp(op, "seal-message") == 0) seal_message(r, out);
	else if (strcmp(op, "open-message") == 0) open_message(r, out);
	else if (strcmp(op, "verify") == 0) verify(r, out);
	else hh_unknown(out, r);
}
