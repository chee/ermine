// patch nodes (patch.h) on what patch_bench.ts measures, row for row: µs per call, medians of up to
// 21 rounds (or as many past 5 as fit in two seconds). N is a clock face of 50 fields and a theme;
// each patch node over it sets theme.accent. "bare": no overlay, places reads the table itself. A
// write's header is made once (a site's capture is not what this measures). names given: only the
// rows whose name holds one.
//   make playground/patch-nodes/c/patch-bench && playground/patch-nodes/c/patch-bench [name...]
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "patch.h"

static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e6 + (double)t.tv_nsec / 1e3;
}
static int order(const void *a, const void *b) {
	double x = *(const double *)a, y = *(const double *)b;
	return x < y ? -1 : x > y;
}

static int nonly;
static char **only;
static const void *sink;
static long n_written;

// the world -------------------------------------------------------------------------------------

typedef struct {
	long runs;
	op_value *value;
} watch;

typedef struct {
	int bare;
	sc_scheduler *s;
	pn *o;
	tb_table *table, *view;
	pt_paths *paths;
	pl *places;
	sc_scope *host;
	sc_pair host_info;
	ch_header made_header;
	pl_made *made;
	int64_t time;
	nd_entry **nodes;
	size_t nnodes, capnodes;
	char **ids;
	size_t nids, capids;
} world;

// patches of writes: the entry's change refers to them until its next update, so a ring of slots,
// each let go of when it comes round again
enum { SLOTS = 8 };
static struct {
	op_key path[3];
	op_patch patch;
	op_value *value;
} slots[SLOTS];
static size_t slot;

static void keep_node(world *w, nd_entry *node) {
	if (w->nnodes == w->capnodes) {
		w->capnodes = w->capnodes ? w->capnodes * 2 : 64;
		w->nodes = realloc(w->nodes, w->capnodes * sizeof *w->nodes);
		if (w->nodes == NULL) abort();
	}
	w->nodes[w->nnodes++] = node;
}
static const char *keep_id(world *w, const char *s) {
	if (w->nids == w->capids) {
		w->capids = w->capids ? w->capids * 2 : 64;
		w->ids = realloc(w->ids, w->capids * sizeof *w->ids);
		if (w->ids == NULL) abort();
	}
	return w->ids[w->nids++] = strcpy(malloc(strlen(s) + 1), s);
}

static void world_drop(void *value, void *data) {
	(void)data;
	op_free(value);
}
typedef struct {
	world *w;
	watch r;
} reader;
static char *reader_set(void *value, void *data) {
	watch *r = &((reader *)data)->r;
	op_value *was = r->value;
	r->value = op_ref(value);
	op_free(was);
	return NULL;
}
static bool reader_equal(const void *a, const void *b, void *data) {
	(void)data;
	const op_value *x = a, *y = b;
	if (x->type == OP_STR && y->type == OP_STR) return strcmp(x->str, y->str) == 0;
	return a == b;
}

static void make_header(void *data) {
	world *w = data;
	char *bad = pl_header(w->places, NULL, 0, CH_HERE, &w->made_header, &w->made);
	if (bad) abort();
}

static world *world_new(int bare) {
	world *w = calloc(1, sizeof *w);
	if (w == NULL) abort();
	w->bare = bare;
	w->places = pl_new();
	w->s = sc_new((sc_options){.drop = world_drop});
	sc_on_tracking_end(w->s, pl_forget, w->places);
	if (bare) {
		w->table = tb_make(pl_event, w->places);
		w->view = w->table;
	} else {
		w->o = pn_new();
		w->table = tb_make(pn_event, w->o);
		w->view = tb_make(pn_view_event, w->o);
		pn_connect(w->o, w->table, w->view, w->places);
	}
	w->paths = pt_new();
	pl_connect(w->places, &(pl_setup){.root = tb_string("R"), .table = w->view, .paths = w->paths,
		.scheduler = w->s});
	w->host_info = (sc_pair){"actor", op_str("host")};
	w->host = sc_create_root_scope(w->s, &w->host_info, 1);
	if (sc_run_with_scope(w->host, make_header, w)) abort();
	w->time = w->made_header.time;
	return w;
}

static void world_free(world *w) {
	sc_free(w->s);
	tb_free(w->table);
	if (!w->bare) {
		pn_free(w->o);
		tb_free(w->view);
	}
	pt_free(w->paths);
	pl_free(w->places);
	pl_made_free(w->made);
	op_free((op_value *)w->host_info.value);
	for (size_t i = 0; i < w->nnodes; i++) nd_free_entry(w->nodes[i]);
	for (size_t i = 0; i < w->nids; i++) free(w->ids[i]);
	free(w->nodes);
	free(w->ids);
	free(w);
}

// the header of the next write: the one made, its time bumped; its block held by the node
static ch_header header(world *w) {
	ch_header h = w->made_header;
	h.time = ++w->time;
	return h;
}
static void hold(world *w, nd_entry *node) { pl_hold(w->places, node, pl_made_ref(w->made), pl_made_free); }

// a node of the value given, its header made once: added to the table (a table event tells)
static void put(world *w, const char *part, const char *id, op_value *value) {
	ch_header h = header(w);
	nd_entry *node = nd_make_entry(value, &h, NULL);
	hold(w, node);
	keep_node(w, node);
	tb_sub(w->table, tb_string(part), tb_string(keep_id(w, id)), node);
	op_free(value);
}

static op_value *strs(const char *a, const char *b) {
	op_value *l = op_list();
	op_push(l, op_str(a));
	op_push(l, op_str(b));
	return l;
}

static void put_face(world *w) {
	op_value *face = op_map(), *theme = op_map();
	op_set(theme, "accent", op_str("lemon"));
	op_set(theme, "font", op_str("chicago"));
	op_set(face, "theme", theme);
	op_set(face, "n", op_num(0));
	for (int i = 0; i < 50; i++) {
		char k[16], v[16];
		snprintf(k, sizeof k, "f%d", i);
		snprintf(v, sizeof v, "field %d", i);
		op_set(face, k, op_str(v));
	}
	put(w, "value", "N", face);
}

// patch node p over on, setting theme.accent
static void patch_on(world *w, const char *p, const char *on) {
	op_value *v = op_map(), *one = op_map(), *list = op_list();
	op_set(v, "on", op_str(on));
	op_set(v, "part", op_str("value"));
	op_set(v, "at", op_num((double)w->time));
	op_set(one, "path", strs("theme", "accent"));
	op_set(one, "value", op_str(p));
	op_push(list, one);
	op_set(v, "patches", list);
	put(w, "patch", p, v);
}
static void patch(world *w, const char *p) { patch_on(w, p, "N"); }

// the patches to the entry there, said: path (up to 3 keys, strings or an index), value taken
static void edit(world *w, const char *part, const char *id, const op_key *path, size_t length,
	op_value *value) {
	slot = (slot + 1) % SLOTS;
	op_free(slots[slot].value);
	slots[slot].value = value;
	memcpy(slots[slot].path, path, length * sizeof *path);
	slots[slot].patch = (op_patch){.place = {slots[slot].path, length, 0, 0, 0}, .has_value = 1,
		.value = value};
	nd_entry *node = tb_get(w->table, tb_string(part), tb_string(id));
	size_t failed;
	if (nd_update(node, &slots[slot].patch, 1, header(w), &failed) != OP_OK) abort();
	pl_changed changed = {1, {node}};
	if (w->bare) pl_commit(w->places, &changed);
	else pn_commit(w->o, &changed);
	hold(w, node);
}
static void write_n(world *w) {
	op_key path[1] = {{.type = OP_STR_KEY, .s = "n"}};
	edit(w, "value", "N", path, 1, op_num((double)++n_written));
}
static void drag(world *w) {
	char c[32];
	snprintf(c, sizeof c, "c%ld", n_written++);
	op_key path[3] = {{.type = OP_STR_KEY, .s = "patches"}, {.type = OP_NUM_KEY, .n = 0},
		{.type = OP_STR_KEY, .s = "value"}};
	edit(w, "patch", "P", path, 3, op_str(c));
}
static const void *get(world *w) { return tb_get(w->view, tb_string("value"), tb_string("N")); }

// a compute reading N at path, its runs counted
static const char *const accent[] = {"theme", "accent"};
static sc_out reader_f(void *previous, void *data) {
	(void)previous;
	reader *x = data;
	x->r.runs++;
	op_key path[2] = {{.type = OP_STR_KEY, .s = accent[0]}, {.type = OP_STR_KEY, .s = accent[1]}};
	const op_value *v = pl_read(x->w->places, tb_string("value"), tb_string("N"), path, 2);
	if (pl_status(x->w->places) == SC_STOP) return (sc_out){.kind = SC_VALUE};
	return (sc_out){.kind = SC_VALUE, .value = v ? op_ref((op_value *)v) : NULL};
}
typedef struct {
	world *w;
	reader *x;
	sc_scope *scope;
	sc_pair info;
} making;
static void make_reader(void *data) {
	making *m = data;
	sc_create_computer(m->w->s, (sc_def){.f = reader_f, .set = reader_set, .equal = reader_equal,
		.data = m->x});
}
static reader *watch_accent(world *w) {
	reader *x = calloc(1, sizeof *x);
	x->w = w;
	making m = {.w = w, .x = x, .info = {"actor", op_str("reader")}};
	m.scope = sc_create_root_scope(w->s, &m.info, 1);
	if (sc_run_with_scope(m.scope, make_reader, &m)) abort();
	sc_pulse(w->s);
	return x;
}
static void reader_free(reader *x) {
	op_free(x->r.value);
	free(x);
}

// rows ------------------------------------------------------------------------------------------

static world *cur;
static reader *noted;
static long wcalls, before;
typedef void (*fn)(void);

static void row(const char *name, fn f, int calls, int note) {
	if (nonly) {
		int hit = 0;
		for (int i = 0; i < nonly; i++) hit |= strstr(name, only[i]) != NULL;
		if (!hit) return;
	}
	if (note) wcalls = 0, before = noted->r.runs;
	for (int i = 0; i < calls; i++) f();
	if (note) wcalls = 0, before = noted->r.runs;
	double times[21];
	int rounds = 0;
	double start = now();
	for (int r = 0; r < 21; r++) {
		double t0 = now();
		for (int i = 0; i < calls; i++) f();
		times[rounds++] = (now() - t0) / calls;
		if (r >= 4 && now() - start > 2e6) break;
	}
	qsort(times, (size_t)rounds, sizeof *times, order);
	printf("%s\t%.3f µs", name, times[rounds >> 1]);
	if (note) printf("\t%.2f runs/write", (double)(noted->r.runs - before) / (double)wcalls);
	printf("\n");
	fflush(stdout);
}

static void f_get(void) { sink = get(cur); }
static void f_write(void) { write_n(cur), sink = get(cur); }
static void f_inout(void) {
	patch(cur, "Q");
	sink = get(cur);
	tb_del(cur->table, tb_string("patch"), tb_string("Q"));
	sink = get(cur);
}
static void f_read_write(void) { wcalls++, write_n(cur), sc_pulse(cur->s); }
static void f_read_drag(void) { wcalls++, drag(cur), sc_pulse(cur->s); }

static void many(world *w, int k, int over_others) {
	for (int i = 0; i < k; i++) {
		char p[16], t[16];
		snprintf(p, sizeof p, "P%d", i);
		snprintf(t, sizeof t, "T%d", i);
		if (over_others) patch_on(w, p, t);
		else patch(w, p);
	}
}
static world *fresh(int bare) {
	world *w = world_new(bare);
	put_face(w);
	return w;
}

int main(int argc, char **argv) {
	only = argv + 1;
	nonly = argc - 1;
	char name[128];

	// reads: get("value", N), nothing changed since the last
	cur = fresh(1);
	row("get, bare", f_get, 100000, 0);
	world_free(cur);
	cur = fresh(0);
	row("get, no patch nodes", f_get, 100000, 0);
	many(cur, 1000, 1);
	row("get, 1000 patch nodes over others", f_get, 100000, 0);
	world_free(cur);
	static const int ks[] = {1, 10, 100};
	for (int j = 0; j < 3; j++) {
		cur = fresh(0);
		many(cur, ks[j], 0);
		snprintf(name, sizeof name, "get, %d patch nodes over it", ks[j]);
		row(name, f_get, 100000, 0);
		world_free(cur);
	}

	// writes: one field of N, said, then a get (where the overlay makes its entry again)
	cur = fresh(1);
	row("write, bare", f_write, 2000, 0);
	world_free(cur);
	cur = fresh(0);
	row("write, no patch nodes", f_write, 2000, 0);
	many(cur, 1000, 1);
	row("write, 1000 patch nodes over others", f_write, 2000, 0);
	world_free(cur);
	for (int j = 0; j < 3; j++) {
		cur = fresh(0);
		many(cur, ks[j], 0);
		snprintf(name, sizeof name, "write, %d patch nodes over it", ks[j]);
		row(name, f_write, ks[j] == 100 ? 200 : 2000, 0);
		world_free(cur);
	}

	// a patch node put over N and taken out, a get after each
	static const int others[] = {0, 10, 100};
	for (int j = 0; j < 3; j++) {
		cur = fresh(0);
		many(cur, others[j], 0);
		snprintf(name, sizeof name, "patch node in and out, %d others over it", others[j]);
		row(name, f_inout, others[j] == 100 ? 200 : 2000, 0);
		world_free(cur);
	}

	// a reader of theme.accent; a write to n, or to the patch node's colour (a drag), then a pulse.
	// runs: how many times the reader ran per write
	static const char *const names[] = {"bare", "no patch nodes", "1 patch node"};
	for (int j = 0; j < 3; j++) {
		cur = fresh(j == 0);
		if (j == 2) patch(cur, "P");
		noted = watch_accent(cur);
		snprintf(name, sizeof name, "write n + pulse, reader of theme.accent, %s", names[j]);
		row(name, f_read_write, 2000, 1);
		reader_free(noted);
		world_free(cur);
	}
	cur = fresh(0);
	patch(cur, "P");
	noted = watch_accent(cur);
	row("drag the patch node's colour + pulse, reader of theme.accent", f_read_drag, 2000, 1);
	reader_free(noted);
	world_free(cur);

	if (sink == &n_written) puts("never");
	return 0;
}
