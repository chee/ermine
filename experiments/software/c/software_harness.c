// The C software (software.h) on the line protocol of typescript/software_harness.ts, which
// documents it (conformance/c/harness.h has the loop). One world, made at the first line: a
// scheduler, table, paths and places (root "R"; contributors [processes(R), children]), scope
// nodes, an hf registry, the host's scope { actor: "host" }, and a session: a process at
// /system/session the host started with processes of its own (pr_*, its body nothing), the owner of
// what is offered with no by. software made over it, its scope the host's, its pulses asked for
// (sw_setup.schedule) held, run by later. Names as the TypeScript's: the session "session", a
// process "proc:<its name>", a place by its name, a derived id its longest named prefix and the
// rest; taken back in a request's values too. The runners, each given the start's facts
// (sw_starting): record (its run and its stop recorded, hf_run.stop_reason given the reason; its
// load and its live form's close recorded, the load's facts sw_loading's, as hf_loader is given
// none), object (record's start and load: C has no map of functions, so it is record by another
// name), boom (hf_run.error "boom", its load's error too), quiet (its run recorded, no handle),
// late (its run recorded, sw_wait: landed by land), spawn (its run recorded, then sw_run of the map
// its code is, its process named), teller (the C api over one api_context, api_new from the facts,
// its teardown recorded; its stop_reason api_stop's why). A run's keys: the TypeScript Start's,
// sorted (sw_starting holds them, as places and root for the box).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../filesystem/places/c/status.h"
#include "../../../ermine/api/c/api.h"
#include "../../../ermine/boxes/c/boxes.h"
#include "../../../ermine/processes/c/processes.h"
#include "../../../ermine/processes/c/start.h"
#include "software.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }
static char *concat(const char *a, const char *b) {
	size_t n = strlen(a);
	char *s = xalloc(n + strlen(b) + 1);
	memcpy(s, a, n);
	strcpy(s + n, b);
	return s;
}

static const op_value *get(const op_value *map, const char *key) {
	return map != NULL && map->type == OP_MAP ? op_get(map, key) : NULL;
}
static const char *text(const op_value *v) { return v != NULL && v->type == OP_STR ? v->str : NULL; }

static op_value *error(const char *why) {
	op_value *o = op_map();
	op_set(o, "error", op_str(why));
	return o;
}
static op_value *with(const char *key, op_value *v) {
	op_value *o = op_map();
	op_set(o, key, v);
	return o;
}

// the world ---------------------------------------------------------------------------------------

// a box by its name
typedef struct {
	char *name;
	bx *box;
} boxed;

// a place by its name: its node, path, scope and whether stored
typedef struct {
	char *name;
	char *id;
	char **at;
	size_t nat;
	sc_scope *scope;
	int stored;
	sc_pair info;
	op_value *value;
} placed;

// a process by its name; a load by its name
typedef struct {
	char *name;
	sw_process *p;
} named_process;
typedef struct {
	char *name;
	sw_loaded *l;
} named_load;

// a pulse software asked for, held
typedef struct {
	void (*f)(void *data);
	void *data;
} asking;

// a late handle not landed: its process's id
typedef struct {
	sw_late *l;
	char *process;
} landing;

struct telling;

static int made;
static sc_scheduler *s;
static tb_table *table;
static pt_paths *paths;
static pl *places;
static pr_processes rows;
static const pl_contributor *walk[2];
static sn *scopes;
static hf *functions;
static sc_scope *host;
static sc_pair host_info;
static pr *host_processes;
static pr_process *session;
static sw *software;

static boxed *boxes;
static size_t nboxes, capboxes;
static placed *places_named;
static size_t nplaced, capplaced;
static named_process *procs;
static size_t nprocs, capprocs;
static named_load *held;
static size_t nheld, capheld;
static asking *asked;
static size_t nasked, capasked;
static landing *landings;
static size_t nlandings, caplandings, landed;
static api_context *context;
static struct telling **tellings;
static size_t ntellings, captellings;

static void drop(void *value, void *data) {
	(void)data;
	op_free(value);
}

// names: an id as answers show it, and back -----------------------------------------------------------

typedef struct {
	char *id;
	char *name;
} naming;
static naming *names;
static size_t nnames, capnames;

static void name(const char *id, const char *as) {
	PUSH(names, nnames, capnames, ((naming){xdup(id), xdup(as)}));
}
static const char *shown_of(const char *id) {
	for (size_t i = nnames; i-- > 0;) {
		if (strcmp(names[i].id, id) == 0) return names[i].name;
	}
	return NULL;
}
static const char *known_of(const char *as) {
	for (size_t i = nnames; i-- > 0;) {
		if (strcmp(names[i].name, as) == 0) return names[i].id;
	}
	return NULL;
}

// a string as shown (named, or derived: its longest named prefix's name and the rest), or taken
// back: fresh
static char *mapped(const char *v, const char *(*of)(const char *)) {
	const char *named = of(v);
	if (named != NULL) return xdup(named);
	for (size_t i = strlen(v); i-- > 1;) {
		if (v[i] != '/') continue;
		char *owner = xalloc(i + 1);
		memcpy(owner, v, i);
		const char *o = of(owner);
		free(owner);
		if (o != NULL) return concat(o, v + i);
	}
	return xdup(v);
}
static char *show(const char *v) { return mapped(v, shown_of); }
static char *take(const char *v) { return mapped(v, known_of); }

// a value with every string mapped (not map keys): new
static op_value *walked(const op_value *v, char *(*f)(const char *)) {
	if (v == NULL) return op_null();
	if (v->type == OP_STR) {
		char *x = f(v->str);
		op_value *o = op_str(x);
		free(x);
		return o;
	}
	if (v->type == OP_LIST) {
		op_value *a = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(a, walked(v->items[i], f));
		return a;
	}
	if (v->type == OP_MAP) {
		op_value *m = op_map();
		for (size_t i = 0; i < v->count; i++) op_set_name(m, v->keys[i], walked(v->items[i], f));
		return m;
	}
	return op_ref((op_value *)v);
}
// an answer: ids by name
static op_value *plain(const op_value *v) { return walked(v, show); }
static op_value *plain_take(op_value *v) {
	op_value *o = plain(v);
	op_free(v);
	return o;
}
// a request's value: names taken back
static op_value *back(const op_value *v) { return walked(v, take); }
static op_value *back_or_null(const op_value *v) { return v != NULL ? back(v) : NULL; }

static op_value *names_json(const char *const *list, size_t n) {
	op_value *out = op_list();
	for (size_t i = 0; i < n; i++) op_push(out, op_str(list[i]));
	return out;
}

// what the runners did, in order: each a value with ids as they are, shown when asked ----------------

static op_value *runs, *stops, *loads, *unloads, *told, *order;

static void ordered(const char *what, const char *id, const op_value *x, int has_x) {
	op_value *e = op_list();
	op_push(e, op_str(what));
	op_push(e, op_str(id));
	if (has_x) op_push(e, x != NULL ? op_ref((op_value *)x) : op_null());
	op_push(order, e);
}

// a run recorded: its process, code (a function's: { live: true }), args, cwd, its box's root, the
// keys of its start, whether its scope is the one open
static void noted(const op_value *code, const sw_starting *st) {
	op_value *m = op_map();
	op_set(m, "process", op_str(st->process.id));
	op_set(m, "code", code != NULL && hf_name(code) != NULL ? with("live", op_bool(1))
	                  : code != NULL                        ? op_ref((op_value *)code)
	                                                        : op_null());
	op_set(m, "args", names_json(st->process.args, st->process.nargs));
	op_set(m, "cwd", names_json(st->process.cwd, st->process.ncwd));
	op_set(m, "root", op_str(st->root));
	static const char *const keys[6] = {"box", "places", "process", "scheduler", "scope", "table"};
	op_set(m, "keys", names_json(keys, 6));
	op_set(m, "open", op_bool(sc_get_current_scope(s) == st->scope));
	op_push(runs, m);
	ordered("ran", st->process.id, NULL, 0);
}

// record's handle: its process
typedef struct {
	char *process;
} handled;
static handled **handles;
static size_t nhandles, caphandles;

static void record_stop(void *ctx, const op_value *reason) {
	handled *h = ctx;
	op_value *m = op_map();
	op_set(m, "process", op_str(h->process));
	op_set(m, "reason", reason != NULL ? op_ref((op_value *)reason) : op_null());
	op_push(stops, m);
	ordered("stopped", h->process, reason, 1);
}
static void record_stop_plain(void *ctx) { record_stop(ctx, NULL); }

static hf_run handle(const char *process) {
	handled *h = xalloc(sizeof *h);
	h->process = xdup(process);
	PUSH(handles, nhandles, caphandles, h);
	return (hf_run){.handle = {record_stop_plain, h}, .stop_reason = record_stop};
}

static hf_run record(const op_value *code, void *api_, void *data) {
	(void)data;
	const sw_starting *st = api_;
	noted(code, st);
	return handle(st->process.id);
}

// record's live form: its owner and code, its close recorded
typedef struct {
	char *by;
	op_value *code;
} live_form;
static void record_close(void *data) {
	live_form *l = data;
	op_value *m = op_map();
	op_set(m, "by", op_str(l->by));
	op_set(m, "code", l->code);
	op_push(unloads, m);
	ordered("unloaded", l->by, l->code, 1);
	free(l->by);
	free(l);
}
static hf_loaded record_load(const op_value *code, void *data) {
	(void)data;
	const sw_starting *st = sw_loading(software);
	op_value *c = code != NULL ? op_ref((op_value *)code) : op_null();
	op_value *m = op_map();
	op_set(m, "by", op_str(st->process.id));
	op_set(m, "code", op_ref(c));
	op_set(m, "cwd", names_json(st->process.cwd, st->process.ncwd));
	op_set(m, "open", op_bool(sc_get_current_scope(s) == st->scope));
	op_push(loads, m);
	ordered("loaded", st->process.id, c, 1);
	live_form *l = xalloc(sizeof *l);
	l->by = xdup(st->process.id);
	l->code = c;
	return (hf_loaded){.live = {.close = record_close, .data = l}};
}

static hf_run boom(const op_value *code, void *api_, void *data) {
	(void)code, (void)api_, (void)data;
	return (hf_run){.error = xdup("boom")};
}
static hf_loaded boom_load(const op_value *code, void *data) {
	(void)code, (void)data;
	return (hf_loaded){.error = xdup("boom")};
}

static hf_run quiet(const op_value *code, void *api_, void *data) {
	(void)data;
	noted(code, api_);
	return (hf_run){0};
}

static hf_run late(const op_value *code, void *api_, void *data) {
	(void)data;
	const sw_starting *st = api_;
	noted(code, st);
	sw_late *l = sw_wait(st);
	if (l != NULL) PUSH(landings, nlandings, caplandings, ((landing){l, xdup(st->process.id)}));
	return (hf_run){0};
}

// an address's steps, copied: a string split as path.ts' parse does, a list as it is
typedef struct {
	char **v;
	size_t n, cap;
} steps;

static steps steps_of(const op_value *a) {
	steps st = {0};
	if (a != NULL && a->type == OP_STR) {
		const char *p = a->str;
		if (*p == '/') PUSH(st.v, st.n, st.cap, xdup("/"));
		while (*p) {
			const char *end = strchr(p, '/');
			size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
			if (len > 0) {
				char *piece = xalloc(len + 1);
				memcpy(piece, p, len);
				PUSH(st.v, st.n, st.cap, piece);
			}
			p += len;
			if (*p == '/') p++;
		}
	} else if (a != NULL && a->type == OP_LIST) {
		for (size_t i = 0; i < a->count; i++) {
			PUSH(st.v, st.n, st.cap, xdup(text(a->items[i]) != NULL ? a->items[i]->str : ""));
		}
	}
	return st;
}
static void steps_free(steps *st) {
	for (size_t i = 0; i < st->n; i++) free(st->v[i]);
	free(st->v);
	*st = (steps){0};
}
#define STEPS(x) ((const char *const *)(x).v), (x).n

// a request's program: an address (its steps in path), or { id, hash?, type?, api?, code? } (its id
// taken back, in *id)
static sw_program program_of(const op_value *pv, steps *path, char **id) {
	sw_program program = {0};
	if (pv != NULL && pv->type == OP_MAP) {
		const char *given = text(get(pv, "id"));
		*id = take(given != NULL ? given : "");
		program.id = *id;
		program.hash = text(get(pv, "hash"));
		// a hash that is no string: never the value's
		if (program.hash == NULL && get(pv, "hash") != NULL) program.hash = "";
		program.type = text(get(pv, "type"));
		program.api = text(get(pv, "api"));
		program.code = get(pv, "code");
	} else {
		*path = steps_of(pv);
		program.at = (const char *const *)path->v;
		program.nat = path->n;
		program.has_at = 1;
	}
	return program;
}

// a process made: named
static void named(sw_process *p, const char *as) {
	if (as == NULL) return;
	char *n = concat("proc:", as);
	name(sw_process_id(p), n);
	free(n);
	PUSH(procs, nprocs, capprocs, ((named_process){xdup(as), p}));
}

static hf_run spawn(const op_value *code, void *api_, void *data) {
	(void)data;
	const sw_starting *st = api_;
	noted(code, st);
	if (code != NULL && code->type == OP_MAP) {
		steps runner = steps_of(get(code, "runner")), at = steps_of(get(code, "at")), path = {0};
		char *id = NULL;
		sw_program program = program_of(get(code, "program"), &path, &id);
		sw_refusal no;
		sw_process *p = sw_run(software, STEPS(runner), &program, STEPS(at), NULL, &no);
		if (p != NULL) named(p, text(get(code, "name")));
		free(id);
		steps_free(&runner), steps_free(&at), steps_free(&path);
	}
	return handle(st->process.id);
}

// teller: an api made from the facts, its teardown recorded; its stop's reason api_stop's why
typedef struct telling {
	char *id;
	api_process process;
	api *a;
} telling;
static void told_f(const op_value *why, void *ctx) {
	telling *t = ctx;
	op_value *m = op_map();
	op_set(m, "process", op_str(t->id));
	op_set(m, "why", why != NULL ? op_ref((op_value *)why) : op_null());
	op_push(told, m);
	ordered("told", t->id, why, 1);
}
static void teller_stop(void *ctx, const op_value *reason) {
	telling *t = ctx;
	api_stop(context, &t->process, reason);
}
static void teller_stop_plain(void *ctx) { teller_stop(ctx, NULL); }
// the api's own pulses: none asked (the harness pulses)
static void no_schedule(void *ctx, void (*f)(void *data), void *data) { (void)ctx, (void)f, (void)data; }
static hf_run teller(const op_value *code, void *api_, void *data) {
	(void)code, (void)data;
	const sw_starting *st = api_;
	if (context == NULL) {
		context = api_context_new(&(api_setup){.scheduler = s, .table = table, .places = places,
			.schedule = no_schedule});
	}
	telling *t = xalloc(sizeof *t);
	t->id = xdup(st->process.id);
	t->process = (api_process){.id = t->id, .at = st->process.at, .nat = st->process.nat,
		.cwd = st->process.cwd, .ncwd = st->process.ncwd, .args = st->process.args,
		.nargs = st->process.nargs, .scope = st->scope};
	t->a = api_new(context, &(api_starting){.process = t->process, .places = st->places});
	api_teardown(t->a, told_f, t);
	PUSH(tellings, ntellings, captellings, t);
	return (hf_run){.handle = {teller_stop_plain, t}, .stop_reason = teller_stop};
}

static const char *const runner_names[7] = {"record", "object", "boom", "quiet", "late", "spawn",
	"teller"};

// a pulse software asked for: held
static void asking_f(void *ctx, void (*f)(void *data), void *data) {
	(void)ctx;
	PUSH(asked, nasked, capasked, ((asking){f, data}));
}

// the world, made at the first line
static void make(void) {
	made = 1;
	places = pl_new();
	s = sc_new((sc_options){.drop = drop});
	sc_on_tracking_end(s, pl_forget, places);
	table = tb_make(pl_event, places);
	paths = pt_new();
	pr_processes_init(&rows, tb_string("R"));
	walk[0] = &rows.contributor;
	walk[1] = &pl_children;
	pl_connect(places, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths,
		.scheduler = s, .contributors = walk, .ncontributors = 2});
	host_info = (sc_pair){"actor", op_str("host")};
	host = sc_create_root_scope(s, &host_info, 1);
	scopes = sn_new(s, table);
	functions = hf_new();
	hf_add_loader(functions, "record", record, record_load, NULL);
	hf_add_loader(functions, "object", record, record_load, NULL);
	hf_add_loader(functions, "boom", boom, boom_load, NULL);
	hf_add_runner(functions, "quiet", quiet, NULL);
	hf_add_runner(functions, "late", late, NULL);
	hf_add_runner(functions, "spawn", spawn, NULL);
	hf_add_runner(functions, "teller", teller, NULL);
	runs = op_list(), stops = op_list(), loads = op_list(), unloads = op_list();
	told = op_list(), order = op_list();
	host_processes = pr_new(&(pr_setup){.scheduler = s, .table = table, .places = places,
		.scopes = scopes, .owner = host});
	static const char *const at[2] = {"system", "session"};
	pr_refusal no;
	session = pr_start(host_processes, places, at, 2, NULL, &no);
	if (session == NULL) {
		fputs("no session\n", stderr);
		abort();
	}
	name(pr_id(session), "session");
	software = sw_new(&(sw_setup){.scheduler = s, .table = table, .places = places, .scopes = scopes,
		.functions = functions, .scope = host, .schedule = asking_f});
}

// f with the host's scope open, or a scope { actor } under it, or none (bare)
static void hosted(void (*f)(void *data), void *data, const char *actor, int bare) {
	if (bare) {
		f(data);
		return;
	}
	if (actor == NULL) {
		sc_run_with_scope(host, f, data);
		return;
	}
	op_value *v = op_str(actor);
	sc_pair info = {"actor", v};
	sc_scope *o = sc_create_scope(s, &info, 1, host);
	sc_run_with_scope(o, f, data);
	free(sc_teardown(o));
	op_free(v);
}

static bx *box_of(const char *n) {
	for (size_t i = nboxes; n != NULL && i-- > 0;) {
		if (strcmp(boxes[i].name, n) == 0) return boxes[i].box;
	}
	return NULL;
}

static sw_process *proc_of(const char *n) {
	for (size_t i = nprocs; n != NULL && i-- > 0;) {
		if (strcmp(procs[i].name, n) == 0) return procs[i].p;
	}
	return NULL;
}

static placed *place_of(const char *n) {
	for (size_t i = nplaced; n != NULL && i-- > 0;) {
		if (strcmp(places_named[i].name, n) == 0) return &places_named[i];
	}
	return NULL;
}

// an owner by its name: a place's, a process's; none: the session. 0: no such
static int by_of(const op_value *given, sw_place *out) {
	const char *n = text(given);
	if (given == NULL) {
		const char *const *at;
		size_t nat = pr_at(session, &at);
		*out = (sw_place){pr_id(session), at, nat, pr_scope(session), 0};
		return 1;
	}
	placed *x = place_of(n);
	if (x != NULL) {
		*out = (sw_place){x->id, (const char *const *)x->at, x->nat, x->scope, x->stored};
		return 1;
	}
	sw_process *p = proc_of(n);
	if (p == NULL) return 0;
	const char *const *at;
	size_t nat = sw_process_at(p, &at);
	*out = (sw_place){sw_process_id(p), at, nat, sw_process_scope(p), 0};
	return 1;
}

// a refusal as answers show it: a places code (and not-a-kind), an error; else software.ts' Refused
static op_value *refusal(const sw_refusal *r) {
	if (strcmp(r->refused, "not-a-name") == 0 || strcmp(r->refused, "nothing-there") == 0 ||
		strcmp(r->refused, "not-a-kind") == 0)
		return error(r->refused);
	return plain_take(sw_refusal_value(r));
}

// the requests ---------------------------------------------------------------------------------------

typedef struct {
	const op_value *r;
	op_value *out;
	const char *part;
} job;

// kids, attrs, value: the entry replaced (its value's names taken back; live: a runner by its
// name); neither: taken out
static void put_entry(void *data) {
	job *j = data;
	char *id = take(text(get(j->r, "id")) ? text(get(j->r, "id")) : "");
	const op_value *v = get(j->r, "value");
	const char *live = text(get(j->r, "live"));
	if (live != NULL && strcmp(j->part, "value") == 0) {
		int known = 0;
		for (size_t i = 0; i < 7; i++) known |= strcmp(live, runner_names[i]) == 0;
		if (!known) {
			j->out = error("no such runner");
			free(id);
			return;
		}
	}
	if (v == NULL && (live == NULL || strcmp(j->part, "value") != 0)) {
		if (tb_get(table, tb_string(j->part), tb_string(id)) != NULL) {
			tb_del(table, tb_string(j->part), tb_string(id));
		}
	} else {
		ch_header h;
		pl_made *m;
		char *bad = pl_header(places, NULL, 0, CH_HERE, &h, &m);
		if (bad != NULL) {
			j->out = error(bad);
			free(bad);
			free(id);
			return;
		}
		op_value *x = live != NULL && strcmp(j->part, "value") == 0 ? hf_value(live) : back(v);
		nd_entry *e = nd_make_entry(x, &h);
		op_free(x);
		pl_own(places, e);
		pl_hold(places, e, m, pl_made_free);
		tb_sub(table, tb_string(j->part), tb_string(id), e);
	}
	free(id);
	j->out = op_map();
}

// a box over the folder's id, by name
static void create_box(void *data) {
	job *j = data;
	const char *folder = text(get(j->r, "folder"));
	const char *n = text(get(j->r, "name"));
	if (folder == NULL || n == NULL) {
		j->out = error("no name or folder");
		return;
	}
	char *id = take(folder);
	bx *b;
	int code = bx_create_id(&(bx_host){places, table, NULL, NULL}, id, NULL, &b);
	free(id);
	if (code != 0) {
		j->out = error(pl_code_name(code));
		return;
	}
	PUSH(boxes, nboxes, capboxes, ((boxed){xdup(n), b}));
	j->out = op_map();
}

// a place, its scope { place: name } under the host's; named
static op_value *place(const op_value *r) {
	const char *n = text(get(r, "name")), *given = text(get(r, "id"));
	if (n == NULL || given == NULL) return error("no name or id");
	placed x = {.name = xdup(n), .id = take(given)};
	steps at = steps_of(get(r, "at"));
	x.at = at.v != NULL ? at.v : xalloc(sizeof *x.at);
	x.nat = at.n;
	const op_value *stored = get(r, "stored");
	x.stored = stored != NULL && stored->type == OP_BOOL && stored->bool_;
	x.value = op_str(n);
	PUSH(places_named, nplaced, capplaced, x);
	// the info's pointers: the one in the list
	placed *in = &places_named[nplaced - 1];
	in->info = (sc_pair){"place", in->value};
	in->scope = sc_create_scope(s, &in->info, 1, host);
	name(in->id, n);
	return op_map();
}

// a scope torn down: a place's; a process's own, alone; "host": the host's; none: the session's
static op_value *close_place(const op_value *r) {
	const char *n = text(get(r, "name"));
	sc_scope *o;
	if (get(r, "name") == NULL) o = pr_scope(session);
	else if (n != NULL && strcmp(n, "host") == 0) o = host;
	else {
		sw_place by;
		if (!by_of(get(r, "name"), &by)) return error("no such place");
		o = by.scope;
	}
	free(sc_teardown(o));
	return op_map();
}

// an offer: { id, at }, or the refusal (a places code: an error)
static void offer(void *data) {
	job *j = data;
	const op_value *r = j->r;
	const char *kind = text(get(r, "kind"));
	int k = -1;
	for (int i = 0; kind != NULL && i < 3; i++) {
		static const char *const kinds[3] = {"runners", "compilers", "surfaces"};
		if (strcmp(kind, kinds[i]) == 0) k = i;
	}
	sw_place by;
	if (!by_of(get(r, "by"), &by)) {
		j->out = error("no such owner");
		return;
	}
	const char *live = text(get(r, "live"));
	if (live != NULL) {
		int known = 0;
		for (size_t i = 0; i < 7; i++) known |= strcmp(live, runner_names[i]) == 0;
		if (!known) {
			j->out = error("no such runner");
			return;
		}
	}
	op_value *fn = live != NULL ? hf_value(live) : NULL;
	op_value *attrs = back_or_null(get(r, "attrs"));
	const char *n = text(get(r, "name"));
	sw_refusal no;
	const sw_offered *o = sw_offer(software, &by, (sw_kind)k, n != NULL ? n : "", attrs, fn, &no);
	op_free(fn);
	op_free(attrs);
	if (o == NULL) {
		j->out = refusal(&no);
		return;
	}
	op_value *m = op_map();
	op_set(m, "id", op_str(o->id));
	op_set(m, "at", names_json(o->at, o->nat));
	j->out = plain_take(m);
}

static void withdraw(void *data) {
	job *j = data;
	const char *id = text(get(j->r, "id"));
	char *taken = take(id != NULL ? id : "");
	sw_withdraw(software, taken);
	free(taken);
	j->out = op_map();
}

// a run: its process named proc:<name>
static void run(void *data) {
	job *j = data;
	const op_value *r = j->r;
	steps runner = steps_of(get(r, "runner")), at = steps_of(get(r, "at"));
	steps cwd = steps_of(get(r, "cwd")), args = steps_of(get(r, "args")), path = {0};
	char *id = NULL;
	sw_program program = program_of(get(r, "program"), &path, &id);
	bx *b = NULL;
	if (get(r, "box") != NULL && (b = box_of(text(get(r, "box")))) == NULL) {
		j->out = error("no such box");
	} else {
		op_value *pin = back_or_null(get(r, "pin"));
		sw_options o = {.args = (const char *const *)args.v, .nargs = args.n,
			.has_args = get(r, "args") != NULL, .cwd = (const char *const *)cwd.v, .ncwd = cwd.n,
			.has_cwd = get(r, "cwd") != NULL, .box = b != NULL ? bx_places(b) : NULL, .pin = pin};
		sw_refusal no;
		sw_process *p = sw_run(software, STEPS(runner), &program, STEPS(at), &o, &no);
		op_free(pin);
		if (p == NULL) j->out = refusal(&no);
		else {
			named(p, text(get(r, "name")));
			const char *const *where;
			size_t nwhere = sw_process_at(p, &where);
			op_value *m = op_map();
			op_set(m, "id", op_str(sw_process_id(p)));
			op_set(m, "at", names_json(where, nwhere));
			j->out = plain_take(m);
		}
	}
	free(id);
	steps_free(&runner), steps_free(&at), steps_free(&cwd), steps_free(&args), steps_free(&path);
}

// a stop by name ("session": the session's, which software does not run)
static void stop(void *data) {
	job *j = data;
	const char *n = text(get(j->r, "name"));
	const char *id = NULL;
	if (n != NULL && strcmp(n, "session") == 0) id = pr_id(session);
	else {
		sw_process *p = proc_of(n);
		if (p == NULL) {
			j->out = error("no such process");
			return;
		}
		id = sw_process_id(p);
	}
	op_value *reason = back_or_null(get(j->r, "reason"));
	sw_stop(software, id, reason);
	op_free(reason);
	j->out = op_map();
}

// a load, named; by as offer's
static void load(void *data) {
	job *j = data;
	const op_value *r = j->r;
	sw_place by;
	if (!by_of(get(r, "by"), &by)) {
		j->out = error("no such owner");
		return;
	}
	bx *b = NULL;
	if (get(r, "box") != NULL && (b = box_of(text(get(r, "box")))) == NULL) {
		j->out = error("no such box");
		return;
	}
	steps runner = steps_of(get(r, "runner")), path = {0};
	char *id = NULL;
	sw_program program = program_of(get(r, "program"), &path, &id);
	sw_refusal no;
	sw_loaded *l = sw_load(software, &by, STEPS(runner), &program, b != NULL ? bx_places(b) : NULL, &no);
	if (l == NULL && strcmp(no.refused, "failed") == 0) j->out = with("failed", op_str(no.error));
	else if (l == NULL) j->out = refusal(&no);
	else {
		const char *n = text(get(r, "name"));
		PUSH(held, nheld, capheld, ((named_load){xdup(n != NULL ? n : ""), l}));
		j->out = op_map();
	}
	free(id);
	steps_free(&runner), steps_free(&path);
}

static void release_named(void *data) {
	job *j = data;
	const char *n = text(get(j->r, "name"));
	for (size_t i = nheld; n != NULL && i-- > 0;) {
		if (strcmp(held[i].name, n) != 0) continue;
		sw_release(software, held[i].l);
		j->out = op_map();
		return;
	}
	j->out = error("no such load");
}

// the oldest late handle not landed: given record's handle (fail: Error("late"))
static op_value *land(const op_value *r) {
	if (landed == nlandings) return error("no late handle");
	landing *l = &landings[landed++];
	const op_value *fail = get(r, "fail");
	if (fail != NULL && fail->type == OP_BOOL && fail->bool_) sw_land(l->l, (hf_run){.error = xdup("late")});
	else sw_land(l->l, handle(l->process));
	free(sc_escaped(s));
	return op_map();
}

// reads, untracked --------------------------------------------------------------------------------------

typedef struct {
	pl *places;
	const char *const *path;
	size_t n;
	op_value *out;
} reading;

static void get_id(void *data) {
	reading *g = data;
	tb_key id;
	g->out = pl_get(g->places, g->path, g->n, &id) && id.symbol == NULL ? op_str(id.string) : op_null();
}
static void list_names(void *data) {
	reading *g = data;
	pl_members list = pl_list(g->places, g->path, g->n);
	g->out = op_list();
	for (size_t i = 0; i < list.n; i++) op_push(g->out, op_str(list.items[i].name));
	pl_members_free(&list);
}

static op_value *read_at(pl *p, const op_value *at, void (*f)(void *data)) {
	steps path = steps_of(at);
	reading g = {p, STEPS(path), NULL};
	pl_peep(p, f, &g);
	pl_status(p);
	steps_free(&path);
	return g.out;
}

static int by_name(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

// a status as answers show it: "pending" | { failed } | null; any other value: { raw: it }
static op_value *status_json(const op_value *v) {
	if (v == NULL) return op_null();
	if (cst_is_pending(v)) return op_str("pending");
	if (cst_error(v) != NULL) return with("failed", op_str(cst_error(v)));
	return with("raw", plain(v));
}

static op_value *node_json(const op_value *r) {
	const char *given = text(get(r, "id"));
	char *id = take(given != NULL ? given : "");
	size_t n;
	const tb_entry *at = tb_at(table, tb_string(id), &n);
	char **parts = xalloc((n + 1) * sizeof *parts);
	for (size_t i = 0; i < n; i++) parts[i] = xdup(at[i].part.string);
	qsort(parts, n, sizeof *parts, by_name);
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(parts[i])), free(parts[i]);
	free(parts);
	op_value *o = op_map();
	op_set(o, "parts", list);
	const nd_entry *a = tb_get(table, tb_string("attributes"), tb_string(id));
	op_value *attributes = op_null(), *state = op_null();
	if (a != NULL) {
		op_free(attributes), op_free(state);
		attributes = op_map();
		const op_value *v = a->value != NULL && a->value->type == OP_MAP ? a->value : NULL;
		const op_value *was = v != NULL ? op_get(v, CST_ATTRIBUTE) : NULL;
		for (size_t i = 0; v != NULL && i < v->count; i++) {
			if (strcmp(v->keys[i], CST_ATTRIBUTE) == 0) continue;
			op_set_name(attributes, v->keys[i], plain(v->items[i]));
		}
		state = status_json(was);
	}
	op_set(o, "attributes", attributes);
	op_set(o, "status", state);
	const nd_entry *c = tb_get(table, tb_string("children"), tb_string(id));
	op_set(o, "children", c != NULL ? plain(c->value) : op_null());
	const nd_entry *v = tb_get(table, tb_string("value"), tb_string(id));
	op_set(o, "live", op_bool(v != NULL && hf_name(v->value) != NULL));
	free(id);
	return o;
}

// whether the entry at (part, id) (part none: attributes) was last written with this file as its
// site: the files differ by harness, so only yes or no
static op_value *site_json(const op_value *r) {
	const char *given = text(get(r, "id")), *part = text(get(r, "part"));
	char *id = take(given != NULL ? given : "");
	const nd_entry *e = tb_get(table, tb_string(part != NULL ? part : "attributes"), tb_string(id));
	free(id);
	int ours = e != NULL && e->change.external_length > 0 && e->change.external[0].file != NULL &&
		strcmp(e->change.external[0].file, __FILE__) == 0;
	return with("harness", op_bool(ours));
}

static op_value *running_json(void) {
	sw_process *const *list;
	size_t n = sw_running(software, &list);
	op_value *ids = op_list();
	for (size_t i = 0; i < n; i++) op_push(ids, op_str(sw_process_id(list[i])));
	return with("running", plain_take(ids));
}

static op_value *offers_json(void) {
	static const char *const kinds[3] = {"runners", "compilers", "surfaces"};
	const sw_offered *const *list;
	size_t n = sw_offers(software, &list);
	op_value *out = op_list();
	for (size_t i = 0; i < n; i++) {
		op_value *m = op_map();
		op_set(m, "id", op_str(list[i]->id));
		op_set(m, "at", names_json(list[i]->at, list[i]->nat));
		op_set(m, "kind", op_str(kinds[list[i]->kind]));
		op_set(m, "name", op_str(list[i]->name));
		op_set(m, "by", op_str(list[i]->by));
		op_push(out, m);
	}
	return with("offers", plain_take(out));
}

static op_value *two(const char *a, const op_value *x, const char *b, const op_value *y) {
	op_value *o = op_map();
	op_set(o, a, plain(x));
	op_set(o, b, plain(y));
	return o;
}

// requests ---------------------------------------------------------------------------------------

static op_value *answer(const op_value *r) {
	const char *op = hh_str(r, "op");
	if (op == NULL) return error("no op");
	if (!made) make();
	job j = {.r = r};
	const char *actor = hh_str(r, "actor");
	const op_value *bare = get(r, "bare");
	int is_bare = bare != NULL && bare->type == OP_BOOL && bare->bool_;
	if (strcmp(op, "kids") == 0 || strcmp(op, "attrs") == 0 || strcmp(op, "value") == 0) {
		j.part = op[0] == 'k' ? "children" : op[0] == 'a' ? "attributes" : "value";
		hosted(put_entry, &j, NULL, 0);
		return j.out;
	}
	if (strcmp(op, "create") == 0) return hosted(create_box, &j, NULL, 0), j.out;
	if (strcmp(op, "place") == 0) return place(r);
	if (strcmp(op, "close-place") == 0) return close_place(r);
	if (strcmp(op, "offer") == 0) return hosted(offer, &j, NULL, 0), j.out;
	if (strcmp(op, "withdraw") == 0) return hosted(withdraw, &j, NULL, 0), j.out;
	if (strcmp(op, "run") == 0) return hosted(run, &j, actor, 0), j.out;
	if (strcmp(op, "stop") == 0) return hosted(stop, &j, actor, 0), j.out;
	if (strcmp(op, "load") == 0) return hosted(load, &j, actor, is_bare), j.out;
	if (strcmp(op, "release") == 0) return hosted(release_named, &j, NULL, 0), j.out;
	if (strcmp(op, "land") == 0) return land(r);
	if (strcmp(op, "later") == 0) {
		size_t n = nasked;
		asking *fs = asked;
		asked = NULL, nasked = capasked = 0;
		for (size_t i = 0; i < n; i++) fs[i].f(fs[i].data), free(sc_escaped(s));
		free(fs);
		return with("pulses", op_num((double)n));
	}
	if (strcmp(op, "pulse") == 0) {
		sc_pulse(s);
		free(sc_escaped(s));
		return op_map();
	}
	if (strcmp(op, "here") == 0 || strcmp(op, "list") == 0) {
		bx *b = NULL;
		if (get(r, "box") != NULL && (b = box_of(hh_str(r, "box"))) == NULL) return error("no such box");
		pl *p = b != NULL ? bx_places(b) : places;
		if (op[0] == 'h') return with("id", plain_take(read_at(p, get(r, "path"), get_id)));
		return with("names", read_at(p, get(r, "path"), list_names));
	}
	if (strcmp(op, "node") == 0) return node_json(r);
	if (strcmp(op, "site") == 0) return site_json(r);
	if (strcmp(op, "raw") == 0) {
		const char *given = text(get(r, "name"));
		char *id = take(given != NULL ? given : "");
		op_value *out = with("id", op_str(id));
		free(id);
		return out;
	}
	if (strcmp(op, "running") == 0) return running_json();
	if (strcmp(op, "offers") == 0) return offers_json();
	if (strcmp(op, "runs") == 0) return two("runs", runs, "stops", stops);
	if (strcmp(op, "loads") == 0) return two("loads", loads, "unloads", unloads);
	if (strcmp(op, "told") == 0) return with("told", plain(told));
	if (strcmp(op, "order") == 0) return with("order", plain(order));
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) {
	op_value *a = answer(request);
	if (a == NULL) {
		hh_unknown(out, request);
		return;
	}
	op_json_write(out, a);
	op_free(a);
}

void hh_finish(void) {
	if (!made) return;
	// everything run here goes with the host's scope; then teller's apis, then their context
	free(sc_teardown(host));
	free(sc_escaped(s));
	for (size_t i = 0; i < ntellings; i++) {
		api_free(tellings[i]->a);
		free(tellings[i]->id);
		free(tellings[i]);
	}
	free(tellings);
	api_context_free(context);
	sw_halt(software);
	pr_halt(host_processes);
	sc_free(s);
	tb_free(table);
	pt_free(paths);
	pl_free(places);
	sw_free(software);
	pr_free(host_processes);
	for (size_t i = 0; i < nboxes; i++) bx_free(boxes[i].box), free(boxes[i].name);
	free(boxes);
	sn_free(scopes);
	hf_free(functions);
	op_free((op_value *)host_info.value);
	for (size_t i = 0; i < nplaced; i++) {
		placed *x = &places_named[i];
		free(x->name), free(x->id), op_free(x->value);
		for (size_t k = 0; k < x->nat; k++) free(x->at[k]);
		free(x->at);
	}
	free(places_named);
	for (size_t i = 0; i < nprocs; i++) free(procs[i].name);
	free(procs);
	for (size_t i = 0; i < nheld; i++) free(held[i].name);
	free(held);
	free(asked);
	for (size_t i = 0; i < nlandings; i++) free(landings[i].process);
	free(landings);
	for (size_t i = 0; i < nhandles; i++) free(handles[i]->process), free(handles[i]);
	free(handles);
	for (size_t i = 0; i < nnames; i++) free(names[i].id), free(names[i].name);
	free(names);
	op_free(runs), op_free(stops), op_free(loads), op_free(unloads), op_free(told), op_free(order);
}
