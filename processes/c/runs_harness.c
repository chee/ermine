// The C runs on the line protocol of typescript/runs_harness.ts.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../places/c/places_harness.h"
#include "guard.h"
op_value *sh_answer(const op_value *r);
void sh_finish(void);
#include "runs.h"

static crn *runs;
static char **denied;
static size_t ndenied, capdenied;
static pr_policy *policy;
static gd *guard;

static pr_answer may(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)ctx, (void)read;
	const char *id = ask->target.id.string;
	for (size_t i = 0; id != NULL && i < ndenied; i++) {
		if (strcmp(denied[i], id) == 0) return (pr_answer){.verdict = PR_NO, .reason = "denied"};
	}
	return (pr_answer){.verdict = PR_YES};
}

static int ask_guard(void *ctx, tb_key id, const char **op, const char **reason) {
	(void)ctx;
	gd_target t = gd_target_of((gd_thing){.id = id}, NULL, NULL);
	gd_refusal why = {0};
	gd_answer a = gd_read(guard, &t, 1, &why);
	if (a == GD_REFUSED) *op = why.op, *reason = why.reason;
	return a;
}

typedef struct {
	world_watch watch;
	const op_value *f, *act;
	const char *wait;
} effect_p;
typedef struct {
	char *name;
	sc_promise *p;
} wait_p;
static wait_p *waits;
static size_t nwaits, capwaits;
static effect_p **effects;
static size_t neffects, capeffects;

static sc_out effect_f(void *previous, void *data) {
	(void)previous;
	effect_p *p = data;
	p->watch.runs++;
	ph_eval c = {0};
	op_value *v = ph_eval_of(p->f, &c);
	if (c.error) return op_free(v), (sc_out){.kind = SC_FAILED, .error = c.error};
	if (c.stopped) return op_free(v), (sc_out){.kind = SC_VALUE};
	if (c.waited) return op_free(v), (sc_out){.kind = SC_PENDING};
	if (p->wait != NULL) {
		op_free(v);
		if (nwaits == capwaits) {
			capwaits = capwaits ? capwaits * 2 : 8;
			waits = realloc(waits, capwaits * sizeof *waits);
			if (waits == NULL) abort();
		}
		sc_promise *promise = sc_promise_new(world_scheduler);
		waits[nwaits++] = (wait_p){world_copy(p->wait), promise};
		return (sc_out){.kind = SC_AWAIT, .promise = promise};
	}
	return (sc_out){.kind = SC_VALUE, .value = v};
}

static char *effect_act(void *value, void *previous, void *data) {
	(void)value, (void)previous;
	effect_p *p = data;
	ph_eval c = {0};
	op_value *v = ph_eval_of(p->act, &c);
	op_free(v);
	return c.error;
}

static op_value *actor_of(const op_value *change) {
	const op_value *a = change != NULL && change->type == OP_MAP ? op_get(change, "actor") : NULL;
	return a != NULL ? op_ref((op_value *)a) : op_null();
}

static op_value *reads_json(const crn_run *run) {
	op_value *rs = op_list();
	for (size_t i = 0; i < run->reads->n; i++) {
		const crn_saw *r = &run->reads->items[i];
		if (!r->named) {
			op_push(rs, op_null());
			continue;
		}
		op_value *m = op_map();
		op_set(m, "part", r->part != NULL ? op_str(r->part) : op_null());
		op_set(m, "id", r->id != NULL ? op_str(r->id) : op_null());
		if (r->spot) op_set(m, "path", op_null());
		else {
			op_value *path = op_list();
			for (size_t k = 0; k < r->npath; k++) {
				const op_key *key = &r->path[k];
				op_push(path, key->type == OP_NUM_KEY ? op_num((double)key->n) : op_str(key->s));
			}
			op_set(m, "path", path);
		}
		if (r->keys) op_set(m, "keys", op_bool(1));
		op_set(m, "actor", actor_of(r->change));
		op_push(rs, m);
	}
	return rs;
}

static op_value *writes_json(const crn_run *run) {
	op_value *ws = op_list();
	for (size_t i = 0; i < run->writes->n; i++) {
		const crn_wrote *w = &run->writes->items[i];
		op_value *m = op_map();
		op_set(m, "part", w->part != NULL ? op_str(w->part) : op_null());
		op_set(m, "id", w->id != NULL ? op_str(w->id) : op_null());
		op_set(m, "actor", actor_of(w->change));
		op_push(ws, m);
	}
	return ws;
}

static op_value *act_json(const crn_run *run) {
	op_value *a = op_map();
	op_set(a, "end", op_str(run->act == CRN_ACT_DONE ? "done" : "failed"));
	if (run->act == CRN_ACT_FAILED) op_set(a, "error", op_str(run->act_error));
	return a;
}

static op_value *run_json(const crn_run *run) {
	if (run == NULL) return op_null();
	op_value *o = op_map();
	op_set(o, "n", op_num((double)run->n));
	op_set(o, "frame", world_show(run->frame));
	op_set(o, "end", op_str(run->end));
	if (run->error != NULL) op_set(o, "error", op_str(run->error));
	if (run->act != CRN_ACT_NONE) op_set(o, "act", act_json(run));
	op_set(o, "timed", op_bool(run->has_started && run->started <= run->ended));
	op_set(o, "reads", reads_json(run));
	op_set(o, "writes", writes_json(run));
	return o;
}

static op_value *field_json(const crn_run *run, crn_field field) {
	if (run == NULL) return op_null();
	switch (field) {
	case CRN_N: return op_num((double)run->n);
	case CRN_FRAME: return world_show(run->frame);
	case CRN_END: return op_str(run->end);
	case CRN_ERROR: return run->error != NULL ? op_str(run->error) : op_null();
	case CRN_ACT: return run->act != CRN_ACT_NONE ? act_json(run) : op_null();
	case CRN_READS: return reads_json(run);
	case CRN_WRITES: return writes_json(run);
	default: return op_null();
	}
}

static int field_of(const char *name, crn_field *out) {
	static const char *const names[] = {"n", "frame", "started", "ended", "end", "error", "act", "reads", "writes"};
	for (int i = 0; i < 9; i++) {
		if (strcmp(names[i], name) == 0) return *out = (crn_field)i, 1;
	}
	return 0;
}

static op_value *run_form(const op_value *e, ph_eval *c, bool *handled) {
	const op_value *x = op_get(e, "run");
	if (x == NULL) return NULL;
	*handled = true;
	if (runs == NULL) return ph_throw(c, world_copy("no runs")), NULL;
	const char *id = x->count > 0 ? world_text(x->items[0]) : NULL;
	if (id == NULL) return ph_throw(c, world_copy("run: id not a string")), NULL;
	crn_field field = CRN_ALL;
	if (x->count > 1) {
		const char *name = world_text(x->items[1]);
		if (name == NULL || !field_of(name, &field)) {
			return ph_throw(c, world_copy("run: not a field")), NULL;
		}
	}
	const crn_run *run;
	const char *what = "", *why = "";
	int a = crn_read(runs, ask_guard, NULL, tb_string(id), field, &run, &what, &why);
	pl_status(world_places);
	if (a == CRN_STOP || a == GD_FAILED) return c->stopped = true, NULL;
	if (a == GD_PENDING) return c->waited = true, op_null();
	if (a == GD_REFUSED) return ph_throw(c, world_format("%s refused: %s", what, why)), NULL;
	return field == CRN_ALL ? run_json(run) : field_json(run, field);
}

static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (strcmp(op, "runs") == 0) {
		if (runs == NULL) {
			runs = crn_new(&(crn_setup){world_places, world_table, world_scheduler});
			policy = pr_call(may, NULL);
			guard = gd_new(&(gd_setup){world_places, world_table, policy, NULL, 0});
			ph_add_form(run_form);
		}
		return op_map();
	}
	if (strcmp(op, "effect") == 0) {
		effect_p *p = world_alloc(sizeof *p);
		p->f = op_get(r, "f"), p->act = op_get(r, "act");
		p->wait = world_text(op_get(r, "wait"));
		if (neffects == capeffects) {
			capeffects = capeffects ? capeffects * 2 : 8;
			effects = realloc(effects, capeffects * sizeof *effects);
			if (effects == NULL) abort();
		}
		effects[neffects++] = p;
		char *bad = world_make(&p->watch, world_text(op_get(r, "name")), world_text(op_get(r, "scope")),
			(sc_def){.f = effect_f, .effect = effect_act, .equal = world_equal, .data = p}, true);
		if (bad) return world_error_take(bad);
		return op_map();
	}
	if (strcmp(op, "settle") == 0) {
		const char *name = world_text(op_get(r, "promise"));
		for (size_t i = 0; name != NULL && i < nwaits; i++) {
			if (strcmp(waits[i].name, name) != 0) continue;
			sc_resolve(waits[i].p, op_null());
			free(sc_escaped(world_scheduler));
			sc_promise_free(waits[i].p);
			free(waits[i].name);
			waits[i] = waits[--nwaits];
			return op_map();
		}
		return world_error_take(world_format("no promise %s", name != NULL ? name : "null"));
	}
	if (strcmp(op, "giveRun") == 0) {
		if (runs == NULL) return world_error("no runs");
		sc_scope *c = world_scope(world_text(op_get(r, "name")));
		if (c == NULL) return world_error("no such scope");
		crn_give(runs, c, world_key(op_get(r, "id")));
		return op_map();
	}
	if (strcmp(op, "runOf") == 0) {
		if (runs == NULL) return world_error("no runs");
		const crn_run *run;
		const char *what = "", *why = "";
		int a = crn_read(runs, ask_guard, NULL, world_key(op_get(r, "id")), CRN_ALL, &run, &what, &why);
		pl_status(world_places);
		if (a == GD_REFUSED) return world_error("refused");
		if (a == GD_PENDING) return world_error("pending");
		op_value *o = op_map();
		op_set(o, "run", run_json(run));
		return o;
	}
	if (strcmp(op, "dropRun") == 0) {
		if (runs != NULL) crn_drop(runs, world_key(op_get(r, "id")));
		return op_map();
	}
	if (strcmp(op, "deny") == 0) {
		if (ndenied == capdenied) {
			capdenied = capdenied ? capdenied * 2 : 8;
			denied = realloc(denied, capdenied * sizeof *denied);
			if (denied == NULL) abort();
		}
		denied[ndenied++] = world_copy(world_text(op_get(r, "id")));
		return op_map();
	}
	return sh_answer(r);
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	if (guard != NULL) gd_free(guard);
	crn_stop(runs);
	for (size_t i = 0; i < nwaits; i++) sc_promise_free(waits[i].p), free(waits[i].name);
	free(waits);
	waits = NULL;
	nwaits = capwaits = 0;
	sh_finish();
	for (size_t i = 0; i < neffects; i++) free(effects[i]);
	free(effects);
	effects = NULL;
	neffects = capeffects = 0;
	crn_free(runs);
	runs = NULL;
	if (policy != NULL) pr_policy_free(policy);
	guard = NULL;
	policy = NULL;
	for (size_t i = 0; i < ndenied; i++) free(denied[i]);
	free(denied);
	denied = NULL;
	ndenied = capdenied = 0;
}
