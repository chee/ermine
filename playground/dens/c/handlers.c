// handlers (handlers.h), in C.
#include "handlers.h"

#include "asks.h"
#include "here.h"
#include "policy.h"
#include "start.h"

// an address as steps (copied): a string split as path.ts' parse does (a leading "/" is "/", empty
// pieces skipped), a list as it is (a step that is no string: ""); anything else: none
typedef struct {
	char **v;
	size_t n, cap;
} steps;

static steps steps_of(const op_value *a) {
	steps s = {0};
	if (dn_is_str(a)) {
		const char *p = a->str;
		if (*p == '/') PUSH(s.v, s.n, s.cap, dn_xdup("/"));
		while (*p) {
			const char *end = strchr(p, '/');
			size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
			if (len > 0) {
				char *piece = dn_xalloc(len + 1);
				memcpy(piece, p, len);
				PUSH(s.v, s.n, s.cap, piece);
			}
			p += len;
			if (*p == '/') p++;
		}
	} else if (a != NULL && a->type == OP_LIST) {
		for (size_t i = 0; i < a->count; i++) {
			PUSH(s.v, s.n, s.cap, dn_xdup(dn_is_str(a->items[i]) ? a->items[i]->str : ""));
		}
	}
	return s;
}

static void steps_free(steps *s) {
	for (size_t i = 0; i < s->n; i++) free(s->v[i]);
	free(s->v);
	*s = (steps){0};
}

// the den's children { on }, the folder on { start, stop }, each a method node: on an install's den
// the names stored and each method's value (hf_value("")) this session's (dn_live_until), else all
// of it the session's; then the asks stored under them answered (asks.c)
void dn_methods(dn *d) {
	dn_process *self = d->self;
	d->on_ids[0] = dn_joined(self->id, DN_ON);
	d->on_ids[1] = dn_joined(d->on_ids[0], "start");
	d->on_ids[2] = dn_joined(d->on_ids[0], "stop");
	const char *on[1] = {DN_ON};
	op_value *folder_id = op_str(d->on_ids[0]);
	dn_write_in(d, NULL, (writing){.what = W_UPSERT, .part = "children", .id = self->id, .path = on,
		.n = 1, .value = folder_id});
	op_free(folder_id);
	d->on_scopes[0] = dn_scope_of(d, d->on_info[0], d->on_values[0], "den", DN_ON, d->on_ids[0],
		self->scope, !d->stored);
	static const char *const names[2] = {DN_ON "/start", DN_ON "/stop"};
	for (size_t k = 1; k < 3; k++) {
		d->on_scopes[k] = dn_scope_of(d, d->on_info[k], d->on_values[k], "den", names[k - 1], d->on_ids[k],
			d->on_scopes[0], !d->stored);
		op_value *fn = hf_value("");
		dn_write_in(d, d->on_scopes[k], (writing){.what = W_SUB, .part = "value", .id = d->on_ids[k],
			.value = fn});
		op_free(fn);
		if (d->stored) dn_live_until(d, d->on_scopes[k], d->on_ids[k]);
		const char *name[1] = {k == 1 ? "start" : "stop"};
		op_value *id = op_str(d->on_ids[k]);
		dn_write_in(d, d->on_scopes[0], (writing){.what = W_UPSERT, .part = "children",
			.id = d->on_ids[0], .path = name, .n = 1, .value = id});
		op_free(id);
	}
	dn_answering(d);
}

// asks and methods ---------------------------------------------------------------------------------

static op_value *with_refused(const char *refused) {
	op_value *m = op_map();
	op_set(m, "refused", op_str(refused));
	return m;
}



// an address of strings: a string, or a list of strings
static int is_path(const op_value *a) {
	if (dn_is_str(a)) return 1;
	if (a == NULL || a->type != OP_LIST) return 0;
	for (size_t i = 0; i < a->count; i++) {
		if (!dn_is_str(a->items[i])) return 0;
	}
	return 1;
}

// steps as given: none, no address, or an address of strings (a list with a step that is no
// string: not)
static int steps_fit(const op_value *a) { return a == NULL || a->type != OP_LIST || is_path(a); }

// a start as a map gives it: runner, program (an address, or { id, hash?, type?, api?, code? }), at,
// args?, cwd?, and pin? (local only). runner and at no address: none; program neither: { id: "" };
// a step that is no string, args given that are no list of strings, a cwd given that is no address:
// refused not-a-name
static op_value *start_from(dn *d, const op_value *who, int remote, const op_value *b) {
	const op_value *given_args = dn_get(b, "args"), *given_cwd = dn_get(b, "cwd");
	if (!steps_fit(dn_get(b, "runner")) || !steps_fit(dn_get(b, "at")) || !steps_fit(dn_get(b, "program")) ||
		(given_cwd != NULL && !is_path(given_cwd)) ||
		(given_args != NULL && (given_args->type != OP_LIST || !is_path(given_args))))
		return with_refused(pl_code_name(PL_NOT_A_NAME));
	steps runner = steps_of(dn_get(b, "runner")), at = steps_of(dn_get(b, "at"));
	steps cwd = steps_of(dn_get(b, "cwd")), args = steps_of(dn_get(b, "args")), program = {0};
	dn_program prog = {0};
	const op_value *pv = dn_get(b, "program");
	if (pv != NULL && (pv->type == OP_STR || pv->type == OP_LIST)) {
		program = steps_of(pv);
		prog.at = (const char *const *)program.v, prog.nat = program.n, prog.has_at = 1;
	} else {
		prog.id = dn_str_at(pv, "id");
		prog.hash = dn_str_at(pv, "hash");
		// a hash that is no string: none's
		if (prog.hash == NULL && dn_get(pv, "hash") != NULL) prog.hash = "";
		prog.type = dn_str_at(pv, "type");
		prog.api = dn_str_at(pv, "api");
		prog.code = dn_get(pv, "code");
	}
	dn_options o = {.args = (const char *const *)args.v, .nargs = args.n,
		.has_args = dn_get(b, "args") != NULL, .cwd = (const char *const *)cwd.v, .ncwd = cwd.n,
		.has_cwd = dn_get(b, "cwd") != NULL, .pin = remote ? NULL : dn_get(b, "pin")};
	dn_refusal r;
	dn_process *p = dn_begin(d, who, remote, (const char *const *)runner.v, runner.n, &prog,
		(const char *const *)at.v, at.n, &o, &r);
	op_value *out = p != NULL ? dn_id_at(p) : dn_refusal_value(&r);
	steps_free(&runner), steps_free(&at), steps_free(&cwd), steps_free(&args), steps_free(&program);
	return out;
}

static op_value *ask_now(dn *d, const op_value *who, const op_value *ask) {
	dn_forget(d);
	const char *op = dn_str_at(ask, "op");
	if (op == NULL || (strcmp(op, "start") != 0 && strcmp(op, "stop") != 0)) return NULL;
	if (d->closed) return with_refused("stopped");
	if (op[2] == 'a') return start_from(d, who, 1, ask);
	const char *id = dn_str_at(ask, "process");
	dn_process *p = dn_find(d, id);
	if (p == NULL) {
		op_value *m = with_refused("not-there");
		const op_value *given = dn_get(ask, "process");
		op_set(m, "process", given != NULL ? op_ref((op_value *)given) : op_null());
		return m;
	}
	dn_refusal r;
	if (dn_stop_as(d, who, 1, p, dn_get(ask, "reason"), &r)) return dn_refusal_value(&r);
	return op_map();
}

op_value *dn_ask_at(dn *d, const op_value *who, const op_value *ask, const ch_site *site) {
	const ch_site *was = dn_enter(d, site);
	op_value *out = ask_now(d, who, ask);
	dn_leave(d, was);
	return out;
}

op_value *dn_on_at(dn *d, const char *op, const op_value *body, const ch_site *site) {
	dn_forget(d);
	if (op == NULL || (strcmp(op, "start") != 0 && strcmp(op, "stop") != 0)) return NULL;
	const ch_site *was = dn_enter(d, site);
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	op_value *out;
	if (op[2] == 'a') out = start_from(d, who, 0, body);
	else {
		const char *id = dn_str_at(body, "process");
		// the den's node, or its session's process
		int self = id != NULL && (strcmp(id, d->self->id) == 0 ||
			(d->self->life != NULL && strcmp(id, pr_id(d->self->life)) == 0));
		const op_value *why = dn_get(body, "reason");
		dn_refusal r;
		int no = self ? dn_stop_self(d, who, 0, why, &r) : dn_stop_as(d, who, 0, dn_find(d, id), why, &r);
		out = no ? dn_refusal_value(&r) : op_map();
	}
	op_free(who);
	dn_leave(d, was);
	return out;
}

op_value *dn_refusal_value(const dn_refusal *r) {
	op_value *m = with_refused(r->refused);
	const char *k = r->refused;
	if (strcmp(k, "not-a-runner") == 0) op_set(m, "runner", dn_names_value(r->runner, r->nrunner));
	else if (strcmp(k, "not-there") == 0) {
		if (r->process != NULL) op_set(m, "process", op_str(r->process));
		else if (r->program_has_at) op_set(m, "program", dn_names_value(r->program_at, r->nprogram_at));
		else op_set(m, "program", op_str(r->program != NULL ? r->program : ""));
	} else if (strcmp(k, "wrong-form") == 0) {
		op_value *program = op_map(), *runner = op_map();
		if (r->type != NULL) op_set(program, "type", op_str(r->type));
		if (r->api != NULL) op_set(program, "api", op_str(r->api));
		if (r->takes != NULL) op_set(runner, "takes", op_str(r->takes));
		if (r->runner_api != NULL) op_set(runner, "api", op_str(r->runner_api));
		op_set(m, "program", program);
		op_set(m, "runner", runner);
	} else if (strcmp(k, "no-permission") == 0) {
		op_set(m, "op", op_str(r->op != NULL ? r->op : ""));
		op_value *a = op_map();
		if (r->answer.verdict == PR_NO) {
			op_set(a, "answer", op_str("no"));
			op_set(a, "reason", op_str(r->answer.reason != NULL ? r->answer.reason : ""));
		} else op_set(a, "answer", op_str("pending"));
		op_set(m, "answer", a);
	} else if (strcmp(k, "taken") == 0) op_set(m, "at", dn_names_value(r->at, r->nat));
	return m;
}
