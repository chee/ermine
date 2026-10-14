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

gd_target gd_item_target(gd_item item, const char *part, const op_value *field) {
	return (gd_target){.item = item, .part = part, .field = field};
}
gd_target gd_entry_target(tb_key source, tb_key id, const char *part, const op_value *field) {
	return (gd_target){.source = source, .id = id, .part = part, .field = field};
}

// where something stands: its path from a start and the route it took, or (an entry) the entry
// alone. The strings are the item's
typedef struct {
	const char **path;
	size_t npath;
	pr_entry *route;
	size_t nroute;
} standing;

static standing standing_of_item(const pl_item *item) {
	standing s = {0};
	for (const pl_item *up = item; up != NULL; up = up->up) s.nroute++;
	s.route = xalloc(s.nroute * sizeof *s.route);
	size_t i = s.nroute;
	for (const pl_item *up = item; up != NULL; up = up->up) s.route[--i] = (pr_entry){up->source, up->id};
	s.npath = pl_path(item, NULL, 0);
	s.path = xalloc(s.npath * sizeof *s.path);
	pl_path(item, s.path, s.npath);
	return s;
}
static void standing_free(standing *s) {
	free(s->path);
	free(s->route);
}

struct gd {
	lk *link;
	st_store *store;
	const pr_policy *may;
	// where the asker stands (from_given: it is placed somewhere)
	int from_given;
	standing from;
	pr_entry from_entry;
	// a typed array's element a reader returns, a number made each time
	op_value scratch;
};

gd *gd_new(const gd_setup *setup) {
	gd *g = xalloc(sizeof *g);
	g->link = setup->link;
	g->store = setup->store;
	g->may = setup->may;
	if (setup->from == NULL) return g;
	g->from_given = 1;
	if (setup->from->item != NULL) {
		g->from = standing_of_item(setup->from->item);
	} else {
		g->from_entry = (pr_entry){setup->from->source, setup->from->id};
		g->from.route = &g->from_entry;
		g->from.nroute = 1;
	}
	return g;
}

void gd_free(gd *g) {
	if (g == NULL) return;
	if (g->from.route != &g->from_entry) standing_free(&g->from);
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
static const op_value *told_reader(void *ctx, tb_key source, const char *part, tb_key id,
	const op_value *path, const op_value *at) {
	(void)at;
	gd *g = ctx;
	size_t n;
	op_key *keys = steps_of(path, &n);
	const op_value *v = lk_get(g->link, source, part, id, keys, n);
	free(keys);
	return v;
}
// a write's: told no one
static const op_value *quiet_reader(void *ctx, tb_key source, const char *part, tb_key id,
	const op_value *path, const op_value *at) {
	(void)at;
	gd *g = ctx;
	size_t n;
	op_key *keys = steps_of(path, &n);
	const nd_node *node = st_get(g->store, source, part, id);
	const op_value *v = node != NULL ? lk_at(node->value, keys, n, &g->scratch) : NULL;
	free(keys);
	return v;
}

// asking ----------------------------------------------------------------------------------------

// one target asked: told (reads) or not (writes). *reason: why a no
static gd_answer asked(gd *g, int told, const char *op, const gd_target *t, const char **reason) {
	// a stand-in is refused, never asked
	if (t->item.item != NULL && t->item.refused) return *reason = "refused", GD_REFUSED;
	if (g->may == NULL) return GD_OK;
	pr_target target = {.part = t->part, .field = t->field};
	standing at = {0};
	if (t->item.item != NULL) {
		target.source = t->item.item->source;
		target.id = t->item.item->id;
		at = standing_of_item(t->item.item);
		target.path = at.path, target.npath = at.npath;
		target.route = at.route, target.nroute = at.nroute;
	} else {
		target.source = t->source;
		target.id = t->id;
	}
	op_value *who = lk_who(g->link, NULL, 0);
	pr_ask ask = {.who = who, .op = op, .target = target};
	if (g->from_given) {
		ask.from.path = g->from.path, ask.from.npath = g->from.npath;
		ask.from.route = g->from.route, ask.from.nroute = g->from.nroute;
	}
	pr_answer a = pr_ask_of(g->may, &ask, told ? told_reader : quiet_reader, g);
	op_free(who);
	standing_free(&at);
	// a read the policy told that said the run must end
	if (lk_status(g->link) != SC_OK) return GD_FAILED;
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

gd_answer gd_items(gd *g, const pl_list *list, gd_list *out) {
	*out = (gd_list){0};
	gd_item *items = xalloc(list->n * sizeof *items);
	int waiting = 0;
	for (size_t i = 0; i < list->n; i++) {
		gd_target t = gd_item_target((gd_item){list->items[i], 0}, NULL, NULL);
		const char *reason;
		gd_answer a = asked(g, 1, "read", &t, &reason);
		if (a == GD_FAILED) return free(items), a;
		if (a == GD_PENDING) waiting = 1;
		items[i] = (gd_item){list->items[i], a != GD_OK};
	}
	if (waiting) return free(items), GD_PENDING;
	*out = (gd_list){list->n, items};
	return GD_OK;
}

void gd_list_free(gd_list *list) {
	free(list->items);
	*list = (gd_list){0};
}
