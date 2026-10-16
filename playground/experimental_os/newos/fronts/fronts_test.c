// fronts_test.c: the fronts contributor (fronts.h) on today's places, scheduler and table: what a walk, a get,
// gets, a list and fr_members answer as fronts come and go, that a run reading a name runs again when they
// do, and what is refused. sh test.sh builds and runs it.
#include "fronts.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
#define CHECK(c, ...) \
	do { \
		if (!(c)) { \
			failures++; \
			fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
			fprintf(stderr, __VA_ARGS__); \
			fputc('\n', stderr); \
		} \
	} while (0)

static sc_scheduler *s;
static tb_table *table;
static pl *p;
static sc_scope *host;
static fr_fronts fronts;

// a write: a header made with the host's scope open, the write, its commit
typedef struct {
	int (*f)(void *ctx, ch_header header, pl_changed *changed, nd_entry **made);
	void *ctx;
	int code;
} Writing;

static void writing(void *data) {
	Writing *w = data;
	ch_header h;
	pl_made *made;
	char *e = pl_header(p, NULL, 0, CH_HERE, &h, &made);
	if (e) {
		fprintf(stderr, "header: %s\n", e);
		abort();
	}
	pl_changed changed = {0};
	nd_entry *node = NULL;
	w->code = w->f(w->ctx, h, &changed, &node);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(p, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (node) pl_hold_also(p, node, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
	pl_commit(p, &changed);
}

static int write_as_host(int (*f)(void *, ch_header, pl_changed *, nd_entry **), void *ctx) {
	Writing w = {f, ctx, 0};
	sc_run_with_scope(host, writing, &w);
	sc_pulse(s);
	return w.code;
}

// a node: its children entry, placed at name under parent's children
typedef struct {
	const char *parent, *name, *id;
} Making;

static int making(void *ctx, ch_header h, pl_changed *changed, nd_entry **made) {
	Making *m = ctx;
	op_value *kids = op_map();
	nd_entry *e = nd_make_entry(kids, &h, &(nd_entry_options){.in_place = 1});
	op_free(kids);
	pl_own(p, e);
	tb_add(table, tb_string("children"), tb_string(m->id), e);
	*made = e;
	if (!m->name) return 0;
	return pl_place(p, tb_get(table, tb_string("children"), tb_string(m->parent)), m->name, tb_string(m->id), h, changed);
}

static void node(const char *parent, const char *name, const char *id) {
	Making m = {parent, name, id};
	int code = write_as_host(making, &m);
	if (code) {
		fprintf(stderr, "make %s: %s\n", id, pl_code_name(code));
		abort();
	}
}

typedef struct {
	const char *parent, *name, *id;
	long at;
	int out;
} Fronting;

static int adding(void *ctx, ch_header h, pl_changed *changed, nd_entry **made) {
	Fronting *f = ctx;
	return fr_add(p, table, FR_PART, tb_string(f->parent), f->name, tb_string(f->id), f->at, h, changed, made);
}

static int removing(void *ctx, ch_header h, pl_changed *changed, nd_entry **made) {
	Fronting *f = ctx;
	*made = NULL;
	return fr_remove(p, table, FR_PART, tb_string(f->parent), f->name, tb_string(f->id), h, changed);
}

static int add(const char *parent, const char *name, const char *id, long at) {
	Fronting f = {parent, name, id, at, 0};
	return write_as_host(adding, &f);
}

static int take(const char *parent, const char *name, const char *id) {
	Fronting f = {parent, name, id, 0, 0};
	return write_as_host(removing, &f);
}

// the id at a path from the root, read outside a run; "" for none
static const char *at(const char *const *path, size_t n) {
	tb_key id;
	return pl_get(p, path, n, &id) ? id.string : "";
}

// every answer at a path, as "id/from id/from"
static char answers[512];
static const char *answersAt(const char *const *path, size_t n) {
	pl_answers all = pl_gets(p, path, n);
	answers[0] = 0;
	for (size_t i = 0; i < all.n; i++)
		snprintf(answers + strlen(answers), sizeof answers - strlen(answers), "%s%s/%s", i ? " " : "", all.items[i].id.string, all.items[i].from);
	pl_answers_free(&all);
	return answers;
}

static char members[512];
static const char *membersOf(const char *parent, const char *name) {
	tb_key out[8];
	size_t n = fr_members(p, FR_PART, tb_string(parent), name, out, 8);
	members[0] = 0;
	for (size_t i = 0; i < n && i < 8; i++) snprintf(members + strlen(members), sizeof members - strlen(members), "%s%s", i ? " " : "", out[i].string);
	return members;
}

static char listed[512];
static const char *list(const char *const *path, size_t n) {
	pl_members all = pl_list(p, path, n);
	listed[0] = 0;
	for (size_t i = 0; i < all.n; i++) snprintf(listed + strlen(listed), sizeof listed - strlen(listed), "%s%s", i ? " " : "", all.items[i].name);
	pl_members_free(&all);
	return listed;
}

// a compute reading the id at R/client: each run kept
static int runs;
static char seen[64];
static sc_out reading(void *previous, void *data) {
	(void)previous;
	(void)data;
	runs++;
	const char *path[] = {"client"};
	tb_key id;
	snprintf(seen, sizeof seen, "%s", pl_get(p, path, 1, &id) ? id.string : "");
	return (sc_out){.kind = SC_VALUE};
}

// a compute's result set somewhere: here, nowhere
static char *kept(void *value, void *data) {
	(void)value;
	(void)data;
	return NULL;
}

static void watch(void *data) {
	(void)data;
	sc_create_computer(s, (sc_def){.f = reading, .set = kept});
}

static void drop(void *value, void *data) {
	(void)value;
	(void)data;
}

int main(void) {
	p = pl_new();
	s = sc_new((sc_options){.drop = drop});
	sc_on_tracking_end(s, pl_forget, p);
	table = tb_make(pl_event, p);
	pt_paths *paths = pt_new();
	fr_init(&fronts, FR_PART);
	const pl_contributor *const order[] = {&fronts.contributor, &pl_children};
	pl_connect(p, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths, .scheduler = s, .contributors = order, .ncontributors = 2});
	sc_pair info = {"actor", op_str("test")};
	host = sc_create_root_scope(s, &info, 1);

	node(NULL, NULL, "R");
	node("R", "client", "doc");
	const char *client[] = {"client"}, *layers[] = {"layers"};
	CHECK(!strcmp(at(client, 1), "doc"), "no fronts: the document (%s)", at(client, 1));

	sc_run_with_scope(host, watch, NULL);
	sc_pulse(s);
	CHECK(runs == 1 && !strcmp(seen, "doc"), "the watch saw the document (%d, %s)", runs, seen);

	// a front: it answers first, the document after it; the reader runs again
	CHECK(add("R", "client", "drag", 0) == 0, "add");
	CHECK(!strcmp(at(client, 1), "drag"), "a front answers first (%s)", at(client, 1));
	CHECK(!strcmp(answersAt(client, 1), "drag/front doc/children"), "gets: %s", answers);
	CHECK(!strcmp(membersOf("R", "client"), "drag doc"), "members: %s", members);
	CHECK(runs == 2 && !strcmp(seen, "drag"), "the watch ran again, saw the front (%d, %s)", runs, seen);

	// a second at the end: the first still answers; one put first: it does
	CHECK(add("R", "client", "edit", -1) == 0, "add at the end");
	CHECK(!strcmp(at(client, 1), "drag"), "the first still answers (%s)", at(client, 1));
	CHECK(!strcmp(membersOf("R", "client"), "drag edit doc"), "members: %s", members);
	CHECK(add("R", "client", "top", 0) == 0, "add first");
	CHECK(!strcmp(membersOf("R", "client"), "top drag edit doc"), "members: %s", members);
	CHECK(!strcmp(seen, "top"), "the watch saw the new first (%s)", seen);

	// refused: a front there already, a name that is none, one not there
	CHECK(add("R", "client", "drag", 0) == PL_ALREADY_THERE, "the same id twice");
	CHECK(add("R", "..", "x", 0) == PL_NOT_A_NAME, "not a name");
	CHECK(take("R", "client", "nobody") == PL_NOTHING_THERE, "not there");

	// taken out: the next answers; the last out, the document again, and the name leaves the part
	CHECK(take("R", "client", "top") == 0, "take");
	CHECK(!strcmp(at(client, 1), "drag"), "next answers (%s)", at(client, 1));
	CHECK(take("R", "client", "drag") == 0 && take("R", "client", "edit") == 0, "take the rest");
	CHECK(!strcmp(at(client, 1), "doc"), "the document again (%s)", at(client, 1));
	CHECK(!strcmp(answersAt(client, 1), "doc/children"), "gets: %s", answers);
	CHECK(!strcmp(seen, "doc"), "the watch saw the document again (%s)", seen);
	const nd_entry *part = tb_get(table, tb_string(FR_PART), tb_string("R"));
	CHECK(part && part->value && op_get(part->value, "client") == NULL, "the name left the part");

	// a name held by an ephemeral alone: listed, answered
	CHECK(add("R", "layers", "win7", 0) == 0, "add alone");
	CHECK(!strcmp(at(layers, 1), "win7"), "alone answers (%s)", at(layers, 1));
	CHECK(!strcmp(list(NULL, 0), "layers client") || !strcmp(list(NULL, 0), "client layers"), "listed: %s", listed);
	CHECK(take("R", "layers", "win7") == 0, "take alone");
	CHECK(!strcmp(at(layers, 1), ""), "gone (%s)", at(layers, 1));
	CHECK(!strcmp(list(NULL, 0), "client"), "listed: %s", listed);

	// a walk from an id (no path): fronts go by the id, so it finds them
	CHECK(add("R", "client", "drag", 0) == 0, "add again");
	pl_member steps[1];
	CHECK(pl_walk(p, tb_string("R"), client, 1, steps) == 1 && !strcmp(steps[0].id.string, "drag") && !strcmp(steps[0].from, "front"),
		"a walk from the id finds the front");

	if (failures) {
		fprintf(stderr, "%d failed\n", failures);
		return 1;
	}
	puts("fronts: all passed");
	return 0;
}
