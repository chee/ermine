// The C pullynode (pullynode.h) on the line protocol of typescript/pullynode_harness.ts, which
// documents it and the program forms (conformance/c/harness.h has the loop). Built on places' harness
// (filesystem/places/c/places_harness.h, compiled with PH_LIB): its world, its programs, its
// requests, and this one's besides.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../filesystem/places/c/places_harness.h"
#include "pullynode.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// the providers, once they are asked for
static pul *pn;
static bool formed;

// a hand provider: what it said since last asked, the write it was given (kept after its stop too),
// and what its request said (the line's, kept)
typedef struct {
	char *name;
	op_value *said;
	pul_writer *write;
	pul_node *node;
	const op_value *first;
	bool has_once, throws;
	const op_value *once;
} hand;
static hand **hands;
static size_t nhands, caphands;

// a check begun: its answer, kept as `as`; NULL till it is ready
typedef struct {
	char *as;
	op_value *answer;
} check;
static check **checks;
static size_t nchecks, capchecks;

static hand *hand_of(const char *name) {
	for (size_t i = nhands; i-- > 0;) {
		if (name != NULL && strcmp(hands[i]->name, name) == 0) return hands[i];
	}
	return NULL;
}

static void stopped(void *ctx) { op_push(((hand *)ctx)->said, op_str("stop")); }

static pul_off start(pul_writer *write, sc_run *woke, void *data) {
	hand *h = data;
	if (woke == NULL) op_push(h->said, op_str("start"));
	else {
		// the compute's name: the user pointer world_name gave it
		const char *name = sc_scope_user(sc_run_computer(woke));
		op_value *m = op_map();
		op_set(m, "start", name != NULL ? op_str(name) : op_null());
		op_push(h->said, m);
	}
	h->write = write;
	if (h->first != NULL) {
		op_patch p = {.has_value = 1, .value = h->first};
		pul_write(write, &p, 1);
	}
	return (pul_off){stopped, h};
}

static char *once(void *data, const op_value **value) {
	hand *h = data;
	if (h->throws) return world_copy(world_text(op_get(h->once, "throw")));
	*value = op_get(h->once, "value");
	return NULL;
}

static op_value *keys_form(const op_value *e, ph_eval *c, bool *handled) {
	const op_value *x = op_get(e, "keys");
	if (x == NULL) return NULL;
	*handled = true;
	size_t n = 0;
	op_key *path = world_path(x->count > 2 ? x->items[2] : NULL, &n);
	pl_namelist names = {0};
	pl_keys(world_places, tb_string(world_part(x->items[0])), world_key(x->items[1]), path, n, 0, &names);
	free(path);
	op_value *list = op_list();
	for (size_t i = 0; i < names.n; i++) op_push(list, op_str(names.items[i]));
	pl_namelist_free(&names);
	if (pl_status(world_places) == SC_STOP) {
		c->stopped = true;
		op_free(list);
		return NULL;
	}
	return list;
}

// a provide request (the line's, or a program's: kept either way): {} or an error
static op_value *provide(const op_value *r) {
	if (pn == NULL) return world_error("no providers");
	hand *h = world_alloc(sizeof *h);
	h->name = world_copy(world_text(op_get(r, "name")));
	h->said = op_list();
	h->first = op_get(r, "first");
	h->once = op_get(r, "once");
	h->has_once = h->once != NULL;
	h->throws = h->has_once && op_get(h->once, "throw") != NULL;
	size_t n;
	const sc_pair *info = world_info(op_get(r, "info"), &n);
	pul_provider p = {.start = start, .once = h->has_once ? once : NULL, .data = h};
	h->node = pul_provide(pn, world_text(op_get(r, "id")), &p, info, n);
	if (h->node == NULL) {
		op_free(h->said);
		free(h->name);
		free(h);
		return world_error("provided");
	}
	PUSH(hands, nhands, caphands, h);
	return op_map();
}

// program e: {"provide": request}, made in the run; null
static op_value *provide_form(const op_value *e, ph_eval *c, bool *handled) {
	const op_value *x = op_get(e, "provide");
	if (x == NULL) return NULL;
	*handled = true;
	op_value *a = provide(x);
	const op_value *error = op_get(a, "error");
	if (error != NULL) {
		ph_throw(c, world_copy(world_text(error)));
		op_free(a);
		return NULL;
	}
	op_free(a);
	return op_null();
}

static void checked(void *ctx, const op_value *value, const char *error) {
	check *k = ctx;
	op_value *a = op_map();
	if (error != NULL) op_set(a, "error", op_str(error));
	else op_set(a, "value", value != NULL ? world_snap(value) : op_null());
	if (k->answer != NULL) op_free(k->answer);
	k->answer = a;
}

static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (!formed) formed = true, ph_add_form(keys_form), ph_add_form(provide_form);
	if (strcmp(op, "providers") == 0) {
		if (pn == NULL) pn = pul_new(&(pul_setup){world_places, world_table, world_scheduler});
		return op_map();
	}
	if (strcmp(op, "provide") == 0) return provide(r);
	if (strcmp(op, "unprovide") == 0) {
		hand *h = hand_of(world_text(op_get(r, "name")));
		if (h == NULL) return world_error("no provider");
		pul_unprovide(h->node);
		return op_map();
	}
	if (strcmp(op, "put") == 0) {
		hand *h = hand_of(world_text(op_get(r, "name")));
		if (h == NULL) return world_error("no provider");
		if (h->write == NULL) return world_error("never started");
		const op_value *v = op_get(r, "value");
		op_patch p = {.has_value = 1, .value = v != NULL ? v : (v = world_snap(NULL))};
		int code = pul_write(h->write, &p, 1);
		if (code != 0) return world_error(op_code_name(code));
		return op_map();
	}
	if (strcmp(op, "said") == 0) {
		hand *h = hand_of(world_text(op_get(r, "name")));
		if (h == NULL) return world_error("no provider");
		op_value *o = op_map();
		op_set(o, "said", h->said);
		h->said = op_list();
		return o;
	}
	if (strcmp(op, "check") == 0) {
		if (pn == NULL) return world_error("no providers");
		const char *as = world_text(op_get(r, "as"));
		check *k = NULL;
		for (size_t i = 0; i < nchecks; i++) {
			if (strcmp(checks[i]->as, as) == 0) k = checks[i];
		}
		if (k == NULL) {
			k = world_alloc(sizeof *k);
			k->as = world_copy(as);
			PUSH(checks, nchecks, capchecks, k);
		}
		if (k->answer != NULL) op_free(k->answer);
		k->answer = NULL;
		pul_check(pn, world_text(op_get(r, "id")), checked, k);
		return op_map();
	}
	if (strcmp(op, "checked") == 0) {
		const char *as = world_text(op_get(r, "as"));
		for (size_t i = 0; i < nchecks; i++) {
			if (strcmp(checks[i]->as, as) == 0 && checks[i]->answer != NULL) {
				return op_ref(checks[i]->answer);
			}
		}
		return op_map();
	}
	if (strcmp(op, "reading") == 0) {
		op_value *o = op_map();
		op_set(o, "reading", op_bool(pn != NULL && pul_reading(pn, world_text(op_get(r, "id")))));
		return o;
	}
	if (strcmp(op, "actor") == 0) {
		const nd_entry *e = tb_get(world_table, tb_string(world_part(op_get(r, "part"))),
			world_key(op_get(r, "id")));
		op_value *o = op_map();
		op_set(o, "actor", e != NULL && e->change.actor != NULL ? world_snap(e->change.actor) : op_null());
		return o;
	}
	if (strcmp(op, "stopAll") == 0) {
		if (pn != NULL) pul_stop(pn);
		return op_map();
	}
	return ph_answer(r);
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	if (pn != NULL) pul_stop(pn);
	ph_finish();
	pul_free(pn);
	pn = NULL;
	formed = false;
	for (size_t i = 0; i < nhands; i++) {
		op_free(hands[i]->said);
		free(hands[i]->name);
		free(hands[i]);
	}
	free(hands);
	hands = NULL;
	nhands = caphands = 0;
	for (size_t i = 0; i < nchecks; i++) {
		if (checks[i]->answer != NULL) op_free(checks[i]->answer);
		free(checks[i]->as);
		free(checks[i]);
	}
	free(checks);
	checks = NULL;
	nchecks = capchecks = 0;
}
