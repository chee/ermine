// line.c: the C harness (core/graph/c/main.c, included whole, its main
// renamed) as a few calls for src/main.rs: one session, answered a line at a
// time, and a payload's JSON forms to CBOR and back. Not thread-safe: the
// caller makes one call at a time.

#define main ermineHarnessMain
#include "../../../../core/graph/c/main.c"
#undef main

#include "../../../../core/graph/c/cbor.h"

/** the one session, as main.c's main keeps it */
static Session peerSession;

/** one request line answered: the answer's line, without its newline, a fresh string (peerFree) */
char *peerAnswer(const char *line, size_t length) {
	return jsonPrint(answerLine(&peerSession, line, length));
}

void peerFree(void *pointer) {
	free(pointer);
}

/** whether the text is one JSON object, as the harness reads a line (lone surrogates allowed) */
int peerIsObject(const char *text, size_t length) {
	char *why = NULL;
	Json *json = jsonParse(text, length, &why);
	int object = jsonIsObject(json);
	free(why);
	jsonFree(json);
	return object;
}

/** a value's JSON forms (PROTOCOL Values in JSON) to its CBOR (cbor.h), a fresh buffer (peerFree); NULL when it has none */
unsigned char *peerCbor(const char *text, size_t length, size_t *out) {
	char *why = NULL;
	Json *value = jsonParse(text, length, &why);
	free(why);
	if (!value) return NULL;
	if (!jsonDecode(&value, false)) {
		jsonFree(value);
		return NULL;
	}
	size_t needed = 0;
	const char *reason = NULL;
	unsigned char *bytes = NULL;
	if (cborEncode(value, NULL, 0, &needed, &reason)) {
		bytes = malloc(needed ? needed : 1);
		if (bytes && !cborEncode(value, bytes, needed, &needed, &reason)) {
			free(bytes);
			bytes = NULL;
		}
	}
	jsonFree(value);
	if (bytes) *out = needed;
	return bytes;
}

/** CBOR (cbor.h) to the value's JSON forms, a fresh string (peerFree); NULL when the bytes are not one value */
char *peerForms(const unsigned char *bytes, size_t length) {
	Json *value = cborDecode(bytes, length, NULL, NULL);
	if (!value) return NULL;
	char *text = jsonPrint(value);
	jsonFree(value);
	return text;
}
