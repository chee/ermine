// The C runs (runs.h) on the line protocol of typescript/runs_harness.ts, which documents it and the
// programs (conformance/c/harness.h has the loop). Built on places' harness (filesystem/places/c/places_harness.h,
// compiled with PH_LIB): its world, its programs, its requests, and this one's besides.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../filesystem/places/c/places_harness.h"
#include "../../../filesystem/places/c/guard.h"
#include "runs.h"

// the runs listener, once it is asked for
static crn *runs;
// the policy: no to reading the ids denied; the guard on it
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

// the guard, asked as crn_read wants
static int ask_guard(void *ctx, tb_key id, const char **op, const char **reason) {
	(void)ctx;
	gd_target t = gd_target_of((gd_thing){.id = id}, NULL, NULL);
	gd_refusal why = {0};
	gd_answer a = gd_read(guard, &t, 1, &why);
	if (a == GD_REFUSED) *op = why.op, *reason = why.reason;
	return a;
}

// the actor of a change as runOf tells it: null for none
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

// a run as runOf tells it (typescript/runs_harness.ts)
static op_value *run_json(const crn_run *run) {
	if (run == NULL) return op_null();
	op_value *o = op_map();
	op_set(o, "n", op_num((double)run->n));
	op_set(o, "end", op_str(run->end));
	if (run->error != NULL) op_set(o, "error", op_str(run->error));
	op_set(o, "timed", op_bool(run->has_started && run->started <= run->ended));
	op_set(o, "reads", reads_json(run));
	op_set(o, "writes", writes_json(run));
	return o;
}

// one field of a record as runOf tells it (started and ended: null, runOf tells only whether timed)
static op_value *field_json(const crn_run *run, crn_field field) {
	if (run == NULL) return op_null();
	switch (field) {
	case CRN_N: return op_num((double)run->n);
	case CRN_END: return op_str(run->end);
	case CRN_ERROR: return run->error != NULL ? op_str(run->error) : op_null();
	case CRN_READS: return reads_json(run);
	case CRN_WRITES: return writes_json(run);
	default: return op_null();
	}
}

static int field_of(const char *name, crn_field *out) {
	static const char *const names[] = {"n", "started", "ended", "end", "error", "reads", "writes"};
	for (int i = 0; i < 7; i++) {
		if (strcmp(names[i], name) == 0) return *out = (crn_field)i, 1;
	}
	return 0;
}

// program e, besides places' harness's: {"run": [id, field?]}
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
	return ph_answer(r);
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	if (guard != NULL) gd_free(guard);
	crn_stop(runs);
	ph_finish();
	crn_free(runs);
	runs = NULL;
	if (policy != NULL) pr_free(policy);
	guard = NULL;
	policy = NULL;
	for (size_t i = 0; i < ndenied; i++) free(denied[i]);
	free(denied);
	denied = NULL;
	ndenied = capdenied = 0;
}
