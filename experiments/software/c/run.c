// run (typescript/run.ts), in C: a program on a runner, as a process. what a run asks of the program
// and the runner (its form, its hash), then the process: run at a path, loaded live with no process,
// stopped, and the reasons it is stopped with. sw_run_at, sw_load_at, sw_release_at, sw_stop_at,
// sw_wait, sw_land, sw_loading and sw_hash_hex are software.h's. which question: how a program runs
// on a runner
#include "common.h"

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

// the one act: the runner called, then the effect gone
static char *run_act(void *value, void *previous, void *data) {
	(void)value, (void)previous;
	owner *p = data;
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
	// core candidate (scheduler): an effect that acts once and goes
	p->first = sc_create_effect(s->s.scheduler, (sc_def){.f = sw_once_f, .effect = run_act, .data = p},
		NULL, 0);
	if (p->first != NULL) pr_give(s->life, life, p->first, 1);
}

// the checks ---------------------------------------------------------------------------------------

// what a run found, as it checks: the runner, the program, its code, its form, its hash
typedef struct {
	char **rpath;
	size_t nr;
	char *rid;
	char **ppath;
	size_t npp;
	char *pid;
	const op_value *code;
	const op_value *type, *api;
	op_value *own_type, *own_api;
	int carried, hashed;
	char hex[65];
} found;

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

// the program: its node (or the code carried), its code read once, its form; 0: refused
static int program_of(sw *s, pl *where, const sw_program *program, found *f, sw_refusal *r) {
	const nd_entry *e;
	f->carried = !program->has_at && program->code != NULL;
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
	return 1;
}

// refused not-a-runner: the runner's path, held
static int not_a_runner(sw *s, found *f, sw_refusal *r) {
	r->refused = "not-a-runner";
	r->runner = sw_keep_names(s, f->rpath, f->nr);
	r->nrunner = f->nr;
	f->rpath = NULL;
	found_free(f);
	return 0;
}

// the checks in order, up to taken (processes'): the runner and its entry, the program read once.
// load: a runner with no load is not-a-runner. 0: refused, f let go; 1: f the caller's to let go
static int check(sw *s, const char *const *runner, size_t nrunner, const sw_program *program,
	pl *where, int load, found *f, const hf_entry **out, sw_refusal *refused) {
	*refused = (sw_refusal){0};
	f->rpath = pr_names(runner, nrunner, &f->nr);
	f->rid = resolve(s->s.places, (const char *const *)f->rpath, f->nr);
	const op_value *rattrs = f->rid != NULL ? attributes_of(s, f->rid) : NULL;
	const op_value *rtype = sw_get(rattrs, SW_ATTRIBUTE);
	if (!sw_is_str(rtype) || strcmp(rtype->str, SW_TYPE_RUNNER) != 0) return not_a_runner(s, f, refused);
	if (!program_of(s, where, program, f, refused)) return found_free(f), 0;
	const op_value *takes = sw_get(rattrs, SW_TAKES), *gives = sw_get(rattrs, SW_API);
	int fits = sw_is_str(f->type) && sw_is_str(takes) && strcmp(f->type->str, takes->str) == 0;
	if (fits && f->api != NULL && !same_scalar(f->api, gives)) fits = 0;
	if (!fits) {
		refused->refused = "wrong-form";
		refused->type = sw_is_str(f->type) ? sw_keep_text(s, f->type->str) : NULL;
		refused->api = sw_is_str(f->api) ? sw_keep_text(s, f->api->str) : NULL;
		refused->takes = sw_is_str(takes) ? sw_keep_text(s, takes->str) : NULL;
		refused->runner_api = sw_is_str(gives) ? sw_keep_text(s, gives->str) : NULL;
		found_free(f);
		return 0;
	}
	// a runner: one with a start (runnerOf's), and, to load, a load
	const nd_entry *fv = tb_get(s->s.table, tb_string("value"), tb_string(f->rid));
	const hf_entry *fn = fv != NULL ? hf_find(s->s.functions, fv->value) : NULL;
	if (fn == NULL || fn->runner == NULL || (load && fn->load == NULL)) {
		return not_a_runner(s, f, refused);
	}
	*out = fn;
	return 1;
}

// run ----------------------------------------------------------------------------------------------

static sw_process *run_now(sw *s, const char *const *runner, size_t nrunner,
	const sw_program *program, const char *const *at, size_t nat, const sw_options *options,
	sw_refusal *refused) {
	sw_forget(s);
	sw_options none = {0};
	const sw_options *o = options != NULL ? options : &none;
	pl *where = o->box != NULL ? o->box : s->s.places;
	found f = {0};
	const hf_entry *fn = NULL;
	if (!check(s, runner, nrunner, program, where, 0, &f, &fn, refused)) return NULL;
	op_value *attrs = op_map();
	op_set(attrs, SW_ATTRIBUTE, op_str(SW_TYPE_PROCESS));
	op_value *rv = op_map();
	op_set(rv, "id", op_str(f.rid));
	op_set(rv, "at", sw_names_value((const char *const *)f.rpath, f.nr));
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
	sw_process *p = run_now(s, runner, nrunner, program, at, nat, options, refused);
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

static sw_loaded *load_now(sw *s, const sw_place *by, const char *const *runner, size_t nrunner,
	const sw_program *program, pl *box, sw_refusal *refused) {
	sw_forget(s);
	*refused = (sw_refusal){0};
	owner *o = by != NULL ? sw_owner_of(s, by) : NULL;
	if (o == NULL) return refused->refused = pl_code_name(PL_NOTHING_THERE), NULL;
	pl *where = box != NULL ? box : o->run ? pr_places(o->life) : s->s.places;
	found f = {0};
	const hf_entry *fn = NULL;
	if (!check(s, runner, nrunner, program, where, 1, &f, &fn, refused)) return NULL;
	// its facts there to read for the call (sw_loading)
	sw_starting st = starting_of(o);
	const sw_starting *was = s->loading;
	s->loading = &st;
	loading l = {.fn = fn, .code = f.code};
	if (sc_get_current_scope(s->s.scheduler) != NULL) call_load(&l);
	else sc_run_with_scope(o->scope, call_load, &l);
	s->loading = was;
	found_free(&f);
	if (l.out.error != NULL) {
		refused->refused = "failed";
		refused->error = sw_keep_owned(s, l.out.error);
		return NULL;
	}
	sw_loaded *x = sw_xalloc(sizeof *x);
	x->sw = s;
	x->by = o;
	x->live = l.out.live;
	PUSH(s->loaded, s->nloaded, s->caploaded, x);
	PUSH(o->loads, o->nloads, o->caploads, x);
	sw_later(s);
	return x;
}

sw_loaded *sw_load_at(sw *s, const sw_place *by, const char *const *runner, size_t nrunner,
	const sw_program *program, pl *box, sw_refusal *refused, const ch_site *site) {
	const ch_site *was = sw_enter(s, site);
	sw_loaded *l = load_now(s, by, runner, nrunner, program, box, refused);
	sw_leave(s, was);
	return l;
}

const sw_starting *sw_loading(const sw *s) { return s->loading; }

const hf_live *sw_loaded_live(const sw_loaded *l) { return &l->live; }

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
