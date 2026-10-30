// crow (crow.h) through crowify (crowify.h) on what crow/typescript/crow_bench.ts measures, at the
// entry (its places row is places/typescript/crowify_bench.ts'): fastest of 31 rounds, µs per write. copy: nd_update on a copying entry; in
// place: op_apply with in_place on the entry's value; crow. a burst: no read between;
// read between: crow is told of a read before each write. then a first write to each of many
// entries, kept, and the scheduler's chain (what the TypeScript bench has, but its places row)
// make places/c/crowify-bench
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "../../graph/c/update.h"
#include "../../crow/c/crow.h"
#include "crowify.h"
#include "../../reactivity/c/scheduler.h"

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e6 + (double)t.tv_nsec / 1e3;
}

static op_key str(const char *s) { return (op_key){.type = OP_STR_KEY, .s = s}; }
static op_key num(long n) { return (op_key){.type = OP_NUM_KEY, .n = n}; }

// the world of a row: what it starts with, and its i-th patch
enum { COPY, IN_PLACE, CROW };
typedef struct {
	op_value *(*start)(void);
	// the i-th write's patches (n of them)
	void (*patch)(long i, op_patch *out);
	int n;
} row;

static ch_header header = {.has_time = 1, .time = 1, .actor = "bench"};

static op_value *folder(size_t n) {
	op_value *m = op_map();
	char name[32];
	for (size_t i = 0; i < n; i++) {
		snprintf(name, sizeof name, "name%zu", i);
		op_set(m, name, op_str("id"));
	}
	return m;
}
static op_value *folder_1000(void) { return folder(1000); }
static op_value *folder_30k(void) { return folder(30000); }
static op_value *doc(void) {
	op_value *m = op_map(), *theme = op_map();
	op_set(theme, "accent", op_str("lemon"));
	op_set(theme, "font", op_str("chicago"));
	op_set(m, "theme", theme);
	op_set(m, "n", op_num(0));
	char name[32];
	for (int i = 0; i < 50; i++) {
		snprintf(name, sizeof name, "f%d", i);
		op_set(m, name, op_str("field"));
	}
	return m;
}
static op_value *items(void) {
	op_value *list = op_list();
	for (int i = 0; i < 1000; i++) {
		op_value *item = op_map();
		op_set(item, "id", op_num(i));
		op_set(item, "text", op_str("item"));
		op_set(item, "done", op_bool(0));
		op_push(list, item);
	}
	op_value *m = op_map();
	op_set(m, "items", list);
	return m;
}

static op_value *deep(void) {
	op_value *cur = op_map();
	op_set(cur, "n", op_num(0));
	const char *down[] = {"f", "e", "d", "c", "b", "a"};
	for (int i = 0; i < 6; i++) {
		op_value *level = op_map();
		op_set(level, down[i], cur);
		cur = level;
	}
	op_value *side = op_map();
	op_set(side, "x", op_num(1));
	op_set(cur, "side", side);
	return cur;
}
static op_value *list_10k(void) {
	op_value *list = op_list();
	for (int i = 0; i < 10000; i++) op_push(list, op_num(i));
	op_value *m = op_map();
	op_set(m, "list", list);
	return m;
}
static op_value *text_10k(void) {
	char *x = malloc(10001);
	for (int i = 0; i < 10000; i++) x[i] = 'x';
	x[10000] = 0;
	op_value *m = op_map();
	op_set(m, "body", op_str_take(x, 10000));
	return m;
}
static op_value *floats(void) {
	double *z = calloc(10000, sizeof *z);
	op_value *m = op_map();
	op_set(m, "samples", op_typed(OP_FLOAT64, z, 10000));
	free(z);
	return m;
}

// the patches: keys and values made once, cycled through
static op_key names[1000];
static op_key *item_paths[1000];
static op_value *ids[1000], *yes, *no;
static op_key n_key;
static void rename_(long i, op_patch *out) {
	long k = i % 1000;
	*out = (op_patch){.place = {&names[k], 1, 0, 0, 0}, .has_value = 1, .value = ids[k]};
}
static void field(long i, op_patch *out) {
	*out = (op_patch){.place = {&n_key, 1, 0, 0, 0}, .has_value = 1, .value = ids[i % 1000]};
}
static void done(long i, op_patch *out) {
	*out = (op_patch){.place = {item_paths[i % 1000], 3, 0, 0, 0}, .has_value = 1,
		.value = i % 2 == 0 ? yes : no};
}

static op_key deep_path[7], five_paths[5], body_path, list_path, samples_path;
static char five_names[5][8];
static op_value *one_item[1000], *one_char, *one_sample[1000];
static void deep_field(long i, op_patch *out) {
	*out = (op_patch){.place = {deep_path, 7, 0, 0, 0}, .has_value = 1, .value = ids[i % 1000]};
}
static void five(long i, op_patch *out) {
	for (int k = 0; k < 5; k++)
		out[k] = (op_patch){.place = {&five_paths[k], 1, 0, 0, 0}, .has_value = 1, .value = ids[i % 1000]};
}
static void append(long i, op_patch *out) {
	*out = (op_patch){.place = {&list_path, 1, 1, 10000 + i, 10000 + i}, .has_value = 1,
		.value = one_item[i % 1000]};
}
static void type(long i, op_patch *out) {
	(void)i;
	*out = (op_patch){.place = {&body_path, 1, 1, 5000, 5000}, .has_value = 1, .value = one_char};
}
static void sample(long i, op_patch *out) {
	*out = (op_patch){.place = {&samples_path, 1, 1, i % 10000, i % 10000 + 1}, .has_value = 1,
		.value = one_sample[i % 1000]};
}

// in place, as op_apply's in_place does: the value changed where it is, the change made as nd_update makes it
static void in_place(nd_entry *e, const op_patch *p, size_t n, ch_header header) {
	op_undo undo = {0};
	op_apply_options ao = {.undo = &undo, .in_place = 1};
	op_value *after = NULL;
	if (op_apply(e->value, p, n, &ao, &after, NULL) != OP_OK) abort();
	op_free(e->value);
	e->value = after;
	op_undo_free(&e->undo);
	e->undo = undo;
	ch_frame_ref(header.frame);
	ch_frame_free(e->change.frame);
	e->change = header;
	e->change.has_op = 1;
	e->change.patches = p;
	e->change.patches_length = n;
	e->change.undo = undo.patches;
	e->change.undo_length = undo.n;
}

// µs per write of a way, fastest of 31 rounds of calls writes after calls to warm up
static double fastest(const row *r, int way, int reading, int calls) {
	cr_crow *u = cr_new();
	nd_entry *e = nd_make_entry(r->start(), &header);
	long i = 0;
	double best = 1e30;
	for (int round = -1; round < 31; round++) {
		double t0 = now();
		for (int c = 0; c < calls; c++, i++) {
			op_patch p[5];
			r->patch(i, p);
			if (way == CROW) {
				if (reading) cr_let_go(u, e);
				pl_update_entry(u, e, p, r->n, header, NULL);
			} else if (way == IN_PLACE) {
				in_place(e, p, r->n, header);
			} else {
				nd_update(e, p, r->n, header, NULL);
			}
		}
		double t = (now() - t0) / calls;
		if (round >= 0 && t < best) best = t;
	}
	nd_free_entry(e);
	cr_free(u);
	return best;
}

static void measure(const char *name, const row *r, int reading, int calls) {
	printf("%s\tcopy %.2f", name, fastest(r, COPY, reading, calls));
	// in place changes what a reader holds: not a way when there are readers
	if (!reading) printf("\tin place %.2f", fastest(r, IN_PLACE, reading, calls));
	printf("\tcrow %.2f µs\n", fastest(r, CROW, reading, calls));
}

// a first write to each of 10k entries: µs per entry, fastest of 11
enum { ENTRIES = 10000 };
static void first_writes(void) {
	printf("a first write to each of 10k entries");
	for (int way = COPY; way <= CROW; way += 2) {
		double best = 1e30;
		static nd_entry *es[ENTRIES];
		for (int r = 0; r < 11; r++) {
			cr_crow *u = cr_new();
			for (int k = 0; k < ENTRIES; k++) es[k] = nd_make_entry(doc(), &header);
			op_patch p;
			field(1, &p);
			double t0 = now();
			for (int k = 0; k < ENTRIES; k++) {
				if (way == COPY) nd_update(es[k], &p, 1, header, NULL);
				else pl_update_entry(u, es[k], &p, 1, header, NULL);
			}
			double t = (now() - t0) / ENTRIES;
			if (t < best) best = t;
			for (int k = 0; k < ENTRIES; k++) nd_free_entry(es[k]);
			cr_free(u);
		}
		printf("\t%s %.2f", way == COPY ? "copy" : "crow", best);
	}
	printf(" µs\n");
}

// kept: what a computation's result costs to let go, by its size: walked whole, or handed (the
// value itself: the walk stops there)
static void kept_rows(void) {
	cr_crow *u = cr_new();
	struct {
		const char *what;
		op_value *(*make)(void);
		int calls;
	} sized[] = {{"a 52-field doc", doc, 1000}, {"a list of 1000 items", items, 1000},
		{"a folder of 30k names", folder_30k, 20}};
	for (int k = 0; k < 3; k++) {
		op_value *v = sized[k].make();
		int calls = sized[k].calls;
		const op_value *own[1] = {v};
		double times[2];
		for (int way = 0; way < 2; way++) {
			double best = 1e30;
			for (int round = -1; round < 31; round++) {
				double t0 = now();
				for (int c = 0; c < calls; c++) cr_let_go_in(u, v, way ? own : NULL, way ? 1 : 0);
				double t = (now() - t0) / calls;
				if (round >= 0 && t < best) best = t;
			}
			times[way] = best;
		}
		printf("kept: %s\twhole %.2f\thanded %.2f µs\n", sized[k].what, times[0], times[1]);
		op_free(v);
	}
	cr_free(u);
}

// the scheduler: a chain of 100 computes, one write at its head, µs per pulse
enum { CHAIN = 100 };
typedef struct node_ node_;
struct node_ {
	sc_scheduler *s;
	// where its result is kept (the scheduler's: borrowed here), what it reads
	op_value *value;
	node_ *from;
};
typedef struct {
	sc_scheduler *s;
	node_ head, nodes[CHAIN];
	sc_scope *root;
} chain;
static void chain_drop(void *value, void *data) {
	(void)data;
	op_free(value);
}
static op_value *counted(double n) {
	op_value *m = op_map();
	op_set(m, "n", op_num(n));
	return m;
}
static sc_out chain_f(void *previous, void *data) {
	(void)previous;
	node_ *n = data;
	sc_track(n->s, n->from);
	return (sc_out){.kind = SC_VALUE, .value = counted(op_get(n->from->value, "n")->num + 1)};
}
static char *chain_set(void *value, void *data) {
	node_ *n = data;
	n->value = value;
	sc_mark(n->s, (const void *const[]){n}, 1, sc_get_run(n->s));
	return NULL;
}
static void chain_listen(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data) {
	(void)c, (void)n, (void)ended, (void)reads, (void)nreads, (void)more, (void)data;
}
static void chain_build(void *data) {
	chain *c = data;
	for (int i = 0; i < CHAIN; i++) {
		c->nodes[i] = (node_){c->s, NULL, i == 0 ? &c->head : &c->nodes[i - 1]};
		sc_create_computer(c->s, (sc_def){.f = chain_f, .set = chain_set, .key = &c->nodes[i],
			.data = &c->nodes[i]}, NULL, 0);
	}
}
static void chain_row(void) {
	printf("scheduler: a chain of 100 computes, a pulse");
	const char *ways[] = {"none", "listener", "keeping"};
	for (int w = 0; w < 3; w++) {
		static chain c;
		cr_crow *u = cr_new();
		c.s = sc_new((sc_options){.drop = chain_drop});
		if (w == 1) sc_on_run_end(c.s, chain_listen, NULL);
		pl_crowified *wired = w == 2 ? pl_crowify(c.s, u, NULL, NULL) : NULL;
		op_value *actor = op_str("bench");
		sc_pair info = {"actor", actor};
		c.root = sc_create_root_scope(c.s, &info, 1);
		op_free(actor);
		c.head = (node_){c.s, counted(0), NULL};
		sc_run_with_scope(c.root, chain_build, &c);
		sc_pulse(c.s);
		double best = 1e30;
		long i = 0;
		for (int round = -1; round < 31; round++) {
			double t0 = now();
			for (int k = 0; k < 200; k++) {
				op_free(c.head.value);
				c.head.value = counted((double)++i);
				sc_mark(c.s, (const void *const[]){&c.head}, 1, NULL);
				sc_pulse(c.s);
			}
			double t = (now() - t0) / 200;
			if (round >= 0 && t < best) best = t;
		}
		printf("\t%s %.2f", ways[w], best);
		pl_crowify_stop(wired);
		sc_free(c.s);
		op_free(c.head.value);
		cr_free(u);
	}
	printf(" µs\n");
}

int main(void) {
	static char buffers[1000][16];
	for (int i = 0; i < 1000; i++) {
		snprintf(buffers[i], sizeof buffers[i], "name%d", i);
		names[i] = str(buffers[i]);
		char id[16];
		snprintf(id, sizeof id, "id%d", i);
		ids[i] = op_str(id);
		item_paths[i] = malloc(3 * sizeof **item_paths);
		item_paths[i][0] = str("items"), item_paths[i][1] = num(i), item_paths[i][2] = str("done");
	}
	yes = op_bool(1), no = op_bool(0);
	n_key = str("n");
	deep_path[0] = str("a"), deep_path[1] = str("b"), deep_path[2] = str("c");
	deep_path[3] = str("d"), deep_path[4] = str("e"), deep_path[5] = str("f"), deep_path[6] = str("n");
	for (int k = 0; k < 5; k++) {
		snprintf(five_names[k], sizeof five_names[k], "f%d", k * 10);
		five_paths[k] = str(five_names[k]);
	}
	list_path = str("list"), body_path = str("body"), samples_path = str("samples");
	for (int i = 0; i < 1000; i++) {
		one_item[i] = op_list();
		op_push(one_item[i], op_num(i));
		double d = i;
		one_sample[i] = op_typed(OP_FLOAT64, &d, 1);
	}
	one_char = op_str("a");
	row r1000 = {folder_1000, rename_, 1}, r30k = {folder_30k, rename_, 1}, rdoc = {doc, field, 1},
		ritems = {items, done, 1}, rdeep = {deep, deep_field, 1}, rfive = {doc, five, 5},
		rlist = {list_10k, append, 1}, rtext = {text_10k, type, 1}, rfloats = {floats, sample, 1};
	measure("a name in a folder of 1000, a burst", &r1000, 0, 1000);
	measure("a name in a folder of 1000, read between", &r1000, 1, 1000);
	measure("a name in a folder of 30k, a burst", &r30k, 0, 20);
	measure("a field of a 52-field doc, a burst", &rdoc, 0, 10000);
	measure("a field of a 52-field doc, read between", &rdoc, 1, 10000);
	measure("an item's field in a list of 1000, a burst", &ritems, 0, 10000);
	measure("an item's field in a list of 1000, read between", &ritems, 1, 10000);
	measure("a field six maps down, a burst", &rdeep, 0, 10000);
	measure("a field six maps down, read between", &rdeep, 1, 10000);
	measure("five fields of a 52-field doc in one write, a burst", &rfive, 0, 10000);
	measure("append to a list of 10k, a burst", &rlist, 0, 300);
	measure("append to a list of 10k, read between", &rlist, 1, 300);
	measure("typing into a 10k string, a burst", &rtext, 0, 2000);
	measure("one sample of a 10k Float64Array, a burst", &rfloats, 0, 2000);
	measure("one sample of a 10k Float64Array, read between", &rfloats, 1, 2000);
	first_writes();
	kept_rows();
	chain_row();
	return 0;
}
