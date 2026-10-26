// The C processes (processes.h) on the line protocol of typescript/processes_harness.ts, which documents
// it and the programs (conformance/c/harness.h has the loop). Its world is places' (the scheduler, the
// table, the writes: core/places/c/world_harness.h), made with the contributors [processes("R"),
// children]; programs are data, evaluated here as the reference does.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../core/places/c/world_harness.h"
#include "processes.h"
#include "scopes.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static pr_processes rows;
static const pl_contributor *walk[2];

// the rows' contributor, each ask counted (the asked request): its step and names
static size_t steps_asked, names_asked;
static int counted_step(void *ctx, const pl_here *here, const char *name, pl *l, tb_key *out) {
	steps_asked++;
	return rows.contributor.step(ctx, here, name, l, out);
}
static void counted_names(void *ctx, const pl_here *here, pl *l, pl_namelist *out) {
	names_asked++;
	rows.contributor.names(ctx, here, l, out);
}
static pl_contributor counted;
static int begun;
static sn *nodes;

// reads -----------------------------------------------------------------------------------------

static op_value *path_json(const char *const *from, size_t depth, const char *const *names,
	size_t n) {
	op_value *a = op_list();
	for (size_t i = 0; i < depth; i++) op_push(a, op_str(from[i]));
	for (size_t i = 0; i < n; i++) op_push(a, op_str(names[i]));
	return a;
}

// the lookup of names from a path, as JSON: the nearest path, or null
static op_value *lookup_json(const char *const *names, size_t n, const char *const *from,
	size_t nfrom) {
	size_t *depths = world_alloc((nfrom + 1) * sizeof *depths);
	size_t found = pl_lookup(world_places, names, n, from, nfrom, 0, depths);
	op_value *out = found ? path_json(from, depths[0], names, n) : op_null();
	free(depths);
	return out;
}

static op_value *get_json(const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	tb_key id;
	int found = pl_get(world_places, names, n, &id);
	free(names);
	return found ? op_str(id.string) : op_null();
}

static op_value *entries_json(const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	pl_answers list = pl_gets(world_places, names, n);
	free(names);
	op_value *a = op_list();
	for (size_t i = 0; i < list.n; i++) {
		op_value *m = op_map();
		op_set(m, "id", op_str(list.items[i].id.string));
		op_set(m, "from", op_str(list.items[i].from));
		op_push(a, m);
	}
	pl_answers_free(&list);
	return a;
}

static op_value *names_json(const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	pl_members list = pl_list(world_places, names, n);
	free(names);
	op_value *a = op_list();
	for (size_t i = 0; i < list.n; i++) op_push(a, op_str(list.items[i].name));
	pl_members_free(&list);
	return a;
}

static op_value *members_json(const op_value *path) {
	size_t n;
	const char **names = world_address(path, &n);
	pl_members list = pl_members_at(world_places, names, n);
	free(names);
	op_value *a = op_list();
	for (size_t i = 0; i < list.n; i++) {
		op_value *m = op_map();
		op_set(m, "name", op_str(list.items[i].name));
		// a level: no id
		if (list.items[i].id.string != NULL) op_set(m, "id", op_str(list.items[i].id.string));
		if (list.items[i].from) op_set(m, "from", op_str(list.items[i].from));
		op_push(a, m);
	}
	pl_members_free(&list);
	return a;
}

// programs --------------------------------------------------------------------------------------

typedef struct {
	bool stopped;
	char *error;
} ctx;

static op_value *eval(const op_value *e, ctx *c) {
	if (!world_is(e, OP_MAP)) {
		if (!world_is(e, OP_LIST)) return op_ref((op_value *)e);
		op_value *a = op_list();
		for (size_t i = 0; i < e->count; i++) {
			op_value *x = eval(e->items[i], c);
			if (x == NULL) return op_free(a), NULL;
			op_push(a, x);
		}
		return a;
	}
	const op_value *x;
	op_value *out;
	if ((x = op_get(e, "get"))) out = get_json(x);
	else if ((x = op_get(e, "entries"))) out = entries_json(x);
	else if ((x = op_get(e, "names"))) out = names_json(x);
	else if ((x = op_get(e, "members"))) out = members_json(x);
	else if ((x = op_get(e, "lookup"))) {
		size_t n, nfrom;
		const char **names = world_address(x->items[0], &n), **from = world_address(x->items[1], &nfrom);
		out = lookup_json(names, n, from, nfrom);
		free(names), free(from);
	} else {
		if (c->error == NULL) c->error = world_copy("unknown program");
		return NULL;
	}
	if (pl_status(world_places) == SC_STOP) {
		c->stopped = true;
		return op_free(out), NULL;
	}
	return out;
}

typedef struct {
	world_watch watch;
	const op_value *f;
} program;
static program **programs;
static size_t nprograms, capprograms;

static sc_out program_f(void *previous, void *data) {
	(void)previous;
	program *p = data;
	p->watch.runs++;
	ctx c = {0};
	op_value *v = eval(p->f, &c);
	if (c.error) {
		op_free(v);
		return (sc_out){.kind = SC_FAILED, .error = c.error};
	}
	if (c.stopped) {
		op_free(v);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

// writes ----------------------------------------------------------------------------------------

// a start or a stop, made in the host's scope
typedef struct {
	const op_value *request;
	bool stop;
	int code;
	const char *why;
} call;

static void write(void *data) {
	call *c = data;
	const op_value *r = c->request;
	size_t n;
	const char **path = world_address(op_get(r, "path"), &n);
	for (size_t i = 0; i < n; i++) {
		if (path[i] == NULL) path[i] = "";
	}
	ch_header h;
	pl_made *made;
	char *bad = pl_header(world_places, NULL, 0, CH_HERE, &h, &made);
	if (bad) {
		free(bad), free(path);
		c->code = -1, c->why = SC_UNSCOPED;
		return;
	}
	pl_changed changed;
	nd_entry *node = NULL;
	if (c->stop) {
		c->code = pr_remove(world_places, world_table, tb_string("R"), path, n, h, &changed);
	} else {
		const char *id = world_text(op_get(r, "id"));
		c->code = pr_add(world_places, world_table, tb_string("R"), path, n,
			tb_string(id ? id : ""), h, &changed, &node);
	}
	free(path);
	pl_commit(world_places, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(world_places, changed.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (node != NULL) pl_hold(world_places, node, made, pl_made_free);
	else pl_made_free(made);
	if (c->code > 0) c->why = pl_code_name(c->code);
}

// scope nodes: a write of a part's entry at an id, in the host's scope
typedef struct {
	const op_value *request;
	const char *why;
} putting;

static void put(void *data) {
	putting *c = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(world_places, NULL, 0, CH_HERE, &h, &made);
	if (bad) {
		free(bad);
		c->why = SC_UNSCOPED;
		return;
	}
	nd_entry *node = nd_make_entry((op_value *)op_get(c->request, "value"), &h);
	pl_hold(world_places, node, made, pl_made_free);
	world_keep_node(node);
	tb_sub(world_table, tb_string(world_part(op_get(c->request, "part"))),
		world_key(op_get(c->request, "id")), node);
}

static int part_order(const void *a, const void *b) {
	return strcmp(*(const char *const *)a, *(const char *const *)b);
}

static op_value *id_answer(const char *id) {
	op_value *o = op_map();
	if (id != NULL) op_set(o, "id", op_str(id));
	return o;
}

// requests --------------------------------------------------------------------------------------

static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (strcmp(op, "start") == 0 || strcmp(op, "stop") == 0) {
		call c = {.request = r, .stop = op[2] == 'o'};
		world_hosted(write, &c);
		return c.code ? world_error(c.why) : op_map();
	}
	if (strcmp(op, "rows") == 0) {
		const nd_entry *node = tb_get(world_table, tb_string(PR_PART), tb_string("R"));
		op_value *o = op_map();
		if (node != NULL && node->value != NULL) op_set(o, "value", world_snap(node->value));
		return o;
	}
	if (strcmp(op, "asked") == 0) {
		op_value *o = op_map();
		op_set(o, "steps", op_num((double)steps_asked));
		op_set(o, "names", op_num((double)names_asked));
		steps_asked = names_asked = 0;
		return o;
	}
	if (strcmp(op, "patches") == 0) {
		const nd_entry *node = tb_get(world_table, tb_string(PR_PART), tb_string("R"));
		op_value *o = op_map();
		if (node != NULL && node->change.has_op) {
			op_set(o, "patches", world_patches(node->change.patches, node->change.patches_length));
		}
		return o;
	}
	if (strcmp(op, "get") == 0) {
		op_value *id = get_json(op_get(r, "path"));
		pl_status(world_places);
		op_value *o = op_map();
		if (id->type == OP_NULL) op_free(id);
		else op_set(o, "id", id);
		return o;
	}
	if (strcmp(op, "entries") == 0 || strcmp(op, "members") == 0) {
		bool entries = op[0] == 'e';
		op_value *list = entries ? entries_json(op_get(r, "path")) : members_json(op_get(r, "at"));
		pl_status(world_places);
		op_value *o = op_map();
		op_set(o, op, list);
		return o;
	}
	if (strcmp(op, "list") == 0) {
		op_value *names = names_json(op_get(r, "at"));
		pl_status(world_places);
		op_value *o = op_map();
		op_set(o, "names", names);
		return o;
	}
	if (strcmp(op, "lookup") == 0) {
		size_t n, nfrom;
		const char **names = world_address(op_get(r, "names"), &n);
		const char **from = world_address(op_get(r, "from"), &nfrom);
		op_value *found = lookup_json(names, n, from, nfrom);
		free(names), free(from);
		pl_status(world_places);
		op_value *o = op_map();
		if (found->type == OP_NULL) op_free(found);
		else op_set(o, "path", found);
		return o;
	}
	if (strcmp(op, "give") == 0) {
		sc_scope *o = world_scope(world_text(op_get(r, "scope")));
		if (o == NULL) return world_error("no such scope");
		if (nodes == NULL) nodes = sn_new(world_scheduler, world_table);
		return id_answer(sn_give(nodes, o, world_text(op_get(r, "id"))));
	}
	if (strcmp(op, "write") == 0) {
		putting c = {.request = r};
		const char *bad = world_hosted(put, &c);
		if (bad == NULL) bad = c.why;
		return bad ? world_error(bad) : op_map();
	}
	if (strcmp(op, "parts") == 0) {
		size_t n;
		const tb_entry *at = tb_at(world_table, world_key(op_get(r, "id")), &n);
		const char **names = world_alloc((n + 1) * sizeof *names);
		for (size_t i = 0; i < n; i++) names[i] = at[i].part.string;
		qsort(names, n, sizeof *names, part_order);
		op_value *a = op_list();
		for (size_t i = 0; i < n; i++) op_push(a, op_str(names[i]));
		free(names);
		op_value *o = op_map();
		op_set(o, "parts", a);
		return o;
	}
	if (strcmp(op, "teardown") == 0) {
		sc_scope *o = world_scope(world_text(op_get(r, "scope")));
		if (o == NULL) return world_error("no such scope");
		char *why = sc_teardown(o);
		if (why) return world_error_take(why);
		return op_map();
	}
	if (strcmp(op, "watch") == 0) {
		program *p = world_alloc(sizeof *p);
		p->f = op_get(r, "f");
		PUSH(programs, nprograms, capprograms, p);
		char *bad = world_make(&p->watch, world_text(op_get(r, "name")), world_text(op_get(r, "scope")),
			(sc_def){.f = program_f, .set = world_set, .equal = world_equal, .data = p}, false);
		if (bad) return world_error_take(bad);
		return op_map();
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) {
	if (!begun) {
		begun = 1;
		pr_processes_init(&rows, tb_string("R"));
		counted = rows.contributor;
		counted.step = counted_step;
		counted.names = counted_names;
		walk[0] = &counted;
		walk[1] = &pl_children;
		world_contribute(walk, 2);
	}
	world_line(request, out, answer);
}

void hh_finish(void) {
	world_finish();
	if (nodes) sn_free(nodes);
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	free(programs);
}
