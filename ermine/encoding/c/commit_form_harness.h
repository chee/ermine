// What the C harnesses of commit, seal, run and history share (conventions: extensions/together/
// conformance/README.md): bytes as lowercase hex, a commit in JSON and back, a commit's refusal.
// Written for the shared loop (conformance/c/harness.h): memory taken is the line's
#ifndef CF_COMMIT_FORM_HARNESS_H
#define CF_COMMIT_FORM_HARNESS_H

#include "commit.h"
#include "../../../conformance/c/harness.h"

#include <stdbool.h>
#include <stdio.h>

// "<hex>", with its quotes
void cf_put_hex(FILE *out, const uint8_t *bytes, size_t length);
// lowercase hex only, two digits a byte; the line's memory. false: it is not
bool cf_unhex(const char *text, uint8_t **bytes, size_t *length);
// the value (a request's) in canonical CBOR, the line's memory; false: it has no encoding
bool cf_value_bytes(const op_value *value, uint8_t **bytes, size_t *length);
// a commit from its JSON form, as a Json for cm_encode_json: signer, each parent, base and each name
// a patch replaces given as a string are hex (anything else is passed on as its value, to be
// refused); not a map: the value it stands for. A fresh value (jsonFree it); NULL with *bad the
// error text when a hex is not
Json *cf_commit(const op_value *form, const char **bad);
// how a parent or base is written in a commit; NULL: hex
typedef void (*cf_name)(void *context, FILE *out, const uint8_t name[CM_NAME]);
// the commit's JSON form
void cf_put_commit(FILE *out, const cm_commit *commit, cf_name name, void *context);
// { "error": code, "field": field }, no field when NULL
void cf_put_refusal(FILE *out, cm_code code, const char *field);

#endif
