// hash.c against conformance/hash/vectors.json, the file typescript/hash_test.ts reads: each
// {value, hash}, the value's hash the given hex. the vectors are found beside this binary
// (../conformance/hash), or given as the first argument when it is a hash vectors file
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "hash.h"
#include "../../../ermine/encoding/c/json.h"
#include "../../../ermine/encoding/c/json_text.h"

int main(int argc, char **argv) {
	char path[4096];
	if (argc > 1 && strstr(argv[1], "hash/vectors.json")) snprintf(path, sizeof path, "%s", argv[1]);
	else {
		char self[4096];
		snprintf(self, sizeof self, "%s", argv[0]);
		snprintf(path, sizeof path, "%s/../conformance/hash/vectors.json", dirname(self));
	}
	FILE *file = fopen(path, "rb");
	if (!file) {
		printf("FAIL cannot open %s\n", path);
		return 1;
	}
	char *text = NULL;
	size_t size = 0;
	FILE *memory = open_memstream(&text, &size);
	int c;
	while ((c = fgetc(file)) != EOF) fputc(c, memory);
	fclose(memory);
	fclose(file);
	char *why = NULL;
	Json *list = jsonParse(text, size, &why);
	free(text);
	if (!jsonIsArray(list)) {
		printf("FAIL %s is not a JSON list: %s\n", path, why ? why : "");
		return 1;
	}
	int failures = 0;
	for (int i = 0; i < list->array.count; i++) {
		Json *vector = list->array.items[i];
		Json *value = jsonGet(vector, "value");
		const char *want = jsonText(jsonGet(vector, "hash"));
		uint8_t out[32];
		const char *no = NULL;
		char got[65] = {0};
		if (!value || !want || !hashValue(value, out, &no)) {
			printf("FAIL vector %d: %s\n", i, no ? no : "malformed");
			failures++;
			continue;
		}
		for (int k = 0; k < 32; k++) snprintf(got + 2 * k, 3, "%02x", out[k]);
		if (strcmp(got, want) != 0) {
			char *name = jsonPrint(value);
			printf("FAIL %s: %s, want %s\n", name, got, want);
			free(name);
			failures++;
		}
	}
	printf("%s %d hash vectors\n", failures ? "FAIL" : "ok", list->array.count);
	jsonFree(list);
	return failures ? 1 : 0;
}
