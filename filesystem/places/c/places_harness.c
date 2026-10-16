// The C places (places.h) on the line protocol of typescript/places_harness.ts, which documents it and
// the programs (conformance/c/harness.h has the loop). The world (the table, the writes, the
// scheduler) is world.h's; programs are data, evaluated here as the reference does.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "world.h"
#include "status.h"
#include "runs.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// the keys of track and mark, one per name: the name's copy is the key
static char **keys;
static size_t nkeys, capkeys;
static const void *key_of(const char *name) {
	for (size_t i = 0; i < nkeys; i++) {
		if (strcmp(keys[i], name) == 0) return keys[i];
	}
	PUSH(keys, nkeys, capkeys, world_copy(name));
	return keys[nkeys - 1];
}

// the runs listener, once it is asked for
static crn *runs;

// pruning (places.h): rows, a trie on the value entry "rows" (a leaf an id, a level a map with
// names; nothing on the path: PL_NONE), a stand-in for ermine/processes', each ask counted; the
// places the filesystem's reads go through: the world's, or after the rows request a view of "R"
// given [rows, children]
static size_t steps_asked, names_asked;
static pl *view;
static pl *reader(void) { return view != NULL ? view : world_places; }

// the keys of here's path and one name more (extra NULL: none)
static op_key *rows_keys(const pl_here *here, const char *extra, size_t *n) {
	op_key *keys = world_alloc((here->length + 2) * sizeof *keys);
	for (size_t i = 0; i < here->length; i++) keys[i] = (op_key){.type = OP_STR_KEY, .s = here->path[i]};
	*n = here->length;
	if (extra != NULL) keys[(*n)++] = (op_key){.type = OP_STR_KEY, .s = extra};
	return keys;
}
// the value in rows at here's path + name, the read told
static const op_value *rows_at(const pl_here *here, const char *name, pl *l) {
	size_t n;
	op_key *keys = rows_keys(here, name, &n);
	const op_value *v = pl_read(l, tb_string("value"), tb_string("rows"), keys, n);
	free(keys);
	return v;
}
static bool filled(const op_value *v) { return v != NULL && v->type == OP_MAP && v->count > 0; }
static int rows_step(void *ctx, const pl_here *here, const char *name, pl *l, tb_key *out) {
	(void)ctx;
	steps_asked++;
	if (!here->has_path) return PL_NONE;
	const op_value *v = rows_at(here, name, l);
	if (v != NULL && v->type == OP_STR) {
		*out = tb_string(v->str);
		return 1;
	}
	return filled(v) ? 0 : PL_NONE;
}
static void rows_names(void *ctx, const pl_here *here, pl *l, pl_namelist *out) {
	(void)ctx;
	names_asked++;
	if (!here->has_path) {
		out->none = 1;
		return;
	}
	size_t n, had = out->n;
	op_key *keys = rows_keys(here, NULL, &n);
	pl_keys(l, tb_string("value"), tb_string("rows"), keys, n, 0, out);
	free(keys);
	if (out->n == had) out->none = 1;
}
static int rows_level(void *ctx, const pl_here *here, const char *name, pl *l) {
	(void)ctx;
	return here->has_path && filled(rows_at(here, name, l));
}
static const pl_contributor rows = {"rows", rows_step, rows_names, rows_level, NULL};
static const pl_contributor *const rows_walk[] = {&rows, &pl_children};

// programs --------------------------------------------------------------------------------------

// what a program is evaluated in: how it ended early, if it did: stopped (a read said the run must
// end), or an error
typedef struct {
	bool stopped;
	bool waited;
	char *error;
} ctx;

static op_value *eval(const op_value *e, ctx *c);
static op_value *eval_for_fill(const op_value *e, void *c) { return eval(e, c); }

static op_value *thrown(ctx *c, char *error) {
	if (c->error == NULL) c->error = error;
	else free(error);
	return NULL;
}
// whether the reads told since the last check let the program go on
static bool alive(ctx *c) {
	sc_track_status status = pl_status(world_places);
	if (status == SC_STOP) c->stopped = true;
	return status == SC_OK;
}

// a path found: the first depth names of from, then names, as JSON
static op_value *path_json(const char *const *from, size_t depth, const char *const *names,
	size_t n) {
	op_value *a = op_list();
	for (size_t i = 0; i < depth; i++) op_push(a, op_str(from[i]));
	for (size_t i = 0; i < n; i++) op_push(a, op_str(names[i]));
	return a;
}

// the lookup of names from a path, as JSON: the nearest path or null; all: the list of them
static op_value *lookup_json(const char *const *names, size_t n, const char *const *from, size_t nfrom,
	bool all) {
	size_t *depths = world_alloc((nfrom + 1) * sizeof *depths);
	size_t found = pl_lookup(reader(), names, n, from, nfrom, all, depths);
	op_value *out;
	if (all) {
		out = op_list();
		for (size_t i = 0; i < found; i++) op_push(out, path_json(from, depths[i], names, n));
	} else {
		out = found ? path_json(from, depths[0], names, n) : op_null();
	}
	free(depths);
	return out;
}

// the value read at (part, id) at path, as JSON
static op_value *evaluate_read(const op_value *x, ctx *c) {
	const op_value *path = x->count > 2 ? x->items[2] : NULL;
	op_value *steps = path ? eval(path, c) : NULL;
	if (path && steps == NULL) return NULL;
	size_t n;
	op_key *keys = world_path(steps, &n);
	const op_value *v = pl_read(world_places, tb_string(world_part(x->items[0])), world_key(x->items[1]),
		keys, n);
	free(keys);
	op_free(steps);
	return alive(c) ? world_snap(v) : NULL;
}

// the patches of the node's latest edit, as JSON, or null
static op_value *patches_of(const ch_header *h) {
	return h != NULL && h->has_op ? world_patches(h->patches, h->patches_length) : op_null();
}

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
	if ((x = op_get(e, "read"))) return evaluate_read(x, c);
	if ((x = op_get(e, "change"))) {
		const ch_header *h = pl_change(world_places, tb_string(world_part(x->items[0])),
			world_key(x->items[1]));
		return alive(c) ? patches_of(h) : NULL;
	}
	if ((x = op_get(e, "get"))) {
		size_t n;
		const char **names = world_address(x, &n);
		tb_key id;
		int found = pl_get(reader(), names, n, &id);
		free(names);
		if (!alive(c)) return NULL;
		return found ? op_str(id.string) : op_null();
	}
	if ((x = op_get(e, "values"))) {
		size_t n;
		const char **names = world_address(x, &n);
		tb_key id;
		int found = pl_get(reader(), names, n, &id);
		free(names);
		if (!alive(c)) return NULL;
		if (!found) return op_null();
		const op_value *v = pl_read(world_places, tb_string("value"), id, NULL, 0);
		return alive(c) ? world_snap(v) : NULL;
	}
	if ((x = op_get(e, "names")) || (x = op_get(e, "level"))) {
		bool names = op_get(e, "names") != NULL;
		size_t n;
		const char **path = world_address(x, &n);
		pl_members list = names ? pl_list(reader(), path, n) : pl_members_at(reader(), path, n);
		free(path);
		op_value *a;
		if (!names) a = world_ids(&list);
		else {
			a = op_list();
			for (size_t i = 0; i < list.n; i++) op_push(a, op_str(list.items[i].name));
		}
		pl_members_free(&list);
		if (!alive(c)) return op_free(a), NULL;
		return a;
	}
	if ((x = op_get(e, "cached"))) {
		size_t n;
		const char **names = world_address(x, &n);
		char *id = pc_get(world_cached(), names, n);
		free(names);
		op_value *out = id ? op_str(id) : op_null();
		free(id);
		return alive(c) ? out : (op_free(out), NULL);
	}
	if ((x = op_get(e, "cachedNames"))) {
		size_t n;
		const char **path = world_address(x, &n);
		pc_names list = pc_list(world_cached(), path, n);
		free(path);
		op_value *a = op_list();
		for (size_t i = 0; i < list.n; i++) op_push(a, op_str(list.items[i]));
		pc_names_free(&list);
		return alive(c) ? a : (op_free(a), NULL);
	}
	if ((x = op_get(e, "cachedEntries"))) {
		size_t n;
		const char **path = world_address(x, &n);
		pc_answers list = pc_gets(world_cached(), path, n);
		free(path);
		op_value *a = op_list();
		for (size_t i = 0; i < list.n; i++) {
			op_value *m = op_map();
			op_set(m, "id", op_str(list.items[i].id));
			op_set(m, "from", op_str(list.items[i].from));
			op_push(a, m);
		}
		pc_answers_free(&list);
		return alive(c) ? a : (op_free(a), NULL);
	}
	if ((x = op_get(e, "cachedMembers"))) {
		size_t n;
		const char **path = world_address(x, &n);
		pc_members list = pc_members_at(world_cached(), path, n);
		free(path);
		op_value *a = op_list();
		for (size_t i = 0; i < list.n; i++) {
			op_value *m = op_map();
			op_set(m, "name", op_str(list.items[i].name));
			op_set(m, "id", op_str(list.items[i].id));
			if (list.items[i].from) op_set(m, "from", op_str(list.items[i].from));
			op_push(a, m);
		}
		pc_members_free(&list);
		return alive(c) ? a : (op_free(a), NULL);
	}
	if ((x = op_get(e, "lookup"))) {
		size_t n, nfrom;
		const char **names = world_address(x->items[0], &n), **from = world_address(x->items[1], &nfrom);
		const op_value *all = op_get(e, "all");
		op_value *out = lookup_json(names, n, from, nfrom, all && all->type == OP_BOOL && all->bool_);
		free(names), free(from);
		return alive(c) ? out : (op_free(out), NULL);
	}
	if ((x = op_get(e, "status"))) {
		const char *id = world_text(x);
		if (id == NULL) return thrown(c, world_copy("id: not a string"));
		op_value *out = world_status_json(cst_status(world_places, tb_string(id)));
		return alive(c) ? out : (op_free(out), NULL);
	}
	if (op_get(e, "wait")) return c->waited = true, op_null();
	if ((x = op_get(e, "track"))) {
		const char *name = world_text(x);
		if (name == NULL) return thrown(c, world_copy("track: not a string"));
		if (sc_track(world_scheduler, key_of(name)) == SC_STOP) c->stopped = true;
		return c->stopped ? NULL : op_null();
	}
	if ((x = op_get(e, "throw"))) {
		const char *message = world_text(x);
		return thrown(c, world_copy(message ? message : "error"));
	}
	if ((x = op_get(e, "write"))) {
		op_value *r = world_fill(x, eval_for_fill, c);
		if (r == NULL) return NULL;
		const char *why;
		size_t failed;
		// the request is kept: the node's change refers into it
		world_keep(r);
		if (world_write(r, &why, &failed)) return thrown(c, world_copy(why));
		return op_null();
	}
	bool handled;
	char *error = NULL;
	op_value *plain = world_basic(e, eval_for_fill, c, &handled, &error);
	if (error) return thrown(c, error);
	if (handled) return plain;
	return thrown(c, world_copy("unknown program"));
}

// a watch's code: counts its run, evaluates its program
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
	if (c.waited) {
		op_free(v);
		return (sc_out){.kind = SC_PENDING};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

// requests --------------------------------------------------------------------------------------

// the actor of a change as runOf tells it: null for none
static op_value *actor_of(const op_value *change) {
	const op_value *a = change != NULL && change->type == OP_MAP ? op_get(change, "actor") : NULL;
	return a != NULL ? op_ref((op_value *)a) : op_null();
}

// a run as runOf tells it (typescript/places_harness.ts)
static op_value *run_json(const op_value *run) {
	if (run == NULL || run->type != OP_MAP) return op_null();
	op_value *o = op_map();
	op_set(o, "n", op_ref(op_get(run, "n")));
	op_set(o, "end", op_ref(op_get(run, "end")));
	const op_value *error = op_get(run, "error");
	if (error != NULL) op_set(o, "error", op_str(cst_error(error) ? cst_error(error) : ""));
	const op_value *started = op_get(run, "started"), *ended = op_get(run, "ended");
	op_set(o, "timed", op_bool(started != NULL && ended != NULL && started->num <= ended->num));
	const op_value *reads = op_get(run, "reads"), *writes = op_get(run, "writes");
	op_value *rs = op_list();
	for (size_t i = 0; i < reads->count; i++) {
		const op_value *r = reads->items[i];
		if (r->type != OP_MAP) {
			op_push(rs, op_null());
			continue;
		}
		op_value *m = op_map();
		op_set(m, "part", op_ref(op_get(r, "part")));
		op_set(m, "id", op_ref(op_get(r, "id")));
		op_set(m, "path", op_ref(op_get(r, "path")));
		if (op_get(r, "keys") != NULL) op_set(m, "keys", op_bool(1));
		op_set(m, "actor", actor_of(op_get(r, "change")));
		op_push(rs, m);
	}
	op_set(o, "reads", rs);
	op_value *ws = op_list();
	for (size_t i = 0; i < writes->count; i++) {
		const op_value *w = writes->items[i];
		op_value *m = op_map();
		op_set(m, "part", op_ref(op_get(w, "part")));
		op_set(m, "id", op_ref(op_get(w, "id")));
		op_set(m, "actor", actor_of(op_get(w, "change")));
		op_push(ws, m);
	}
	op_set(o, "writes", ws);
	return o;
}

static op_value *with_value(const op_value *v) {
	op_value *o = op_map();
	if (v != NULL) op_set(o, "value", world_snap(v));
	return o;
}

// places' requests; NULL: not one of them
static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (strcmp(op, "at") == 0) {
		op_value *value = op_get(r, "value");
		size_t n;
		op_key *keys = world_path(op_get(r, "path"), &n);
		op_value scratch = {0};
		const op_value *v = pl_at(value, keys, n, &scratch);
		// the scratch is on the stack: a number made from it, not held
		op_value *o = with_value(v == &scratch ? NULL : v);
		if (v == &scratch) op_set(o, "value", op_num(scratch.num));
		free(keys);
		return o;
	}
	if (strcmp(op, "read") == 0) {
		size_t n;
		op_key *keys = world_path(op_get(r, "path"), &n);
		const op_value *v = pl_read(world_places, tb_string(world_part(op_get(r, "part"))),
			world_key(op_get(r, "id")), keys, n);
		free(keys);
		pl_status(world_places);
		return with_value(v);
	}
	if (strcmp(op, "change") == 0) {
		const ch_header *h = pl_change(world_places, tb_string(world_part(op_get(r, "part"))),
			world_key(op_get(r, "id")));
		pl_status(world_places);
		op_value *o = op_map();
		if (h != NULL && h->has_op) op_set(o, "patches", world_patches(h->patches, h->patches_length));
		return o;
	}
	if (strcmp(op, "get") == 0) {
		size_t n;
		const char **names = world_address(op_get(r, "path"), &n);
		tb_key id;
		int found = pl_get(reader(), names, n, &id);
		free(names);
		pl_status(world_places);
		op_value *o = op_map();
		if (found) op_set(o, "id", op_str(id.string));
		return o;
	}
	if (strcmp(op, "list") == 0) {
		size_t n;
		const char **path = world_address(op_get(r, "at"), &n);
		pl_members list = pl_list(reader(), path, n);
		free(path);
		pl_status(world_places);
		op_value *a = op_list();
		for (size_t i = 0; i < list.n; i++) op_push(a, op_str(list.items[i].name));
		pl_members_free(&list);
		op_value *o = op_map();
		op_set(o, "names", a);
		return o;
	}
	if (strcmp(op, "cached") == 0) {
		size_t n;
		const char **path = world_address(op_get(r, "path"), &n);
		char *id = pc_get(world_cached(), path, n);
		free(path);
		pl_status(world_places);
		op_value *o = op_map();
		if (id) op_set(o, "id", op_str(id));
		free(id);
		return o;
	}
	if (strcmp(op, "cachedList") == 0) {
		size_t n;
		const char **path = world_address(op_get(r, "at"), &n);
		pc_names list = pc_list(world_cached(), path, n);
		free(path);
		pl_status(world_places);
		op_value *a = op_list();
		for (size_t i = 0; i < list.n; i++) op_push(a, op_str(list.items[i]));
		pc_names_free(&list);
		op_value *o = op_map();
		op_set(o, "names", a);
		return o;
	}
	if (strcmp(op, "lookup") == 0) {
		size_t n, nfrom;
		const char **names = world_address(op_get(r, "names"), &n);
		const char **from = world_address(op_get(r, "from"), &nfrom);
		const op_value *all = op_get(r, "all");
		bool every = all && all->type == OP_BOOL && all->bool_;
		op_value *found = lookup_json(names, n, from, nfrom, every);
		free(names), free(from);
		pl_status(world_places);
		op_value *o = op_map();
		if (every) op_set(o, "paths", found);
		else if (found->type == OP_NULL) op_free(found);
		else op_set(o, "path", found);
		return o;
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
	if (strcmp(op, "reads") == 0) {
		sc_scope *c = world_scope(world_text(op_get(r, "name")));
		if (c == NULL) return world_error("no such scope");
		const op_value *reads = world_reads(c);
		op_value *o = op_map();
		op_set(o, "reads", reads ? op_ref((op_value *)reads) : op_list());
		return o;
	}
	if (strcmp(op, "runs") == 0) {
		if (runs == NULL) runs = crn_new(&(crn_setup){world_places, world_table, world_scheduler});
		return op_map();
	}
	if (strcmp(op, "giveRun") == 0) {
		if (runs == NULL) return world_error("no runs");
		sc_scope *c = world_scope(world_text(op_get(r, "name")));
		if (c == NULL) return world_error("no such scope");
		crn_give(runs, c, world_key(op_get(r, "id")));
		return op_map();
	}
	if (strcmp(op, "runOf") == 0) {
		const op_value *run = crn_latest(world_places, world_key(op_get(r, "id")));
		pl_status(world_places);
		op_value *o = op_map();
		op_set(o, "run", run_json(run));
		return o;
	}
	if (strcmp(op, "mark") == 0) {
		const op_value *names = op_get(r, "keys");
		const void **ks = world_alloc((names->count + 1) * sizeof *ks);
		for (size_t i = 0; i < names->count; i++) ks[i] = key_of(names->items[i]->str);
		sc_mark(world_scheduler, ks, names->count, NULL);
		free(ks);
		return op_map();
	}
	if (strcmp(op, "rows") == 0) {
		if (view == NULL) view = pl_view(world_places, tb_string("R"), rows_walk, 2);
		return op_map();
	}
	if (strcmp(op, "asked") == 0) {
		op_value *o = op_map();
		op_set(o, "steps", op_num((double)steps_asked));
		op_set(o, "names", op_num((double)names_asked));
		steps_asked = names_asked = 0;
		return o;
	}
	if (strcmp(op, "spot") == 0) {
		const char *key = world_text(op_get(r, "key"));
		pl_where w;
		op_value *o = op_map();
		if (key != NULL && pl_spot(world_places, key, &w)) op_set(o, "spot", world_where(&w));
		return o;
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	if (view != NULL) pl_free(view);
	view = NULL;
	crn_stop(runs);
	world_finish();
	crn_free(runs);
	runs = NULL;
	for (size_t i = 0; i < nkeys; i++) free(keys[i]);
	free(keys);
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	free(programs);
}
