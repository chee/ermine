// Tests the C squish at the ends of a 64-bit whole number. Exits 1 at the first failure.
#include <stdio.h>
#include <stdlib.h>

#include "squish.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static const sq_key t[] = {{"t", 0}};

static sq_patch put(int64_t from, int64_t to, const char *s, size_t size) {
	return (sq_patch){.path = t, .depth = 1, .has_range = 1, .from = from, .to = to, .has_value = 1,
		.value = sq_str(s, size)};
}
static sq_patch removal(int64_t from, int64_t to) {
	return (sq_patch){.path = t, .depth = 1, .has_range = 1, .from = from, .to = to};
}

static size_t squished(sq_patch a, sq_patch b) {
	sq *s = sq_new();
	sq_push(s, &a);
	sq_push(s, &b);
	size_t n;
	sq_patches(s, &n);
	sq_free(s);
	return n;
}

int main(void) {
	CHECK(squished(put(INT64_MAX - 1, INT64_MAX - 1, "abc", 3), put(INT64_MAX, INT64_MAX, "d", 1)) == 2);
	CHECK(squished(put(0, INT64_MAX, "ab", 2), removal(2, 5)) == 2);
	CHECK(squished(removal(0, INT64_MAX), removal(0, 5)) == 2);
	squished(removal(INT64_MIN, INT64_MIN), removal(INT64_MIN, INT64_MAX));
	{
		sq *s = sq_new();
		sq_patch ps[] = {put(INT64_MAX - 1, INT64_MAX - 1, "abc", 3), removal(0, 0), removal(0, 1)};
		for (size_t i = 0; i < 3; i++) sq_push(s, &ps[i]);
		sq_free(s);
	}

	{
		sq_patch ps[] = {removal(INT64_MIN, INT64_MAX), removal(INT64_MAX, INT64_MAX),
			removal(INT64_MIN, INT64_MIN + 1), removal(5, 3)};
		sq_columns c = sq_encode(ps, 4);
		size_t n;
		sq_patch *back = sq_decode(&c, &n);
		CHECK(back && n == 4);
		for (size_t i = 0; i < n; i++) CHECK(back[i].from == ps[i].from && back[i].to == ps[i].to);
		free(back);
		sq_columns_free(&c);
	}

	{
		sq_path paths[] = {{t, 1}};
		int64_t path[] = {0, 1}, shape[] = {0, INT64_MAX, 0, INT64_MAX, 0, 3};
		sq_columns c = {.paths = paths, .npaths = 1, .path = {path, 2}, .shape = {shape, 6}};
		size_t n;
		sq_patch *back = sq_decode(&c, &n);
		CHECK(!back && n == (size_t)-1);
	}
	puts("squish_test: ok");
	return 0;
}
