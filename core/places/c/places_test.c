// the C places when a watch writes (places.h: "A watch that writes commits in turn, in the same
// run"): the watches after it are still told what landed first, whole, though the write let go of
// it. exits 1 at the first thing that is not so. run under the sanitizers for the frees
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "places.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static pl *p;
static tb_table *table;
static nd_entry *kids, *thing;

// the first watch: told the first fact, it writes the same entry again, and commits
static int writes;
static void writer(const pl_fact *fact, void *ctx) {
	(void)fact;
	(void)ctx;
	if (writes++) return;
	pl_changed changed;
	if (ctx == NULL) {
		CHECK(pl_place(p, kids, "b", tb_string("B"), (ch_header){0}, &changed) == 0);
	} else {
		op_value *two = op_num(2);
		CHECK(pl_upsert(p, tb_string("value"), tb_string("T"), NULL, 0, two, (ch_header){0}, &changed, NULL) == 0);
		op_free(two);
	}
	pl_commit(p, &changed);
}

// the second watch: how many facts it is told, and the last one's last patch (the writer's commit
// is told it first, then the fact the writer was told)
static int told;
static char name[8];
static double number;
static void reader(const pl_fact *fact, void *ctx) {
	(void)ctx;
	told++;
	CHECK(fact->patches_length >= 1);
	const op_patch *last = &fact->patches[fact->patches_length - 1];
	if (last->place.length == 1 && last->place.path[0].type == OP_STR_KEY) {
		snprintf(name, sizeof name, "%s", last->place.path[0].s);
	}
	if (last->has_value && last->value->type == OP_NUM) number = last->value->num;
}

static void setup(void *ctx, sc_scheduler **s, pt_paths **paths) {
	p = pl_new();
	*s = sc_new((sc_options){0});
	sc_on_tracking_end(*s, pl_forget, p);
	table = tb_make(pl_event, p);
	*paths = pt_new();
	pl_connect(p, &(pl_setup){.root = tb_string("R"), .table = table, .paths = *paths, .scheduler = *s});
	kids = nd_make_entry(NULL, NULL);
	pl_own(p, kids);
	tb_add(table, tb_string("children"), tb_string("R"), kids);
	pl_watch_all(p, writer, ctx);
	pl_watch_all(p, reader, NULL);
	writes = told = 0;
	name[0] = 0;
	number = 0;
}

static void teardown(sc_scheduler *s, pt_paths *paths) {
	pl_free(p);
	tb_free(table);
	pt_free(paths);
	sc_free(s);
}

int main(void) {
	sc_scheduler *s;
	pt_paths *paths;

	// a commit: the reader is told the place of "a", though the writer's place of "b" let go of
	// the patches that made it
	setup(NULL, &s, &paths);
	pl_changed changed;
	CHECK(pl_place(p, kids, "a", tb_string("A"), (ch_header){0}, &changed) == 0);
	pl_commit(p, &changed);
	CHECK(writes == 2 && told == 2);
	CHECK(strcmp(name, "a") == 0);
	teardown(s, paths);

	// a table event: the reader is told the value added, 1, though the writer's upsert of 2
	// replaced it
	setup((void *)1, &s, &paths);
	op_value *one = op_num(1);
	thing = nd_make_entry(one, NULL);
	op_free(one);
	pl_own(p, thing);
	tb_add(table, tb_string("value"), tb_string("T"), thing);
	CHECK(writes == 2 && told == 2);
	CHECK(number == 1);
	teardown(s, paths);
	return 0;
}
