// The workloads of newcore/opstreams/squish_bench.ts: N patches each, made once, then squished, encoded
// and decoded R times; the mean per run. BENCH=1 ./build.sh && ./bench
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "squish.h"

enum { N = 10000, R = 200 };

static unsigned x = 1;
static unsigned rnd(unsigned n) { return (x = (x * 1103515245u + 12345u) & 0x7fffffffu) % n; }

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e6 + (double)t.tv_nsec / 1e3;
}

static const sq_key T[] = {{"t", 0}}, L[] = {{"l", 0}};
static sq_key docs[100][2], fields[10][100][3], rows[10][2];
static char names[100][8];
static int elements[N];
static const void *element[N];
static const uint8_t none = 0;

static sq_patch typing[N], fixing[N], appending[N], scattered[N], putting[N];

static void make(void) {
	for (int i = 0; i < 100; i++) snprintf(names[i], 8, "%d", i);
	for (int i = 0; i < N; i++) elements[i] = i, element[i] = &elements[i];
	for (int i = 0; i < N; i++) {
		typing[i] = (sq_patch){T, 1, 1, i, i, 1, sq_str("a", 1), NULL};
		appending[i] = (sq_patch){L, 1, 1, i, i, 1, sq_list(&element[i], 1), NULL};
	}
	for (int i = 0, caret = 0; i < N; i++) {
		if (i % 5 == 4) fixing[i] = (sq_patch){T, 1, 1, caret - 1, caret, 0, {0}, NULL}, caret--;
		else fixing[i] = (sq_patch){T, 1, 1, caret, caret, 1, sq_str("a", 1), NULL}, caret++;
	}
	for (int d = 0; d < 100; d++) docs[d][0] = (sq_key){"docs", 0}, docs[d][1] = (sq_key){names[d], 0};
	for (int i = 0; i < N; i++) {
		long at = rnd(1000);
		scattered[i] = (sq_patch){docs[rnd(100)], 2, 1, at, at, 1, sq_str("x", 1), NULL};
	}
	for (int r = 0; r < 10; r++) {
		rows[r][0] = (sq_key){"rows", 0}, rows[r][1] = (sq_key){NULL, r};
		for (int f = 0; f < 100; f++) {
			fields[r][f][0] = rows[r][0], fields[r][f][1] = rows[r][1];
			fields[r][f][2] = (sq_key){names[f], 0};
		}
	}
	for (int i = 0; i < N; i++) {
		int r = i / 100 % 10;
		if (i % 100 == 99) putting[i] = (sq_patch){rows[r], 2, 0, 0, 0, 1, sq_any(&none), NULL};
		else putting[i] = (sq_patch){fields[r][rnd(100)], 3, 0, 0, 0, 1, sq_any(&none), NULL};
	}
}

static volatile size_t sink;

static void bench(const char *name, const sq_patch *ps) {
	double t = now();
	sq *s = sq_new();
	for (int r = 0; r < R; r++) {
		sq_clear(s);
		for (int i = 0; i < N; i++) sq_push(s, &ps[i]);
		size_t n;
		sq_patches(s, &n);
		sink += n;
	}
	double squish = (now() - t) / R;
	t = now();
	for (int r = 0; r < R; r++) {
		sq_columns c = sq_encode(ps, N);
		sink += c.npaths;
		sq_columns_free(&c);
	}
	double encode = (now() - t) / R;
	sq_columns c = sq_encode(ps, N);
	t = now();
	for (int r = 0; r < R; r++) {
		size_t n;
		free(sq_decode(&c, &n));
		sink += n;
	}
	double decode = (now() - t) / R;
	size_t n;
	sq_patches(s, &n);
	printf("%-10s %9.1f %9.1f %9.1f   %5zu patches left, %zu path runs\n", name, squish, encode, decode, n,
	       c.path.n / 2);
	sq_columns_free(&c);
	sq_free(s);
}

int main(void) {
	make();
	printf("µs per %d patches  squish    encode    decode\n", N);
	bench("typing", typing);
	bench("fixing", fixing);
	bench("appending", appending);
	bench("scattered", scattered);
	bench("puts", putting);
	return 0;
}
