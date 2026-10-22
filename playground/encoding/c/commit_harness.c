// The C commit on the line protocol (conformance/c/harness.h): requests and answers as
// playground/encoding/typescript/commit_harness.ts has them. Nothing lasts between lines
#include "commit_form_harness.h"

#include "../../../ermine/encoding/c/cbor.h"
#include "pack.h"

#include <stdlib.h>
#include <string.h>

static void put_bytes_and_name(FILE *out, const uint8_t *bytes, size_t length) {
	uint8_t name[CM_NAME];
	cm_name(bytes, length, name);
	fputs("{\"bytes\":", out);
	cf_put_hex(out, bytes, length);
	fputs(",\"name\":", out);
	cf_put_hex(out, name, CM_NAME);
	fputc('}', out);
}

static void encode(const op_value *r, FILE *out) {
	const char *bad = NULL;
	Json *c = cf_commit(op_get(r, "commit"), &bad);
	if (c == NULL) {
		hh_error(out, "%s", bad ? bad : "bad commit");
		return;
	}
	uint8_t *bytes;
	size_t length;
	char *field;
	cm_code code = cm_encode_json(c, &bytes, &length, &field);
	jsonFree(c);
	if (code != CM_OK) {
		cf_put_refusal(out, code, field);
		free(field);
		return;
	}
	// the commit read back, written from its cm_commit (no Json): the same bytes
	cm_commit back;
	uint8_t *again = NULL;
	size_t again_length = 0;
	if (cm_decode(bytes, length, &back, NULL) != CM_OK || cm_encode(&back, &again, &again_length, NULL) != CM_OK ||
		again_length != length || memcmp(again, bytes, length) != 0)
		hh_error(out, "cm_encode of the commit read writes other bytes");
	else put_bytes_and_name(out, bytes, length);
	cm_free(&back);
	free(again);
	free(bytes);
}

static void decode(const op_value *r, FILE *out) {
	const op_value *value = op_get(r, "value");
	const char *hex = hh_str(r, "bytes");
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
	cm_commit c;
	char *field;
	cm_code code = cm_decode(bytes, length, &c, &field);
	if (code != CM_OK) {
		cf_put_refusal(out, code, field);
		free(field);
		return;
	}
	uint8_t name[CM_NAME];
	cm_name(bytes, length, name);
	fputs("{\"commit\":", out);
	cf_put_commit(out, &c, NULL, NULL);
	fputs(",\"name\":", out);
	cf_put_hex(out, name, CM_NAME);
	fputc('}', out);
	cm_free(&c);
}

static void compare(const op_value *r, FILE *out) {
	const char *x = hh_str(r, "a"), *y = hh_str(r, "b");
	uint8_t *a, *b;
	size_t n, m;
	if (x == NULL || y == NULL || !cf_unhex(x, &a, &n) || !cf_unhex(y, &b, &m)) {
		hh_error(out, "not hex");
		return;
	}
	int c = cm_compare(a, n, b, m);
	fprintf(out, "{\"order\":%d}", c < 0 ? -1 : c > 0);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) hh_unknown(out, r);
	else if (strcmp(op, "encode") == 0) encode(r, out);
	else if (strcmp(op, "decode") == 0) decode(r, out);
	else if (strcmp(op, "compare") == 0) compare(r, out);
	else hh_unknown(out, r);
}
