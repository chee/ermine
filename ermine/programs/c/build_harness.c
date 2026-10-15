// build (build.h) on the line protocol of typescript/build_harness.ts, which documents it and the
// compilers (conformance/c/harness.h has the loop). Its world is places' (world.h): the scheduler, the
// table, the host's scope and places (root "R", children alone); this adds the builds, the watches and
// the compilers.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

#include "../../../filesystem/places/c/world.h"
#include "build.h"
#include "mem.h"

static hf *functions;
static bd **builds;
static size_t nbuilds, capbuilds;
static char *cache;

// the compilers, and their calls
static unsigned calls_upper, calls_wrap, calls_slow, calls_boom, calls_live;

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

static hf_out live(const op_value *input, const hf_context *ctx, void *data) {
	(void)input, (void)ctx, (void)data;
	calls_live++;
	return (hf_out){.kind = HF_VALUE, .value = hf_value("")};
}

static void begin(void) {
	functions = hf_new();
	hf_add_compiler(functions, "upper", upper, NULL);
	hf_add_compiler(functions, "wrap", wrap, NULL);
	hf_add_compiler(functions, "slow", slow, NULL);
	hf_add_compiler(functions, "boom", boom, NULL);
	hf_add_compiler(functions, "live", live, NULL);
}

// writes ------------------------------------------------------------------------------------------------

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
	nd_entry *node = nd_make_entry((op_value *)e->value, &h, NULL);
	pl_hold(world_places, node, made, pl_made_free);
	world_keep_node(node);
	tb_sub(world_table, tb_string(e->part), e->id, node);
}

typedef struct {
	bd *made;
} making;
static void make_builds(void *data) {
	making *m = data;
	m->made = bd_new(&(bd_setup){.places = world_places, .table = world_table, .scheduler = world_scheduler,
		.cache = cache, .functions = functions});
}

// watches -----------------------------------------------------------------------------------------------

typedef struct {
	world_watch watch;
	bd *builds;
	const op_value *request;
	char **compilers;
	size_t ncompilers;
} watching;
static watching **watches;
static size_t nwatches, capwatches;
static char **scopes;
static size_t nscopes, capscopes;

static op_value *refused(const char *code) {
	op_value *m = op_map();
	op_set(m, "refused", op_str(code));
	return m;
}

static sc_out watch_f(void *previous, void *data) {
	(void)previous;
	watching *w = data;
	w->watch.runs++;
	const op_value *r = w->request, *node = op_get(r, "node");
	const op_value *v = node == NULL ? op_get(r, "input")
	                                 : pl_read(world_places, tb_string("value"), world_key(node), NULL, 0);
	op_value *out = NULL;
	for (size_t i = 0; i < w->ncompilers && out == NULL; i++) {
		bd_result b = bd_compile(w->builds, w->compilers[i], v);
		switch (b.kind) {
		case BD_STOP: return (sc_out){.kind = SC_VALUE};
		case BD_VALUE: v = b.value; break;
		case BD_PENDING: out = op_str("pending"); break;
		case BD_REFUSED: out = refused(b.text); break;
		case BD_FAILED:
			out = op_map();
			op_set(out, "failed", op_str(b.text));
			break;
		}
	}
	if (out == NULL) out = v != NULL ? op_ref((op_value *)v) : op_null();
	if (pl_status(world_places) == SC_STOP) {
		op_free(out);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = out};
}

static watching *watch_named(const char *name) {
	for (size_t i = 0; i < nwatches; i++) {
		if (strcmp(watches[i]->watch.name, name) == 0) return watches[i];
	}
	return NULL;
}

// requests ----------------------------------------------------------------------------------------------

static op_value *with(const char *key, op_value *v) {
	op_value *o = op_map();
	op_set(o, key, v);
	return o;
}

static op_value *answer(const op_value *r) {
	if (functions == NULL) begin();
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (strcmp(op, "attrs") == 0 || strcmp(op, "compiler") == 0) {
		op_value *fn = NULL;
		entering e = {"attributes", world_key(op_get(r, "id")), op_get(r, "value")};
		if (op[0] == 'c') {
			const char *name = world_text(op_get(r, "compiler"));
			fn = hf_value(name);
			e.part = "value", e.value = fn;
		}
		world_hosted(enter, &e);
		op_free(fn);
		return op_map();
	}
	if (strcmp(op, "builds") == 0) {
		for (size_t i = 0; i < nscopes; i++) {
			sc_scope *o = world_scope(scopes[i]);
			if (o != NULL && sc_scope_alive(o)) free(sc_teardown(o));
		}
		if (nbuilds) bd_stop(builds[nbuilds - 1]);
		free(cache);
		cache = world_copy(world_text(op_get(r, "cache")));
		making m = {0};
		world_hosted(make_builds, &m);
		PG_PUSH(builds, nbuilds, capbuilds, m.made);
		return op_map();
	}
	if (strcmp(op, "watch") == 0) {
		if (nbuilds == 0) return world_error("no builds");
		const char *name = world_text(op_get(r, "name"));
		watching *w = world_alloc(sizeof *w);
		w->builds = builds[nbuilds - 1];
		w->request = r;
		const op_value *list = op_get(r, "compilers");
		w->ncompilers = list != NULL ? list->count : 0;
		w->compilers = world_alloc((w->ncompilers + 1) * sizeof *w->compilers);
		for (size_t i = 0; i < w->ncompilers; i++) w->compilers[i] = world_copy(world_text(list->items[i]));
		PG_PUSH(watches, nwatches, capwatches, w);
		char *scope = world_format("%s#scope", name);
		sc_scope *o = sc_create_scope(world_scheduler, NULL, 0, world_host);
		char *bad = world_name(o, scope);
		if (bad) return free(scope), world_error_take(bad);
		PG_PUSH(scopes, nscopes, capscopes, scope);
		bad = world_make(&w->watch, name, scope, (sc_def){.f = watch_f, .set = world_set, .equal = world_equal, .data = w},
			false);
		if (bad) return world_error_take(bad);
		return op_map();
	}
	if (strcmp(op, "stop") == 0) {
		char *scope = world_format("%s#scope", world_text(op_get(r, "name")));
		sc_scope *o = world_scope(scope);
		free(scope);
		if (o == NULL) return world_error("no such watch");
		free(sc_teardown(o));
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
	if (strcmp(op, "state") == 0 || strcmp(op, "runs") == 0) {
		watching *w = watch_named(world_text(op_get(r, "name")));
		if (w == NULL) return world_error("no such watch");
		if (op[0] == 'r') return with("runs", op_num((double)w->watch.runs));
		if (w->watch.runs == 0 || w->watch.value == NULL) return with("value", op_str(w->watch.runs == 0 ? "pending" : "null"));
		return with("value", op_ref(w->watch.value));
	}
	if (strcmp(op, "calls") == 0) {
		op_value *o = op_map();
		op_set(o, "upper", op_num(calls_upper));
		op_set(o, "wrap", op_num(calls_wrap));
		op_set(o, "slow", op_num(calls_slow));
		op_set(o, "boom", op_num(calls_boom));
		op_set(o, "live", op_num(calls_live));
		return o;
	}
	if (strcmp(op, "cache") == 0) {
		if (cache == NULL) return world_error("no builds");
		const nd_entry *e = tb_get(world_table, tb_string("children"), tb_string(cache));
		op_value *entries = op_map();
		size_t size = 0;
		if (e != NULL && e->value != NULL && e->value->type == OP_MAP) {
			for (size_t i = 0; i < e->value->count; i++) {
				const nd_entry *n = tb_get(world_table, tb_string("value"), tb_string(e->value->items[i]->str));
				op_set(entries, e->value->keys[i], n != NULL && n->value != NULL ? op_ref(n->value) : op_null());
				size++;
			}
		}
		op_value *o = op_map();
		op_set(o, "size", op_num((double)size));
		op_set(o, "entries", entries);
		return o;
	}
	if (strcmp(op, "kinds") == 0) {
		if (cache == NULL) return world_error("no builds");
		const nd_entry *e = tb_get(world_table, tb_string("children"), tb_string(cache));
		op_value *types = op_map();
		if (e != NULL && e->value != NULL && e->value->type == OP_MAP) {
			for (size_t i = 0; i < e->value->count; i++) {
				const nd_entry *n = tb_get(world_table, tb_string("attributes"), tb_string(e->value->items[i]->str));
				const op_value *t = n != NULL && n->value != NULL ? op_get(n->value, "ermine.type") : NULL;
				op_set(types, e->value->keys[i], t != NULL ? op_ref((op_value *)t) : op_null());
			}
		}
		op_value *o = op_map();
		op_set(o, "types", types);
		return o;
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	for (size_t i = 0; i < nbuilds; i++) bd_stop(builds[i]);
	for (size_t i = 0; i < nwaiting; i++) sc_promise_free(waiting[i].promise);
	world_finish();
	for (size_t i = 0; i < nbuilds; i++) bd_free(builds[i]);
	for (size_t i = 0; i < nwaiting; i++) op_free(waiting[i].input);
	for (size_t i = 0; i < nwatches; i++) {
		for (size_t j = 0; j < watches[i]->ncompilers; j++) free(watches[i]->compilers[j]);
		free(watches[i]->compilers);
		free(watches[i]);
	}
	for (size_t i = 0; i < nscopes; i++) free(scopes[i]);
	free(scopes), free(watches), free(builds), free(waiting), free(cache);
	hf_free(functions);
}
