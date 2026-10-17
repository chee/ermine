// The C seal on the line protocol (extensions/subduction/typescript/seal_harness.ts): one JSON request per line
// in, one answer per line out. Bytes are lowercase hex.
//   {op: "seal", blop, seed}: the host's signer made from the 32-byte Ed25519 seed; {bytes} or {code}
//   {op: "unseal", bytes}: {blop, name, stored, signer} or {code}; blop the blop's bytes, the
//     decoded blop encoded again by blop.c (canonical, so the bytes sealed)
//   {op: "stored", bytes}: {stored}
// {code} for a seal fault
#include "seal.h"
#include "ed25519/ed25519.h"
#include "../../../ermine/encoding/c/blop.h"
#include "../../../ermine/encoding/c/json_text.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void hex(const uint8_t *b, size_t n) {
	for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
}

static uint8_t *unhex(const char *s, size_t *n) {
	*n = strlen(s) / 2;
	uint8_t *bytes = malloc(*n ? *n : 1);
	if (bytes == NULL) abort();
	for (size_t i = 0; i < *n; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) fputs("bad hex\n", stderr), exit(1);
		bytes[i] = (uint8_t)x;
	}
	return bytes;
}

static const char *codes[] = {"", "shape", "signature"};

// the host's sign: the seed's key signs
static size_t sign(void *context, const uint8_t *message, size_t length, uint8_t signature[64]) {
	ermEd25519Sign(context, message, length, signature);
	return 64;
}

static void seal_op(const char *blop, const char *seed) {
	size_t n, m;
	uint8_t *bytes = unhex(blop, &n), *s = unhex(seed, &m);
	if (m != 32) fputs("bad seed\n", stderr), exit(1);
	seal_signer signer = {.sign = sign, .context = s};
	ermEd25519Public(s, signer.key);
	uint8_t *out;
	size_t length;
	seal_code code = seal_seal(bytes, n, &signer, NULL, &out, &length);
	if (code == SEAL_OK) {
		fputs("{\"bytes\":\"", stdout);
		hex(out, length);
		puts("\"}");
		free(out);
	} else printf("{\"code\":\"%s\"}\n", codes[code]);
	free(bytes);
	free(s);
}

static void unseal_op(const char *text) {
	size_t n;
	uint8_t *bytes = unhex(text, &n);
	seal_unsealed u;
	seal_code code = seal_unseal(bytes, n, &u);
	free(bytes);
	if (code != SEAL_OK) {
		printf("{\"code\":\"%s\"}\n", codes[code]);
		return;
	}
	uint8_t *blop;
	size_t length;
	blop_error e = blop_encode(u.blop, &blop, &length);
	if (e.code != BLOP_OK) fputs("a decoded blop does not encode\n", stderr), exit(1);
	fputs("{\"blop\":\"", stdout);
	hex(blop, length);
	fputs("\",\"name\":\"", stdout);
	hex(u.name, 32);
	fputs("\",\"stored\":\"", stdout);
	hex(u.stored, 32);
	fputs("\",\"signer\":\"", stdout);
	hex(u.signer, 32);
	puts("\"}");
	free(blop);
	seal_free(&u);
}

static void stored_op(const char *text) {
	size_t n;
	uint8_t *bytes = unhex(text, &n), stored[32];
	seal_stored(bytes, n, stored);
	free(bytes);
	fputs("{\"stored\":\"", stdout);
	hex(stored, 32);
	puts("\"}");
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		const char *op = jsonText(jsonGet(request, "op")), *blop = jsonText(jsonGet(request, "blop")),
			*seed = jsonText(jsonGet(request, "seed")), *bytes = jsonText(jsonGet(request, "bytes"));
		if (op && strcmp(op, "seal") == 0 && blop && seed) seal_op(blop, seed);
		else if (op && strcmp(op, "unseal") == 0 && bytes) unseal_op(bytes);
		else if (op && strcmp(op, "stored") == 0 && bytes) stored_op(bytes);
		else printf("{\"error\":\"unknown op %s\"}\n", op ? op : "");
		jsonFree(request);
	}
	fflush(stdout);
	free(line);
	return 0;
}
