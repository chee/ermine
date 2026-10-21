// The harnesses' forms of a commit (commit_form_harness.h), as commit_harness.ts and harnesses.ts have them
#include "commit_form_harness.h"

#include "cbor.h"
#include "pack.h"

#include <stdlib.h>
#include <string.h>

void cf_put_hex(FILE *out, const uint8_t *bytes, size_t length) {
	fputc('"', out);
	for (size_t i = 0; i < length; i++) fprintf(out, "%02x", bytes[i]);
	fputc('"', out);
}

bool cf_unhex(const char *text, uint8_t **bytes, size_t *length) {
	size_t n = strlen(text);
	if (n % 2) return false;
	uint8_t *b = hh_take(n / 2 + 1);
	for (size_t i = 0; i < n; i++) {
		char c = text[i];
		int d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
		if (d < 0) return false;
		if (i % 2 == 0) b[i / 2] = (uint8_t)(d << 4);
		else b[i / 2] |= (uint8_t)d;
	}
	*bytes = b;
	*length = n / 2;
	return true;
}

bool cf_value_bytes(const op_value *value, uint8_t **bytes, size_t *length) {
	CborOut o = {NULL, 0, 0, true};
	bool ok = value != NULL && pk_put(&o, value);
	if (ok) {
		*bytes = hh_take(o.length + 1);
		if (o.length) memcpy(*bytes, o.data, o.length);
		*length = o.length;
	}
	free(o.data);
	return ok;
}

// a byte field: a string is its hex, anything else the value it stands for
static Json *bytes_or(const op_value *v, const char **bad) {
	if (v->type != OP_STR) return pk_to_json(v);
	uint8_t *b;
	size_t n;
	if (!cf_unhex(v->str, &b, &n)) return *bad = "not hex", NULL;
	return jsonBytes(b, n);
}

// a list of byte fields (parents, a patch's replaces): each as bytes_or; NULL with *bad
static Json *names_or(const op_value *v, const char **bad) {
	Json *j = jsonArray();
	for (size_t p = 0; p < v->count; p++) {
		Json *item = bytes_or(v->items[p], bad);
		if (item == NULL) return jsonFree(j), NULL;
		jsonPush(j, item);
	}
	return j;
}

// a patch: replaces, a list, as names_or; the rest its value
static Json *patch_of(const op_value *v, const char **bad) {
	if (v->type != OP_MAP) return pk_to_json(v);
	Json *out = jsonObject();
	for (size_t i = 0; i < v->count; i++) {
		const op_value *x = v->items[i];
		Json *j = strcmp(v->keys[i], "replaces") == 0 && x->type == OP_LIST ? names_or(x, bad) : pk_to_json(x);
		if (j == NULL) return jsonFree(out), NULL;
		jsonAdd(out, v->keys[i], j);
	}
	return out;
}

Json *cf_commit(const op_value *form, const char **bad) {
	if (form == NULL) return jsonNull();
	if (form->type != OP_MAP) return pk_to_json(form);
	Json *out = jsonObject();
	for (size_t i = 0; i < form->count; i++) {
		const char *k = form->keys[i];
		const op_value *v = form->items[i];
		Json *j;
		if (strcmp(k, "signer") == 0 || strcmp(k, "base") == 0) j = bytes_or(v, bad);
		else if (strcmp(k, "parents") == 0 && v->type == OP_LIST) j = names_or(v, bad);
		else if (strcmp(k, "patches") == 0 && v->type == OP_LIST) {
			j = jsonArray();
			for (size_t p = 0; p < v->count && j != NULL; p++) {
				Json *item = patch_of(v->items[p], bad);
				if (item == NULL) jsonFree(j), j = NULL;
				else jsonPush(j, item);
			}
		} else j = pk_to_json(v);
		if (j == NULL) return jsonFree(out), NULL;
		jsonAdd(out, k, j);
	}
	return out;
}

static void put_target(FILE *out, const op_target *t) {
	fputs("\"path\":[", out);
	for (size_t i = 0; i < t->length; i++) {
		if (i) fputc(',', out);
		if (t->path[i].type == OP_STR_KEY) op_json_string(out, t->path[i].s);
		else fprintf(out, "%ld", t->path[i].n);
	}
	fputc(']', out);
	if (t->has_range) fprintf(out, ",\"range\":[%lld,%lld]", (long long)t->from, (long long)t->to);
}

// the patches, as {path, range?, value?, move?, replaces?} each; a name replaced as name does
static void cf_put_patches(FILE *out, const cm_commit *c, cf_name name, void *context) {
	const op_patch *ps = c->patches;
	size_t length = c->patches_length;
	fputc('[', out);
	for (size_t i = 0; i < length; i++) {
		if (i) fputc(',', out);
		fputc('{', out);
		put_target(out, &ps[i].place);
		if (ps[i].has_value) {
			fputs(",\"value\":", out);
			op_json_write(out, ps[i].value);
		}
		if (ps[i].has_move) {
			fputs(",\"move\":{", out);
			put_target(out, &ps[i].move);
			fputc('}', out);
		}
		if (c->replaces != NULL && c->replaces[i].has) {
			fputs(",\"replaces\":[", out);
			for (size_t k = 0; k < c->replaces[i].length; k++) {
				if (k) fputc(',', out);
				if (name != NULL) name(context, out, c->replaces[i].names[k]);
				else cf_put_hex(out, c->replaces[i].names[k], CM_NAME);
			}
			fputc(']', out);
		}
		fputc('}', out);
	}
	fputc(']', out);
}

void cf_put_commit(FILE *out, const cm_commit *c, cf_name name, void *context) {
	const ch_header *h = &c->change;
	fputs("{\"table\":", out);
	op_json_string(out, c->table);
	fputs(",\"actor\":", out);
	op_json_write(out, h->actor);
	if (h->reader != NULL) fputs(",\"reader\":", out), op_json_string(out, h->reader);
	if (h->external != NULL) {
		fputs(",\"external\":[", out);
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			if (i) fputc(',', out);
			fputs("{\"file\":", out);
			op_json_string(out, s->file);
			fprintf(out, ",\"line\":%ld", s->line);
			if (s->has_column) fprintf(out, ",\"column\":%ld", s->column);
			if (s->function != NULL) fputs(",\"function\":", out), op_json_string(out, s->function);
			fputc('}', out);
		}
		fputc(']', out);
	}
	if (h->metadata != NULL) {
		// a map; one whose one key is "/": {"/": {"map": it}} (form.ts)
		bool slash = h->metadata_length == 1 && strcmp(h->metadata[0].key, "/") == 0;
		fputs(slash ? ",\"metadata\":{\"/\":{\"map\":{" : ",\"metadata\":{", out);
		for (size_t i = 0; i < h->metadata_length; i++) {
			if (i) fputc(',', out);
			op_json_string(out, h->metadata[i].key);
			fputc(':', out);
			op_json_write(out, h->metadata[i].value);
		}
		fputs(slash ? "}}}" : "}", out);
	}
	fprintf(out, ",\"time\":%lld,\"signer\":", (long long)h->time);
	cf_put_hex(out, c->signer, c->signer_length);
	fprintf(out, ",\"nonce\":%lld,\"parents\":[", (long long)c->nonce);
	for (size_t i = 0; i < c->parents_length; i++) {
		if (i) fputc(',', out);
		if (name != NULL) name(context, out, c->parents[i]);
		else cf_put_hex(out, c->parents[i], CM_NAME);
	}
	fputc(']', out);
	if (c->has_base) {
		fputs(",\"base\":", out);
		if (name != NULL) name(context, out, c->base);
		else cf_put_hex(out, c->base, CM_NAME);
	}
	if (c->merge != NULL) fputs(",\"merge\":", out), op_json_string(out, c->merge);
	fprintf(out, ",\"lamport\":%lld,\"patches\":", (long long)c->lamport);
	cf_put_patches(out, c, name, context);
	fputc('}', out);
}

void cf_put_refusal(FILE *out, cm_code code, const char *field) {
	fprintf(out, "{\"error\":\"%s\"", cm_code_name(code));
	if (field != NULL) fputs(",\"field\":", out), op_json_string(out, field);
	fputc('}', out);
}
