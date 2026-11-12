// Tests that the C places still tells the functions after a pl_watch_all function that writes
// what landed, whole, though the write let go of it, and the answerers (as answerers_test.ts).
// Exits 1 at the first failure. Run under the sanitizers to check the frees.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "children.h"
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
static const pl_contributor *const walk[] = {&pl_children};
static nd_entry *kids, *thing;

typedef struct {
	op_patch patch;
	op_value *two;
} rewrite;
static void rewrite_free(void *b) {
	rewrite *r = b;
	op_free(r->two);
	free(r);
}

static int writes;
static void writer(const pl_fact *fact, void *ctx) {
	(void)fact;
	(void)ctx;
	if (writes++) return;
	pl_changed changed;
	if (ctx == NULL) {
		CHECK(pl_place(p, kids, "b", tb_string("B"), (ch_header){0}, &changed) == 0);
	} else {
		rewrite *r = malloc(sizeof *r);
		CHECK(r != NULL);
		r->two = op_num(2);
		r->patch = (op_patch){.has_value = 1, .value = r->two};
		size_t failed;
		CHECK(nd_update(thing, &r->patch, 1, (ch_header){0}, &failed) == OP_OK);
		pl_hold(p, thing, r, rewrite_free);
		changed = (pl_changed){1, {thing}};
	}
	pl_commit(p, &changed);
}

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
	table = tb_new();
	*paths = pt_new();
	pl_connect(p, &(pl_setup){.root = tb_string("R"), .table = table, .paths = *paths, .scheduler = *s,
		.contributors = walk, .ncontributors = 1});
	kids = nd_make_entry(NULL, NULL);
	pl_own(p, kids);
	pl_add(p, tb_string("children"), tb_string("R"), kids);
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

// Answerers. A holder answers reads for one (part, id): its items at the root path, or the one
// under a first key it has; it counts how often it is asked.
typedef struct {
	const char *part, *id;
	const op_value *items[3];
	int gone[3];
	size_t n;
	const op_value *from;
	const char *key;
	const op_value *at_key;
	int asked;
} holder;
static void hold_read(void *ctx, tb_key part, tb_key id, const op_key *path, size_t n,
	pl_versions *out) {
	holder *h = ctx;
	h->asked++;
	if (strcmp(part.string, h->part) != 0 || id.string == NULL || strcmp(id.string, h->id) != 0) return;
	if (n == 1 && h->key != NULL && path[0].type == OP_STR_KEY && strcmp(path[0].s, h->key) == 0) {
		pl_versions_add(out, (pl_version){h->at_key, 0, NULL});
		return;
	}
	if (n != 0) return;
	for (size_t i = 0; i < h->n; i++) {
		pl_versions_add(out, (pl_version){h->items[i], h->gone[i], h->from});
	}
}

static const void *marked[8];
static size_t nmarked;
static void on_mark(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data) {
	(void)run, (void)due, (void)ndue, (void)tick, (void)data;
	for (size_t i = 0; i < nkeys && nmarked < 8; i++) marked[nmarked++] = keys[i];
}
static int was_marked(const void *key) {
	for (size_t i = 0; i < nmarked; i++) {
		if (marked[i] == key) return 1;
	}
	return 0;
}

static int facts;
static void count_fact(const pl_fact *fact, void *ctx) {
	(void)fact, (void)ctx;
	facts++;
}

typedef struct {
	tb_key part, id;
	const op_key *path;
	size_t n;
} reading;
static void read_it(void *ctx) {
	reading *r = ctx;
	pl_read(p, r->part, r->id, r->path, r->n);
}

static sc_scheduler *as;
static pt_paths *apaths;
static void answering(const pl_contributor *const *list, size_t n) {
	p = pl_new();
	as = sc_new((sc_options){0});
	sc_on_tracking_end(as, pl_forget, p);
	table = tb_new();
	apaths = pt_new();
	pl_connect(p, &(pl_setup){.root = tb_string("R"), .table = table, .paths = apaths, .scheduler = as,
		.contributors = list, .ncontributors = n});
}
static void put(const char *id, op_value *v) {
	nd_entry *e = nd_make_entry(v, NULL);
	op_free(v);
	pl_own(p, e);
	pl_add(p, tb_string("value"), tb_string(id), e);
}
static const op_value *value_of(const char *id) {
	return pl_read(p, tb_string("value"), tb_string(id), NULL, 0);
}
static int is_str(const op_value *v, const char *want) {
	return v != NULL && v->type == OP_STR && strcmp(v->str, want) == 0;
}

static void answerers(void) {
	op_value *older = op_str("older"), *oldest = op_str("oldest"), *draft = op_str("draft");
	op_value *heads = op_map(), *title = op_str("h\xc3\xa9llo");
	op_set(heads, "heads", op_num(1));

	// none reads: pl_read_all is the table's one item, with its entry's change, by children
	answering(walk, 1);
	pl_showns all = pl_read_all(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(all.n == 0);
	pl_showns_free(&all);
	put("n", op_str("now"));
	all = pl_read_all(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(all.n == 1 && is_str(all.items[0].value, "now") && !all.items[0].gone);
	CHECK(strcmp(all.items[0].by, "children") == 0 && all.items[0].from == NULL);
	CHECK(all.items[0].change == pl_change(p, tb_string("value"), tb_string("n")));
	pl_showns_free(&all);
	teardown(as, apaths);

	// one behind the table: its items come after the table's in pl_read_all, with its from and
	// name; pl_read never asks it, so a node the table has nothing for reads as nothing
	holder history = {.part = "value", .id = "n", .items = {older, oldest}, .n = 2, .from = heads};
	const pl_contributor behind = {.from = "history", .read = hold_read, .ctx = &history};
	const pl_contributor *const after[] = {&pl_children, &behind};
	answering(after, 2);
	CHECK(value_of("n") == NULL);
	op_value *cut = NULL;
	CHECK(pl_read_range(p, tb_string("value"), tb_string("n"), NULL, 0, 0, 0, &cut) == OP_OK);
	CHECK(cut == NULL && history.asked == 0);
	all = pl_read_all(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(all.n == 2 && is_str(all.items[0].value, "older") && history.asked == 1);
	pl_showns_free(&all);
	put("n", op_str("now"));
	CHECK(is_str(value_of("n"), "now") && history.asked == 1);
	all = pl_read_all(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(all.n == 3 && is_str(all.items[0].value, "now") && is_str(all.items[2].value, "oldest"));
	CHECK(strcmp(all.items[0].by, "children") == 0 && strcmp(all.items[1].by, "history") == 0);
	CHECK(all.items[1].from == heads && all.items[1].change == NULL && all.items[0].change != NULL);
	pl_showns_free(&all);
	// a walk and a listing pass one with no step and no names
	tb_key got;
	CHECK(pl_get(p, (const char *const[]){"a"}, 1, &got) == 0);
	pl_members names = pl_list(p, NULL, 0);
	CHECK(names.n == 0);
	pl_members_free(&names);
	teardown(as, apaths);

	// one in front of the table is read first; nothing from it looks through; gone hides the table
	holder overlay = {.part = "value", .id = "n", .items = {draft}, .n = 1, .key = "title",
		.at_key = title};
	holder second = {.part = "value", .id = "n", .items = {older}, .n = 1};
	const pl_contributor over = {.from = "overlay", .read = hold_read, .ctx = &overlay};
	const pl_contributor under = {.from = "second", .read = hold_read, .ctx = &second};
	const pl_contributor *const before[] = {&over, &under, &pl_children};
	answering(before, 3);
	put("n", op_str("saved"));
	put("m", op_str("kept"));
	CHECK(is_str(value_of("n"), "draft") && second.asked == 0);
	CHECK(is_str(value_of("m"), "kept") && second.asked == 1);
	all = pl_read_all(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(all.n == 3 && is_str(all.items[0].value, "draft") && is_str(all.items[2].value, "saved"));
	CHECK(strcmp(all.items[0].by, "overlay") == 0 && strcmp(all.items[2].by, "children") == 0);
	pl_showns_free(&all);
	// it is asked with the path, and a range is cut from the front value (code points)
	op_key at_title = {.type = OP_STR_KEY, .s = "title"};
	CHECK(pl_read(p, tb_string("value"), tb_string("n"), &at_title, 1) == title);
	CHECK(pl_read_range(p, tb_string("value"), tb_string("n"), &at_title, 1, 1, 3, &cut) == OP_OK);
	CHECK(is_str(cut, "\xc3\xa9l"));
	op_free(cut);
	overlay.gone[0] = 1;
	CHECK(value_of("n") == NULL);
	all = pl_read_all(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(all.n == 3 && all.items[0].gone && all.items[0].value == NULL);
	pl_showns_free(&all);
	overlay.gone[0] = 0;

	// pl_moved marks the spot a read of it tracked, and tells no watch; with a patch, only the
	// spots the patch touches
	pl_watch_all(p, count_fact, NULL);
	sc_on_mark(as, on_mark, NULL);
	pl_set whole = {0}, titled = {0};
	reading r = {tb_string("value"), tb_string("n"), NULL, 0};
	pl_record(p, read_it, &r, &whole, NULL);
	r = (reading){tb_string("value"), tb_string("n"), &at_title, 1};
	pl_record(p, read_it, &r, &titled, NULL);
	CHECK(whole.n == 1 && titled.n == 1);
	facts = 0, nmarked = 0;
	pl_moved(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(was_marked(whole.items[0]) && was_marked(titled.items[0]) && facts == 0);
	nmarked = 0;
	op_key body = {.type = OP_STR_KEY, .s = "body"};
	op_patch patch = {.place = {.path = &body, .length = 1}, .has_value = 1, .value = draft};
	pl_moved(p, tb_string("value"), tb_string("n"), &patch, 1);
	CHECK(was_marked(whole.items[0]) && !was_marked(titled.items[0]) && facts == 0);
	pl_set_free(&whole);
	pl_set_free(&titled);
	teardown(as, apaths);

	// none marked stored: the table is last, and its item is by "table"
	const pl_contributor *const unmarked[] = {&over};
	answering(unmarked, 1);
	put("n", op_str("saved"));
	all = pl_read_all(p, tb_string("value"), tb_string("n"), NULL, 0);
	CHECK(all.n == 2 && is_str(all.items[0].value, "draft") && strcmp(all.items[1].by, "table") == 0);
	pl_showns_free(&all);
	teardown(as, apaths);

	op_free(older), op_free(oldest), op_free(draft), op_free(heads), op_free(title);
}

int main(void) {
	sc_scheduler *s;
	pt_paths *paths;

	// a commit: the reader is told the place of "a" though the writer's place of "b" let go of its patches
	setup(NULL, &s, &paths);
	pl_changed changed;
	CHECK(pl_place(p, kids, "a", tb_string("A"), (ch_header){0}, &changed) == 0);
	pl_commit(p, &changed);
	CHECK(writes == 2 && told == 2);
	CHECK(strcmp(name, "a") == 0);
	teardown(s, paths);

	// a table event: the reader is told the value added, 1, though the writer's write of 2 replaced it
	setup((void *)1, &s, &paths);
	op_value *one = op_num(1);
	thing = nd_make_entry(one, NULL);
	op_free(one);
	pl_own(p, thing);
	pl_add(p, tb_string("value"), tb_string("T"), thing);
	CHECK(writes == 2 && told == 2);
	CHECK(number == 1);
	teardown(s, paths);

	answerers();
	return 0;
}
