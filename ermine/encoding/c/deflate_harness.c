// The C deflate on the line protocol (conformance/c/harness.h): requests and answers as
// ermine/encoding/typescript/deflate_harness.ts has them. Nothing lasts between lines
#include "blake3/blake3.h"
#include "deflate.h"

#include "../../../conformance/c/harness.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void put_hex(FILE *out, const uint8_t *b, size_t n) {
	fputc('"', out);
	for (size_t i = 0; i < n; i++) fprintf(out, "%02x", b[i]);
	fputc('"', out);
}

static int unhex(const char *s, uint8_t **bytes, size_t *n) {
	size_t length = strlen(s);
	if (length % 2) return 0;
	*bytes = malloc(length / 2 + 1);
	for (size_t i = 0; i < length / 2; i++) {
		unsigned v;
		char pair[3] = {s[2 * i], s[2 * i + 1], 0}, *end;
		v = (unsigned)strtoul(pair, &end, 16);
		if (*end) {
			free(*bytes);
			return 0;
		}
		(*bytes)[i] = (uint8_t)v;
	}
	*n = length / 2;
	return 1;
}

static void put_hash(FILE *out, const uint8_t *b, size_t n) {
	blake3_hasher h;
	uint8_t sum[BLAKE3_OUT_LEN];
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, b, n);
	blake3_hasher_finalize(&h, sum, sizeof sum);
	put_hex(out, sum, sizeof sum);
}

static double num(const op_value *m, const char *key) {
	const op_value *v = op_get(m, key);
	return v != NULL && v->type == OP_NUM ? v->num : 0;
}

// a big input made here: {repeat, times}, {random, length, alphabet}, {words, length}
static uint8_t *make(const op_value *m, size_t *n) {
	const char *repeat = hh_str(m, "repeat");
	if (repeat != NULL) {
		size_t one = strlen(repeat), times = (size_t)num(m, "times");
		uint8_t *out = malloc(one * times + 1);
		for (size_t i = 0; i < times; i++) memcpy(out + i * one, repeat, one);
		*n = one * times;
		return out;
	}
	int random = op_get(m, "random") != NULL;
	uint32_t x = (uint32_t)(uint64_t)num(m, random ? "random" : "words");
	size_t length = (size_t)num(m, "length"), alphabet = (size_t)num(m, "alphabet");
	uint8_t *out = malloc(length + 1);
	*n = length;
#define NEXT() (x = x * 1103515245u + 12345u, x >> 16)
	if (random) {
		for (size_t i = 0; i < length; i++) out[i] = (uint8_t)(NEXT() % alphabet);
		return out;
	}
	static const char *const words[8] = {"lemon ", "cherry ", "paper ", "ink ", "otter ", "moth ", "wren ", "fox "};
	for (size_t i = 0; i < length;) {
		const char *w = words[NEXT() % 8];
		for (size_t j = 0; w[j] && i < length; j++) out[i++] = (uint8_t)w[j];
	}
	return out;
}

static void refusal(FILE *out, df_code code) {
	fprintf(out, "{\"code\":\"%s\"}", code == DF_OVER_THE_LIMIT ? "over-the-limit" : "not-deflate");
}

static void deflate(const op_value *r, FILE *out) {
	const op_value *m = op_get(r, "make");
	const char *hex = hh_str(r, "input");
	uint8_t *in, *z, *back;
	size_t n, zn, bn;
	if (m != NULL) in = make(m, &n);
	else if (hex == NULL || !unhex(hex, &in, &n)) {
		hh_error(out, "not hex");
		return;
	}
	df_deflate(in, n, &z, &zn);
	if (m == NULL) {
		fputs("{\"bytes\":", out);
		put_hex(out, z, zn);
		fputc('}', out);
	} else {
		int same = df_inflate(z, zn, (size_t)1 << 30, &back, &bn) == DF_OK && bn == n && memcmp(back, in, n) == 0;
		free(back);
		fprintf(out, "{\"length\":%zu,\"blake3\":", zn);
		put_hash(out, z, zn);
		fprintf(out, ",\"inflated\":%s}", same ? "true" : "false");
	}
	free(in), free(z);
}

static void inflate(const op_value *r, FILE *out) {
	const char *hex = hh_str(r, "bytes");
	const op_value *limit = op_get(r, "limit");
	uint8_t *in, *back;
	size_t n, bn;
	if (hex == NULL || !unhex(hex, &in, &n)) {
		hh_error(out, "not hex");
		return;
	}
	df_code code = df_inflate(in, n, limit != NULL && limit->type == OP_NUM ? (size_t)limit->num : (size_t)1 << 30,
		&back, &bn);
	free(in);
	if (code != DF_OK) {
		refusal(out, code);
		return;
	}
	if (op_get(r, "made") != NULL) {
		fprintf(out, "{\"length\":%zu,\"blake3\":", bn);
		put_hash(out, back, bn);
		fputc('}', out);
	} else {
		fputs("{\"input\":", out);
		put_hex(out, back, bn);
		fputc('}', out);
	}
	free(back);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) hh_unknown(out, r);
	else if (strcmp(op, "deflate") == 0) deflate(r, out);
	else if (strcmp(op, "inflate") == 0) inflate(r, out);
	else hh_unknown(out, r);
}
