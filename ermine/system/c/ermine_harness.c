// the C ermine (ermine.h) on the line protocol of typescript/ermine_harness.ts, which documents it
// and the programs (conformance/c/harness.h has the loop). E's job, one request at a time:
//   the world: one ermine per run (a plain one, or the last "ermine" asked): root "R", the host's
//     scope { actor: "test" }, new ids "n1", "n2", … in order, a process's id "proc:<name>"; a
//     schedule that queues, run after every request till none is asked for
//   every op: ermine, features, late, uuid, node, context, o (resolve, write, remove, ask, within,
//     api), host, code, start, stop, status, close, service (land), record, waits,
//     slot, do, settle, log, pulse, saved, id, metadata, caller, site
//   programs as data steps: { do: [fn, ...args], as? }, "$x" in an arg, the forms (createMemo,
//     createEffect, createAction, addTeardown, getStatus, explain, peep, ref, log, later, if,
//     throw, each, pick, is, keys, whole, inc, explaincall, explainargs, explainfrom, share), and every es_
//     function called as it is. a program is an es_program whose ctx holds its steps; a memo's
//     function an es_compute whose ctx holds its expression; an action's an es_action whose ctx
//     holds its steps. a program's calls find their context with es_found (the imported
//     functions), the host's and a context op's use the context given
//   handles minted for the host's steps (a map of only id, path, part: es_handle_of), and shown in
//     answers as what they reach ("plain")
//   the test features of features_fixture.ts (an es_feature whose ctx holds the spec), their logs
//   "plain" answers: statuses, explains, records, errors as the TypeScript harness shows them
//     ({ error: code }, "refused", "feature" with feature, hook and cause, "pending", else the text)
// memory: every line is retained (hh_retain): the steps a memo, action or process keeps point into
// it, so the lines are let go of at hh_finish. an environment lives as long as anything that captured
// it, and what a step made for a memo, action, process or feature as long as the ermine: both the
// world's, freed with it (world_free, when a new ermine replaces it, and at hh_finish), after es_free.
// values held are op_ref'd. a site is the line that made it: a memo's or effect's is define's (the "computer" site),
// any other write here a "program" one. not written: a recipe for createPatch (patches only).
#define _POSIX_C_SOURCE 200809L
#include "../../../conformance/c/protocol_harness.h"
#include "../../../extensions/patchy/c/patch.h"
#include "ermine.h"
#include "ermine_harness.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#define TRY(call) \
	do { \
		int code_ = (call); \
		if (code_ != 0) return code_; \
	} while (0)

int (*hx_op)(const op_value *request, es_ermine *e, op_value **res);
pl *(*hx_places)(const char *name);

// --- the world -----------------------------------------------------------------------------------

// what a step's function acts as: the context given (the host's, a context op's), else the one the
// scope open finds, as the imported functions of @ermine/system do. host: remove and pulse too
typedef struct {
	es_context *fixed;
	int host;
} sys_t;

// the names a program's steps set, under the one that made it (an action's args are "0", "1" …)
typedef struct env env_t;
struct env {
	es_map vars;
	env_t *parent;
};

// a process the harness started: its start, and the environment its setup ended with
typedef struct {
	es_started *started;
	// its node's id; started is NULL for one a program started (its record is freed with its scope)
	char *id;
	env_t *env;
	int has_api;
} running_t;

// a program a code step made: its steps, and what it gives back
typedef struct {
	const op_value *steps;
	const op_value *back;
	const char *throws;
	int promise;
} program_t;

// a promise the harness made, settled at the next "settle" with expr's value (none: undefined)
typedef struct {
	es_promise *promise;
	sys_t sys;
	env_t *env;
	const op_value *expr;
} held_t;

typedef struct {
	void (*f)(void *data);
	void *data;
} queued_t;

// a deny entry of the request: every field given must match
typedef struct {
	char *op, *path, *id, *from, *box;
	int pending;
} deny_t;

// a test feature: its spec, and what its hooks keep
typedef struct {
	char *name;
	const op_value *spec;
	es_feature_api *api;
	es_slot *slot;
	long matched;
	op_value *held;
} tf_t;

// something the world holds on to: let go with free, else dtor
typedef struct {
	void *p;
	void (*dtor)(void *p);
} owned_t;

typedef struct {
	es_ermine *e;
	es_map running;
	es_map logs;
	es_map slots;
	es_map programs;
	es_map shared;
	es_map late;
	env_t *host;
	queued_t *queue;
	size_t nqueue, capqueue, head;
	held_t *held;
	size_t nheld, capheld;
	char *next, *pending;
	long counter;
	deny_t *deny;
	size_t ndeny;
	pr_policy *policy;
	op_value *actor;
	sc_pair info;
	char **args;
	size_t nargs;
	// what the host says of the person's event: 1 a person just interacted with the page
	int event;
	// patchy, when the ermine has it
	struct py *patchy;
	// what the world made and holds on to, let go with it
	owned_t *owned;
	size_t nowned, capowned;
	env_t **envs;
	size_t nenvs, capenvs;
} world_t;
static world_t *W;

static hh_line **lines;
static size_t nlines, caplines;

// memory the world holds on to: a step's state, a feature, a process: freed when the world is
static void *own_with(void *p, void (*dtor)(void *p)) {
	owned_t o = {p, dtor};
	ES_PUSH(W->owned, W->nowned, W->capowned, o);
	return p;
}
static void *own(void *p) { return own_with(p, NULL); }
static void *owned_alloc(size_t n) { return own(es_alloc(n)); }

// an environment lives as long as anything that captured it (a memo, an action, a promise, a process):
// the world's
static env_t *env_new(env_t *parent) {
	env_t *e = es_alloc(sizeof *e);
	e->parent = parent;
	ES_PUSH(W->envs, W->nenvs, W->capenvs, e);
	return e;
}
static op_value *env_get(const env_t *e, const char *name) {
	for (; e != NULL; e = e->parent) {
		if (es_map_has(&e->vars, name)) return es_map_get(&e->vars, name);
	}
	return NULL;
}
// takes v
static void env_set(env_t *e, const char *name, op_value *v) {
	op_value *old = es_map_get(&e->vars, name);
	es_map_set(&e->vars, name, v);
	op_free(old);
}

// --- small things ----------------------------------------------------------------------------------

static int fail(const char *format, ...) __attribute__((format(printf, 1, 2)));
static int fail(const char *format, ...) {
	char message[512];
	va_list args;
	va_start(args, format);
	vsnprintf(message, sizeof message, format, args);
	va_end(args);
	return es_fail_text(message);
}

static op_value *strs(size_t n, const char *const *s) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(s[i]));
	return list;
}
static op_value *names_value(const es_names *names) {
	return strs(names->n, (const char *const *)names->names);
}

static int is_str(const op_value *v) { return v != NULL && v->type == OP_STR; }

// a value a field holds in a request map, else NULL
static const op_value *field(const op_value *map, const char *key) {
	return map != NULL && map->type == OP_MAP ? op_get(map, key) : NULL;
}
// a spec flag: given and not false or null
static int flag(const op_value *spec, const char *key) {
	const op_value *v = field(spec, key);
	return v != NULL && v->type != OP_NULL && !(v->type == OP_BOOL && !v->bool_);
}
static const char *text(const op_value *spec, const char *key) {
	const op_value *v = field(spec, key);
	return is_str(v) ? v->str : NULL;
}
// a string field, else ""
static const char *str_or(const op_value *spec, const char *key) {
	const char *s = text(spec, key);
	return s != NULL ? s : "";
}

static void log_push(const char *name, op_value *v) {
	op_value *list = es_map_get(&W->logs, name);
	if (list == NULL) {
		list = op_list();
		es_map_set(&W->logs, name, list);
	}
	op_push(list, v != NULL ? v : op_null());
}

// the hooks' log: [name, hook, …more]
static void say(const tf_t *t, const char *hook, const char *a, const char *b, const char *c) {
	op_value *row = op_list();
	op_push(row, op_str(t->name));
	op_push(row, op_str(hook));
	if (a != NULL) op_push(row, op_str(a));
	if (b != NULL) op_push(row, op_str(b));
	if (c != NULL) op_push(row, op_str(c));
	log_push("hooks", row);
}

// a path as text, "/a/b", its empty names gone
static char *rooted(const char *p) {
	char *out = es_alloc(strlen(p) + 2), *w = out;
	*w++ = '/';
	const char *s = p;
	for (;;) {
		const char *e = strchr(s, '/');
		size_t len = e == NULL ? strlen(s) : (size_t)(e - s);
		if (len > 0) {
			if (w[-1] != '/') *w++ = '/';
			memcpy(w, s, len);
			w += len;
		}
		if (e == NULL) break;
		s = e + 1;
	}
	*w = '\0';
	return out;
}

// --- values: shown, and looked into ---------------------------------------------------------------------

static op_value *site_value(const ch_site *s) {
	op_value *m = op_map();
	op_set(m, "file", op_str(s->file != NULL ? s->file : ""));
	op_set(m, "line", op_int(s->line));
	if (s->has_column) op_set(m, "column", op_int(s->column));
	if (s->function != NULL) op_set(m, "function", op_str(s->function));
	return m;
}
static op_value *view_value(const es_change_view *v) {
	op_value *m = op_map();
	op_set(m, "time", op_int(v->time));
	op_set(m, "actor", v->actor != NULL ? op_ref((op_value *)v->actor) : op_null());
	if (v->has_site) op_set(m, "site", site_value(&v->site));
	return m;
}
static op_value *node_value(const es_node_data *n) {
	op_value *m = op_map();
	if (n->has_path) op_set(m, "path", strs(n->npath, (const char *const *)n->path));
	else op_set(m, "id", op_str(n->id));
	op_set(m, "part", op_str(n->part));
	return m;
}
// a stand-in a program may look into, as the object it is: a change view. new; NULL: none
static op_value *expand(const op_value *v) {
	const es_change_view *view = es_live_of(v, "view");
	if (view != NULL) return view_value(view);
	return NULL;
}

// v as an answer shows it: a handle what it reaches, a promise {}, a function "function", a view
// as its fields, a list and a map through. new
static op_value *plain(const op_value *v) {
	if (v == NULL) return NULL;
	if (v->type == OP_STAND) {
		const es_handle *h = es_live_of(v, "handle");
		if (h != NULL) {
			es_node_data node;
			if (W->e != NULL && es_data_of(W->e, h, &node)) {
				op_value *out = node_value(&node);
				es_node_data_free(&node);
				return out;
			}
			return op_str("a handle of no ermine");
		}
		if (W->e != NULL && es_promise_of(W->e, v) != NULL) return op_map();
		// a status node's PENDING, and an Error it holds (its message)
		if (cst_is_pending(v)) return op_str("PENDING");
		if (cst_error(v) != NULL) return op_str(cst_error(v));
		op_value *x = expand(v);
		if (x != NULL) {
			op_value *out = plain(x);
			op_free(x);
			return out;
		}
		// a function placed; any other stand-in is data
		if (es_live_of(v, "function") != NULL) return op_str("function");
		// a writer, and what start gave to stop and ask the status: functions to the program
		if (es_live_of(v, "runner") != NULL || es_live_of(v, "stop") != NULL ||
			es_live_of(v, "status") != NULL) {
			return op_str("function");
		}
		return op_ref((op_value *)v);
	}
	if (v->type == OP_LIST) {
		op_value *list = op_list();
		for (size_t i = 0; i < v->count; i++) {
			op_value *x = plain(v->items[i]);
			op_push(list, x != NULL ? x : op_null());
		}
		return list;
	}
	if (v->type == OP_MAP) {
		op_value *map = op_map();
		for (size_t i = 0; i < v->count; i++) {
			op_value *x = plain(v->items[i]);
			if (x != NULL) op_set(map, v->keys[i], x);
		}
		return map;
	}
	return op_ref((op_value *)v);
}

// the value at a path in v, as places' at: a name into a map, a number (or a number's text) into a
// list. new; NULL: nothing there
static op_value *value_at(const op_value *v, const op_value *path) {
	op_value *cur = op_ref((op_value *)v);
	for (size_t i = 0; path != NULL && path->type == OP_LIST && i < path->count && cur != NULL; i++) {
		const op_value *k = path->items[i];
		op_value *x = expand(cur);
		if (x != NULL) {
			op_free(cur);
			cur = x;
		}
		op_value *next = NULL;
		if (cur->type == OP_MAP && is_str(k)) {
			next = op_ref(op_get(cur, k->str));
		} else if (cur->type == OP_LIST) {
			long at = -1;
			if (k->type == OP_NUM) at = (long)k->num;
			else if (is_str(k) && k->str[0] >= '0' && k->str[0] <= '9') at = atol(k->str);
			if (at >= 0 && (size_t)at < cur->count) next = op_ref(cur->items[at]);
		}
		op_free(cur);
		cur = next;
	}
	return cur;
}

// Object.is: scalars by value, anything else by identity (a handle, promise or function by what it
// holds)
static int same_value(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return op_same_num(a, b);
	case OP_STR: return strcmp(a->str, b->str) == 0;
	case OP_STAND: {
		static const char *const kinds[] = {"handle", "promise", "function", "program", "view"};
		for (size_t i = 0; i < sizeof kinds / sizeof *kinds; i++) {
			const void *x = es_live_of(a, kinds[i]);
			if (x != NULL) return x == es_live_of(b, kinds[i]);
		}
		return 0;
	}
	default: return 0;
	}
}

// "$x" anywhere in an argument (inside lists and maps too)
static int has_name(const op_value *a) {
	if (a == NULL) return 0;
	if (a->type == OP_STR) return a->str[0] == '$';
	if (a->type == OP_LIST || a->type == OP_MAP) {
		for (size_t i = 0; i < a->count; i++) {
			if (has_name(a->items[i])) return 1;
		}
	}
	return 0;
}
// "$x" is the name x (undefined when unset), anywhere in an argument; anything else as it is. new
static op_value *arg(const env_t *env, const op_value *a) {
	if (a == NULL) return NULL;
	if (!has_name(a)) return op_ref((op_value *)a);
	if (a->type == OP_STR) return op_ref(env_get(env, a->str + 1));
	if (a->type == OP_LIST) {
		op_value *list = op_list();
		for (size_t i = 0; i < a->count; i++) {
			op_value *x = arg(env, a->items[i]);
			op_push(list, x != NULL ? x : op_null());
		}
		return list;
	}
	op_value *map = op_map();
	for (size_t i = 0; i < a->count; i++) {
		op_value *x = arg(env, a->items[i]);
		op_set(map, a->keys[i], x != NULL ? x : op_null());
	}
	return map;
}

// --- what an argument is -------------------------------------------------------------------------------

// a path: text, or a list of names
static int at_of(const op_value *v, es_at *out) {
	if (is_str(v)) {
		*out = es_text(v->str);
		return 0;
	}
	if (v != NULL && v->type == OP_LIST) {
		const char **steps = hh_take((v->count + 1) * sizeof *steps);
		for (size_t i = 0; i < v->count; i++) {
			if (!is_str(v->items[i])) return fail("a path is text or a list of names");
			steps[i] = v->items[i]->str;
		}
		*out = es_steps(steps, v->count);
		return 0;
	}
	return fail("a path is text or a list of names");
}
#define NOT_A_HANDLE \
	"not-a-handle: a node is given by @ermine/system's functions (getNode, ensureNode, createMemo …) or a path, never written as an object"
// a target: a handle (one of this ermine's), else a path; an object no handle: not-a-handle
static int target_of(const op_value *v, es_target *out) {
	if (v != NULL && v->type == OP_STAND) {
		const es_handle *h = W->e != NULL ? es_handle_in(W->e, v) : NULL;
		if (h == NULL) return es_fail(ES_NOT_A_HANDLE, NOT_A_HANDLE);
		*out = es_on_node(h);
		return 0;
	}
	if (is_str(v) || (v != NULL && v->type == OP_LIST)) {
		es_at at;
		TRY(at_of(v, &at));
		*out = es_on_path(at);
		return 0;
	}
	return es_fail(ES_NOT_A_HANDLE, NOT_A_HANDLE);
}
// a read's key: a list of names and numbers; none given: no key
static int keys_of(const op_value *v, const op_key **out, size_t *n) {
	*out = NULL;
	*n = 0;
	if (v == NULL) return 0;
	if (v->type != OP_LIST) return fail("a key is a list of names and numbers");
	op_key *keys = hh_take((v->count + 1) * sizeof *keys);
	for (size_t i = 0; i < v->count; i++) {
		const op_value *x = v->items[i];
		if (is_str(x)) keys[i] = (op_key){.type = OP_STR_KEY, .s = x->str};
		else if (x->type == OP_NUM) keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)x->num};
		else return fail("a key is a list of names and numbers");
	}
	*out = keys;
	*n = v->count;
	return 0;
}
// patches: a list of { path, value?, move? }
static int patches_of(const op_value *v, const op_patch **out, size_t *n) {
	if (v == NULL || v->type != OP_LIST) {
		return es_fail(ES_NOT_PATCHES, "not-patches: patch takes patches: [{ path, value }]");
	}
	op_patch *ps = hh_take((v->count + 1) * sizeof *ps);
	for (size_t i = 0; i < v->count; i++) hh_patch(v->items[i], &ps[i]);
	*out = ps;
	*n = v->count;
	return 0;
}

// --- results, as a program is given them ----------------------------------------------------------------

static op_value *version_value(const es_version *v) {
	op_value *m = op_map();
	if (v->value != NULL) op_set(m, "value", op_ref((op_value *)v->value));
	op_value *from = op_map();
	if (v->from.view != NULL) op_set(from, "change", es_live("view", v->from.view));
	if (v->from.kind != NULL) op_set(from, "kind", op_str(v->from.kind));
	if (v->from.feature != NULL) op_set(from, "feature", op_str(v->from.feature));
	if (v->from.more != NULL && v->from.more->type == OP_MAP) {
		for (size_t i = 0; i < v->from.more->count; i++) {
			op_set(from, v->from.more->keys[i], op_ref(v->from.more->items[i]));
		}
	}
	op_set(m, "from", from);
	if (v->gone) op_set(m, "gone", op_bool(1));
	if (v->inside) op_set(m, "inside", op_bool(1));
	return m;
}
static op_value *versions_value(const es_versions *vs) {
	op_value *list = op_list();
	for (size_t i = 0; i < vs->n; i++) op_push(list, version_value(&vs->items[i]));
	return list;
}
static op_value *items_value(const es_items *items) {
	op_value *list = op_list();
	for (size_t i = 0; i < items->n; i++) {
		const es_item *it = &items->items[i];
		op_value *m = op_map();
		if (it->value != NULL) op_set(m, "value", op_ref((op_value *)it->value));
		op_set(m, "from", op_str(it->from));
		if (it->node != NULL) op_set(m, "node", es_handle_value(it->node));
		if (it->refused) op_set(m, "refused", op_bool(1));
		op_push(list, m);
	}
	return list;
}

// a path as a node is seen: names, or null when outside
static op_value *path_value(int has_path, char *const *path, size_t n) {
	return has_path ? strs(n, (const char *const *)path) : op_null();
}

static op_value *status_value(const es_status *st) {
	op_value *m = op_map();
	op_set(m, "state", op_str(st->state));
	if (st->has_held) {
		op_value *h = op_map();
		op_set(h, "feature", op_str(st->held_feature));
		op_set(h, "write", op_str(st->held_write));
		op_set(m, "held", h);
	}
	if (st->error != NULL) op_set(m, "error", op_str(st->error));
	if (st->phase != NULL) op_set(m, "phase", op_str(st->phase));
	if (st->nwaiting > 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < st->nwaiting; i++) {
			const es_waiting *w = &st->waiting[i];
			op_value *x = NULL;
			switch (w->kind) {
			case ES_WAIT_NODE:
				x = op_map();
				op_set(x, "node", path_value(w->has_path, w->path, w->npath));
				break;
			case ES_WAIT_SEND:
				x = op_map();
				op_set(x, "send", path_value(w->has_path, w->path, w->npath));
				break;
			case ES_WAIT_CODE:
				x = op_map();
				op_set(x, "code", path_value(w->has_path, w->path, w->npath));
				break;
			case ES_WAIT_PROMISE: x = op_str("a promise"); break;
			case ES_WAIT_PENDING: x = op_str("PENDING"); break;
			}
			op_push(list, x);
		}
		op_set(m, "waiting", list);
	}
	if (st->has_n) op_set(m, "n", op_int(st->n));
	if (st->more != NULL && st->more->type == OP_MAP) {
		for (size_t i = 0; i < st->more->count; i++) {
			op_set(m, st->more->keys[i], op_ref(st->more->items[i]));
		}
	}
	return m;
}

// where a site is: "none", a process's setup's ("setup": the function it is given), the harness's own
// ("computer" for the line define made, else "program"), ermine's files ("api"), any other ("other")
static const char *site_of(const ch_site *s) {
	if (s == NULL) return "none";
	if (s->function != NULL && strcmp(s->function, "setup") == 0) return "setup";
	if (s->file != NULL && strcmp(s->file, __FILE__) == 0) {
		return s->function != NULL && strcmp(s->function, "define") == 0 ? "computer" : "program";
	}
	static const char *const ours[] = {"nodes.c", "computers.c", "actions.c", "host.c"};
	const char *file = s->file != NULL ? s->file : "";
	const char *base = strrchr(file, '/');
	base = base != NULL ? base + 1 : file;
	for (size_t i = 0; i < sizeof ours / sizeof *ours; i++) {
		if (strcmp(base, ours[i]) == 0) return "api";
	}
	return "other";
}

// an explain, as the harness shows it; none for none
static op_value *explained_value(const es_explained *x) {
	if (x == NULL) return NULL;
	op_value *m = op_map();
	if (x->has_writer) {
		const es_writer *w = &x->writer;
		switch (w->kind) {
		case ES_WRITER_COMPUTER:
			op_set(m, "writer", op_str("computer"));
			op_set(m, "path", path_value(w->has_path, w->path, w->npath));
			if (w->run != NULL) op_set(m, "n", op_int(w->run->n));
			break;
		case ES_WRITER_ACTION:
			op_set(m, "writer", op_str("method"));
			op_set(m, "path", path_value(w->has_path, w->path, w->npath));
			if (w->call != NULL) op_set(m, "n", op_int(w->call->n));
			break;
		case ES_WRITER_OUTSIDE:
			op_set(m, "writer", op_str("outside"));
			op_set(m, "site", op_str(site_of(w->has_site ? &w->site : NULL)));
			break;
		}
	}
	if (x->change != NULL && x->change->user_activated) op_set(m, "userActivated", op_bool(1));
	if (x->has_held) {
		op_value *h = op_map();
		op_set(h, "feature", op_str(x->held_feature));
		op_set(m, "held", h);
	}
	return m;
}

// --- errors, as an answer shows them ----------------------------------------------------------------------

// { error }, from the code a function returned and what it threw
static op_value *error_value(int code) {
	op_value *m = op_map();
	const es_error *t = es_thrown();
	switch (code) {
	case ES_PENDING: op_set(m, "error", op_str("pending")); break;
	case ES_REFUSED:
		op_set(m, "error", op_str("refused"));
		if (t->feature != NULL) {
			op_set(m, "feature", op_str(t->feature));
			op_set(m, "hook", op_str(t->hook != NULL ? t->hook : ""));
		}
		break;
	case ES_FEATURE:
		op_set(m, "error", op_str("feature"));
		op_set(m, "feature", op_str(t->feature != NULL ? t->feature : ""));
		op_set(m, "hook", op_str(t->hook != NULL ? t->hook : ""));
		op_set(m, "cause", op_str(t->cause != NULL ? t->cause : ""));
		break;
	case ES_FAILED: {
		const char *message = t->message != NULL ? t->message : "";
		char *s = es_alloc(strlen(message) + 8);
		sprintf(s, "Error: %s", message);
		op_set(m, "error", op_str_take(s, strlen(s)));
		break;
	}
	default: op_set(m, "error", op_str(es_code_name(code))); break;
	}
	return m;
}

// --- the interpreter ------------------------------------------------------------------------------------------

struct py;
static es_feature *py_feature(void);
static int lib_run(void *ctx);
static es_out land_run(es_context *c, void *ctx, const op_value *const *args, size_t nargs);
static int expr(sys_t sys, env_t *env, const op_value *e, op_value **out);
static int call_form(sys_t sys, env_t *env, const op_value *form, op_value **out);
static es_out program_run(es_context *c, void *ctx);

static es_context *sys_ctx(sys_t sys, const char *name) {
	return sys.fixed != NULL ? sys.fixed : es_found(name);
}
#define CTX(name) \
	es_context *c = sys_ctx(sys, name); \
	if (c == NULL) return es_thrown()->code
#define A(i) ((size_t)(i) < n ? a[i] : NULL)

static int run_steps(sys_t sys, env_t *env, const op_value *steps) {
	for (size_t i = 0; steps != NULL && steps->type == OP_LIST && i < steps->count; i++) {
		const op_value *step = steps->items[i];
		op_value *v = NULL;
		TRY(call_form(sys, env, field(step, "do"), &v));
		const char *as = text(step, "as");
		if (as != NULL) env_set(env, as, v);
		else op_free(v);
	}
	return 0;
}

// a value's JSON, as JSON.stringify gives it ("undefined" for none)
static char *json_of(const op_value *v) { return v == NULL ? es_dup("undefined") : op_json_text(v); }

// a memo or effect: its expression, and the effect's log
typedef struct {
	sys_t sys;
	env_t *env;
	const op_value *expr;
	const char *to;
	int throws;
	// an effect's act: steps to run in it (an error they throw logged to caught), a cleanup it gives
	// (logs [cleanup, v]), a value it returns as it is
	const op_value *act, *returns;
	const char *caught, *cleanup;
	int has_returns;
} comp_t;

static es_out comp_compute(es_context *c, void *ctx, const op_value *previous) {
	(void)c;
	(void)previous;
	comp_t *k = ctx;
	op_value *v = NULL;
	int code = expr(k->sys, k->env, k->expr, &v);
	if (code != 0) return es_out_code(code);
	return es_out_of(v);
}
static int comp_equal(void *ctx, const op_value *a, const op_value *b) {
	(void)ctx;
	char *x = json_of(a), *y = json_of(b);
	int same = strcmp(x, y) == 0;
	free(x);
	free(y);
	return same;
}
// a cleanup an act gave: logs its name, with the value the act was given
typedef struct {
	const char *log;
	op_value *value;
} cleanup_t;
static void cleanup_run(void *ctx, const char *why) {
	(void)why;
	cleanup_t *k = ctx;
	log_push(k->log, op_ref(k->value));
}
static void cleanup_free(void *p) {
	cleanup_t *k = p;
	op_free(k->value);
	free(k);
}

// what an error is logged as: its code, else its message
static op_value *code_text(int code) {
	const es_error *t = es_thrown();
	if (code == ES_FAILED) return op_str(t->message != NULL ? t->message : "");
	return op_str(es_code_name(code));
}

// what typeof says of a value
static const char *type_of(const op_value *v) {
	if (v == NULL) return "undefined";
	switch (v->type) {
	case OP_BOOL: return "boolean";
	case OP_NUM: return "number";
	case OP_STR: return "string";
	default: return "object";
	}
}

static int comp_act(es_context *c, void *ctx, const op_value *value, const op_value *before) {
	(void)before;
	comp_t *k = ctx;
	log_push(k->to, op_ref((op_value *)value));
	if (k->throws) {
		char *j = json_of(value);
		int code = fail("act %s", j);
		free(j);
		return code;
	}
	if (k->act != NULL) {
		int code = run_steps(k->sys, env_new(k->env), k->act);
		if (code != 0) {
			log_push(k->caught != NULL ? k->caught : "caught", code_text(code));
			es_clear_thrown();
		}
	}
	if (k->cleanup != NULL) {
		cleanup_t *cl = es_alloc(sizeof *cl);
		cl->log = k->cleanup;
		cl->value = op_ref((op_value *)value);
		own_with(cl, cleanup_free);
		TRY(es_cleanup(c, cleanup_run, cl));
	}
	// C's act gives no value: the one an interpreted act is to return is checked here, as the
	// TypeScript checks what it returned
	if (k->has_returns) {
		return es_fail_ermine(ES_BAD_CLEANUP,
			"an effect's act returned %s: return a function (its cleanup), or nothing",
			type_of(k->returns));
	}
	return 0;
}

// createMemo, createEffect: the node's site is this function's line
static int define(sys_t sys, env_t *env, const char *fn, const op_value *const *raw, size_t n,
	op_value **out) {
	CTX(fn);
	es_at name;
	es_handle *h;
	comp_t *k = owned_alloc(sizeof *k);
	k->sys = sys;
	k->env = env;
	TRY(at_of(n > 0 ? raw[0] : NULL, &name));
	if (strcmp(fn, "createMemo") == 0) {
		const op_value *options = n > 1 ? raw[1] : NULL;
		k->expr = n > 2 ? raw[2] : NULL;
		int json = strcmp(str_or(options, "equal"), "json") == 0;
		es_computed_options o = {.equal = json ? comp_equal : NULL, .equal_ctx = k};
		TRY(es_create_memo(c, name, comp_compute, k, &o, &h));
	} else {
		const op_value *options = n > 4 ? raw[4] : NULL;
		k->expr = n > 1 ? raw[1] : NULL;
		k->to = n > 2 && is_str(raw[2]) ? raw[2]->str : "";
		k->throws = n > 3 && is_str(raw[3]) && strcmp(raw[3]->str, "throws") == 0;
		es_computed_options o = {.early = flag(options, "early")};
		k->act = field(options, "act");
		k->caught = text(options, "caught");
		k->cleanup = text(options, "cleanup");
		k->returns = field(options, "returns");
		k->has_returns = field(options, "returns") != NULL;
		TRY(es_create_effect(c, name, comp_compute, comp_act, k, &o, &h));
	}
	*out = es_handle_value(h);
	return 0;
}

// an action: its steps, and what it gives back
typedef struct {
	sys_t sys;
	env_t *env;
	const op_value *steps, *back;
} act_t;
static env_t *act_env(const act_t *k, const op_value *const *args, size_t nargs) {
	env_t *inner = env_new(k->env);
	for (size_t i = 0; i < nargs; i++) {
		char name[24];
		snprintf(name, sizeof name, "%zu", i);
		env_set(inner, name, op_ref((op_value *)args[i]));
	}
	return inner;
}
static es_out act_run(es_context *c, void *ctx, const op_value *const *args, size_t nargs) {
	(void)c;
	act_t *k = ctx;
	env_t *inner = act_env(k, args, nargs);
	int code = run_steps(k->sys, inner, k->steps);
	if (code != 0) return es_out_code(code);
	if (k->back == NULL) return es_out_of(NULL);
	op_value *v = NULL;
	code = expr(k->sys, inner, k->back, &v);
	if (code != 0) return es_out_code(code);
	return es_out_of(v);
}

// a generator action: C has no generators, so the system does not step one. its steps run in order, a
// {do: ["yield", expr]} waiting for the promise expr gives, and the rest of it runs through the runner
// the action bound, so it is under the call's mark as the TypeScript's stepped steps are. the call
// gives a promise of its return
typedef struct {
	act_t *a;
	env_t *inner;
	size_t at;
	// where the value a yield waited for goes
	const char *as;
	es_promise *result;
	op_value *runner;
	// the promise a yield waited for, how it settled
	int ok;
	op_value *value;
	char *error;
	// the end: how the result is to be settled
	int finished, failed;
	op_value *returned;
	char *failure;
} gen_t;

static int gen_steps(gen_t *g);
static int gen_resume(void *ctx);

static void gen_resumed(void *ctx, int ok, const op_value *value, const char *error) {
	gen_t *g = ctx;
	g->ok = ok;
	op_free(g->value);
	g->value = ok ? op_ref((op_value *)value) : NULL;
	free(g->error);
	g->error = ok ? NULL : es_dup(error != NULL ? error : "error");
	// nothing is open as a promise settles: the writer brings the rest back under the mark
	int code = es_with_writer(W->e, g->runner, gen_resume, g);
	if (code != 0 && !g->finished) {
		g->finished = g->failed = 1;
		const es_error *t = es_thrown();
		g->failure = es_dup(t->message != NULL ? t->message : es_code_name(code));
	}
	if (!g->finished) return;
	es_drop_writer(W->e, g->runner);
	if (g->failed) es_promise_reject(g->result, g->failure);
	else es_promise_resolve(g->result, g->returned);
	g->returned = NULL;
}

// a yield's value is back (or its throw: the generator has no catch, so it ends with it)
static int gen_resume(void *ctx) {
	gen_t *g = ctx;
	if (!g->ok) {
		g->finished = g->failed = 1;
		g->failure = es_dup(g->error);
		return 0;
	}
	if (g->as != NULL) env_set(g->inner, g->as, g->value);
	else op_free(g->value);
	g->value = NULL;
	return gen_steps(g);
}

// from the step at, to the next yield that waits, or the end
static int gen_steps(gen_t *g) {
	act_t *k = g->a;
	while (k->steps != NULL && g->at < k->steps->count) {
		const op_value *step = k->steps->items[g->at++];
		const op_value *form = field(step, "do");
		const char *as = text(step, "as");
		if (form != NULL && form->type == OP_LIST && form->count > 1 && is_str(form->items[0]) &&
			strcmp(form->items[0]->str, "yield") == 0) {
			op_value *v = NULL;
			int code = expr(k->sys, g->inner, form->items[1], &v);
			if (code != 0) {
				const es_error *t = es_thrown();
				g->finished = g->failed = 1;
				g->failure = es_dup(t->message != NULL ? t->message : es_code_name(code));
				return 0;
			}
			es_promise *p = v == NULL ? NULL : es_promise_of(W->e, v);
			if (p != NULL) {
				g->as = as;
				es_promise_then(p, gen_resumed, g);
				op_free(v);
				return 0;
			}
			if (as != NULL) env_set(g->inner, as, v);
			else op_free(v);
			continue;
		}
		op_value *v = NULL;
		int code = call_form(k->sys, g->inner, form, &v);
		if (code != 0) {
			const es_error *t = es_thrown();
			g->finished = g->failed = 1;
			g->failure = es_dup(t->message != NULL ? t->message : es_code_name(code));
			return 0;
		}
		if (as != NULL) env_set(g->inner, as, v);
		else op_free(v);
	}
	g->finished = 1;
	if (k->back == NULL) return 0;
	int code = expr(k->sys, g->inner, k->back, &g->returned);
	if (code != 0) {
		const es_error *t = es_thrown();
		g->failed = 1;
		g->failure = es_dup(t->message != NULL ? t->message : es_code_name(code));
	}
	return 0;
}

static void gen_free(void *p) {
	gen_t *g = p;
	op_free(g->runner);
	op_free(g->value);
	op_free(g->returned);
	free(g->error);
	free(g->failure);
	free(g);
}

static es_out gen_run(es_context *c, void *ctx, const op_value *const *args, size_t nargs) {
	act_t *k = ctx;
	gen_t *g = es_alloc(sizeof *g);
	own_with(g, gen_free);
	g->a = k;
	g->inner = act_env(k, args, nargs);
	g->result = es_promise_new(W->e);
	int code = es_create_writer(c, &g->runner);
	if (code != 0) return es_out_code(code);
	gen_steps(g);
	op_value *p = es_promise_value(g->result);
	if (g->finished) {
		// settled at once: kept (a settled promise let go of is data), the world's
		es_drop_writer(W->e, g->runner);
		if (g->failed) es_promise_reject(g->result, g->failure);
		else es_promise_resolve(g->result, g->returned);
		g->returned = NULL;
	} else {
		es_promise_release(g->result);
	}
	return es_out_of(p);
}

// "share": one function per name, giving the node of the nearest scope above the one open
static es_out share_run(es_context *c, void *ctx, const op_value *const *args, size_t nargs) {
	(void)c;
	(void)ctx;
	(void)args;
	(void)nargs;
	for (sc_scope *o = sc_get_current_scope(W->e->scheduler); o != NULL; o = sc_scope_parent(o)) {
		const sc_info *info = sc_scope_info(o);
		for (size_t i = 0; i < info->n; i++) {
			if (strcmp(info->pairs[i].key, PL_NODE) == 0) {
				return es_out_of(op_ref((op_value *)info->pairs[i].value));
			}
		}
	}
	return es_out_of(op_null());
}

// a promise the harness makes, settled at "settle" with the expression's value
static op_value *promised(sys_t sys, env_t *env, const op_value *e) {
	held_t h = {es_promise_new(W->e), sys, env, e};
	ES_PUSH(W->held, W->nheld, W->capheld, h);
	return es_promise_value(h.promise);
}

// a promise a call gave: how it settled is logged to "promised" ([value], or ["rejected", message])
static void watched_run(void *ctx, int ok, const op_value *value, const char *error) {
	(void)ctx;
	op_value *row = op_list();
	if (ok) {
		op_push(row, value != NULL ? op_ref((op_value *)value) : op_null());
	} else {
		op_push(row, op_str("rejected"));
		op_push(row, op_str(error != NULL ? error : "error"));
	}
	log_push("promised", row);
}
static void watched(const op_value *v) {
	es_promise *p = v == NULL ? NULL : es_promise_of(W->e, v);
	if (p != NULL) es_promise_then(p, watched_run, NULL);
}

// a library function's call: its raw arguments, its environment, and what it gives
typedef struct {
	env_t *env;
	const op_value *const *raw;
	size_t nraw;
	int layers;
	op_value *out;
} lib_t;

typedef struct {
	sys_t sys;
	env_t *env;
	const op_value *expr;
	op_value *out;
} peep_t;
static int peep_run(void *ctx) {
	peep_t *k = ctx;
	return expr(k->sys, k->env, k->expr, &k->out);
}

typedef struct {
	const char *log, *tag;
} td_t;
static void td_run(void *ctx, const char *why) {
	td_t *k = ctx;
	if (k->tag == NULL) {
		log_push(k->log, op_str(why));
		return;
	}
	char *s = es_alloc(strlen(k->tag) + strlen(why) + 2);
	sprintf(s, "%s:%s", k->tag, why);
	log_push(k->log, op_str_take(s, strlen(s)));
}

// ref's maker: the value given
static op_value *ref_make(void *ctx) { return op_ref(ctx); }

// --- the process api, as a step calls it ----------------------------------------------------------------------

// a step's function: its arguments (with "$x" given), the context it acts as, what it gives back
typedef int (*api_fn)(sys_t sys, op_value *const *a, size_t n, op_value **out);

static int api_get_node(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("getNode");
	es_at at;
	es_handle *h;
	TRY(at_of(A(0), &at));
	TRY(es_get_node(c, at, &h));
	*out = es_handle_value(h);
	return 0;
}
static int api_has_node(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("hasNode");
	es_target x;
	int has;
	TRY(target_of(A(0), &x));
	TRY(es_has_node(c, x, &has));
	*out = op_bool(has);
	return 0;
}
static int api_ensure_node(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("ensureNode");
	es_at at;
	es_handle *h;
	TRY(at_of(A(0), &at));
	TRY(es_ensure_node(c, at, A(1), &h));
	*out = es_handle_value(h);
	return 0;
}
static int api_create_node(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("createNode");
	es_at at;
	es_handle *h;
	TRY(at_of(A(0), &at));
	TRY(es_create_node(c, at, A(1), &h));
	*out = es_handle_value(h);
	return 0;
}

// read and readAttributes: the value, as a program holds it
static int read_with(sys_t sys, const char *name, op_value *const *a, size_t n, op_value **out,
	int (*f)(es_context *, es_target, const op_key *, size_t, const op_value **)) {
	CTX(name);
	es_target x;
	const op_key *key;
	size_t nkey;
	const op_value *v = NULL;
	TRY(target_of(A(0), &x));
	TRY(keys_of(A(1), &key, &nkey));
	TRY(f(c, x, key, nkey, &v));
	*out = op_ref((op_value *)v);
	return 0;
}
static int api_read(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	return read_with(sys, "read", a, n, out, es_read);
}
static int api_read_attributes(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	return read_with(sys, "readAttributes", a, n, out, es_read_attributes);
}
static int api_read_children(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("readChildren");
	es_target x;
	es_children kids;
	TRY(target_of(A(0), &x));
	TRY(es_read_children(c, x, &kids));
	op_value *m = op_map();
	for (size_t i = 0; i < kids.n; i++) op_set(m, kids.names[i], es_handle_value(kids.nodes[i]));
	es_children_free(&kids);
	*out = m;
	return 0;
}
static int all_with(sys_t sys, const char *name, op_value *const *a, size_t n, op_value **out,
	int (*f)(es_context *, es_target, const op_key *, size_t, es_versions *)) {
	CTX(name);
	es_target x;
	const op_key *key;
	size_t nkey;
	es_versions vs = {0};
	TRY(target_of(A(0), &x));
	TRY(keys_of(A(1), &key, &nkey));
	TRY(f(c, x, key, nkey, &vs));
	*out = versions_value(&vs);
	es_versions_free(&vs);
	return 0;
}
static int api_read_all(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	return all_with(sys, "readAll", a, n, out, es_read_all);
}
static int api_read_all_attributes(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	return all_with(sys, "readAllAttributes", a, n, out, es_read_all_attributes);
}
static int api_read_all_children(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("readAllChildren");
	es_target x;
	es_versions vs = {0};
	TRY(target_of(A(0), &x));
	TRY(es_read_all_children(c, x, &vs));
	*out = versions_value(&vs);
	es_versions_free(&vs);
	return 0;
}
static int api_read_entries(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("readEntries");
	es_target x;
	es_items items = {0};
	TRY(target_of(A(0), &x));
	TRY(es_read_entries(c, x, &items));
	*out = items_value(&items);
	es_items_free(&items);
	return 0;
}
static int api_patch(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)out;
	CTX("patch");
	es_target x;
	const op_patch *ps;
	size_t np;
	TRY(target_of(A(0), &x));
	TRY(patches_of(A(1), &ps, &np));
	return es_patch(c, x, ps, np);
}
static int api_patch_attributes(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)out;
	CTX("patchAttributes");
	es_target x;
	const op_patch *ps;
	size_t np;
	TRY(target_of(A(0), &x));
	TRY(patches_of(A(1), &ps, &np));
	return es_patch_attributes(c, x, ps, np);
}
static int api_patch_children(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)out;
	CTX("patchChildren");
	es_target x;
	const op_patch *ps;
	size_t np;
	TRY(target_of(A(0), &x));
	TRY(patches_of(A(1), &ps, &np));
	return es_patch_children(c, x, ps, np);
}

// explain: the change at x (or a change a program was shown), who made it. none: *ex NULL
static int explain_ex(sys_t sys, const char *name, op_value *const *a, size_t n, es_explained **ex) {
	CTX(name);
	*ex = NULL;
	const es_change_view *view = es_live_of(A(0), "view");
	if (view != NULL) return es_explain_view(c, view, ex);
	es_target x;
	const op_key *key;
	size_t nkey;
	TRY(target_of(A(0), &x));
	if (strcmp(name, "explainAttributes") == 0) return es_explain_attributes(c, x, ex);
	if (strcmp(name, "explainChildren") == 0) return es_explain_children(c, x, ex);
	TRY(keys_of(A(1), &key, &nkey));
	return es_explain(c, x, key, nkey, ex);
}
static int explain_with(sys_t sys, const char *name, op_value *const *a, size_t n, op_value **out) {
	es_explained *ex = NULL;
	TRY(explain_ex(sys, name, a, n, &ex));
	*out = explained_value(ex);
	es_explained_free(ex);
	return 0;
}
static int api_explain(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	return explain_with(sys, "explain", a, n, out);
}
static int api_explain_attributes(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	return explain_with(sys, "explainAttributes", a, n, out);
}
static int api_explain_children(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	return explain_with(sys, "explainChildren", a, n, out);
}

static int api_place(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)out;
	CTX("place");
	es_at at;
	es_target x;
	TRY(at_of(A(0), &at));
	TRY(target_of(A(1), &x));
	return es_place(c, at, x);
}
static int api_unplace(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)out;
	CTX("unplace");
	es_at at;
	TRY(at_of(A(0), &at));
	return es_unplace(c, at);
}
static int api_rename(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)out;
	CTX("rename");
	es_at from, to;
	TRY(at_of(A(0), &from));
	TRY(at_of(A(1), &to));
	return es_rename(c, from, to);
}
static int api_list(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("list");
	es_target x;
	es_names names = {0};
	TRY(target_of(A(0), &x));
	TRY(es_list(c, x, &names));
	*out = names_value(&names);
	es_names_free(&names);
	return 0;
}
static int api_execute_action(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	CTX("executeAction");
	es_target x;
	op_value *returned = NULL;
	TRY(target_of(A(0), &x));
	TRY(es_execute_action(c, x, (const op_value *const *)(n > 1 ? a + 1 : a), n > 1 ? n - 1 : 0,
		&returned));
	*out = returned;
	return 0;
}
static int api_get_caller(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)a;
	(void)n;
	CTX("getCaller");
	es_caller who;
	if (!es_get_caller(c, &who)) return 0;
	op_value *m = op_map();
	op_set(m, "actor", who.actor != NULL ? op_ref((op_value *)who.actor) : op_null());
	if (who.has_process) op_set(m, "process", names_value(&who.process));
	es_caller_free(&who);
	*out = m;
	return 0;
}
static int api_get_args(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)a;
	(void)n;
	CTX("getArgs");
	size_t count;
	const char *const *args = es_get_args(c, &count);
	*out = strs(count, args);
	return 0;
}
static int api_remove(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)out;
	CTX("remove");
	es_target x;
	TRY(target_of(A(0), &x));
	return es_remove(c, x);
}
static int api_pulse(sys_t sys, op_value *const *a, size_t n, op_value **out) {
	(void)a;
	(void)n;
	(void)out;
	CTX("pulse");
	return es_pulse(c);
}

// @ermine/system's functions by name; host: the ermine object's only
static const struct {
	const char *name;
	api_fn fn;
	int host;
} API[] = {
	{"getNode", api_get_node, 0},
	{"hasNode", api_has_node, 0},
	{"ensureNode", api_ensure_node, 0},
	{"createNode", api_create_node, 0},
	{"read", api_read, 0},
	{"readAttributes", api_read_attributes, 0},
	{"readChildren", api_read_children, 0},
	{"readAll", api_read_all, 0},
	{"readAllAttributes", api_read_all_attributes, 0},
	{"readAllChildren", api_read_all_children, 0},
	{"readEntries", api_read_entries, 0},
	{"patch", api_patch, 0},
	{"patchAttributes", api_patch_attributes, 0},
	{"patchChildren", api_patch_children, 0},
	{"explain", api_explain, 0},
	{"explainAttributes", api_explain_attributes, 0},
	{"explainChildren", api_explain_children, 0},
	{"place", api_place, 0},
	{"unplace", api_unplace, 0},
	{"rename", api_rename, 0},
	{"list", api_list, 0},
	{"executeAction", api_execute_action, 0},
	{"getCaller", api_get_caller, 0},
	{"getArgs", api_get_args, 0},
	{"remove", api_remove, 1},
	{"pulse", api_pulse, 1},
};

// names sorted
static void sort_names(const char **names, size_t count) {
	for (size_t i = 1; i < count; i++) {
		for (size_t j = i; j > 0 && strcmp(names[j - 1], names[j]) > 0; j--) {
			const char *t = names[j];
			names[j] = names[j - 1];
			names[j - 1] = t;
		}
	}
}

// explaincall: the keys of explain's writer.call, sorted; explainargs: its args and what it returned
static int explain_call(sys_t sys, env_t *env, const op_value *const *raw, size_t nraw, int args_only,
	op_value **out) {
	op_value *pair[2] = {arg(env, nraw > 0 ? raw[0] : NULL),
		args_only ? NULL : arg(env, nraw > 1 ? raw[1] : NULL)};
	es_explained *ex = NULL;
	int code = explain_ex(sys, "explain", pair, args_only ? 1 : 2, &ex);
	if (code == 0) {
		const es_call_view *cv = ex != NULL && ex->has_writer && ex->writer.kind == ES_WRITER_ACTION
			? ex->writer.call : NULL;
		if (cv == NULL) {
			*out = op_null();
		} else if (args_only) {
			op_value *m = op_map(), *list = op_list();
			for (size_t i = 0; i < cv->nargs; i++) {
				op_push(list, cv->args[i] != NULL ? op_ref(cv->args[i]) : op_null());
			}
			op_set(m, "args", list);
			op_set(m, "returned", cv->has_returned && cv->returned != NULL ? op_ref(cv->returned) : op_null());
			*out = m;
		} else {
			const char *names[12] = {"args", "end", "n", "reads", "started", "writes"};
			size_t count = 6;
			if (cv->has_ended) names[count++] = "ended";
			if (cv->error != NULL) names[count++] = "error";
			if (cv->nmade > 0) names[count++] = "made";
			if (cv->has_returned) names[count++] = "returned";
			sort_names(names, count);
			*out = strs(count, names);
		}
	}
	es_explained_free(ex);
	op_free(pair[0]);
	op_free(pair[1]);
	return code;
}

// explainfrom: explain of readAll(target)[i].from.change
static int explain_from(sys_t sys, env_t *env, const op_value *const *raw, size_t nraw, op_value **out) {
	CTX("readAll");
	op_value *t = arg(env, nraw > 0 ? raw[0] : NULL), *i = arg(env, nraw > 1 ? raw[1] : NULL);
	es_target x;
	es_versions vs = {0};
	int code = target_of(t, &x);
	if (code == 0) code = es_read_all(c, x, NULL, 0, &vs);
	if (code == 0) {
		size_t at = i != NULL && i->type == OP_NUM ? (size_t)i->num : 0;
		const es_change_view *view = at < vs.n ? vs.items[at].from.view : NULL;
		if (view != NULL) {
			es_explained *ex = NULL;
			code = es_explain_view(c, view, &ex);
			if (code == 0) *out = explained_value(ex);
			es_explained_free(ex);
		}
	}
	es_versions_free(&vs);
	op_free(t);
	op_free(i);
	return code;
}

// the keys of a map, sorted ([] for anything else)
static op_value *keys_value(const op_value *v) {
	op_value *x = expand(v);
	const op_value *m = x != NULL ? x : v;
	op_value *list = op_list();
	if (m != NULL && m->type == OP_MAP) {
		const char **ks = es_alloc((m->count + 1) * sizeof *ks);
		for (size_t i = 0; i < m->count; i++) ks[i] = m->keys[i];
		sort_names(ks, m->count);
		for (size_t i = 0; i < m->count; i++) op_push(list, op_str(ks[i]));
		free(ks);
	}
	op_free(x);
	return list;
}

static int form_status(sys_t sys, env_t *env, const op_value *const *raw, size_t nraw, op_value **out) {
	CTX("getStatus");
	es_target x;
	es_status st;
	op_value *t = arg(env, nraw > 0 ? raw[0] : NULL);
	int code = target_of(t, &x);
	if (code == 0) code = es_get_status(c, x, &st);
	op_free(t);
	if (code != 0) return code;
	if (st.state != NULL) *out = status_value(&st);
	es_status_free(&st);
	return 0;
}

// [fn, ...args]: the forms, then the process api. new value in *out (NULL: undefined)
// a writer given a function: steps, then expr's value
typedef struct {
	sys_t sys;
	env_t *env;
	const op_value *steps, *back;
	op_value *out;
} bound_t;
static int bound_run(void *ctx) {
	bound_t *k = ctx;
	env_t *inner = env_new(k->env);
	TRY(run_steps(k->sys, inner, k->steps));
	if (k->back == NULL) return 0;
	return expr(k->sys, inner, k->back, &k->out);
}
static int form_bound(sys_t sys, env_t *env, const op_value *const *raw, size_t nraw, op_value **out) {
	op_value *runner = arg(env, nraw > 0 ? raw[0] : NULL);
	bound_t k = {sys, env, nraw > 1 ? raw[1] : NULL, nraw > 2 ? raw[2] : NULL, NULL};
	int code = es_with_writer(W->e, runner, bound_run, &k);
	op_free(runner);
	if (code != 0) {
		op_free(k.out);
		return code;
	}
	*out = k.out;
	return 0;
}

// what start gave, for stop and status: the process by its id
typedef struct {
	char *id;
} child_t;
static void child_free(void *p) {
	child_t *k = p;
	free(k->id);
	free(k);
}

// start(program, at, options?) as a program: name is the new process's name here (its id proc:<name>),
// program the node holding its program (default at); gives start's result
static int form_start(sys_t sys, env_t *env, const op_value *const *raw, size_t nraw, op_value **out) {
	CTX("start");
	op_value *v[4] = {NULL, NULL, NULL, NULL};
	for (size_t i = 0; i < 4 && i < nraw; i++) v[i] = arg(env, raw[i]);
	const char *name = is_str(v[0]) ? v[0]->str : "", *at = is_str(v[1]) ? v[1]->str : "";
	char *key = rooted(is_str(v[2]) ? v[2]->str : at);
	program_t *program = es_map_get(&W->programs, key);
	int code = 0;
	if (program == NULL) code = fail("no program made at %s", key);
	free(key);
	es_start_options so = {0};
	const op_value *args = field(v[3], "args");
	if (code == 0 && args != NULL && args->type == OP_LIST) {
		const char **list = hh_take((args->count + 1) * sizeof *list);
		for (size_t i = 0; i < args->count; i++) list[i] = is_str(args->items[i]) ? args->items[i]->str : "";
		so.args = list;
		so.nargs = args->count;
		so.has_args = 1;
	}
	es_child child;
	es_refused refused;
	if (code == 0) {
		// the next process is this one: its id, and the name its program finds itself by
		char *was_next = W->next, *was_pending = W->pending;
		char *mine = es_alloc(strlen(name) + 6);
		sprintf(mine, "proc:%s", name);
		char *pending = es_dup(name);
		W->next = mine;
		W->pending = pending;
		running_t *me = owned_alloc(sizeof *me);
		me->env = env_new(NULL);
		es_map_set(&W->running, name, me);
		code = es_start_in(c, program_run, program, es_text(at), &so, &child, &refused);
		if (W->next == mine) free(mine);
		W->next = was_next;
		W->pending = was_pending;
		free(pending);
		if (code == 0 && refused.refused != NULL) {
			es_map_del(&W->running, name);
			op_value *m = op_map();
			op_set(m, "refused", op_str(refused.refused));
			op_set(m, "at", strs(refused.nat, (const char *const *)refused.at));
			es_refused_free(&refused);
			*out = m;
		} else if (code == 0) {
			me->id = own(es_dup(child.id));
			child_t *k = es_alloc(sizeof *k);
			k->id = es_dup(child.id);
			own_with(k, child_free);
			op_value *process = op_map();
			op_set(process, "at", strs(child.at.n, (const char *const *)child.at.names));
			op_set(process, "folder", strs(child.folder.n, (const char *const *)child.folder.names));
			es_child_free(&child);
			op_value *m = op_map();
			op_set(m, "process", process);
			op_set(m, "stop", es_live("stop", k));
			op_set(m, "status", es_live("status", k));
			*out = m;
		} else {
			es_map_del(&W->running, name);
		}
	}
	for (size_t i = 0; i < 4; i++) op_free(v[i]);
	return code;
}

// the stop of what start gave, called with why
static int form_stopped(sys_t sys, env_t *env, const op_value *const *raw, size_t nraw, op_value **out) {
	(void)out;
	CTX("stop");
	op_value *started = arg(env, nraw > 0 ? raw[0] : NULL), *why = arg(env, nraw > 1 ? raw[1] : NULL);
	const op_value *stop = field(started, "stop");
	child_t *k = es_live_of(stop, "stop");
	int code = k == NULL ? fail("not a started process") : es_child_stop(c, k->id, is_str(why) ? why->str : NULL);
	op_free(started);
	op_free(why);
	return code;
}

static int call_form(sys_t sys, env_t *env, const op_value *form, op_value **out) {
	*out = NULL;
	if (form == NULL || form->type != OP_LIST || form->count == 0 || !is_str(form->items[0])) {
		return fail("no api function %s",
			form != NULL && form->type == OP_LIST && form->count > 0 && is_str(form->items[0])
				? form->items[0]->str : "undefined");
	}
	const char *fn = form->items[0]->str;
	const op_value *const *raw = (const op_value *const *)form->items + 1;
	size_t nraw = form->count - 1;
#define R(i) ((size_t)(i) < nraw ? raw[i] : NULL)
	if (strcmp(fn, "createMemo") == 0 || strcmp(fn, "createEffect") == 0) {
		return define(sys, env, fn, raw, nraw, out);
	}
	if (strcmp(fn, "log") == 0) {
		op_value *v = NULL;
		TRY(expr(sys, env, R(1), &v));
		log_push(is_str(R(0)) ? R(0)->str : "", op_ref(v));
		*out = v;
		return 0;
	}
	if (strcmp(fn, "createAction") == 0 || strcmp(fn, "share") == 0) {
		CTX(fn);
		es_at at;
		es_handle *h;
		TRY(at_of(R(0), &at));
		if (strcmp(fn, "share") == 0) {
			const char *name = is_str(R(1)) ? R(1)->str : "";
			void *k = es_map_get(&W->shared, name);
			if (k == NULL) {
				k = owned_alloc(1);
				es_map_set(&W->shared, name, k);
			}
			TRY(es_create_action(c, at, share_run, k, &h));
		} else {
			act_t *k = owned_alloc(sizeof *k);
			*k = (act_t){sys, env, R(1), nraw > 2 ? R(2) : NULL};
			int gen = nraw > 3 && is_str(R(3)) && strcmp(R(3)->str, "gen") == 0;
			TRY(es_create_action(c, at, gen ? gen_run : act_run, k, &h));
		}
		*out = es_handle_value(h);
		return 0;
	}
	if (strcmp(fn, "addTeardown") == 0) {
		CTX(fn);
		td_t *k = owned_alloc(sizeof *k);
		k->log = is_str(R(0)) ? R(0)->str : "";
		k->tag = R(1) != NULL ? (is_str(R(1)) ? R(1)->str : "undefined") : NULL;
		return es_add_teardown(c, td_run, k);
	}
	if (strcmp(fn, "createWriter") == 0) {
		CTX(fn);
		return es_create_writer(c, out);
	}
	if (strcmp(fn, "withWriter") == 0) return form_bound(sys, env, raw, nraw, out);
	if (strcmp(fn, "start") == 0) return form_start(sys, env, raw, nraw, out);
	if (strcmp(fn, "stopped") == 0) return form_stopped(sys, env, raw, nraw, out);
	if (strcmp(fn, "caught") == 0) {
		int code = run_steps(sys, env_new(env), R(1));
		if (code != 0) {
			log_push(is_str(R(0)) ? R(0)->str : "", code_text(code));
			es_clear_thrown();
		}
		return 0;
	}
	if (strcmp(fn, "ref") == 0) {
		CTX(fn);
		es_at at;
		es_handle *h;
		TRY(at_of(R(0), &at));
		TRY(es_ref(c, at, ref_make, (void *)R(1), &h));
		*out = es_handle_value(h);
		return 0;
	}
	if (strcmp(fn, "getStatus") == 0) return form_status(sys, env, raw, nraw, out);
	if (strcmp(fn, "explainfrom") == 0) return explain_from(sys, env, raw, nraw, out);
	if (strcmp(fn, "explaincall") == 0) return explain_call(sys, env, raw, nraw, 0, out);
	if (strcmp(fn, "explainargs") == 0) return explain_call(sys, env, raw, nraw, 1, out);
	if (strcmp(fn, "later") == 0) {
		*out = promised(sys, env, R(0));
		return 0;
	}
	if (strcmp(fn, "peep") == 0) {
		CTX(fn);
		peep_t k = {sys, env, R(0), NULL};
		TRY(es_peep(c, peep_run, &k));
		*out = k.out;
		return 0;
	}
	if (strcmp(fn, "createPatch") == 0 || strcmp(fn, "layers") == 0) {
		// a library's, run with its caller's scope open
		lib_t k = {env, raw, nraw, strcmp(fn, "layers") == 0, NULL};
		int code = sys.fixed != NULL ? es_within(sys.fixed, lib_run, &k) : lib_run(&k);
		*out = k.out;
		return code;
	}
	if (strcmp(fn, "is") == 0) {
		op_value *x = NULL, *y = NULL;
		int code = expr(sys, env, R(0), &x);
		if (code == 0) code = expr(sys, env, R(1), &y);
		if (code == 0) *out = op_bool(same_value(x, y));
		op_free(x);
		op_free(y);
		return code;
	}
	if (strcmp(fn, "keys") == 0) {
		op_value *v = NULL;
		TRY(expr(sys, env, R(0), &v));
		*out = keys_value(v);
		op_free(v);
		return 0;
	}
	for (size_t i = 0; i < sizeof API / sizeof *API; i++) {
		if (strcmp(API[i].name, fn) != 0) continue;
		if (API[i].host && !sys.host) break;
		op_value **a = hh_take((nraw + 1) * sizeof *a);
		for (size_t k = 0; k < nraw; k++) a[k] = arg(env, raw[k]);
		int code = API[i].fn(sys, a, nraw, out);
		for (size_t k = 0; k < nraw; k++) op_free(a[k]);
		return code;
	}
	return fail("no api function %s", fn);
#undef R
}

// an expression: [fn, ...args], ["all", expr, …], "$x", or any other value as it is. new
static int expr(sys_t sys, env_t *env, const op_value *e, op_value **out) {
	*out = NULL;
	if (e == NULL || e->type != OP_LIST) {
		*out = arg(env, e);
		return 0;
	}
	const char *fn = e->count > 0 && is_str(e->items[0]) ? e->items[0]->str : "";
	const op_value *const *args = (const op_value *const *)e->items + 1;
	size_t n = e->count > 0 ? e->count - 1 : 0;
#define X(i) ((size_t)(i) < n ? args[i] : NULL)
	if (strcmp(fn, "all") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < n; i++) {
			op_value *x = NULL;
			int code = expr(sys, env, args[i], &x);
			if (code != 0) {
				op_free(list);
				return code;
			}
			op_push(list, x != NULL ? x : op_null());
		}
		*out = list;
		return 0;
	}
	// a whole value's patches, the value expr's
	if (strcmp(fn, "whole") == 0) {
		op_value *v = NULL;
		TRY(expr(sys, env, X(0), &v));
		op_value *patch = op_map();
		op_set(patch, "path", op_list());
		op_set(patch, "value", v != NULL ? v : op_null());
		op_value *list = op_list();
		op_push(list, patch);
		*out = list;
		return 0;
	}
	if (strcmp(fn, "inc") == 0) {
		op_value *v = NULL;
		TRY(expr(sys, env, X(0), &v));
		*out = op_num(v != NULL && v->type == OP_NUM ? v->num + 1 : NAN);
		op_free(v);
		return 0;
	}
	if (strcmp(fn, "if") == 0) {
		op_value *test = NULL;
		TRY(expr(sys, env, X(0), &test));
		int yes = test != NULL && test->type == OP_BOOL && test->bool_;
		op_free(test);
		if (yes) return expr(sys, env, X(1), out);
		return n > 2 ? expr(sys, env, args[2], out) : 0;
	}
	if (strcmp(fn, "throw") == 0) return es_fail_text(is_str(X(0)) ? X(0)->str : "undefined");
	if (strcmp(fn, "each") == 0) {
		op_value *list = NULL;
		TRY(expr(sys, env, X(0), &list));
		op_value *result = op_list();
		for (size_t i = 0; list != NULL && list->type == OP_LIST && i < list->count; i++) {
			op_value *x = value_at(list->items[i], X(1));
			op_push(result, x != NULL ? x : op_null());
		}
		op_free(list);
		*out = result;
		return 0;
	}
	if (strcmp(fn, "pick") == 0) {
		op_value *v = NULL;
		TRY(expr(sys, env, X(0), &v));
		op_value *x = value_at(v, X(1));
		op_free(v);
		*out = x != NULL ? x : op_null();
		return 0;
	}
#undef X
	return call_form(sys, env, e, out);
}

// --- the world's pieces ----------------------------------------------------------------------------------------

// a new node's id: the next process's while one starts, else n1, n2 …
static char *world_id(void *ctx) {
	(void)ctx;
	if (W->next != NULL) {
		char *id = W->next;
		W->next = NULL;
		return id;
	}
	char id[32];
	snprintf(id, sizeof id, "n%ld", ++W->counter);
	return es_dup(id);
}
static int world_user_activated(void *ctx) {
	(void)ctx;
	return W->event;
}
static void world_schedule(void *ctx, void (*f)(void *data), void *data) {
	(void)ctx;
	queued_t q = {f, data};
	ES_PUSH(W->queue, W->nqueue, W->capqueue, q);
}
// the pulses asked for, run till none is
static void drain(void) {
	while (W->head < W->nqueue) {
		queued_t q = W->queue[W->head++];
		q.f(q.data);
	}
	W->head = W->nqueue = 0;
}
static void world_created(void *ctx, const es_created *made) {
	(void)ctx;
	op_value *row = op_list();
	op_push(row, op_str(strcmp(made->kind, "action") == 0 ? "method" : made->kind));
	op_push(row, op_str(made->id));
	op_push(row, op_str(made->process));
	log_push("onCreateFunction", row);
}

// deny: every field given must match what is asked
static char *joined(const char *const *path, size_t n) {
	size_t size = 1;
	for (size_t i = 0; i < n; i++) size += strlen(path[i]) + 1;
	char *s = es_alloc(size), *w = s;
	for (size_t i = 0; i < n; i++) {
		if (i > 0) *w++ = '/';
		w += sprintf(w, "%s", path[i]);
	}
	return s;
}
static int path_is(const char *const *path, size_t n, const char *want) {
	if (path == NULL) return 0;
	char *p = joined(path, n);
	int same = strcmp(p, want) == 0;
	free(p);
	return same;
}
static pr_answer deny_run(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)read;
	(void)ctx;
	for (size_t i = 0; i < W->ndeny; i++) {
		const deny_t *d = &W->deny[i];
		if (strcmp(d->op, ask->op) != 0) continue;
		if (d->id != NULL && (ask->target.id.string == NULL || strcmp(d->id, ask->target.id.string) != 0)) {
			continue;
		}
		if (d->path != NULL && !path_is(ask->target.path, ask->target.npath, d->path)) continue;
		if (d->from != NULL && !path_is(ask->from.path, ask->from.npath, d->from)) continue;
		if (d->box != NULL &&
			(ask->from.box.string == NULL || strcmp(d->box, ask->from.box.string) != 0)) {
			continue;
		}
		if (d->pending) return (pr_answer){.verdict = PR_PENDING};
		return (pr_answer){.verdict = PR_NO, .reason = "denied"};
	}
	return (pr_answer){.verdict = PR_YES};
}

// --- the test features (features_fixture.ts) ------------------------------------------------------------------

static int boom(const tf_t *t) { return fail("%s threw", t->name); }
static int is_how(const tf_t *t, const char *hook, const char *how) {
	const char *x = text(t->spec, hook);
	return x != NULL && strcmp(x, how) == 0;
}

static int tf_table(void *ctx, const es_under *under, es_table_next *next, es_layer *out) {
	tf_t *t = ctx;
	say(t, "onTable", NULL, NULL, NULL);
	if (is_how(t, "onTable", "throw")) return boom(t);
	return es_next_table(next, under, out);
}
static int tf_read(void *ctx, const es_reading *x, const es_versions *items, es_read_next *next,
	es_versions *out) {
	tf_t *t = ctx;
	say(t, "onRead", x->id, NULL, NULL);
	if (is_how(t, "onRead", "throw")) return boom(t);
	if (is_how(t, "onRead", "drop")) {
		*out = (es_versions){0};
		return 0;
	}
	if (is_how(t, "onRead", "add")) {
		es_versions mine = {0};
		mine.items = es_alloc((items->n + 1) * sizeof *mine.items);
		memcpy(mine.items, items->items, items->n * sizeof *mine.items);
		mine.n = mine.cap = items->n + 1;
		es_version *extra = &mine.items[items->n];
		extra->held = op_str(t->name);
		extra->value = extra->held;
		extra->from.kind = "test";
		int code = es_next_read(next, x, &mine, out);
		free(mine.items);
		return code;
	}
	return es_next_read(next, x, items, out);
}
static int in_list(const op_value *list, const char *s) {
	for (size_t i = 0; i < list->count; i++) {
		if (is_str(list->items[i]) && strcmp(list->items[i]->str, s) == 0) return 1;
	}
	return 0;
}
static int tf_write(void *ctx, es_context *o, const es_write *w, es_write_next *next) {
	tf_t *t = ctx;
	if (t->slot != NULL) {
		long count = 0;
		es_slot_get(t->slot, o, &count);
		es_slot_set(t->slot, o, count + 1);
	}
	const char *how = text(t->spec, "onWrite");
	if (how == NULL) return es_next_write(next, o, w);
	// only: the host's context's writes; ids, parts: writes to those alone
	if (is_how(t, "only", "host") && o->process != NULL) return es_next_write(next, o, w);
	const op_value *ids = field(t->spec, "ids"), *parts = field(t->spec, "parts");
	if (ids != NULL && ids->type == OP_LIST && !in_list(ids, w->id)) return es_next_write(next, o, w);
	if (parts != NULL && parts->type == OP_LIST && !in_list(parts, w->part)) {
		return es_next_write(next, o, w);
	}
	// takes: only writes taking something out (an entry gone, or every patch with no value or move)
	int out = w->gone;
	if (!out) {
		out = 1;
		for (size_t i = 0; i < w->npatches; i++) {
			if (w->patches[i].has_value || w->patches[i].has_move) out = 0;
		}
	}
	if (flag(t->spec, "takes") && !out) return es_next_write(next, o, w);
	const op_value *times = field(t->spec, "times");
	if (times != NULL && times->type == OP_NUM && t->matched++ >= (long)times->num) {
		return es_next_write(next, o, w);
	}
	say(t, "onWrite", w->part, w->id, w->gone ? "gone" : NULL);
	if (strcmp(how, "throw") == 0) return boom(t);
	if (strcmp(how, "drop") == 0) return 0;
	if (strcmp(how, "copy") == 0) {
		es_write copy = *w;
		return es_next_write(next, o, &copy);
	}
	if (strcmp(how, "refuse") == 0) {
		char reason[256];
		snprintf(reason, sizeof reason, "%s refused", t->name);
		gd_refusal why = {.op = "edit", .reason = reason};
		return es_fail_refusal(&why, NULL, NULL);
	}
	return es_next_write(next, o, w);
}
static int tf_teardown(void *ctx, sc_scope *scope, const char *why, es_teardown_next *next) {
	tf_t *t = ctx;
	say(t, "onTeardown", why, NULL, NULL);
	if (is_how(t, "onTeardown", "throw")) return boom(t);
	if (is_how(t, "onTeardown", "drop")) return 0;
	if (is_how(t, "onTeardown", "why")) {
		char *s = es_alloc(strlen(t->name) + strlen(why) + 2);
		sprintf(s, "%s:%s", t->name, why);
		int code = es_next_teardown(next, scope, s);
		free(s);
		return code;
	}
	return es_next_teardown(next, scope, why);
}
static int tf_status(void *ctx, const es_asked *x, const es_status *st, es_status_next *next,
	es_status *out) {
	tf_t *t = ctx;
	say(t, "onStatus", x->id, NULL, NULL);
	if (is_how(t, "onStatus", "throw")) return boom(t);
	if (is_how(t, "onStatus", "drop")) {
		*out = *st;
		return 0;
	}
	TRY(es_next_status(next, x, st, out));
	if (is_how(t, "onStatus", "add")) {
		// a status beside the one next gave: its fields and this feature's, good till the next call
		op_value *more = op_map();
		if (out->more != NULL && out->more->type == OP_MAP) {
			for (size_t i = 0; i < out->more->count; i++) {
				op_set(more, out->more->keys[i], op_ref(out->more->items[i]));
			}
		}
		op_set(more, t->name, op_bool(1));
		op_free(t->held);
		t->held = more;
		out->more = more;
	}
	return 0;
}
static int tf_record(void *ctx, const es_recorded *r, es_record_next *next) {
	tf_t *t = ctx;
	say(t, "onRecord", r->run != NULL ? "run" : "call", r->id,
		r->run != NULL ? r->run->end : r->call->end);
	if (is_how(t, "onRecord", "throw")) return boom(t);
	if (is_how(t, "onRecord", "drop")) return 0;
	return es_next_record(next, r);
}
// the late hook: it passes everything on
static int tf_pass(void *ctx, es_context *o, const es_write *w, es_write_next *next) {
	(void)ctx;
	return es_next_write(next, o, w);
}

static int tf_setup(void *ctx, es_feature_api *f) {
	tf_t *t = ctx;
	t->api = f;
	if (flag(t->spec, "early")) {
		pl *places;
		TRY(es_api_places(f, &places));
	}
	if (flag(t->spec, "onTable")) TRY(es_on_table(f, tf_table, t));
	if (flag(t->spec, "onRead")) TRY(es_on_read(f, tf_read, t));
	if (flag(t->spec, "slot")) {
		TRY(es_reserve_slot(f, &t->slot));
		es_map_set(&W->slots, t->name, t);
	}
	if (flag(t->spec, "onWrite") || t->slot != NULL) TRY(es_on_write(f, tf_write, t));
	if (flag(t->spec, "onTeardown")) TRY(es_on_teardown(f, tf_teardown, t));
	if (flag(t->spec, "onStatus")) TRY(es_on_status(f, tf_status, t));
	if (flag(t->spec, "onRecord")) TRY(es_on_record(f, tf_record, t));
	return 0;
}

// "inline": a feature written here, listing no files
static int inline_write(void *ctx, es_context *o, const es_write *w, es_write_next *next) {
	(void)ctx;
	op_value *row = op_list();
	op_push(row, op_str("inline"));
	op_push(row, op_str("onWrite"));
	op_push(row, op_str(w->part));
	op_push(row, op_str(w->id));
	if (w->gone) op_push(row, op_str("gone"));
	log_push("hooks", row);
	return es_next_write(next, o, w);
}
static int inline_setup(void *ctx, es_feature_api *f) {
	(void)ctx;
	return es_on_write(f, inline_write, NULL);
}
static const es_feature inline_feature = {.name = "inline", .setup = inline_setup};

static void tf_free(void *p) {
	tf_t *t = p;
	free(t->name);
	op_free(t->held);
	free(t);
}

// a feature as a request gives it: a name, or a spec
static int feature_of(const op_value *f, const es_feature **out) {
	if (is_str(f)) {
		if (strcmp(f->str, "inline") == 0) {
			*out = &inline_feature;
			return 0;
		}
		if (strcmp(f->str, "patchy") == 0) {
			*out = py_feature();
			return 0;
		}
		return fail("no feature %s", f->str);
	}
	es_feature *feature = owned_alloc(sizeof *feature);
	tf_t *t = own_with(es_alloc(sizeof *t), tf_free);
	t->name = es_dup(str_or(f, "name"));
	t->spec = f;
	feature->name = t->name;
	feature->setup = tf_setup;
	feature->ctx = t;
	const op_value *needs = field(f, "needs");
	if (needs != NULL && needs->type == OP_LIST) {
		const char **names = owned_alloc((needs->count + 1) * sizeof *names);
		for (size_t i = 0; i < needs->count; i++) names[i] = is_str(needs->items[i]) ? needs->items[i]->str : "";
		feature->needs = names;
		feature->nneeds = needs->count;
	}
	if (flag(f, "late")) es_map_set(&W->late, t->name, t);
	*out = feature;
	return 0;
}

// --- patchy (extensions/patchy/typescript/feature.ts): the overlay a feature, createPatch and layers
// a library, land a service ---------------------------------------------------------------------------------------

// a layer's kind in reads, and the table's own as a layer's from
#define LAYER "layer"

// the overlay (patch.h) as the one frontmost layer: the view it gives places, the table it is over,
// and the places, connected when the first event or commit comes (the places are made after setup)
struct py {
	pn *overlay;
	tb_table *table, *view;
	es_feature_api *api;
	pl *places;
	int connected;
};
typedef struct py py_t;

static int py_connect(py_t *p) {
	if (p->connected) return 0;
	TRY(es_api_places(p->api, &p->places));
	pn_connect(p->overlay, p->table, p->view, p->places);
	p->connected = 1;
	return 0;
}
static void py_event(void *ctx, tb_key part, tb_key id) {
	py_t *p = ctx;
	if (py_connect(p) == 0) pn_event(p->overlay, part, id);
}
static void py_commit(void *ctx, const pl_changed *changed) {
	py_t *p = ctx;
	if (py_connect(p) == 0) pn_commit(p->overlay, changed);
}
// the view's event: an entry made in places' own table (by a library handed it as its table) goes to
// the table the writes go to, then the overlay says places
static void py_view_event(void *ctx, tb_key part, tb_key id) {
	py_t *p = ctx;
	nd_entry *made = p->connected ? tb_get(p->view, part, id) : NULL;
	if (made != NULL && tb_get(p->table, part, id) == NULL) tb_add(p->table, part, id, made);
	pn_view_event(p->overlay, part, id);
}
// onTable: the overlay in front of the table the layers after it gave
static int py_table(void *ctx, const es_under *under, es_table_next *next, es_layer *out) {
	py_t *p = ctx;
	es_layer inner;
	TRY(es_next_table(next, under, &inner));
	p->table = inner.front;
	p->view = tb_make(py_view_event, p);
	*out = (es_layer){.front = p->view, .event = py_event, .commit = py_commit, .ctx = p};
	return 0;
}
// onRead: where a patch node is over the node read, every layer, front first, after the items given
static int py_read(void *ctx, const es_reading *x, const es_versions *items, es_read_next *next,
	es_versions *out) {
	py_t *p = ctx;
	TRY(py_connect(p));
	pn_items ls = pn_entries(p->overlay, tb_string(x->part), tb_string(x->id), x->path, x->npath);
	int layered = 0;
	for (size_t i = 0; i < ls.n; i++) layered = layered || strcmp(ls.items[i].from, PN_TABLE) != 0;
	if (!layered) {
		pn_items_free(&ls);
		return es_next_read(next, x, items, out);
	}
	es_versions mine = {0};
	mine.items = es_alloc((items->n + ls.n + 1) * sizeof *mine.items);
	memcpy(mine.items, items->items, items->n * sizeof *mine.items);
	mine.n = mine.cap = items->n + ls.n;
	for (size_t i = 0; i < ls.n; i++) {
		const pn_item *l = &ls.items[i];
		es_version *v = &mine.items[items->n + i];
		int table = strcmp(l->from, PN_TABLE) == 0;
		// a layer's change: the patch node's patch entry's, the table's the target's own
		const nd_entry *entry = table ? tb_get(p->table, tb_string(x->part), tb_string(x->id))
			: tb_get(p->table, tb_string("patch"), tb_string(l->from));
		*v = (es_version){.value = l->value};
		if (entry != NULL) v->from.change = pl_change_value(p->places, &entry->change);
		v->from.kind = LAYER;
		// the layer named by its patch node's path as the reader sees it (none: null)
		op_value *more = op_map();
		es_names seen = {0};
		if (table) {
			op_set(more, LAYER, op_str(PN_TABLE));
		} else if (es_api_seen(p->api, l->from, x->context, &seen) == 0) {
			op_set(more, LAYER, names_value(&seen));
		} else {
			es_clear_thrown();
			op_set(more, LAYER, op_null());
		}
		es_names_free(&seen);
		if (l->stale) op_set(more, "stale", op_bool(1));
		if (l->error != NULL) op_set(more, "error", op_str(l->error));
		v->from.more = more;
	}
	int code = es_next_read(next, x, &mine, out);
	free(mine.items);
	pn_items_free(&ls);
	return code;
}
static int py_setup(void *ctx, es_feature_api *f) {
	py_t *p = ctx;
	p->api = f;
	p->overlay = pn_new();
	TRY(es_on_table(f, py_table, p));
	return es_on_read(f, py_read, p);
}
static void py_free(void *ctx) {
	py_t *p = ctx;
	if (p->overlay != NULL) pn_free(p->overlay);
	if (p->view != NULL) tb_free(p->view);
	free(p);
}
static es_feature *py_feature(void) {
	es_feature *feature = owned_alloc(sizeof *feature);
	py_t *p = own_with(es_alloc(sizeof *p), py_free);
	feature->name = "patchy";
	feature->setup = py_setup;
	feature->ctx = p;
	W->patchy = p;
	return feature;
}

#define L(i) ((size_t)(i) < k->nraw ? k->raw[i] : NULL)

// createPatch(at, over, change): the patch node at at, over's node, its patch entry written by patch
// against over's saved value (the table's layer, else read's) and its change's time. patches only:
// the base takes patches, and C has no recipe
static int lib_create_patch(lib_t *k) {
	sys_t found = {NULL, 0};
	es_context *c = sys_ctx(found, "createPatch");
	if (c == NULL) return es_thrown()->code;
	py_t *py = W->patchy;
	if (py == NULL) return fail("nothing-there (a node no ermine with patchy gave)");
	op_value *over = arg(k->env, L(1)), *change = arg(k->env, L(2));
	int code = 0;
	es_handle *o = NULL;
	if (is_str(over) || (over != NULL && over->type == OP_LIST)) {
		es_at where;
		code = at_of(over, &where);
		if (code == 0) code = es_get_node(c, where, &o);
	} else {
		o = (es_handle *)es_handle_in(W->e, over);
	}
	es_node_data od = {0};
	if (code == 0 && (o == NULL || !es_api_data_of(py->api, o, &od))) {
		code = fail("nothing-there (a node no ermine with patchy gave)");
	}
	if (code != 0) {
		op_free(over);
		op_free(change);
		return code;
	}
	// the target's id, from the handle readEntries gives (patchy's power: dataOf)
	char *on = od.id != NULL ? es_dup(od.id) : NULL;
	es_items entries = {0};
	if (on == NULL) {
		code = es_read_entries(c, es_on_node(o), &entries);
		if (code == 0 && entries.n > 0 && entries.items[0].node != NULL) {
			es_node_data fd;
			if (es_api_data_of(py->api, entries.items[0].node, &fd)) {
				if (fd.id != NULL) on = es_dup(fd.id);
				es_node_data_free(&fd);
			}
		}
		es_items_free(&entries);
	}
	if (code == 0 && on == NULL) {
		char *name = od.has_path ? joined((const char *const *)od.path, od.npath) : es_dup(od.id);
		code = fail("nothing-there (%s)", name);
		free(name);
	}
	es_versions shown = {0};
	if (code == 0) code = es_read_all(c, es_on_node(o), NULL, 0, &shown);
	if (code == 0 && (change == NULL || change->type != OP_LIST)) {
		code = fail("createPatch: patches only (a recipe is not written in C)");
	}
	es_handle *n = NULL;
	if (code == 0) {
		op_value *node = op_map();
		op_set(node, "on", op_str(on));
		op_set(node, "part", op_str(od.part));
		const es_change_view *first = shown.n > 0 ? shown.items[0].from.view : NULL;
		op_set(node, "at", op_int(first != NULL ? first->time : 0));
		op_set(node, "patches", op_ref(change));
		es_at where;
		code = at_of(L(0), &where);
		if (code == 0) code = es_ensure_node(c, where, NULL, &n);
		// its patch entry, through a handle to that table
		es_node_data made;
		if (code == 0 && !es_api_data_of(py->api, n, &made)) {
			code = fail("nothing-there (a node no ermine with patchy gave)");
		}
		if (code == 0) {
			free(made.part);
			made.part = es_dup("patch");
			es_handle *h;
			code = es_api_handle_of(py->api, &made, &h);
			es_node_data_free(&made);
			op_patch whole = {.has_value = 1, .value = node};
			if (code == 0) code = es_patch(c, es_on_node(h), &whole, 1);
		}
		op_free(node);
	}
	es_versions_free(&shown);
	es_node_data_free(&od);
	free(on);
	op_free(over);
	op_free(change);
	if (code == 0) k->out = es_handle_value(n);
	return code;
}

// layers(x, path?): readAll's layers, front first; none over x: the table's alone (read's), or none
static int lib_layers(lib_t *k) {
	sys_t found = {NULL, 0};
	es_context *c = sys_ctx(found, "layers");
	if (c == NULL) return es_thrown()->code;
	op_value *x = arg(k->env, L(0));
	es_target target;
	const op_key *key;
	size_t nkey;
	es_versions all = {0};
	int code = target_of(x, &target);
	if (code == 0) code = keys_of(L(1), &key, &nkey);
	if (code == 0) code = es_read_all(c, target, key, nkey, &all);
	if (code == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < all.n; i++) {
			const es_version *v = &all.items[i];
			if (v->from.kind == NULL || strcmp(v->from.kind, LAYER) != 0) continue;
			op_value *m = op_map();
			if (v->value != NULL) op_set(m, "value", op_ref((op_value *)v->value));
			const op_value *layer = field(v->from.more, LAYER);
			op_set(m, "from", layer != NULL ? op_ref((op_value *)layer) : op_null());
			if (field(v->from.more, "stale") != NULL) op_set(m, "stale", op_bool(1));
			if (field(v->from.more, "error") != NULL) op_set(m, "error", op_ref((op_value *)field(v->from.more, "error")));
			op_push(list, m);
		}
		if (list->count == 0 && all.n > 0) {
			op_value *m = op_map();
			if (all.items[0].value != NULL) op_set(m, "value", op_ref((op_value *)all.items[0].value));
			op_set(m, "from", op_str(PN_TABLE));
			op_push(list, m);
		}
		k->out = list;
	}
	es_versions_free(&all);
	op_free(x);
	return code;
}
static int lib_run(void *ctx) {
	lib_t *k = ctx;
	return k->layers ? lib_layers(k) : lib_create_patch(k);
}
#undef L

// land(ermine): the service's handler: the patch node sent landed. no stricter and no looser than its
// caller's own functions: the patch node reached as the caller's own edit would (a handle's place or
// a path in the caller's), edit asked on the target (by its id) and on the patch node
// (by the path it was sent by, else its id) as the caller and as the service, written with the
// service's power in the call; the patch entry taken out once the write has landed. a write that
// fails throws, one an onWrite hook holds back gives false: either way the patch node stays
static int land_do(const op_value *p, int *landed) {
	es_ermine *e = W->e;
	es_context *own = es_host_context(e);
	*landed = 0;
	int path_given = is_str(p) || (p != NULL && p->type == OP_LIST);
	es_node_data d = {0};
	int has_d = 0, code = 0;
	es_handle *h = NULL;
	if (!path_given) {
		h = es_handle_in(e, p);
		if (h != NULL) has_d = es_data_of(e, h, &d);
		if (!has_d) return fail("nothing-there (not a node handle)");
	}
	// asked as the caller (it acts for its caller), whether sent a handle or a path
	es_calling_view view;
	es_context *from = es_calling(e, &view) ? view.context : own;
	es_names resolved = {0};
	char *id = NULL;
	const char *const *path = NULL;
	size_t npath = 0;
	if (has_d) {
		path = d.has_path ? (const char *const *)d.path : NULL;
		npath = d.npath;
		if (!d.has_path) id = es_dup(d.id);
		else {
			// a handle's place: the node the host reaches there, by id (read_entries gives it)
			es_items reached;
			code = es_read_entries(own, es_on_node(h), &reached);
			es_node_data rd;
			if (code == 0 && reached.n > 0 && reached.items[0].node != NULL &&
				es_data_of(e, reached.items[0].node, &rd)) {
				if (rd.id != NULL) id = es_dup(rd.id);
				es_node_data_free(&rd);
			}
			if (code == 0) es_items_free(&reached);
		}
	} else {
		es_at where;
		code = at_of(p, &where);
		if (code == 0) code = es_resolve(from, where, &resolved);
		path = (const char *const *)resolved.names;
		npath = resolved.n;
	}
	if (code == 0 && id == NULL) {
		tb_key key;
		if (pl_get(from->places, path, npath, &key)) id = es_dup(key.string);
	}
	const nd_entry *patch_node = id != NULL ? tb_get(e->table, tb_string("patch"), tb_string(id)) : NULL;
	if (code == 0 && (id == NULL || patch_node == NULL || patch_node->value == NULL)) {
		char *name = id != NULL ? es_dup(id) : joined(path, npath);
		code = fail("nothing-there (%s)", name);
		free(name);
	}
	if (code == 0) {
		const op_value *v = patch_node->value;
		const char *on = str_or(v, "on"), *part = str_or(v, "part");
		// asked as both, in the form the caller's own edit would be
		gd_target targets[2] = {
			gd_target_of((gd_thing){tb_string(on), NULL, 0}, part, NULL),
			gd_target_of((gd_thing){tb_string(id), path, npath}, "patch", NULL),
		};
		for (int i = from == own ? 1 : 0; code == 0 && i < 2; i++) {
			code = es_context_ask(i == 0 ? from : own, "edit", targets, 2);
		}
		if (code == 0) {
			const nd_entry *target = tb_get(e->table, tb_string(part), tb_string(on));
			ch_header before = {0};
			int had = target != NULL;
			if (had) before = target->change;
			const op_patch *patches;
			size_t npatches;
			code = patches_of(field(v, "patches"), &patches, &npatches);
			es_aim aim = {.id = on};
			if (code == 0) code = es_context_write(own, part, &aim, patches, npatches);
			target = tb_get(e->table, tb_string(part), tb_string(on));
			int same = (target == NULL) == !had && (!had || memcmp(&before, &target->change, sizeof before) == 0);
			if (code == 0 && !same) {
				es_aim gone = {.id = id};
				code = es_context_remove(own, "patch", &gone);
				if (code == 0) *landed = 1;
			}
		}
	}
	free(id);
	es_names_free(&resolved);
	if (has_d) es_node_data_free(&d);
	return code;
}
static es_out land_run(es_context *c, void *ctx, const op_value *const *args, size_t nargs) {
	(void)c;
	(void)ctx;
	int landed;
	int code = land_do(nargs > 0 ? args[0] : NULL, &landed);
	if (code != 0) return es_out_code(code);
	return es_out_of(op_bool(landed));
}

// --- a world made ------------------------------------------------------------------------------------------------

// the ermine of a request (ermine's options), replacing the world
static int make(const op_value *r) {
	world_t *w = es_alloc(sizeof *w);
	W = w;
	w->host = env_new(NULL);
	w->actor = op_str("test");
	w->info = (sc_pair){"actor", w->actor};
	const op_value *features = field(r, "features"), *deny = field(r, "deny");
	size_t nfeatures = features != NULL && features->type == OP_LIST ? features->count : 0;
	const es_feature **list = owned_alloc((nfeatures + 1) * sizeof *list);
	for (size_t i = 0; i < nfeatures; i++) TRY(feature_of(features->items[i], &list[i]));
	if (deny != NULL && deny->type == OP_LIST) {
		w->deny = owned_alloc((deny->count + 1) * sizeof *w->deny);
		w->ndeny = deny->count;
		for (size_t i = 0; i < deny->count; i++) {
			const op_value *d = deny->items[i];
			deny_t *x = &w->deny[i];
			x->op = es_dup(str_or(d, "op"));
			if (text(d, "path") != NULL) x->path = es_dup(text(d, "path"));
			if (text(d, "id") != NULL) x->id = es_dup(text(d, "id"));
			if (text(d, "from") != NULL) x->from = es_dup(text(d, "from"));
			if (text(d, "box") != NULL) x->box = es_dup(text(d, "box"));
			x->pending = flag(d, "pending");
		}
		w->policy = pr_call(deny_run, NULL);
	}
	es_options o = {.features = list, .nfeatures = nfeatures, .may = w->policy,
		.schedule = world_schedule, .on_create_function = world_created, .root = "R",
		.info = &w->info, .ninfo = 1, .calls_never = strcmp(str_or(r, "calls"), "never") == 0,
		.user_activated = world_user_activated};
	if (!flag(r, "uuid")) o.id = world_id;
	if (text(r, "at") != NULL) o.host.at = text(r, "at");
	const op_value *args = field(r, "args");
	if (args != NULL && args->type == OP_LIST) {
		w->args = owned_alloc((args->count + 1) * sizeof *w->args);
		for (size_t i = 0; i < args->count; i++) w->args[i] = (char *)(is_str(args->items[i]) ? args->items[i]->str : "");
		w->nargs = args->count;
		o.host.args = (const char *const *)w->args;
		o.host.nargs = w->nargs;
	}
	return es_create(&o, &w->e);
}

// a world let go: its ermine (closed, if it is not), then what it held on to. its steps point
// into the retained lines, which go last, at hh_finish
static void world_free(world_t *w) {
	if (w == NULL) return;
	world_t *was = W;
	W = w;
	for (size_t i = 0; i < w->nheld; i++) es_promise_release(w->held[i].promise);
	if (w->e != NULL) es_free(w->e);
	for (size_t i = 0; i < w->nenvs; i++) {
		env_t *e = w->envs[i];
		for (size_t k = 0; k < e->vars.n; k++) op_free(e->vars.vals[k]);
		es_map_free(&e->vars);
		free(e);
	}
	for (size_t i = 0; i < w->ndeny; i++) {
		free(w->deny[i].op);
		free(w->deny[i].path);
		free(w->deny[i].id);
		free(w->deny[i].from);
		free(w->deny[i].box);
	}
	if (w->policy != NULL) pr_policy_free(w->policy);
	free(w->envs);
	for (size_t i = 0; i < w->nowned; i++) {
		if (w->owned[i].dtor != NULL) w->owned[i].dtor(w->owned[i].p);
		else free(w->owned[i].p);
	}
	free(w->owned);
	for (size_t i = 0; i < w->logs.n; i++) op_free(w->logs.vals[i]);
	es_map_free(&w->logs);
	es_map_free(&w->running);
	es_map_free(&w->slots);
	es_map_free(&w->programs);
	es_map_free(&w->shared);
	es_map_free(&w->late);
	free(w->queue);
	free(w->held);
	free(w->next);
	op_free(w->actor);
	free(w);
	W = was == w ? NULL : was;
}

static running_t *running_named(const char *name) {
	return name != NULL ? es_map_get(&W->running, name) : NULL;
}

// the context a request's process names (none: the host's); NULL: the process is not running
static es_context *context_of(const op_value *r) {
	const char *name = text(r, "process");
	if (name == NULL) return es_get_process_context(W->e, NULL);
	running_t *p = running_named(name);
	if (p == NULL || p->id == NULL) return NULL;
	return es_process_context_of(W->e, p->id);
}

// a node written as { id?, path?, part } in a host's step is minted a handle, as the host may
static int minted(const op_value *x, op_value **out) {
	*out = NULL;
	if (x == NULL) return 0;
	if (x->type == OP_LIST) {
		op_value *list = op_list();
		for (size_t i = 0; i < x->count; i++) {
			op_value *y = NULL;
			int code = minted(x->items[i], &y);
			if (code != 0) {
				op_free(list);
				return code;
			}
			op_push(list, y != NULL ? y : op_null());
		}
		*out = list;
		return 0;
	}
	int node = x->type == OP_MAP && x->count > 0 && op_get(x, "part") != NULL;
	for (size_t i = 0; node && i < x->count; i++) {
		node = strcmp(x->keys[i], "id") == 0 || strcmp(x->keys[i], "path") == 0 ||
			strcmp(x->keys[i], "part") == 0;
	}
	if (!node) {
		*out = op_ref((op_value *)x);
		return 0;
	}
	es_node_data d = {0};
	const op_value *path = op_get(x, "path"), *id = op_get(x, "id"), *part = op_get(x, "part");
	d.part = (char *)(is_str(part) ? part->str : "value");
	if (path != NULL && path->type == OP_LIST) {
		d.has_path = 1;
		d.npath = path->count;
		d.path = hh_take((path->count + 1) * sizeof *d.path);
		for (size_t i = 0; i < path->count; i++) d.path[i] = (char *)(is_str(path->items[i]) ? path->items[i]->str : "");
	} else {
		d.id = (char *)(is_str(id) ? id->str : "");
	}
	es_handle *h = es_handle_of(W->e, &d);
	if (h == NULL) return es_thrown()->code;
	*out = es_handle_value(h);
	return 0;
}

// --- programs --------------------------------------------------------------------------------------------------------

static es_out program_run(es_context *c, void *ctx) {
	(void)c;
	program_t *p = ctx;
	sys_t sys = {NULL, 0};
	env_t *env = env_new(NULL);
	running_t *me = running_named(W->pending);
	if (me != NULL) {
		me->env = env;
		me->has_api = 1;
	}
	int code = run_steps(sys, env, p->steps);
	if (code != 0) return es_out_code(code);
	if (p->throws != NULL) return es_out_failed(es_dup(p->throws));
	if (p->promise) return es_out_of(promised(sys, env, p->back));
	op_value *v = NULL;
	code = expr(sys, env, p->back, &v);
	if (code != 0) return es_out_code(code);
	return es_out_of(v);
}

// the harness's promises settled: each given its expression's value, outside any scope
static void settle_all(void) {
	while (W->nheld > 0) {
		held_t *batch = W->held;
		size_t n = W->nheld;
		W->held = NULL;
		W->nheld = W->capheld = 0;
		for (size_t i = 0; i < n; i++) {
			op_value *v = NULL;
			int code = expr(batch[i].sys, batch[i].env, batch[i].expr, &v);
			if (code != 0) {
				const es_error *t = es_thrown();
				es_promise_reject(batch[i].promise, code == ES_PENDING ? "PENDING" :
					t->message != NULL ? t->message : es_code_name(code));
			} else {
				es_promise_resolve(batch[i].promise, v);
			}
			es_promise_release(batch[i].promise);
		}
		free(batch);
		drain();
	}
}

// --- records, as an answer shows them ---------------------------------------------------------------------------------

static op_value *pair_value(const char *part, const char *id) {
	op_value *p = op_list();
	op_push(p, op_str(part));
	op_push(p, id != NULL ? op_str(id) : op_null());
	return p;
}
static op_value *call_shown(const es_call *c) {
	op_value *m = op_map();
	op_set(m, "n", op_int(c->n));
	op_set(m, "caller", op_str(c->caller));
	op_set(m, "handler", op_str(c->handler));
	op_value *args = op_list();
	for (size_t i = 0; i < c->nargs; i++) op_push(args, plain(c->args[i]));
	op_set(m, "args", args);
	op_set(m, "end", op_str(c->end));
	if (c->has_returned && c->returned != NULL) op_set(m, "returned", plain(c->returned));
	if (c->error != NULL) op_set(m, "error", op_str(c->error));
	op_value *reads = op_list(), *writes = op_list();
	for (size_t i = 0; i < c->nreads; i++) op_push(reads, pair_value(c->reads[i].part, c->reads[i].id));
	for (size_t i = 0; i < c->nwrites; i++) op_push(writes, pair_value(c->writes[i].part, c->writes[i].id));
	op_set(m, "reads", reads);
	op_set(m, "writes", writes);
	if (c->nmade > 0) {
		op_value *made = op_list();
		for (size_t i = 0; i < c->nmade; i++) op_push(made, pair_value(c->made[i].kind, c->made[i].id));
		op_set(m, "made", made);
	}
	return m;
}
static op_value *run_shown(const crn_run *r, const char *held) {
	op_value *m = op_map();
	op_set(m, "n", op_int(r->n));
	op_set(m, "end", op_str(r->end));
	if (r->error != NULL) op_set(m, "error", op_str(r->error));
	op_value *writes = op_list();
	for (size_t i = 0; r->writes != NULL && i < r->writes->n; i++) {
		op_push(writes, pair_value(r->writes->items[i].part, r->writes->items[i].id));
	}
	op_set(m, "writes", writes);
	if (held != NULL) {
		op_value *h = op_map();
		op_set(h, "feature", op_str(held));
		op_set(h, "write", op_str("status"));
		op_set(m, "held", h);
	}
	return m;
}

// --- the ops ------------------------------------------------------------------------------------------------------------

static op_value *with_value(op_value *v) {
	op_value *m = op_map();
	if (v != NULL) op_set(m, "value", v);
	return m;
}

typedef struct {
	sys_t sys;
	env_t *env;
	const op_value *call;
	op_value *out;
} do_t;
static int do_run(void *ctx) {
	do_t *k = ctx;
	return call_form(k->sys, k->env, k->call, &k->out);
}

typedef struct {
	es_context *c;
	const char *part;
	es_aim aim;
	const op_patch *patches;
	size_t npatches;
	int remove;
} write_t;
static int write_run(void *ctx) {
	write_t *k = ctx;
	if (k->remove) return es_context_remove(k->c, k->part, &k->aim);
	return es_context_write(k->c, k->part, &k->aim, k->patches, k->npatches);
}
typedef struct {
	es_context *c;
	int same;
} scope_t;
static int scope_run(void *ctx) {
	scope_t *k = ctx;
	k->same = sc_get_current_scope(k->c->ermine->scheduler) == k->c->scope;
	return 0;
}

// an id, or { id, path }: what a write is at
static int aim_of(const op_value *x, es_aim *aim) {
	*aim = (es_aim){0};
	if (is_str(x)) {
		aim->id = x->str;
		return 0;
	}
	const op_value *id = field(x, "id"), *path = field(x, "path");
	if (!is_str(id)) return fail("a write is at an id");
	aim->id = id->str;
	if (path != NULL && path->type == OP_LIST) {
		const char **steps = hh_take((path->count + 1) * sizeof *steps);
		for (size_t i = 0; i < path->count; i++) steps[i] = is_str(path->items[i]) ? path->items[i]->str : "";
		aim->has_path = 1;
		aim->path = steps;
		aim->npath = path->count;
	}
	return 0;
}

// the op "o": a process context's own
static int op_o(const op_value *r, op_value **res) {
	es_context *c = context_of(r);
	if (c == NULL) return fail("no context");
	const op_value *call = field(r, "call");
	if (call == NULL || call->type != OP_LIST || call->count == 0 || !is_str(call->items[0])) {
		return fail("no context function undefined");
	}
	const char *fn = call->items[0]->str;
	const op_value *const *a = (const op_value *const *)call->items + 1;
	size_t n = call->count - 1;
	if (strcmp(fn, "resolve") == 0) {
		es_names names;
		TRY(es_resolve(c, es_text(is_str(A(0)) ? A(0)->str : ""), &names));
		*res = with_value(names_value(&names));
		es_names_free(&names);
		return 0;
	}
	if (strcmp(fn, "write") == 0 || strcmp(fn, "remove") == 0) {
		write_t k = {.c = c, .part = is_str(A(0)) ? A(0)->str : "", .remove = fn[0] == 'r'};
		TRY(aim_of(A(1), &k.aim));
		if (!k.remove) TRY(patches_of(A(2), &k.patches, &k.npatches));
		*res = op_map();
		if (flag(r, "within")) return es_within(c, write_run, &k);
		return write_run(&k);
	}
	if (strcmp(fn, "ask") == 0) {
		const char *id = is_str(A(1)) ? A(1)->str : "", *part = is_str(A(2)) ? A(2)->str : "";
		gd_target t = gd_target_of((gd_thing){tb_string(id), NULL, 0}, part, NULL);
		*res = op_map();
		return es_context_ask(c, is_str(A(0)) ? A(0)->str : "", &t, 1);
	}
	if (strcmp(fn, "within") == 0) {
		scope_t k = {c, 0};
		TRY(es_within(c, scope_run, &k));
		*res = with_value(op_bool(k.same));
		return 0;
	}
	if (strcmp(fn, "api") == 0) {
		sys_t sys = {c, 0};
		op_value *v = NULL;
		TRY(call_form(sys, W->host, A(0), &v));
		op_value *p = plain(v);
		op_free(v);
		*res = with_value(p);
		return 0;
	}
	return fail("no context function %s", fn);
}

// the op "start"
static int op_start(const op_value *r, op_value **res) {
	const char *name = text(r, "name");
	if (name == NULL) return fail("start needs a name");
	W->next = es_alloc(strlen(name) + 6);
	sprintf(W->next, "proc:%s", name);
	W->pending = (char *)name;
	running_t *me = owned_alloc(sizeof *me);
	me->env = env_new(NULL);
	es_map_set(&W->running, name, me);
	// where its program was made: given, else at
	const char *at = str_or(r, "at");
	char *where = es_alloc(strlen(at) + strlen(str_or(r, "program")) + 8);
	if (text(r, "program") != NULL) {
		strcpy(where, text(r, "program"));
	} else {
		strcpy(where, "/");
		strcat(where, at);
	}
	char *key = rooted(where);
	free(where);
	program_t *program = es_map_get(&W->programs, key);
	if (program == NULL) {
		int code = fail("no program made at %s", key);
		free(key);
		free(W->next);
		W->next = NULL;
		W->pending = NULL;
		return code;
	}
	free(key);
	es_start_options so = {0};
	const op_value *args = field(r, "args");
	if (args != NULL && args->type == OP_LIST) {
		const char **list = hh_take((args->count + 1) * sizeof *list);
		for (size_t i = 0; i < args->count; i++) list[i] = is_str(args->items[i]) ? args->items[i]->str : "";
		so.args = list;
		so.nargs = args->count;
		so.has_args = 1;
	}
	if (text(r, "in") != NULL) {
		so.places = hx_places != NULL ? hx_places(text(r, "in")) : NULL;
		if (so.places == NULL) {
			int code = fail("no places %s", text(r, "in"));
			free(W->next);
			W->next = NULL;
			W->pending = NULL;
			return code;
		}
	}
	es_started *started = NULL;
	es_refused refused = {0};
	int code = es_start(W->e, program_run, program, es_text(at), &so, &started, &refused);
	free(W->next);
	W->next = NULL;
	W->pending = NULL;
	if (code == ES_TAKEN) {
		op_value *m = op_map();
		op_set(m, "refused", op_str(refused.refused));
		if (refused.has_held) {
			op_value *h = op_map();
			op_set(h, "process", op_str(refused.held_process));
			op_set(h, "feature", op_str(refused.held_feature));
			op_set(m, "held", h);
		}
		es_refused_free(&refused);
		es_map_del(&W->running, name);
		*res = m;
		return 0;
	}
	if (code != 0) return code;
	me->started = started;
	me->id = own(es_dup(pr_id(started->process)));
	*res = op_map();
	op_set(*res, "id", op_str(pr_id(started->process)));
	return 0;
}

// the nodes of the table, as the harness reads them
static const nd_entry *entry_of(const op_value *r) {
	const char *part = text(r, "part"), *id = text(r, "id");
	if (part == NULL || id == NULL) return NULL;
	return tb_get(W->e->table, tb_string(part), tb_string(id));
}
static const op_value *metadata_of(const nd_entry *entry, const char *key) {
	if (entry == NULL) return NULL;
	for (size_t i = 0; i < entry->change.metadata_length; i++) {
		if (strcmp(entry->change.metadata[i].key, key) == 0) return entry->change.metadata[i].value;
	}
	return NULL;
}

// a uuidv7: 8-4-4-4-12 hex, the version 7 and the variant 8 to b
static int is_uuid7(const char *s) {
	if (strlen(s) != 36) return 0;
	for (size_t i = 0; i < 36; i++) {
		if (i == 8 || i == 13 || i == 18 || i == 23) {
			if (s[i] != '-') return 0;
		} else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) {
			return 0;
		}
	}
	return s[14] == '7' && (s[19] == '8' || s[19] == '9' || s[19] == 'a' || s[19] == 'b');
}

// the id at a path from the root: 1 and *id, 0 none
static int id_at(const op_value *path, const char **id) {
	if (path == NULL || path->type != OP_LIST) return 0;
	const char **steps = hh_take((path->count + 1) * sizeof *steps);
	for (size_t i = 0; i < path->count; i++) steps[i] = is_str(path->items[i]) ? path->items[i]->str : "";
	tb_key key;
	if (!pl_get(W->e->places, steps, path->count, &key)) return 0;
	*id = key.string;
	return 1;
}

static int by_name(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static int op_features(op_value **res) {
	TRY(es_alive(W->e));
	size_t n;
	const es_shown *shown = es_features(W->e, &n);
	static const char *const hooks[] = {"onTable", "onRead", "onWrite", "onTeardown", "onRecord", "onStatus"};
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) {
		op_value *m = op_map(), *hs = op_list();
		op_set(m, "name", op_str(shown[i].name));
		op_set(m, "needs", strs(shown[i].nneeds, (const char *const *)shown[i].needs));
		for (size_t k = 0; k < shown[i].nhooks; k++) op_push(hs, op_str(hooks[shown[i].hooks[k]]));
		op_set(m, "hooks", hs);
		op_push(list, m);
	}
	*res = op_map();
	op_set(*res, "features", list);
	return 0;
}

static int op_metadata(const op_value *r, op_value **res) {
	const nd_entry *entry = entry_of(r);
	*res = op_map();
	size_t n = entry != NULL ? entry->change.metadata_length : 0;
	const char **keys = hh_take((n + 1) * sizeof *keys);
	for (size_t i = 0; i < n; i++) keys[i] = entry->change.metadata[i].key;
	qsort(keys, n, sizeof *keys, by_name);
	op_set(*res, "keys", strs(n, keys));
	const op_value *v;
	if ((v = metadata_of(entry, PL_NODE)) != NULL) op_set(*res, "node", plain(v));
	if ((v = metadata_of(entry, "features")) != NULL) op_set(*res, "features", plain(v));
	if ((v = metadata_of(entry, "call")) != NULL) op_set(*res, "call", plain(v));
	if ((v = metadata_of(entry, "handler")) != NULL) op_set(*res, "handler", plain(v));
	if ((v = metadata_of(entry, "caller")) != NULL && field(v, "node") != NULL) {
		op_set(*res, "caller", plain(field(v, "node")));
	}
	return 0;
}

static int op_record(const op_value *r, op_value **res) {
	TRY(es_alive(W->e));
	const char *id = text(r, "id");
	if (id == NULL && !id_at(field(r, "path"), &id)) return fail("no id");
	*res = op_map();
	if (strcmp(str_or(r, "kind"), "call") == 0) {
		const es_call *c = es_records_call(W->e, id);
		if (c != NULL) op_set(*res, "record", call_shown(c));
	} else {
		const crn_run *run = es_records_run(W->e, id);
		if (run != NULL) op_set(*res, "record", run_shown(run, es_records_run_held(W->e, id)));
	}
	return 0;
}

static int op_waits(op_value **res) {
	TRY(es_alive(W->e));
	size_t n;
	es_wait *waits = es_records_waits(W->e, &n);
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) {
		op_value *m = op_map();
		op_set(m, "caller", op_str(waits[i].caller));
		if (waits[i].has_path) op_set(m, "path", strs(waits[i].npath, (const char *const *)waits[i].path));
		if (waits[i].id != NULL) op_set(m, "id", op_str(waits[i].id));
		op_push(list, m);
	}
	es_waits_free(waits, n);
	*res = op_map();
	op_set(*res, "waits", list);
	return 0;
}

static int op_do(const op_value *r, op_value **res) {
	TRY(es_alive(W->e));
	running_t *p = running_named(text(r, "process"));
	if (p == NULL || !p->has_api) return fail("no process %s", str_or(r, "process"));
	es_context *c = es_process_context_of(W->e, p->id);
	if (c == NULL) return fail("process %s stopped", str_or(r, "process"));
	do_t k = {{NULL, 0}, p->env, field(r, "call"), NULL};
	TRY(es_within(c, do_run, &k));
	watched(k.out);
	if (text(r, "as") != NULL) env_set(p->env, text(r, "as"), op_ref(k.out));
	op_value *shown = plain(k.out);
	op_free(k.out);
	*res = with_value(shown);
	return 0;
}

static int op_saved(const op_value *r, op_value **res) {
	const nd_entry *entry = entry_of(r);
	op_value *v = entry != NULL ? op_ref(entry->value) : NULL;
	const op_value *path = field(r, "path");
	if (path != NULL && path->type == OP_LIST) {
		op_value *x = value_at(v, path);
		op_free(v);
		v = x;
	}
	op_value *shown = plain(v);
	op_free(v);
	*res = with_value(shown);
	return 0;
}

// kids and put: a table entry set, as the host's scope makes its change (table.sub)
typedef struct {
	const char *part, *id;
	const op_value *value;
} put_t;
static int put_run(void *ctx) {
	put_t *k = ctx;
	es_ermine *e = W->e;
	ch_header h;
	pl_made *made;
	TRY(es_header(e, &h, &made));
	nd_entry *entry = nd_make_entry((op_value *)k->value, &h);
	tb_sub(e->table, tb_string(k->part), tb_string(k->id), entry);
	pl_own(e->places, entry);
	if (made != NULL) pl_hold(e->places, entry, made, pl_made_free);
	return 0;
}

static int answer(const op_value *r, op_value **res) {
	const char *op = hh_str(r, "op");
	if (op == NULL) return fail("no op undefined");
	if (strcmp(op, "ermine") == 0) {
		world_t *old = W;
		int code = make(r);
		world_free(old);
		TRY(code);
		*res = op_map();
		return 0;
	}
	es_ermine *e = W->e;
	if (e == NULL) return fail("no ermine");
	if (strcmp(op, "features") == 0) return op_features(res);
	if (strcmp(op, "late") == 0) {
		tf_t *t = es_map_get(&W->late, str_or(r, "feature"));
		if (t == NULL || t->api == NULL) return fail("no feature %s", str_or(r, "feature"));
		TRY(es_on_write(t->api, tf_pass, NULL));
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "uuid") == 0) {
		TRY(es_alive(e));
		const char *id = NULL;
		*res = op_map();
		op_set(*res, "v7", op_bool(id_at(field(r, "path"), &id) && id != NULL && is_uuid7(id)));
		return 0;
	}
	if (strcmp(op, "node") == 0) {
		TRY(es_alive(e));
		const nd_entry *attrs = tb_get(e->table, tb_string("attributes"), tb_string(e->node));
		*res = op_map();
		op_set(*res, "id", op_str(e->node));
		op_value *p = attrs != NULL ? plain(attrs->value) : NULL;
		if (p != NULL) op_set(*res, "attributes", p);
		return 0;
	}
	if (strcmp(op, "context") == 0) {
		TRY(es_alive(e));
		es_context *c = context_of(r);
		*res = op_map();
		if (c == NULL) return 0;
		op_set(*res, "at", strs(c->nat, (const char *const *)c->at));
		op_set(*res, "folder", strs(c->nfolder, (const char *const *)c->folder));
		op_set(*res, "args", strs(c->nargs, (const char *const *)c->args));
		if (c->process != NULL) op_set(*res, "process", op_str(pr_id(c->process)));
		op_set(*res, "scope", op_str(c == e->host_context ? "host" : c->process != NULL ? "process" : "other"));
		return 0;
	}
	if (strcmp(op, "o") == 0) {
		TRY(es_alive(e));
		return op_o(r, res);
	}
	if (strcmp(op, "host") == 0) {
		sys_t sys = {es_host_context(e), 1};
		op_value *call = NULL, *v = NULL;
		TRY(minted(field(r, "call"), &call));
		// the call's pieces are held (a memo's expression points into it): the line's
		hh_hold(call);
		int code = call_form(sys, W->host, call, &v);
		if (code != 0) return code;
		watched(v);
		if (text(r, "as") != NULL) env_set(W->host, text(r, "as"), op_ref(v));
		op_value *shown = plain(v);
		op_free(v);
		*res = with_value(shown);
		return 0;
	}
	if (strcmp(op, "code") == 0) {
		program_t *p = owned_alloc(sizeof *p);
		p->steps = field(r, "program");
		p->back = field(r, "back");
		p->throws = text(r, "throws");
		p->promise = flag(r, "promise");
		const char *at = str_or(r, "at");
		char *key = rooted(at);
		es_map_set(&W->programs, key, p);
		free(key);
		es_handle *h;
		op_value *live = es_live("program", p);
		int code = es_ensure_node(es_host_context(e), es_text(at), live, &h);
		op_free(live);
		TRY(code);
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "start") == 0) return op_start(r, res);
	if (strcmp(op, "stop") == 0) {
		running_t *p = running_named(text(r, "name"));
		if (p == NULL || p->id == NULL) return fail("no process %s", str_or(r, "name"));
		// the host, not the starter, stops a child here: as its node is unplaced (a child's own stop is
		// the starter's, es_child_stop)
		if (p->started == NULL) es_stop_node(e, p->id);
		else TRY(es_stop(p->started, text(r, "why")));
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "status") == 0) {
		running_t *p = running_named(text(r, "name"));
		if (p == NULL || p->id == NULL) return fail("no process %s", str_or(r, "name"));
		es_status st;
		if (p->started == NULL) {
			es_node_data node = {.id = p->id, .part = (char *)"value"};
			TRY(es_get_status(es_host_context(e), es_on_node(es_handle_of(e, &node)), &st));
		}
		else TRY(es_started_status(p->started, &st));
		*res = op_map();
		if (st.state != NULL) op_set(*res, "status", status_value(&st));
		es_status_free(&st);
		return 0;
	}
	if (strcmp(op, "close") == 0) {
		TRY(es_close(e));
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "service") == 0) {
		if (strcmp(str_or(r, "what"), "land") != 0) return fail("no service %s", str_or(r, "what"));
		es_handle *h;
		TRY(es_create_action(es_host_context(e), es_text(str_or(r, "at")), land_run, NULL, &h));
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "record") == 0) return op_record(r, res);
	if (strcmp(op, "waits") == 0) return op_waits(res);
	if (strcmp(op, "slot") == 0) {
		TRY(es_alive(e));
		running_t *p = running_named(text(r, "process"));
		es_context *c = p != NULL && p->id != NULL ? es_process_context_of(e, p->id) : NULL;
		tf_t *t = es_map_get(&W->slots, str_or(r, "feature"));
		long count;
		*res = op_map();
		if (c != NULL && t != NULL && t->slot != NULL && es_slot_get(t->slot, c, &count)) {
			op_set(*res, "value", op_int(count));
		}
		return 0;
	}
	if (strcmp(op, "do") == 0) return op_do(r, res);
	if (strcmp(op, "settle") == 0) {
		settle_all();
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "log") == 0) {
		const op_value *list = es_map_get(&W->logs, str_or(r, "name"));
		*res = op_map();
		op_set(*res, "values", list != NULL ? plain(list) : op_list());
		return 0;
	}
	if (strcmp(op, "pulse") == 0) {
		TRY(es_alive(e));
		TRY(es_pulse(es_host_context(e)));
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "activation") == 0) {
		W->event = flag(r, "active") && field(r, "active")->type == OP_BOOL;
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "withWriter") == 0) {
		TRY(es_alive(e));
		running_t *p = running_named(text(r, "process"));
		if (p == NULL || !p->has_api) return fail("no process %s", str_or(r, "process"));
		op_value *runner = env_get(p->env, str_or(r, "name"));
		bound_t k = {{NULL, 0}, p->env, field(r, "steps"), field(r, "back"), NULL};
		int code = es_with_writer(e, runner, bound_run, &k);
		if (code != 0) {
			op_free(k.out);
			return code;
		}
		op_value *shown = plain(k.out);
		op_free(k.out);
		*res = with_value(shown);
		return 0;
	}
	if (strcmp(op, "kids") == 0 || strcmp(op, "put") == 0) {
		TRY(es_alive(e));
		put_t k = {strcmp(op, "kids") == 0 ? "children" : str_or(r, "part"), str_or(r, "id"), field(r, "value")};
		TRY(es_within(es_host_context(e), put_run, &k));
		*res = op_map();
		return 0;
	}
	if (strcmp(op, "saved") == 0) {
		TRY(es_alive(e));
		return op_saved(r, res);
	}
	if (strcmp(op, "id") == 0) {
		TRY(es_alive(e));
		const char *id = NULL;
		*res = op_map();
		if (id_at(field(r, "path"), &id)) op_set(*res, "id", op_str(id));
		return 0;
	}
	if (strcmp(op, "metadata") == 0) {
		TRY(es_alive(e));
		return op_metadata(r, res);
	}
	if (strcmp(op, "caller") == 0) {
		TRY(es_alive(e));
		const op_value *v = metadata_of(entry_of(r), "caller");
		*res = v != NULL ? plain(v) : op_map();
		return 0;
	}
	if (strcmp(op, "site") == 0) {
		TRY(es_alive(e));
		const nd_entry *entry = entry_of(r);
		*res = op_map();
		const ch_site *site = entry != NULL && entry->change.external_length > 0 ? &entry->change.external[0] : NULL;
		op_set(*res, "site", op_str(site_of(site)));
		return 0;
	}
	if (hx_op != NULL) {
		int code = hx_op(r, e, res);
		if (code != HX_NOT_MINE) return code;
	}
	return fail("no op %s", op);
}

void hh_finish(void) {
	world_free(W);
	W = NULL;
	for (size_t i = 0; i < nlines; i++) hh_release(lines[i]);
	free(lines);
	lines = NULL;
	nlines = caplines = 0;
}

void hh_answer(const op_value *request, FILE *out) {
	ES_PUSH(lines, nlines, caplines, hh_retain());
	if (W == NULL && strcmp(str_or(request, "op"), "ermine") != 0) {
		if (make(NULL) != 0) W->e = NULL;
	}
	op_value *res = NULL;
	es_clear_thrown();
	int code = answer(request, &res);
	if (W->e != NULL && !W->e->closed) drain();
	if (code != 0) {
		op_free(res);
		res = error_value(code);
	}
	if (res == NULL) res = op_map();
	op_json_write(out, res);
	op_free(res);
}
