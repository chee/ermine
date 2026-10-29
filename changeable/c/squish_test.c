// the C squish (squish.h) at the ends of a 64-bit whole number: what no scenario reaches (the line
// protocol's numbers are doubles). ranges joined past them stay apart, columns' steps and sizes
// wrap and come back as they went, and counts adding up past a size_t are bad columns. exits 1 at
// the first thing that is not so. make test-c-squish-test (test-check-, test-leaks-); or under the
// sanitizers, recovering from none:
//   cc -std=c11 -g -O1 -fsanitize=address,undefined -fno-sanitize-recover=all \
//     -o /tmp/squish-test changeable/c/squish.c changeable/c/squish_test.c && /tmp/squish-test
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

// how many patches a and then b squish to
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
	// a put's span, a + n, past the end
	CHECK(squished(put(INT64_MAX - 1, INT64_MAX - 1, "abc", 3), put(INT64_MAX, INT64_MAX, "d", 1)) == 2);
	// a removal past what a put made: its range grown past the end
	CHECK(squished(put(0, INT64_MAX, "ab", 2), removal(2, 5)) == 2);
	// a removal over a removal: grown past the end
	CHECK(squished(removal(0, INT64_MAX), removal(0, 5)) == 2);
	// a removal over one from the bottom to the top: how far it runs, d - a, is past the end. joined
	// or not, never overflowing
	squished(removal(INT64_MIN, INT64_MIN), removal(INT64_MIN, INT64_MAX));
	// reaching back, with the span of the one before past the end
	{
		sq *s = sq_new();
		sq_patch ps[] = {put(INT64_MAX - 1, INT64_MAX - 1, "abc", 3), removal(0, 0), removal(0, 1)};
		for (size_t i = 0; i < 3; i++) sq_push(s, &ps[i]);
		sq_free(s);
	}

	// columns: steps from the bottom to the top and back, sizes from the bottom to the top
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

	// counts that add up past a size_t: bad, not a few patches
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
