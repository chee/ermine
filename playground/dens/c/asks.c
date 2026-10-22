// asks (asks.h), in C.
#include "asks.h"

static const char *const ops[2] = {"start", "stop"};

// an address: a string, or a list
static int is_address(const op_value *v) { return dn_is_str(v) || (v != NULL && v->type == OP_LIST); }

// the fields of v named, set on a (shared)
static void copy_fields(op_value *a, const op_value *v, const char *const *names, size_t n) {
	for (size_t i = 0; i < n; i++) {
		const op_value *x = dn_get(v, names[i]);
		if (x != NULL) op_set(a, names[i], op_ref((op_value *)x));
	}
}

// the ask the stored value v says, for the method op (a map: op, who?, and the fields of that op);
// NULL: not one. new
static op_value *ask_of(const char *op, const op_value *v) {
	if (!dn_is_map(v)) return NULL;
	op_value *a;
	if (strcmp(op, "start") == 0) {
		const op_value *program = dn_get(v, "program");
		if (!is_address(dn_get(v, "runner")) || !is_address(dn_get(v, "at")) || !dn_is_map(program) ||
			dn_str_at(program, "id") == NULL)
			return NULL;
		a = op_map();
		copy_fields(a, v, (const char *const[]){"runner", "program", "at", "args", "cwd"}, 5);
	} else {
		if (dn_str_at(v, "process") == NULL) return NULL;
		a = op_map();
		copy_fields(a, v, (const char *const[]){"process", "reason"}, 2);
	}
	op_set(a, "op", op_str(op));
	copy_fields(a, v, (const char *const[]){"who"}, 1);
	return a;
}

// the ask without its op: new
static op_value *body_of(const op_value *ask) {
	op_value *body = op_map();
	for (size_t i = 0; i < ask->count; i++) {
		if (strcmp(ask->keys[i], "op") != 0) op_set_name(body, ask->keys[i], op_ref(ask->items[i]));
	}
	return body;
}

char *dn_ask_write_at(const dn_world *w, const char *den, const op_value *ask, const ch_site *site) {
	const char *op = dn_str_at(ask, "op");
	if (op == NULL || (strcmp(op, "start") != 0 && strcmp(op, "stop") != 0)) return NULL;
	op_value *body = body_of(ask);
	char name[65];
	if (!dn_hash_hex(body, name)) {
		op_free(body);
		return NULL;
	}
	char *on = dn_joined(den, DN_ON);
	char *method = dn_joined(on, op);
	char *id = dn_joined(method, name);
	// a write with no den: the world's table and places, the caller's site
	dn stub = {.s = {.table = w->table, .places = w->places}, .site = site};
	int failed = 0;
	if (tb_get(w->table, tb_string("value"), tb_string(id)) == NULL) {
		if (dn_write_in(&stub, w->scope, (writing){.what = W_ADD, .part = "value", .id = id, .value = body}) == -1) failed = 1;
	}
	// the method reached from the den's node: its on folder, the folder's method, the method's ask
	const char *steps[3] = {DN_ON, op, name};
	const char *parents[3] = {den, on, method};
	const char *kids[3] = {on, method, id};
	for (size_t i = 0; i < 3; i++) {
		op_value *v = op_str(kids[i]);
		if (dn_write_in(&stub, w->scope, (writing){.what = W_UPSERT, .part = "children", .id = parents[i],
			.path = &steps[i], .n = 1, .value = v}) == -1)
			failed = 1;
		op_free(v);
	}
	free(on);
	op_free(body);
	free(method);
	// no scope open: the header could not be made, nothing was written
	if (failed) {
		free(id);
		return NULL;
	}
	return id;
}

const op_value *dn_ask_answer(const dn_world *w, const char *n) {
	char *at = dn_joined(n, DN_ANSWER);
	const op_value *v = pl_read(w->places, tb_string("value"), tb_string(at), NULL, 0);
	free(at);
	return v;
}

// the den's side --------------------------------------------------------------------------------------

static int answered(const dn *d, const char *id) {
	for (size_t i = 0; i < d->nanswered; i++) {
		if (strcmp(d->answered[i], id) == 0) return 1;
	}
	return 0;
}

// the asks with no answer: a list of { op, id }, the reads told
static sc_out waiting_f(void *previous, void *data) {
	(void)previous;
	dn *d = data;
	op_value *out = op_list();
	for (size_t k = 0; k < 2; k++) {
		const op_value *kids = pl_read(d->s.places, tb_string("children"), tb_string(d->on_ids[k + 1]), NULL, 0);
		if (!dn_is_map(kids)) continue;
		for (size_t i = 0; i < kids->count; i++) {
			const op_value *id = kids->items[i];
			if (!dn_is_str(id) || answered(d, id->str)) continue;
			// only the method's own <method>/<name> is an ask, and once its value is there
			char *own = dn_joined(d->on_ids[k + 1], kids->keys[i]);
			int mine = strcmp(own, id->str) == 0;
			free(own);
			if (!mine || pl_read(d->s.places, tb_string("value"), tb_string(id->str), NULL, 0) == NULL) continue;
			char *at = dn_joined(id->str, DN_ANSWER);
			const op_value *got = pl_read(d->s.places, tb_string("value"), tb_string(at), NULL, 0);
			free(at);
			if (got != NULL) continue;
			op_value *m = op_map();
			op_set(m, "op", op_str(ops[k]));
			op_set(m, "id", op_str(id->str));
			op_push(out, m);
		}
	}
	if (pl_status(d->s.places) == SC_STOP) {
		op_free(out);
		return (sc_out){.kind = SC_VALUE};
	}
	return (sc_out){.kind = SC_VALUE, .value = out};
}

// { error: why }, new
static op_value *error_of(const char *why) {
	op_value *m = op_map();
	op_set(m, "error", op_str(why));
	return m;
}

// the ask at id (under the method op) answered, once: its answer at <id>/answer, and in the ask's
// children
static void reply(dn *d, const char *op, const char *id) {
	PUSH(d->answered, d->nanswered, d->capanswered, dn_xdup(id));
	const nd_entry *e = tb_get(d->s.table, tb_string("value"), tb_string(id));
	op_value *a = ask_of(op, e != NULL ? e->value : NULL);
	op_value *out = a == NULL ? NULL : dn_ask_inner(d, dn_get(a, "who"), a, NULL);
	if (out == NULL) out = error_of("not-an-ask");
	op_free(a);
	// what start threw there (a places code) is { error }, as a refusal is not
	const char *no = dn_str_at(out, "refused");
	if (no != NULL && (strcmp(no, "not-a-name") == 0 || strcmp(no, "nothing-there") == 0 ||
		strcmp(no, "already-there") == 0)) {
		op_value *thrown = error_of(no);
		op_free(out);
		out = thrown;
	}
	char *at = dn_joined(id, DN_ANSWER);
	sc_scope *on = d->on_scopes[0];
	if (tb_get(d->s.table, tb_string("value"), tb_string(at)) == NULL) {
		dn_write_in(d, on, (writing){.what = W_ADD, .part = "value", .id = at, .value = out});
	}
	const char *path[1] = {DN_ANSWER};
	op_value *v = op_str(at);
	dn_write_in(d, on, (writing){.what = W_UPSERT, .part = "children", .id = id, .path = path, .n = 1,
		.value = v});
	op_free(v);
	op_free(out);
	// a den with no install: the ask and its answer go with the session
	if (!d->stored) dn_forget_at(d, on, id), dn_forget_at(d, on, at);
	free(at);
}

static char *answer_act(void *value, void *previous, void *data) {
	(void)previous;
	dn *d = data;
	const op_value *asks = value;
	if (asks == NULL) return NULL;
	for (size_t i = 0; i < asks->count; i++) {
		reply(d, dn_str_at(asks->items[i], "op"), dn_str_at(asks->items[i], "id"));
	}
	return NULL;
}

static void make_answering(void *data) {
	dn *d = data;
	sc_create_effect(d->s.scheduler, (sc_def){.f = waiting_f, .effect = answer_act, .data = d}, NULL, 0);
}

void dn_answering(dn *d) { sc_run_with_scope(d->on_scopes[0], make_answering, d); }
