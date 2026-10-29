// one change on a big value, copy-on-write against in place (op_apply's in_place): append to a list
// of 10k, and edit deep in a map of 10k. each call changes the value and changes it back, so it
// stays the size it is; the mean per call. make bench, then changeable/c/apply-bench
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "apply.h"

enum { N = 10000 };

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e6 + (double)t.tv_nsec / 1e3;
}

static op_value *big(void) {
	op_value *root = op_map(), *list = op_list(), *map = op_map();
	for (int i = 0; i < N; i++) {
		op_push(list, op_num(i));
		char key[16];
		snprintf(key, sizeof key, "k%d", i);
		op_value *c = op_map(), *b = op_map(), *a = op_map();
		op_set(c, "c", op_num(i));
		op_set(b, "b", c);
		op_set(a, "a", b);
		op_set(map, key, a);
	}
	op_set(root, "list", list);
	op_set(root, "map", map);
	return root;
}

static void run(const char *name, const op_value *root, const op_patch *ps, size_t n, int calls) {
	for (int in_place = 0; in_place < 2; in_place++) {
		double t = now();
		for (int i = 0; i < calls; i++) {
			op_value *out = NULL;
			if (op_apply(root, ps, n, &(op_apply_options){.in_place = in_place}, &out, NULL) != OP_OK) {
				fprintf(stderr, "bench: refused\n");
				exit(1);
			}
			op_free(out);
		}
		printf("%-28s %-14s %10.2f us per call\n", name, in_place ? "in place" : "copy-on-write",
			(now() - t) / calls);
	}
}

int main(void) {
	op_value *root = big();
	op_value *one = op_list();
	op_push(one, op_num(1));
	const op_key list[] = {{.type = OP_STR_KEY, .s = "list"}};
	const op_patch append[] = {
		{.place = {list, 1, 1, N, N}, .has_value = 1, .value = one},
		{.place = {list, 1, 1, N, N + 1}},
	};
	const op_key deep[] = {{.type = OP_STR_KEY, .s = "map"}, {.type = OP_STR_KEY, .s = "k5000"},
		{.type = OP_STR_KEY, .s = "a"}, {.type = OP_STR_KEY, .s = "b"}, {.type = OP_STR_KEY, .s = "c"}};
	op_value *minus = op_num(-1), *back = op_num(5000);
	const op_patch edit[] = {
		{.place = {deep, 5, 0, 0, 0}, .has_value = 1, .value = minus},
		{.place = {deep, 5, 0, 0, 0}, .has_value = 1, .value = back},
	};
	run("append to a list of 10k", root, append, 2, 20000);
	run("edit deep in a map of 10k", root, edit, 2, 2000);
	op_free(one);
	op_free(minus);
	op_free(back);
	op_free(root);
	return 0;
}
