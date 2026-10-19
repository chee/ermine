// start and stop (start.h) on the line protocol of typescript/start_harness.ts, which documents it, the
// compilers, the runner and createAPI (conformance/c/harness.h has the loop). Its world is places'
// (world_harness.h), made here before the first line: the host's places at R asked [processes(R), children]
// (the outermost box), the table telling them alone (a box's places is a view of them); scope nodes,
// builds and programs are made by the programs request. An address given as a string is split as
// path.ts' parse splits it. Not here: the js and wasm loads, nor the loads and said requests:
// conformance/load, on this protocol, is the TypeScript's only. Here: the dlopen runner (dlopen.h) and
// the native requests (conformance/native), the fixtures read from PG_FIXTURES (the Makefile's).
#define _DEFAULT_SOURCE
#define _DARWIN_C_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../../../filesystem/places/c/world_harness.h"
#include "../../../ermine/boxes/c/boxes.h"
#include "../../../ermine/processes/c/processes.h"
#include "../../../ermine/processes/c/scopes.h"
#include "../../build/c/build.h"
#include "dlopen.h"
#include "../../build/c/mem.h"
#include "programs.h"
#include "programs_json.h"
#include "start.h"

static pr_processes root_rows;
static const pl_contributor *root_walk[2];
static sn *scope_nodes;
static sc_pair host_info;
static hf *functions;
static bd *builds;
static ps *programs;
// where scopes are noted (ermine/sites): a process's site is where ps_start was called here
static st_sites *sites;
static char *cache;

// the native fixtures' folder (the Makefile's: this file's fixtures/, from the repo's root)
#ifndef PG_FIXTURES
#define PG_FIXTURES "extensions/programs/c/fixtures/"
#endif

typedef struct {
	char *name;
	bx *box;
} naming;
static naming *named;
static size_t nnamed, capnamed;

typedef struct {
	char *name;
	ps_process *process;
	char *id;
} started;
static started *procs;
static size_t nprocs, capprocs;

static bx *box_named(const char *name) {
	for (size_t i = 0; name != NULL && i < nnamed; i++) {
		if (strcmp(named[i].name, name) == 0) return named[i].box;
	}
	return NULL;
}

static started *proc_named(const char *name) {
	for (size_t i = 0; name != NULL && i < nprocs; i++) {
		if (strcmp(procs[i].name, name) == 0) return &procs[i];
	}
	return NULL;
}

static void commit_host(void *ctx, const pl_changed *changed) {
	(void)ctx;
	pl_commit(world_places, changed);
}

// a uuid's form: a folder a box made
static int is_uuid(const char *s) {
	if (strlen(s) != 36) return 0;
	for (size_t i = 0; i < 36; i++) {
		int dash = i == 8 || i == 13 || i == 18 || i == 23;
		if (dash ? s[i] != '-' : strchr("0123456789abcdef", s[i]) == NULL) return 0;
	}
	return 1;
}

// an address's steps, the strings copied: a string split as path.ts' parse does (a leading "/" is
// "/", empty pieces skipped), a list as it is (a piece that is no string: "")
typedef struct {
	char **v;
	size_t n, cap;
} steps;

static steps steps_of(const op_value *a) {
	steps s = {0};
	if (world_is(a, OP_STR)) {
		const char *p = a->str;
		if (*p == '/') PG_PUSH(s.v, s.n, s.cap, pg_dup("/"));
		while (*p) {
			const char *end = strchr(p, '/');
			size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
			if (len > 0) {
				char *piece = pg_alloc(len + 1);
				memcpy(piece, p, len);
				PG_PUSH(s.v, s.n, s.cap, piece);
			}
			p += len;
			if (*p == '/') p++;
		}
	} else if (world_is(a, OP_LIST)) {
		for (size_t i = 0; i < a->count; i++) {
			const char *t = world_text(a->items[i]);
			PG_PUSH(s.v, s.n, s.cap, pg_dup(t != NULL ? t : ""));
		}
	}
	return s;
}

static void steps_free(steps *s) {
	for (size_t i = 0; i < s->n; i++) free(s->v[i]);
	free(s->v);
	*s = (steps){0};
}

static op_value *names_json(const char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

// the compilers, and their calls --------------------------------------------------------------------------

static unsigned calls_upper, calls_wrap, calls_slow, calls_boom;

typedef struct {
	sc_promise *promise;
	op_value *input;
	int settled;
} waiter;
static waiter *waiting;
static size_t nwaiting, capwaiting;

static hf_out upper(const op_value *input, const hf_context *ctx, void *data) {
	(void)ctx, (void)data;
	calls_upper++;
	if (input == NULL || input->type != OP_STR) return (hf_out){.kind = HF_FAILED, .error = pg_dup("not a string")};
	char *s = pg_dup(input->str);
	for (char *p = s; *p; p++) *p = (char)toupper((unsigned char)*p);
	op_value *v = op_str(s);
	free(s);
	return (hf_out){.kind = HF_VALUE, .value = v};
}

static hf_out wrap(const op_value *input, const hf_context *ctx, void *data) {
	(void)ctx, (void)data;
	calls_wrap++;
	op_value *m = op_map();
	op_set(m, "wasm", input != NULL ? op_ref((op_value *)input) : op_null());
	return (hf_out){.kind = HF_VALUE, .value = m};
}

static hf_out slow(const op_value *input, const hf_context *ctx, void *data) {
	(void)ctx, (void)data;
	calls_slow++;
	waiter w = {sc_promise_new(world_scheduler), input != NULL ? op_ref((op_value *)input) : op_null(), 0};
	PG_PUSH(waiting, nwaiting, capwaiting, w);
	return (hf_out){.kind = HF_AWAIT, .promise = w.promise};
}

static hf_out boom(const op_value *input, const hf_context *ctx, void *data) {
	(void)input, (void)ctx, (void)data;
	calls_boom++;
	return (hf_out){.kind = HF_FAILED, .error = pg_dup("boom")};
}

// the runner and what the program is given ---------------------------------------------------------------

typedef struct {
	// what native code is handed (fixtures/runner.c): ctx (this api), and write, bytes as the
	// process's result
	void *ctx;
	void (*write)(void *ctx, const uint8_t *bytes, size_t n);
	pl *places;
	const char *id;
	const char *const *at;
	size_t nat;
	const char *const *args;
	size_t nargs;
	const char *const *cwd;
	size_t ncwd;
} api;

typedef struct {
	char *process;
	op_value *code;
	op_value *args;
	size_t runs;
	// what each arg's last run found: its name, and an id or none
	char **names;
	char **found;
	size_t n, cap;
} ran;
static ran **ran_list;
static size_t nran, capran;
static char **stops;
static size_t nstops, capstops;

typedef struct {
	ran *record;
	size_t arg;
	api *api;
	const char *name;
} argwatch;
static argwatch **argwatches;
static size_t nargwatches, capargwatches;

static const char *name_of_process(const char *id) {
	for (size_t i = 0; i < nprocs; i++) {
		if (strcmp(procs[i].id, id) == 0) return procs[i].name;
	}
	return id;
}

// what native code wrote, by process, in order
typedef struct {
	char *process;
	char *text;
} writing;
static writing *wrote;
static size_t nwrote, capwrote;

static void write_native(void *ctx, const uint8_t *bytes, size_t n) {
	api *a = ctx;
	char *t = pg_alloc(n + 1);
	memcpy(t, bytes, n);
	writing w = {pg_dup(name_of_process(a->id)), t};
	PG_PUSH(wrote, nwrote, capwrote, w);
}

static void *create_api(const ps_context *c, void *data) {
	(void)data;
	api *a = pg_alloc(sizeof *a);
	a->ctx = a;
	a->write = write_native;
	a->places = c->places;
	a->id = c->process.id;
	a->at = c->process.at;
	a->nat = c->process.nat;
	a->args = c->process.args;
	a->nargs = c->process.nargs;
	a->cwd = c->process.cwd;
	a->ncwd = c->process.ncwd;
	return a;
}
static void free_api(void *a, void *data) {
	(void)data;
	free(a);
}

// looks the arg up from the process's cwd each run (nearest first, up to its root), keeping what it
// finds
static sc_out watch_f(void *previous, void *data) {
	(void)previous;
	argwatch *w = data;
	api *a = w->api;
	size_t nfrom = a->ncwd;
	const char *names[] = {w->name};
	size_t *depths = pg_alloc((nfrom + 1) * sizeof *depths);
	tb_key id = {0};
	int found = 0;
	if (pl_lookup(a->places, names, 1, a->cwd, nfrom, 0, depths) > 0) {
		const char **path = pg_alloc((depths[0] + 2) * sizeof *path);
		for (size_t i = 0; i < depths[0]; i++) path[i] = a->cwd[i];
		path[depths[0]] = w->name;
		found = pl_get(a->places, path, depths[0] + 1, &id) && id.symbol == NULL;
		free(path);
	}
	free(depths);
	w->record->runs++;
	free(w->record->found[w->arg]);
	w->record->found[w->arg] = found ? pg_dup(id.string) : NULL;
	if (pl_status(a->places) == SC_STOP) return (sc_out){.kind = SC_VALUE};
	return (sc_out){.kind = SC_VALUE, .value = found ? op_str(id.string) : op_null()};
}
static char *no_set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}

static void stop_runner(void *ctx) {
	const char *name = ctx;
	char *copy = pg_dup(name);
	PG_PUSH(stops, nstops, capstops, copy);
}

static hf_run runner(const op_value *code, void *api_, void *data) {
	(void)data;
	api *a = api_;
	const char *name = name_of_process(a->id);
	ran *r = pg_alloc(sizeof *r);
	r->process = pg_dup(name);
	r->code = code != NULL ? op_ref((op_value *)code) : op_null();
	r->args = op_list();
	for (size_t i = 0; i < a->nargs; i++) op_push(r->args, op_str(a->args[i]));
	r->names = pg_alloc((a->nargs + 1) * sizeof *r->names);
	r->found = pg_alloc((a->nargs + 1) * sizeof *r->found);
	for (size_t i = 0; i < a->nargs; i++) r->names[i] = pg_dup(a->args[i]);
	r->n = a->nargs;
	PG_PUSH(ran_list, nran, capran, r);
	for (size_t i = 0; i < a->nargs; i++) {
		argwatch *w = pg_alloc(sizeof *w);
		w->record = r, w->arg = i, w->api = a, w->name = r->names[i];
		PG_PUSH(argwatches, nargwatches, capargwatches, w);
		sc_create_computer(world_scheduler, (sc_def){.f = watch_f, .set = no_set, .data = w}, NULL, 0);
	}
	return (hf_run){.handle = {stop_runner, r->process}};
}

// the dlopen runner, its loads and their compiles counted ---------------------------------------------------

static dlr *native;
static char *native_dir;
static unsigned native_loads, native_compiles, native_signed;

// a live form counted: the dlopen runner's, inside
typedef struct {
	hf_live inner;
} counted;

static hf_out counted_compile(const op_value *input, void *data) {
	counted *c = data;
	native_compiles++;
	return c->inner.compile(input, c->inner.data);
}
static hf_run counted_run(const op_value *code, void *api_, void *data) {
	counted *c = data;
	return c->inner.run(code, api_, c->inner.data);
}
static void counted_close(void *data) {
	counted *c = data;
	if (c->inner.close != NULL) c->inner.close(c->inner.data);
	free(c);
}

static hf_loaded counted_load(const op_value *code, void *data) {
	native_loads++;
	hf_loaded out = dlr_load(code, data);
	if (out.error != NULL) return out;
	counted *c = pg_alloc(sizeof *c);
	c->inner = out.live;
	out.live = (hf_live){.compile = c->inner.compile != NULL ? counted_compile : NULL,
		.run = c->inner.run != NULL ? counted_run : NULL, .close = counted_close, .data = c};
	return out;
}

static hf_run counted_program(const op_value *code, void *api_, void *data) {
	native_loads++;
	return dlr_run(code, api_, data);
}

static void native_note(const char *what, const char *detail, void *ctx) {
	(void)detail, (void)ctx;
	if (strcmp(what, "signed") == 0) native_signed++;
}

// made as first asked for: its files in a folder of the harness's own
static void native_runner(void) {
	if (native != NULL) return;
	const char *tmp = getenv("TMPDIR");
	char *dir = world_format("%s/ermine-native-XXXXXX", tmp != NULL && *tmp ? tmp : "/tmp");
	if (mkdtemp(dir) == NULL) {
		free(dir);
		dir = NULL;
	}
	native_dir = dir;
	native = dlr_new(&(dlr_setup){.dir = native_dir, .note = native_note});
	hf_add_loader(functions, "dlopen", counted_program, counted_load, native);
}

static size_t native_files(void) {
	DIR *d = native_dir != NULL ? opendir(native_dir) : NULL;
	if (d == NULL) return 0;
	size_t n = 0;
	struct dirent *e;
	while ((e = readdir(d)) != NULL) {
		if (strcmp(e->d_name, ".") != 0 && strcmp(e->d_name, "..") != 0) n++;
	}
	closedir(d);
	return n;
}

// a fixture's bytes; NULL: none there
static op_value *fixture(const char *name) {
	if (name == NULL || strchr(name, '/') != NULL) return NULL;
	char *path = world_format("%s%s.so", PG_FIXTURES, name);
	FILE *f = fopen(path, "rb");
	free(path);
	if (f == NULL) return NULL;
	size_t n = 0, cap = 4096;
	unsigned char *b = pg_alloc(cap);
	size_t got;
	while ((got = fread(b + n, 1, cap - n, f)) > 0) {
		n += got;
		if (n == cap) {
			cap *= 2;
			b = realloc(b, cap);
			if (b == NULL) abort();
		}
	}
	fclose(f);
	op_value *v = op_bytes(b, n);
	free(b);
	return v;
}

// masks --------------------------------------------------------------------------------------------------

static op_value *mask(const op_value *v) {
	if (v == NULL) return op_null();
	if (v->type == OP_STR) {
		for (size_t i = 0; i < nnamed; i++) {
			if (!is_uuid(v->str) || strcmp(bx_root(named[i].box), v->str) != 0) continue;
			char *s = world_format("box:%s", named[i].name);
			op_value *o = op_str(s);
			free(s);
			return o;
		}
		for (size_t i = 0; i < nprocs; i++) {
			if (strcmp(procs[i].id, v->str) != 0) continue;
			char *s = world_format("proc:%s", procs[i].name);
			op_value *o = op_str(s);
			free(s);
			return o;
		}
		return op_ref((op_value *)v);
	}
	if (v->type == OP_LIST) {
		op_value *a = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(a, mask(v->items[i]));
		return a;
	}
	if (v->type == OP_MAP) {
		op_value *m = op_map();
		for (size_t i = 0; i < v->count; i++) op_set(m, v->keys[i], mask(v->items[i]));
		return m;
	}
	return op_ref((op_value *)v);
}

static op_value *mask_take(op_value *v) {
	op_value *m = mask(v);
	op_free(v);
	return m;
}

// writes ---------------------------------------------------------------------------------------------------

typedef struct {
	const char *part;
	tb_key id;
	const op_value *value;
} entering;

static void enter(void *data) {
	entering *e = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(world_places, NULL, 0, CH_HERE, &h, &made);
	if (bad) {
		free(bad);
		return;
	}
	nd_entry *node = nd_make_entry((op_value *)e->value, &h);
	pl_hold(world_places, node, made, pl_made_free);
	world_keep_node(node);
	tb_sub(world_table, tb_string(e->part), e->id, node);
}

typedef struct {
	const op_value *request;
	const char *op;
	bx *box;
	int code;
	const char *why;
	// create: the box made
	bx *made;
} call;

static void boxing(void *data) {
	call *c = data;
	const op_value *r = c->request;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(world_places, NULL, 0, CH_HERE, &h, &made);
	if (bad) {
		free(bad);
		c->code = -1, c->why = SC_UNSCOPED;
		return;
	}
	pl_changed changed = {0};
	steps addr = steps_of(op_get(r, c->op[0] == 'c' ? "at" : "path"));
	const char *const *path = (const char *const *)addr.v;
	if (strcmp(c->op, "create") == 0) {
		bx_host host = {world_places, world_table, commit_host, NULL};
		c->code = bx_create(&host, path, addr.n, NULL, h, made, &c->made);
	} else if (strcmp(c->op, "box") == 0) {
		c->code = bx_box(c->box, path, addr.n, world_key(op_get(r, "node")), h, made, &changed);
	} else {
		c->code = bx_unbox(c->box, path, addr.n, h, made, &changed);
	}
	steps_free(&addr);
	pl_made_free(made);
	if (c->code > 0) c->why = pl_code_name(c->code);
}

static void make_programs(void *data) {
	(void)data;
	builds = bd_new(&(bd_setup){.places = world_places, .table = world_table, .scheduler = world_scheduler,
		.cache = cache, .functions = functions, .commit = commit_host});
	programs = ps_new(&(ps_setup){.scheduler = world_scheduler, .table = world_table, .places = world_places,
		.builds = builds, .scopes = scope_nodes, .functions = functions, .create_api = create_api,
		.free_api = free_api, .commit = commit_host, .sites = sites});
}

typedef struct {
	pl *places;
	const pg_way *way;
	const op_value *request;
	ps_process *process;
	ps_refusal refusal;
} starting;

static void do_start(void *data) {
	starting *s = data;
	const op_value *r = s->request;
	size_t nargs = 0;
	steps at = steps_of(op_get(r, "at"));
	steps cwd = steps_of(op_get(r, "cwd"));
	const op_value *list = op_get(r, "args");
	const char **args = list != NULL ? world_address(list, &nargs) : NULL;
	ps_options o = {args, nargs, list != NULL, (const char *const *)cwd.v, cwd.n, op_get(r, "cwd") != NULL};
	s->process = ps_start(programs, s->places, s->way, (const char *const *)at.v, at.n, &o, &s->refusal);
	free(args);
	steps_free(&at);
	steps_free(&cwd);
}

// requests -------------------------------------------------------------------------------------------------

static op_value *with(const char *key, op_value *v) {
	op_value *o = op_map();
	op_set(o, key, v);
	return o;
}

static op_value *shown(const op_value *v) {
	if (v == NULL) return op_null();
	if (cst_is_pending(v)) return op_str("pending");
	const char *error = cst_error(v);
	if (error == NULL) return mask(v);
	op_value *m = op_map();
	if (strncmp(error, "not-a-compiler", 14) == 0) op_set(m, "refused", op_str("not-a-compiler"));
	else if (strncmp(error, "uncacheable", 11) == 0) op_set(m, "refused", op_str("uncacheable"));
	else op_set(m, "failed", op_str(error));
	return m;
}

static int cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static op_value *start_op(const op_value *r) {
	if (programs == NULL) return world_error("no programs");
	bx *b = NULL;
	if (op_get(r, "box") != NULL && (b = box_named(world_text(op_get(r, "box")))) == NULL) {
		return world_error("no such box");
	}
	pl *places = b != NULL ? bx_places(b) : world_places;
	// from: given, else the cwd (given, else the folder at is in), as names borrowed from addr
	steps addr = {0};
	size_t nfrom;
	const char **from;
	if (op_get(r, "from") != NULL) from = world_address(op_get(r, "from"), &nfrom);
	else {
		int has_cwd = op_get(r, "cwd") != NULL;
		addr = steps_of(op_get(r, has_cwd ? "cwd" : "at"));
		from = pg_alloc((addr.n + 1) * sizeof *from);
		nfrom = bx_inside((const char *const *)addr.v, addr.n, NULL, 0, from);
		if (!has_cwd && nfrom > 0) nfrom--;
	}
	pg_found *found = NULL;
	pg_opened *opened = NULL;
	pg_way way;
	op_value *out = NULL;
	if (op_get(r, "file") == NULL) {
		found = pg_satisfy(places, world_text(op_get(r, "program")), from, nfrom);
		if (found->refused != NULL) out = mask_take(pg_found_json(found));
		else {
			int k = op_get(r, "chain") != NULL ? (int)op_get(r, "chain")->num : 0;
			way = (pg_way){found->program, found->chains.items[k]};
		}
	} else {
		opened = pg_open_with(places, world_text(op_get(r, "file")), from, nfrom);
		if (opened->refused != NULL) out = mask_take(pg_opened_json(opened));
		else {
			int k = op_get(r, "way") != NULL ? (int)op_get(r, "way")->num : 0;
			way = opened->ways.items[k];
		}
	}
	free(from);
	steps_free(&addr);
	if (out == NULL) {
		starting s = {.places = places, .way = &way, .request = r};
		world_hosted(do_start, &s);
		if (s.process == NULL) {
			out = op_map();
			op_set(out, "refused", op_str(s.refusal.refused));
			if (strcmp(s.refusal.refused, "no-runner") == 0) op_set(out, "program", pg_place_json(s.refusal.program));
			else if (strcmp(s.refusal.refused, "taken") == 0) op_set(out, "at", names_json(s.refusal.at, s.refusal.nat));
			else {
				op_free(out);
				out = world_error(s.refusal.refused);
			}
		} else {
			started p = {pg_dup(world_text(op_get(r, "name"))), s.process, pg_dup(ps_id(s.process))};
			PG_PUSH(procs, nprocs, capprocs, p);
			out = op_map();
			op_set(out, "id", mask_take(op_str(p.id)));
			const char *const *at;
			size_t nat = ps_at(s.process, &at);
			op_set(out, "at", names_json(at, nat));
		}
	}
	pg_found_free(found);
	pg_opened_free(opened);
	return out;
}

static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (strcmp(op, "attrs") == 0 || strcmp(op, "compiler") == 0 || strcmp(op, "runner") == 0) {
		op_value *fn = NULL;
		entering e = {"attributes", world_key(op_get(r, "id")), op_get(r, "value")};
		if (op[0] != 'a') {
			fn = hf_value(op[0] == 'c' ? world_text(op_get(r, "compiler")) : "runner");
			e.part = "value", e.value = fn;
		}
		world_hosted(enter, &e);
		op_free(fn);
		return op_map();
	}
	if (strcmp(op, "fixture") == 0 || strcmp(op, "dlopen") == 0) {
		op_value *v;
		if (op[0] == 'f') {
			v = fixture(world_text(op_get(r, "name")));
			if (v == NULL) return world_error_take(world_format("no fixture %s: make builds it", world_text(op_get(r, "name"))));
		} else {
			native_runner();
			v = hf_value("dlopen");
		}
		entering e = {"value", world_key(op_get(r, "id")), v};
		world_hosted(enter, &e);
		op_free(v);
		return op_map();
	}
	if (strcmp(op, "native") == 0) {
		op_value *o = op_map();
		op_set(o, "loads", op_num(native_loads));
		op_set(o, "compiles", op_num(native_compiles));
		op_set(o, "files", op_num((double)native_files()));
		op_set(o, "signed", op_num(native_signed));
		op_value *list = op_list();
		for (size_t i = 0; i < nwrote; i++) {
			op_value *m = op_map();
			op_set(m, "process", op_str(wrote[i].process));
			op_set(m, "text", op_str(wrote[i].text));
			op_push(list, m);
		}
		op_set(o, "wrote", list);
		return o;
	}
	if (strcmp(op, "create") == 0) {
		call c = {.request = r, .op = op};
		const char *folder = world_text(op_get(r, "folder"));
		if (folder != NULL) {
			bx_host host = {world_places, world_table, commit_host, NULL};
			c.code = bx_create_id(&host, folder, NULL, &c.made);
		} else world_hosted(boxing, &c);
		if (c.code) return world_error(c.why != NULL ? c.why : pl_code_name(c.code));
		naming n = {world_copy(world_text(op_get(r, "name"))), c.made};
		PG_PUSH(named, nnamed, capnamed, n);
		return op_map();
	}
	if (strcmp(op, "box") == 0 || strcmp(op, "unbox") == 0) {
		bx *b = box_named(world_text(op_get(r, "box")));
		if (b == NULL) return world_error("no such box");
		call c = {.request = r, .op = op, .box = b};
		world_hosted(boxing, &c);
		return c.code ? world_error(c.why) : op_map();
	}
	if (strcmp(op, "programs") == 0) {
		free(cache);
		cache = world_copy(world_text(op_get(r, "cache")));
		if (programs != NULL) ps_halt(programs);
		if (builds != NULL) bd_stop(builds);
		world_hosted(make_programs, NULL);
		return op_map();
	}
	if (strcmp(op, "start") == 0) return start_op(r);
	if (strcmp(op, "stop") == 0) {
		started *p = proc_named(world_text(op_get(r, "name")));
		if (p == NULL) return world_error("no such process");
		ps_stop(programs, p->process);
		return op_map();
	}
	if (strcmp(op, "settle") == 0) {
		const char *fail = world_text(op_get(r, "fail"));
		for (size_t i = 0; i < nwaiting; i++) {
			if (waiting[i].settled) continue;
			waiting[i].settled = 1;
			if (fail == NULL) sc_resolve(waiting[i].promise, op_ref(waiting[i].input));
			else sc_reject(waiting[i].promise, pg_dup(fail));
		}
		sc_pulse(world_scheduler);
		return op_map();
	}
	if (strcmp(op, "process") == 0) {
		started *p = proc_named(world_text(op_get(r, "name")));
		if (p == NULL) return world_error("no such process");
		size_t n;
		const tb_entry *at = tb_at(world_table, tb_string(p->id), &n);
		char **parts = pg_alloc((n + 1) * sizeof *parts);
		for (size_t i = 0; i < n; i++) parts[i] = pg_dup(at[i].part.string);
		qsort(parts, n, sizeof *parts, cmp);
		op_value *list = op_list();
		for (size_t i = 0; i < n; i++) op_push(list, op_str(parts[i])), free(parts[i]);
		free(parts);
		const nd_entry *e = tb_get(world_table, tb_string("attributes"), tb_string(p->id));
		const op_value *attrs = e != NULL && e->value != NULL && e->value->type == OP_MAP ? e->value : NULL;
		op_value *o = op_map();
		op_set(o, "parts", list);
		op_set(o, "status", shown(attrs != NULL ? op_get(attrs, CST_ATTRIBUTE) : NULL));
		op_set(o, "args", mask(attrs != NULL ? op_get(attrs, PR_ARGS) : NULL));
		op_set(o, "cwd", mask(attrs != NULL ? op_get(attrs, PR_CWD) : NULL));
		op_set(o, "pin", mask(attrs != NULL ? op_get(attrs, PR_PIN) : NULL));
		return o;
	}
	if (strcmp(op, "here") == 0) {
		bx *b = NULL;
		if (op_get(r, "box") != NULL && (b = box_named(world_text(op_get(r, "box")))) == NULL) {
			return world_error("no such box");
		}
		size_t n;
		const char **path = world_address(op_get(r, "path"), &n);
		tb_key id;
		pl *places = b != NULL ? bx_places(b) : world_places;
		op_value *v = pl_get(places, path, n, &id) ? mask_take(op_str(id.string)) : op_null();
		free(path);
		return with("id", v);
	}
	if (strcmp(op, "runs") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < nran; i++) {
			op_value *m = op_map();
			op_set(m, "process", op_str(ran_list[i]->process));
			op_set(m, "code", op_ref(ran_list[i]->code));
			op_set(m, "args", op_ref(ran_list[i]->args));
			op_value *keys = op_list();
			op_push(keys, op_str("places"));
			op_push(keys, op_str("process"));
			op_push(keys, op_str("watch"));
			op_set(m, "keys", keys);
			op_push(list, m);
		}
		op_value *o = op_map();
		op_set(o, "runs", list);
		op_value *s = op_list();
		for (size_t i = 0; i < nstops; i++) op_push(s, op_str(stops[i]));
		op_set(o, "stops", s);
		return o;
	}
	if (strcmp(op, "found") == 0) {
		const char *name = world_text(op_get(r, "name"));
		for (size_t i = 0; i < nran; i++) {
			if (strcmp(ran_list[i]->process, name) != 0) continue;
			op_value *f = op_map();
			for (size_t k = 0; k < ran_list[i]->n; k++) {
				const char *id = ran_list[i]->found[k];
				op_set(f, ran_list[i]->names[k], id != NULL ? mask_take(op_str(id)) : op_null());
			}
			op_value *o = op_map();
			op_set(o, "runs", op_num((double)ran_list[i]->runs));
			op_set(o, "found", f);
			return o;
		}
		return world_error("no program ran");
	}
	if (strcmp(op, "sites") == 0) {
		started *p = proc_named(world_text(op_get(r, "name")));
		if (p == NULL) return world_error("no such process");
		const st_site *chain[16];
		size_t n = st_sites_of(sites, ps_scope(p->process), chain, 16);
		op_value *list = op_list();
		for (size_t i = 0; i < n && i < 16; i++) {
			// the file's name, no folder and no extension
			const char *f = strrchr(chain[i]->file, '/');
			f = f != NULL ? f + 1 : chain[i]->file;
			const char *dot = strrchr(f, '.');
			size_t len = dot != NULL ? (size_t)(dot - f) : strlen(f);
			char *name = pg_alloc(len + 1);
			memcpy(name, f, len);
			op_push(list, op_str(name));
			free(name);
		}
		return with("sites", list);
	}
	if (strcmp(op, "calls") == 0) {
		op_value *o = op_map();
		op_set(o, "upper", op_num(calls_upper));
		op_set(o, "wrap", op_num(calls_wrap));
		op_set(o, "slow", op_num(calls_slow));
		op_set(o, "boom", op_num(calls_boom));
		return o;
	}
	if (strcmp(op, "cache") == 0) {
		if (cache == NULL) return world_error("no programs");
		const nd_entry *e = tb_get(world_table, tb_string("children"), tb_string(cache));
		return with("size", op_num(e != NULL && e->value != NULL && e->value->type == OP_MAP ? (double)e->value->count : 0));
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) {
	if (world_places == NULL) {
		world_places = pl_new();
		world_scheduler = sc_new((sc_options){.drop = world_drop});
		sc_on_tracking_end(world_scheduler, pl_forget, world_places);
		world_table = tb_make(pl_event, world_places);
		world_paths = pt_new();
		pr_processes_init(&root_rows, tb_string("R"));
		root_walk[0] = &root_rows.contributor;
		root_walk[1] = &pl_children;
		pl_connect(world_places, &(pl_setup){.root = tb_string("R"), .table = world_table,
			.paths = world_paths, .scheduler = world_scheduler, .contributors = root_walk,
			.ncontributors = 2});
		host_info = (sc_pair){"actor", op_str("test")};
		world_host = sc_create_root_scope(world_scheduler, &host_info, 1);
		scope_nodes = sn_new(world_scheduler, world_table);
		sites = st_new(world_scheduler);
		functions = hf_new();
		hf_add_compiler(functions, "upper", upper, NULL);
		hf_add_compiler(functions, "wrap", wrap, NULL);
		hf_add_compiler(functions, "slow", slow, NULL);
		hf_add_compiler(functions, "boom", boom, NULL);
		hf_add_runner(functions, "runner", runner, NULL);
	}
	world_line(request, out, answer);
}

void hh_finish(void) {
	if (programs != NULL) ps_halt(programs);
	if (builds != NULL) bd_stop(builds);
	for (size_t i = 0; i < nwaiting; i++) sc_promise_free(waiting[i].promise);
	world_finish();
	// the scopes are done: their sites go
	st_free(sites);
	sites = NULL;
	// the boxes' places after the scheduler (a process torn down there still writes through them)
	for (size_t i = 0; i < nnamed; i++) bx_free(named[i].box);
	ps_free(programs);
	bd_free(builds);
	sn_free(scope_nodes);
	hf_free(functions);
	dlr_free(native);
	if (native_dir != NULL) remove(native_dir);
	free(native_dir);
	for (size_t i = 0; i < nwrote; i++) free(wrote[i].process), free(wrote[i].text);
	free(wrote);
	op_free((op_value *)host_info.value);
	for (size_t i = 0; i < nwaiting; i++) op_free(waiting[i].input);
	free(waiting);
	for (size_t i = 0; i < nran; i++) {
		ran *r = ran_list[i];
		for (size_t k = 0; k < r->n; k++) free(r->names[k]), free(r->found[k]);
		free(r->names), free(r->found), free(r->process);
		op_free(r->code), op_free(r->args);
		free(r);
	}
	free(ran_list);
	for (size_t i = 0; i < nargwatches; i++) free(argwatches[i]);
	free(argwatches);
	for (size_t i = 0; i < nstops; i++) free(stops[i]);
	free(stops);
	for (size_t i = 0; i < nprocs; i++) free(procs[i].name), free(procs[i].id);
	free(procs);
	for (size_t i = 0; i < nnamed; i++) free(named[i].name);
	free(named);
	free(cache);
}
