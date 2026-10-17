// The C id on the line protocol (extensions/subduction/typescript/id_harness.ts): one JSON request per line in,
// one answer per line out. Bytes are lowercase hex.
//   {op: "id", lock, made}: {id} or {code}
//   {op: "bytes", id}: {bytes} or {code}
//   {op: "is", id}: {is}
#include "id.h"
#include "../../../ermine/encoding/c/json.h"
#include "../../../ermine/encoding/c/json_text.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *codes[] = {"", "name", "size", "not-an-id"};

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

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		const char *op = jsonText(jsonGet(request, "op")), *lock = jsonText(jsonGet(request, "lock")),
			*made = jsonText(jsonGet(request, "made")), *id = jsonText(jsonGet(request, "id"));
		if (op && strcmp(op, "id") == 0 && lock && made) {
			size_t n;
			uint8_t *bytes = unhex(made, &n);
			char out[ID_LENGTH + 1];
			id_code code = id_make(lock, bytes, n, out);
			if (code == ID_OK) printf("{\"id\":\"%s\"}\n", out);
			else printf("{\"code\":\"%s\"}\n", codes[code]);
			free(bytes);
		} else if (op && strcmp(op, "bytes") == 0 && id) {
			uint8_t out[32];
			id_code code = id_bytes(id, out);
			if (code == ID_OK) {
				fputs("{\"bytes\":\"", stdout);
				for (int i = 0; i < 32; i++) printf("%02x", out[i]);
				puts("\"}");
			} else printf("{\"code\":\"%s\"}\n", codes[code]);
		} else if (op && strcmp(op, "is") == 0) {
			// not a string: not an id
			printf("{\"is\":%s}\n", id && id_is(id) ? "true" : "false");
		} else printf("{\"error\":\"unknown op %s\"}\n", op ? op : "");
		jsonFree(request);
	}
	fflush(stdout);
	free(line);
	return 0;
}
