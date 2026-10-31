// The C guard on the line protocol of typescript/guard_harness.ts.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "guard.h"
#include "../../places/c/world_harness.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static op_value *asked;

static op_value *strings_json(const char *const *names, size_t n) {
	op_value *a = op_list();
	for (size_t i = 0; i < n; i++) op_push(a, op_str(names[i]));
	return a;
}

static op_value *target_json(const pr_target *x) {
	op_value *t = op_map();
	if (x->part) op_set(t, "part", op_str(x->part));
	if (x->id.string) op_set(t, "id", op_str(x->id.string));
	if (x->field) op_set(t, "field", world_snap(x->field));
	if (x->path) op_set(t, "path", strings_json(x->path, x->npath));
	return t;
}

static op_value *who_json(const op_value *who) {
	op_value *o = op_map();
	for (size_t i = 0; i < who->count; i++) {
		const op_value *v = who->items[i];
		op_set(o, who->keys[i], strcmp(who->keys[i], "frame") == 0 ? world_show_infos(v) : world_snap(v));
	}
	return o;
}

static op_value *ask_json(const pr_ask *ask) {
	op_value *o = op_map();
	const pr_target *n = &ask->node;
	op_set(o, "op", op_str(ask->op));
	op_set(o, "target", target_json(&ask->target));
	if (n->part || n->id.string || n->field || n->path) op_set(o, "node", target_json(n));
	if (ask->who) op_set(o, "who", who_json(ask->who));
	if (ask->from.path) {
		op_value *from = op_map();
		op_set(from, "path", strings_json(ask->from.path, ask->from.npath));
		op_set(o, "from", from);
	}
	return o;
}

static void **kept;
static size_t nkept, capkept;
static pr_policy **policies;
static size_t npolicies, cappolicies;

static void *keep(void *p) {
	PUSH(kept, nkept, capkept, p);
	return p;
}

typedef struct {
	const op_value *m;
} data;

static pr_answer yes(void) { return (pr_answer){.verdict = PR_YES}; }
static pr_answer no(const char *reason) { return (pr_answer){.verdict = PR_NO, .reason = reason}; }

static pr_answer access_policy(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)ask;
	const op_value *m = ((data *)ctx)->m;
	const op_value *a = pr_read_at(read, world_text(m->items[0]), world_key(m->items[1]), NULL);
	if (a == NULL) return (pr_answer){.verdict = PR_PENDING};
	return a->type == OP_STR && strcmp(a->str, "allow") == 0 ? yes() : no("closed");
}
static pr_answer denyid_policy(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)read;
	const char *id = ask->target.id.string;
	return id && strcmp(id, ((data *)ctx)->m->str) == 0 ? no("denied id") : yes();
}
static pr_answer denynode_policy(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)read;
	const char *id = ask->node.id.string;
	return id && strcmp(id, ((data *)ctx)->m->str) == 0 ? no("denied node") : yes();
}
static pr_answer whois_policy(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)read;
	const op_value *m = ((data *)ctx)->m;
	const op_value *who = ask->who;
	const op_value *actor = who ? op_get(who, "actor") : NULL, *reader = who ? op_get(who, "reader") : NULL;
	bool same = actor && reader && actor->type == OP_STR && reader->type == OP_STR &&
		strcmp(actor->str, m->items[0]->str) == 0 &&
		strcmp(reader->str, m->items[1]->str) == 0;
	return same ? yes() : no("whois");
}

static pr_policy *policy(const op_value *p);

static pr_policy *policy_call(pr_call_fn fn, const op_value *m) {
	data *d = keep(world_alloc(sizeof *d));
	d->m = m;
	return pr_call(fn, d);
}

static pr_policy *policy(const op_value *p) {
	if (world_is(p, OP_STR)) {
		if (strcmp(p->str, "yes") == 0) return pr_yes();
		if (strcmp(p->str, "pending") == 0) return pr_pending();
		return NULL;
	}
	if (!world_is(p, OP_MAP)) return NULL;
	const op_value *x;
	if ((x = op_get(p, "no"))) return pr_no(x->str);
	if ((x = op_get(p, "grants"))) {
		return pr_grants((pr_where){world_text(x->items[0]), world_key(x->items[1])});
	}
	if ((x = op_get(p, "all")) || (x = op_get(p, "any"))) {
		pr_policy **kids = keep(world_alloc(((size_t)x->count + 1) * sizeof *kids));
		for (size_t i = 0; i < x->count; i++) {
			if ((kids[i] = policy(x->items[i])) == NULL) return NULL;
		}
		return op_get(p, "all") ? pr_all(kids, (size_t)x->count)
		                         : pr_any(kids, (size_t)x->count);
	}
	if ((x = op_get(p, "only"))) {
		pr_policy *inner = policy(op_get(p, "policy"));
		if (inner == NULL) return NULL;
		const char **ops = keep(world_alloc(((size_t)x->count + 1) * sizeof *ops));
		for (size_t i = 0; i < x->count; i++) ops[i] = world_text(x->items[i]);
		return pr_only(ops, (size_t)x->count, inner);
	}
	if ((x = op_get(p, "access"))) return policy_call(access_policy, x);
	if ((x = op_get(p, "denyid"))) return policy_call(denyid_policy, x);
	if ((x = op_get(p, "denynode"))) return policy_call(denynode_policy, x);
	if ((x = op_get(p, "whois"))) return policy_call(whois_policy, x);
	return NULL;
}

static pr_answer recording(void *ctx, const pr_ask *ask, const pr_read *read) {
	if (asked == NULL) asked = op_list();
	op_push(asked, ask_json(ask));
	return pr_ask_of(ctx, ask, read->reader, read->ctx);
}

typedef struct {
	const char **from;
	size_t nfrom;
} caller;
static int caller_at(void *ctx, const char *const **from, size_t *nfrom) {
	const caller *c = ctx;
	*from = c->from, *nfrom = c->nfrom;
	return 1;
}

typedef struct {
	char *name;
	gd *g;
	caller *caller;
} guard;
static guard *guards;
static size_t nguards, capguards;

static gd *guard_named(const char *name) {
	for (size_t i = 0; i < nguards; i++) if (strcmp(guards[i].name, name) == 0) return guards[i].g;
	return NULL;
}

typedef enum { RAN, REFUSED, PENDING, CODE } ended;

typedef struct {
	gd *g;
	const op_value *given;
	bool stopped;
	ended ended;
	gd_refusal refusal;
	const op_value *refused_field;
	char *code;
	const char ***held;
	size_t nheld, capheld;
} ctx;

static op_value *eval(const op_value *e, ctx *c);
static op_value *eval_for_fill(const op_value *e, void *c) { return eval(e, c); }

static op_value *thrown_code(ctx *c, char *code) {
	if (c->ended == RAN) c->ended = CODE, c->code = code;
	else free(code);
	return NULL;
}
static bool allowed(ctx *c, gd_answer a, const gd_refusal *why, const gd_target *targets) {
	if (a == GD_FAILED) c->stopped = true;
	else if (a == GD_PENDING && c->ended == RAN) c->ended = PENDING;
	else if (a == GD_REFUSED && c->ended == RAN) {
		c->ended = REFUSED, c->refusal = *why;
		c->refused_field = targets[why->target].field;
	}
	return a == GD_OK;
}
static bool alive(ctx *c) {
	sc_track_status status = pl_status(world_places);
	if (status == SC_STOP) c->stopped = true;
	return status == SC_OK;
}

static const char *const *names_of(ctx *c, const op_value *list, size_t *n) {
	const char **names = world_address(list, n);
	PUSH(c->held, c->nheld, c->capheld, names);
	return names;
}

static bool guarded(ctx *c, const char *const *path, size_t n, pl_member *out) {
	tb_key id;
	bool found = pl_get(world_places, path, n, &id);
	if (!alive(c)) return false;
	if (!found) return false;
	pl_member one = {n ? path[n - 1] : "", id, NULL};
	pl_members list = {1, &one}, got;
	if (!allowed(c, gd_members(c->g, &list, path, n ? n - 1 : 0, &got), NULL, NULL)) return false;
	*out = got.items[0];
	pl_members_free(&got);
	return true;
}

static bool start_of(ctx *c, const op_value *ts, gd_thing *out) {
	*out = (gd_thing){0};
	if (world_is(ts, OP_STR)) {
		out->id = world_key(ts);
		return true;
	}
	size_t n;
	const char *const *path = names_of(c, op_get(ts, "at"), &n);
	pl_member m;
	if (!guarded(c, path, n, &m)) {
		if (c->ended == RAN && !c->stopped) thrown_code(c, world_copy("nothing there"));
		return false;
	}
	*out = (gd_thing){m.id, path, n};
	return true;
}

static const char *shown(tb_key id) { return gd_is_refused(id) ? "REFUSED" : id.string; }
static op_value *members_json(const pl_members *list, bool full) {
	op_value *a = op_list();
	for (size_t i = 0; i < list->n; i++) {
		const pl_member *m = &list->items[i];
		if (!full) {
			op_push(a, op_str(shown(m->id)));
			continue;
		}
		op_value *row = op_list();
		op_push(row, op_str(shown(m->id)));
		op_push(row, op_str(m->name));
		if (m->from != NULL) op_push(row, op_str(m->from));
		op_push(a, row);
	}
	return a;
}

static op_value *eval_get(const op_value *e, const op_value *x, ctx *c) {
	size_t n;
	const char *const *path = names_of(c, x, &n);
	pl_member m;
	if (!guarded(c, path, n, &m)) return c->ended == RAN && !c->stopped ? op_null() : NULL;
	if (op_get(e, "full") == NULL) return op_str(shown(m.id));
	pl_members one = {1, &m};
	op_value *rows = members_json(&one, true), *row = op_ref(rows->items[0]);
	op_free(rows);
	return row;
}

static op_value *eval_members(const op_value *x, bool full, ctx *c) {
	size_t n;
	const char *const *path = names_of(c, x, &n);
	pl_members list = pl_members_at(world_places, path, n), got;
	if (!alive(c)) return pl_members_free(&list), NULL;
	gd_answer a = gd_members(c->g, &list, path, n, &got);
	pl_members_free(&list);
	if (!allowed(c, a, NULL, NULL)) return NULL;
	op_value *out = members_json(&got, full);
	pl_members_free(&got);
	return out;
}

static op_value *eval_ask(const op_value *x, const op_value *at, ctx *c) {
	size_t n = 0;
	const char *const *path = at != NULL ? names_of(c, at, &n) : NULL;
	pl_members list = {x->count, world_alloc((x->count + 1) * sizeof(pl_member))}, got;
	for (size_t i = 0; i < x->count; i++) {
		const op_value *row = x->items[i];
		list.items[i] = (pl_member){world_text(row->items[0]), world_key(row->items[1]),
			row->count > 2 ? world_text(row->items[2]) : NULL};
	}
	gd_answer a = gd_members(c->g, &list, path, n, &got);
	pl_members_free(&list);
	if (!allowed(c, a, NULL, NULL)) return NULL;
	op_value *out = members_json(&got, true);
	pl_members_free(&got);
	return out;
}

static op_value *eval_read(const op_value *x, ctx *c) {
	gd_thing s;
	if (!start_of(c, x->items[0], &s)) return NULL;
	const char *part = world_text(x->items[1]);
	const op_value *path = x->count > 2 ? x->items[2] : NULL;
	gd_target t = gd_target_of(s, part, path);
	gd_refusal why;
	bool ok = allowed(c, gd_read(c->g, &t, 1, &why), &why, &t);
	if (!ok) return NULL;
	size_t n;
	op_key *keys = world_path(path, &n);
	const op_value *v = pl_read(world_places, tb_string(world_part(x->items[1])), s.id, keys, n);
	free(keys);
	return alive(c) ? world_snap(v) : NULL;
}

static op_value *eval_edit(const op_value *x, ctx *c) {
	gd_thing s;
	if (!start_of(c, x->items[0], &s)) return NULL;
	const char *part = world_text(x->items[1]);
	op_value *patches = world_fill(x->items[2], eval_for_fill, c);
	if (patches == NULL) return NULL;
	world_keep(patches);
	size_t cap = 2 * (size_t)patches->count + 1, n = 0;
	gd_target *targets = world_alloc(cap * sizeof *targets);
	for (size_t i = 0; i < patches->count; i++) {
		const op_value *p = patches->items[i], *move = op_get(p, "move");
		targets[n++] = gd_target_of(s, part, op_get(p, "path"));
		if (move) targets[n++] = gd_target_of(s, part, op_get(move, "path"));
	}
	gd_refusal why;
	bool ok = allowed(c, gd_write(c->g, "edit", targets, n, &why), &why, targets);
	free(targets);
	if (!ok) return NULL;
	nd_entry *node;
	const char *bad;
	size_t failed;
	if (world_edit(world_part(x->items[1]), s.id, patches, &node, &bad, &failed)) {
		return thrown_code(c, world_copy(bad));
	}
	return world_summary(&node->change);
}

static op_value *eval_place(const op_value *x, ctx *c) {
	const op_value *slot = x->items[0];
	gd_thing s;
	if (!start_of(c, slot->items[0], &s)) return NULL;
	const char *name = world_text(slot->items[1]);
	op_value *field;
	gd_target t = gd_slot(s, name, &field);
	gd_refusal why;
	bool ok = allowed(c, gd_write(c->g, "place", &t, 1, &why), &why, &t);
	op_free(field);
	if (!ok) return NULL;
	op_value *r = op_map();
	op_set(r, "op", op_str("place"));
	op_set(r, "at", op_str(s.id.string));
	op_set(r, "name", op_str(name));
	op_set(r, "id", op_ref((op_value *)x->items[1]));
	world_keep(r);
	const char *bad;
	size_t failed;
	if (world_write(r, &bad, &failed)) return thrown_code(c, world_copy(bad));
	return op_null();
}

static op_value *eval_name(const op_value *x, ctx *c) {
	const op_value *slot = x->items[0];
	gd_thing s;
	if (!start_of(c, slot->items[0], &s)) return NULL;
	const char *name = world_text(slot->items[1]);
	op_value *field;
	gd_target targets[2];
	targets[0] = gd_slot(s, name, &field);
	targets[1] = gd_target_of((gd_thing){.id = world_key(x->items[1])}, NULL, NULL);
	const op_value *list = x->count > 2 ? x->items[2] : NULL;
	size_t nops = list ? (size_t)list->count : 2;
	const char **ops = world_alloc((nops + 1) * sizeof *ops);
	if (list) for (size_t i = 0; i < nops; i++) ops[i] = world_text(list->items[i]);
	else ops[0] = "read", ops[1] = "edit";
	gd_refusal why;
	bool ok = allowed(c, gd_place(c->g, &targets[0], &targets[1], ops, nops, &why), &why, targets);
	op_free(field);
	free(ops);
	if (!ok) return NULL;
	op_value *r = op_map();
	op_set(r, "op", op_str("place"));
	op_set(r, "at", op_str(s.id.string));
	op_set(r, "name", op_str(name));
	op_set(r, "id", op_ref((op_value *)x->items[1]));
	world_keep(r);
	const char *bad;
	size_t failed;
	if (world_write(r, &bad, &failed)) return thrown_code(c, world_copy(bad));
	return op_null();
}

static op_value *caught(ctx *c) {
	op_value *v;
	switch (c->ended) {
	case REFUSED: v = op_str("refused"); break;
	case PENDING: v = op_str("pending"); break;
	case CODE: v = op_str(c->code); free(c->code); break;
	default: return NULL;
	}
	c->ended = RAN;
	c->code = NULL;
	return v;
}

static op_value *eval(const op_value *e, ctx *c) {
	if (!world_is(e, OP_MAP)) {
		if (!world_is(e, OP_LIST)) return op_ref((op_value *)e);
		op_value *a = op_list();
		for (size_t i = 0; i < e->count; i++) {
			op_value *x = eval(e->items[i], c);
			if (x == NULL) return op_free(a), NULL;
			op_push(a, x);
		}
		return a;
	}
	const op_value *x;
	if ((x = op_get(e, "get"))) return eval_get(e, x, c);
	if ((x = op_get(e, "members"))) {
		return eval_members(x, op_get(e, "full") != NULL, c);
	}
	if ((x = op_get(e, "ask"))) return eval_ask(x, op_get(e, "at"), c);
	if ((x = op_get(e, "read"))) return eval_read(x, c);
	if ((x = op_get(e, "edit"))) return eval_edit(x, c);
	if ((x = op_get(e, "place"))) return eval_place(x, c);
	if ((x = op_get(e, "name"))) return eval_name(x, c);
	if ((x = op_get(e, "try"))) {
		op_value *v = eval(x, c);
		op_value *as = caught(c);
		if (as == NULL) return v;
		op_free(v);
		return as;
	}
	if (op_get(e, "given")) return c->given ? op_ref((op_value *)c->given) : op_null();
	bool handled;
	char *error = NULL;
	op_value *plain = world_basic(e, eval_for_fill, c, &handled, &error);
	if (error) return thrown_code(c, error);
	if (handled) return plain;
	return thrown_code(c, world_copy("unknown program"));
}

static ctx start_ctx(gd *g, const op_value *given) { return (ctx){.g = g, .given = given}; }
static void finish_ctx(ctx *c) {
	for (size_t i = 0; i < c->nheld; i++) free(c->held[i]);
	free(c->held);
	free(c->code);
}

typedef struct {
	const op_value *e;
	gd *g;
	bool detail;
	op_value *out;
} evaluating;
static void in_eval(void *d) {
	evaluating *ev = d;
	ctx c = start_ctx(ev->g, NULL);
	op_value *v = eval(ev->e, &c);
	if (c.stopped) ev->out = world_error("stopped");
	else if (c.ended == REFUSED) {
		ev->out = world_error("refused");
		op_set(ev->out, "reason", op_str(c.refusal.reason));
		op_set(ev->out, "op", op_str(c.refusal.op));
		if (ev->detail && c.refusal.grant.where != NULL) {
			const pr_grant *gr = &c.refusal.grant;
			op_value *grant = op_map();
			op_set(grant, "part", op_str(gr->where->part));
			op_set(grant, "id", op_str(gr->where->id.string));
			op_set(grant, "index", op_num((double)gr->index));
			op_set(ev->out, "grant", grant);
		}
		if (ev->detail && c.refused_field != NULL) op_set(ev->out, "field", op_ref((op_value *)c.refused_field));
	} else if (c.ended == PENDING) ev->out = world_error("pending");
	else if (c.ended == CODE) ev->out = world_error(c.code);
	else {
		ev->out = op_map();
		op_set(ev->out, "value", v ? op_ref(v) : op_null());
	}
	op_free(v);
	finish_ctx(&c);
}

typedef struct {
	world_watch watch;
	gd *g;
	const op_value *f, *then;
} program;
static program **programs;
static size_t nprograms, capprograms;

static sc_out program_f(void *previous, void *d) {
	(void)previous;
	program *p = d;
	p->watch.runs++;
	ctx c = start_ctx(p->g, NULL);
	op_value *v = eval(p->f, &c);
	sc_out out = {.kind = SC_VALUE, .value = v};
	if (c.stopped) op_free(v), out.value = NULL;
	else if (c.ended == PENDING) op_free(v), out = (sc_out){.kind = SC_PENDING};
	else if (c.ended == REFUSED) {
		op_free(v);
		out = (sc_out){.kind = SC_FAILED, .error = world_format("%s refused: %s", c.refusal.op, c.refusal.reason)};
	} else if (c.ended == CODE) {
		op_free(v);
		out = (sc_out){.kind = SC_FAILED, .error = world_copy(c.code)};
	}
	finish_ctx(&c);
	return out;
}

static char *then_of(program *p, void *value) {
	if (p->then == NULL) return NULL;
	ctx c = start_ctx(p->g, value);
	op_value *v = eval(p->then, &c);
	op_free(v);
	char *error = c.ended == CODE ? world_copy(c.code)
	              : c.ended == REFUSED ? world_format("%s refused: %s", c.refusal.op, c.refusal.reason)
	              : c.ended == PENDING ? world_copy("pending") : NULL;
	finish_ctx(&c);
	return error;
}
static char *program_set(void *value, void *d) {
	world_set(value, d);
	return then_of(d, value);
}
static char *program_act(void *value, void *previous, void *d) {
	(void)previous;
	return then_of(d, value);
}

static op_value *answer(const op_value *r) {
	const char *op = world_text(op_get(r, "op"));
	if (op == NULL) return world_error("no op");
	if (strcmp(op, "guard") == 0) {
		const op_value *may = op_get(r, "may"), *from = op_get(r, "from");
		pr_policy *inner = may ? policy(may) : NULL;
		if (may && inner == NULL) return world_error("unknown policy");
		pr_policy *outer = inner ? pr_call(recording, inner) : NULL;
		if (inner) PUSH(policies, npolicies, cappolicies, inner);
		if (outer) PUSH(policies, npolicies, cappolicies, outer);
		guard g = {.name = world_copy(world_text(op_get(r, "name")))};
		size_t nfrom = 0;
		const char **names = from ? world_address(from, &nfrom) : NULL;
		const op_value *given = op_get(r, "caller");
		caller *c = NULL;
		if (given != NULL) {
			c = world_alloc(sizeof *c);
			const op_value *cfrom = op_get(given, "from");
			c->from = cfrom ? world_address(cfrom, &c->nfrom) : NULL;
		}
		g.g = gd_new(&(gd_setup){world_places, world_table, outer, names, nfrom,
			.caller = c ? caller_at : NULL, .caller_ctx = c});
		g.caller = c;
		free(names);
		PUSH(guards, nguards, capguards, g);
		return op_map();
	}
	if (strcmp(op, "eval") == 0) {
		gd *g = guard_named(world_text(op_get(r, "guard")));
		if (g == NULL) return world_error("no such guard");
		const op_value *detail = op_get(r, "detail");
		evaluating ev = {.e = op_get(r, "e"), .g = g, .detail = detail != NULL && detail->type == OP_BOOL && detail->bool_};
		const char *scope = world_text(op_get(r, "scope"));
		if (scope == NULL) in_eval(&ev);
		else {
			sc_scope *o = world_scope(scope);
			if (o == NULL) return world_error("no such scope");
			const char *bad = sc_run_with_scope(o, in_eval, &ev);
			if (bad) return world_error(bad);
		}
		return ev.out;
	}
	if (strcmp(op, "watch") == 0) {
		gd *g = guard_named(world_text(op_get(r, "guard")));
		if (g == NULL) return world_error("no such guard");
		program *p = world_alloc(sizeof *p);
		p->g = g, p->f = op_get(r, "f"), p->then = op_get(r, "then");
		PUSH(programs, nprograms, capprograms, p);
		const op_value *effect = op_get(r, "effect");
		bool is_effect = effect && effect->type == OP_BOOL && effect->bool_;
		sc_def def = {.f = program_f, .equal = world_equal, .data = p};
		if (is_effect) def.effect = program_act;
		else def.set = program_set;
		char *bad = world_make(&p->watch, world_text(op_get(r, "name")), world_text(op_get(r, "scope")), def,
			is_effect);
		if (bad) return world_error_take(bad);
		return op_map();
	}
	if (strcmp(op, "asks") == 0) {
		op_value *o = op_map();
		op_set(o, "asks", asked ? asked : op_list());
		asked = NULL;
		return o;
	}
	return NULL;
}

void hh_answer(const op_value *request, FILE *out) { world_line(request, out, answer); }

void hh_finish(void) {
	for (size_t i = 0; i < nguards; i++) {
		gd_free(guards[i].g);
		free(guards[i].name);
		if (guards[i].caller) free(guards[i].caller->from);
		free(guards[i].caller);
	}
	world_finish();
	for (size_t i = 0; i < npolicies; i++) pr_policy_free(policies[i]);
	for (size_t i = 0; i < nkept; i++) free(kept[i]);
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	op_free(asked);
	free(guards), free(policies), free(kept), free(programs);
}
