// actions (system/actions.ts' createAction, executeAction; system/explaining.ts' explain …; calls.ts), in C: actions, the call frame,
// call records, getCaller, explain and its views, teardowns, promises. C's job, function by function
// (ermine.h says each):
//   state: es_actions_new, es_actions_free, es_is_action (each action placed, by its node: the
//     function and the scope open when it was placed)
//   actions: es_create_action_at (the function a stand-in in the node's value), es_execute_action_at
//     (the call frame, waits, PENDING, the record held as the handler's latest, a promise's call lasts
//     till it settles), es_get_caller, es_add_teardown (the why)
//   explain: es_explain, es_explain_attributes, es_explain_children, es_explain_view, es_explained_free;
//     the views: es_change_view_of, es_view_change, es_run_view_of, es_call_view_of, es_run_view_free,
//     es_call_view_free, es_show (handles shown as paths), es_caller_free
//   calls.ts: es_calls_new, es_calls_free, es_calls_next, es_calls_begin, es_calls_end,
//     es_calls_calling, es_calls_open, es_calls_read, es_calls_made, es_calls_latest, es_calls_wait,
//     es_calls_answered, es_calls_waits, es_waits_free, es_calls_stop
//   promises: es_promise_new, es_promise_release, es_promise_value, es_promise_resolve,
//     es_promise_reject, es_promise_then (held by the maker and each then; settled and let go: freed)
//
// a call going (es_going) is held by its scope: the scope's own teardown, the last it runs, lets it go,
// and a promise out holds it till it settles. a call frame's info is { caller: { node, actor }, handler,
// call }, op_values the calls state keeps till the scope is freed (a scope borrows its info). a
// record holds its caller's context (its scope's hold), so the context lasts as the record does.
// a track the scheduler answers SC_STOP to, in latest and waits, is let go: the TypeScript's track
// does not stop a run, and these give no code.
#include "ermine.h"

#include <stdio.h>

#include "../../processes/c/platform.h"

// milliseconds since 1970, fractional
static double now(void) { return PF_NOW_MS(); }


// a pair of the info that is an op_value of this type
static const op_value *value_of(const sc_scope *o, const char *key, op_type type) {
	const op_value *v = es_pair_of(o, key);
	return v != NULL && v->type == type ? v : NULL;
}

// the actor a write made now would carry: the first the frame open (none: the context's) or one under
// it gives
static const op_value *actor_here(es_context *c) {
	for (sc_frame *o = es_open_frame(c); o != NULL; o = sc_frame_parent(o)) {
		const op_value *a = es_frame_pair_of(o, "actor");
		if (a != NULL) return a;
	}
	return NULL;
}

static char *opt_dup(const char *s) { return s == NULL ? NULL : es_dup(s); }
static char *text(tb_key k) { return es_dup(k.string != NULL ? k.string : ""); }


// --- keys, changes ---------------------------------------------------------------------------------------

static op_key *keys_copy(const op_key *k, size_t n) {
	if (n == 0) return NULL;
	op_key *out = es_alloc(n * sizeof *out);
	for (size_t i = 0; i < n; i++) {
		out[i] = k[i];
		if (k[i].type == OP_STR_KEY) out[i].s = es_dup(k[i].s);
	}
	return out;
}

static void keys_free(op_key *k, size_t n) {
	for (size_t i = 0; i < n; i++) {
		if (k[i].type == OP_STR_KEY) free((char *)k[i].s);
	}
	free(k);
}

// a path as an op_value list of its steps (a guard target's field)
static op_value *keys_value(const op_key *k, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) {
		if (k[i].type == OP_STR_KEY) op_push(list, op_str(k[i].s));
		else if (k[i].type == OP_NUM_KEY) op_push(list, op_num((double)k[i].n));
		else op_push(list, op_null());
	}
	return list;
}

// a header's pieces as a value, held (the caller's to op_free): places' own (pl_change_value, made once
// a header and shared by identity); one places didn't make, built here
static op_value *change_value(es_ermine *e, const ch_header *h) {
	const op_value *shared = pl_change_value(e->places, h);
	if (shared != NULL) return op_ref((op_value *)shared);
	op_value *m = op_map();
	if (h->has_time) op_set(m, "time", op_num((double)h->time));
	if (h->actor != NULL) op_set(m, "actor", op_ref((op_value *)h->actor));
	if (h->reader != NULL) op_set(m, "reader", op_str(h->reader));
	if (h->external_length > 0) {
		op_value *sites = op_list();
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			op_value *site = op_map();
			op_set(site, "file", op_str(s->file ? s->file : ""));
			op_set(site, "line", op_num((double)s->line));
			if (s->has_column) op_set(site, "column", op_num((double)s->column));
			if (s->function != NULL) op_set(site, "function", op_str(s->function));
			op_push(sites, site);
		}
		op_set(m, "external", sites);
	}
	if (h->metadata_length > 0) {
		op_value *meta = op_map();
		for (size_t i = 0; i < h->metadata_length; i++) {
			const op_value *v = h->metadata[i].value;
			op_set(meta, h->metadata[i].key, v ? op_ref((op_value *)v) : op_null());
		}
		op_set(m, "metadata", meta);
	}
	return m;
}

// the change of the entry at (part, id) in the table written to, held; NULL: no entry
static op_value *change_at(es_ermine *e, const char *part, const char *id) {
	const nd_entry *there = tb_get(e->table, tb_string(part), tb_string(id));
	return there == NULL ? NULL : change_value(e, &there->change);
}

// --- the state -------------------------------------------------------------------------------------------

typedef struct {
	void (*fn)(void *ctx, int ok, const op_value *value, const char *error);
	void *ctx;
} then_cb;

struct es_promise {
	// 0 out, 1 resolved, 2 rejected
	int state;
	op_value *value;
	char *error;
	then_cb *cbs;
	size_t n, cap;
	// its holds: its maker's (es_promise_release), and each then not told yet. settled and none
	// left: freed. serial: its stand-in's, so one left of a freed promise names no other. x NULL: the
	// ermine closed; held by its maker still, it settles nothing and is freed as the maker lets go
	size_t holds;
	uint64_t serial;
	size_t at;
	struct es_actions *x;
};

// an action's record: the function a node's stand-in names. let go when its node's value stops being
// that stand-in (taken out, written over) or the scope that placed it goes; then dead, its gen up (so a
// stand-in held elsewhere, copied or placed, names an older one and is no action), its slot used
// again. a slot is never freed before close, so a stand-in's pointer is safe to look at
typedef struct {
	es_function f;
	uint32_t gen;
	int live;
	size_t index;
} fnslot;

// a frame a handler or a writer owns [chee 10-28]: made alone under its scope's own frame as it is
// made, its site found then (es_site_up) and noted; a handler's info { handler: its node }, a
// writer's none. its owner holds it, and each frame made under it (a call's), so it outlasts its
// owner while one goes
typedef struct hframe {
	es_ermine *e;
	sc_frame *frame;
	op_value *id;
	sc_pair info[1];
	size_t refs;
} hframe;

static hframe *hframe_new(es_context *c, const char *handler, sc_scope *own, const ch_site *given) {
	es_ermine *e = c->ermine;
	hframe *h = es_alloc(sizeof *h);
	h->e = e;
	h->refs = 1;
	if (handler != NULL) {
		h->id = op_str(handler);
		h->info[0] = (sc_pair){"handler", h->id};
	}
	h->frame = sc_create_frame(e->scheduler, h->info, handler != NULL ? 1 : 0, sc_scope_frame(own));
	ch_site found;
	const ch_site *site = es_site_up(e, es_open_frame(c), given, &found);
	if (site != NULL && e->sites != NULL) {
		st_note_frame(e->sites, h->frame, site->file, (int)site->line, site->function);
	}
	return h;
}

static void hframe_drop(hframe *h) {
	if (h == NULL || --h->refs > 0) return;
	if (h->e->sites != NULL) st_forget_frame(h->e->sites, h->frame);
	sc_free_frame(h->frame);
	op_free(h->id);
	free(h);
}

// an action placed: the function (its slot, and the gen it had), the scope that placed it, the context
// it was placed as, and its handler's frame
typedef struct {
	es_function *fn;
	uint32_t gen;
	sc_scope *scope;
	es_context *context;
	hframe *frame;
} placed;

static void placed_free(placed *p) {
	if (p == NULL) return;
	hframe_drop(p->frame);
	free(p);
}

typedef struct writer_rec writer_rec;
// a writer: where it was made (its parent: what it makes and asks as belongs to it), and the
// mark it was made under (an action's call frame: its caller, handler and call), held. it is freed as its
// parent goes, or when the program lets it go (es_drop_writer); a stand-in of one freed is gone (the
// serial tells it from a later one at its address). a parent has one teardown for all it made
typedef struct writer_owner writer_owner;
struct writer_rec {
	struct es_actions *x;
	writer_owner *owner;
	es_context *c;
	sc_scope *parent;
	uint64_t serial;
	op_value *mark[3];
	size_t nmark;
	// its own frame, under its parent's: its site where createWriter was called; each run is under it
	hframe *frame;
};
struct writer_owner {
	struct es_actions *x;
	sc_scope *parent;
	writer_rec **bs;
	size_t n, cap;
};

struct es_actions {
	// each action placed, by its node: gone with that scope
	es_map methods;
	// the (scope, node) pairs that have their teardown registered: one per pair, however often placed
	es_map placers;
	// every record made, live or dead; the dead ones' places, to use again; the records' addresses
	fnslot **fns;
	size_t nfns, capfns;
	size_t *dead;
	size_t ndead, capdead;
	pm known;
	// a change's view, made once: change → view, and the views (a view not in it is no view of this
	// ermine's). a view lasts while its change does (the reference's WeakMap by the header): one
	// whose change only it holds goes at a pulse's end, once there are twice as many as were left
	pm views, viewed;
	es_change_view **allviews;
	size_t nviews, capviews, swept;
	sc_listener *sweeping;
	es_promise **promises;
	size_t npromises, cappromises;
	uint64_t serials;
	// the promises made, by address: a stand-in of kind promise is one of them, or data
	pm made;
	// the writers alive, by address; the parents that made some, by scope
	pm writers, owners;
};

static void views_sweep(void *data);
static void promise_free(es_promise *p);
static void writer_free(writer_rec *b);

struct es_actions *es_actions_new(es_ermine *e) {
	struct es_actions *x = es_alloc(sizeof(struct es_actions));
	x->sweeping = sc_on_after_pulse(e->scheduler, views_sweep, x);
	return x;
}

void es_actions_free(struct es_actions *x) {
	if (x == NULL) return;
	if (x->sweeping != NULL) sc_remove_listener(x->sweeping);
	for (size_t i = 0; i < x->methods.n; i++) placed_free(x->methods.vals[i]);
	es_map_free(&x->methods);
	es_map_free(&x->placers);
	for (size_t i = 0; i < x->nfns; i++) free(x->fns[i]);
	free(x->fns);
	free(x->dead);
	pm_clear(&x->known);
	for (size_t i = 0; i < x->nviews; i++) {
		op_free((op_value *)x->allviews[i]->change);
		free(x->allviews[i]);
	}
	free(x->allviews);
	pm_clear(&x->views);
	pm_clear(&x->viewed);
	for (size_t i = 0; i < x->npromises; i++) {
		es_promise *p = x->promises[i];
		// the thens not told are dropped; the maker's hold keeps the promise till it lets go
		p->holds -= p->n;
		free(p->cbs);
		p->cbs = NULL;
		p->n = p->cap = 0;
		p->x = NULL;
		if (p->holds == 0) promise_free(p);
	}
	free(x->promises);
	pm_clear(&x->made);
	for (size_t i = 0; i < x->owners.cap; i++) {
		writer_owner *o = x->owners.keys[i] != NULL ? x->owners.vals[i] : NULL;
		if (o == NULL) continue;
		for (size_t j = 0; j < o->n; j++) writer_free(o->bs[j]);
		free(o->bs);
		free(o);
	}
	pm_clear(&x->writers);
	pm_clear(&x->owners);
	free(x);
}

int es_is_action(es_ermine *e, const char *id) { return es_map_has(&e->actions->methods, id); }

// --- action records --------------------------------------------------------------------------------------

// a record for f/ctx: a dead one's slot, else a new one
static fnslot *fn_new(struct es_actions *x, es_action fn, void *ctx) {
	fnslot *s;
	if (x->ndead > 0) {
		s = x->fns[x->dead[--x->ndead]];
	} else {
		s = es_alloc(sizeof *s);
		s->index = x->nfns;
		ES_PUSH(x->fns, x->nfns, x->capfns, s);
		pm_set(&x->known, s, s);
	}
	s->f = (es_function){fn, ctx};
	s->live = 1;
	return s;
}

// the stand-in for a record: the function's, and its gen
static op_value *fn_value(const fnslot *s) {
	op_value *v = es_function_value(&s->f);
	op_set(v->items[0], "gen", op_num((double)s->gen));
	return v;
}

// the live record a value is the stand-in of; NULL: it is none (or let go)
static fnslot *fn_of(struct es_actions *x, const op_value *v) {
	fnslot *s = (fnslot *)es_function_of(v);
	if (s == NULL || !pm_has(&x->known, s) || !s->live) return NULL;
	const op_value *gen = op_get(v->items[0], "gen");
	return gen != NULL && gen->type == OP_NUM && gen->num == (double)s->gen ? s : NULL;
}

// a record let go: dead, its gen up, its slot there to use again
static void fn_forget(struct es_actions *x, fnslot *s) {
	if (!s->live) return;
	s->live = 0;
	s->gen++;
	s->f = (es_function){0};
	ES_PUSH(x->dead, x->ndead, x->capdead, s->index);
}

void *es_action_held(es_ermine *e, const op_value *was) {
	return was == NULL ? NULL : fn_of(e->actions, was);
}

void es_action_let_go(es_ermine *e, void *held, const op_value *now) {
	if (held == NULL) return;
	struct es_actions *x = e->actions;
	if (now != NULL && fn_of(x, now) == held) return;
	fn_forget(x, held);
}

// --- promises --------------------------------------------------------------------------------------------

es_promise *es_promise_new(es_ermine *e) {
	struct es_actions *x = e->actions;
	es_promise *p = es_alloc(sizeof *p);
	p->holds = 1;
	p->serial = ++x->serials;
	p->x = x;
	p->at = x->npromises;
	ES_PUSH(x->promises, x->npromises, x->cappromises, p);
	pm_set(&x->made, p, p);
	return p;
}

op_value *es_promise_value(const es_promise *p) {
	op_value *v = es_live("promise", p);
	op_set(v->items[0], "n", op_num((double)p->serial));
	return v;
}

es_promise *es_promise_of(es_ermine *e, const op_value *v) {
	es_promise *p = es_live_of(v, "promise");
	if (p == NULL || e->actions == NULL || !pm_has(&e->actions->made, p)) return NULL;
	const op_value *n = op_get(v->items[0], "n");
	return n != NULL && n->type == OP_NUM && n->num == (double)p->serial ? p : NULL;
}

static void promise_free(es_promise *p) {
	op_free(p->value);
	free(p->error);
	free(p->cbs);
	free(p);
}

// settled and held by nothing: out of the made, freed
static void promise_let_go(es_promise *p) {
	if (p->x == NULL) {
		if (p->holds == 0) promise_free(p);
		return;
	}
	if (p->state == 0 || p->holds > 0) return;
	struct es_actions *x = p->x;
	pm_delete(&x->made, p);
	es_promise *last = x->promises[--x->npromises];
	x->promises[p->at] = last;
	last->at = p->at;
	promise_free(p);
}

void es_promise_release(es_promise *p) {
	if (p == NULL || p->holds == 0) return;
	p->holds--;
	promise_let_go(p);
}

// the callbacks, in the order added, once; each let go of its hold after
static void settled(es_promise *p) {
	size_t n = p->n;
	for (size_t i = 0; i < n; i++) {
		p->cbs[i].fn(p->cbs[i].ctx, p->state == 1, p->value, p->error);
	}
	free(p->cbs);
	p->cbs = NULL;
	p->n = p->cap = 0;
	p->holds -= n;
	promise_let_go(p);
}

void es_promise_resolve(es_promise *p, op_value *value) {
	if (p->state != 0 || p->x == NULL) {
		op_free(value);
		return;
	}
	p->state = 1;
	p->value = value;
	settled(p);
}

void es_promise_reject(es_promise *p, const char *message) {
	if (p->state != 0 || p->x == NULL) return;
	p->state = 2;
	p->error = es_dup(message);
	settled(p);
}

void es_promise_then(es_promise *p,
	void (*fn)(void *ctx, int ok, const op_value *value, const char *error), void *ctx) {
	if (p->state != 0) {
		// held while fn runs: fn letting go of the last other hold frees nothing it was handed
		p->holds++;
		fn(ctx, p->state == 1, p->value, p->error);
		p->holds--;
		promise_let_go(p);
		return;
	}
	if (p->x == NULL) return;
	then_cb cb = {fn, ctx};
	ES_PUSH(p->cbs, p->n, p->cap, cb);
	p->holds++;
}

// --- views -----------------------------------------------------------------------------------------------

const es_change_view *es_change_view_of(es_ermine *e, const op_value *change) {
	struct es_actions *x = e->actions;
	if (change == NULL) return NULL;
	es_change_view *v = pm_get(&x->views, change);
	if (v != NULL) return v;
	v = es_alloc(sizeof *v);
	v->change = op_ref((op_value *)change);
	const op_value *t = op_get(change, "time");
	int64_t time;
	if (t != NULL && op_as_int64(t, &time)) v->time = time;
	v->actor = op_get(change, "actor");
	const op_value *meta = op_get(change, "metadata");
	const op_value *during = meta == NULL ? NULL : op_get(meta, "userActivated");
	v->user_activated = during != NULL && during->type == OP_BOOL && during->bool_;
	const op_value *external = op_get(change, "external");
	if (external != NULL && external->type == OP_LIST && external->count > 0) {
		// of its sites, the last: the nearest
		const op_value *s = external->items[external->count - 1];
		const op_value *file = op_get(s, "file"), *line = op_get(s, "line");
		const op_value *column = op_get(s, "column"), *function = op_get(s, "function");
		double n;
		v->has_site = 1;
		v->site.file = file != NULL && file->type == OP_STR ? file->str : "";
		if (line != NULL && op_as_double(line, &n)) v->site.line = (long)n;
		if (column != NULL && op_as_double(column, &n)) {
			v->site.column = (long)n;
			v->site.has_column = 1;
		}
		if (function != NULL && function->type == OP_STR) v->site.function = function->str;
	}
	pm_set(&x->views, change, v);
	pm_set(&x->viewed, v, v);
	ES_PUSH(x->allviews, x->nviews, x->capviews, v);
	return v;
}

// the views whose change only they hold, let go: nothing else names that change now (no node, no
// record), so the view is named by none either but a program still holding a read's from, which
// is borrowed till the node changes. at a pulse's end, as there come to be twice as many
static void views_sweep(void *data) {
	struct es_actions *x = data;
	if (x->nviews < 2 * x->swept + 64) return;
	size_t k = 0;
	for (size_t i = 0; i < x->nviews; i++) {
		es_change_view *v = x->allviews[i];
		if (v->change->refs > 0) {
			x->allviews[k++] = v;
			continue;
		}
		pm_delete(&x->views, v->change);
		pm_delete(&x->viewed, v);
		op_free((op_value *)v->change);
		free(v);
	}
	x->nviews = x->swept = k;
}

const op_value *es_view_change(es_ermine *e, const es_change_view *v) {
	if (v == NULL || !pm_has(&e->actions->viewed, v)) return NULL;
	return v->change;
}

// --- records as a process sees them ------------------------------------------------------------------------

// a record's read or write: the part, and the node's path from the root (none: nothing reaches it)
static void touched(es_context *c, es_touched *out, const char *part, const char *id) {
	es_names names;
	out->part = es_dup(part);
	if (es_seen_in(c->ermine, c, id, &names)) {
		out->has_path = 1;
		out->path = names.names;
		out->npath = names.n;
	}
}

// the path of a node as c sees it, for a writer or a made one
static void path_of(es_context *c, const char *id, int *has, char ***path, size_t *npath) {
	es_names names;
	if (es_seen_in(c->ermine, c, id, &names)) {
		*has = 1;
		*path = names.names;
		*npath = names.n;
	}
}

static void names_free_all(char **path, size_t n) {
	for (size_t i = 0; i < n; i++) free(path[i]);
	free(path);
}

static void touched_free(es_touched *t, size_t n) {
	for (size_t i = 0; i < n; i++) {
		free(t[i].part);
		names_free_all(t[i].path, t[i].npath);
	}
	free(t);
}

es_run_view *es_run_view_of(es_context *c, const crn_run *r) {
	es_run_view *v = es_alloc(sizeof *v);
	v->n = r->n;
	v->has_started = r->has_started;
	v->started = r->started;
	v->ended = r->ended;
	v->end = r->end;
	v->error = opt_dup(r->error);
	v->act = r->act;
	v->act_error = opt_dup(r->act_error);
	if (r->reads != NULL) {
		v->reads = es_alloc(r->reads->n * sizeof *v->reads);
		for (size_t i = 0; i < r->reads->n; i++) {
			const crn_saw *w = &r->reads->items[i];
			if (w->named && w->part != NULL && w->id != NULL) {
				touched(c, &v->reads[v->nreads++], w->part, w->id);
			}
		}
	}
	if (r->writes != NULL) {
		v->writes = es_alloc(r->writes->n * sizeof *v->writes);
		for (size_t i = 0; i < r->writes->n; i++) {
			touched(c, &v->writes[v->nwrites++], r->writes->items[i].part, r->writes->items[i].id);
		}
	}
	return v;
}

void es_run_view_free(es_run_view *v) {
	if (v == NULL) return;
	free(v->error);
	free(v->act_error);
	touched_free(v->reads, v->nreads);
	touched_free(v->writes, v->nwrites);
	free(v);
}

// v as c is shown it: a handle the path it reaches as c sees it (none: null), never the handle; lists
// and plain maps looked through
op_value *es_show(es_context *c, const op_value *v) {
	if (v == NULL) return NULL;
	es_ermine *e = c->ermine;
	// a writer is a power, never data: a marker, as a handle is shown as its path
	if (es_live_of(v, "runner") != NULL) return op_str("[writer]");
	es_handle *h = es_handle_in(e, v);
	if (h != NULL) {
		const es_handle_data *d = es_handle_lookup(e, h);
		const char *id;
		es_names names;
		if (d != NULL && es_id_of(c, &d->node, &id) && es_seen_in(e, c, id, &names)) {
			op_value *list = op_list();
			for (size_t i = 0; i < names.n; i++) op_push(list, op_str(names.names[i]));
			es_names_free(&names);
			return list;
		}
		return op_null();
	}
	if (v->type == OP_LIST) {
		op_value *list = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(list, es_show(c, v->items[i]));
		return list;
	}
	if (v->type == OP_MAP) {
		op_value *map = op_map();
		for (size_t i = 0; i < v->count; i++) op_set(map, v->keys[i], es_show(c, v->items[i]));
		return map;
	}
	return op_ref((op_value *)v);
}

es_call_view *es_call_view_of(es_context *c, const es_call *call) {
	es_call_view *v = es_alloc(sizeof *v);
	v->n = call->n;
	v->end = call->end;
	v->started = call->started;
	v->has_ended = call->has_ended;
	v->ended = call->ended;
	v->error = opt_dup(call->error);
	if (call->nargs > 0) v->args = es_alloc(call->nargs * sizeof *v->args);
	for (size_t i = 0; i < call->nargs; i++) v->args[v->nargs++] = es_show(c, call->args[i]);
	v->has_returned = call->has_returned;
	if (call->has_returned) v->returned = es_show(c, call->returned);
	if (call->nreads > 0) v->reads = es_alloc(call->nreads * sizeof *v->reads);
	for (size_t i = 0; i < call->nreads; i++) {
		touched(c, &v->reads[v->nreads++], call->reads[i].part, call->reads[i].id);
	}
	if (call->nwrites > 0) v->writes = es_alloc(call->nwrites * sizeof *v->writes);
	for (size_t i = 0; i < call->nwrites; i++) {
		touched(c, &v->writes[v->nwrites++], call->writes[i].part, call->writes[i].id);
	}
	if (call->nmade > 0) v->made = es_alloc(call->nmade * sizeof *v->made);
	for (size_t i = 0; i < call->nmade; i++) {
		es_made_view *m = &v->made[v->nmade++];
		m->kind = call->made[i].kind;
		path_of(c, call->made[i].id, &m->has_path, &m->path, &m->npath);
	}
	return v;
}

void es_call_view_free(es_call_view *v) {
	if (v == NULL) return;
	for (size_t i = 0; i < v->nargs; i++) op_free(v->args[i]);
	free(v->args);
	op_free(v->returned);
	free(v->error);
	touched_free(v->reads, v->nreads);
	touched_free(v->writes, v->nwrites);
	for (size_t i = 0; i < v->nmade; i++) names_free_all(v->made[i].path, v->made[i].npath);
	free(v->made);
	free(v);
}

// --- explain ---------------------------------------------------------------------------------------------

// the change's writer, one step: a computer (by the run it names), an action (by the call), or code
// outside any
static void writer_of(es_context *c, const op_value *change, es_explained *out) {
	es_ermine *e = c->ermine;
	const es_change_view *view = es_change_view_of(e, change);
	out->change = view;
	out->has_writer = 1;
	es_writer *w = &out->writer;
	const op_value *meta = op_get(change, "metadata");
	const op_value *run = meta == NULL ? NULL : op_get(meta, "run");
	const op_value *node = meta == NULL ? NULL : op_get(meta, PL_NODE);
	const op_value *call = meta == NULL ? NULL : op_get(meta, "call");
	const op_value *handler = meta == NULL ? NULL : op_get(meta, "handler");
	if (run != NULL && node != NULL && node->type == OP_STR) {
		w->kind = ES_WRITER_COMPUTER;
		path_of(c, node->str, &w->has_path, &w->path, &w->npath);
		const crn_run *r;
		double n;
		if (es_latest_run(e, node->str, &r) && op_as_double(run, &n) && (double)r->n == n &&
			r->writes != NULL) {
			for (size_t i = 0; i < r->writes->n; i++) {
				if (r->writes->items[i].change == change) {
					w->run = es_run_view_of(c, r);
					break;
				}
			}
		}
		return;
	}
	if (call != NULL && handler != NULL && handler->type == OP_STR) {
		w->kind = ES_WRITER_ACTION;
		path_of(c, handler->str, &w->has_path, &w->path, &w->npath);
		const es_call *latest = es_calls_latest(e, handler->str);
		double n;
		if (latest != NULL && op_as_double(call, &n) && (double)latest->n == n) {
			for (size_t i = 0; i < latest->nwrites; i++) {
				if (latest->writes[i].change == change) {
					w->call = es_call_view_of(c, latest);
					break;
				}
			}
		}
		return;
	}
	w->kind = ES_WRITER_OUTSIDE;
	if (view != NULL && view->has_site) {
		w->has_site = 1;
		w->site = view->site;
	}
}

void es_explained_free(es_explained *x) {
	if (x == NULL) return;
	names_free_all(x->writer.path, x->writer.npath);
	es_run_view_free(x->writer.run);
	es_call_view_free(x->writer.call);
	free(x->held_feature);
	free(x);
}

// the read of the node asked of the policy, as the node's side is: the guard's read
static int ask_read(es_context *t, const char *id, const es_node_data *n, const op_key *key,
	size_t nkey) {
	if (!t->guarded) return 0;
	op_value *field = nkey > 0 ? keys_value(key, nkey) : NULL;
	gd_thing thing = es_thing_of(id, n);
	gd_target target = gd_target_of(thing, n->part, field);
	gd_refusal why;
	gd_answer answer = gd_read(t->guard, &target, 1, &why);
	int code = 0;
	if (answer == GD_REFUSED) code = es_fail_refusal(&why, NULL, NULL);
	else if (answer == GD_PENDING) code = ES_PENDING;
	else if (answer == GD_FAILED) code = ES_STOP;
	op_free(field);
	return code;
}

// the node n explained: its entry's change, and a write held there
static int explain_node(es_context *c, const es_node_data *n, const op_key *key,
	size_t nkey, es_explained **out) {
	es_ermine *e = c->ermine;
	*out = NULL;
	const char *id;
	if (!es_id_of(c, n, &id)) return 0;
	int code = ask_read(c, id, n, key, nkey);
	if (code) return code;
	pl_change(c->places, tb_string(n->part), tb_string(id));
	if (pl_status(c->places) != SC_OK) return ES_STOP;
	op_value *change = change_at(e, n->part, id);
	es_explained *x = es_alloc(sizeof *x);
	es_held h;
	if (es_held_at(e, n->part, id, &h)) {
		x->has_held = 1;
		x->held_feature = es_dup(h.feature);
	}
	if (change == NULL) {
		if (!x->has_held) {
			free(x);
			return 0;
		}
		*out = x;
		return 0;
	}
	writer_of(c, change, x);
	// the view holds the change now
	op_free(change);
	*out = x;
	return 0;
}

int es_explain(es_context *c, es_target x, const op_key *key, size_t nkey, es_explained **out) {
	*out = NULL;
	int code = es_alive(c->ermine);
	if (code) return code;
	es_node_data n;
	code = es_node_of(c, x, &n);
	if (code) return code;
	code = explain_node(c, &n, key, nkey, out);
	es_node_data_free(&n);
	return code;
}

// the same node's attributes or children: its part changed, no handle made
static int explain_part(es_context *c, es_target x, const char *part, es_explained **out) {
	*out = NULL;
	int code = es_alive(c->ermine);
	if (code) return code;
	es_node_data n;
	code = es_node_of(c, x, &n);
	if (code) return code;
	free(n.part);
	n.part = es_dup(part);
	code = explain_node(c, &n, NULL, 0, out);
	es_node_data_free(&n);
	return code;
}

int es_explain_attributes(es_context *c, es_target x, es_explained **out) {
	return explain_part(c, x, "attributes", out);
}

int es_explain_children(es_context *c, es_target x, es_explained **out) {
	return explain_part(c, x, "children", out);
}

int es_explain_view(es_context *c, const es_change_view *v, es_explained **out) {
	*out = NULL;
	int code = es_alive(c->ermine);
	if (code) return code;
	const op_value *change = es_view_change(c->ermine, v);
	if (change == NULL) {
		return es_fail(ES_NOTHING_THERE, "nothing-there (not a change this ermine shows)");
	}
	es_explained *x = es_alloc(sizeof *x);
	writer_of(c, change, x);
	*out = x;
	return 0;
}

// --- the call records (calls.ts) ----------------------------------------------------------------------------

// a handler's latest call. its address is the key a read of it tracks
typedef struct {
	es_call *call;
} held;

// a send waiting: the wait, the run (a computer's) it was made in
typedef struct {
	es_wait wait;
	char *key;
	int has_run;
	unsigned run;
} target;

// a caller's waits, in the order made
typedef struct {
	char *caller;
	target *items;
	size_t n, cap;
} waiter;

struct es_going {
	struct es_calls *x;
	unsigned n;
	// its call's frame, made alone and its (the calls' map has it till the call ends), with the
	// values its info borrows: both freed with the record
	sc_frame *frame;
	struct call_info *info;
	// the run open as it began (a send from a memo or effect): what is done in it is the call's
	int has_run;
	sc_computer *computer;
	unsigned run_n;
	// its record so far
	char *caller;
	es_context *context;
	char *handler;
	op_value *handler_change;
	op_value **args;
	size_t nargs;
	double started;
	es_call_read *reads;
	size_t nreads, capreads;
	es_map seen;
	es_call_write *writes;
	size_t nwrites, capwrites;
	es_made *made;
	size_t nmade, capmade;
	// the call's end holds one, a promise out one more
	size_t refs;
	// its handler gone while it went: told onRecord as it ends, never held
	int gone;
	// where it was called from
	int has_site;
	ch_site site;
};

struct es_calls {
	es_ermine *e;
	int keep;
	int closing;
	unsigned n;
	// the calls going, innermost last
	es_going **stack;
	size_t nstack, capstack;
	// call frame → going, and every going alive
	pm frames, live;
	// handler → held
	es_map records;
	waiter **waiting;
	size_t nwaiting, capwaiting;
	// the waits' list: its address is the key waits() tracks
	char list;
	// the (scope, caller, run) with a teardown registered to take a caller's waits out
	es_map armed;
	pl_watch *watch;
	sc_listener *ended;
};

// a call frame's info: { caller, handler, call }, borrowed by the frame, held here till it is freed
typedef struct call_info {
	op_value *values[4];
	size_t n;
	// the handler's frame the call frame is under, held till it is freed
	hframe *up;
} call_info;

static void call_info_free(call_info *k) {
	for (size_t i = 0; i < k->n; i++) op_free(k->values[i]);
	hframe_drop(k->up);
	free(k);
}

static void call_read_free(es_call_read *r) {
	free(r->part);
	free(r->id);
	keys_free(r->path, r->npath);
	op_free(r->change);
}

static void call_free(es_call *c) {
	if (c == NULL) return;
	// the caller's context held while the record is (its scope's hold)
	if (c->context != NULL) sc_release(c->context->scope);
	free(c->caller);
	free(c->handler);
	op_free(c->handler_change);
	for (size_t i = 0; i < c->nargs; i++) op_free(c->args[i]);
	free(c->args);
	op_free(c->returned);
	free(c->error);
	for (size_t i = 0; i < c->nreads; i++) call_read_free(&c->reads[i]);
	free(c->reads);
	for (size_t i = 0; i < c->nwrites; i++) {
		free(c->writes[i].part);
		free(c->writes[i].id);
		op_free(c->writes[i].change);
	}
	free(c->writes);
	for (size_t i = 0; i < c->nmade; i++) {
		free(c->made[i].id);
		names_free_all(c->made[i].path, c->made[i].npath);
	}
	free(c->made);
	free(c);
}

// a record as a copy of its own: the pieces it holds copied or held
static es_call *call_copy(const es_call *c) {
	es_call *o = es_alloc(sizeof *o);
	o->n = c->n;
	o->caller = opt_dup(c->caller);
	o->context = c->context;
	if (o->context != NULL) sc_retain(o->context->scope);
	o->handler = opt_dup(c->handler);
	o->handler_change = op_ref(c->handler_change);
	if (c->nargs > 0) o->args = es_alloc(c->nargs * sizeof *o->args);
	for (size_t i = 0; i < c->nargs; i++) o->args[o->nargs++] = op_ref(c->args[i]);
	o->end = c->end;
	o->has_site = c->has_site;
	o->site = c->site;
	o->has_returned = c->has_returned;
	o->returned = op_ref(c->returned);
	o->error = opt_dup(c->error);
	o->started = c->started;
	o->ended = c->ended;
	o->has_ended = c->has_ended;
	if (c->nreads > 0) o->reads = es_alloc(c->nreads * sizeof *o->reads);
	for (size_t i = 0; i < c->nreads; i++) {
		const es_call_read *r = &c->reads[i];
		o->reads[o->nreads++] = (es_call_read){es_dup(r->part), es_dup(r->id),
			keys_copy(r->path, r->npath), r->npath, r->has_path, r->keys, op_ref(r->change)};
	}
	if (c->nwrites > 0) o->writes = es_alloc(c->nwrites * sizeof *o->writes);
	for (size_t i = 0; i < c->nwrites; i++) {
		const es_call_write *w = &c->writes[i];
		o->writes[o->nwrites++] = (es_call_write){es_dup(w->part), es_dup(w->id), op_ref(w->change)};
	}
	if (c->nmade > 0) o->made = es_alloc(c->nmade * sizeof *o->made);
	for (size_t i = 0; i < c->nmade; i++) {
		const es_made *m = &c->made[i];
		es_made *d = &o->made[o->nmade++];
		d->kind = m->kind;
		d->id = es_dup(m->id);
		if (m->npath > 0) d->path = es_alloc(m->npath * sizeof *d->path);
		for (size_t j = 0; j < m->npath; j++) d->path[d->npath++] = es_dup(m->path[j]);
	}
	return o;
}

static void wait_free(es_wait *w) {
	free(w->caller);
	free(w->id);
	names_free_all(w->path, w->npath);
}

static void target_free(target *t) {
	free(t->key);
	wait_free(&t->wait);
}

static void waiter_free(waiter *w) {
	for (size_t i = 0; i < w->n; i++) target_free(&w->items[i]);
	free(w->items);
	free(w->caller);
	free(w);
}

static void going_free(es_going *g) {
	struct es_calls *x = g->x;
	if (!x->closing) {
		for (size_t i = 0; i < x->nstack; i++) {
			if (x->stack[i] == g) {
				memmove(x->stack + i, x->stack + i + 1, (x->nstack - i - 1) * sizeof *x->stack);
				x->nstack--;
				break;
			}
		}
		pm_delete(&x->live, g);
		pm_delete(&x->frames, g->frame);
	}
	sc_free_frame(g->frame);
	call_info_free(g->info);
	free(g->caller);
	free(g->handler);
	op_free(g->handler_change);
	for (size_t i = 0; i < g->nargs; i++) op_free(g->args[i]);
	free(g->args);
	for (size_t i = 0; i < g->nreads; i++) call_read_free(&g->reads[i]);
	free(g->reads);
	es_map_free(&g->seen);
	for (size_t i = 0; i < g->nwrites; i++) {
		free(g->writes[i].part);
		free(g->writes[i].id);
		op_free(g->writes[i].change);
	}
	free(g->writes);
	for (size_t i = 0; i < g->nmade; i++) {
		free(g->made[i].id);
		names_free_all(g->made[i].path, g->made[i].npath);
	}
	free(g->made);
	if (g->computer != NULL) sc_release(g->computer);
	if (g->context != NULL) sc_release(g->context->scope);
	free(g);
}

static void going_release(es_going *g) {
	if (--g->refs == 0) going_free(g);
}

// the writes a call made: told by places, to the call open
static void landed(const pl_fact *fact, void *ctx);
static void run_ended(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data);

struct es_calls *es_calls_new(es_ermine *e, int keep) {
	struct es_calls *x = es_alloc(sizeof *x);
	x->e = e;
	x->keep = keep;
	x->watch = pl_watch_all(e->places, landed, x);
	x->ended = sc_on_run_end(e->scheduler, run_ended, x);
	return x;
}

static void calls_stop(struct es_calls *x) {
	if (x->watch != NULL) pl_stop(x->watch);
	if (x->ended != NULL) sc_remove_listener(x->ended);
	x->watch = NULL;
	x->ended = NULL;
}

void es_calls_stop(es_ermine *e) {
	if (e->calls != NULL) calls_stop(e->calls);
}

void es_calls_free(struct es_calls *x) {
	if (x == NULL) return;
	calls_stop(x);
	x->closing = 1;
	for (size_t i = 0; i < x->live.cap; i++) {
		if (x->live.keys[i] != NULL) going_free(x->live.vals[i]);
	}
	pm_clear(&x->live);
	pm_clear(&x->frames);
	for (size_t i = 0; i < x->records.n; i++) {
		held *h = x->records.vals[i];
		call_free(h->call);
		free(h);
	}
	es_map_free(&x->records);
	for (size_t i = 0; i < x->nwaiting; i++) waiter_free(x->waiting[i]);
	free(x->waiting);
	es_map_free(&x->armed);
	free(x->stack);
	free(x);
}

unsigned es_calls_next(es_ermine *e) { return ++e->calls->n; }

// the innermost call, when what runs now is its: no run begun inside it since
static es_going *open_call(struct es_calls *x) {
	if (x->nstack == 0) return NULL;
	es_going *g = x->stack[x->nstack - 1];
	sc_run *r = sc_get_run(x->e->scheduler);
	if (r == NULL) return g->has_run ? NULL : g;
	if (!g->has_run) return NULL;
	return sc_run_computer(r) == g->computer && sc_run_n(r) == g->run_n ? g : NULL;
}

es_going *es_calls_open(es_ermine *e) { return open_call(e->calls); }

static void landed(const pl_fact *fact, void *ctx) {
	struct es_calls *x = ctx;
	es_going *g = open_call(x);
	if (g == NULL) return;
	es_call_write w = {text(fact->part), text(fact->id), NULL};
	if (fact->change != NULL) w.change = change_value(x->e, fact->change);
	ES_PUSH(g->writes, g->nwrites, g->capwrites, w);
}

static void mark_list(struct es_calls *x) {
	const void *keys[1] = {&x->list};
	sc_mark(x->e->scheduler, keys, 1, NULL);
}

static waiter *waiter_of(struct es_calls *x, const char *caller) {
	for (size_t i = 0; i < x->nwaiting; i++) {
		if (strcmp(x->waiting[i]->caller, caller) == 0) return x->waiting[i];
	}
	return NULL;
}

// a caller's waits gone, its entry too: 1 if it had any
static int waiter_drop(struct es_calls *x, const char *caller) {
	for (size_t i = 0; i < x->nwaiting; i++) {
		if (strcmp(x->waiting[i]->caller, caller) != 0) continue;
		waiter_free(x->waiting[i]);
		memmove(x->waiting + i, x->waiting + i + 1, (x->nwaiting - i - 1) * sizeof *x->waiting);
		x->nwaiting--;
		return 1;
	}
	return 0;
}

// a computer's waits left from its earlier runs go as a run ends without them
static void run_ended(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data) {
	(void)ended;
	(void)reads;
	(void)nreads;
	(void)more;
	struct es_calls *x = data;
	const op_value *id = value_of(c, PL_NODE, OP_STR);
	if (id == NULL) return;
	waiter *w = waiter_of(x, id->str);
	if (w == NULL) return;
	int gone = 0;
	for (size_t i = 0; i < w->n;) {
		if (w->items[i].has_run && w->items[i].run == n) {
			i++;
			continue;
		}
		target_free(&w->items[i]);
		memmove(w->items + i, w->items + i + 1, (w->n - i - 1) * sizeof *w->items);
		w->n--;
		gone = 1;
	}
	if (w->n == 0) waiter_drop(x, id->str);
	if (gone) mark_list(x);
}

// a call over: its frame is no longer looked up, and the hold its beginning took is let go
static void call_over(es_going *g) {
	pm_delete(&g->x->frames, g->frame);
	going_release(g);
}

es_going *es_calls_begin(es_ermine *e, unsigned n, sc_frame *frame, struct call_info *info,
	const es_calling_view *base) {
	struct es_calls *x = e->calls;
	es_going *g = es_alloc(sizeof *g);
	g->x = x;
	g->n = n;
	g->frame = frame;
	g->info = info;
	g->refs = 1;
	sc_run *r = sc_get_run(e->scheduler);
	if (r != NULL) {
		g->has_run = 1;
		g->computer = sc_retain(sc_run_computer(r));
		g->run_n = sc_run_n(r);
	}
	g->caller = es_dup(base->caller);
	g->context = base->context;
	if (g->context != NULL) sc_retain(g->context->scope);
	g->handler = es_dup(base->handler);
	g->handler_change = op_ref((op_value *)base->handler_change);
	if (base->nargs > 0) g->args = es_alloc(base->nargs * sizeof *g->args);
	for (size_t i = 0; i < base->nargs; i++) g->args[g->nargs++] = op_ref((op_value *)base->args[i]);
	g->started = now();
	ES_PUSH(x->stack, x->nstack, x->capstack, g);
	pm_set(&x->frames, frame, g);
	pm_set(&x->live, g, g);
	return g;
}

int es_calls_calling(es_ermine *e, sc_frame *frame, es_calling_view *out) {
	for (sc_frame *o = frame; o != NULL; o = sc_frame_parent(o)) {
		es_going *g = pm_get(&e->calls->frames, o);
		if (g == NULL) continue;
		out->n = g->n;
		out->caller = g->caller;
		out->context = g->context;
		out->handler = g->handler;
		out->handler_change = g->handler_change;
		out->args = (const op_value *const *)g->args;
		out->nargs = g->nargs;
		out->started = g->started;
		return 1;
	}
	return 0;
}

// a record on its way to being held
typedef struct {
	struct es_calls *x;
	es_call *owned;
	int held;
	// its handler gone: not held
	int gone;
} keeping;

static void keep_record(void *ctx, const es_recorded *r) {
	keeping *k = ctx;
	struct es_calls *x = k->x;
	if (!x->keep || k->gone || r->call == NULL) return;
	held *h = es_map_get(&x->records, r->id);
	// the latest is the call begun last: an earlier call settling later is told, not held
	if (h != NULL && h->call != NULL && h->call->n > r->call->n) return;
	// next called again with the record held: held already
	if (h != NULL && h->call == r->call) return;
	es_call *mine = r->call == k->owned ? k->owned : call_copy(r->call);
	k->held = mine == k->owned;
	if (h == NULL) {
		h = es_alloc(sizeof *h);
		es_map_set(&x->records, r->id, h);
	}
	// the one held was the record's own, a changed record's next replacing it: let go of here
	if (h->call != NULL && h->call == k->owned) k->owned = NULL, k->held = 0;
	call_free(h->call);
	h->call = mine;
	k->held = mine == k->owned;
	const void *keys[1] = {h};
	sc_mark(x->e->scheduler, keys, 1, sc_get_run(x->e->scheduler));
}

// what a record says beyond the call so far
typedef struct {
	int has_returned;
	op_value *returned;
	const char *error;
	int has_ended;
	double ended;
} more_of;

// the call so far, ended as end says, told to onRecord and held as the handler's latest. the hook's code
static int record(es_going *g, const char *end, const more_of *m) {
	struct es_calls *x = g->x;
	es_call c = {0};
	c.n = g->n;
	c.caller = g->caller;
	c.context = g->context;
	c.handler = g->handler;
	c.handler_change = g->handler_change;
	c.args = g->args;
	c.nargs = g->nargs;
	c.end = end;
	c.has_returned = m->has_returned;
	c.returned = m->returned;
	c.error = (char *)m->error;
	c.started = g->started;
	c.has_ended = m->has_ended;
	c.ended = m->ended;
	c.reads = g->reads;
	c.nreads = g->nreads;
	c.writes = g->writes;
	c.nwrites = g->nwrites;
	c.made = g->made;
	c.nmade = g->nmade;
	c.has_site = g->has_site;
	c.site = g->site;
	keeping k = {x, call_copy(&c), 0, g->gone};
	es_recorded r = {g->handler, NULL, k.owned, NULL};
	int code = es_hook_record(x->e, &r, keep_record, &k);
	if (!k.held) call_free(k.owned);
	return code;
}

// the promise a call returned settled: its record ends
static void call_settled(void *ctx, int ok, const op_value *value, const char *error) {
	es_going *g = ctx;
	more_of m = {0};
	m.has_ended = 1;
	m.ended = now();
	if (ok) {
		m.has_returned = 1;
		m.returned = (op_value *)value;
		record(g, "done", &m);
	} else {
		m.error = error;
		record(g, "failed", &m);
	}
	going_release(g);
}

// a call ended: held as its handler's latest. the hook's code
static int end_call(es_ermine *e, es_going *g, const es_out *out) {
	struct es_calls *x = e->calls;
	for (size_t i = 0; i < x->nstack; i++) {
		if (x->stack[i] != g) continue;
		memmove(x->stack + i, x->stack + i + 1, (x->nstack - i - 1) * sizeof *x->stack);
		x->nstack--;
		break;
	}
	more_of m = {0};
	m.has_ended = 1;
	m.ended = now();
	if (out->kind == ES_OUT_PENDING) return record(g, "pending", &m);
	if (out->kind == ES_OUT_FAILED) {
		m.error = out->error;
		return record(g, "failed", &m);
	}
	es_promise *p = out->value == NULL ? NULL : es_promise_of(e, out->value);
	if (p == NULL) {
		m.has_returned = 1;
		m.returned = out->value;
		return record(g, "done", &m);
	}
	more_of unended = {0};
	int code = record(g, "pending", &unended);
	g->refs++;
	es_promise_then(p, call_settled, g);
	return code;
}

void es_calls_end(es_ermine *e, es_going *g, const es_out *out) { end_call(e, g, out); }

// a read as one string: the same read in a call is recorded once
static char *read_key(const char *part, const char *id, const op_key *path, size_t npath,
	int has_path, int keys) {
	size_t len = strlen(part) + strlen(id) + 16;
	for (size_t i = 0; i < npath; i++) len += (path[i].type == OP_STR_KEY ? strlen(path[i].s) : 0) + 48;
	char *k = es_alloc(len);
	size_t at = (size_t)snprintf(k, len, "%s\x1f%s\x1f", part, id);
	if (!has_path) at += (size_t)snprintf(k + at, len - at, "N");
	for (size_t i = 0; has_path && i < npath; i++) {
		if (path[i].type == OP_STR_KEY) {
			at += (size_t)snprintf(k + at, len - at, "s%s\x1e", path[i].s);
		} else if (path[i].type == OP_NUM_KEY) {
			at += (size_t)snprintf(k + at, len - at, "n%ld\x1e", path[i].n);
		} else {
			at += (size_t)snprintf(k + at, len - at, "r%lld,%lld\x1e", (long long)path[i].a,
				(long long)path[i].b);
		}
	}
	if (keys) snprintf(k + at, len - at, "+");
	return k;
}

void es_calls_read(es_ermine *e, const char *part, const char *id, const op_key *path, size_t npath,
	int has_path, int keys) {
	es_going *g = open_call(e->calls);
	if (g == NULL) return;
	char *k = read_key(part, id, path, npath, has_path, keys);
	int fresh = es_map_set(&g->seen, k, NULL);
	free(k);
	if (!fresh) return;
	es_call_read r = {es_dup(part), es_dup(id), has_path ? keys_copy(path, npath) : NULL,
		has_path ? npath : 0, has_path, keys, change_at(e, part, id)};
	ES_PUSH(g->reads, g->nreads, g->capreads, r);
}

void es_calls_made(es_ermine *e, const char *kind, const char *id, const char *const *path,
	size_t npath) {
	es_going *g = open_call(e->calls);
	if (g == NULL) return;
	es_made m = {kind, es_dup(id), NULL, 0};
	if (npath > 0) m.path = es_alloc(npath * sizeof *m.path);
	for (size_t i = 0; i < npath; i++) m.path[m.npath++] = es_dup(path[i]);
	ES_PUSH(g->made, g->nmade, g->capmade, m);
}

const es_call *es_calls_latest(es_ermine *e, const char *id) {
	struct es_calls *x = e->calls;
	held *h = es_map_get(&x->records, id);
	if (h == NULL) {
		h = es_alloc(sizeof *h);
		es_map_set(&x->records, id, h);
	}
	sc_track(e->scheduler, h);
	return h->call;
}

void es_calls_drop(es_ermine *e, const char *id) {
	struct es_calls *x = e->calls;
	if (x == NULL) return;
	for (size_t i = 0; i < x->live.cap; i++) {
		es_going *g = x->live.keys[i] != NULL ? x->live.vals[i] : NULL;
		if (g != NULL && strcmp(g->handler, id) == 0) g->gone = 1;
	}
	// the slot goes with its record (its address is what readers track: told once more, then gone)
	held *h = es_map_get(&x->records, id);
	if (h == NULL) return;
	const void *keys[1] = {h};
	sc_mark(e->scheduler, keys, 1, sc_get_run(e->scheduler));
	es_map_del(&x->records, id);
	call_free(h->call);
	free(h);
}

// a wait's target as one string: its path, or its id
static char *target_key(const es_aim *at) {
	if (!at->has_path) {
		size_t len = strlen(at->id) + 2;
		char *k = es_alloc(len);
		snprintf(k, len, "#%s", at->id);
		return k;
	}
	size_t len = 2;
	for (size_t i = 0; i < at->npath; i++) len += strlen(at->path[i]) + 1;
	char *k = es_alloc(len);
	strcpy(k, "/");
	for (size_t i = 0; i < at->npath; i++) {
		strcat(k, at->path[i]);
		strcat(k, "\x1f");
	}
	return k;
}

// a teardown that takes a caller's waits out as its scope goes
typedef struct {
	struct es_calls *x;
	sc_scope *scope;
	char *caller;
	char *tag;
} arming;

static char *armed_gone(void *data) {
	arming *a = data;
	struct es_calls *x = a->x;
	es_map_del(&x->armed, a->tag);
	if (!sc_scope_alive(a->scope) && waiter_drop(x, a->caller)) mark_list(x);
	free(a->caller);
	free(a->tag);
	free(a);
	return NULL;
}

// the scope told to take caller's waits out as it goes: each (caller, run) once per scope. a computer's
// teardown runs after its next run too (it still alive: the waits are run_ended's then); one registered
// per run, so none piles up
static void arm(struct es_calls *x, sc_scope *scope, const char *caller, int has_run, unsigned run) {
	size_t len = strlen(caller) + 64;
	char *tag = es_alloc(len);
	snprintf(tag, len, "%p\x1f%s\x1f%d:%u", (void *)scope, caller, has_run, has_run ? run : 0);
	if (es_map_has(&x->armed, tag)) {
		free(tag);
		return;
	}
	es_map_set(&x->armed, tag, NULL);
	arming *a = es_alloc(sizeof *a);
	a->x = x;
	a->scope = scope;
	a->caller = es_dup(caller);
	a->tag = tag;
	free(sc_register_teardown(x->e->scheduler, scope, armed_gone, a));
}

void es_calls_wait(es_ermine *e, const char *caller, const es_aim *at, sc_scope *scope) {
	struct es_calls *x = e->calls;
	waiter *w = waiter_of(x, caller);
	if (w == NULL) {
		w = es_alloc(sizeof *w);
		w->caller = es_dup(caller);
		ES_PUSH(x->waiting, x->nwaiting, x->capwaiting, w);
	}
	char *key = target_key(at);
	sc_run *r = sc_get_run(e->scheduler);
	int has_run = r != NULL;
	unsigned run = has_run ? sc_run_n(r) : 0;
	for (size_t i = 0; i < w->n; i++) {
		if (strcmp(w->items[i].key, key) != 0) continue;
		w->items[i].has_run = has_run;
		w->items[i].run = run;
		free(key);
		arm(x, scope, caller, has_run, run);
		return;
	}
	target t = {{0}, key, has_run, run};
	t.wait.caller = es_dup(caller);
	if (at->has_path) {
		t.wait.has_path = 1;
		if (at->npath > 0) t.wait.path = es_alloc(at->npath * sizeof *t.wait.path);
		for (size_t i = 0; i < at->npath; i++) t.wait.path[t.wait.npath++] = es_dup(at->path[i]);
	} else {
		t.wait.id = es_dup(at->id);
	}
	t.wait.since = now();
	ES_PUSH(w->items, w->n, w->cap, t);
	mark_list(x);
	// last: a scope going takes the wait out at once, the waiter with it
	arm(x, scope, caller, has_run, run);
}

void es_calls_answered(es_ermine *e, const char *caller, const es_aim *at) {
	struct es_calls *x = e->calls;
	waiter *w = waiter_of(x, caller);
	if (w == NULL) return;
	char *key = target_key(at);
	for (size_t i = 0; i < w->n; i++) {
		if (strcmp(w->items[i].key, key) != 0) continue;
		target_free(&w->items[i]);
		memmove(w->items + i, w->items + i + 1, (w->n - i - 1) * sizeof *w->items);
		w->n--;
		if (w->n == 0) waiter_drop(x, caller);
		mark_list(x);
		break;
	}
	free(key);
}

static void wait_copy(es_wait *to, const es_wait *from) {
	to->caller = es_dup(from->caller);
	to->has_path = from->has_path;
	if (from->npath > 0) to->path = es_alloc(from->npath * sizeof *to->path);
	for (size_t i = 0; i < from->npath; i++) to->path[to->npath++] = es_dup(from->path[i]);
	to->id = opt_dup(from->id);
	to->since = from->since;
}

es_wait *es_calls_waits(es_ermine *e, const char *caller, size_t *n) {
	struct es_calls *x = e->calls;
	sc_track(e->scheduler, &x->list);
	size_t total = 0;
	for (size_t i = 0; i < x->nwaiting; i++) {
		if (caller == NULL || strcmp(x->waiting[i]->caller, caller) == 0) total += x->waiting[i]->n;
	}
	*n = 0;
	es_wait *out = es_alloc(total * sizeof *out);
	for (size_t i = 0; i < x->nwaiting; i++) {
		waiter *w = x->waiting[i];
		if (caller != NULL && strcmp(w->caller, caller) != 0) continue;
		for (size_t j = 0; j < w->n; j++) wait_copy(&out[(*n)++], &w->items[j].wait);
	}
	return out;
}

void es_waits_free(es_wait *waits, size_t n) {
	for (size_t i = 0; i < n; i++) wait_free(&waits[i]);
	free(waits);
}

// --- actions ---------------------------------------------------------------------------------------------

// the placement of id by own, lasting while own does: own going takes it out, unless a later placement took
// over. one teardown per (own, node), however often it is placed; a computer's cleanup after a run (own
// still alive) passes it on to the next run's
typedef struct {
	struct es_actions *x;
	es_ermine *e;
	char *id;
	sc_scope *own;
	char *tag;
} keeping_placed;

static void placer_forget(keeping_placed *k) {
	es_map_del(&k->x->placers, k->tag);
	free(k->id);
	free(k->tag);
	free(k);
}

static char *placed_gone(void *data) {
	keeping_placed *k = data;
	struct es_actions *x = k->x;
	placed *p = es_map_get(&x->methods, k->id);
	if (p == NULL || p->scope != k->own) {
		placer_forget(k);
		return NULL;
	}
	if (sc_scope_alive(k->own)) {
		free(sc_register_teardown(k->e->scheduler, k->own, placed_gone, k));
		return NULL;
	}
	es_map_del(&x->methods, k->id);
	// its call record goes with it
	es_calls_drop(k->e, k->id);
	// its record with the scope, unless the node's value was already let go and the slot used again
	fnslot *slot = (fnslot *)p->fn;
	if (slot->gen == p->gen) fn_forget(x, slot);
	placed_free(p);
	placer_forget(k);
	return NULL;
}

// an action stopped by its node: its placement let go (the node's value is the caller's to take
// out first), its call record with it; its function's record with it unless the slot was used again
int es_stop_action(es_ermine *e, const char *id) {
	struct es_actions *x = e->actions;
	placed *p = es_map_get(&x->methods, id);
	if (p == NULL) return 0;
	es_map_del(&x->methods, id);
	es_calls_drop(e, id);
	fnslot *slot = (fnslot *)p->fn;
	if (slot->gen == p->gen) fn_forget(x, slot);
	placed_free(p);
	return 1;
}

typedef struct {
	es_context *c;
	const es_names *path;
	op_value *value;
	char *id;
} creating;

// the node at the path made holding the function, or its value replaced (asked "edit")
static int do_create(void *ctx) {
	creating *m = ctx;
	es_context *c = m->c;
	const char *const *names = (const char *const *)m->path->names;
	tb_key got;
	if (!pl_get(c->places, names, m->path->n, &got)) {
		return es_build(c, names, m->path->n, m->value, NULL, &m->id);
	}
	m->id = es_dup(got.string);
	gd_target target = gd_target_of((gd_thing){tb_string(m->id), names, m->path->n}, "value", NULL);
	int code = es_context_ask(c, "edit", &target, 1);
	if (code) return code;
	op_patch whole = {0};
	whole.has_value = 1;
	whole.value = m->value;
	es_write w = {0};
	w.part = "value";
	w.id = m->id;
	w.has_path = 1;
	w.path = names;
	w.npath = m->path->n;
	w.patches = &whole;
	w.npatches = 1;
	return es_context_put(c, &w);
}

static int create_action(es_context *c, es_at p, es_action fn, void *ctx, es_handle **out) {
	es_ermine *e = c->ermine;
	struct es_actions *x = e->actions;
	int code = es_alive(e);
	if (code) return code;
	sc_scope *own = es_owner(c);
	code = es_not_in_act(e, own, "createAction");
	if (code) return code;
	es_names path;
	code = es_resolve(c, p, &path);
	if (code) return code;
	fnslot *f = fn_new(x, fn, ctx);
	creating m = {c, &path, fn_value(f), NULL};
	code = es_inside(c, do_create, &m);
	op_free(m.value);
	if (code) {
		fn_forget(x, f);
		free(m.id);
		es_names_free(&path);
		return code;
	}
	// lasting while own does
	placed *was = es_map_get(&x->methods, m.id);
	placed *entry = es_alloc(sizeof *entry);
	entry->fn = &f->f;
	entry->gen = f->gen;
	entry->scope = own;
	entry->context = c;
	entry->frame = hframe_new(c, m.id, own, e->site);
	es_map_set(&x->methods, m.id, entry);
	placed_free(was);
	size_t len = strlen(m.id) + 40;
	char *tag = es_alloc(len);
	snprintf(tag, len, "%p\x1f%s", (void *)own, m.id);
	if (es_map_has(&x->placers, tag)) {
		free(tag);
	} else {
		es_map_set(&x->placers, tag, NULL);
		keeping_placed *k = es_alloc(sizeof *k);
		k->x = x;
		k->e = e;
		k->id = es_dup(m.id);
		k->own = own;
		k->tag = tag;
		free(sc_register_teardown(e->scheduler, own, placed_gone, k));
	}
	es_node_data n = {1, path.names, path.n, NULL, (char *)"value"};
	if (e->on_create_function != NULL) {
		es_created made = {"action", NULL, &n, m.id, c->node};
		e->on_create_function(e->on_create_function_ctx, &made);
	}
	es_queue_pulse(e);
	if (out != NULL) *out = es_handle_make(c, &n);
	free(m.id);
	es_names_free(&path);
	return 0;
}

int es_create_action_at(es_context *c, es_at p, es_action fn, void *ctx, es_handle **out,
	const ch_site *site) {
	if (out != NULL) *out = NULL;
	const ch_site *was = es_enter(c->ermine, site);
	int code = create_action(c, p, fn, ctx, out);
	es_enter(c->ermine, was);
	return code;
}

// the execute ask, run in the call frame
typedef struct {
	es_context *c;
	const char *id;
	const es_node_data *n;
	int code;
} asking;

static void do_ask(void *ctx) {
	asking *a = ctx;
	gd_thing thing = es_thing_of(a->id, a->n);
	gd_target target = gd_target_of(thing, "value", NULL);
	a->code = es_context_ask(a->c, "execute", &target, 1);
}

// the action's function, run in the call's frame
typedef struct {
	es_context *c;
	es_function *f;
	const op_value *const *args;
	size_t nargs;
	es_out out;
} running;

static void do_run(void *ctx) {
	running *r = ctx;
	r->out = r->f->fn(r->c, r->f->ctx, r->args, r->nargs);
}

// a call over, its frame let go: the record's end (a promise's when it settles)
typedef struct {
	es_ermine *e;
	es_going *g;
} ending;

static void call_ended(void *ctx, int ok, const op_value *value, const char *error) {
	(void)ok;
	(void)value;
	(void)error;
	ending *g = ctx;
	call_over(g->g);
	es_queue_pulse(g->e);
	free(g);
}

// the call's frame: its info { caller: { node, actor }, handler, call }, the values held by the
// record till it is freed (a frame borrows its info), made alone under the scope the call runs in
// (under's own frame), or under the handler's frame (up: the placed function is the one called, so its
// writes take the handler's site). the record frees it (call_over lets go the hold its beginning took)
static sc_frame *call_frame(es_context *c, const char *id, unsigned k, sc_scope *under, hframe *up,
	call_info **held) {
	es_ermine *e = c->ermine;
	op_value *caller = op_map();
	op_set(caller, "node", op_str(c->node));
	const op_value *actor = actor_here(c);
	if (actor != NULL) op_set(caller, "actor", op_ref((op_value *)actor));
	op_value *handler = op_str(id), *call = op_num((double)k);
	sc_pair pairs[3] = {{"caller", caller}, {"handler", handler}, {"call", call}};
	call_info *info = es_alloc(sizeof *info);
	*info = (call_info){{caller, handler, call}, 3, up};
	if (up != NULL) up->refs++;
	*held = info;
	return sc_create_frame(e->scheduler, pairs, 3, up != NULL ? up->frame : sc_scope_frame(under));
}

// the action f found at n (id): asked "execute" in a call frame, run there, its record held
static int call_action(es_context *c, const es_node_data *n, const char *id,
	es_function *f, const op_value *const *args, size_t nargs, op_value **out, const ch_site *site) {
	es_ermine *e = c->ermine;
	// the placement's scope while the node still holds what was placed; else (its owner gone, or a
	// function written there by edit) the sender's, as any function value
	placed *p = es_map_get(&e->actions->methods, id);
	int mine = p != NULL && p->fn == f && p->gen == ((fnslot *)f)->gen;
	unsigned k = es_calls_next(e);
	// what the action makes is under's; what a change it makes is made as is the call's, under the
	// handler's frame. where it was called from (the click): found up the caller's frame open, else site
	sc_scope *under = mine ? p->scope : c->scope;
	ch_site found;
	const ch_site *from = es_site_up(e, es_open_frame(c), site, &found);
	call_info *held;
	sc_frame *call = call_frame(c, id, k, under, mine ? p->frame : NULL, &held);
	asking a = {c, id, n, 0};
	const char *bad = sc_run_with(under, call, do_ask, &a);
	int code = bad != NULL ? es_fail_text(bad) : a.code;
	if (code) {
		sc_free_frame(call);
		call_info_free(held);
		return code;
	}
	op_value *called = change_at(e, "value", id);
	es_calling_view base = {k, c->node, c, id, called, args, nargs, 0};
	es_going *g = es_calls_begin(e, k, call, held, &base);
	if (from != NULL) {
		g->has_site = 1;
		g->site = *from;
	}
	op_free(called);
	// the call's frame lasts as the record does: a promise's till it settles (the record ended
	// first), else till the handler returns or throws
	running r = {mine ? p->context : c, f, args, nargs, es_out_of(NULL)};
	bad = sc_run_with(under, call, do_run, &r);
	if (bad != NULL) r.out = es_out_failed(es_dup(bad));
	if (r.out.kind == ES_OUT_FAILED) {
		// what was thrown, if it still is (a Refusal keeps its class through the call)
		const es_error *thrown = es_thrown();
		int thrown_code = thrown->code != 0 && thrown->message != NULL && r.out.error != NULL &&
			strcmp(thrown->message, r.out.error) == 0 ? thrown->code : 0;
		end_call(e, g, &r.out);
		call_over(g);
		es_queue_pulse(e);
		if (thrown_code != 0) {
			thrown = es_thrown();
			if (thrown->code != thrown_code || thrown->message == NULL ||
				strcmp(thrown->message, r.out.error) != 0) {
				es_fail(thrown_code, "%s", r.out.error);
			}
			code = thrown_code;
		} else {
			code = es_fail_text(r.out.error);
		}
		free(r.out.error);
		return code;
	}
	if (r.out.kind == ES_OUT_PENDING) {
		end_call(e, g, &r.out);
		call_over(g);
		es_queue_pulse(e);
		return ES_PENDING;
	}
	code = end_call(e, g, &r.out);
	if (code) {
		call_over(g);
		es_queue_pulse(e);
		op_free(r.out.value);
		return code;
	}
	es_promise *promise = r.out.value == NULL ? NULL : es_promise_of(e, r.out.value);
	if (promise != NULL) {
		ending *done = es_alloc(sizeof *done);
		done->e = e;
		done->g = g;
		es_promise_then(promise, call_ended, done);
	} else {
		call_over(g);
	}
	es_queue_pulse(e);
	*out = r.out.value;
	return 0;
}

static int execute_action(es_context *c, es_target x, const op_value *const *args, size_t nargs,
	op_value **out, const ch_site *site) {
	es_ermine *e = c->ermine;
	int code = es_alive(e);
	if (code) return code;
	// the action: resolved and asked as c, the caller
	es_node_data n;
	code = es_node_of(c, x, &n);
	if (code) return code;
	const char *found;
	char *id = es_id_of(c, &n, &found) ? es_dup(found) : NULL;
	es_aim at = {n.has_path ? NULL : n.id, n.has_path, (const char *const *)n.path, n.npath};
	// in a run, the computer waits; else whoever this context is
	sc_run *run = sc_get_run(e->scheduler);
	sc_computer *computer = run == NULL ? NULL : sc_run_computer(run);
	const op_value *by = computer == NULL ? NULL : value_of(computer, PL_NODE, OP_STR);
	const char *caller = by != NULL ? by->str : c->node;
	// tracked in a run, so the handler coming reruns it
	const op_value *value =
		id != NULL ? pl_read(c->places, tb_string("value"), tb_string(id), NULL, 0) : NULL;
	if (pl_status(c->places) != SC_OK) {
		code = ES_STOP;
	} else if (value == NULL) {
		// lasting while the caller does: a computer's with it, else the context's. the path: from the root
		es_calls_wait(e, caller, &at, computer != NULL ? computer : c->scope);
		code = ES_PENDING;
	} else if (fn_of(e->actions, value) == NULL) {
		char *where = n.has_path ? es_join(CP(n.path), n.npath) : NULL;
		code = es_fail(ES_NOT_A_METHOD, "not-a-method (%s)",
			where != NULL ? where : "a node it was handed");
		free(where);
	} else {
		es_function *f = &fn_of(e->actions, value)->f;
		es_calls_answered(e, caller, &at);
		code = call_action(c, &n, id, f, args, nargs, out, site);
	}
	free(id);
	es_node_data_free(&n);
	return code;
}

int es_execute_action_at(es_context *c, es_target x, const op_value *const *args, size_t nargs,
	op_value **out, const ch_site *site) {
	*out = NULL;
	const ch_site *was = es_enter(c->ermine, site);
	int code = execute_action(c, x, args, nargs, out, site);
	es_enter(c->ermine, was);
	return code;
}

// a pair of a frame's info that is an op_value of this type
static const op_value *frame_value_of(const sc_frame *o, const char *key, op_type type) {
	const op_value *v = es_frame_pair_of(o, key);
	return v != NULL && v->type == type ? v : NULL;
}

// the call open now: its frame's info names its caller (execute's call frame)
int es_get_caller(es_context *c, es_caller *out) {
	es_ermine *e = c->ermine;
	*out = (es_caller){0};
	for (sc_frame *o = es_open_frame(c); o != NULL; o = sc_frame_parent(o)) {
		if (es_frame_pair_of(o, "call") == NULL || es_frame_pair_of(o, "handler") == NULL) continue;
		const op_value *caller = frame_value_of(o, "caller", OP_MAP);
		const op_value *node = caller == NULL ? NULL : op_get(caller, "node");
		out->actor = caller == NULL ? NULL : op_get(caller, "actor");
		if (node != NULL && node->type == OP_STR && es_seen_in(e, c, node->str, &out->process)) {
			out->has_process = 1;
		}
		return 1;
	}
	return 0;
}

int es_caller_place(void *ctx, const char *const **from, size_t *nfrom, tb_key *box) {
	es_context *c = ctx;
	es_ermine *e = c->ermine;
	for (sc_frame *o = sc_get_current_frame(e->scheduler); o != NULL; o = sc_frame_parent(o)) {
		if (es_frame_pair_of(o, "call") == NULL || es_frame_pair_of(o, "handler") == NULL) continue;
		const op_value *caller = frame_value_of(o, "caller", OP_MAP);
		const op_value *node = caller == NULL ? NULL : op_get(caller, "node");
		*from = NULL;
		*nfrom = 0;
		if (node == NULL || node->type != OP_STR || strcmp(node->str, e->node) == 0) return 1;
		es_context *by = es_process_context_of(e, node->str);
		if (by != NULL && by->process != NULL) {
			*from = (const char *const *)by->at, *nfrom = by->nat;
			if (by->box != NULL) *box = tb_string(by->box);
		}
		return 1;
	}
	return 0;
}

void es_caller_free(es_caller *c) {
	if (c == NULL) return;
	if (c->has_process) es_names_free(&c->process);
	c->has_process = 0;
}

// --- teardowns ---------------------------------------------------------------------------------------------

typedef struct {
	es_context *c;
	sc_scope *own;
	es_teardown fn;
	void *ctx;
} tearing;

// why a teardown's scope goes: a stop's reason; else, the process still there, its owner ran again
// (replaced), or ended
static char *torn(void *data) {
	tearing *t = data;
	es_ermine *e = t->c->ermine;
	const char *why = es_why_of(e, t->c->node);
	if (why == NULL) why = !sc_scope_alive(t->c->scope) ? "ended" : "replaced";
	int code = es_hook_teardown(e, t->own, why, t->fn, t->ctx);
	// the error as the scheduler carries it; what was thrown stays in es_thrown() for whoever tears down
	char *err = NULL;
	if (code) {
		const es_error *thrown = es_thrown();
		err = es_dup(thrown->message != NULL ? thrown->message : es_code_name(code));
	}
	free(t);
	return err;
}

// fn as own goes
static int teardown_on(es_context *c, sc_scope *own, es_teardown fn, void *ctx) {
	tearing *t = es_alloc(sizeof *t);
	t->c = c;
	t->own = own;
	t->fn = fn;
	t->ctx = ctx;
	char *err = sc_register_teardown(c->ermine->scheduler, own, torn, t);
	int code = 0;
	if (err != NULL) {
		code = es_fail_text(err);
		free(err);
	}
	return code;
}

int es_add_teardown(es_context *c, es_teardown fn, void *ctx) {
	es_ermine *e = c->ermine;
	int code = es_alive(e);
	if (code) return code;
	sc_scope *own = es_owner(c);
	code = es_not_in_act(e, own, "addTeardown");
	if (code) return code;
	// in an action: a call's frame is open between the frame open and own's
	sc_frame *ours = sc_scope_frame(own);
	for (sc_frame *o = sc_get_current_frame(e->scheduler); o != NULL && o != ours; o = sc_frame_parent(o)) {
		if (es_frame_pair_of(o, "call") != NULL) {
			return es_fail_ermine(ES_NOT_HERE,
				"addTeardown in an action: add it in setup, or keep what the call started and stop it from setup's teardown");
		}
	}
	return teardown_on(c, own, fn, ctx);
}

int es_cleanup(es_context *c, es_teardown fn, void *ctx) {
	es_ermine *e = c->ermine;
	int code = es_alive(e);
	if (code) return code;
	sc_scope *act = es_acting(e);
	// an action called from the act is between: what it makes is its owner's, not the effect's
	if (act == NULL || es_owner(c) != act) {
		return es_fail_ermine(ES_NOT_HERE, "a cleanup is given from an effect's act");
	}
	return teardown_on(c, act, fn, ctx);
}

// --- writer ------------------------------------------------------------------------------------------------------

static void writer_free(writer_rec *b) {
	hframe_drop(b->frame);
	for (size_t i = 0; i < b->nmark; i++) op_free(b->mark[i]);
	free(b);
}

// a parent gone: every writer made in it
static char *writer_gone(void *data) {
	writer_owner *o = data;
	for (size_t i = 0; i < o->n; i++) {
		pm_delete(&o->x->writers, o->bs[i]);
		writer_free(o->bs[i]);
	}
	pm_delete(&o->x->owners, o->parent);
	free(o->bs);
	free(o);
	return NULL;
}

static const char *const MARK_KEYS[3] = {"caller", "handler", "call"};

int es_create_writer_at(es_context *c, op_value **writer, const ch_site *site) {
	es_ermine *e = c->ermine;
	struct es_actions *x = e->actions;
	*writer = NULL;
	int code = es_alive(e);
	if (code) return code;
	sc_scope *own = es_owner(c);
	if (own == NULL || !sc_scope_alive(own)) {
		return es_fail_ermine(ES_GONE, "gone: what this writer was created in has ended");
	}
	const op_value *node = value_of(own, PL_NODE, OP_STR);
	if (node != NULL && es_is_computer(e, node->str)) {
		return es_fail_ermine(ES_NOT_HERE,
			"createWriter in a memo or effect: create it in setup or an action, and use the writer there");
	}
	writer_rec *b = es_alloc(sizeof *b);
	b->x = x;
	b->c = c;
	b->parent = own;
	b->serial = ++x->serials;
	b->frame = hframe_new(c, NULL, own, site);
	// the mark it is made under: the frame open when it is not own's (a call's, a writer's run's)
	sc_frame *at = sc_get_current_frame(e->scheduler);
	if (at != NULL && at != sc_scope_frame(own)) {
		for (size_t i = 0; i < 3; i++) {
			const op_value *v = es_frame_pair_of(at, MARK_KEYS[i]);
			if (v != NULL) b->mark[b->nmark++] = op_ref((op_value *)v);
		}
	}
	writer_owner *o = pm_get(&x->owners, own);
	if (o == NULL) {
		o = es_alloc(sizeof *o);
		o->x = x;
		o->parent = own;
		pm_set(&x->owners, own, o);
		free(sc_register_teardown(e->scheduler, own, writer_gone, o));
	}
	ES_PUSH(o->bs, o->n, o->cap, b);
	b->owner = o;
	pm_set(&x->writers, b, b);
	op_value *kind = op_map();
	op_set(kind, "live", op_str("runner"));
	op_set(kind, "at", op_bytes(&b, sizeof b));
	op_set(kind, "serial", op_num((double)b->serial));
	*writer = op_stand(kind);
	return 0;
}

// the writer a value is the stand-in of; NULL: none (*gone 1: one that ended)
static writer_rec *writer_found(es_ermine *e, const op_value *v, int *gone) {
	*gone = 0;
	writer_rec *b = es_live_of(v, "runner");
	if (b == NULL) return NULL;
	const op_value *serial = op_get(v->items[0], "serial");
	writer_rec *there = pm_get(&e->actions->writers, b);
	double n;
	if (there == NULL || serial == NULL || !op_as_double(serial, &n) || (uint64_t)n != there->serial) {
		*gone = 1;
		return NULL;
	}
	return there;
}

void es_drop_writer(es_ermine *e, const op_value *writer) {
	int gone;
	writer_rec *b = writer_found(e, writer, &gone);
	if (b == NULL) return;
	writer_owner *o = b->owner;
	for (size_t i = 0; i < o->n; i++) {
		if (o->bs[i] != b) continue;
		o->bs[i] = o->bs[--o->n];
		break;
	}
	pm_delete(&b->x->writers, b);
	writer_free(b);
}

typedef struct {
	es_thunk f;
	void *ctx;
	int code;
} later_call;

static void later_run(void *data) {
	later_call *l = data;
	l->code = l->f(l->ctx);
}

int es_with_writer(es_ermine *e, const op_value *writer, es_thunk f, void *ctx) {
	int code = es_alive(e);
	if (code) return code;
	int gone;
	writer_rec *b = writer_found(e, writer, &gone);
	if (b == NULL && !gone) {
		return es_fail_ermine(ES_NOT_A_FUNCTION, "a writer is needed");
	}
	if (f == NULL) return es_fail_ermine(ES_NOT_A_FUNCTION, "a writer takes a function");
	if (sc_get_current_scope(e->scheduler) != NULL || sc_get_run(e->scheduler) != NULL) {
		return es_fail_ermine(ES_ALREADY_INSIDE,
			"already inside a run: call it directly (a writer is for code that runs with nothing open)");
	}
	if (b == NULL || !sc_scope_alive(b->parent) || !sc_scope_alive(b->c->scope)) {
		return es_fail_ermine(ES_GONE, "gone: what this writer was created in has ended");
	}
	int during = e->user_activated != NULL && e->user_activated(e->user_activated_ctx);
	sc_scope *at = b->parent;
	hframe *under = b->frame;
	under->refs++;
	sc_frame *frame = under->frame;
	call_info *info = NULL;
	// f may free b (it lets its writer go, or stops what it was created in): nothing of b is read after it
	int own_mark = b->nmark > 0 || during;
	if (own_mark) {
		// a frame of its own for this run: the writer's info, and userActivated
		info = es_alloc(sizeof *info);
		sc_pair pairs[4];
		size_t n = 0;
		for (size_t i = 0; i < b->nmark; i++) {
			info->values[info->n++] = op_ref(b->mark[i]);
			pairs[n++] = (sc_pair){MARK_KEYS[i], info->values[i]};
		}
		if (during) {
			info->values[info->n++] = op_bool(1);
			pairs[n++] = (sc_pair){"userActivated", info->values[info->n - 1]};
		}
		frame = sc_create_frame(e->scheduler, pairs, n, under->frame);
	}
	later_call l = {f, ctx, 0};
	const char *bad = sc_run_with(at, frame, later_run, &l);
	if (own_mark) {
		sc_free_frame(frame);
		call_info_free(info);
		es_queue_pulse(e);
	}
	hframe_drop(under);
	if (bad != NULL) return es_fail_text(bad);
	return l.code;
}
