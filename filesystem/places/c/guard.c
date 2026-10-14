// Guard (guard.h), in C.
#include "guard.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("guard: out of memory\n", stderr);
		abort();
	}
	return p;
}

static const char refused_token;
tb_key gd_refused(void) { return tb_symbol(&refused_token); }
int gd_is_refused(tb_key id) { return id.symbol == &refused_token; }

gd_target gd_target_of(gd_thing thing, const char *part, const op_value *field) {
	return (gd_target){thing, part, field};
}
gd_target gd_slot(gd_thing parent, const char *name, op_value **field) {
	*field = op_list();
	op_push(*field, op_str(name));
	return gd_target_of(parent, "children", *field);
}

struct gd {
	pl *places;
	tb_table *table;
	const pr_policy *may;
	// where the asker stands: a path, copied (from_given: it is placed somewhere)
	int from_given;
	const char **from;
	size_t nfrom;
	// a typed array's element a reader returns, a number made each time
	op_value scratch;
};

gd *gd_new(const gd_setup *setup) {
	gd *g = xalloc(sizeof *g);
	g->places = setup->places;
	g->table = setup->table;
	g->may = setup->may;
	if (setup->from == NULL) return g;
	g->from_given = 1;
	g->nfrom = setup->nfrom;
	g->from = xalloc((setup->nfrom + 1) * sizeof *g->from);
	for (size_t i = 0; i < setup->nfrom; i++) g->from[i] = setup->from[i];
	return g;
}

void gd_free(gd *g) {
	if (g == NULL) return;
	free(g->from);
	free(g);
}

// the policy's reads --------------------------------------------------------------------------

// the steps of a path, an op_value list of strings and whole numbers, as keys; the caller frees
static op_key *steps_of(const op_value *path, size_t *n) {
	*n = path != NULL && path->type == OP_LIST ? path->count : 0;
	op_key *keys = xalloc(*n * sizeof *keys);
	for (size_t i = 0; i < *n; i++) {
		const op_value *step = path->items[i];
		if (step->type == OP_STR) keys[i] = (op_key){.type = OP_STR_KEY, .s = step->str};
		else keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)step->num};
	}
	return keys;
}

// a read made for a run asking: told, so the run tracks it
static const op_value *told_reader(void *ctx, const char *part, tb_key id, const op_value *path,
	const op_value *at) {
	(void)at;
	gd *g = ctx;
	size_t n;
	op_key *keys = steps_of(path, &n);
	const op_value *v = pl_read(g->places, tb_string(part), id, keys, n);
	free(keys);
	return v;
}
// a write's: told no one
static const op_value *quiet_reader(void *ctx, const char *part, tb_key id, const op_value *path,
	const op_value *at) {
	(void)at;
	gd *g = ctx;
	size_t n;
	op_key *keys = steps_of(path, &n);
	const nd_entry *node = tb_get(g->table, tb_string(part), id);
	const op_value *v = node != NULL ? pl_at(node->value, keys, n, &g->scratch) : NULL;
	free(keys);
	return v;
}

// asking ----------------------------------------------------------------------------------------

// one target asked: told (reads) or not (writes). *reason: why a no
static gd_answer asked(gd *g, int told, const char *op, const gd_target *t, const char **reason) {
	// a stand-in is refused, never asked
	if (gd_is_refused(t->thing.id)) return *reason = "refused", GD_REFUSED;
	if (g->may == NULL) return GD_OK;
	pr_target target = {.part = t->part, .field = t->field, .id = t->thing.id};
	target.path = t->thing.path, target.npath = t->thing.npath;
	op_value *who = pl_who(g->places, NULL, 0);
	pr_ask ask = {.who = who, .op = op, .target = target};
	if (g->from_given) ask.from.path = g->from, ask.from.npath = g->nfrom;
	pr_answer a = pr_ask_of(g->may, &ask, told ? told_reader : quiet_reader, g);
	op_free(who);
	// a read the policy told that said the run must end
	if (pl_status(g->places) != SC_OK) return GD_FAILED;
	*reason = a.reason;
	return a.verdict == PR_YES ? GD_OK : a.verdict == PR_NO ? GD_REFUSED : GD_PENDING;
}

static gd_answer demand(gd *g, int told, const char *op, const gd_target *targets, size_t n,
	gd_refusal *why) {
	int waiting = 0;
	for (size_t i = 0; i < n; i++) {
		const char *reason = NULL;
		gd_answer a = asked(g, told, op, &targets[i], &reason);
		if (a == GD_REFUSED) {
			if (why != NULL) *why = (gd_refusal){op, reason};
			return a;
		}
		if (a == GD_FAILED) return a;
		if (a == GD_PENDING) waiting = 1;
	}
	return waiting ? GD_PENDING : GD_OK;
}

gd_answer gd_read(gd *g, const gd_target *targets, size_t n, gd_refusal *why) {
	return demand(g, 1, "read", targets, n, why);
}
gd_answer gd_write(gd *g, const char *op, const gd_target *targets, size_t n, gd_refusal *why) {
	return demand(g, 0, op, targets, n, why);
}

gd_answer gd_members(gd *g, const pl_members *list, const char *const *at, size_t nat,
	pl_members *out) {
	*out = (pl_members){0};
	pl_member *items = xalloc((list->n + 1) * sizeof *items);
	const char **path = xalloc((nat + 2) * sizeof *path);
	for (size_t i = 0; i < nat; i++) path[i] = at[i];
	int waiting = 0;
	for (size_t i = 0; i < list->n; i++) {
		gd_thing thing = {.id = list->items[i].id};
		if (at != NULL) {
			path[nat] = list->items[i].name;
			thing.path = path, thing.npath = nat + 1;
		}
		gd_target t = gd_target_of(thing, NULL, NULL);
		const char *reason;
		gd_answer a = asked(g, 1, "read", &t, &reason);
		if (a == GD_FAILED) return free(items), free(path), a;
		if (a == GD_PENDING) waiting = 1;
		items[i] = a == GD_OK ? list->items[i] : (pl_member){list->items[i].name, gd_refused()};
	}
	free(path);
	if (waiting) return free(items), GD_PENDING;
	*out = (pl_members){list->n, items};
	return GD_OK;
}
