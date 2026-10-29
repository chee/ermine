// the tracker on what a scheduler does with it, as tracker_bench.ts does: runs that read spots,
// readers of a hot spot. cc -O2 -o tracker-bench tracker.c tracker_bench.c
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "tracker.h"

#define N 1000
#define HOT 5000

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e9 + (double)t.tv_nsec;
}
static size_t sink;

static tg_node **nodes(size_t n) {
	tg_node **out = malloc(n * sizeof *out);
	for (size_t i = 0; i < n; i++) out[i] = tg_node_new(NULL);
	return out;
}
static void run(tg_node *r, tg_node **to, size_t n) {
	tg_begin(r);
	for (size_t i = 0; i < n; i++) tg_track(r, to[i]);
	tg_end(r);
}
// the time for one call of f, over enough calls to take ~100 ms (after a warm-up)
typedef void (*fn)(void *);
static void bench(const char *name, fn f, void *arg) {
	for (int i = 0; i < 200; i++) f(arg);
	size_t reps = 1;
	double dt;
	for (;;) {
		double t0 = now();
		for (size_t i = 0; i < reps; i++) f(arg);
		dt = now() - t0;
		if (dt > 100e6) break;
		reps *= 2;
	}
	printf("%s\t%.1f\n", name, dt / (double)reps);
}

static tg_node **spots, *r, **half_a, **half_b, **readers, *hot;
static int flip;
static size_t cursor;

static void first_run(void *a) {
	(void)a;
	run(r, spots, N);
	tg_untrack(r, NULL);
}
static void rerun10(void *a) { run(r, spots, 10); (void)a; }
static void rerun_n(void *a) { run(r, spots, N); (void)a; }
static void rerun_half(void *a) {
	(void)a;
	flip = !flip;
	run(r, flip ? half_b : half_a, N / 2);
}
static void rerun_reversed(void *a) {
	(void)a;
	flip = !flip;
	run(r, flip ? half_b : half_a, 100);
}
static void read_many(void *a) { run(r, a, N); }
static void hot_leave(void *a) {
	(void)a;
	tg_node *x = readers[cursor++ % HOT];
	run(x, NULL, 0);
	run(x, &hot, 1);
}
static void hot_untrack(void *a) {
	(void)a;
	tg_node *x = readers[cursor++ % HOT];
	tg_untrack(x, hot);
	tg_add(x, hot);
}
static void hot_readers(void *a) {
	(void)a;
	for (tg_link *l = hot->first; l != NULL; l = l->after) sink++;
}
static void hot_readers_hole(void *a) {
	(void)a;
	tg_node *x = readers[1 + (cursor++ % (HOT - 2))];
	tg_untrack(x, hot);
	for (tg_link *l = hot->first; l != NULL; l = l->after) sink++;
	tg_add(x, hot);
}
static void run_untrack(void *a) {
	(void)a;
	run(r, spots, N);
	tg_untrack(r, NULL);
}
static void run_untrack_last(void *a) {
	(void)a;
	run(r, spots, N);
	tg_untrack(r, spots[N - 1]);
	tg_untrack(r, NULL);
}
static tg_node **chain, **fan;
static void chain_rerun(void *a) {
	(void)a;
	for (size_t i = 0; i < N - 1; i++) run(chain[i], &chain[i + 1], 1);
}
static void fan_rerun(void *a) {
	(void)a;
	for (size_t i = 0; i < N; i++) run(fan[i], &hot, 1);
}

int main(void) {
	spots = nodes(N);
	r = tg_node_new(NULL);
	bench("first run, 1000 spots (+ untrack)", first_run, NULL);

	run(r, spots, N);
	bench("re-run, same 10 spots", rerun10, NULL);
	bench("re-run, same 1000 spots", rerun_n, NULL);

	half_a = spots;
	half_b = spots + N / 4;
	tg_untrack(r, NULL);
	run(r, half_a, N / 2);
	bench("re-run, other half of 1000 (overlap half)", rerun_half, NULL);

	tg_untrack(r, NULL);
	tg_node **back = malloc(100 * sizeof *back);
	for (int i = 0; i < 100; i++) back[i] = spots[99 - i];
	half_a = spots;
	half_b = back;
	run(r, spots, 100);
	bench("re-run, reversed 100 spots", rerun_reversed, NULL);

	tg_untrack(r, NULL);
	tg_node **many = malloc(N * sizeof *many);
	for (int i = 0; i < N; i++) many[i] = spots[0];
	bench("one spot read 1000 times in a run", read_many, many);

	tg_untrack(r, NULL);
	hot = tg_node_new(NULL);
	readers = nodes(HOT);
	for (size_t i = 0; i < HOT; i++) run(readers[i], &hot, 1);
	bench("hot spot, 5000 readers, one leaves and returns", hot_leave, NULL);
	bench("hot spot, 5000 readers, untrack and add back", hot_untrack, NULL);
	bench("readers of a hot spot, 5000, no holes", hot_readers, NULL);
	bench("readers of a hot spot, 5000, after one leaves", hot_readers_hole, NULL);

	bench("run + untrack a reader of 1000 spots", run_untrack, NULL);
	bench("run + untrack one spot (the last) + untrack all", run_untrack_last, NULL);

	chain = nodes(N);
	for (size_t i = 0; i < N - 1; i++) run(chain[i], &chain[i + 1], 1);
	bench("deep chain, 1000 re-runs of one read", chain_rerun, NULL);

	fan = nodes(N);
	hot = tg_node_new(NULL);
	for (size_t i = 0; i < N; i++) run(fan[i], &hot, 1);
	bench("wide fan, 1000 readers of one spot re-run", fan_rerun, NULL);

	return (int)(sink == 1);
}
