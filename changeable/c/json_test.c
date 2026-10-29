// the C JSON writer (json.h) on a value nested far deeper than the reader takes: written whole,
// not by recursion (the C stack held ~11.7k levels). exits 1 at the first thing that is not so.
// make test-c-json-test (test-check-, test-leaks-)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "json.h"
#include "value.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

int main(void) {
	enum { DEPTH = 40000 };
	// lists in lists, maps in the list at the bottom
	op_value *root = op_list(), *at = root;
	for (int i = 1; i < DEPTH; i++) {
		op_value *inner = op_list();
		op_push(at, inner);
		at = inner;
	}
	op_value *bottom = op_map();
	op_set(bottom, "k", op_num(1));
	op_push(at, bottom);
	char *text = op_json_text(root);
	size_t n = strlen(text);
	CHECK(n == 2 * DEPTH + strlen("{\"k\":1}"));
	CHECK(text[0] == '[' && text[DEPTH - 1] == '[' && strncmp(text + DEPTH, "{\"k\":1}", 7) == 0);
	for (size_t i = DEPTH + 7; i < n; i++) CHECK(text[i] == ']');
	free(text);
	op_free(root);
	puts("json_test: ok");
	return 0;
}
