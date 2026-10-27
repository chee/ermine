// computers (system.ts' createMemo, createEffect, getStatus), in C: memos, effects, their nodes and
// names, status, runs. B's job, function by function (ermine.h says each):
//   state: es_computers_new, es_computers_free, es_computer_forget (the memos, computers, contexts and
//     awaiting sets; each context's names for what its owners' runs made)
//   computers: es_create_memo_at, es_create_effect_at ({ early }). the node placed at its name, its
//     scope written (ES_SCOPE); made again by its owner's next run: claimed (sc_claim), new code; a name
//     not made again goes after the run with its node, status and run; a second at a name in one run:
//     ES_ALREADY_THERE. status given (cst_give) and runs (crn_give); onCreateFunction told; a promise
//     given ends the run pending (the computer awaiting till it settles)
//   known: es_is_computer, es_is_memo, es_computer_context, es_awaiting
//   status: es_get_status, es_status_free (ownStatus: done, failed, looping, pending and what it waits
//     on; held; then onStatus), es_latest_run
//
// what B asks of the others (the header says each): A's es_resolve, es_inside, es_owner,
// es_place_under, es_folder_slot, es_context_put, es_node_of, es_id_of, es_seen_in,
// es_handle_make; C's es_calls_made, es_calls_waits; D's es_new_id, es_queue_pulse,
// es_enter, es_hook_status, es_held_*, es_promise_*. es_hook_status gives a status of its own
// (es_status_free); one that shares the base's pieces is fine. es_computers_free runs while the
// scheduler is still there (it lets go of the promises it made).
#include "ermine.h"

#include <stdbool.h>
#include <stdio.h>

typedef struct made made;
typedef struct bridge bridge;

// a promise a compute gave, as the scheduler's: settled as the program's promise settles. let go of
// once the pulse is over (the scheduler's run may not have taken it yet), or at close
struct bridge {
	struct es_computers *x;
	sc_promise *sp;
	// the node whose awaiting it ends
	char *id;
	int settled;
};

// a memo or effect made (Made): its code, in place (a run of its owner making it again gives it
// new code). holds: the creating call, and each cleanup on its owner still to come; it is let go of
// with the last
struct made {
	struct es_computers *x;
	// the context that made it (NULL once that is let go of)
	es_context *cx;
	sc_scope *own;
	sc_computer *c;
	char *id;
	// its id as its PL_NODE pair's value: alive as long as the scheduler's scope is
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
	int has_site;
	ch_site site;
	unsigned holds;
	int gone, given, awaiting;
	// its place in x->all
	size_t at;
};

// what is made at one path of a context (its names), in the order made
typedef struct {
	made **v;
	size_t n, cap;
} madelist;

struct es_computers {
	es_ermine *e;
	// every one made and not gone, by its node's id
	es_map by_id;
	// every one not let go of yet
	made **all;
	size_t nall, capall;
	// the id values computers were made with, by the computer, once its made is let go of: the
	// scheduler borrows its info, so each goes as its computer is freed
	pm ids;
	bridge **bridges;
	size_t nbridges, capbridges;
	sc_listener *after, *freed;
	// the scope an effect's act is running in now (an act makes nothing)
	sc_scope *acting;
};

// state ----------------------------------------------------------------------------------------------

// the settled promises' bridges let go of: a pulse is over, so the scheduler has taken what it will
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

// a computer freed: the id value its info borrowed goes
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

static void free_made(made *m) {
	struct es_computers *x = m->x;
	// a context let go of after this (close) must not find it
	named_del(m);
	if (es_map_get(&x->by_id, m->id) == m) es_map_del(&x->by_id, m->id);
	x->all[m->at] = x->all[--x->nall];
	x->all[m->at]->at = m->at;
	// its computer let go (the maker's hold), its id value kept till that is freed
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
	while (x->nall > 0) {
		made *m = x->all[x->nall - 1];
		m->holds = 1;
		release(m);
	}
	// what is left is the scheduler's still, freed with it (no info is read after)
	for (size_t i = 0; i < x->ids.cap; i++)
		if (x->ids.keys[i] != NULL) op_free(x->ids.vals[i]);
	pm_clear(&x->ids);
	free(x->all);
	es_map_free(&x->by_id);
	free(x);
}

// the names a context's owners' runs made, by their path
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

// a path as one string, for a message
static char *join(char *const *path, size_t n) {
	size_t len = 1;
	for (size_t i = 0; i < n; i++) len += strlen(path[i]) + 1;
	char *s = es_alloc(len), *p = s;
	for (size_t i = 0; i < n; i++) {
		if (i > 0) *p++ = '/';
		size_t k = strlen(path[i]);
		memcpy(p, path[i], k);
		p += k;
	}
	return s;
}

// a path as a key that two paths share only if they are the same: each name by its length
static char *key_of(char *const *path, size_t n) {
	size_t len = 1;
	for (size_t i = 0; i < n; i++) len += strlen(path[i]) + 24;
	char *s = es_alloc(len), *p = s;
	for (size_t i = 0; i < n; i++) p += snprintf(p, len - (size_t)(p - s), "%zu:%s", strlen(path[i]), path[i]);
	return s;
}

// the one made at key under own, still alive: the first
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

// what is known ---------------------------------------------------------------------------------------

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

// its code running ---------------------------------------------------------------------------------------

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

// a promise settled: its node no longer awaiting, and the scheduler's told
static void settled(void *ctx, int ok, const op_value *value, const char *error) {
	bridge *b = ctx;
	made *m = es_map_get(&b->x->by_id, b->id);
	if (m != NULL) m->awaiting = 0;
	b->settled = 1;
	if (ok) sc_resolve(b->sp, op_ref((op_value *)value));
	else sc_reject(b->sp, es_dup(error != NULL ? error : "error"));
}

// m's code run: what it gave as the scheduler has it. a promise marks its node awaiting till it
// settles; PENDING and a failure leave that as it was (the reference throws them)
static sc_out ran(made *m, es_out r) {
	if (r.kind == ES_OUT_PENDING) return (sc_out){.kind = SC_PENDING};
	if (r.kind == ES_OUT_FAILED) {
		return (sc_out){.kind = SC_FAILED, .error = r.error != NULL ? r.error : es_dup("error")};
	}
	es_promise *p = es_promise_of(m->x->e, r.value);
	if (p == NULL) {
		m->awaiting = 0;
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
	es_promise_then(p, settled, b);
	return (sc_out){.kind = SC_AWAIT, .promise = b->sp};
}

static sc_out computer_f(void *previous, void *data) {
	made *m = data;
	es_ermine *e = m->x->e;
	if (m->cx == NULL) return (sc_out){.kind = SC_FAILED, .error = es_dup("closed")};
	// an early effect's first run is inside its making: its status and run record are given from here
	if (m->early && !m->given) {
		m->given = 1;
		sc_computer *self = sc_run_computer(sc_get_run(e->scheduler));
		cst_give(e->statuses, self, tb_string(m->id));
		if (e->runs != NULL) crn_give(e->runs, self, tb_string(m->id));
	}
	return ran(m, m->f(m->cx, m->ctx, previous));
}

// the error string a code left, for the scheduler
static char *failure(int code) {
	const es_error *t = es_thrown();
	return es_dup(t->message != NULL ? t->message : es_code_name(code));
}

// the result written to its node, when there is one to say (whole(v))
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
	// an act makes nothing: the scope open is the effect's, and it cleans up with es_cleanup
	struct es_computers *x = m->x;
	sc_scope *was = x->acting;
	x->acting = sc_get_current_scope(x->e->scheduler);
	int code = m->act(m->cx, m->ctx, value, previous);
	x->acting = was;
	return code ? failure(code) : NULL;
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

// its node and name gone ------------------------------------------------------------------------------------

// m's name taken out of its folder, if it is still m's there, and every part of its node out of the table
static char *drop(made *m) {
	struct es_computers *x = m->x;
	es_ermine *e = x->e;
	char *bad = NULL;
	named_del(m);
	es_missing_drop(e, m->id);
	if (es_map_get(&x->by_id, m->id) == m) es_map_del(&x->by_id, m->id);
	es_context *c = m->cx;
	if (c != NULL && m->npath > 0) {
		nd_entry *children;
		const char *last;
		int code = es_folder_slot(c, (const char *const *)m->path, m->npath, &children, &last);
		if (code == 0) {
			const op_value *held = children->value != NULL && children->value->type == OP_MAP
				? op_get(children->value, last)
				: NULL;
			tb_key parent = {0};
			bool ours = held != NULL && held->type == OP_STR && strcmp(held->str, m->id) == 0;
			if (ours && m->npath == 1) parent = pl_root(c->places);
			else if (ours && !pl_get(c->places, (const char *const *)m->path, m->npath - 1, &parent)) {
				ours = false;
			}
			if (ours) {
				op_key step = {.type = OP_STR_KEY, .s = last};
				op_patch out = {.place = {.path = &step, .length = 1}};
				es_write w = {.part = "children", .id = parent.string, .patches = &out, .npatches = 1};
				code = es_context_put(c, &w);
				if (code && code != ES_CLOSED) bad = failure(code);
			}
		}
	}
	if (c != NULL) {
		// every part at the node (the table's scratch is changed by each delete: names copied first)
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

// m's node and name go once its computer has. asked again in each run of its owner that makes it (a
// cleanup of that run, run once the next run is done: it finds the computer claimed, alive, and leaves
// it), and as the owner goes (what is under it first)
static char *cleanup(void *data) {
	made *m = data;
	char *bad = NULL;
	if (!(m->c != NULL && sc_scope_alive(m->c)) && !m->gone) {
		m->gone = 1;
		bad = drop(m);
	}
	release(m);
	return bad;
}

// one more cleanup on its owner, asking after it
static void hold(made *m) {
	m->holds++;
	free(sc_register_teardown(m->x->e->scheduler, m->own, cleanup, m));
}

// making one --------------------------------------------------------------------------------------------------

// the PL_NODE key's id of o or the nearest scope above it with one; NULL: none
static const op_value *node_above(const sc_scope *o) {
	for (; o != NULL; o = sc_scope_parent(o)) {
		const sc_info *info = sc_scope_info(o);
		for (size_t i = 0; info != NULL && i < info->n; i++) {
			if (strcmp(info->pairs[i].key, PL_NODE) != 0) continue;
			const op_value *v = info->pairs[i].value;
			return v != NULL && v->type == OP_STR ? v : NULL;
		}
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

// a computer's node placed at its path, its scope written (own's PL_NODE key, or the nearest above with
// one; none: not written)
static int place_node(void *data) {
	placing *p = data;
	es_context *c = p->c;
	if (p->npath == 0) return es_fail(ES_NOT_A_NAME, "not-a-name (/)");
	tb_key parent = {0};
	bool found = true;
	if (p->npath == 1) parent = pl_root(c->places);
	else found = pl_get(c->places, (const char *const *)p->path, p->npath - 1, &parent) != 0;
	if (!found) {
		char *at = join(p->path, p->npath);
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
} creating;

static void create_in(void *data) {
	creating *k = data;
	made *m = k->m;
	es_ermine *e = m->x->e;
	sc_pair info = {PL_NODE, m->id_value};
	m->c = k->effect ? sc_create_effect(e->scheduler, k->def, &info, 1)
	                 : sc_create_computer(e->scheduler, k->def, &info, 1);
	if (m->c != NULL && e->sites != NULL && m->has_site) {
		st_note(e->sites, m->c, m->site.file, (int)m->site.line, m->site.function);
	}
}

static void set_code(made *m, es_compute f, es_act act, void *ctx, const es_computed_options *o) {
	m->f = f;
	m->act = act;
	m->ctx = ctx;
	m->equal = o != NULL ? o->equal : NULL;
	m->equal_ctx = o != NULL ? o->equal_ctx : NULL;
}

// a new one: its node placed, its computer made and given its status and run record
static int create(es_context *c, int memo, es_names *path, char **key, es_compute f, es_act act,
	void *ctx, const es_computed_options *o, es_node_data *nd, es_handle **out, const ch_site *site) {
	es_ermine *e = c->ermine;
	struct es_computers *x = e->computers;
	sc_scope *own = es_owner(c);
	char *id = es_new_id(e);
	placing p = {c, path->names, path->n, id, node_above(own)};
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
	if (site != NULL) {
		m->has_site = 1;
		m->site = *site;
	}
	m->at = x->nall;
	ES_PUSH(x->all, x->nall, x->capall, m);
	es_map_set(&x->by_id, id, m);
	named_add(m);
	// the creating call's hold, and the first cleanup on its owner
	m->holds = 1;
	hold(m);
	es_calls_made(e, memo ? "memo" : m->early ? "early" : "effect", id, (const char *const *)m->path,
		m->npath);
	creating k = {.m = m, .effect = !memo};
	k.def = (sc_def){.f = computer_f, .equal = computer_equal, .data = m, .early = m->early};
	if (memo) k.def.set = computer_set;
	else k.def.effect = computer_act;
	const char *bad = sc_run_with_scope(own, create_in, &k);
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
	const es_computed_options *o, es_handle **out, const ch_site *site) {
	es_ermine *e = c->ermine;
	sc_scope *own = es_owner(c);
	int code = es_not_in_act(e, own, memo ? "createMemo" : "createEffect");
	if (code) return code;
	es_names path = {0};
	code = es_resolve(c, name, &path);
	if (code) return code;
	char *key = key_of(path.names, path.n);
	es_node_data nd = {.has_path = 1, .path = path.names, .npath = path.n, .part = (char *)"value"};
	made *m = made_at(c, key, own);
	if (m == NULL) {
		code = create(c, memo, &path, &key, f, act, ctx, o, &nd, out, site);
	} else if (!sc_claim(m->c)) {
		// made at this path under own before: claimed, given the new code (a parent's rerun does not
		// destroy its children). as own's run starts, what its earlier runs made is old (the
		// scheduler's); one not old was made in this run, or own has had no run since: already-there
		char *at = join(path.names, path.n);
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
	const es_computed_options *o, es_handle **out, const ch_site *site) {
	const ch_site *was = es_enter(c->ermine, site);
	int code = make(c, 1, name, f, NULL, ctx, o, out, site);
	es_enter(c->ermine, was);
	return code;
}

int es_create_effect_at(es_context *c, es_at name, es_compute f, es_act act, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_site *site) {
	const ch_site *was = es_enter(c->ermine, site);
	int code = make(c, 0, name, f, act, ctx, o, out, site);
	es_enter(c->ermine, was);
	return code;
}

// status -----------------------------------------------------------------------------------------------------------

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

// what a status handed on by onStatus (shown) no longer shares with the base's is let go of
static void release_unshared(es_status *st, const es_status *shown) {
	if (st->held_feature != shown->held_feature) free(st->held_feature);
	if (st->error != shown->error) free(st->error);
	if (st->waiting != shown->waiting) free_waiting(st->waiting, st->nwaiting);
	if (st->more != shown->more) op_free(st->more);
}

// the policy asked, as reading the node's status
static int ask_status(es_context *t, const char *id, const es_node_data *n) {
	if (!t->guarded) return 0;
	op_value *field = op_list();
	op_push(field, op_str(CST_ATTRIBUTE));
	gd_thing thing = {tb_string(id), n->has_path ? (const char *const *)n->path : NULL,
		n->has_path ? n->npath : 0};
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

// a field of the status table's entry at id, tracked
static const op_value *status_field(pl *places, const char *id, const char *field) {
	op_key key = {.type = OP_STR_KEY, .s = field};
	return pl_read(places, tb_string(CST_TABLE), tb_string(id), &key, 1);
}

// an error's message, as a program is shown it
static char *error_text(const op_value *v) {
	const char *m = cst_error(v);
	if (m != NULL) return es_dup(m);
	if (v != NULL && v->type == OP_STR) return es_dup(v->str);
	return es_dup("error");
}

// a path from the root, for a waiting (has_path 0: nothing reaches it), the names copied
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

// a send's wait as c sees it: where the send went (its path from the root, or the node it named)
static void wait_of(es_context *c, const es_wait *w, es_waiting *out) {
	es_names names = {0};
	*out = (es_waiting){.kind = ES_WAIT_SEND, .since = w->since};
	if (w->has_path) waiting_path_of(out, (const char *const *)w->path, w->npath);
	else waiting_path(out, es_seen_in(c->ermine, c, w->id, &names), &names);
}

// a path an op_value list holds, the names copied
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

// a wait a process's status says (written as start goes pending): a send's as wait_of, the rest as it is
static void said_of(es_context *c, const op_value *w, es_waiting *out) {
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
		wait_of(c, &wait, out);
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
		// a node it read that wasn't there: its path from the root
		out->kind = ES_WAIT_NODE;
		char **abs;
		size_t nabs;
		if (list_names(missing, &abs, &nabs)) {
			waiting_path_of(out, (const char *const *)abs, nabs);
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
	p->pending = cst_is_pending(status_field(p->places, p->id, CST_ATTRIBUTE));
}

// a process's (or any node nothing computes) status
static int plain_status(es_context *c, es_context *t, const char *id, const op_value *v, es_status *st) {
	es_ermine *e = c->ermine;
	if (v == NULL) {
		st->state = "done";
		return 0;
	}
	if (!cst_is_pending(v)) {
		st->state = es_pipe_looped(e, id) ? "looping" : "failed";
		st->error = error_text(v);
		return 0;
	}
	const op_value *said = status_field(t->places, id, ES_WAITING);
	if (pl_status(t->places) == SC_STOP) return ES_STOP;
	st->state = "pending";
	if (said != NULL && said->type == OP_LIST && said->count > 0) {
		st->waiting = es_alloc(said->count * sizeof *st->waiting);
		for (size_t i = 0; i < said->count; i++) said_of(c, said->items[i], &st->waiting[i]);
		st->nwaiting = said->count;
		return 0;
	}
	size_t n = 0;
	es_wait *waits = es_calls_waits(e, id, &n);
	st->waiting = es_alloc((n + 1) * sizeof *st->waiting);
	for (size_t i = 0; i < n; i++) wait_of(c, &waits[i], &st->waiting[i]);
	st->nwaiting = n;
	es_waits_free(waits, n);
	if (st->nwaiting == 0) st->waiting[st->nwaiting++] = (es_waiting){.kind = ES_WAIT_PENDING};
	return 0;
}

// a memo's or effect's status, from its latest run
static int computer_status(es_context *c, es_context *t, const char *id, const op_value *v,
	es_status *st) {
	es_ermine *e = c->ermine;
	const crn_run *r = NULL;
	if (e->runs != NULL &&
		crn_read(e->runs, NULL, NULL, tb_string(id), CRN_ALL, &r, NULL, NULL) == CRN_STOP) {
		return ES_STOP;
	}
	if (r != NULL) {
		st->has_n = 1;
		st->n = r->n;
	}
	if (v == NULL) {
		st->state = "done";
		return 0;
	}
	if (!cst_is_pending(v)) {
		st->error = error_text(v);
		if (r != NULL && strcmp(r->end, "looping") == 0) {
			st->state = "looping";
			return 0;
		}
		st->state = "failed";
		st->phase = r != NULL && strcmp(r->end, "failed") != 0 && r->act == CRN_ACT_FAILED ? "act" : "run";
		return 0;
	}
	st->state = "pending";
	es_waiting *waiting = NULL;
	size_t nwaiting = 0, cap = 0;
	// the pending memos it read
	for (size_t i = 0; r != NULL && r->reads != NULL && i < r->reads->n; i++) {
		const crn_saw *w = &r->reads->items[i];
		if (!w->named || w->part == NULL || w->id == NULL || w->spot || w->keys) continue;
		if (strcmp(w->part, CST_TABLE) != 0 || strcmp(w->id, id) == 0) continue;
		if (w->npath != 1 || w->path[0].type != OP_STR_KEY ||
			strcmp(w->path[0].s, CST_ATTRIBUTE) != 0) {
			continue;
		}
		peeking p = {t->places, w->id, 0};
		pl_peep(t->places, peek, &p);
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
		wait_of(c, &waits[i], &item);
		ES_PUSH(waiting, nwaiting, cap, item);
	}
	es_waits_free(waits, n);
	// the nodes it read that weren't there, in this run
	const es_missing *missing = es_missing_of(e, id);
	if (missing != NULL && r != NULL && missing->has_n && missing->n == r->n) {
		for (size_t i = 0; i < missing->npaths; i++) {
			es_waiting item = {.kind = ES_WAIT_NODE};
			waiting_path_of(&item, (const char *const *)missing->paths[i].names, missing->paths[i].n);
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

// the base's status, read and asked as t (the node's side), told as c sees it
static int own_status(es_context *c, es_context *t, const es_node_data *n, const char *id,
	es_status *st) {
	es_ermine *e = c->ermine;
	int code = ask_status(t, id, n);
	if (code) return code;
	const op_value *v = status_field(t->places, id, CST_ATTRIBUTE);
	if (pl_status(t->places) == SC_STOP) return ES_STOP;
	es_held h;
	if (es_held_status(e, id, &h) || es_held_row(e, id, &h)) {
		st->has_held = 1;
		st->held_feature = es_dup(h.feature);
		st->held_write = h.write;
	}
	if (!es_is_computer(e, id)) return plain_status(c, t, id, v, st);
	return computer_status(c, t, id, v, st);
}

// the base's, then what features show (onStatus)
int es_get_status(es_context *c, es_target x, es_status *out) {
	*out = (es_status){0};
	es_context *t = c;
	es_node_data n = {0};
	int code = es_node_of(t, x, &n);
	if (code) return code;
	const char *at;
	if (!es_id_of(t, &n, &at)) {
		es_node_data_free(&n);
		return 0;
	}
	char *id = es_dup(at);
	es_status st = {0};
	code = own_status(c, t, &n, id, &st);
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
	// a track that says stop leaves none: the run it was read in ends at its next read
	if (e->runs == NULL ||
		crn_read(e->runs, NULL, NULL, tb_string(id), CRN_ALL, out, NULL, NULL) != 0) {
		*out = NULL;
	}
	return *out != NULL;
}
