// places on what it is used for, timed by hand: the cases of typescript/places_bench.ts (the same
// world: a deep chain of 8 names, a wide folder of 5000, a fan of 3 entries 4 deep, a shallow
// name; nodes in a table, the hole as a scheduler would have it), each run ROUNDS times, round
// robin, and its median printed in µs per rep, with what a rep costs in C: allocations (malloc +
// calloc + realloc), frees, calls into the hole, reads told. Run it several times and compare
// medians: one process is one run.
//
// counting allocations renames the allocators in every file but this one, which keeps the real ones:
//   cc -O2 -Dmalloc=bench_malloc -Dcalloc=bench_calloc -Drealloc=bench_realloc -Dfree=bench_free \
//     -o places-bench places.c trie.c ../../graph/c/table.c ../../node/c/node.c ../../node/c/update.c \
//     ../../op/c/value.c ../../op/c/apply.c ../../op/c/invert.c places_bench.c
#define _POSIX_C_SOURCE 200809L
#undef malloc
#undef calloc
#undef realloc
#undef free
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "places.h"

// --- counting ---

static size_t allocs, frees;
void *bench_malloc(size_t n) {
	allocs++;
	return malloc(n);
}
void *bench_calloc(size_t n, size_t size) {
	allocs++;
	return calloc(n, size);
}
void *bench_realloc(void *p, size_t n) {
	allocs++;
	return realloc(p, n);
}
void bench_free(void *p) {
	if (p != NULL) frees++;
	free(p);
}

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e6 + (double)t.tv_nsec / 1e3;
}

// --- the world ---

static tb_table *world;
static size_t holes, reads;
static const tb_key S = {.string = "s"};
static ch_header h = {.has_time = 1, .time = 1, .actor = "me"};

static nd_node *children(void *ctx, tb_key source, tb_key id) {
	(void)ctx;
	holes++;
	return tb_get(world, source, id);
}
static void told(void *ctx, tb_key source, tb_key id, const char *name, int keys) {
	(void)ctx;
	(void)source;
	(void)id;
	(void)name;
	(void)keys;
	reads++;
}

static op_value *entry(const char *id) {
	op_value *e = op_list();
	op_push(e, op_str("s"));
	op_push(e, op_str(id));
	return e;
}
// takes value; the node in the world under id, in place of any there
static void kids(const char *id, op_value *value) {
	nd_node *old = tb_get(world, S, tb_string(id));
	if (old != NULL) nd_free(old);
	nd_node *n = nd_make(value, &h, NULL);
	op_free(value);
	tb_sub(world, S, tb_string(id), n);
}
static op_value *one(const char *name, const char *id) {
	op_value *m = op_map(), *l = op_list();
	op_push(l, entry(id));
	op_set(m, name, l);
	return m;
}

#define DEPTH 8
#define WIDTH 5000
#define MANY 1000
static char deep_names[DEPTH][16];
static const char *deep[DEPTH];
static char wide_names[WIDTH][16];
static const char *wide[WIDTH];
static const char *fan[5] = {"fan", "x", "x", "x", "x"};
static const pl_at R = {NULL, {.string = "s"}, {.string = "R"}};
static const pl_at W = {NULL, {.string = "s"}, {.string = "W"}};
static const pl_at A = {NULL, {.string = "s"}, {.string = "A"}};
static const pl_at X = {NULL, {.string = "s"}, {.string = "X"}};

static void make_world(void) {
	world = tb_new();
	for (int i = 0; i < DEPTH; i++) snprintf(deep_names[i], 16, "deep-%d", i), deep[i] = deep_names[i];
	for (int i = 0; i < WIDTH; i++) snprintf(wide_names[i], 16, "wide-%d", i), wide[i] = wide_names[i];
	op_value *root = op_map();
	op_value *l;
	l = op_list(), op_push(l, entry("A")), op_set(root, "a", l);
	l = op_list(), op_push(l, entry("W")), op_set(root, "wide", l);
	l = op_list(), op_push(l, entry("F")), op_set(root, "fan", l);
	l = op_list(), op_push(l, entry("D0")), op_set(root, deep[0], l);
	kids("R", root);
	kids("A", one("b", "B"));
	char id[16], up[16];
	for (int i = 1; i < DEPTH; i++) {
		snprintf(id, 16, "D%d", i), snprintf(up, 16, "D%d", i - 1);
		kids(up, one(deep[i], id));
	}
	snprintf(id, 16, "D%d", DEPTH - 1);
	kids(id, one("leaf", "L"));
	op_value *w = op_map();
	for (int i = 0; i < WIDTH; i++) {
		snprintf(id, 16, "W%d", i);
		l = op_list(), op_push(l, entry(id)), op_set(w, wide[i], l);
	}
	kids("W", w);
	// a fan: x has 3 entries, in each of F, F0, F1, F2 and so on 4 deep
	static const char *const fs[3] = {"F0", "F1", "F2"};
	for (int k = -1; k < 3; k++) {
		op_value *m = op_map();
		l = op_list();
		for (int i = 0; i < 3; i++) op_push(l, entry(fs[i]));
		op_set(m, "x", l);
		kids(k < 0 ? "F" : fs[k], m);
	}
}

// a node with n entries under t (and u for moves across names), fresh before each write; A, the
// other parent moved into, fresh too
static void fresh(size_t n) {
	kids("A", one("b", "B"));
	op_value *m = op_map(), *t = op_list(), *u = op_list();
	char id[16];
	for (size_t i = 0; i < n; i++) snprintf(id, 16, "e%zu", i), op_push(t, entry(id));
	op_push(u, entry("4"));
	op_set(m, "t", t);
	op_set(m, "u", u);
	kids("X", m);
}
static void small(void) { fresh(3); }
static void large(void) { fresh(2000); }

// --- the cases ---

static pl *quiet, *telling;
static pl_item *deep_item;
static pl_held *many[MANY];
static pl_held *one_quiet, *one_told;
static size_t sink;
static const char *a[1] = {"a"}, *nope[1] = {"nope"}, *leaf[1] = {"leaf"};
static const char *up_leaf[2] = {"..", "leaf"};
static const char *dots[5] = {"a", ".", "..", "a", "b"};
static const char *wide_name[2] = {"wide", NULL};
static tb_key nine = {.string = "9"}, o = {.string = "O"};

// the hole alone, as pl_items asks it
static void hole(void) { sink += children(NULL, S, R.id) != NULL; }
static void got(pl_list *l) {
	sink += l->n;
	pl_list_free(l);
}
static void get_shallow(void) { got(pl_get(quiet, a, 1, NULL, NULL)); }
static void get_shallow_read(void) { got(pl_get(telling, a, 1, NULL, NULL)); }
static void get_deep(void) { got(pl_get(quiet, deep, DEPTH, NULL, NULL)); }
static void get_deep_read(void) { got(pl_get(telling, deep, DEPTH, NULL, NULL)); }
static void get_deep_from_item(void) {
	pl_at at = pl_at_item(deep_item);
	got(pl_get(quiet, up_leaf, 2, &at, NULL));
}
static void get_dots(void) { got(pl_get(quiet, dots, 5, NULL, NULL)); }
static void get_wide_name(void) { got(pl_get(quiet, wide_name, 2, NULL, NULL)); }
static void get_fan(void) { got(pl_get(quiet, fan, 5, NULL, NULL)); }
static void get_missing(void) { got(pl_get(quiet, nope, 1, NULL, NULL)); }
static void lookup_missing(void) {
	pl_at at = pl_at_item(deep_item);
	got(pl_lookup(quiet, nope, 1, &at, 0, NULL));
}
static void lookup_at_root(void) {
	pl_at at = pl_at_item(deep_item);
	got(pl_lookup(quiet, a, 1, &at, 0, NULL));
}
static void lookup_all(void) {
	pl_at at = pl_at_item(deep_item);
	got(pl_lookup(quiet, leaf, 1, &at, 1, NULL));
}
static void names_wide(void) {
	pl_strings s = pl_names(quiet, W, NULL);
	sink += s.n;
	pl_strings_free(s);
}
static void open_drop_deep(void) {
	pl_held *o = pl_open(quiet, deep, DEPTH, NULL);
	sink += pl_items(o, NULL)->n;
	pl_close(o);
}
static void items_same(void) { sink += pl_items(one_quiet, NULL)->n; }
static void items_same_read(void) { sink += pl_items(one_told, NULL)->n; }
static void all(void) {
	for (size_t i = 0; i < MANY; i++) sink += pl_items(many[i], NULL)->n;
}
static void unrelated_change(void) {
	pl_place(telling, R, "other", S, o, h, PL_END, NULL, NULL);
	pl_unplace(telling, R, "other", 0, h, NULL, NULL);
}
static void rename_above(void) {
	pl_rename(telling, R, "wide", "gone", h, NULL, NULL);
	all();
	pl_rename(telling, R, "gone", "wide", h, NULL, NULL);
}
static void place_small(void) { pl_place(telling, X, "t", S, nine, h, PL_END, NULL, NULL); }
static void place_large(void) { pl_place(telling, X, "t", S, nine, h, 1000, NULL, NULL); }
static void unplace_small(void) { pl_unplace(telling, X, "t", 1, h, NULL, NULL); }
static void unplace_large(void) { pl_unplace(telling, X, "t", 1000, h, NULL, NULL); }
static void order_small(void) { pl_order(telling, X, "t", 0, 2, h, NULL, NULL); }
static void order_large(void) { pl_order(telling, X, "t", 0, 1999, h, NULL, NULL); }
static void rename_t(void) { pl_rename(telling, X, "t", "v", h, NULL, NULL); }
static void move_t(void) { pl_move(telling, X, "t", 0, X, "u", h, PL_END, NULL, NULL); }
static void move_other(void) { pl_move(telling, X, "t", 0, A, "u", h, PL_END, NULL, NULL); }

// name, reps per timing, what to do before each rep (not timed), the work
typedef struct {
	const char *name;
	int reps;
	void (*before)(void);
	void (*work)(void);
} bench_case;
static const bench_case cases[] = {
	{"hole alone", 20000, NULL, hole},
	{"get shallow", 20000, NULL, get_shallow},
	{"get shallow, read", 20000, NULL, get_shallow_read},
	{"get deep", 5000, NULL, get_deep},
	{"get deep, read", 5000, NULL, get_deep_read},
	{"get deep from item, ..", 5000, NULL, get_deep_from_item},
	{"get dots", 10000, NULL, get_dots},
	{"get wide name", 20000, NULL, get_wide_name},
	{"get fan (81 items)", 1000, NULL, get_fan},
	{"get missing", 20000, NULL, get_missing},
	{"lookup from deep, missing", 2000, NULL, lookup_missing},
	{"lookup from deep, at root", 2000, NULL, lookup_at_root},
	{"lookup from deep, all", 2000, NULL, lookup_all},
	{"names wide", 20, NULL, names_wide},
	{"open + drop deep", 5000, NULL, open_drop_deep},
	{"items same, deep", 20000, NULL, items_same},
	{"items same, deep, read", 20000, NULL, items_same_read},
	{"items same, 1000 shared", 10, NULL, all},
	{"items after unrelated change, 1000 shared", 10, unrelated_change, all},
	{"items after rename above, 1000 shared", 10, rename_above, all},
	{"place small", 2000, small, place_small},
	{"place large", 500, large, place_large},
	{"unplace small", 2000, small, unplace_small},
	{"unplace large", 500, large, unplace_large},
	{"order small", 2000, small, order_small},
	{"order large", 500, large, order_large},
	{"rename small", 2000, small, rename_t},
	{"rename large", 500, large, rename_t},
	{"move small", 2000, small, move_t},
	{"move large", 500, large, move_t},
	{"move small, other parent", 2000, small, move_other},
};
#define CASES (sizeof cases / sizeof *cases)
#define ROUNDS 15
#define WARMUP 3

static int by_double(const void *a, const void *b) {
	double x = *(const double *)a, y = *(const double *)b;
	return x < y ? -1 : x > y;
}

int main(void) {
	make_world();
	wide_name[1] = wide[2500];
	pl_setup s = {.root_source = S, .root_id = {.string = "R"}, .children = children};
	quiet = pl_new(&s);
	s.read = told;
	telling = pl_new(&s);
	pl_list *d = pl_get(quiet, deep, DEPTH, NULL, NULL);
	deep_item = pl_item_ref(d->items[0]);
	pl_list_free(d);
	// opened places sharing a beginning: wide-0 .. wide-999 under wide, from the places told of reads
	for (size_t i = 0; i < MANY; i++) {
		const char *address[2] = {"wide", wide[i]};
		many[i] = pl_open(telling, address, 2, NULL);
	}
	one_quiet = pl_open(quiet, deep, DEPTH, NULL);
	one_told = pl_open(telling, deep, DEPTH, NULL);

	static double times[CASES][ROUNDS];
	static double counts[CASES][4]; // allocs, frees, holes, reads per rep, from the last round
	for (int r = 0; r < WARMUP + ROUNDS; r++) {
		for (size_t c = 0; c < CASES; c++) {
			const bench_case *b = &cases[c];
			double t = 0;
			size_t a = 0, f = 0, ho = 0, re = 0; // the work's own, not what before did
			if (b->before == NULL) {
				size_t a0 = allocs, f0 = frees, h0 = holes, r0 = reads;
				double t0 = now();
				for (int i = 0; i < b->reps; i++) b->work();
				t = now() - t0;
				a = allocs - a0, f = frees - f0, ho = holes - h0, re = reads - r0;
			} else {
				for (int i = 0; i < b->reps; i++) {
					b->before();
					size_t a0 = allocs, f0 = frees, h0 = holes, r0 = reads;
					double t0 = now();
					b->work();
					t += now() - t0;
					a += allocs - a0, f += frees - f0, ho += holes - h0, re += reads - r0;
				}
			}
			if (r >= WARMUP) times[c][r - WARMUP] = t / b->reps;
			counts[c][0] = (double)a / b->reps;
			counts[c][1] = (double)f / b->reps;
			counts[c][2] = (double)ho / b->reps;
			counts[c][3] = (double)re / b->reps;
		}
	}
	printf("%-44s %10s %8s %8s %8s %8s\n", "case", "median", "allocs", "frees", "holes", "reads");
	for (size_t c = 0; c < CASES; c++) {
		qsort(times[c], ROUNDS, sizeof(double), by_double);
		double m = times[c][ROUNDS / 2];
		char us[32];
		if (m >= 1000) snprintf(us, sizeof us, "%.1fms", m / 1000);
		else snprintf(us, sizeof us, "%.2fµs", m);
		printf("%-44s %10s %8.1f %8.1f %8.1f %8.1f\n", cases[c].name, us, counts[c][0], counts[c][1],
			counts[c][2], counts[c][3]);
	}
	for (size_t i = 0; i < MANY; i++) pl_close(many[i]);
	pl_close(one_quiet);
	pl_close(one_told);
	pl_item_free(deep_item);
	pl_free(quiet);
	pl_free(telling);
	return sink == 1;
}
