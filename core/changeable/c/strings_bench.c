// Times typing into a long string: 2000 single CJK characters at the end and in the middle of
// strings of 0, 20k, 100k and 400k characters, in place. Reports the mean per character. Build
// with make bench, then run core/changeable/c/strings-bench.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "apply.h"

enum { TYPED = 2000 };

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e6 + (double)t.tv_nsec / 1e3;
}

static op_value *text(size_t n) {
	char *s = malloc(n * 3 + 1);
	for (size_t i = 0; i < n; i++) memcpy(s + 3 * i, "\xE4\xB8\xAD", 3);
	s[3 * n] = 0;
	op_value *root = op_map();
	op_set(root, "text", op_str_take(s, 3 * n));
	return root;
}

static double type(size_t n, int middle) {
	op_value *root = text(n);
	const op_key path[] = {{.type = OP_STR_KEY, .s = "text"}};
	op_value *one = op_str("\xE6\x96\x87");
	double t = now();
	for (int i = 0; i < TYPED; i++) {
		int64_t at = (int64_t)(middle ? n / 2 : n) + i;
		const op_patch p = {.place = {path, 1, 1, at, at}, .has_value = 1, .value = one};
		op_value *out = NULL;
		if (op_apply(root, &p, 1, &(op_apply_options){.in_place = 1}, &out, NULL) != OP_OK) {
			fprintf(stderr, "bench: refused\n");
			exit(1);
		}
		if (out != root) {
			op_free(root);
			root = out;
		}
	}
	t = (now() - t) / TYPED;
	op_free(root);
	op_free(one);
	return t;
}

int main(void) {
	const size_t sizes[] = {0, 20000, 100000, 400000};
	for (size_t i = 0; i < sizeof sizes / sizeof *sizes; i++)
		printf("%7zu characters  end %8.2f us  middle %8.2f us per character\n", sizes[i],
			type(sizes[i], 0), type(sizes[i], 1));
	return 0;
}
