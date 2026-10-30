// Benchmark for paths.h matching paths_bench.ts: median of 31 rounds, in microseconds per mark.
// Run with: make reactivity/c/paths-bench
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "paths.h"

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e6 + (double)t.tv_nsec / 1e3;
}
static int order(const void *a, const void *b) {
	double x = *(const double *)a, y = *(const double *)b;
	return x < y ? -1 : x > y;
}
typedef void (*fn)(void);
static double median(fn f, int calls) {
	double times[31];
	for (int i = 0; i < calls; i++) f();
	for (int r = 0; r < 31; r++) {
		double t0 = now();
		for (int i = 0; i < calls; i++) f();
		times[r] = (now() - t0) / calls;
	}
	qsort(times, 31, sizeof *times, order);
	return times[15];
}

static pt_paths *p;
static pt_key v, doc, folder, stream;
static size_t sink;
static op_value *one;
static long k;
static int flip;

static op_key str(const char *s) { return (op_key){.type = OP_STR_KEY, .s = s}; }
static op_key num(long n) { return (op_key){.type = OP_NUM_KEY, .n = n}; }

static void keystroke(void) {
	op_key body = str("body");
	op_patch patch = {.place = {&body, 1, 1, k, k}, .has_value = 1, .value = one};
	size_t n;
	pt_mark(p, v, doc, &patch, 1, &n);
	sink += n;
	k = (k + 1) % 1000;
}
static void rename_(void) {
	static op_key a, b;
	a = str("name2500"), b = str("renamed");
	flip = !flip;
	op_patch patch = {.place = {flip ? &b : &a, 1, 0, 0, 0}, .has_move = 1, .move = {flip ? &a : &b, 1, 0, 0, 0}};
	size_t n;
	pt_mark(p, v, folder, &patch, 1, &n);
	sink += n;
}
static void appends(void) {
	for (long i = 100; i < 10100; i++) {
		op_patch patch = {.place = {NULL, 0, 1, i, i}, .has_value = 1, .value = one};
		size_t n;
		pt_mark(p, v, stream, &patch, 1, &n);
		sink += n;
	}
}

int main(void) {
	v = pt_string("v"), doc = pt_string("doc"), folder = pt_string("folder"), stream = pt_string("stream");
	one = op_str("x");
	char name[32];
	int sizes[] = {10, 100, 1000};
	for (int s = 0; s < 3; s++) {
		p = pt_new();
		for (int i = 0; i < sizes[s]; i++) {
			snprintf(name, sizeof name, "field%d", i);
			op_key key = str(name);
			pt_spot_of(p, v, doc, &key, 1, 0);
		}
		op_key body = str("body");
		pt_spot_of(p, v, doc, &body, 1, 0);
		pt_spot_of(p, v, doc, NULL, 0, 0);
		printf("keystroke, %d readers of other fields\t%.3f µs\n", sizes[s], median(keystroke, 10000));
		pt_free(p);
	}

	p = pt_new();
	for (int i = 0; i < 5000; i++) {
		snprintf(name, sizeof name, "name%d", i);
		op_key key = str(name);
		pt_spot_of(p, v, folder, &key, 1, 0);
	}
	pt_spot_of(p, v, folder, NULL, 0, 0);
	printf("rename in 5000 names, 5000 readers\t%.3f µs\n", median(rename_, 10000));
	pt_free(p);

	p = pt_new();
	for (long i = 0; i < 100; i++) {
		op_key key = num(i);
		pt_spot_of(p, v, stream, &key, 1, 0);
	}
	pt_spot_of(p, v, stream, NULL, 0, 0);
	printf("append, 100 index readers (one of 10k)\t%.3f µs\n", median(appends, 1) / 10000);
	pt_free(p);

	op_free(one);
	return sink == 0;
}
