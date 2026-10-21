// start (start.h), in C.
#include "start.h"

#include "offers.h"
#include "policy.h"

static const op_value *attributes_of(const dn *d, const char *id) {
	const nd_entry *e = tb_get(d->s.table, tb_string("attributes"), tb_string(id));
	return e != NULL && dn_is_map(e->value) ? e->value : NULL;
}

static void set_reason(dn_process *p, const op_value *v) {
	op_value *was = p->reason;
	p->reason = v != NULL ? op_ref((op_value *)v) : NULL;
	op_free(was);
}

static void stop_handle(dn_process *p, const op_value *reason) {
	if (!p->has_handle) return;
	p->has_handle = 0;
	if (p->stop_reason != NULL) p->stop_reason(p->handle.ctx, reason);
	else if (p->handle.stop != NULL) p->handle.stop(p->handle.ctx);
}

// why a process goes: told by a stop; else the den closing (or its owner torn down), its pending
// reason; else its runner's offer going, the offer's why (none: "runner-stopped"); else none
static const op_value *reason_of(dn_process *p) {
	dn *d = p->den;
	if (p->told) return p->reason;
	if (d->closed || !sc_scope_alive(d->owner)) return d->pending;
	if (p->on != NULL && !sc_scope_alive(p->on->scope)) {
		return p->on->why != NULL ? p->on->why : d->reasons[R_RUNNER];
	}
	return NULL;
}

// its stopper going: its handle's stop with its reason
static char *stopper_gone(void *data) {
	dn_process *p = data;
	stop_handle(p, reason_of(p));
	return NULL;
}

// its own scope torn down alone (from above it, by a host): where it runs goes too
static char *scope_gone(void *data) {
	dn_process *p = data;
	return sc_teardown(p->under);
}

// a process going (its stop, as processes' start calls it, or its scope torn down from above): out
// of the lists. what goes with it is its scope's. dn_free's: its handle's stop, no reason
static void process_end(pr_process *life, void *data) {
	(void)life;
	dn_process *p = data;
	dn *d = p->den;
	if (p->ended) return;
	p->ended = 1;
	if (d->freeing) {
		stop_handle(p, NULL);
		return;
	}
	DROP(d->running, d->nrunning, p);
	dn_changed(d);
}

// a process stopped with a reason: told, then where it runs torn down
void dn_halt_process(dn *d, dn_process *p, const op_value *why) {
	(void)d;
	if (p->ended) return;
	p->told = 1;
	set_reason(p, why);
	free(sc_teardown(p->under));
}

static sc_out fail_f(void *previous, void *data) {
	(void)previous;
	return (sc_out){.kind = SC_FAILED, .error = dn_xdup(data)};
}
static char *no_set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}

typedef struct {
	dn_process *p;
	hf_run out;
	sc_computer *outcome;
} calling;

// an owner's facts, as its runner is handed them
static dn_starting starting_of(dn_process *p) {
	dn *d = p->den;
	dn_starting st = {.places = pr_places(p->life), .root = pr_root(p->life),
		.scheduler = d->s.scheduler, .table = d->s.table, .scope = p->scope, .den = d};
	st.process.id = p->id;
	st.process.nat = pr_at(p->life, &st.process.at);
	st.process.nargs = pr_args(p->life, &st.process.args);
	st.process.ncwd = pr_cwd(p->life, &st.process.cwd);
	return st;
}

// the runner called with the code and the start's facts: the process's scope open
static void call_runner(void *data) {
	calling *c = data;
	dn_process *p = c->p;
	dn_starting st = starting_of(p);
	c->out = p->fn.runner(p->code, &st, p->fn.data);
}

// a computer that fails with the runner's failure, under the scope open
static void make_outcome(void *data) {
	calling *c = data;
	c->outcome = sc_create_computer(c->p->den->s.scheduler,
		(sc_def){.f = fail_f, .set = no_set, .data = c->p->failure}, NULL, 0);
}

// the runner called: a handle, held (ended by now: stopped at once, with the reason); a failure, a
// computer that fails with it, its status the node's
static void run(dn_process *p) {
	dn *d = p->den;
	if (p->ended) return;
	calling c = {.p = p};
	sc_run_with_scope(p->scope, call_runner, &c);
	if (c.out.error != NULL) {
		free(p->failure);
		p->failure = c.out.error;
		if (p->ended) return;
		sc_run_with_scope(p->scope, make_outcome, &c);
		if (c.outcome != NULL) pr_give(d->life, p->life, c.outcome, 0);
		return;
	}
	if (c.out.handle.stop == NULL && c.out.stop_reason == NULL) return;
	p->handle = c.out.handle;
	p->stop_reason = c.out.stop_reason;
	p->has_handle = 1;
	if (!sc_scope_alive(p->stopper)) stop_handle(p, reason_of(p));
}

// the one act: the runner called, then the effect gone
static char *run_act(void *value, void *previous, void *data) {
	(void)value, (void)previous;
	dn_process *p = data;
	run(p);
	free(sc_teardown(p->first));
	return NULL;
}


// in the process's scope, as processes' start gives it: its stopper beside its scope (newer, so it
// goes before it: what its program made told the reason; what it offers, newer still, before
// that), it running, and the effect that calls the runner at the first pulse, its status (and run)
// the node's
static void process_body(pr_process *life, void *data) {
	dn_process *p = data;
	dn *d = p->den;
	p->life = life;
	p->id = dn_xdup(pr_id(life));
	const char *const *at;
	p->nat = pr_at(life, &at);
	p->at = dn_copy_names(at, p->nat);
	p->scope = pr_scope(life);
	const sc_info *info = sc_scope_info(p->scope);
	p->stopper = sc_create_scope(d->s.scheduler, info->pairs, info->n, p->under);
	ch_site buf;
	const ch_site *here = dn_site(d, &buf);
	if (d->s.sites != NULL && here != NULL && here->file != NULL) {
		st_note(d->s.sites, p->stopper, here->file, (int)here->line, here->function);
	}
	free(sc_register_teardown(d->s.scheduler, p->stopper, stopper_gone, p));
	free(sc_register_teardown(d->s.scheduler, p->scope, scope_gone, p));
	dn_holder(d, p);
	PUSH(d->running, d->nrunning, d->caprunning, p);
	p->first = sc_create_effect(d->s.scheduler, (sc_def){.f = dn_once_f, .effect = run_act, .data = p},
		NULL, 0);
	if (p->first != NULL) pr_give(d->life, life, p->first, 1);
}

// a start's answer: { id, at }
op_value *dn_id_at(const dn_process *p) {
	op_value *m = op_map();
	op_set(m, "id", op_str(p->id));
	op_set(m, "at", dn_names_value((const char *const *)p->at, p->nat));
	return m;
}

// start ----------------------------------------------------------------------------------------------

// what a start found, as it checks: the runner, the program, its code, its form, its hash
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
	if (pl_get(g->places, g->path, g->n, &id) && id.symbol == NULL) g->id = dn_xdup(id.string);
}

// the id at a path from the places' root, untracked; NULL: nothing there
static char *resolve(pl *p, char *const *path, size_t n) {
	getting g = {p, (const char *const *)path, n, NULL};
	pl_peep(p, get_now, &g);
	return g.id;
}

// a value the same as another, as === has it: a scalar's value; a list or map is only itself
static int same_scalar(const op_value *a, const op_value *b) {
	if (a == NULL || b == NULL) return a == b;
	if (a->type == OP_LIST || a->type == OP_MAP || a->type == OP_STAND || a->type == OP_BYTES ||
		a->type == OP_TYPED)
		return a == b;
	return pr_same(a, b);
}

// refused not-there: the program's path (held), or its id
static int not_there_at(dn *d, found *f, dn_refusal *r) {
	r->refused = "not-there";
	r->program_has_at = 1;
	r->program_at = dn_keep_names(d, f->ppath, f->npp);
	r->nprogram_at = f->npp;
	f->ppath = NULL;
	return 0;
}
static int not_there_id(dn *d, found *f, dn_refusal *r) {
	r->refused = "not-there";
	r->program = dn_keep_text(d, f->pid);
	return 0;
}

// the program: its node (or the code carried), its code read once, its form; 0: refused
static int program_of(dn *d, pl *where, const dn_program *program, found *f, dn_refusal *r) {
	const nd_entry *e;
	f->carried = !program->has_at && program->code != NULL;
	if (program->has_at) {
		f->ppath = pr_names(program->at, program->nat, &f->npp);
		f->pid = resolve(where, f->ppath, f->npp);
		e = f->pid != NULL ? tb_get(d->s.table, tb_string("value"), tb_string(f->pid)) : NULL;
		if (e == NULL) return not_there_at(d, f, r);
		f->code = e->value;
	} else {
		f->pid = dn_xdup(program->id != NULL ? program->id : "");
		if (f->carried) f->code = program->code;
		else {
			e = tb_get(d->s.table, tb_string("value"), tb_string(f->pid));
			if (e == NULL) return not_there_id(d, f, r);
			f->code = e->value;
		}
	}
	f->hashed = f->code != NULL && dn_hash_hex(f->code, f->hex);
	if (!program->has_at && program->hash != NULL &&
		(!f->hashed || strcmp(program->hash, f->hex) != 0))
		return not_there_id(d, f, r);
	if (f->carried) {
		f->type = f->own_type = program->type != NULL ? op_str(program->type) : NULL;
		f->api = f->own_api = program->api != NULL ? op_str(program->api) : NULL;
	} else {
		const op_value *attrs = attributes_of(d, f->pid);
		f->type = dn_get(attrs, DN_ATTRIBUTE);
		f->api = dn_get(attrs, DN_PROGRAM_API);
	}
	return 1;
}

// refused not-a-runner: the runner's path, held
static dn_process *not_a_runner(dn *d, found *f, dn_refusal *r) {
	r->refused = "not-a-runner";
	r->runner = dn_keep_names(d, f->rpath, f->nr);
	r->nrunner = f->nr;
	f->rpath = NULL;
	found_free(f);
	return NULL;
}

// start's checks in order, up to taken (processes'): the runner and its entry (load: one with a
// load), the program found, the policy asked. 0: refused, f let go; 1: f the caller's to let go
static int check(dn *d, const op_value *who, int remote, const char *const *runner, size_t nrunner,
	const dn_program *program, pl *where, int load, found *f, const hf_entry **out,
	dn_refusal *refused) {
	*refused = (dn_refusal){0};
	if (d->closed) return refused->refused = "stopped", 0;
	f->rpath = pr_names(runner, nrunner, &f->nr);
	f->rid = resolve(d->s.places, f->rpath, f->nr);
	const op_value *rattrs = f->rid != NULL ? attributes_of(d, f->rid) : NULL;
	const op_value *rtype = dn_get(rattrs, DN_ATTRIBUTE);
	if (!dn_is_str(rtype) || strcmp(rtype->str, DN_TYPE_RUNNER) != 0) {
		return not_a_runner(d, f, refused), 0;
	}
	if (!program_of(d, where, program, f, refused)) return found_free(f), 0;
	const op_value *takes = dn_get(rattrs, DN_TAKES), *gives = dn_get(rattrs, DN_API);
	int fits = dn_is_str(f->type) && dn_is_str(takes) && strcmp(f->type->str, takes->str) == 0;
	if (fits && f->api != NULL && !same_scalar(f->api, gives)) fits = 0;
	if (!fits) {
		refused->refused = "wrong-form";
		refused->type = dn_is_str(f->type) ? dn_keep_text(d, f->type->str) : NULL;
		refused->api = dn_is_str(f->api) ? dn_keep_text(d, f->api->str) : NULL;
		refused->takes = dn_is_str(takes) ? dn_keep_text(d, takes->str) : NULL;
		refused->runner_api = dn_is_str(gives) ? dn_keep_text(d, gives->str) : NULL;
		found_free(f);
		return 0;
	}
	const nd_entry *fv = tb_get(d->s.table, tb_string("value"), tb_string(f->rid));
	const hf_entry *fn = fv != NULL ? hf_find(d->s.functions, fv->value) : NULL;
	if (fn == NULL || (load ? fn->load == NULL : fn->runner == NULL)) {
		return not_a_runner(d, f, refused), 0;
	}
	pr_answer a = dn_permit(d, who, "start", NULL, f->rid, f->rpath, f->nr, remote);
	if (a.verdict != PR_YES) return dn_no_permission(refused, "start", a), found_free(f), 0;
	if (!f->carried) {
		a = dn_permit(d, who, "read", "value", f->pid, f->ppath, f->npp, remote);
		if (a.verdict != PR_YES) return dn_no_permission(refused, "read", a), found_free(f), 0;
	}
	*out = fn;
	return 1;
}

// start's checks, then processes' start. who: the policy's; remote: another den's ask
dn_process *dn_begin(dn *d, const op_value *who, int remote, const char *const *runner,
	size_t nrunner, const dn_program *program, const char *const *steps, size_t nsteps,
	const dn_options *options, dn_refusal *refused) {
	dn_options none = {0};
	const dn_options *o = options != NULL ? options : &none;
	pl *where = o->box != NULL ? o->box : d->s.places;
	found f = {0};
	const hf_entry *fn = NULL;
	if (!check(d, who, remote, runner, nrunner, program, where, 0, &f, &fn, refused)) return NULL;
	op_value *attrs = op_map();
	op_set(attrs, DN_ATTRIBUTE, op_str(DN_TYPE_PROCESS));
	op_value *rv = op_map();
	op_set(rv, "id", op_str(f.rid));
	op_set(rv, "at", dn_names_value((const char *const *)f.rpath, f.nr));
	op_set(attrs, DN_RUNNER, rv);
	op_value *pv = op_map();
	op_set(pv, "id", op_str(f.pid));
	if (f.ppath != NULL) op_set(pv, "at", dn_names_value((const char *const *)f.ppath, f.npp));
	if (f.hashed) op_set(pv, "hash", op_str(f.hex));
	op_set(attrs, DN_PROGRAM, pv);
	op_value *dv = op_map();
	op_set(dv, "id", op_str(d->self->id));
	op_set(dv, "at", dn_names_value((const char *const *)d->self->at, d->self->nat));
	op_set(attrs, DN_DEN, dv);
	dn_process *p = dn_xalloc(sizeof *p);
	p->den = d;
	p->where = where;
	p->on = dn_live_offer(d, f.rid);
	p->fn = *fn;
	p->code = f.code != NULL ? op_ref((op_value *)f.code) : NULL;
	PUSH(d->all, d->nall, d->capall, p);
	ch_site buf;
	const ch_site *here = dn_site(d, &buf);
	const char *file = here != NULL ? here->file : NULL, *func = here != NULL ? here->function : NULL;
	int line = here != NULL ? (int)here->line : 0;
	// where it runs: a scope under its runner's offer (none: the owner) holding, newest first, what
	// it offers, its stopper, then its own scope
	p->under_value = op_str(f.rid);
	p->under_info[0] = (sc_pair){"on", p->under_value};
	p->under = sc_create_scope(d->s.scheduler, p->under_info, 1,
		p->on != NULL ? p->on->scope : d->owner);
	if (d->s.sites != NULL && file != NULL) st_note(d->s.sites, p->under, file, line, func);
	pr_refusal no;
	pr_process *life = pr_start_at(d->life, where, steps, nsteps,
		&(pr_options){.args = o->args, .nargs = o->nargs, .has_args = o->has_args, .cwd = o->cwd,
			.ncwd = o->ncwd, .has_cwd = o->has_cwd, .pin = o->pin, .body = process_body,
			.stop = process_end, .data = p, .attributes = attrs, .under = p->under},
		&no, file, line, func);
	op_free(attrs);
	found_free(&f);
	if (life == NULL) {
		// refused: made no more (its pieces freed at dn_free)
		p->ended = 1;
		free(sc_teardown(p->under));
		refused->refused = no.refused;
		refused->at = no.at, refused->nat = no.nat;
		return NULL;
	}
	dn_changed(d);
	dn_later(d);
	return p;
}

dn_process *dn_start_at(dn *d, const char *const *runner, size_t nrunner, const dn_program *program,
	const char *const *at, size_t nat, const dn_options *options, dn_refusal *refused,
	const ch_site *site) {
	dn_forget(d);
	const ch_site *was = dn_enter(d, site);
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	dn_process *p = dn_begin(d, who, 0, runner, nrunner, program, at, nat, options, refused);
	op_free(who);
	dn_leave(d, was);
	return p;
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

static dn_loaded *load_now(dn *d, dn_process *by, const char *const *runner, size_t nrunner,
	const dn_program *program, const dn_options *options, dn_refusal *refused) {
	dn_forget(d);
	*refused = (dn_refusal){0};
	if (d->closed) return refused->refused = "stopped", NULL;
	dn_process *o = by != NULL ? by : d->self;
	if (o->den != d || o->ended || o->life == NULL) return refused->refused = "nothing-there", NULL;
	pl *where = options != NULL && options->box != NULL ? options->box : pr_places(o->life);
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	found f = {0};
	const hf_entry *fn = NULL;
	int ok = check(d, who, 0, runner, nrunner, program, where, 1, &f, &fn, refused);
	op_free(who);
	if (!ok) return NULL;
	loading l = {.fn = fn, .code = f.code};
	if (sc_get_current_scope(d->s.scheduler) != NULL) call_load(&l);
	else sc_run_with_scope(o->scope, call_load, &l);
	found_free(&f);
	if (l.out.error != NULL) {
		refused->refused = "failed";
		refused->error = dn_keep_owned(d, l.out.error);
		return NULL;
	}
	dn_loaded *x = dn_xalloc(sizeof *x);
	x->den = d;
	x->by = o;
	x->live = l.out.live;
	PUSH(d->loaded, d->nloaded, d->caploaded, x);
	PUSH(o->loads, o->nloads, o->caploads, x);
	dn_later(d);
	return x;
}

dn_loaded *dn_load_at(dn *d, dn_process *by, const char *const *runner, size_t nrunner,
	const dn_program *program, const dn_options *options, dn_refusal *refused, const ch_site *site) {
	const ch_site *was = dn_enter(d, site);
	dn_loaded *l = load_now(d, by, runner, nrunner, program, options, refused);
	dn_leave(d, was);
	return l;
}

const hf_live *dn_loaded_live(const dn_loaded *l) { return &l->live; }

void dn_release_at(dn *d, dn_loaded *l, const ch_site *site) {
	if (l == NULL || l->den != d) return;
	const ch_site *was = dn_enter(d, site);
	dn_drop(l);
	dn_leave(d, was);
}

// stop -------------------------------------------------------------------------------------------------

// asked stop on its node, a process this den started (the den's own: here's)
int dn_stop_as(dn *d, const op_value *who, int remote, dn_process *p, const op_value *reason,
	dn_refusal *refused) {
	*refused = (dn_refusal){0};
	if (p == NULL || p->den != d || p->self || p->ended || p->life == NULL) return 0;
	pr_answer a = dn_permit(d, who, "stop", NULL, p->id, p->at, p->nat, remote);
	if (a.verdict != PR_YES) return dn_no_permission(refused, "stop", a), 1;
	dn_halt_process(d, p, reason);
	return 0;
}

dn_process *dn_find(const dn *d, const char *id) {
	for (size_t i = 0; id != NULL && i < d->nrunning; i++) {
		if (strcmp(d->running[i]->id, id) == 0) return d->running[i];
	}
	return NULL;
}

size_t dn_processes(const dn *d, dn_process *const **out) {
	*out = d->running;
	return d->nrunning;
}

const char *dn_process_id(const dn_process *p) { return p->id; }
size_t dn_process_at(const dn_process *p, const char *const **out) {
	*out = (const char *const *)p->at;
	return p->nat;
}
sc_scope *dn_process_scope(const dn_process *p) { return p->scope; }

int dn_hash_hex(const op_value *v, char out[65]) {
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
