// The C seal on the line protocol (conformance/c/harness.h): requests and answers as
// extensions/sync/typescript/seal_harness.ts has them. Nothing lasts between lines
#include "seal.h"
#include "ed25519/ed25519.h"

#include "../../../ermine/encoding/c/commit_form.h"
#include "../../../ermine/encoding/c/pack.h"

#include <stdlib.h>
#include <string.h>

static void refuse(FILE *out, sl_code code) {
	fprintf(out, "{\"error\":\"%s\"}", sl_code_name(code));
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
	sl_code code = sl_seal(commit, length, &s.signer, NULL, &sealed, &sealed_length, &why, &field);
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
	sl_unsealed u;
	sl_code code = sl_unseal(bytes, length, &u, NULL);
	if (code != SL_OK) {
		refuse(out, code);
		return;
	}
	fputs("{\"commit\":", out);
	cf_put_commit(out, &u.commit, NULL, NULL);
	fputs(",\"bytes\":", out);
	cf_put_hex(out, u.bytes, u.length);
	fputs(",\"name\":", out);
	cf_put_hex(out, u.name, 32);
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
	else if (strcmp(op, "verify") == 0) verify(r, out);
	else hh_unknown(out, r);
}
