// The C names on the line protocol (playground/tools/files/typescript/names_harness.ts): one JSON request per line in, one answer
// per line out. Bytes are lowercase hex; a missing answer is null.
//   {op: "extension", name} -> {result: ext | null}     {op: "fits", ext, form}              -> {result: bool}
//   {op: "sniff", head}     -> {result}                 {op: "suffix", form, head?}          -> {result}
//   {op: "split", name, form, head?, pass?} -> {result: {stem, ext, added}}
//   {op: "write", name, pass} -> {result}               {op: "cut", stem, ext}               -> {result}
//   {op: "free", stem, taken: [stem]} -> {result}       {op: "read", name}                   -> {result}
//   {op: "key", stem}       -> {result}                 {op: "passes", name, pass}           -> {result: bool}
//   {op: "member", n, words?} -> {result}               {op: "number", stem} -> {result: [n, words] | null}
//   {op: "take", entry}     -> {result: {slot, form?}}  {op: "renamed", entry, ext?, folder} -> {result}
//   {op: "percent", id}     -> {result} | {error}       {op: "unpercent", segment}           -> {result}
//   {op: "bycodepoint", a, b} -> {result: -1 | 0 | 1}
#include "names.h"

#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/json_text.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *text(const Json *request, const char *key) {
	const char *s = jsonText(jsonGet(request, key));
	return s ? s : "";
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

/** the patterns of a request's list; free the array, not the patterns */
static const char **patterns(const Json *request, const char *key, size_t *count) {
	const Json *list = jsonGet(request, key);
	*count = jsonIsArray(list) ? (size_t)list->array.count : 0;
	const char **out = malloc((*count + 1) * sizeof *out);
	if (out == NULL) abort();
	for (size_t i = 0; i < *count; i++) out[i] = jsonText(list->array.items[i]);
	return out;
}

/** print {"result": value}, taking the value */
static int result(Json *value) {
	Json *answer = jsonObject();
	jsonAdd(answer, "result", value);
	char *s = jsonPrint(answer);
	puts(s);
	free(s);
	jsonFree(answer);
	return 0;
}

static int result_string(char *s) {
	result(s ? jsonString(s) : jsonNull());
	free(s);
	return 0;
}

static bool in_list(const char *stem, void *context) {
	const Json *taken = context;
	for (int i = 0; i < taken->array.count; i++)
		if (strcmp(jsonText(taken->array.items[i]), stem) == 0) return true;
	return false;
}

static int answer(const Json *request, const char *op) {
	const char *name = text(request, "name");
	if (strcmp(op, "extension") == 0) return result_string(names_extension(name));
	if (strcmp(op, "fits") == 0) return result(jsonBoolean(names_fits(text(request, "ext"), text(request, "form"))));
	if (strcmp(op, "sniff") == 0 || strcmp(op, "suffix") == 0 || strcmp(op, "split") == 0) {
		size_t n;
		uint8_t *head = unhex(text(request, "head"), &n);
		if (strcmp(op, "sniff") == 0) result(jsonString(names_sniff(head, n)));
		else if (strcmp(op, "suffix") == 0) result(jsonString(names_suffix(text(request, "form"), head, n)));
		else {
			size_t count;
			const char **pass = patterns(request, "pass", &count);
			names_split_result r = names_split(name, text(request, "form"), head, n, jsonGet(request, "pass") ? pass : NULL, count);
			Json *o = jsonObject();
			jsonAdd(o, "stem", jsonString(r.stem));
			jsonAdd(o, "ext", jsonString(r.ext));
			jsonAdd(o, "added", jsonBoolean(r.added));
			result(o);
			free(r.stem), free(r.ext), free(pass);
		}
		free(head);
		return 0;
	}
	if (strcmp(op, "write") == 0 || strcmp(op, "passes") == 0) {
		size_t count;
		const char **pass = patterns(request, "pass", &count);
		if (strcmp(op, "write") == 0) result_string(names_write(name, pass, count));
		else result(jsonBoolean(names_passes(name, pass, count)));
		free(pass);
		return 0;
	}
	if (strcmp(op, "cut") == 0) return result_string(names_cut(text(request, "stem"), text(request, "ext")));
	if (strcmp(op, "free") == 0) return result_string(names_free(text(request, "stem"), in_list, (void *)jsonGet(request, "taken")));
	if (strcmp(op, "read") == 0) return result_string(names_read(name));
	if (strcmp(op, "key") == 0) return result_string(names_key(text(request, "stem")));
	if (strcmp(op, "member") == 0) {
		double n = 0;
		const Json *v = jsonGet(request, "n");
		if (jsonIsNumber(v)) n = v->number;
		return result_string(names_member(n, text(request, "words")));
	}
	if (strcmp(op, "number") == 0) {
		double n;
		char *words;
		if (!names_number(text(request, "stem"), &n, &words)) return result(jsonNull());
		Json *pair = jsonArray();
		// as JSON.stringify writes Infinity
		jsonPush(pair, n - n == 0 ? jsonNumber(n) : jsonNull());
		jsonPush(pair, jsonString(words));
		free(words);
		return result(pair);
	}
	if (strcmp(op, "take") == 0) {
		names_take_result r = names_take(text(request, "entry"));
		Json *o = jsonObject();
		jsonAdd(o, "slot", jsonString(r.slot));
		if (r.form) jsonAdd(o, "form", jsonString(r.form));
		result(o);
		free(r.slot), free(r.form);
		return 0;
	}
	if (strcmp(op, "renamed") == 0) {
		const Json *folder = jsonGet(request, "folder");
		const char *ext = jsonGet(request, "ext") ? jsonText(jsonGet(request, "ext")) : NULL;
		return result_string(names_renamed(text(request, "entry"), ext, folder && folder->type == JSON_BOOLEAN && folder->boolean));
	}
	if (strcmp(op, "percent") == 0) {
		char *s = names_percent(text(request, "id"));
		if (s == NULL) return puts("{\"error\":\"URI malformed\"}");
		return result_string(s);
	}
	if (strcmp(op, "unpercent") == 0) return result_string(names_unpercent(text(request, "segment")));
	if (strcmp(op, "bycodepoint") == 0) return result(jsonInteger(names_bycodepoint(text(request, "a"), text(request, "b"))));
	return printf("{\"error\":\"unknown op %s\"}\n", op);
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
		answer(request, op ? op : "");
		jsonFree(request);
	}
	fflush(stdout);
	free(line);
	return 0;
}
