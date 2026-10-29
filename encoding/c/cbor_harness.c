// cbor.c on the line protocol (typescript/cbor_harness.ts): one JSON request per line
// in, one answer per line out. a value in its JSON form (json_text.h), lone surrogates taken (held
// as WTF-8, so encoding can refuse them); bytes lowercase hex.
//   {op: "encode", value} -> {bytes} | {error: "no-encoding"} | {error: "not-a-form"}
//   {op: "decode", bytes} -> {value, again} | {error: "not-an-encoding"}   again: value's encoding
// the fuzz (typescript/cbor_fuzz_test.ts) and the scenarios (conformance/cbor/NN-*.json) ask it
#include "cbor.h"
#include "json.h"
#include "json_text.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void hex(const unsigned char *b, size_t n) {
	for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
}

// lowercase hex only; NULL for anything else
static unsigned char *unhex(const char *s, size_t length, size_t *n) {
	if (length % 2) return NULL;
	*n = length / 2;
	unsigned char *bytes = allocate(*n + 1);
	for (size_t i = 0; i < *n; i++) {
		unsigned x = 0;
		for (int k = 0; k < 2; k++) {
			char c = s[2 * i + k];
			if (c >= '0' && c <= '9') x = x * 16 + (unsigned)(c - '0');
			else if (c >= 'a' && c <= 'f') x = x * 16 + (unsigned)(c - 'a' + 10);
			else return free(bytes), NULL;
		}
		bytes[i] = (unsigned char)x;
	}
	return bytes;
}

// strings and keys holding a lone surrogate, which jsonDecode refuses: each swapped for a
// stand-in text before it ("\x01" and a number, no form's word) and back after
typedef struct {
	char **texts;
	size_t *lengths;
	int count, capacity;
} Held;

static void swap(char **text, size_t *length, Held *held) {
	if (!utf8Surrogate(*text, *length)) return;
	held->texts = growArray(held->texts, held->count, &held->capacity, sizeof *held->texts);
	int room = held->capacity;
	held->lengths = realloc(held->lengths, (size_t)room * sizeof *held->lengths);
	if (!held->lengths) abort();
	held->texts[held->count] = *text;
	held->lengths[held->count] = *length;
	*text = formatString("\x01%d", held->count++);
	*length = strlen(*text);
}

static void hide(Json *v, Held *held) {
	if (v->type == JSON_STRING) swap(&v->string, &v->stringLength, held);
	else if (v->type == JSON_ARRAY)
		for (int i = 0; i < v->array.count; i++) hide(v->array.items[i], held);
	else if (v->type == JSON_OBJECT)
		for (int i = 0; i < v->object.count; i++) {
			swap(&v->object.members[i].key, &v->object.members[i].keyLength, held);
			hide(v->object.members[i].value, held);
		}
}

static void back(char **text, size_t *length, Held *held) {
	if ((*text)[0] != 1) return;
	int k = atoi(*text + 1);
	if (k < 0 || k >= held->count || !held->texts[k]) return;
	free(*text);
	*text = held->texts[k], *length = held->lengths[k];
	held->texts[k] = NULL;
}

static void show(Json *v, Held *held) {
	if (v->type == JSON_STRING) back(&v->string, &v->stringLength, held);
	else if (v->type == JSON_STAND) show(v->stand.kind, held);
	else if (v->type == JSON_ARRAY)
		for (int i = 0; i < v->array.count; i++) show(v->array.items[i], held);
	else if (v->type == JSON_OBJECT)
		for (int i = 0; i < v->object.count; i++) {
			back(&v->object.members[i].key, &v->object.members[i].keyLength, held);
			show(v->object.members[i].value, held);
		}
}

// the member of a request, to be changed in place
static Json **slot(Json *request, const char *key) {
	for (int i = 0; i < request->object.count; i++)
		if (strcmp(request->object.members[i].key, key) == 0) return &request->object.members[i].value;
	return NULL;
}

static void encodeOp(Json *request) {
	Json **value = slot(request, "value");
	Held held = { 0 };
	bool ok = value != NULL;
	if (ok) hide(*value, &held), ok = jsonDecode(value);
	if (ok) show(*value, &held);
	for (int i = 0; i < held.count; i++) free(held.texts[i]);
	free(held.texts), free(held.lengths);
	if (!ok) {
		puts("{\"error\":\"not-a-form\"}");
		return;
	}
	size_t length;
	const char *why = NULL;
	if (!cborEncode(*value, NULL, 0, &length, &why)) {
		puts("{\"error\":\"no-encoding\"}");
		return;
	}
	unsigned char *out = allocate(length + 1);
	size_t again;
	cborEncode(*value, out, length, &again, &why);
	fputs("{\"bytes\":\"", stdout);
	hex(out, length);
	puts("\"}");
	free(out);
}

static void decodeOp(const Json *text) {
	size_t n;
	unsigned char *bytes = text ? unhex(text->string, text->stringLength, &n) : NULL;
	if (!bytes) {
		puts("{\"error\":\"not-hex\"}");
		return;
	}
	const char *why = NULL, *whyCheck = NULL;
	size_t at = 0, atCheck = 0;
	Json *value = cborDecode(bytes, n, &why, &at);
	// the check says the same, at the same byte
	bool checked = cborCheck(bytes, n, &whyCheck, &atCheck);
	if (checked != (value != NULL) || (!checked && (why != whyCheck || at != atCheck))) {
		fprintf(stderr, "cborCheck and cborDecode disagree\n");
		abort();
	}
	if (!value) {
		puts("{\"error\":\"not-an-encoding\"}");
		free(bytes);
		return;
	}
	size_t length;
	cborEncode(value, NULL, 0, &length, &why);
	unsigned char *out = allocate(length + 1);
	size_t again;
	bool ok = cborEncode(value, out, length, &again, &why);
	char *printed = jsonPrint(value);
	printf("{\"value\":%s,\"again\":\"", printed);
	if (ok) hex(out, length);
	puts("\"}");
	free(printed);
	free(out);
	free(bytes);
	jsonFree(value);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	ssize_t got;
	while ((got = getline(&line, &capacity, stdin)) != -1) {
		if (strspn(line, " \t\r\n") == (size_t)got) continue;
		char *why = NULL;
		Json *request = jsonParse(line, (size_t)got, &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		const char *op = jsonText(jsonGet(request, "op"));
		if (op && strcmp(op, "encode") == 0) encodeOp(request);
		else if (op && strcmp(op, "decode") == 0) decodeOp(jsonGet(request, "bytes"));
		else printf("{\"error\":\"unknown op %s\"}\n", op ? op : "");
		jsonFree(request);
		fflush(stdout);
	}
	free(line);
	return 0;
}
