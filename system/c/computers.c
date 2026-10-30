// Memos and effects (createMemo, createEffect), their nodes and names, and status. ermine.h
// declares the functions. es_computers_free runs while the scheduler is still there, because it
// lets go of the promises it made.
#include "ermine.h"

#include <stdbool.h>
#include <stdio.h>

typedef struct made made;
typedef struct bridge bridge;

// a promise a compute gave, settled as the program's promise settles; let go after the pulse or at close
struct bridge {
	struct es_computers *x;
	sc_promise *sp;
	char *id;
	int settled;
};

// a memo or effect made: its code, in place (its owner running again gives it new code). Held by
// the creating call and by each cleanup still to come on its owner; let go with the last.
struct made {
	struct es_computers *x;
	es_context *cx;
	sc_scope *own;
	sc_computer *c;
	char *id;
	op_value *id_value;
	char **path;
	size_t npath;
	char *key;
	int memo, early;
	es_compute f;
	es_act act;
	void *ctx;
	es_equal equal;
	void *equal_ctx;
	unsigned holds;
	int gone, given, awaiting;
	int pausing;
	void *awaiting_for;
	int binned;
	size_t at;
};

typedef struct {
	made **v;
	size_t n, cap;
} madelist;

// what an owner made and has not let go. One teardown on the owner asks after them all when the
// owner runs again (run once the next run is done: a computer claimed again is left alone, one not
// made again is dead and its node and name go) and when the owner goes. A stopped memo or effect
// leaves its owner's bin at once.
typedef struct {
	struct es_computers *x;
	sc_scope *own;
	made **v;
	size_t n, cap;
	int armed;
} bin;

struct es_computers {
	es_ermine *e;
	pm bins;
	es_map by_id;
	made **all;
	size_t nall, capall;
	// the id values computers were made with (the scheduler borrows its info), freed with their computer
	pm ids;
	bridge **bridges;
	size_t nbridges, capbridges;
	sc_listener *after, *freed;
	sc_scope *acting;
};

// state ----------

static void sweep(struct es_computers *x) {
	size_t k = 0;
	for (size_t i = 0; i < x->nbridges; i++) {
		bridge *b = x->bridges[i];
		if (!b->settled) {
			x->bridges[k++] = b;
			continue;
		}
		sc_promise_free(b->sp);
		free(b->id);
		free(b);
	}
	x->nbridges = k;
}

static void after_pulse(void *data) { sweep(data); }

static void computer_freed(sc_scope *o, void *data) {
	struct es_computers *x = data;
	op_value *id = pm_get(&x->ids, o);
	if (id == NULL) return;
	pm_delete(&x->ids, o);
	op_free(id);
}

struct es_computers *es_computers_new(es_ermine *e) {
	struct es_computers *x = es_alloc(sizeof *x);
	x->e = e;
	if (e->scheduler != NULL) {
		x->after = sc_on_after_pulse(e->scheduler, after_pulse, x);
		x->freed = sc_on_free(e->scheduler, computer_freed, x);
	}
	return x;
}

static void named_del(made *m);

static void bin_leave(made *m);

static void free_made(made *m) {
	struct es_computers *x = m->x;
	bin_leave(m);
	named_del(m);
	if (es_map_get(&x->by_id, m->id) == m) es_map_del(&x->by_id, m->id);
	x->all[m->at] = x->all[--x->nall];
	x->all[m->at]->at = m->at;
	if (m->c != NULL) {
		pm_set(&x->ids, m->c, m->id_value);
		sc_release(m->c);
	} else {
		op_free(m->id_value);
	}
	for (size_t i = 0; i < m->npath; i++) free(m->path[i]);
	free(m->path);
	free(m->key);
	free(m->id);
	free(m);
}

static void release(made *m) {
	if (--m->holds == 0) free_made(m);
}

void es_computers_free(struct es_computers *x) {
	if (x == NULL) return;
	if (x->after != NULL) sc_remove_listener(x->after);
	if (x->freed != NULL) sc_remove_listener(x->freed);
	for (size_t i = 0; i < x->nbridges; i++) {
		sc_promise_free(x->bridges[i]->sp);
		free(x->bridges[i]->id);
		free(x->bridges[i]);
	}
	free(x->bridges);
	for (size_t i = 0; i < x->bins.cap; i++) {
		if (x->bins.keys[i] == NULL) continue;
		bin *b = x->bins.vals[i];
		for (size_t k = 0; k < b->n; k++) b->v[k]->binned = 0;
		free(b->v);
		free(b);
	}
	pm_clear(&x->bins);
	while (x->nall > 0) {
		made *m = x->all[x->nall - 1];
		m->holds = 1;
		release(m);
	}
	for (size_t i = 0; i < x->ids.cap; i++)
		if (x->ids.keys[i] != NULL) op_free(x->ids.vals[i]);
	pm_clear(&x->ids);
	free(x->all);
	es_map_free(&x->by_id);
	free(x);
}

static es_map *named_of(es_context *c, int create) {
	if (c->named == NULL && create) c->named = es_alloc(sizeof(es_map));
	return c->named;
}

void es_computer_forget(es_context *c) {
	es_map *named = c->named;
	if (named == NULL) return;
	for (size_t i = 0; i < named->n; i++) {
		madelist *l = named->vals[i];
		for (size_t j = 0; j < l->n; j++) l->v[j]->cx = NULL;
		free(l->v);
		free(l);
	}
	es_map_free(named);
	free(named);
	c->named = NULL;
}



static made *made_at(es_context *c, const char *key, sc_scope *own) {
	es_map *named = named_of(c, 0);
	madelist *l = named == NULL ? NULL : es_map_get(named, key);
	for (size_t i = 0; l != NULL && i < l->n; i++) {
		made *m = l->v[i];
		if (m->own == own && m->c != NULL && sc_scope_alive(m->c)) return m;
	}
	return NULL;
}

static void named_add(made *m) {
	es_map *named = named_of(m->cx, 1);
	madelist *l = es_map_get(named, m->key);
	if (l == NULL) {
		l = es_alloc(sizeof *l);
		es_map_set(named, m->key, l);
	}
	ES_PUSH(l->v, l->n, l->cap, m);
}

static void named_del(made *m) {
	if (m->cx == NULL || m->cx->named == NULL) return;
	es_map *named = m->cx->named;
	madelist *l = es_map_get(named, m->key);
	if (l == NULL) return;
	for (size_t i = 0; i < l->n; i++) {
		if (l->v[i] != m) continue;
		memmove(l->v + i, l->v + i + 1, (l->n - i - 1) * sizeof *l->v);
		l->n--;
		break;
	}
	if (l->n == 0) {
		es_map_del(named, m->key);
		free(l->v);
		free(l);
	}
}

// what is known ----------

static made *live(es_ermine *e, const char *id) {
	made *m = e->computers == NULL ? NULL : es_map_get(&e->computers->by_id, id);
	return m != NULL && !m->gone ? m : NULL;
}

int es_is_computer(es_ermine *e, const char *id) { return live(e, id) != NULL; }

int es_is_memo(es_ermine *e, const char *id) {
	made *m = live(e, id);
	return m != NULL && m->memo;
}

es_context *es_computer_context(es_ermine *e, const char *id) {
	made *m = live(e, id);
	return m == NULL ? NULL : m->cx;
}

int es_awaiting(es_ermine *e, const char *id) {
	made *m = live(e, id);
	return m != NULL && m->awaiting;
}

// its code running ----------

// a result as the scheduler's equal has it: Object.is, scalars by content, anything else by identity
static bool same_value(const op_value *a, const op_value *b) {
	if (a == b) return true;
	if (a == NULL || b == NULL || a->type != b->type) return false;
	switch (a->type) {
	case OP_NULL: return true;
	case OP_BOOL: return !a->bool_ == !b->bool_;
	case OP_NUM: return op_same_num(a, b) != 0;
	case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
	default: return false;
	}
}

static bool computer_equal(const void *p, const void *q, void *data) {
	made *m = data;
	if (m->equal != NULL) return m->equal(m->equal_ctx, p, q) != 0;
	return same_value(p, q);
}

static void settled(void *ctx, int ok, const op_value *value, const char *error) {
	bridge *b = ctx;
	made *m = es_map_get(&b->x->by_id, b->id);
	if (m != NULL && m->awaiting_for == b) m->awaiting = 0;
	b->settled = 1;
	if (ok) sc_resolve(b->sp, op_ref((op_value *)value));
	else sc_reject(b->sp, es_dup(error != NULL ? error : "error"));
}

// m's code run, giving what the scheduler expects. A promise marks the node awaiting until it
// settles; PENDING and a failure leave that as it was.
static sc_out ran(made *m, es_out r);

typedef struct {
	made *m;
	bridge *b;
	es_step step;
} paused;

static void paused_quit(void *data) {
	paused *k = data;
	k->step.quit(k->step.ctx);
	free(k);
}

static sc_out paused_next(void *data, bool ok, void *value, char *error) {
	paused *k = data;
	made *m = k->m;
	if (m->awaiting_for == k->b) {
		m->awaiting = 0;
		m->pausing = 0;
	}
	es_step step = k->step;
	free(k);
	if (m->cx == NULL) {
		step.quit(step.ctx);
		op_free(value);
		free(error);
		return (sc_out){.kind = SC_FAILED, .error = es_dup("closed")};
	}
	return ran(m, step.next(m->cx, step.ctx, ok, value, error));
}

static sc_out ran(made *m, es_out r) {
	if (r.kind == ES_OUT_PENDING) return (sc_out){.kind = SC_PENDING};
	if (r.kind == ES_OUT_PAUSE) {
		es_promise *p = es_promise_of(m->x->e, r.value);
		if (p == NULL) {
			return ran(m, r.step.next(m->cx, r.step.ctx, 1, r.value, NULL));
		}
		op_free(r.value);
		struct es_computers *x = m->x;
		bridge *b = es_alloc(sizeof *b);
		b->x = x;
		b->id = es_dup(m->id);
		b->sp = sc_promise_new(x->e->scheduler);
		ES_PUSH(x->bridges, x->nbridges, x->capbridges, b);
		m->awaiting = 1;
		m->awaiting_for = b;
		m->pausing = 1;
		paused *k = es_alloc(sizeof *k);
		k->m = m;
		k->b = b;
		k->step = r.step;
		es_promise_then(p, settled, b);
		return (sc_out){.kind = SC_PAUSE, .promise = b->sp, .step = {paused_next, paused_quit, k}};
	}
	if (r.kind == ES_OUT_FAILED) {
		return (sc_out){.kind = SC_FAILED, .error = r.error != NULL ? r.error : es_dup("error")};
	}
	es_promise *p = es_promise_of(m->x->e, r.value);
	if (p == NULL) {
		m->awaiting = 0;
		m->awaiting_for = NULL;
		m->pausing = 0;
		return (sc_out){.kind = SC_VALUE, .value = r.value};
	}
	op_free(r.value);
	struct es_computers *x = m->x;
	bridge *b = es_alloc(sizeof *b);
	b->x = x;
	b->id = es_dup(m->id);
	b->sp = sc_promise_new(x->e->scheduler);
	ES_PUSH(x->bridges, x->nbridges, x->capbridges, b);
	m->awaiting = 1;
	m->awaiting_for = b;
	es_promise_then(p, settled, b);
	return (sc_out){.kind = SC_AWAIT, .promise = b->sp};
}

static sc_out computer_f(void *previous, void *data) {
	made *m = data;
	es_ermine *e = m->x->e;
	if (m->cx == NULL) return (sc_out){.kind = SC_FAILED, .error = es_dup("closed")};
	if (m->pausing) m->awaiting = m->pausing = 0;
	if (m->early && !m->given) {
		m->given = 1;
		sc_computer *self = sc_run_computer(sc_get_run(e->scheduler));
		cst_give(e->statuses, self, tb_string(m->id));
		if (e->runs != NULL) crn_give(e->runs, self, tb_string(m->id));
	}
	return ran(m, m->f(m->cx, m->ctx, previous));
}

static char *failure(int code) {
	const es_error *t = es_thrown();
	return es_dup(t->message != NULL ? t->message : es_code_name(code));
}

static char *write_value(made *m, const op_value *v) {
	es_ermine *e = m->x->e;
	if (m->cx == NULL) return NULL;
	if (v == NULL && tb_get(e->table, tb_string("value"), tb_string(m->id)) == NULL) return NULL;
	op_patch whole = {0};
	if (v != NULL) {
		whole.has_value = 1;
		whole.value = v;
	}
	es_write w = {.part = "value", .id = m->id, .patches = &whole, .npatches = 1};
	int code = es_context_put(m->cx, &w);
	return code ? failure(code) : NULL;
}

static char *computer_set(void *value, void *data) { return write_value(data, value); }

static char *computer_act(void *value, void *previous, void *data) {
	made *m = data;
	char *bad = write_value(m, value);
	if (bad != NULL) return bad;
	if (m->act == NULL || m->cx == NULL) return NULL;
	struct es_computers *x = m->x;
	sc_scope *was = x->acting;
	x->acting = sc_get_current_scope(x->e->scheduler);
	int code = m->act(m->cx, m->ctx, value, previous);
	x->acting = was;
	return code ? failure(code) : NULL;
}

int es_inside_only(es_context *c, const es_names *path, const char *fn) {
	int inside = path->n > c->nat;
	for (size_t i = 0; inside && i < c->nat; i++) inside = strcmp(path->names[i], c->at[i]) == 0;
	if (inside) return 0;
	char *at = es_join(CP(path->names), path->n);
	int code = es_fail_ermine(ES_OUTSIDE, "%s(\"/%s\"): made outside its maker, it would outlive it", fn, at);
	free(at);
	return code;
}

sc_scope *es_acting(es_ermine *e) { return e->computers == NULL ? NULL : e->computers->acting; }

int es_not_in_act(es_ermine *e, sc_scope *own, const char *fn) {
	if (own == NULL || es_acting(e) != own) return 0;
	if (strcmp(fn, "addTeardown") == 0) {
		return es_fail_ermine(ES_IN_ACT,
			"addTeardown in an effect's act: return a cleanup function from the act instead");
	}
	return es_fail_ermine(ES_IN_ACT, "%s in an effect's act: an act makes nothing", fn);
}

// its node and name gone ----------

// m's name taken out of its folder, if it is still m's there, and every part of its node out of the table
static char *drop(made *m) {
	struct es_computers *x = m->x;
	es_ermine *e = x->e;
	char *bad = NULL;
	named_del(m);
	es_missing_drop(e, m->id);
	if (es_map_get(&x->by_id, m->id) == m) es_map_del(&x->by_id, m->id);
	es_context *c = m->cx;
	if (c != NULL) bad = es_unplace_names(c, m->id);
	if (c != NULL) {
		size_t n = 0;
		const tb_entry *at = tb_at(e->table, tb_string(m->id), &n);
		char **parts = es_alloc((n + 1) * sizeof *parts);
		size_t np = 0;
		for (size_t i = 0; i < n; i++) {
			if (at[i].part.string != NULL) parts[np++] = es_dup(at[i].part.string);
		}
		for (size_t i = 0; i < np; i++) {
			es_write w = {.part = parts[i], .id = m->id, .gone = 1};
			int code = es_context_put(c, &w);
			if (code && code != ES_CLOSED && bad == NULL) bad = failure(code);
			free(parts[i]);
		}
		free(parts);
	}
	if (e->runs != NULL) crn_drop(e->runs, tb_string(m->id));
	es_held_drop(e, m->id);
	return bad;
}

static char *settle(made *m) {
	if (!(m->c != NULL && sc_scope_alive(m->c)) && !m->gone) {
		m->gone = 1;
		return drop(m);
	}
	return NULL;
}

static void bin_leave(made *m) {
	if (!m->binned) return;
	bin *b = pm_get(&m->x->bins, m->own);
	m->binned = 0;
	if (b == NULL) return;
	for (size_t i = 0; i < b->n; i++) {
		if (b->v[i] != m) continue;
		memmove(b->v + i, b->v + i + 1, (b->n - i - 1) * sizeof *b->v);
		b->n--;
		return;
	}
}

static char *bin_run(void *data) {
	bin *b = data;
	b->armed = 0;
	char *bad = NULL;
	int alive = sc_scope_alive(b->own);
	for (size_t i = b->n; i-- > 0;) {
		made *m = b->v[i];
		char *err = settle(m);
		if (err != NULL && bad == NULL) bad = err;
		else free(err);
		if (m->gone || !alive) {
			m->binned = 0;
			memmove(b->v + i, b->v + i + 1, (b->n - i - 1) * sizeof *b->v);
			b->n--;
			release(m);
		}
	}
	if (alive) {
		if (b->n > 0) {
			b->armed = 1;
			free(sc_register_teardown(b->x->e->scheduler, b->own, bin_run, b));
		}
	} else {
		pm_delete(&b->x->bins, b->own);
		free(b->v);
		free(b);
	}
	return bad;
}

// m's scope torn down now, its teardowns told "ended", its node and name gone (asked by remove and
// unplace). The maker's process lives on, so they are not told "replaced".
void es_stop_computer(es_ermine *e, const char *id) {
	made *m = live(e, id);
	if (m == NULL) return;
	if (m->c != NULL && sc_scope_alive(m->c)) {
		const char *key = m->cx != NULL ? m->cx->node : NULL;
		char *had = key != NULL ? (char *)es_why_of(e, key) : NULL;
		if (key != NULL) es_map_set(&e->whys, key, (void *)"ended");
		free(sc_teardown(m->c));
		if (key != NULL) {
			if (had != NULL) es_map_set(&e->whys, key, had);
			else es_map_del(&e->whys, key);
		}
	}
	if (!m->gone) {
		m->gone = 1;
		free(drop(m));
	}
	if (m->binned) {
		bin_leave(m);
		release(m);
	}
}

static void hold(made *m) {
	struct es_computers *x = m->x;
	bin *b = pm_get(&x->bins, m->own);
	if (b == NULL) {
		b = es_alloc(sizeof *b);
		*b = (bin){.x = x, .own = m->own};
		pm_set(&x->bins, m->own, b);
	}
	if (!m->binned) {
		m->binned = 1;
		m->holds++;
		ES_PUSH(b->v, b->n, b->cap, m);
	}
	if (!b->armed) {
		b->armed = 1;
		free(sc_register_teardown(x->e->scheduler, m->own, bin_run, b));
	}
}

// making one ----------

static const op_value *node_above(const ch_frame *o) {
	for (; o != NULL; o = o->parent) {
		const op_value *v = ch_frame_get(o, CH_NODE);
		if (v != NULL) return v->type == OP_STR ? v : NULL;
	}
	return NULL;
}

typedef struct {
	es_context *c;
	char *const *path;
	size_t npath;
	const char *id;
	const op_value *above;
} placing;

// a computer's node placed at its path, its scope written (own's CH_NODE id, or the nearest above)
static int place_node(void *data) {
	placing *p = data;
	es_context *c = p->c;
	if (p->npath == 0) return es_fail(ES_NOT_A_NAME, "not-a-name (/)");
	tb_key parent = {0};
	bool found = true;
	if (p->npath == 1) parent = pl_root(c->places);
	else found = pl_get(c->places, (const char *const *)p->path, p->npath - 1, &parent) != 0;
	if (!found) {
		char *at = es_join(CP(p->path), p->npath);
		int code = es_fail(ES_NOTHING_THERE, "nothing-there (%s)", at);
		free(at);
		return code;
	}
	int code = es_place_under(c, parent.string, p->path[p->npath - 1], p->id,
		(const char *const *)p->path, p->npath);
	if (code || p->above == NULL) return code;
	op_key step = {.type = OP_STR_KEY, .s = ES_SCOPE};
	op_patch scope = {.place = {.path = &step, .length = 1}, .has_value = 1, .value = p->above};
	es_write w = {.part = "attributes", .id = p->id, .patches = &scope, .npatches = 1};
	return es_context_put(c, &w);
}

typedef struct {
	made *m;
	sc_def def;
	int effect;
	op_value *locations;
} creating;

static void create_in(void *data) {
	creating *k = data;
	made *m = k->m;
	es_ermine *e = m->x->e;
	sc_pair info[2] = {{CH_NODE, m->id_value}};
	size_t n = 1;
	if (k->locations != NULL) info[n++] = (sc_pair){CH_LOCATIONS, k->locations};
	m->c = k->effect ? sc_create_effect(e->scheduler, k->def, info, n)
	                 : sc_create_computer(e->scheduler, k->def, info, n);
}

static void set_code(made *m, es_compute f, es_act act, void *ctx, const es_computed_options *o) {
	m->f = f;
	m->act = act;
	m->ctx = ctx;
	m->equal = o != NULL ? o->equal : NULL;
	m->equal_ctx = o != NULL ? o->equal_ctx : NULL;
}

// made again the same: C's code has no text and what ctx holds is not read, so the claim is not
// due
static int same_code(const made *m, es_compute f, es_act act, const es_computed_options *o) {
	return m->f == f && m->act == act && m->equal == (o != NULL ? o->equal : NULL);
}

static int create(es_context *c, int memo, es_names *path, char **key, es_compute f, es_act act,
	void *ctx, const es_computed_options *o, es_node_data *nd, es_handle **out, const ch_location *site) {
	es_ermine *e = c->ermine;
	struct es_computers *x = e->computers;
	sc_scope *own = es_owner(c);
	(void)site;
	char *id = es_new_id(e);
	placing p = {c, path->names, path->n, id, node_above(sc_scope_frame(own))};
	int code = es_inside(c, place_node, &p);
	if (code) {
		free(id);
		return code;
	}
	made *m = es_alloc(sizeof *m);
	m->x = x;
	m->cx = c;
	m->own = own;
	m->id = id;
	m->id_value = op_str(id);
	m->npath = path->n;
	m->path = es_alloc((path->n + 1) * sizeof *m->path);
	for (size_t i = 0; i < path->n; i++) m->path[i] = es_dup(path->names[i]);
	m->key = *key;
	*key = NULL;
	m->memo = memo;
	m->early = !memo && o != NULL && o->early;
	set_code(m, f, act, ctx, o);
	m->at = x->nall;
	ES_PUSH(x->all, x->nall, x->capall, m);
	es_map_set(&x->by_id, id, m);
	named_add(m);
	m->holds = 1;
	hold(m);
	es_calls_made(e, memo ? "memo" : m->early ? "early" : "effect", id, (const char *const *)m->path,
		m->npath);
	creating k = {.m = m, .effect = !memo};
	es_outside(e, &k.locations);
	k.def = (sc_def){.f = computer_f, .equal = computer_equal, .data = m, .early = m->early};
	if (memo) k.def.set = computer_set;
	else k.def.effect = computer_act;
	const char *bad = sc_run_with_scope(own, create_in, &k);
	op_free(k.locations);
	if (bad != NULL || m->c == NULL) {
		code = es_fail(ES_FAILED, "%s", bad != NULL ? bad : SC_UNSCOPED);
		release(m);
		return code;
	}
	cst_give(e->statuses, m->c, tb_string(id));
	if (e->runs != NULL) crn_give(e->runs, m->c, tb_string(id));
	if (e->on_create_function != NULL) {
		es_created made = {.kind = memo ? "memo" : "effect", .computer = m->c, .node = nd, .id = id,
			.process = c->node};
		e->on_create_function(e->on_create_function_ctx, &made);
	}
	es_queue_pulse(e);
	if (out != NULL) *out = es_handle_make(c, nd);
	release(m);
	return 0;
}

static int make(es_context *c, int memo, es_at name, es_compute f, es_act act, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_location *site) {
	es_ermine *e = c->ermine;
	sc_scope *own = es_owner(c);
	int code = es_not_in_act(e, own, memo ? "createMemo" : "createEffect");
	if (code) return code;
	es_names path = {0};
	code = es_resolve(c, name, &path);
	if (code) return code;
	code = es_inside_only(c, &path, memo ? "createMemo" : "createEffect");
	if (code) {
		es_names_free(&path);
		return code;
	}
	char *key = es_path_key(CP(path.names), path.n);
	es_node_data nd = {.has_path = 1, .path = path.names, .npath = path.n, .part = (char *)"value"};
	made *m = made_at(c, key, own);
	if (m == NULL) {
		code = create(c, memo, &path, &key, f, act, ctx, o, &nd, out, site);
	} else if (!(same_code(m, f, act, o) ? sc_claim_same(m->c) : sc_claim(m->c))) {
		// made at this path under own before: claimed and given the new code (a parent's rerun does not
		// destroy its children). As own's run starts what its earlier runs made is old; one not old was
		// made in this run, or own has had no run since: already there
		char *at = es_join(CP(path.names), path.n);
		code = es_fail(ES_ALREADY_THERE, "already-there (%s)", at);
		free(at);
	} else {
		set_code(m, f, act, ctx, o);
		hold(m);
		es_queue_pulse(e);
		if (out != NULL) *out = es_handle_make(c, &nd);
	}
	free(key);
	es_names_free(&path);
	return code;
}

int es_create_memo_at(es_context *c, es_at name, es_compute f, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_location *site) {
	const ch_location *was = es_enter(c->ermine, site);
	int code = make(c, 1, name, f, NULL, ctx, o, out, site);
	es_enter(c->ermine, was);
	return code;
}

int es_create_effect_at(es_context *c, es_at name, es_compute f, es_act act, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_location *site) {
	const ch_location *was = es_enter(c->ermine, site);
	int code = make(c, 0, name, f, act, ctx, o, out, site);
	es_enter(c->ermine, was);
	return code;
}

// status ----------

static void free_waiting(es_waiting *w, size_t n) {
	for (size_t i = 0; i < n; i++) {
		for (size_t j = 0; j < w[i].npath; j++) free(w[i].path[j]);
		free(w[i].path);
	}
	free(w);
}

void es_status_free(es_status *s) {
	if (s == NULL) return;
	free(s->held_feature);
	free(s->error);
	free_waiting(s->waiting, s->nwaiting);
	op_free(s->more);
	*s = (es_status){0};
}

static void release_unshared(es_status *st, const es_status *shown) {
	if (st->held_feature != shown->held_feature) free(st->held_feature);
	if (st->error != shown->error) free(st->error);
	if (st->waiting != shown->waiting) free_waiting(st->waiting, st->nwaiting);
	if (st->more != shown->more) op_free(st->more);
}

static int ask_status(es_context *t, const char *id, const es_node_data *n) {
	if (!t->guarded) return 0;
	op_value *field = op_list();
	op_push(field, op_str(CST_ATTRIBUTE));
	gd_thing thing = es_thing_of(id, n);
	gd_target target = gd_target_of(thing, CST_TABLE, field);
	gd_refusal why = {0};
	gd_answer a = gd_read(t->guard, &target, 1, &why);
	int code = 0;
	if (a == GD_REFUSED) code = es_fail_refusal(&why, NULL, NULL);
	else if (a == GD_PENDING) code = es_fail(ES_PENDING, "PENDING");
	else if (a == GD_FAILED) code = ES_STOP;
	op_free(field);
	return code;
}

static const op_value *status_field(pl *places, const char *id, const char *field) {
	op_key key = {.type = OP_STR_KEY, .s = field};
	return pl_read(places, tb_string(CST_TABLE), tb_string(id), &key, 1);
}

static char *error_text(const op_value *v) {
	const char *m = cst_error(v);
	if (m != NULL) return es_dup(m);
	if (v != NULL && v->type == OP_STR) return es_dup(v->str);
	return es_dup("error");
}

static void waiting_path_of(es_waiting *w, const char *const *path, size_t n) {
	w->has_path = 1;
	w->npath = n;
	w->path = es_alloc((n + 1) * sizeof *w->path);
	for (size_t i = 0; i < n; i++) w->path[i] = es_dup(path[i]);
}
static void waiting_path(es_waiting *w, int found, es_names *names) {
	if (!found) return;
	waiting_path_of(w, (const char *const *)names->names, names->n);
	es_names_free(names);
}

static int other_world(es_context *c, const char *owner) {
	es_context *o = es_computer_context(c->ermine, owner);
	if (o == NULL) o = es_process_context_of(c->ermine, owner);
	return o != NULL && strcmp(pl_root(o->places).string, pl_root(c->places).string) != 0;
}

static void wait_of(es_context *c, const char *owner, const es_wait *w, es_waiting *out) {
	es_names names = {0};
	*out = (es_waiting){.kind = ES_WAIT_SEND, .since = w->since};
	if (w->has_path) {
		if (!other_world(c, owner)) waiting_path_of(out, (const char *const *)w->path, w->npath);
	}
	else waiting_path(out, es_seen_in(c->ermine, c, w->id, &names), &names);
}

static int list_names(const op_value *list, char ***out, size_t *n) {
	if (list == NULL || list->type != OP_LIST) return 0;
	char **names = es_alloc((list->count + 1) * sizeof *names);
	for (size_t i = 0; i < list->count; i++) {
		const op_value *s = list->items[i];
		names[i] = es_dup(s != NULL && s->type == OP_STR ? s->str : "");
	}
	*out = names;
	*n = list->count;
	return 1;
}

static void said_of(es_context *c, const char *owner, const op_value *w, es_waiting *out) {
	*out = (es_waiting){.kind = ES_WAIT_PENDING};
	if (w == NULL) return;
	if (w->type == OP_STR) {
		if (strcmp(w->str, "a promise") == 0) out->kind = ES_WAIT_PROMISE;
		return;
	}
	if (w->type != OP_MAP) return;
	const op_value *send = op_get(w, "send"), *code = op_get(w, "code"), *node = op_get(w, "node");
	const op_value *missing = op_get(w, "missing");
	if (send != NULL) {
		const op_value *since = op_get(w, "since");
		es_wait wait = {0};
		if (since != NULL) op_as_double(since, &wait.since);
		if (send->type == OP_LIST) wait.has_path = list_names(send, &wait.path, &wait.npath);
		else if (send->type == OP_STR) wait.id = send->str;
		wait_of(c, owner, &wait, out);
		if (wait.has_path) {
			for (size_t i = 0; i < wait.npath; i++) free(wait.path[i]);
			free(wait.path);
		}
	} else if (code != NULL) {
		out->kind = ES_WAIT_CODE;
		out->has_path = list_names(code, &out->path, &out->npath);
	} else if (node != NULL) {
		out->kind = ES_WAIT_NODE;
		out->has_path = list_names(node, &out->path, &out->npath);
	} else if (missing != NULL) {
		out->kind = ES_WAIT_NODE;
		char **abs;
		size_t nabs;
		if (list_names(missing, &abs, &nabs)) {
			if (!other_world(c, owner)) waiting_path_of(out, (const char *const *)abs, nabs);
			for (size_t i = 0; i < nabs; i++) free(abs[i]);
			free(abs);
		}
	}
}

typedef struct {
	pl *places;
	const char *id;
	int pending;
} peeking;

static void peek(void *ctx) {
	peeking *p = ctx;
	p->pending = cst_pending(p->places, tb_string(p->id));
}

static int plain_status(es_context *c, const char *id, const op_value *v, es_status *st) {
	es_ermine *e = c->ermine;
	if (v == NULL) {
		st->state = "done";
		return 0;
	}
	if (!cst_is_pending(v)) {
		st->state = "failed";
		st->error = error_text(v);
		return 0;
	}
	const op_value *said = status_field(c->places, id, ES_WAITING);
	if (pl_status(c->places) == SC_STOP) return ES_STOP;
	st->state = "pending";
	if (said != NULL && said->type == OP_LIST && said->count > 0) {
		st->waiting = es_alloc(said->count * sizeof *st->waiting);
		for (size_t i = 0; i < said->count; i++) said_of(c, id, said->items[i], &st->waiting[i]);
		st->nwaiting = said->count;
		return 0;
	}
	size_t n = 0;
	es_wait *waits = es_calls_waits(e, id, &n);
	st->waiting = es_alloc((n + 1) * sizeof *st->waiting);
	for (size_t i = 0; i < n; i++) wait_of(c, id, &waits[i], &st->waiting[i]);
	st->nwaiting = n;
	es_waits_free(waits, n);
	if (st->nwaiting == 0) st->waiting[st->nwaiting++] = (es_waiting){.kind = ES_WAIT_PENDING};
	return 0;
}

// whether key wants field k (key NULL: every field)
static int wants(const char *key, const char *k) { return key == NULL || strcmp(key, k) == 0; }

static int run_field(es_ermine *e, const char *id, crn_field field, const crn_run **r) {
	if (e->runs == NULL) return 0;
	return crn_read(e->runs, NULL, NULL, tb_string(id), field, r, NULL, NULL);
}

// key: the field wanted (NULL: all). The run record is read field by field, only what the field
// takes (n for n, end for state and phase, act for phase, reads for waiting), so a reader of state
// is not rerun at every run
static int computer_status(es_context *c, const char *id, const op_value *v, const char *key,
	es_status *st) {
	es_ermine *e = c->ermine;
	const crn_run *r = NULL;
	if (wants(key, "n") || wants(key, "waiting")) {
		if (run_field(e, id, CRN_N, &r) == CRN_STOP) return ES_STOP;
		if (r != NULL) {
			st->has_n = 1;
			st->n = r->n;
		}
	}
	if (v == NULL) {
		st->state = "done";
		return 0;
	}
	if (!cst_is_pending(v)) {
		st->error = error_text(v);
		st->state = "failed";
		if (!wants(key, "state") && !wants(key, "phase")) return 0;
		if (run_field(e, id, CRN_END, &r) == CRN_STOP) return ES_STOP;
		if (r != NULL && strcmp(r->end, "looping") == 0) {
			st->state = "looping";
			return 0;
		}
		if (!wants(key, "phase")) return 0;
		if (run_field(e, id, CRN_ACT, &r) == CRN_STOP) return ES_STOP;
		st->phase = r != NULL && strcmp(r->end, "failed") != 0 && r->act == CRN_ACT_FAILED ? "act" : "run";
		return 0;
	}
	st->state = "pending";
	if (!wants(key, "waiting")) return 0;
	if (run_field(e, id, CRN_READS, &r) == CRN_STOP) return ES_STOP;
	es_waiting *waiting = NULL;
	size_t nwaiting = 0, cap = 0;
	for (size_t i = 0; r != NULL && r->reads != NULL && i < r->reads->n; i++) {
		const crn_saw *w = &r->reads->items[i];
		if (!w->named || w->part == NULL || w->id == NULL || w->spot || w->keys) continue;
		if (strcmp(w->part, CST_TABLE) != 0 || strcmp(w->id, id) == 0) continue;
		if (w->npath != 1 || w->path[0].type != OP_STR_KEY ||
			strcmp(w->path[0].s, CST_ATTRIBUTE) != 0) {
			continue;
		}
		peeking p = {c->places, w->id, 0};
		pl_peep(c->places, peek, &p);
		if (!p.pending) continue;
		es_names names = {0};
		es_waiting item = {.kind = ES_WAIT_NODE};
		waiting_path(&item, es_seen_in(e, c, w->id, &names), &names);
		ES_PUSH(waiting, nwaiting, cap, item);
	}
	size_t n = 0;
	es_wait *waits = es_calls_waits(e, id, &n);
	for (size_t i = 0; i < n; i++) {
		es_waiting item;
		wait_of(c, id, &waits[i], &item);
		ES_PUSH(waiting, nwaiting, cap, item);
	}
	es_waits_free(waits, n);
	const es_missing *missing = es_missing_of(e, id);
	if (missing != NULL && r != NULL && missing->has_n && missing->n == r->n) {
		for (size_t i = 0; i < missing->npaths; i++) {
			es_waiting item = {.kind = ES_WAIT_NODE};
			if (!other_world(c, id)) {
				waiting_path_of(&item, (const char *const *)missing->paths[i].names, missing->paths[i].n);
			}
			ES_PUSH(waiting, nwaiting, cap, item);
		}
	}
	if (es_awaiting(e, id)) {
		es_waiting item = {.kind = ES_WAIT_PROMISE};
		ES_PUSH(waiting, nwaiting, cap, item);
	}
	if (nwaiting == 0) {
		es_waiting item = {.kind = ES_WAIT_PENDING};
		ES_PUSH(waiting, nwaiting, cap, item);
	}
	st->waiting = waiting;
	st->nwaiting = nwaiting;
	return 0;
}

static int own_status(es_context *c, const es_node_data *n, const char *id, const char *key,
	es_status *st) {
	es_ermine *e = c->ermine;
	int code = ask_status(c, id, n);
	if (code) return code;
	const op_value *v = cst_status(c->places, tb_string(id));
	if (pl_status(c->places) == SC_STOP) return ES_STOP;
	es_held h;
	if (es_held_status(e, id, &h) || es_held_row(e, id, &h)) {
		st->has_held = 1;
		st->held_feature = es_dup(h.feature);
		st->held_write = h.write;
	}
	if (!es_is_computer(e, id)) return plain_status(c, id, v, st);
	return computer_status(c, id, v, key, st);
}

int es_get_status(es_context *c, es_target x, es_status *out) { return es_get_status_of(c, x, NULL, out); }

int es_get_status_of(es_context *c, es_target x, const char *key, es_status *out) {
	*out = (es_status){0};
	es_node_data n = {0};
	int code = es_node_of(c, x, &n);
	if (code) return code;
	const char *at;
	if (!es_id_of(c, &n, &at)) {
		es_node_data_free(&n);
		return 0;
	}
	char *id = es_dup(at);
	es_status st = {0};
	code = own_status(c, &n, id, key, &st);
	if (code == 0) {
		es_asked asked = {&n, id};
		es_status shown = {0};
		code = es_hook_status(c->ermine, &asked, &st, &shown);
		if (code == 0) {
			release_unshared(&st, &shown);
			*out = shown;
		} else es_status_free(&st);
	} else es_status_free(&st);
	free(id);
	es_node_data_free(&n);
	return code;
}

int es_latest_run(es_ermine *e, const char *id, const crn_run **out) {
	*out = NULL;
	if (e->runs == NULL ||
		crn_read(e->runs, NULL, NULL, tb_string(id), CRN_ALL, out, NULL, NULL) != 0) {
		*out = NULL;
	}
	return *out != NULL;
}
