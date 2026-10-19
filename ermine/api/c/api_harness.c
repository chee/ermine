// the C process api (api.h) on the line protocol of typescript/api_harness.ts, which documents it
// and the programs (conformance/c/harness.h has the loop). its own world, lasting for the process
// (or until a "world" request): a scheduler, a table, paths, scope nodes and places at the root "R"
// (asked [processes("R"), children]), the host's scope [["actor","test"]]. after every request what
// the api asked to run later (its pulse) is run. new ids are "n1", "n2", ...; a process's id is
// "proc:<name>". processes here are started by the harness, not by programs.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/protocol_harness.h"
#include "../../../ermine/processes/c/processes.h"
#include "../../../ermine/processes/c/scopes.h"
#include "api.h"

#define CP_(x) ((const char *const *)(x))
#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// the change op's keys, from the metadata (keys unique), as the TS harness's
static void found_pair(op_value *o, const char *key, const op_value *v) {
	if (!key || !v) return;
	if ((strcmp(key, "actor") == 0 || strcmp(key, "process") == 0 || strcmp(key, "caller") == 0) &&
		op_get(o, key) == NULL)
		op_set(o, key, op_ref((op_value *)v));
}

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }
// for qsort: two keys' texts
static int by_text(const void *a, const void *b) {
	return strcmp(*(const char *const *)a, *(const char *const *)b);
}

// names ------------------------------------------------------------------------------------------

typedef struct {
	char *key;
	op_value *val;
} binding;
typedef struct {
	binding *v;
	size_t n, cap;
} env;

static void env_set(env *e, const char *key, op_value *val) {
	for (size_t i = 0; i < e->n; i++) {
		if (strcmp(e->v[i].key, key) != 0) continue;
		op_free(e->v[i].val);
		e->v[i].val = val;
		return;
	}
	binding b = {xdup(key), val};
	PUSH(e->v, e->n, e->cap, b);
}
static op_value *env_get(const env *e, const char *key) {
	for (size_t i = 0; i < e->n; i++) {
		if (strcmp(e->v[i].key, key) == 0) return e->v[i].val;
	}
	return NULL;
}
static void env_free(env *e) {
	for (size_t i = 0; i < e->n; i++) free(e->v[i].key), op_free(e->v[i].val);
	free(e->v);
	*e = (env){0};
}
static env env_copy(const env *e) {
	env c = {0};
	for (size_t i = 0; i < e->n; i++) env_set(&c, e->v[i].key, op_ref(e->v[i].val));
	return c;
}

// the world ----------------------------------------------------------------------------------------

typedef struct {
	char *name;
	api *api;
	env env;
	char *id;
	char **at, **cwd, **args;
	size_t nat, ncwd, nargs;
	op_value *at_value, *id_value;
	sc_scope *scope;
	api_process process;
} running;

typedef struct {
	char *name;
	op_value *values;
} logged;

typedef struct {
	char *op, *path;
} deny;

typedef struct {
	sc_scheduler *s;
	tb_table *table, *view;
	pt_paths *paths;
	pl *places;
	pn *overlay;
	sn *scopes;
	pr_processes rows;
	const pl_contributor *walk[2];
	sc_scope *host, *above;
	sc_pair host_info, above_info;
	api_context *context;
	pr_policy *policy;
	deny *denied;
	size_t ndenied, capdenied;
	env **envs;
	size_t nenvs, capenvs;
	pres_world presence;
	int has_presence;
	int64_t clock;
	char *who;
	unsigned counter;
	char idbuf[32];
	running **procs;
	size_t nprocs, capprocs;
	logged *logs;
	size_t nlogs, caplogs;
	struct {
		void (*f)(void *);
		void *data;
	} *queue;
	size_t qn, qcap, qhead;
	void **closures;
	size_t nclosures, capclosures;
	// values a closure refers to (a memo's expression, a method's steps): let go with the world
	op_value **held;
	size_t nheld, capheld;
	// the table events since last asked: [part, id, "put" | "gone"] each
	op_value *events;
} world;

static world *w;

static pr_answer deny_policy(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)read;
	world *m = ctx;
	if (ask->target.path != NULL) {
		size_t len = 1;
		for (size_t i = 0; i < ask->target.npath; i++) len += strlen(ask->target.path[i]) + 1;
		char *joined = xalloc(len);
		for (size_t i = 0; i < ask->target.npath; i++) {
			if (i) strcat(joined, "/");
			strcat(joined, ask->target.path[i]);
		}
		for (size_t i = 0; i < m->ndenied; i++) {
			if (strcmp(m->denied[i].op, ask->op) == 0 && strcmp(m->denied[i].path, joined) == 0) {
				free(joined);
				return (pr_answer){PR_NO, "denied", NULL};
			}
		}
		free(joined);
	}
	return (pr_answer){PR_YES, "", NULL};
}

static int64_t read_clock(void *ctx) { return ((world *)ctx)->clock; }

static const char *next_id(void *ctx) {
	world *m = ctx;
	snprintf(m->idbuf, sizeof m->idbuf, "n%u", ++m->counter);
	return m->idbuf;
}

static void schedule(void *ctx, void (*f)(void *), void *data) {
	world *m = ctx;
	if (m->qn == m->qcap) {
		m->qcap = m->qcap ? m->qcap * 2 : 16;
		m->queue = realloc(m->queue, m->qcap * sizeof *m->queue);
		if (m->queue == NULL) abort();
	}
	m->queue[m->qn].f = f, m->queue[m->qn].data = data, m->qn++;
}
// what the api asked to run later, till none is asked for
static void drain(void) {
	while (w->qhead < w->qn) {
		size_t i = w->qhead++;
		w->queue[i].f(w->queue[i].data);
	}
	w->qn = w->qhead = 0;
}

static void commit_hook(void *ctx, const pl_changed *changed) {
	world *m = ctx;
	if (m->overlay) pn_commit(m->overlay, changed);
	else pl_commit(m->places, changed);
}

// programs' stop, as the harness starts: the row out, the scope torn down
typedef struct {
	world *m;
	const api_process *p;
} stopcall;
static void remove_row(void *data) {
	stopcall *c = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(c->m->places, NULL, 0, NULL, &h, &made);
	if (bad) {
		free(bad);
		return;
	}
	pl_changed changed = {0};
	int code = pr_remove(c->m->places, c->m->table, tb_string("R"), c->p->at, c->p->nat, h, &changed);
	if (code) {
		pl_made_free(made);
		return;
	}
	pl_commit(c->m->places, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(c->m->places, changed.entries[i], pl_made_ref(made), pl_made_free);
	}
	pl_made_free(made);
}
static void stop_hook(void *ctx, const api_process *p) {
	if (!sc_scope_alive(p->scope)) return;
	stopcall c = {ctx, p};
	sc_run_with_scope(p->scope, remove_row, &c);
	free(sc_teardown(p->scope));
}

// a table event, kept for "events", then told to the overlay or places
static void table_event(void *ctx, tb_key part, tb_key id) {
	world *m = ctx;
	op_value *e = op_list();
	op_push(e, part.symbol ? op_null() : op_str(part.string));
	op_push(e, id.symbol ? op_null() : op_str(id.string));
	op_push(e, op_str(tb_get(m->table, part, id) ? "put" : "gone"));
	op_push(m->events, e);
	if (m->overlay) pn_event(m->overlay, part, id);
	else pl_event(m->places, part, id);
}

static world *make(const op_value *o) {
	world *m = xalloc(sizeof *m);
	m->events = op_list();
	m->s = sc_new((sc_options){.drop = api_drop});
	m->places = pl_new();
	const op_value *overlay = o ? op_get(o, "overlay") : NULL;
	if (overlay && overlay->type == OP_BOOL && overlay->bool_) {
		m->overlay = pn_new();
		m->table = tb_make(table_event, m);
		m->view = tb_make(pn_view_event, m->overlay);
	} else {
		m->table = tb_make(table_event, m);
		m->view = m->table;
	}
	m->paths = pt_new();
	pr_processes_init(&m->rows, tb_string("R"));
	m->walk[0] = &m->rows.contributor, m->walk[1] = &pl_children;
	pl_connect(m->places, &(pl_setup){.root = tb_string("R"), .table = m->view, .paths = m->paths,
		.scheduler = m->s, .contributors = m->walk, .ncontributors = 2});
	if (m->overlay) pn_connect(m->overlay, m->table, m->view, m->places);
	sc_on_tracking_end(m->s, pl_forget, m->places);
	m->scopes = sn_new(m->s, m->table);
	m->host_info = (sc_pair){"actor", op_str("test")};
	m->host = sc_create_root_scope(m->s, &m->host_info, 1);
	m->above_info = (sc_pair){"role", op_str("programs")};
	m->above = sc_create_scope(m->s, &m->above_info, 1, m->host);
	const op_value *list = o ? op_get(o, "deny") : NULL;
	if (list && list->type == OP_LIST) {
		for (size_t i = 0; i < list->count; i++) {
			deny d = {xdup(hh_str(list->items[i], "op")), xdup(hh_str(list->items[i], "path"))};
			PUSH(m->denied, m->ndenied, m->capdenied, d);
		}
		m->policy = pr_call(deny_policy, m);
	}
	const op_value *pres = o ? op_get(o, "presence") : NULL;
	if (pres && pres->type == OP_BOOL && pres->bool_) {
		m->has_presence = 1;
		m->presence = (pres_world){.table = m->table,
			.places = m->places,
			.scheduler = m->s,
			.scope = m->host,
			.now = read_clock,
			.now_ctx = m};
	}
	const char *who = o ? hh_str(o, "who") : NULL;
	if (who) m->who = xdup(who);
	api_setup setup = {.scheduler = m->s,
		.table = m->table,
		.places = m->places,
		.commit = commit_hook,
		.commit_ctx = m,
		.stop = stop_hook,
		.stop_ctx = m,
		.may = m->policy,
		.presence = m->has_presence ? &m->presence : NULL,
		.who = m->who,
		.overlay = m->overlay,
		.schedule = schedule,
		.schedule_ctx = m};
	// uuid: no setup.id, new ids the api's own
	const op_value *uuid = o ? op_get(o, "uuid") : NULL;
	if (!(uuid && uuid->type == OP_BOOL && uuid->bool_)) setup.id = next_id, setup.id_ctx = m;
	m->context = api_context_new(&setup);
	return m;
}

static void finish(world *m) {
	// the scopes torn down first (the apis' teardowns write), then what they made
	free(sc_teardown(m->host));
	for (size_t i = 0; i < m->nprocs; i++) {
		running *r = m->procs[i];
		api_free(r->api);
		env_free(&r->env);
		for (size_t k = 0; k < r->nat; k++) free(r->at[k]);
		for (size_t k = 0; k < r->ncwd; k++) free(r->cwd[k]);
		for (size_t k = 0; k < r->nargs; k++) free(r->args[k]);
		free(r->at), free(r->cwd), free(r->args), free(r->id), free(r->name);
		op_free(r->at_value);
		op_free(r->id_value);
		free(r);
	}
	free(m->procs);
	api_context_free(m->context);
	if (m->has_presence) pres_free(&m->presence);
	if (m->overlay) pn_free(m->overlay);
	sn_free(m->scopes);
	sc_free(m->s);
	tb_free(m->table);
	if (m->view != m->table) tb_free(m->view);
	pt_free(m->paths);
	pl_free(m->places);
	if (m->policy) pr_policy_free(m->policy);
	for (size_t i = 0; i < m->ndenied; i++) free(m->denied[i].op), free(m->denied[i].path);
	free(m->denied);
	for (size_t i = 0; i < m->nlogs; i++) free(m->logs[i].name), op_free(m->logs[i].values);
	free(m->logs);
	for (size_t i = 0; i < m->nenvs; i++) env_free(m->envs[i]), free(m->envs[i]);
	free(m->envs);
	for (size_t i = 0; i < m->nclosures; i++) free(m->closures[i]);
	free(m->closures);
	for (size_t i = 0; i < m->nheld; i++) op_free(m->held[i]);
	free(m->held);
	op_free(m->events);
	free(m->queue);
	op_free((op_value *)m->host_info.value);
	op_free((op_value *)m->above_info.value);
	free(m->who);
	free(m);
}

static world *world_(void) {
	if (w == NULL) w = make(NULL);
	return w;
}

static void log_to(const char *name, const op_value *v) {
	world *m = world_();
	for (size_t i = 0; i < m->nlogs; i++) {
		if (strcmp(m->logs[i].name, name) == 0) {
			op_push(m->logs[i].values, v ? op_ref((op_value *)v) : op_null());
			return;
		}
	}
	logged l = {xdup(name), op_list()};
	op_push(l.values, v ? op_ref((op_value *)v) : op_null());
	PUSH(m->logs, m->nlogs, m->caplogs, l);
}

// how many values a log holds now
static size_t log_count(const char *name) {
	world *m = world_();
	for (size_t i = 0; i < m->nlogs; i++) {
		if (strcmp(m->logs[i].name, name) == 0) return m->logs[i].values->count;
	}
	return 0;
}

// a string kept as long as the world
static const char *kept(const char *s) {
	world *m = world_();
	char *c = xdup(s);
	PUSH(m->closures, m->nclosures, m->capclosures, (void *)c);
	return c;
}
static void *closure(size_t n) {
	world *m = world_();
	void *p = xalloc(n);
	PUSH(m->closures, m->nclosures, m->capclosures, p);
	return p;
}
// a reference to v, let go with the world (a closure is freed whole, not what it refers to)
static op_value *held(const op_value *v) {
	world *m = world_();
	op_value *r = op_ref((op_value *)v);
	PUSH(m->held, m->nheld, m->capheld, r);
	return r;
}

// values and nodes ---------------------------------------------------------------------------------

// "$x" anywhere in an argument is the name x; anything else as it is. a new tree (NULL: undefined)
static op_value *arg(const env *e, const op_value *a) {
	if (a == NULL) return NULL;
	if (a->type == OP_STR && a->str[0] == '$') {
		op_value *v = env_get(e, a->str + 1);
		return v ? op_ref(v) : NULL;
	}
	if (a->type == OP_LIST) {
		op_value *l = op_list();
		for (size_t i = 0; i < a->count; i++) {
			op_value *x = arg(e, a->items[i]);
			op_push(l, x ? x : op_null());
		}
		return l;
	}
	if (a->type == OP_MAP) {
		op_value *m = op_map();
		for (size_t i = 0; i < a->count; i++) {
			op_value *x = arg(e, a->items[i]);
			op_set(m, a->keys[i], x ? x : op_null());
		}
		return m;
	}
	return op_ref((op_value *)a);
}

static op_value *node_json(const api_node *n) {
	op_value *o = op_map();
	if (n->path) {
		op_value *p = op_list();
		for (size_t i = 0; i < n->npath; i++) op_push(p, op_str(n->path[i]));
		op_set(o, "path", p);
	} else op_set(o, "id", op_str(n->id));
	op_set(o, "part", op_str(n->part));
	return o;
}
// a node from its JSON; the part is one of the api's names
static int node_of(const op_value *v, api_node *out) {
	if (v == NULL || v->type != OP_MAP) return 0;
	const char *part = hh_str(v, "part");
	if (part == NULL) return 0;
	*out = (api_node){.part = strcmp(part, API_ATTRIBUTES) == 0 ? API_ATTRIBUTES : API_VALUE};
	const op_value *p = op_get(v, "path");
	if (p && p->type == OP_LIST) {
		out->path = xalloc((p->count + 1) * sizeof *out->path);
		out->npath = p->count;
		for (size_t i = 0; i < p->count; i++) out->path[i] = xdup(p->items[i]->str);
	} else if (hh_str(v, "id")) out->id = xdup(hh_str(v, "id"));
	else return 0;
	return 1;
}

static op_key *keys_of(const op_value *list, size_t *n) {
	*n = list && list->type == OP_LIST ? list->count : 0;
	op_key *k = xalloc((*n + 1) * sizeof *k);
	for (size_t i = 0; i < *n; i++) {
		const op_value *s = list->items[i];
		if (s->type == OP_STR) k[i] = (op_key){.type = OP_STR_KEY, .s = s->str};
		else k[i] = (op_key){.type = OP_NUM_KEY, .n = (long)s->num};
	}
	return k;
}

// the result of an api call: a value, or a code
typedef struct {
	op_value *v;
	int code;
	char *text;
} res;
static res ok(op_value *v) { return (res){v, 0, NULL}; }
static res bad(api *a, int code) { return (res){NULL, code, xdup(api_why(a))}; }
static res broke(const char *text) { return (res){NULL, API_FAILED, xdup(text)}; }

static res call(api *a, env *e, const op_value *c);

static res expr(api *a, env *e, const op_value *x) {
	if (x->type == OP_STR) {
		op_value *v = arg(e, x);
		return ok(v);
	}
	if (x->type != OP_LIST || x->count == 0 || x->items[0]->type != OP_STR) {
		return broke("not an expression");
	}
	if (strcmp(x->items[0]->str, "all") == 0) {
		op_value *l = op_list();
		for (size_t i = 1; i < x->count; i++) {
			res r = expr(a, e, x->items[i]);
			if (r.code) return op_free(l), r;
			op_push(l, r.v ? r.v : op_null());
		}
		return ok(l);
	}
	if (strcmp(x->items[0]->str, "if") == 0 && x->count >= 3) {
		res t = expr(a, e, x->items[1]);
		if (t.code) return t;
		bool yes = t.v && t.v->type == OP_BOOL && t.v->bool_;
		op_free(t.v);
		if (yes) return expr(a, e, x->items[2]);
		return x->count > 3 ? expr(a, e, x->items[3]) : ok(NULL);
	}
	if (strcmp(x->items[0]->str, "throw") == 0 && x->count >= 2 && x->items[1]->type == OP_STR) {
		return broke(x->items[1]->str);
	}
	return call(a, e, x);
}

// a step: { do: [fn, ...args], as? }
static res run(api *a, env *e, const op_value *steps) {
	for (size_t i = 0; i < steps->count; i++) {
		const op_value *s = steps->items[i];
		res r = call(a, e, op_get(s, "do"));
		if (r.code) return r;
		const char *as = hh_str(s, "as");
		if (as) env_set(e, as, r.v);
		else op_free(r.v);
	}
	return ok(NULL);
}

// a memo's or effect's expression, evaluated in its run
typedef struct {
	env *e;
	op_value *expr;
	const char *log;
} computing;
static bool json_equal(const op_value *p, const op_value *q, void *ctx) {
	(void)ctx;
	if (p == NULL || q == NULL) return p == q;
	return pr_same(p, q);
}
static sc_out compute_f(api *a, const op_value *previous, void *ctx) {
	(void)previous;
	computing *c = ctx;
	res r = expr(a, c->e, c->expr);
	free(r.text);
	if (r.code == API_PENDING) return (sc_out){.kind = SC_PENDING};
	if (r.code == API_STOP) return op_free(r.v), (sc_out){.kind = SC_VALUE};
	if (r.code) return (sc_out){.kind = SC_FAILED, .error = xdup(api_code_name(r.code))};
	return (sc_out){.kind = SC_VALUE, .value = r.v};
}
static void effect_act(api *a, const op_value *value, const op_value *before, void *ctx) {
	(void)a, (void)before;
	log_to(((computing *)ctx)->log, value);
}

typedef struct {
	env *e;
	op_value *steps, *back;
} methoding;
static int method_f(api *a, const op_value *const *args, size_t nargs, op_value **out, void *ctx) {
	methoding *m = ctx;
	// the names a closure made in this call refers to outlive it: kept till the world goes
	env *inner = xalloc(sizeof *inner);
	*inner = env_copy(m->e);
	PUSH(world_()->envs, world_()->nenvs, world_()->capenvs, inner);
	for (size_t i = 0; i < nargs; i++) {
		char key[24];
		snprintf(key, sizeof key, "%zu", i);
		env_set(inner, key, args[i] ? op_ref((op_value *)args[i]) : NULL);
	}
	res r = run(a, inner, m->steps);
	if (!r.code && m->back) {
		r = expr(a, inner, m->back);
		*out = r.v;
	}
	int code = r.code;
	free(r.text);
	return code;
}

static void teardown_f(const op_value *why, void *ctx) { log_to(ctx, why); }

static op_value *patches_json(const pl_fact *f) {
	char *text;
	size_t size;
	FILE *s = open_memstream(&text, &size);
	if (s == NULL) hh_fail("out of memory");
	putc('[', s);
	for (size_t i = 0; i < f->patches_length; i++) {
		if (i) putc(',', s);
		hh_put_patch(s, &f->patches[i]);
	}
	putc(']', s);
	fclose(s);
	op_value *list = op_json_read(text, NULL);
	free(text);
	return list;
}
static void watch_f(const pl_fact *f, void *ctx) {
	op_value *p = patches_json(f);
	log_to(ctx, p);
	op_free(p);
}

static op_value *made_f(void *ctx) { return op_ref(ctx); }

static op_value *items_json(const api_items *items) {
	op_value *l = op_list();
	for (size_t i = 0; i < items->n; i++) {
		const api_item *it = &items->items[i];
		op_value *o = op_map();
		if (it->value) op_set(o, "value", op_ref(it->value));
		op_set(o, "from", op_str(it->from));
		if (it->id) op_set(o, "id", op_str(it->id));
		if (it->refused) op_set(o, "refused", op_bool(1));
		op_push(l, o);
	}
	return l;
}

// an api function called as the program would: [fn, ...args]
static res call(api *a, env *e, const op_value *c) {
	if (c == NULL || c->type != OP_LIST || c->count == 0 || c->items[0]->type != OP_STR) {
		return broke("not a call");
	}
	const char *fn = c->items[0]->str;
	const op_value *const *raw = (const op_value *const *)c->items + 1;
	size_t nraw = c->count - 1;
	api_node out = {0};
	int code;
	if (strcmp(fn, "memo") == 0) {
		computing *m = closure(sizeof *m);
		m->e = e, m->expr = held(raw[2]);
		const op_value *o = raw[1];
		api_options options = {0};
		if (o && o->type == OP_MAP && hh_str(o, "equal") && strcmp(hh_str(o, "equal"), "json") == 0) {
			options.equal = json_equal;
		}
		if ((code = api_memo(a, raw[0]->str, compute_f, m, &options, &out))) return bad(a, code);
		res r = ok(node_json(&out));
		api_node_free(&out);
		return r;
	}
	if (strcmp(fn, "effect") == 0 || strcmp(fn, "early") == 0) {
		computing *m = closure(sizeof *m);
		m->e = e, m->expr = held(raw[1]), m->log = kept(raw[2]->str);
		code = strcmp(fn, "early") == 0 ? api_early(a, raw[0]->str, compute_f, effect_act, m, NULL, &out)
		                                : api_effect(a, raw[0]->str, compute_f, effect_act, m, NULL, &out);
		if (code) return bad(a, code);
		res r = ok(node_json(&out));
		api_node_free(&out);
		return r;
	}
	if (strcmp(fn, "log") == 0) {
		res r = expr(a, e, raw[1]);
		if (r.code) return r;
		log_to(raw[0]->str, r.v);
		return r;
	}
	if (strcmp(fn, "count") == 0) {
		op_value *n = op_num((double)log_count(raw[0]->str));
		log_to(raw[1]->str, n);
		op_free(n);
		return ok(NULL);
	}
	if (strcmp(fn, "method") == 0) {
		methoding *m = closure(sizeof *m);
		m->e = e, m->steps = held(raw[1]);
		m->back = nraw > 2 && raw[2] ? held(raw[2]) : NULL;
		if ((code = api_method(a, raw[0]->str, method_f, m, &out))) return bad(a, code);
		res r = ok(node_json(&out));
		api_node_free(&out);
		return r;
	}
	if (strcmp(fn, "teardown") == 0) {
		if ((code = api_teardown(a, teardown_f, (void *)kept(raw[0]->str)))) return bad(a, code);
		return ok(NULL);
	}
	if (strcmp(fn, "ref") == 0) {
		if ((code = api_ref(a, raw[0]->str, made_f, (void *)raw[1], &out))) return bad(a, code);
		res r = ok(node_json(&out));
		api_node_free(&out);
		return r;
	}
	// the rest take their arguments with the names in them filled
	op_value **args = xalloc((nraw + 1) * sizeof *args);
	for (size_t i = 0; i < nraw; i++) args[i] = arg(e, raw[i]);
	res r = {0};
	// a target: a path string, or a node
	api_node tn[3] = {{0}};
	api_target t[3];
	for (size_t i = 0; i < nraw && i < 3; i++) {
		if (args[i] && args[i]->type == OP_STR) t[i] = api_at(args[i]->str);
		else if (node_of(args[i], &tn[i])) t[i] = api_of(&tn[i]);
		else t[i] = api_at("");
	}
	const char *s0 = nraw > 0 && args[0] && args[0]->type == OP_STR ? args[0]->str : "";
	const char *s1 = nraw > 1 && args[1] && args[1]->type == OP_STR ? args[1]->str : "";
	if (strcmp(fn, "watch") == 0) {
		api_watching *wt;
		if ((code = api_watch(a, t[0], watch_f, (void *)kept(raw[1]->str), &wt))) r = bad(a, code);
		else r = ok(NULL);
	} else if (strcmp(fn, "open") == 0) {
		code = api_open(a, s0, nraw > 1 ? args[1] : NULL, &out);
		r = code ? bad(a, code) : ok(node_json(&out));
	} else if (strcmp(fn, "create") == 0) {
		code = api_create(a, s0, nraw > 1 ? args[1] : NULL, &out);
		r = code ? bad(a, code) : ok(node_json(&out));
	} else if (strcmp(fn, "info") == 0) {
		code = api_info(a, t[0], &out);
		r = code ? bad(a, code) : ok(node_json(&out));
	} else if (strcmp(fn, "read") == 0) {
		size_t n;
		op_key *keys = keys_of(nraw > 1 ? args[1] : NULL, &n);
		const op_value *v;
		code = api_read(a, t[0], keys, n, &v);
		free(keys);
		r = code ? bad(a, code) : ok(v ? op_ref((op_value *)v) : NULL);
	} else if (strcmp(fn, "peep") == 0) {
		size_t n;
		op_key *keys = keys_of(nraw > 1 ? args[1] : NULL, &n);
		const op_value *v;
		code = api_peep(a, t[0], keys, n, &v);
		free(keys);
		r = code ? bad(a, code) : ok(v ? op_ref((op_value *)v) : NULL);
	} else if (strcmp(fn, "entries") == 0) {
		api_items items;
		code = api_entries(a, t[0], &items);
		if (code) r = bad(a, code);
		else r = ok(items_json(&items)), api_items_free(&items);
	} else if (strcmp(fn, "list") == 0) {
		api_names names;
		code = api_list(a, t[0], &names);
		if (code) r = bad(a, code);
		else {
			op_value *l = op_list();
			for (size_t i = 0; i < names.n; i++) op_push(l, op_str(names.items[i]));
			api_names_free(&names);
			r = ok(l);
		}
	} else if (strcmp(fn, "edit") == 0) {
		const op_value *ps = nraw > 1 ? args[1] : NULL;
		size_t n = ps && ps->type == OP_LIST ? ps->count : 0;
		op_patch *patches = hh_take((n + 1) * sizeof *patches);
		for (size_t i = 0; i < n; i++) hh_patch(ps->items[i], &patches[i]);
		if (ps) hh_hold(op_ref((op_value *)ps));
		code = api_edit(a, t[0], patches, n);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "place") == 0) {
		code = api_place(a, s0, t[1]);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "unplace") == 0) {
		code = api_unplace(a, s0);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "move") == 0) {
		code = api_move(a, s0, s1);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "remove") == 0) {
		code = api_remove(a, t[0]);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "send") == 0) {
		op_value *back;
		code = api_send(a, t[0], (const op_value *const *)args + 1, nraw ? nraw - 1 : 0, &back);
		r = code ? bad(a, code) : ok(back);
	} else if (strcmp(fn, "presence") == 0) {
		pres_lives rows;
		code = api_presence(a, t[0], &rows);
		if (code) r = bad(a, code);
		else {
			op_value *l = op_list();
			for (size_t i = 0; i < rows.n; i++) {
				op_value *o = op_map();
				op_set(o, "who", op_str(rows.items[i].who));
				op_set(o, "value", op_ref(rows.items[i].value));
				op_set(o, "until", op_num((double)rows.items[i].until));
				op_push(l, o);
			}
			pres_lives_free(&rows);
			r = ok(l);
		}
	} else if (strcmp(fn, "present") == 0) {
		const op_value *o = nraw > 2 ? args[2] : NULL;
		api_present options = {0};
		if (o && o->type == OP_MAP) {
			const op_value *ttl = op_get(o, "ttl");
			if (ttl && ttl->type == OP_NUM) options.ttl = (int64_t)ttl->num;
			options.who = hh_str(o, "who");
		}
		code = api_present_at(a, t[0], nraw > 1 ? args[1] : NULL, &options);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "absent") == 0) {
		const op_value *o = nraw > 1 ? args[1] : NULL;
		code = api_absent(a, t[0], o && o->type == OP_MAP ? hh_str(o, "who") : NULL);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "patch") == 0) {
		code = api_patch(a, s0, t[1], nraw > 2 ? args[2] : NULL, &out);
		r = code ? bad(a, code) : ok(node_json(&out));
	} else if (strcmp(fn, "land") == 0) {
		code = api_land(a, t[0]);
		r = code ? bad(a, code) : ok(NULL);
	} else if (strcmp(fn, "layers") == 0) {
		size_t n;
		op_key *keys = keys_of(nraw > 1 ? args[1] : NULL, &n);
		api_layers layers;
		code = api_layers_of(a, t[0], keys, n, &layers);
		free(keys);
		if (code) r = bad(a, code);
		else {
			op_value *l = op_list();
			for (size_t i = 0; i < layers.n; i++) {
				op_value *o = op_map();
				if (layers.items[i].value) op_set(o, "value", op_ref(layers.items[i].value));
				op_set(o, "from", op_str(layers.items[i].from));
				if (layers.items[i].stale) op_set(o, "stale", op_bool(1));
				if (layers.items[i].error) op_set(o, "error", op_str(layers.items[i].error));
				op_push(l, o);
			}
			api_layers_free(&layers);
			r = ok(l);
		}
	} else if (strcmp(fn, "pulse") == 0) {
		api_pulse(a);
		r = ok(NULL);
	} else {
		char text[128];
		snprintf(text, sizeof text, "no api function %s", fn);
		r = broke(text);
	}
	api_node_free(&out);
	for (size_t i = 0; i < 3; i++) api_node_free(&tn[i]);
	for (size_t i = 0; i < nraw; i++) op_free(args[i]);
	free(args);
	return r;
}

// requests -----------------------------------------------------------------------------------------

static op_value *error_answer(int code, const char *text) {
	op_value *o = op_map();
	op_set(o, "error", op_str(code == API_FAILED && text ? text : api_code_name(code)));
	return o;
}

static running *running_named(const char *name) {
	world *m = world_();
	for (size_t i = 0; i < m->nprocs; i++) {
		if (strcmp(m->procs[i]->name, name) == 0) return m->procs[i];
	}
	return NULL;
}

static char **strings_of(const op_value *list, size_t *n) {
	*n = list && list->type == OP_LIST ? list->count : 0;
	char **v = xalloc((*n + 1) * sizeof *v);
	for (size_t i = 0; i < *n; i++) v[i] = xdup(list->items[i]->str);
	return v;
}

// a children or other entry put at (part, id), in the host's scope
typedef struct {
	const char *part;
	const char *id;
	const op_value *value;
	int code;
} putting;
static void put_in(void *data) {
	putting *p = data;
	world *m = world_();
	ch_header h;
	pl_made *made;
	char *bad_ = pl_header(m->places, NULL, 0, NULL, &h, &made);
	if (bad_) {
		free(bad_);
		p->code = -1;
		return;
	}
	nd_entry *e = nd_make_entry((op_value *)p->value, &h, NULL);
	pl_own(m->places, e);
	pl_hold(m->places, e, made, pl_made_free);
	tb_sub(m->table, tb_string(p->part), tb_string(p->id), e);
}

typedef struct {
	running *r;
	const op_value *program;
	res out;
} starting;
static void add_row(void *data) {
	starting *s = data;
	world *m = world_();
	ch_header h;
	pl_made *made;
	char *bad_ = pl_header(m->places, NULL, 0, NULL, &h, &made);
	if (bad_) {
		free(bad_);
		return;
	}
	pl_changed changed = {0};
	nd_entry *node = NULL;
	int code = pr_add(m->places, m->table, tb_string("R"), CP_(s->r->at), s->r->nat,
		tb_string(s->r->id), h, &changed, &node);
	if (code) {
		pl_made_free(made);
		s->out = broke(pl_code_name(code));
		return;
	}
	pl_commit(m->places, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(m->places, changed.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (node) pl_hold(m->places, node, made, pl_made_free);
	else pl_made_free(made);
}
static void run_program(void *data) {
	starting *s = data;
	s->out = run(s->r->api, &s->r->env, s->program);
}

// lowercase, 8-4-4-4-12, version 7, variant 10
static bool is_uuidv7(const char *s) {
	if (s == NULL || strlen(s) != 36) return false;
	for (int i = 0; i < 36; i++) {
		bool dash = i == 8 || i == 13 || i == 18 || i == 23;
		if (dash ? s[i] != '-' : !((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
	}
	return s[14] == '7' && strchr("89ab", s[19]) != NULL;
}

static op_value *answer(const op_value *r) {
	const char *op = hh_str(r, "op");
	if (op == NULL) return error_answer(API_FAILED, "no op");
	if (strcmp(op, "world") == 0) {
		if (w) finish(w);
		w = make(r);
		return op_map();
	}
	world *m = world_();
	if (strcmp(op, "kids") == 0 || strcmp(op, "put") == 0) {
		bool kids = op[0] == 'k';
		putting p = {kids ? "children" : hh_str(r, "part"), hh_str(r, "id"), op_get(r, "value"), 0};
		sc_run_with_scope(m->host, put_in, &p);
		return op_map();
	}
	if (strcmp(op, "saved") == 0) {
		const nd_entry *e = tb_get(m->table, tb_string(hh_str(r, "part")), tb_string(hh_str(r, "id")));
		op_value *o = op_map();
		const op_value *v = e ? e->value : NULL;
		const op_value *path = op_get(r, "path");
		for (size_t i = 0; v && path && path->type == OP_LIST && i < path->count; i++) {
			v = v->type == OP_MAP && path->items[i]->type == OP_STR ? op_get(v, path->items[i]->str) : NULL;
		}
		if (v) op_set(o, "value", op_ref((op_value *)v));
		return o;
	}
	if (strcmp(op, "metadata") == 0) {
		const nd_entry *e = tb_get(m->table, tb_string(hh_str(r, "part")), tb_string(hh_str(r, "id")));
		op_value *o = op_map(), *keys = op_list();
		const op_value *node = NULL;
		size_t n = e ? e->change.metadata_length : 0;
		const char **sorted = xalloc((n ? n : 1) * sizeof *sorted);
		for (size_t i = 0; i < n; i++) {
			sorted[i] = e->change.metadata[i].key;
			if (strcmp(e->change.metadata[i].key, PL_NODE) == 0) node = e->change.metadata[i].value;
		}
		qsort(sorted, n, sizeof *sorted, by_text);
		for (size_t i = 0; i < n; i++) op_push(keys, op_str(sorted[i]));
		free(sorted);
		op_set(o, "keys", keys);
		if (node) op_set(o, "node", op_ref((op_value *)node));
		return o;
	}
	if (strcmp(op, "change") == 0) {
		const nd_entry *e = tb_get(m->table, tb_string(hh_str(r, "part")), tb_string(hh_str(r, "id")));
		op_value *o = op_map();
		if (e == NULL) return o;
		if (e->change.actor) op_set(o, "actor", op_ref((op_value *)e->change.actor));
		// the keys asked for, from the metadata
		for (size_t i = 0; i < e->change.metadata_length; i++)
			found_pair(o, e->change.metadata[i].key, e->change.metadata[i].value);
		return o;
	}
	if (strcmp(op, "id") == 0) {
		size_t n;
		char **path = strings_of(op_get(r, "path"), &n);
		tb_key id;
		op_value *o = op_map();
		if (pl_get(m->places, (const char *const *)path, n, &id)) op_set(o, "id", op_str(id.string));
		for (size_t i = 0; i < n; i++) free(path[i]);
		free(path);
		return o;
	}
	if (strcmp(op, "uuids") == 0) {
		const op_value *paths = op_get(r, "paths");
		bool v7 = true, ordered = true;
		char *before = NULL;
		for (size_t k = 0; paths && paths->type == OP_LIST && k < paths->count; k++) {
			size_t n;
			char **path = strings_of(paths->items[k], &n);
			tb_key id;
			char *now = pl_get(m->places, (const char *const *)path, n, &id) ? xdup(id.string) : NULL;
			for (size_t i = 0; i < n; i++) free(path[i]);
			free(path);
			if (!is_uuidv7(now)) v7 = false;
			if (k && (now == NULL || before == NULL || strcmp(now, before) <= 0)) ordered = false;
			free(before);
			before = now;
		}
		free(before);
		op_value *o = op_map();
		op_set(o, "v7", op_bool(v7));
		op_set(o, "ordered", op_bool(ordered));
		return o;
	}
	if (strcmp(op, "now") == 0) {
		m->clock = (int64_t)op_get(r, "t")->num;
		return op_map();
	}
	if (strcmp(op, "start") == 0) {
		running *p = xalloc(sizeof *p);
		p->name = xdup(hh_str(r, "name"));
		p->at = strings_of(op_get(r, "at"), &p->nat);
		p->at_value = op_ref((op_value *)op_get(r, "at"));
		const op_value *cwd = op_get(r, "cwd");
		if (cwd) p->cwd = strings_of(cwd, &p->ncwd);
		else {
			p->cwd = xalloc((p->nat + 1) * sizeof *p->cwd);
			p->ncwd = p->nat ? p->nat - 1 : 0;
			for (size_t i = 0; i < p->ncwd; i++) p->cwd[i] = xdup(p->at[i]);
		}
		p->args = strings_of(op_get(r, "args"), &p->nargs);
		// its id first, then its scope [["process", at], [PL_NODE, id]]
		char want[256];
		snprintf(want, sizeof want, "proc:%s", p->name);
		p->id = xdup(want);
		p->id_value = op_str(p->id);
		sc_pair *info = xalloc(2 * sizeof *info);
		info[0] = (sc_pair){"process", p->at_value};
		info[1] = (sc_pair){PL_NODE, p->id_value};
		p->scope = sc_create_scope(m->s, info, 2, m->above);
		sn_give(m->scopes, p->scope, p->id);
		PUSH(m->closures, m->nclosures, m->capclosures, info);
		p->process = (api_process){p->id, (const char *const *)p->at, p->nat,
			(const char *const *)p->cwd, p->ncwd, (const char *const *)p->args, p->nargs, p->scope};
		PUSH(m->procs, m->nprocs, m->capprocs, p);
		starting s = {p, op_get(r, "program"), ok(NULL)};
		sc_run_with_scope(p->scope, add_row, &s);
		if (s.out.code) {
			op_value *e = error_answer(s.out.code, s.out.text);
			free(s.out.text);
			return e;
		}
		p->api = api_new(m->context, &(api_starting){.process = p->process});
		sc_run_with_scope(p->scope, run_program, &s);
		if (s.out.code) {
			op_value *e = error_answer(s.out.code, s.out.text);
			free(s.out.text);
			return e;
		}
		op_value *o = op_map();
		op_set(o, "id", op_str(p->id));
		return o;
	}
	if (strcmp(op, "stop") == 0) {
		running *p = running_named(hh_str(r, "name"));
		if (p == NULL) return error_answer(API_FAILED, "no process");
		api_stop(m->context, &p->process, op_get(r, "why"));
		return op_map();
	}
	if (strcmp(op, "do") == 0) {
		running *p = running_named(hh_str(r, "process"));
		if (p == NULL) return error_answer(API_FAILED, "no process");
		res x = call(p->api, &p->env, op_get(r, "call"));
		if (x.code) {
			op_value *e = error_answer(x.code, x.text);
			free(x.text);
			return e;
		}
		op_value *o = op_map();
		const char *as = hh_str(r, "as");
		if (as) env_set(&p->env, as, x.v ? op_ref(x.v) : NULL);
		if (x.v) op_set(o, "value", x.v);
		return o;
	}
	if (strcmp(op, "log") == 0) {
		op_value *o = op_map(), *values = NULL;
		for (size_t i = 0; i < m->nlogs; i++) {
			if (strcmp(m->logs[i].name, hh_str(r, "name")) == 0) values = op_ref(m->logs[i].values);
		}
		op_set(o, "values", values ? values : op_list());
		return o;
	}
	if (strcmp(op, "events") == 0) {
		op_value *o = op_map();
		op_set(o, "events", m->events);
		m->events = op_list();
		return o;
	}
	if (strcmp(op, "pulse") == 0) {
		sc_pulse(m->s);
		return op_map();
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) {
	op_value *a = answer(request);
	if (a == NULL) {
		hh_unknown(out, request);
		return;
	}
	if (w) drain();
	op_json_write(out, a);
	op_free(a);
}

void hh_finish(void) {
	if (w) finish(w);
	w = NULL;
}
