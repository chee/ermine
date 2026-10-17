// The C blop on the line protocol (newcore/conformance/blop/harness.ts): one JSON request per
// line in, one answer per line out. A blop is shown in its JSON form (ENCODING.tex: "/" for bytes
// and typed arrays); bytes and names are lowercase hex.
//   {op: "encode", blop}  -> {bytes} | {code, field?}
//   {op: "decode", bytes} -> {blop}  | {code, field?}
//   {op: "name", bytes}   -> {name}
#include "blop.h"
#include "json.h"
#include "json_text.h"

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

static void error(blop_error e) {
	printf("{\"code\":\"%s\"", e.code == BLOP_CANNOT_CARRY ? "cannot-carry" : "not-a-blop");
	if (e.field) {
		char *s = jsonPrint(&(Json){.type = JSON_STRING, .string = e.field, .stringLength = strlen(e.field)});
		printf(",\"field\":%s", s);
		free(s);
	}
	puts("}");
	free(e.field);
}

// the member of a request, to be changed in place
static Json **slot(Json *request, const char *key) {
	for (int i = 0; i < request->object.count; i++)
		if (strcmp(request->object.members[i].key, key) == 0) return &request->object.members[i].value;
	return NULL;
}

static void encode_op(Json *request) {
	Json **blop = slot(request, "blop");
	// a form that stands for none: cannot be carried
	if (blop == NULL || !jsonDecode(blop)) {
		puts("{\"code\":\"cannot-carry\"}");
		return;
	}
	uint8_t *bytes;
	size_t n;
	blop_error e = blop_encode(*blop, &bytes, &n);
	if (e.code != BLOP_OK) {
		error(e);
		return;
	}
	fputs("{\"bytes\":\"", stdout);
	hex(bytes, n);
	puts("\"}");
	free(bytes);
}

static void decode_op(const char *text) {
	size_t n;
	uint8_t *bytes = unhex(text, &n);
	Json *blop;
	blop_error e = blop_decode(bytes, n, &blop);
	free(bytes);
	if (e.code != BLOP_OK) {
		error(e);
		return;
	}
	char *s = jsonPrint(blop);
	printf("{\"blop\":%s}\n", s);
	free(s);
	jsonFree(blop);
}

static void name_op(const char *text) {
	size_t n;
	uint8_t *bytes = unhex(text, &n), name[32];
	blop_name(bytes, n, name);
	free(bytes);
	fputs("{\"name\":\"", stdout);
	hex(name, 32);
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
		const char *op = jsonText(jsonGet(request, "op")), *bytes = jsonText(jsonGet(request, "bytes"));
		if (op && strcmp(op, "encode") == 0) encode_op(request);
		else if (op && strcmp(op, "decode") == 0 && bytes) decode_op(bytes);
		else if (op && strcmp(op, "name") == 0 && bytes) name_op(bytes);
		else printf("{\"error\":\"unknown op %s\"}\n", op ? op : "");
		jsonFree(request);
	}
	fflush(stdout);
	free(line);
	return 0;
}
