// The C installs (installs.h) on the line protocol of typescript/installs_harness.ts, which
// documents it (conformance/c/harness.h has the loop). One store in memory for the run; the key is
// Ed25519 (the repo's, core/ed25519/c: this harness's only, installs knows none).
// Bytes are lowercase hex.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../core/ed25519/c/ed25519.h"
#include "installs.h"

#define NAMES 8

static struct {
	char *name;
	uint8_t *data;
	size_t length;
} stored[NAMES];
static size_t nstored;
// the names the last open wrote, in order
static const char *wrote[NAMES];
static size_t nwrote;
static bool has_first;
static char first_id[ID_TEXT], first_root[ID_TEXT];

static void set(const char *name, const uint8_t *data, size_t length) {
	size_t i = 0;
	while (i < nstored && strcmp(stored[i].name, name) != 0) i++;
	if (i == nstored) {
		if (nstored == NAMES) abort();
		stored[nstored++].name = strdup(name);
	} else free(stored[i].data);
	stored[i].data = malloc(length ? length : 1);
	if (stored[i].data == NULL) abort();
	memcpy(stored[i].data, data, length);
	stored[i].length = length;
}

static bool read_named(void *ctx, const char *name, uint8_t *out, size_t cap, size_t *length) {
	(void)ctx;
	for (size_t i = 0; i < nstored; i++) {
		if (strcmp(stored[i].name, name) != 0) continue;
		memcpy(out, stored[i].data, stored[i].length < cap ? stored[i].length : cap);
		*length = stored[i].length;
		return true;
	}
	return false;
}

static bool write_named(void *ctx, const char *name, const uint8_t *data, size_t length) {
	(void)ctx;
	set(name, data, length);
	for (size_t i = 0; i < nstored; i++) {
		if (strcmp(stored[i].name, name) == 0) wrote[nwrote++] = stored[i].name;
	}
	return true;
}

static bool ed25519_of(void *ctx, const uint8_t secret[32], uint8_t out[32]) {
	(void)ctx;
	ermEd25519Public(secret, out);
	return true;
}

static int value(char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	return -1;
}

// lowercase hex's bytes, for the line; NULL when not hex
static uint8_t *unhex(const char *s, size_t *length) {
	if (s == NULL || strlen(s) % 2) return NULL;
	size_t n = strlen(s) / 2;
	uint8_t *out = hh_take(n ? n : 1);
	for (size_t i = 0; i < n; i++) {
		int hi = value(s[2 * i]), lo = value(s[2 * i + 1]);
		if (hi < 0 || lo < 0) return NULL;
		out[i] = (uint8_t)(hi << 4 | lo);
	}
	*length = n;
	return out;
}

static const char *kinds[] = {NULL, "fresh", "hashed", "key"};

// { "id": kind, "root": kind } of two ids' text
static void kinds_of(FILE *out, const char *id, const char *root) {
	const char *text[2] = {id, root};
	const char *names[2] = {"id", "root"};
	fputc('{', out);
	for (int i = 0; i < 2; i++) {
		uint8_t bytes[ID_MAX];
		size_t n = id_parse(text[i], strlen(text[i]), bytes);
		const char *k = kinds[n ? id_kind_of(bytes, n) : ID_NONE];
		fprintf(out, "%s\"%s\":", i ? "," : "", names[i]);
		if (k) op_json_string(out, k);
		else fputs("null", out);
	}
	fputc('}', out);
}

void hh_start(void) {}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) {
		hh_unknown(out, r);
		return;
	}
	if (strcmp(op, "put") == 0) {
		size_t n;
		const char *name = hh_str(r, "name");
		const uint8_t *bytes = unhex(hh_str(r, "hex"), &n);
		if (name == NULL || bytes == NULL) {
			hh_error(out, "put: no name, or not hex");
			return;
		}
		set(name, bytes, n);
		fputs("{}", out);
	} else if (strcmp(op, "open") == 0) {
		uint8_t random[INST_RANDOM];
		arc4random_buf(random, sizeof random);
		nwrote = 0;
		inst_install me;
		inst_store store = {.read = read_named, .write = write_named};
		inst_public_key public_key = {.public_key_of = ed25519_of};
		int code = inst_open(&store, &public_key, hh_str(r, "root"), random, &me);
		if (code != INST_OK) {
			hh_error(out, "%s", inst_error(code));
			return;
		}
		if (!has_first) {
			has_first = true;
			strcpy(first_id, me.id);
			strcpy(first_root, me.root);
		}
		fputs("{\"id\":", out);
		op_json_string(out, me.id);
		fputs(",\"root\":", out);
		op_json_string(out, me.root);
		fputs(",\"kinds\":", out);
		kinds_of(out, me.id, me.root);
		fputs(",\"wrote\":[", out);
		for (size_t i = 0; i < nwrote; i++) {
			if (i) fputc(',', out);
			op_json_string(out, wrote[i]);
		}
		fprintf(out, "],\"same\":%s}", strcmp(me.id, first_id) == 0 && strcmp(me.root, first_root) == 0 ? "true" : "false");
	} else if (strcmp(op, "stored") == 0) {
		fputs("{\"sizes\":{", out);
		for (size_t i = 0; i < nstored; i++) {
			if (i) fputc(',', out);
			op_json_string(out, stored[i].name);
			fprintf(out, ":%zu", stored[i].length);
		}
		fputs("}}", out);
	} else hh_unknown(out, r);
}

void hh_finish(void) {
	for (size_t i = 0; i < nstored; i++) {
		free(stored[i].name);
		free(stored[i].data);
	}
	nstored = 0;
}
