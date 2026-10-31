// The guard asks the protect policy before reads and writes; see guard.h.
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
static tb_key gd_refused(void) { return tb_symbol(&refused_token); }
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
	int from_given;
	const char **from;
	size_t nfrom;
	int (*caller)(void *ctx, const char *const **from, size_t *nfrom);
	void *caller_ctx;
	op_value scratch;
};

gd *gd_new(const gd_setup *setup) {
	gd *g = xalloc(sizeof *g);
	g->places = setup->places;
	g->table = setup->table;
	g->may = setup->may;
	g->caller = setup->caller;
	g->caller_ctx = setup->caller_ctx;
	if (setup->from == NULL) return g;
	g->from_given = 1;
	g->nfrom = setup->nfrom;
	g->from = xalloc((setup->nfrom + 1) * sizeof *g->from);
	for (size_t i = 0; i < setup->nfrom; i++) {
		const char *name = setup->from[i] != NULL ? setup->from[i] : "";
		size_t n = strlen(name) + 1;
		g->from[i] = memcpy(xalloc(n), name, n);
	}
	return g;
}

void gd_free(gd *g) {
	if (g == NULL) return;
	for (size_t i = 0; i < g->nfrom; i++) free((char *)g->from[i]);
	free(g->from);
	free(g);
}

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

static pr_target target_of(const gd_target *t) {
	pr_target target = {.part = t->part, .field = t->field, .id = t->thing.id};
	target.path = t->thing.path, target.npath = t->thing.npath;
	return target;
}

static gd_answer asked_from(gd *g, int told, const char *op, const gd_target *t,
	const gd_target *node, int from_given, const char *const *from, size_t nfrom,
	const char **reason, pr_grant *grant) {
	*grant = (pr_grant){0};
	if (g->may == NULL) return GD_OK;
	op_value *who = pl_change_base(g->places, NULL, 0);
	pr_ask ask = {.who = who, .op = op, .target = target_of(t)};
	if (node != NULL) ask.node = target_of(node);
	if (from_given) ask.from.path = from, ask.from.npath = nfrom;
	pr_answer a = pr_ask_of(g->may, &ask, told ? told_reader : quiet_reader, g);
	op_free(who);
	if (pl_status(g->places) != SC_OK) return GD_FAILED;
	*reason = a.reason;
	*grant = a.grant;
	return a.verdict == PR_YES ? GD_OK : a.verdict == PR_NO ? GD_REFUSED : GD_PENDING;
}

static gd_answer asked(gd *g, int told, const char *op, const gd_target *t, const gd_target *node,
	const char **reason, pr_grant *grant) {
	*grant = (pr_grant){0};
	if (gd_is_refused(t->thing.id) || (node != NULL && gd_is_refused(node->thing.id))) {
		return *reason = "refused", GD_REFUSED;
	}
	gd_answer first = asked_from(g, told, op, t, node, g->from_given, g->from, g->nfrom,
		reason, grant);
	const char *const *from;
	size_t nfrom;
	if (first == GD_REFUSED || first == GD_FAILED || g->caller == NULL ||
		!g->caller(g->caller_ctx, &from, &nfrom)) {
		return first;
	}
	int same = g->from_given == (from != NULL);
	if (same && from != NULL) {
		same = g->nfrom == nfrom;
		for (size_t i = 0; same && i < nfrom; i++) same = strcmp(g->from[i], from[i]) == 0;
	}
	if (same) return first;
	const char *reason2 = NULL;
	pr_grant grant2;
	gd_answer second = asked_from(g, told, op, t, node, from != NULL, from, nfrom, &reason2,
		&grant2);
	if (second == GD_REFUSED || second == GD_FAILED ||
		(first == GD_OK && second == GD_PENDING)) {
		*reason = reason2;
		*grant = grant2;
		return second;
	}
	return first;
}

static gd_answer demand(gd *g, int told, const char *op, const gd_target *targets, size_t n,
	gd_refusal *why) {
	int waiting = 0;
	for (size_t i = 0; i < n; i++) {
		const char *reason = NULL;
		pr_grant grant;
		gd_answer a = asked(g, told, op, &targets[i], NULL, &reason, &grant);
		if (a == GD_REFUSED) {
			if (why != NULL) *why = (gd_refusal){op, reason, grant, i};
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

gd_answer gd_place(gd *g, const gd_target *slot, const gd_target *node, const char *const *ops,
	size_t nops, gd_refusal *why) {
	const char *reason = NULL;
	pr_grant grant;
	gd_answer a = asked(g, 0, "place", slot, node, &reason, &grant);
	if (a == GD_REFUSED) {
		if (why != NULL) *why = (gd_refusal){"place", reason, grant, 0};
		return a;
	}
	if (a == GD_FAILED) return a;
	int waiting = a == GD_PENDING;
	for (size_t i = 0; i < nops; i++) {
		a = asked(g, 0, ops[i], node, NULL, &reason, &grant);
		if (a == GD_REFUSED) {
			if (why != NULL) *why = (gd_refusal){ops[i], reason, grant, 1};
			return a;
		}
		if (a == GD_FAILED) return a;
		if (a == GD_PENDING) waiting = 1;
	}
	return waiting ? GD_PENDING : GD_OK;
}

gd_answer gd_move(const char *const *from, size_t nfrom, const char *const *to, size_t nto,
	gd_refusal *why) {
	if (nto <= nfrom) return GD_OK;
	for (size_t i = 0; i < nfrom; i++)
		if (strcmp(from[i], to[i]) != 0) return GD_OK;
	if (why != NULL) *why = (gd_refusal){"move", "into-itself", {0}, 0};
	return GD_REFUSED;
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
		pr_grant grant;
		gd_answer a = asked(g, 1, "read", &t, NULL, &reason, &grant);
		if (a == GD_FAILED) return free(items), free(path), a;
		if (a == GD_PENDING) waiting = 1;
		items[i] = a == GD_OK ? list->items[i] : (pl_member){list->items[i].name, gd_refused(), list->items[i].from};
	}
	free(path);
	if (waiting) return free(items), GD_PENDING;
	*out = (pl_members){list->n, items};
	return GD_OK;
}
