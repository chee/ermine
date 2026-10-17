// The C diag on the line protocol (playground/tools/files/typescript/diag_harness.ts): one JSON request per
// line in, one answer per line out. A value is shown in its JSON form (ENCODING.tex: "/" for
// bytes and typed arrays); text is a JSON string.
//   {op: "write", value} -> {text} | {code}
//   {op: "read", text}   -> {value} | {code, at, line, column}
#include "diag.h"
#include "../../../../ermine/encoding/c/json_text.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void write_op(Json *request) {
	Json *value = jsonGet(request, "value");
	// a form that stands for none, or a value with no notation: cannot be carried
	if (value == NULL || !jsonDecode(&value)) {
		puts("{\"code\":\"cannot-carry\"}");
		return;
	}
	char *text = diag_write(value, NULL);
	if (text == NULL) {
		puts("{\"code\":\"cannot-carry\"}");
		return;
	}
	char *s = jsonPrint(&(Json){.type = JSON_STRING, .string = text, .stringLength = strlen(text)});
	printf("{\"text\":%s}\n", s);
	free(s);
	free(text);
}

static void read_op(Json *request) {
	Json *text = jsonGet(request, "text");
	if (!jsonIsString(text)) {
		puts("{\"error\":\"no text\"}");
		return;
	}
	diag_error e;
	Json *value = diag_read(text->string, text->stringLength, &e);
	if (value == NULL) {
		printf("{\"code\":\"not-diag\",\"at\":%zu,\"line\":%zu,\"column\":%zu}\n", e.at, e.line, e.column);
		return;
	}
	char *s = jsonPrint(value);
	printf("{\"value\":%s}\n", s);
	free(s);
	jsonFree(value);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		const char *op = jsonText(jsonGet(request, "op"));
		if (op && strcmp(op, "write") == 0) write_op(request);
		else if (op && strcmp(op, "read") == 0) read_op(request);
		else printf("{\"error\":\"unknown op %s\"}\n", op ? op : "");
		jsonFree(request);
	}
	fflush(stdout);
	free(line);
	return 0;
}
