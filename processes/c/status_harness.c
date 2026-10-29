// status (status.h) on the places harness (places_harness.c, built as a library: PH_LIB): its
// requests and programs, and status's (typescript/status_harness.ts says them). a harness built on
// this one (SH_LIB, runs') takes sh_answer for status's and places', and has its own loop
#include <string.h>

#include "status.h"
#include "../../places/c/places_harness.h"
#include "../../places/c/world_harness.h"

static cst *statuses;
static bool formed;

// a status as the requests tell it: "pending", { error: message }, or null
static op_value *status_json(const op_value *status) {
	if (cst_is_pending(status)) return op_str("pending");
	const char *message = cst_error(status);
	if (message == NULL) return op_null();
	op_value *o = op_map();
	op_set(o, "error", op_str(message));
	return o;
}

// {"status":id}: statusOf, tracked
static op_value *status_form(const op_value *e, ph_eval *c, bool *handled) {
	const op_value *x = op_get(e, "status");
	if (x == NULL) return NULL;
	*handled = true;
	const char *id = world_text(x);
	if (id == NULL) return ph_throw(c, world_copy("id: not a string")), NULL;
	op_value *out = status_json(cst_status(world_places, tb_string(id)));
	sc_track_status st = pl_status(world_places);
	if (st == SC_STOP) c->stopped = true;
	if (st == SC_OK) return out;
	op_free(out);
	return NULL;
}

op_value *sh_answer(const op_value *r) {
	if (!formed) ph_add_form(status_form), formed = true;
	const char *op = world_text(op_get(r, "op"));
	if (op != NULL && strcmp(op, "status") == 0) {
		if (statuses == NULL) statuses = cst_new(&(cst_setup){world_places, world_table, world_scheduler});
		return op_map();
	}
	if (op != NULL && strcmp(op, "give") == 0) {
		sc_scope *c = world_scope(world_text(op_get(r, "name")));
		const op_value *id = op_get(r, "id");
		if (statuses == NULL) return world_error("no status");
		if (c == NULL) return world_error("no such scope");
		if (!world_is(id, OP_STR)) return world_error("id: not a string");
		cst_give(statuses, c, world_key(id));
		return op_map();
	}
	if (op != NULL && strcmp(op, "statusOf") == 0) {
		const op_value *id = op_get(r, "id");
		if (!world_is(id, OP_STR)) return world_error("id: not a string");
		const op_value *v = cst_status(world_places, world_key(id));
		pl_status(world_places);
		op_value *o = op_map();
		op_set(o, "status", status_json(v));
		return o;
	}
	return ph_answer(r);
}

// after the last line, before the builder's own
void sh_finish(void) {
	cst_stop(statuses);
	ph_finish();
	cst_free(statuses);
	statuses = NULL;
	formed = false;
}

#ifndef SH_LIB
void hh_answer(const op_value *request, FILE *out) { world_line(request, out, sh_answer); }
void hh_finish(void) { sh_finish(); }
#endif
