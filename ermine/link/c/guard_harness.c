// The C guard (guard.h) on the line protocol of typescript/guard_harness.ts, which documents it,
// the policies and the programs (conformance/c/harness.h has the loop). The world (the store, the
// writes, the scheduler) is world.h's. Each program asks its guard, then reads and writes itself,
// as a process layer will.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "guard.h"
#include "world.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// policies ---------------------------------------------------------------------------------------

// every ask of a guard's policy is recorded, whole, for the asks request
static op_value *asked;

static op_value *strings_json(const char *const *names, size_t n) {
	op_value *a = op_list();
	for (size_t i = 0; i < n; i++) op_push(a, op_str(names[i]));
	return a;
}
static op_value *route_json(const pr_entry *route, size_t n) {
	op_value *a = op_list();
	for (size_t i = 0; i < n; i++) {
		op_value *pair = op_list();
		op_push(pair, op_str(route[i].source.string));
		op_push(pair, op_str(route[i].id.string));
		op_push(a, pair);
	}
	return a;
}

static op_value *ask_json(const pr_ask *ask) {
	op_value *t = op_map();
	const pr_target *x = &ask->target;
	if (x->source.string) op_set(t, "source", op_str(x->source.string));
	if (x->part) op_set(t, "part", op_str(x->part));
	if (x->id.string) op_set(t, "id", op_str(x->id.string));
	if (x->field) op_set(t, "field", world_snap(x->field));
	if (x->path) op_set(t, "path", strings_json(x->path, x->npath));
	if (x->route) op_set(t, "route", route_json(x->route, x->nroute));
	op_value *o = op_map();
	op_set(o, "op", op_str(ask->op));
	op_set(o, "target", t);
	if (ask->who) op_set(o, "who", world_snap(ask->who));
	if (ask->from.route) {
		op_value *from = op_map();
		if (ask->from.path) op_set(from, "path", strings_json(ask->from.path, ask->from.npath));
		op_set(from, "route", route_json(ask->from.route, ask->from.nroute));
		op_set(o, "from", from);
	}
	return o;
}

// the policies of a request, and what they refer to, kept to the end
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

// {access: [source, part, id]}: the value there: not there, pending; "allow", yes; else no
static pr_answer access_policy(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)ask;
	const op_value *m = ((data *)ctx)->m;
	const op_value *a = pr_read_at(read, world_key(m->items[0]), world_text(m->items[1]),
		world_key(m->items[2]), NULL);
	if (a == NULL) return (pr_answer){.verdict = PR_PENDING};
	return a->type == OP_STR && strcmp(a->str, "allow") == 0 ? yes() : no("closed");
}
// {denyid: id}: no for that target id
static pr_answer denyid_policy(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)read;
	const char *id = ask->target.id.string;
	return id && strcmp(id, ((data *)ctx)->m->str) == 0 ? no("denied id") : yes();
}
// {whois: [actor, reader]}: yes for that actor and reader of who
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
		return pr_grants((pr_where){world_key(x->items[0]), world_text(x->items[1]),
			world_key(x->items[2])});
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
	if ((x = op_get(p, "whois"))) return policy_call(whois_policy, x);
	return NULL;
}

// a policy that writes down what it is asked
static pr_answer recording(void *ctx, const pr_ask *ask, const pr_read *read) {
	if (asked == NULL) asked = op_list();
	op_push(asked, ask_json(ask));
	return pr_ask_of(ctx, ask, read->reader, read->ctx);
}

// guards -----------------------------------------------------------------------------------------

typedef struct {
	char *name;
	gd *g;
	// the item it is placed at, held
	pl_item *at;
} guard;
static guard *guards;
static size_t nguards, capguards;

static gd *guard_named(const char *name) {
	for (size_t i = 0; i < nguards; i++) if (strcmp(guards[i].name, name) == 0) return guards[i].g;
	return NULL;
}

// programs ---------------------------------------------------------------------------------------

typedef enum { RAN, REFUSED, PENDING, CODE } ended;

// what a program is evaluated in: its guard, the value a `then` is given, and how it ended early,
// if it did: stopped (a read said the run must end), or an exception
typedef struct {
	gd *g;
	const op_value *given;
	bool stopped;
	ended ended;
	gd_refusal refusal;
	char *code;
	// the items it held (the items a start names), let go at the end
	pl_item **held;
	size_t nheld, capheld;
} ctx;

static op_value *eval(const op_value *e, ctx *c);
static op_value *eval_for_fill(const op_value *e, void *c) { return eval(e, c); }

static op_value *thrown_code(ctx *c, char *code) {
	if (c->ended == RAN) c->ended = CODE, c->code = code;
	else free(code);
	return NULL;
}
// what an answer of the guard does to the program: false when it must end
static bool allowed(ctx *c, gd_answer a, const gd_refusal *why) {
	if (a == GD_FAILED) c->stopped = true;
	else if (a == GD_PENDING && c->ended == RAN) c->ended = PENDING;
	else if (a == GD_REFUSED && c->ended == RAN) c->ended = REFUSED, c->refusal = *why;
	return a == GD_OK;
}
// whether the reads the program told let it go on
static bool alive(ctx *c) {
	sc_read_status status = lk_status(world_link);
	if (status == SC_STOP) c->stopped = true;
	if (status == SC_CLOSED) thrown_code(c, world_copy(SC_STOPPED));
	return status == SC_OK;
}

// where a program starts: an item of a guarded get (maybe refused), or an entry
typedef struct {
	gd_item item;
	tb_key source, id;
} start;

static gd_target start_target(const start *s, const char *part, const op_value *field) {
	return s->item.item ? gd_item_target(s->item, part, field)
	                    : gd_entry_target(s->source, s->id, part, field);
}
static void start_ids(const start *s, tb_key *source, tb_key *id) {
	*source = s->item.item ? s->item.item->source : s->source;
	*id = s->item.item ? s->item.item->id : s->id;
}

// the start a program names: an entry, or {"item": [name..], "n"?: k}, the kth of the guarded get
static bool start_of(ctx *c, const op_value *ts, start *out) {
	*out = (start){0};
	if (world_is(ts, OP_LIST)) {
		out->source = world_key(ts->items[0]);
		out->id = world_key(ts->items[1]);
		return true;
	}
	size_t n;
	const char **names = world_address(op_get(ts, "item"), &n);
	pl_list *list = pl_get(world_places, names, n, NULL, NULL);
	free(names);
	if (!alive(c)) return pl_list_free(list), false;
	gd_list items;
	if (!allowed(c, gd_items(c->g, list, &items), NULL)) return pl_list_free(list), false;
	int64_t k = 0;
	world_whole(op_get(ts, "n"), &k);
	bool found = k >= 0 && (size_t)k < items.n;
	if (found) {
		// the item outlives its list, held until the program ends
		out->item = items.items[k];
		PUSH(c->held, c->nheld, c->capheld, pl_item_ref((pl_item *)items.items[k].item));
	} else {
		thrown_code(c, world_copy("no such item"));
	}
	gd_list_free(&items);
	pl_list_free(list);
	return found;
}

static const char *shown(gd_item i, char **text) {
	if (i.refused) return "REFUSED";
	*text = world_format("%s:%s", i.item->source.string, i.item->id.string);
	return *text;
}
static op_value *items_json(const gd_list *items, bool full) {
	op_value *a = op_list();
	for (size_t i = 0; i < items->n; i++) {
		gd_item it = items->items[i];
		if (!full) {
			char *text = NULL;
			op_push(a, op_str(shown(it, &text)));
			free(text);
			continue;
		}
		op_value *row = op_list();
		op_push(row, op_str(it.refused ? "REFUSED" : it.item->source.string));
		op_push(row, op_str(it.refused ? "REFUSED" : it.item->id.string));
		op_push(row, it.item->name ? op_str(it.item->name) : op_null());
		op_push(row, it.item->name ? op_num((double)((int64_t)it.item->at)) : op_null());
		op_push(a, row);
	}
	return a;
}

// the guarded items of a list the program got
static op_value *guarded(ctx *c, pl_list *list, bool full) {
	if (!alive(c)) return pl_list_free(list), NULL;
	gd_list items;
	if (!allowed(c, gd_items(c->g, list, &items), NULL)) return pl_list_free(list), NULL;
	op_value *a = items_json(&items, full);
	gd_list_free(&items);
	pl_list_free(list);
	return a;
}

static op_value *eval_get(const op_value *e, const op_value *x, ctx *c) {
	size_t n;
	const char **names = world_address(x, &n);
	const op_value *from = op_get(e, "from");
	start s = {0};
	if (from && !start_of(c, from, &s)) return free(names), NULL;
	// a refused place to start from has nothing under it
	if (s.item.refused) return free(names), op_list();
	pl_at at = s.item.item ? pl_at_item(s.item.item) : pl_at_entry(s.source, s.id);
	pl_list *list = pl_get(world_places, names, n, from ? &at : NULL, NULL);
	free(names);
	return guarded(c, list, op_get(e, "full") != NULL);
}

static op_value *eval_read(const op_value *x, ctx *c) {
	start s;
	if (!start_of(c, x->items[0], &s)) return NULL;
	const char *part = world_text(x->items[1]);
	const op_value *path = x->count > 2 ? x->items[2] : NULL;
	gd_target t = start_target(&s, part, path);
	gd_refusal why;
	bool ok = allowed(c, gd_read(c->g, &t, 1, &why), &why);
	if (!ok) return NULL;
	tb_key source, id;
	start_ids(&s, &source, &id);
	size_t n;
	op_key *keys = world_path(path, &n);
	const op_value *v = lk_get(world_link, source, world_part(x->items[1]), id, keys, n);
	free(keys);
	return alive(c) ? world_snap(v) : NULL;
}

// each patch asked by its path (and a move's), then written
static op_value *eval_edit(const op_value *x, ctx *c) {
	start s;
	if (!start_of(c, x->items[0], &s)) return NULL;
	const char *part = world_text(x->items[1]);
	op_value *patches = world_fill(x->items[2], eval_for_fill, c);
	if (patches == NULL) return NULL;
	world_keep(patches);
	size_t cap = 2 * (size_t)patches->count + 1, n = 0;
	gd_target *targets = world_alloc(cap * sizeof *targets);
	for (size_t i = 0; i < patches->count; i++) {
		const op_value *p = patches->items[i], *move = op_get(p, "move");
		targets[n++] = start_target(&s, part, op_get(p, "path"));
		if (move) targets[n++] = start_target(&s, part, op_get(move, "path"));
	}
	gd_refusal why;
	bool ok = allowed(c, gd_write(c->g, "edit", targets, n, &why), &why);
	free(targets);
	if (!ok) return NULL;
	tb_key source, id;
	start_ids(&s, &source, &id);
	nd_node *node;
	const char *bad;
	size_t failed;
	if (world_edit(source, world_part(x->items[1]), id, patches, &node, &bad, &failed)) {
		return thrown_code(c, world_copy(bad));
	}
	return world_summary(&node->change);
}

// the slot asked, then placed
static op_value *eval_place(const op_value *x, ctx *c) {
	const op_value *slot = x->items[0];
	start s;
	if (!start_of(c, slot->items[0], &s)) return NULL;
	const char *name = world_text(slot->items[1]);
	op_value *field = op_list();
	op_push(field, op_str(name));
	gd_target t = start_target(&s, "children", field);
	gd_refusal why;
	bool ok = allowed(c, gd_write(c->g, "place", &t, 1, &why), &why);
	op_free(field);
	if (!ok) return NULL;
	tb_key source, id;
	start_ids(&s, &source, &id);
	op_value *r = op_map(), *at = op_list();
	op_push(at, op_str(source.string));
	op_push(at, op_str(id.string));
	op_set(r, "op", op_str("place"));
	op_set(r, "at", at);
	op_set(r, "name", op_str(name));
	op_set(r, "entry", op_ref((op_value *)x->items[1]));
	world_keep(r);
	const char *bad;
	size_t failed;
	if (world_write(r, &bad, &failed)) return thrown_code(c, world_copy(bad));
	return op_null();
}

// the exception a program ended on, as the value `try` gives; no exception: NULL
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
		start s;
		if (!start_of(c, x, &s)) return NULL;
		if (s.item.refused) return op_list();
		pl_at at = s.item.item ? pl_at_item(s.item.item) : pl_at_entry(s.source, s.id);
		return guarded(c, pl_members_at(world_places, at, NULL), false);
	}
	if ((x = op_get(e, "read"))) return eval_read(x, c);
	if ((x = op_get(e, "edit"))) return eval_edit(x, c);
	if ((x = op_get(e, "place"))) return eval_place(x, c);
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
	for (size_t i = 0; i < c->nheld; i++) pl_item_free(c->held[i]);
	free(c->held);
	free(c->code);
}

// requests ---------------------------------------------------------------------------------------

// eval: the program with the scope open
typedef struct {
	const op_value *e;
	gd *g;
	op_value *out;
} evaluating;
static void in_eval(void *d) {
	evaluating *ev = d;
	ctx c = start_ctx(ev->g, NULL);
	op_value *v = eval(ev->e, &c);
	if (c.stopped) ev->out = world_error(SC_STOPPED);
	else if (c.ended == REFUSED) {
		ev->out = world_error("refused");
		op_set(ev->out, "reason", op_str(c.refusal.reason));
		op_set(ev->out, "op", op_str(c.refusal.op));
	} else if (c.ended == PENDING) ev->out = world_error("pending");
	else if (c.ended == CODE) ev->out = world_error(c.code);
	else {
		ev->out = op_map();
		op_set(ev->out, "value", v ? op_ref(v) : op_null());
	}
	op_free(v);
	finish_ctx(&c);
}

// a watch's code: counts its run, evaluates its program, its `then` in its set or its act
typedef struct {
	world_watch watch;
	gd *g;
	const op_value *f, *then;
} program;
static program **programs;
static size_t nprograms, capprograms;

static sc_out program_f(sc_run *run, void *d) {
	(void)run;
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

// then, given the value
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
		pl_at at = {0};
		if (from && world_is_entry(from)) at = world_entry(from);
		else if (from) {
			size_t n;
			const char **names = world_address(op_get(from, "get"), &n);
			pl_list *list = pl_get(world_places, names, n, NULL, NULL);
			free(names);
			if (list->n > 0) g.at = pl_item_ref(list->items[0]), at = pl_at_item(g.at);
			else from = NULL;
			pl_list_free(list);
		}
		g.g = gd_new(&(gd_setup){world_link, world_store, outer, from ? &at : NULL});
		PUSH(guards, nguards, capguards, g);
		return op_map();
	}
	if (strcmp(op, "eval") == 0) {
		gd *g = guard_named(world_text(op_get(r, "guard")));
		if (g == NULL) return world_error("no such guard");
		evaluating ev = {.e = op_get(r, "e"), .g = g};
		const char *scope = world_text(op_get(r, "scope"));
		if (scope == NULL) in_eval(&ev);
		else {
			sc_scope *o = world_scope(scope);
			if (o == NULL) return world_error("no such scope");
			const char *bad = sc_setup(o, in_eval, &ev);
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
		if (is_effect) def.act = program_act;
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
		if (guards[i].at) pl_item_free(guards[i].at);
		free(guards[i].name);
	}
	world_finish();
	for (size_t i = 0; i < npolicies; i++) pr_free(policies[i]);
	for (size_t i = 0; i < nkept; i++) free(kept[i]);
	for (size_t i = 0; i < nprograms; i++) free(programs[i]);
	op_free(asked);
	free(guards), free(policies), free(kept), free(programs);
}
