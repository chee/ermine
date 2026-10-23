// run (typescript/run.ts), in C: a program on a runner, as a process. what a run asks of the program
// and the runner (its form, its hash), then the process: run at a path, loaded live with no process,
// stopped, and the reasons it is stopped with. sw_run_at, sw_load_at, sw_release_at, sw_stop_at,
// sw_wait, sw_land, sw_loading and sw_hash_hex are software.h's. which question: how a program runs
// on a runner
#include "common.h"

#include "../../../ermine/types/c/types.h"

static const op_value *attributes_of(const sw *s, const char *id) {
	const nd_entry *e = tb_get(s->s.table, tb_string("attributes"), tb_string(id));
	return e != NULL && sw_is_map(e->value) ? e->value : NULL;
}

static void set_reason(owner *p, const op_value *v) {
	op_value *was = p->reason;
	p->reason = v != NULL ? op_ref((op_value *)v) : NULL;
	op_free(was);
}

static void stop_handle(owner *p, const op_value *reason) {
	if (!p->has_handle) return;
	p->has_handle = 0;
	if (p->stop_reason != NULL) p->stop_reason(p->handle.ctx, reason);
	else if (p->handle.stop != NULL) p->handle.stop(p->handle.ctx);
}

// why a process goes: told by a stop; else its runner's offer going, the offer's why (none:
// "runner-stopped"); else none
static const op_value *reason_of(owner *p) {
	if (p->told) return p->reason;
	if (p->on != NULL && !sc_scope_alive(p->on->scope)) {
		return p->on->why != NULL ? p->on->why : p->sw->reasons[R_RUNNER];
	}
	return NULL;
}

// its stopper going: its handle's stop with its reason
static char *stopper_gone(void *data) {
	owner *p = data;
	stop_handle(p, reason_of(p));
	return NULL;
}

// its own scope torn down alone (from above it, by a host): where it runs goes too
static char *scope_gone(void *data) {
	owner *p = data;
	return sc_teardown(p->under);
}

// a process going (its stop, as processes' start calls it, or its scope torn down from above): out
// of the lists. what goes with it is its scope's. sw_free's: its handle's stop, no reason
static void process_end(pr_process *life, void *data) {
	(void)life;
	owner *p = data;
	sw *s = p->sw;
	if (p->ended) return;
	p->ended = 1;
	if (s->freeing) {
		stop_handle(p, NULL);
		return;
	}
	DROP(s->running, s->nrunning, p);
	sw_changed(s);
}

static sc_out fail_f(void *previous, void *data) {
	(void)previous;
	return (sc_out){.kind = SC_FAILED, .error = sw_xdup(data)};
}
static sc_out await_f(void *previous, void *data) {
	(void)previous;
	return (sc_out){.kind = SC_AWAIT, .promise = data};
}
static char *no_set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}

typedef struct {
	owner *p;
	hf_run out;
	sc_computer *outcome;
} calling;

// an owner's facts, as its runner is handed them (software.ts' startOf): a process's from its life;
// a place's box setup's places, its args none, its cwd its path's folder
static sw_starting starting_of(owner *o) {
	sw *s = o->sw;
	sw_starting st = {.scheduler = s->s.scheduler, .table = s->s.table, .scope = o->scope,
		.software = s};
	st.process.id = o->id;
	st.process.at = (const char *const *)o->at;
	st.process.nat = o->nat;
	if (o->run) {
		st.places = pr_places(o->life);
		st.root = pr_root(o->life);
		st.process.nargs = pr_args(o->life, &st.process.args);
		st.process.ncwd = pr_cwd(o->life, &st.process.cwd);
	} else {
		st.places = s->s.places;
		st.root = pl_root(s->s.places).string;
		st.process.cwd = (const char *const *)o->cwd;
		st.process.ncwd = o->ncwd;
	}
	return st;
}

// the runner called with the code and the start's facts: the process's scope open
static void call_runner(void *data) {
	calling *c = data;
	owner *p = c->p;
	sw_starting st = starting_of(p);
	c->out = p->fn.runner(p->code, &st, p->fn.data);
}

// a computer that fails with the runner's failure, under the scope open
static void make_outcome(void *data) {
	calling *c = data;
	c->outcome = sc_create_computer(c->p->sw->s.scheduler,
		(sc_def){.f = fail_f, .set = no_set, .data = c->p->failure}, NULL, 0);
}

// a computer that awaits the late handle's promise, under the scope open
static void make_waiting(void *data) {
	calling *c = data;
	c->outcome = sc_create_computer(c->p->sw->s.scheduler,
		(sc_def){.f = await_f, .set = no_set, .data = c->p->late->promise}, NULL, 0);
}

// a handle given: held, its stop its stopper's teardown; gone already, stopped now with its reason.
// no stop in it: nothing
static void hold(owner *p, hf_run out) {
	if (out.handle.stop == NULL && out.stop_reason == NULL) return;
	p->handle = out.handle;
	p->stop_reason = out.stop_reason;
	p->has_handle = 1;
	if (!sc_scope_alive(p->stopper)) stop_handle(p, reason_of(p));
}

// the runner's start called, the process's scope open. a handle at once: held; a failure: a
// computer that fails with it; a late one (sw_wait): a computer awaiting it. its status the node's
static void begin(owner *p) {
	sw *s = p->sw;
	if (p->ended) return;
	calling c = {.p = p};
	owner *was = s->calling;
	s->calling = p;
	sc_run_with_scope(p->scope, call_runner, &c);
	s->calling = was;
	if (p->late != NULL) {
		free(c.out.error);
		if (p->ended) return;
		sc_run_with_scope(p->scope, make_waiting, &c);
		if (c.outcome != NULL) pr_give(s->life, p->life, c.outcome, 0);
		return;
	}
	if (c.out.error != NULL) {
		free(p->failure);
		p->failure = c.out.error;
		if (p->ended) return;
		sc_run_with_scope(p->scope, make_outcome, &c);
		if (c.outcome != NULL) pr_give(s->life, p->life, c.outcome, 0);
		return;
	}
	hold(p, c.out);
}

// a built program's first run: its build's read, tracked (a value given NULL: null)
static sc_out build_f(void *previous, void *data) {
	(void)previous;
	owner *p = data;
	sc_out out = p->build(p->build_data);
	if (out.kind == SC_VALUE && out.value == NULL) out.value = op_null();
	return out;
}

// the one act: the runner called (built: with what build gave), then the effect gone
static char *run_act(void *value, void *previous, void *data) {
	(void)previous;
	owner *p = data;
	if (p->build != NULL && p->code == NULL && value != NULL) p->code = op_ref(value);
	begin(p);
	free(sc_teardown(p->first));
	return NULL;
}

// in the process's scope, as processes' start gives it: its stopper beside its scope (newer, so it
// goes before it: what its program made told the reason; what it offers, newer still, before
// that), it running, and the effect that calls the runner at the first pulse, its status (and run)
// the node's
static void process_body(pr_process *life, void *data) {
	owner *p = data;
	sw *s = p->sw;
	p->life = life;
	p->id = sw_xdup(pr_id(life));
	const char *const *at;
	p->nat = pr_at(life, &at);
	p->at = sw_copy_names(at, p->nat);
	p->scope = pr_scope(life);
	const sc_info *info = sc_scope_info(p->scope);
	p->stopper = sc_create_scope(s->s.scheduler, info->pairs, info->n, p->under);
	ch_site buf;
	const ch_site *here = sw_site(s, &buf);
	if (s->s.sites != NULL && here != NULL && here->file != NULL) {
		st_note(s->s.sites, p->stopper, here->file, (int)here->line, here->function);
	}
	free(sc_register_teardown(s->s.scheduler, p->stopper, stopper_gone, p));
	free(sc_register_teardown(s->s.scheduler, p->scope, scope_gone, p));
	sw_holder(s, p);
	PUSH(s->running, s->nrunning, s->caprunning, p);
	// core candidate (scheduler): an effect that acts once and goes. built: its read makes the code,
	// the process pending while it is
	p->first = sc_create_effect(s->s.scheduler,
		(sc_def){.f = p->build != NULL ? build_f : sw_once_f, .effect = run_act, .data = p}, NULL, 0);
	if (p->first != NULL) pr_give(s->life, life, p->first, 1);
}

// the checks ---------------------------------------------------------------------------------------

// what a run found, as it checks: the runner (its function's name; carried, its live form), the
// program, its code (built: its build), its form, its hash
typedef struct {
	char **rpath;
	size_t nr;
	char *rid;
	const char *rname;
	const hf_entry *rlive;
	char **ppath;
	size_t npp;
	char *pid;
	const op_value *code;
	const op_value *type, *api;
	op_value *own_type, *own_api;
	int carried, hashed;
	sc_out (*build)(void *data);
	void *build_data;
	char hex[65];
} found;

// a runner as given: an address from setup's places' root, or carried
typedef struct {
	const char *const *at;
	size_t nat;
	const sw_carried *carried;
} given;

static void found_free(found *f) {
	if (f->rpath != NULL) pr_names_free(f->rpath, f->nr);
	if (f->ppath != NULL) pr_names_free(f->ppath, f->npp);
	free(f->rid);
	free(f->pid);
	op_free(f->own_type);
	op_free(f->own_api);
}

typedef struct {
	pl *places;
	const char *const *path;
	size_t n;
	char *id;
} getting;

// the id at the path (a string), copied
static void get_now(void *data) {
	getting *g = data;
	tb_key id;
	if (pl_get(g->places, g->path, g->n, &id) && id.symbol == NULL) g->id = sw_xdup(id.string);
}

// the id at a path from the places' root, untracked; NULL: nothing there
static char *resolve(pl *p, const char *const *path, size_t n) {
	getting g = {p, path, n, NULL};
	pl_peep(p, get_now, &g);
	return g.id;
}

// a value the same as another, as === has it: a scalar's value (a number's as op_same_num has it);
// anything else is only itself
static int same_scalar(const op_value *a, const op_value *b) {
	if (a == NULL || b == NULL) return a == b;
	if (a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return op_same_num(a, b);
	case OP_STR: return strcmp(a->str, b->str) == 0;
	default: return a == b;
	}
}

// the type of a program at its place, untracked (types' ty_type_of)
typedef struct {
	pl *places;
	const char *id;
	const char *const *at;
	size_t nat;
	char *type;
} typing;

static void type_now(void *data) {
	typing *t = data;
	t->type = ty_type_of(t->places, t->id, t->at, t->nat, NULL);
}

// whether a takes (a string, or a list of them) holds a type
static int takes_has(const op_value *takes, const char *type) {
	if (sw_is_str(takes)) return strcmp(takes->str, type) == 0;
	if (takes == NULL || takes->type != OP_LIST) return 0;
	for (size_t i = 0; i < takes->count; i++) {
		if (sw_is_str(takes->items[i]) && strcmp(takes->items[i]->str, type) == 0) return 1;
	}
	return 0;
}

// whether a type fits what a runner takes: one is it, or one it conforms to, by the nearest
// ermine/types from a folder in where (from), untracked
typedef struct {
	pl *places;
	const char *const *from;
	size_t nfrom;
	const char *type;
	const op_value *takes;
	int fits;
} fitting;

static void fit_now(void *data) {
	fitting *f = data;
	ty_folder folder;
	int has = ty_at(f->places, f->from, f->nfrom, &folder);
	ty_conformance c = ty_conform(f->places, has ? &folder : NULL, f->type);
	for (size_t i = 0; i < c.n && !f->fits; i++) f->fits = takes_has(f->takes, c.all[i]);
	ty_conformance_free(&c);
	if (has) ty_folder_free(&folder);
}

static int fits(pl *where, const char *const *from, size_t nfrom, const char *type,
	const op_value *takes) {
	if (takes_has(takes, type)) return 1;
	fitting f = {where, from, nfrom, type, takes, 0};
	pl_peep(where, fit_now, &f);
	return f.fits;
}

// a takes' strings, copied, for a refusal (a string: a list of one); none: NULL, *n 0
static char **takes_names(const op_value *takes, size_t *n) {
	*n = 0;
	if (sw_is_str(takes)) {
		*n = 1;
		return sw_copy_names((const char *const *)&takes->str, 1);
	}
	if (takes == NULL || takes->type != OP_LIST) return NULL;
	char **names = sw_xalloc((takes->count + 1) * sizeof *names);
	for (size_t i = 0; i < takes->count; i++) {
		if (sw_is_str(takes->items[i])) names[(*n)++] = sw_xdup(takes->items[i]->str);
	}
	if (*n == 0) free(names), names = NULL;
	return names;
}

// refused not-there: the program's path (held), or its id
static int not_there_at(sw *s, found *f, sw_refusal *r) {
	r->refused = "not-there";
	r->program_has_at = 1;
	r->program_at = sw_keep_names(s, f->ppath, f->npp);
	r->nprogram_at = f->npp;
	f->ppath = NULL;
	return 0;
}
static int not_there_id(sw *s, found *f, sw_refusal *r) {
	r->refused = "not-there";
	r->program = sw_keep_text(s, f->pid);
	return 0;
}

// the program: its node (or the code carried, or its build), its code read once, its form. to_load:
// a build is not read. 0: refused
static int program_of(sw *s, pl *where, const sw_program *program, int to_load, found *f,
	sw_refusal *r) {
	const nd_entry *e;
	int built = !to_load && program->code == NULL && program->build != NULL;
	f->carried = !program->has_at && (program->code != NULL || built);
	if (!program->has_at && built) f->build = program->build, f->build_data = program->build_data;
	if (program->has_at) {
		f->ppath = pr_names(program->at, program->nat, &f->npp);
		f->pid = resolve(where, (const char *const *)f->ppath, f->npp);
		e = f->pid != NULL ? tb_get(s->s.table, tb_string("value"), tb_string(f->pid)) : NULL;
		if (e == NULL) return not_there_at(s, f, r);
		f->code = e->value;
	} else {
		f->pid = sw_xdup(program->id != NULL ? program->id : "");
		if (f->carried) f->code = program->code;
		else {
			e = tb_get(s->s.table, tb_string("value"), tb_string(f->pid));
			if (e == NULL) return not_there_id(s, f, r);
			f->code = e->value;
		}
	}
	f->hashed = f->code != NULL && sw_hash_hex(f->code, f->hex);
	if (!program->has_at && program->hash != NULL &&
		(!f->hashed || strcmp(program->hash, f->hex) != 0))
		return not_there_id(s, f, r);
	if (f->carried) {
		f->type = f->own_type = program->type != NULL ? op_str(program->type) : NULL;
		f->api = f->own_api = program->api != NULL ? op_str(program->api) : NULL;
	} else {
		const op_value *attrs = attributes_of(s, f->pid);
		f->type = sw_get(attrs, SW_ATTRIBUTE);
		f->api = sw_get(attrs, SW_PROGRAM_API);
	}
	// by its path: its ermine.type, else its name's
	if (program->has_at) {
		typing t = {where, f->pid, (const char *const *)f->ppath, f->npp, NULL};
		pl_peep(where, type_now, &t);
		f->type = f->own_type = t.type != NULL ? op_str(t.type) : NULL;
		free(t.type);
	}
	return 1;
}

// refused not-a-runner: the runner's path, held; carried, its id
static int not_a_runner(sw *s, found *f, sw_refusal *r) {
	r->refused = "not-a-runner";
	if (f->rpath == NULL) r->runner_id = sw_keep_text(s, f->rid);
	else {
		r->runner = sw_keep_names(s, f->rpath, f->nr);
		r->nrunner = f->nr;
		f->rpath = NULL;
	}
	found_free(f);
	return 0;
}

// the checks in order, up to taken (processes'): the runner and its entry, the program read once.
// to_load: a runner with no load is not-a-runner. carried: its id alone, its form the caller's. 0:
// refused, f let go; 1: f the caller's to let go
static int check(sw *s, const given *runner, const sw_program *program, pl *where, int to_load,
	found *f, const hf_entry **out, sw_refusal *refused) {
	*refused = (sw_refusal){0};
	const op_value *rattrs = NULL;
	if (runner->carried != NULL) {
		f->rid = sw_xdup(runner->carried->id != NULL ? runner->carried->id : "");
		f->rlive = runner->carried->live;
	} else {
		f->rpath = pr_names(runner->at, runner->nat, &f->nr);
		f->rid = resolve(s->s.places, (const char *const *)f->rpath, f->nr);
		rattrs = f->rid != NULL ? attributes_of(s, f->rid) : NULL;
		const op_value *rtype = sw_get(rattrs, SW_ATTRIBUTE);
		if (!sw_is_str(rtype) || strcmp(rtype->str, SW_TYPE_RUNNER) != 0) {
			return not_a_runner(s, f, refused);
		}
	}
	if (!program_of(s, where, program, to_load, f, refused)) return found_free(f), 0;
	// its type fits from its folder; by id, or carried, from where's root. a carried runner's form
	// is its caller's
	const op_value *takes = sw_get(rattrs, SW_TAKES), *gives = sw_get(rattrs, SW_API);
	size_t nfrom = f->ppath != NULL && f->npp > 0 ? f->npp - 1 : 0;
	int fit = runner->carried != NULL || (sw_is_str(f->type) &&
		fits(where, (const char *const *)f->ppath, nfrom, f->type->str, takes));
	if (runner->carried == NULL && fit && f->api != NULL && !same_scalar(f->api, gives)) fit = 0;
	if (!fit) {
		refused->refused = "wrong-form";
		refused->type = sw_is_str(f->type) ? sw_keep_text(s, f->type->str) : NULL;
		refused->api = sw_is_str(f->api) ? sw_keep_text(s, f->api->str) : NULL;
		char **names = takes_names(takes, &refused->ntakes);
		refused->takes = names != NULL ? sw_keep_names(s, names, refused->ntakes) : NULL;
		refused->runner_api = sw_is_str(gives) ? sw_keep_text(s, gives->str) : NULL;
		found_free(f);
		return 0;
	}
	// a runner: one with a start (runnerOf's), and, to load, a load
	const hf_entry *fn = f->rlive;
	const nd_entry *fv = NULL;
	if (runner->carried == NULL) {
		fv = tb_get(s->s.table, tb_string("value"), tb_string(f->rid));
		fn = fv != NULL ? hf_find(s->s.functions, fv->value) : NULL;
	}
	if (fn == NULL || fn->runner == NULL || (to_load && fn->load == NULL)) {
		return not_a_runner(s, f, refused);
	}
	f->rname = fv != NULL ? hf_name(fv->value) : NULL;
	*out = fn;
	return 1;
}

// run ----------------------------------------------------------------------------------------------

static sw_process *run_now(sw *s, const given *runner, const sw_program *program,
	const char *const *at, size_t nat, const sw_options *options, sw_refusal *refused) {
	sw_forget(s);
	sw_options none = {0};
	const sw_options *o = options != NULL ? options : &none;
	pl *where = o->box != NULL ? o->box : s->s.places;
	found f = {0};
	const hf_entry *fn = NULL;
	if (!check(s, runner, program, where, 0, &f, &fn, refused)) return NULL;
	op_value *attrs = op_map();
	op_set(attrs, SW_ATTRIBUTE, op_str(SW_TYPE_PROCESS));
	op_value *rv = op_map();
	op_set(rv, "id", op_str(f.rid));
	if (f.rpath != NULL) op_set(rv, "at", sw_names_value((const char *const *)f.rpath, f.nr));
	op_set(attrs, SW_RUNNER, rv);
	op_value *pv = op_map();
	op_set(pv, "id", op_str(f.pid));
	if (f.ppath != NULL) op_set(pv, "at", sw_names_value((const char *const *)f.ppath, f.npp));
	if (f.hashed) op_set(pv, "hash", op_str(f.hex));
	op_set(attrs, SW_PROGRAM, pv);
	owner *p = sw_xalloc(sizeof *p);
	p->sw = s;
	p->run = 1;
	p->on = sw_live_offer(s, f.rid);
	p->fn = *fn;
	p->code = f.code != NULL ? op_ref((op_value *)f.code) : NULL;
	p->build = f.build;
	p->build_data = f.build_data;
	PUSH(s->all, s->nall, s->capall, p);
	ch_site buf;
	const ch_site *here = sw_site(s, &buf);
	const char *file = here != NULL ? here->file : NULL, *func = here != NULL ? here->function : NULL;
	int line = here != NULL ? (int)here->line : 0;
	// where it runs: a scope under its runner's offer (none: setup.scope) holding, newest first, what
	// it offers, its stopper, then its own scope
	p->under_value = op_str(f.rid);
	p->under_info[0] = (sc_pair){"on", p->under_value};
	p->under = sc_create_scope(s->s.scheduler, p->under_info, 1,
		p->on != NULL ? p->on->scope : s->s.scope);
	if (s->s.sites != NULL && file != NULL) st_note(s->s.sites, p->under, file, line, func);
	pr_refusal no;
	pr_process *life = pr_start_at(s->life, where, at, nat,
		&(pr_options){.args = o->args, .nargs = o->nargs, .has_args = o->has_args, .cwd = o->cwd,
			.ncwd = o->ncwd, .has_cwd = o->has_cwd, .pin = o->pin, .body = process_body,
			.stop = process_end, .data = p, .attributes = attrs, .under = p->under},
		&no, file, line, func);
	op_free(attrs);
	found_free(&f);
	if (life == NULL) {
		// refused: made no more (its pieces freed at sw_free)
		p->ended = 1;
		free(sc_teardown(p->under));
		refused->refused = no.refused;
		refused->at = no.at, refused->nat = no.nat;
		return NULL;
	}
	sw_changed(s);
	sw_later(s);
	return p;
}

sw_process *sw_run_at(sw *s, const char *const *runner, size_t nrunner, const sw_program *program,
	const char *const *at, size_t nat, const sw_options *options, sw_refusal *refused,
	const ch_site *site) {
	const ch_site *was = sw_enter(s, site);
	sw_process *p = run_now(s, &(given){runner, nrunner, NULL}, program, at, nat, options, refused);
	sw_leave(s, was);
	return p;
}

sw_process *sw_run_carried_at(sw *s, const sw_carried *runner, const sw_program *program,
	const char *const *at, size_t nat, const sw_options *options, sw_refusal *refused,
	const ch_site *site) {
	const ch_site *was = sw_enter(s, site);
	sw_process *p = run_now(s, &(given){NULL, 0, runner}, program, at, nat, options, refused);
	sw_leave(s, was);
	return p;
}

// late handles ---------------------------------------------------------------------------------------

sw_late *sw_wait(const sw_starting *st) {
	sw *s = st != NULL ? st->software : NULL;
	owner *p = s != NULL ? s->calling : NULL;
	if (p == NULL || p->late != NULL || st->process.id == NULL || strcmp(p->id, st->process.id) != 0) {
		return NULL;
	}
	sw_late *l = sw_xalloc(sizeof *l);
	l->sw = s;
	l->p = p;
	l->promise = sc_promise_new(s->s.scheduler);
	PUSH(s->lates, s->nlates, s->caplates, l);
	p->late = l;
	return l;
}

// a handle landing: held as one given at once (what its stop does, the process gone, has nobody to
// tell); then the status gone
void sw_land(sw_late *l, hf_run out) {
	if (l == NULL || l->landed || l->promise == NULL) {
		free(out.error);
		return;
	}
	l->landed = 1;
	if (out.error != NULL) {
		sc_reject(l->promise, out.error);
		return;
	}
	hold(l->p, out);
	sc_resolve(l->promise, op_bool(1));
}

// load -------------------------------------------------------------------------------------------------

typedef struct {
	const hf_entry *fn;
	const op_value *code;
	hf_loaded out;
} loading;

static void call_load(void *data) {
	loading *l = data;
	l->out = l->fn->load(l->code, l->fn->data);
}

typedef struct {
	char *s;
	size_t n, cap;
} text;

// a part of a key: its length, then it, so no part runs into the next
static void text_part(text *t, const char *part) {
	char len[24];
	snprintf(len, sizeof len, "%zu:", strlen(part));
	size_t a = strlen(len), b = strlen(part);
	while (t->n + a + b + 1 > t->cap) {
		t->cap = t->cap ? t->cap * 2 : 64;
		t->s = realloc(t->s, t->cap);
		if (t->s == NULL) abort();
	}
	memcpy(t->s + t->n, len, a);
	memcpy(t->s + t->n + a, part, b);
	t->n += a + b;
	t->s[t->n] = '\0';
}

// a pointer's bytes in hex, a key's part (a function pointer's too: no conversion to void *)
static void bytes_part(text *t, const void *p, size_t n) {
	static const char hex[] = "0123456789abcdef";
	char out[2 * sizeof(void (*)(void)) + 2 * sizeof(void *) + 1];
	size_t k = 0;
	const unsigned char *b = p;
	for (size_t i = 0; i < n && k + 2 < sizeof out; i++) out[k++] = hex[b[i] >> 4], out[k++] = hex[b[i] & 15];
	out[k] = '\0';
	text_part(t, out);
}

// a load's key, new: the program's id, its value's hash (no encoding: the value's address), the
// runner's id and function's name (carried: its live form's runner, load and data), then the
// chain's keys
static char *key_of(const found *f, const sw_load_options *o) {
	text t = {0};
	text_part(&t, f->pid);
	char at[32];
	if (f->hashed) text_part(&t, f->hex);
	else {
		snprintf(at, sizeof at, "p%p", (const void *)f->code);
		text_part(&t, at);
	}
	text_part(&t, f->rid);
	if (f->rlive == NULL) text_part(&t, f->rname != NULL ? f->rname : "");
	else {
		bytes_part(&t, &f->rlive->runner, sizeof f->rlive->runner);
		bytes_part(&t, &f->rlive->load, sizeof f->rlive->load);
		bytes_part(&t, &f->rlive->data, sizeof f->rlive->data);
	}
	for (size_t i = 0; i < o->nchain; i++) text_part(&t, o->chain[i]);
	return t.s;
}

static load *standing(const sw *s, const char *key) {
	for (size_t i = 0; i < s->nstanding; i++) {
		if (strcmp(s->standing[i]->key, key) == 0) return s->standing[i];
	}
	return NULL;
}

// a load going (its last hold let go, or setup.scope torn down): out of the standing ones, its
// live form closed, before what its load made goes
static char *unload(void *data) {
	load *l = data;
	if (l->gone) return NULL;
	l->gone = 1;
	DROP(l->sw->standing, l->sw->nstanding, l);
	if (l->live.close != NULL) l->live.close(l->live.data);
	return NULL;
}

// a load made: the entry's load called, by's facts and the load's own scope open. key: taken. NULL:
// the load failed (refused failed), its scope gone
static load *make(sw *s, owner *by, const found *f, const hf_entry *fn, char *key,
	sw_refusal *refused) {
	load *l = sw_xalloc(sizeof *l);
	l->sw = s;
	l->key = key;
	l->code = f->code != NULL ? op_ref((op_value *)f->code) : NULL;
	PUSH(s->loads, s->nloads, s->caploads, l);
	l->values[0] = op_str(f->pid);
	l->values[1] = op_str(f->rid);
	l->info[0] = (sc_pair){"load", l->values[0]};
	l->info[1] = (sc_pair){"on", l->values[1]};
	l->scope = sc_create_scope(s->s.scheduler, l->info, 2, s->s.scope);
	ch_site buf;
	const ch_site *here = sw_site(s, &buf);
	if (s->s.sites != NULL && here != NULL && here->file != NULL) {
		st_note(s->s.sites, l->scope, here->file, (int)here->line, here->function);
	}
	// its facts there to read for the call (sw_loading)
	sw_starting st = starting_of(by);
	st.scope = l->scope;
	const sw_starting *was = s->loading;
	s->loading = &st;
	loading c = {.fn = fn, .code = f->code};
	sc_run_with_scope(l->scope, call_load, &c);
	s->loading = was;
	if (c.out.error != NULL) {
		l->gone = 1;
		free(sc_teardown(l->scope));
		refused->refused = "failed";
		refused->error = sw_keep_owned(s, c.out.error);
		return NULL;
	}
	l->live = c.out.live;
	PUSH(s->standing, s->nstanding, s->capstanding, l);
	free(sc_register_teardown(s->s.scheduler, l->scope, unload, l));
	return l;
}

static sw_loaded *load_now(sw *s, const sw_place *by, const given *runner,
	const sw_program *program, const sw_load_options *options, sw_refusal *refused) {
	sw_forget(s);
	*refused = (sw_refusal){0};
	sw_load_options none = {0};
	const sw_load_options *opts = options != NULL ? options : &none;
	owner *o = by != NULL ? sw_owner_of(s, by) : NULL;
	if (o == NULL) return refused->refused = pl_code_name(PL_NOTHING_THERE), NULL;
	pl *where = opts->box != NULL ? opts->box : o->run ? pr_places(o->life) : s->s.places;
	found f = {0};
	const hf_entry *fn = NULL;
	if (!check(s, runner, program, where, 1, &f, &fn, refused)) return NULL;
	char *key = key_of(&f, opts);
	load *l = standing(s, key);
	if (l != NULL) free(key);
	else l = make(s, o, &f, fn, key, refused);
	found_free(&f);
	if (l == NULL) return NULL;
	sw_loaded *x = sw_xalloc(sizeof *x);
	x->sw = s;
	x->by = o;
	x->load = l;
	l->holds++;
	PUSH(s->loaded, s->nloaded, s->caploaded, x);
	PUSH(o->loads, o->nloads, o->caploads, x);
	sw_later(s);
	return x;
}

sw_loaded *sw_load_at(sw *s, const sw_place *by, const char *const *runner, size_t nrunner,
	const sw_program *program, const sw_load_options *options, sw_refusal *refused,
	const ch_site *site) {
	const ch_site *was = sw_enter(s, site);
	sw_loaded *l = load_now(s, by, &(given){runner, nrunner, NULL}, program, options, refused);
	sw_leave(s, was);
	return l;
}

sw_loaded *sw_load_carried_at(sw *s, const sw_place *by, const sw_carried *runner,
	const sw_program *program, const sw_load_options *options, sw_refusal *refused,
	const ch_site *site) {
	const ch_site *was = sw_enter(s, site);
	sw_loaded *l = load_now(s, by, &(given){NULL, 0, runner}, program, options, refused);
	sw_leave(s, was);
	return l;
}

const sw_starting *sw_loading(const sw *s) { return s->loading; }

const hf_live *sw_loaded_live(const sw_loaded *l) { return &l->load->live; }

void sw_release_at(sw *s, sw_loaded *l, const ch_site *site) {
	if (l == NULL || l->sw != s) return;
	const ch_site *was = sw_enter(s, site);
	sw_drop(l);
	sw_leave(s, was);
}

// stop -------------------------------------------------------------------------------------------------

// the reason told, then where it runs torn down
void sw_stop_at(sw *s, const char *id, const op_value *reason, const ch_site *site) {
	sw_forget(s);
	owner *p = sw_find(s, id);
	if (p == NULL || p->ended) return;
	const ch_site *was = sw_enter(s, site);
	p->told = 1;
	set_reason(p, reason);
	free(sc_teardown(p->under));
	sw_leave(s, was);
}

sw_process *sw_find(const sw *s, const char *id) {
	for (size_t i = 0; id != NULL && i < s->nrunning; i++) {
		if (strcmp(s->running[i]->id, id) == 0) return s->running[i];
	}
	return NULL;
}

const char *sw_process_id(const sw_process *p) { return p->id; }
size_t sw_process_at(const sw_process *p, const char *const **out) {
	*out = (const char *const *)p->at;
	return p->nat;
}
sc_scope *sw_process_scope(const sw_process *p) { return p->scope; }

int sw_hash_hex(const op_value *v, char out[65]) {
	if (v == NULL || hf_holds(v)) return 0;
	Json *j = pk_to_json(v);
	if (j == NULL) return 0;
	uint8_t h[32];
	const char *why;
	int ok = hashValue(j, h, &why);
	jsonFree(j);
	if (!ok) return 0;
	static const char hex[] = "0123456789abcdef";
	for (size_t i = 0; i < 32; i++) {
		out[2 * i] = hex[h[i] >> 4];
		out[2 * i + 1] = hex[h[i] & 15];
	}
	out[64] = 0;
	return 1;
}
