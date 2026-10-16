// Start (start.h), in C.
#include "start.h"

#include <string.h>

#include "../../../ermine/programs/c/mem.h"

// a load (start.ts' Load): its key, and the value loaded (held, so a key naming it by its address
// names no other); its live form once loaded, or its failure (malloc'd); how many processes hold it;
// cached: in the programs' loads by key (a failure, or one let go: no more); closed: its live form
// let go, as the last process holding it stopped
typedef struct {
	char *key;
	op_value *value;
	hf_live live;
	char *error;
	size_t holders;
	int cached, closed;
} ps_load;

// a step keyed at start (a loaded one, or a by of one): its key; a loaded one's value, read then
typedef struct {
	const pg_step *step;
	char *key;
	op_value *value;
} ps_keyed;

// a process: its life (processes' start.h; NULL: refused), and the way it runs
struct ps_process {
	ps *owner;
	pr_process *life;
	op_value *value;
	op_value *nothing;
	pg_chain chain;
	sc_computer *build;
	hf_handle handle;
	int has_handle, stopped;
	void *api;
	char *failure;
	// the chain's loaded steps keyed at start; the loads it holds; a loaded runner's load, as the
	// build last ran
	ps_keyed *keyed;
	size_t nkeyed, capkeyed;
	ps_load **held;
	size_t nheld, capheld;
	ps_load *runner;
};

struct ps {
	ps_setup s;
	// the processes' owner, its info [["programs", "start"]]
	sc_scope *owner;
	sc_pair owner_info;
	// the processes' lives, under the owner
	pr *life;
	ps_process **all;
	size_t n, cap;
	// every load made (the programs' until ps_free); those cached found by key
	ps_load **loads;
	size_t nloads, caploads;
	int halted;
};

ps *ps_new_at(const ps_setup *setup, const char *file, int line, const char *func) {
	ps *p = pg_alloc(sizeof *p);
	p->s = *setup;
	p->owner_info = (sc_pair){"programs", op_str("start")};
	p->owner = sc_create_scope(setup->scheduler, &p->owner_info, 1, NULL);
	if (setup->sites != NULL) st_note(setup->sites, p->owner, file, line, func);
	p->life = pr_new_at(&(pr_setup){.scheduler = setup->scheduler, .table = setup->table,
		.places = setup->places, .scopes = setup->scopes, .commit = setup->commit,
		.commit_ctx = setup->commit_ctx, .sites = setup->sites, .runs = setup->runs, .owner = p->owner},
		file, line, func);
	return p;
}

const char *ps_id(const ps_process *p) { return pr_id(p->life); }
sc_scope *ps_scope(const ps_process *p) { return pr_scope(p->life); }
size_t ps_at(const ps_process *p, const char *const **out) { return pr_at(p->life, out); }
size_t ps_cwd(const ps_process *p, const char *const **out) { return pr_cwd(p->life, out); }

// what was chosen, read untracked now
static op_value *place_value(const pg_place *p) {
	op_value *m = op_map();
	op_set(m, "id", op_str(p->id));
	op_value *at = op_list();
	for (size_t i = 0; i < p->n; i++) op_push(at, op_str(p->at[i]));
	op_set(m, "at", at);
	return m;
}

static op_value *names_value(char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

// a step as pinned: its identity, else its attributes' hash; a loaded one's (by not empty) also its
// value's hash and its by, pinned so
static op_value *pin_step(ps *s, const pg_step *st) {
	char hex[65];
	op_value *step = place_value(&st->place);
	const nd_entry *e = tb_get(s->s.table, tb_string("attributes"), tb_string(st->place.id));
	const op_value *attrs = e != NULL ? e->value : NULL;
	const op_value *identity = attrs != NULL && attrs->type == OP_MAP ? op_get(attrs, BD_COMPILER) : NULL;
	if (identity != NULL) op_set(step, "identity", op_ref((op_value *)identity));
	else if (attrs != NULL && bd_hash_hex(attrs, hex)) op_set(step, "attributes", op_str(hex));
	if (st->by.n == 0) return step;
	const nd_entry *v = tb_get(s->s.table, tb_string("value"), tb_string(st->place.id));
	if (v != NULL && v->value != NULL && bd_hash_hex(v->value, hex)) op_set(step, "hash", op_str(hex));
	op_value *by = op_list();
	for (size_t i = 0; i < st->by.n; i++) op_push(by, pin_step(s, &st->by.steps[i]));
	op_set(step, "by", by);
	return step;
}

static op_value *pin_of(ps *s, const char *root, char *const *cwd, size_t ncwd, const pg_way *way,
	const op_value *value) {
	op_value *pin = op_map();
	op_value *program = place_value(&way->program);
	char hex[65];
	if (value != NULL && bd_hash_hex(value, hex)) op_set(program, "hash", op_str(hex));
	op_set(pin, "program", program);
	op_value *chain = op_list();
	for (size_t i = 0; i < way->chain.n; i++) op_push(chain, pin_step(s, &way->chain.steps[i]));
	op_set(pin, "chain", chain);
	op_set(pin, "box", op_str(root));
	op_set(pin, "cwd", names_value(cwd, ncwd));
	return pin;
}

// a load's live form let go, once
static void close_load(ps_load *l) {
	if (l->closed) return;
	l->closed = 1;
	l->cached = 0;
	if (l->error == NULL && l->live.close != NULL) l->live.close(l->live.data);
}

// the loads p holds let go; one held by no process goes, its live form closed
static void release(ps_process *p) {
	for (size_t i = 0; i < p->nheld; i++) {
		ps_load *l = p->held[i];
		if (--l->holders == 0) close_load(l);
	}
	p->nheld = 0;
	p->runner = NULL;
}

// at the process's stop (processes' start.h: its scope open while alive, the row still there): the
// runner's stop, once; its loads let go
static void end(pr_process *life, void *data) {
	(void)life;
	ps_process *p = data;
	if (!p->stopped) {
		p->stopped = 1;
		int had = p->has_handle && p->handle.stop != NULL;
		p->has_handle = 0;
		if (had) p->handle.stop(p->handle.ctx);
	}
	release(p);
}

// the build -------------------------------------------------------------------------------------------

// loading (start.h): keys, live forms, the fold ------------------------------------------------------

typedef struct {
	char *s;
	size_t n, cap;
} text;

static void text_add(text *t, const char *s, size_t n) {
	while (t->n + n + 1 > t->cap) {
		t->cap = t->cap ? t->cap * 2 : 64;
		t->s = realloc(t->s, t->cap);
		if (t->s == NULL) abort();
	}
	memcpy(t->s + t->n, s, n);
	t->n += n;
	t->s[t->n] = '\0';
}

// a part of a key: its length, then it, so no part runs into the next
static void text_part(text *t, const char *s) {
	char n[24];
	snprintf(n, sizeof n, "%zu:", strlen(s));
	text_add(t, n, strlen(n));
	text_add(t, s, strlen(s));
}

static ps_keyed *keyed_of(ps_process *p, const pg_step *st) {
	for (size_t i = 0; i < p->nkeyed; i++) {
		if (p->keyed[i].step == st) return &p->keyed[i];
	}
	return NULL;
}

// a step's key, made once (start.ts' keyOf): a host step's, its function's name (none: its id); a
// loaded one's, its id, the hash of its value (no encoding: the value itself) and its by's keys
static const char *key_of(ps_process *p, const pg_step *st) {
	ps_keyed *k = keyed_of(p, st);
	if (k != NULL) return k->key;
	ps *s = p->owner;
	const nd_entry *e = tb_get(s->s.table, tb_string("value"), tb_string(st->place.id));
	const op_value *v = e != NULL ? e->value : NULL;
	text t = {0};
	op_value *value = NULL;
	if (st->by.n == 0) {
		const char *name = hf_name(v);
		text_add(&t, name != NULL ? "f" : "x", 1);
		text_part(&t, name != NULL ? name : st->place.id);
	} else {
		value = v != NULL ? op_ref((op_value *)v) : NULL;
		char hex[65];
		text_add(&t, "l", 1);
		text_part(&t, st->place.id);
		if (v == NULL) text_part(&t, "none");
		else if (bd_hash_hex(v, hex)) text_part(&t, hex);
		else {
			char at[32];
			snprintf(at, sizeof at, "p%p", (const void *)v);
			text_part(&t, at);
		}
		for (size_t i = 0; i < st->by.n; i++) text_part(&t, key_of(p, &st->by.steps[i]));
	}
	ps_keyed made = {st, t.s, value};
	PG_PUSH(p->keyed, p->nkeyed, p->capkeyed, made);
	return t.s;
}

// the chain's loaded steps keyed now, their values read now
static void key_chain(ps_process *p) {
	for (size_t i = 0; i < p->chain.n; i++) {
		if (p->chain.steps[i].by.n > 0) key_of(p, &p->chain.steps[i]);
	}
}

static const op_value *value_of(ps_process *p, const pg_step *st) {
	ps_keyed *k = keyed_of(p, st);
	return k != NULL && k->value != NULL ? k->value : p->nothing;
}

typedef enum { K_OK, K_PENDING, K_FAILED, K_STOP } ps_kind;

// a live form, or why none yet: pending, failed (error malloc'd), or the run told to end
typedef struct {
	ps_kind kind;
	hf_live live;
	ps_load *load;
	char *error;
} lived;

// a value through compilers, or why none yet
typedef struct {
	ps_kind kind;
	const op_value *value;
	char *error;
} folded;

static lived not_live(ps_kind k, char *error) { return (lived){.kind = k, .error = error}; }

static folded fold(ps_process *p, const pg_step *steps, size_t n, const op_value *v);

static ps_load *held_by(ps_process *p, const char *key) {
	for (size_t i = 0; i < p->nheld; i++) {
		if (strcmp(p->held[i]->key, key) == 0) return p->held[i];
	}
	return NULL;
}

static ps_load *cached(ps *s, const char *key) {
	for (size_t i = 0; i < s->nloads; i++) {
		if (s->loads[i]->cached && strcmp(s->loads[i]->key, key) == 0) return s->loads[i];
	}
	return NULL;
}

// a step's live form (start.ts' liveOf): a host's, its node's function's (none: not-a-runner); a
// loaded one's, its load's, the process holding it. a load not made yet: its by's runner's load
// called on its value folded through its by's compilers (C's loads are synchronous: called here, in
// the build's run, no computer of their own); a failure no one's but its holders'
static lived live_of(ps_process *p, const pg_step *st) {
	ps *s = p->owner;
	if (st->by.n == 0) {
		const nd_entry *e = tb_get(s->s.table, tb_string("value"), tb_string(st->place.id));
		if (e == NULL || hf_name(e->value) == NULL) return not_live(K_FAILED, pg_dup("not-a-runner"));
		const hf_entry *fn = hf_find(s->s.functions, e->value);
		hf_live live = {0};
		if (fn != NULL) live = (hf_live){.run = fn->runner, .load = fn->load, .data = fn->data};
		return (lived){.kind = K_OK, .live = live};
	}
	const char *key = key_of(p, st);
	ps_load *l = held_by(p, key);
	if (l == NULL) l = cached(s, key);
	if (l == NULL) {
		lived by = live_of(p, &st->by.steps[st->by.n - 1]);
		if (by.kind != K_OK) return by;
		if (by.live.load == NULL) return not_live(K_FAILED, pg_dup("not-a-loader"));
		folded code = fold(p, st->by.steps, st->by.n - 1, value_of(p, st));
		if (code.kind != K_OK) return not_live(code.kind, code.error);
		l = pg_alloc(sizeof *l);
		l->key = pg_dup(key);
		l->value = op_ref((op_value *)value_of(p, st));
		l->cached = 1;
		PG_PUSH(s->loads, s->nloads, s->caploads, l);
		hf_loaded out = by.live.load(code.value, by.live.data);
		if (out.error != NULL) l->error = out.error, l->cached = 0;
		else l->live = out.live;
	}
	if (held_by(p, key) == NULL) {
		PG_PUSH(p->held, p->nheld, p->capheld, l);
		l->holders++;
	}
	if (l->error != NULL) return not_live(K_FAILED, pg_dup(l->error));
	return (lived){.kind = K_OK, .live = l->live, .load = l};
}

// a loaded compiler's identity (start.ts'): its ermine.programs.compiler; none, { id, hash } of its
// value as read at start; no encoding, its id
static op_value *identity_of(ps_process *p, const pg_step *c) {
	ps *s = p->owner;
	const nd_entry *e = tb_get(s->s.table, tb_string("attributes"), tb_string(c->place.id));
	const op_value *attrs = e != NULL ? e->value : NULL;
	const op_value *named = attrs != NULL && attrs->type == OP_MAP ? op_get(attrs, BD_COMPILER) : NULL;
	if (named != NULL) return op_ref((op_value *)named);
	ps_keyed *k = keyed_of(p, c);
	char hex[65];
	if (k == NULL || k->value == NULL || !bd_hash_hex(k->value, hex)) return op_str(c->place.id);
	op_value *m = op_map();
	op_set(m, "id", op_str(c->place.id));
	op_set(m, "hash", op_str(hex));
	return m;
}

// a loaded compiler's step run: its live form's compile, unless let go by now
static hf_out compile_run(const op_value *code, void *data) {
	ps_load *l = data;
	if (l->closed) return (hf_out){.kind = HF_FAILED, .error = pg_dup("unloaded")};
	return l->live.compile(code, l->live.data);
}

// the value through the compilers (start.ts' fold), each a host's (bd_compile) or loaded (bd_step
// under its identity)
static folded fold(ps_process *p, const pg_step *steps, size_t n, const op_value *v) {
	ps *s = p->owner;
	for (size_t i = 0; i < n; i++) {
		const pg_step *c = &steps[i];
		bd_result r;
		if (c->by.n == 0) r = bd_compile(s->s.builds, c->place.id, v);
		else {
			lived l = live_of(p, c);
			if (l.kind != K_OK) return (folded){.kind = l.kind, .error = l.error};
			if (l.live.compile == NULL) return (folded){.kind = K_FAILED, .error = pg_dup("not-a-compiler")};
			op_value *identity = identity_of(p, c);
			r = bd_step(s->s.builds, identity, v, compile_run, l.load, 0);
			op_free(identity);
		}
		switch (r.kind) {
		case BD_STOP: return (folded){.kind = K_STOP};
		case BD_PENDING: return (folded){.kind = K_PENDING};
		case BD_REFUSED:
		case BD_FAILED: return (folded){.kind = K_FAILED, .error = pg_dup(r.text)};
		case BD_VALUE: v = r.value;
		}
	}
	return (folded){.kind = K_OK, .value = v};
}

// the build -------------------------------------------------------------------------------------------

static sc_out out_of(ps_kind k, char *error) {
	if (k == K_PENDING) return (sc_out){.kind = SC_PENDING};
	if (k == K_FAILED) return (sc_out){.kind = SC_FAILED, .error = error};
	// told to end now: return at once
	return (sc_out){.kind = SC_VALUE};
}

// the value through the compilers, then a loaded runner's live form
static sc_out build_f(void *previous, void *data) {
	(void)previous;
	ps_process *p = data;
	const op_value *v = p->value != NULL ? p->value : p->nothing;
	folded f = fold(p, p->chain.steps, p->chain.n - 1, v);
	if (f.kind != K_OK) return out_of(f.kind, f.error);
	const pg_step *runner = &p->chain.steps[p->chain.n - 1];
	p->runner = NULL;
	if (runner->by.n > 0) {
		lived r = live_of(p, runner);
		if (r.kind != K_OK) return out_of(r.kind, r.error);
		p->runner = r.load;
	}
	return (sc_out){.kind = SC_VALUE, .value = op_ref((op_value *)f.value)};
}

static sc_out fail_f(void *previous, void *data) {
	(void)previous;
	return (sc_out){.kind = SC_FAILED, .error = pg_dup(data)};
}
static char *no_set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}

typedef struct {
	ps_process *p;
	const op_value *code;
	const char *error;
	hf_runner fn;
	void *data;
	sc_computer *outcome;
	hf_run out;
} running;

static void call_runner(void *data) {
	running *r = data;
	ps_process *p = r->p;
	ps *s = p->owner;
	ps_context ctx = {.places = pr_places(p->life), .root = pr_root(p->life),
		.scheduler = s->s.scheduler, .table = s->s.table, .scope = pr_scope(p->life)};
	ctx.process.id = pr_id(p->life);
	ctx.process.nat = pr_at(p->life, &ctx.process.at);
	ctx.process.nargs = pr_args(p->life, &ctx.process.args);
	ctx.process.ncwd = pr_cwd(p->life, &ctx.process.cwd);
	p->api = s->s.create_api != NULL ? s->s.create_api(&ctx, s->s.data) : NULL;
	r->out = r->fn(r->code, p->api, r->data);
}

static void make_outcome(void *data) {
	running *r = data;
	ps *s = r->p->owner;
	r->outcome = sc_create_computer(s->s.scheduler,
		(sc_def){.f = fail_f, .set = no_set, .data = (void *)r->error});
}

// the runner called, the process's scope open: a host's function, or a loaded one's run. a handle:
// held; a failure: a computer holding it, its status the node's
static void run(ps_process *p, const pg_step *runner, const op_value *code) {
	ps *s = p->owner;
	running r = {.p = p, .code = code};
	if (runner->by.n > 0) {
		if (p->runner != NULL && !p->runner->closed) r.fn = p->runner->live.run, r.data = p->runner->live.data;
	} else {
		const nd_entry *e = tb_get(s->s.table, tb_string("value"), tb_string(runner->place.id));
		const hf_entry *fn = e != NULL ? hf_find(s->s.functions, e->value) : NULL;
		if (fn != NULL) r.fn = fn->runner, r.data = fn->data;
	}
	if (r.fn == NULL) r.error = "not-a-runner";
	else {
		sc_run_with_scope(pr_scope(p->life), call_runner, &r);
		if (r.out.error != NULL) r.error = r.out.error;
	}
	if (r.error != NULL) {
		// the error text outlives the computer: kept in the process
		char *kept = pg_dup(r.error);
		free(r.out.error);
		r.error = kept;
		sc_run_with_scope(pr_scope(p->life), make_outcome, &r);
		if (r.outcome != NULL) pr_give(s->life, p->life, r.outcome, 0);
		free(p->failure);
		p->failure = kept;
		return;
	}
	if (r.out.handle.stop == NULL) return;
	if (p->stopped) r.out.handle.stop(r.out.handle.ctx);
	else p->handle = r.out.handle, p->has_handle = 1;
}

static char *act(void *value, void *previous, void *data) {
	(void)previous;
	ps_process *p = data;
	run(p, &p->chain.steps[p->chain.n - 1], value);
	char *bad = sc_teardown(p->build);
	free(bad);
	return NULL;
}

// start ------------------------------------------------------------------------------------------------

// in the process's scope, as processes' start gives it: the effect that builds, its status (and run)
// the process's node's
static void make_build(pr_process *life, void *data) {
	ps_process *p = data;
	ps *s = p->owner;
	p->life = life;
	p->build = sc_create_effect(s->s.scheduler, (sc_def){.f = build_f, .effect = act, .data = p});
	pr_give(s->life, life, p->build, 1);
}

ps_process *ps_start_at(ps *s, pl *where, const pg_way *way, const char *const *steps, size_t nsteps,
	const ps_options *options, ps_refusal *refused, const char *file, int line, const char *func) {
	*refused = (ps_refusal){0};
	ps_options none = {0};
	const ps_options *o = options != NULL ? options : &none;
	if (way->chain.n == 0) return refused->refused = "no-runner", refused->program = &way->program, NULL;
	ps_process *p = pg_alloc(sizeof *p);
	p->owner = s;
	p->nothing = op_null();
	PG_PUSH(s->all, s->n, s->cap, p);
	const nd_entry *e = tb_get(s->s.table, tb_string("value"), tb_string(way->program.id));
	p->value = e != NULL && e->value != NULL ? op_ref(e->value) : NULL;
	pg_chain_copy(&p->chain, &way->chain);
	key_chain(p);
	// the pin, from the path and cwd as processes' start resolves them
	size_t nat, ncwd;
	char **at = pr_names(steps, nsteps, &nat);
	char **cwd = pr_cwd_of((const char *const *)at, nat, o->cwd, o->ncwd, o->has_cwd, &ncwd);
	op_value *pin = pin_of(s, pl_root(where).string, cwd, ncwd, way, p->value);
	pr_refusal no;
	pr_process *life = pr_start_at(s->life, where, steps, nsteps,
		&(pr_options){.args = o->args, .nargs = o->nargs, .has_args = o->has_args,
			.cwd = (const char *const *)cwd, .ncwd = ncwd, .has_cwd = 1, .pin = pin,
			.body = make_build, .stop = end, .data = p},
		&no, file, line, func);
	op_free(pin);
	pr_names_free(at, nat);
	pr_names_free(cwd, ncwd);
	if (life == NULL) {
		// refused: the process made no more (its pieces freed at ps_free)
		p->stopped = 1;
		refused->refused = no.refused;
		refused->at = no.at, refused->nat = no.nat;
		return NULL;
	}
	return p;
}

void ps_stop(ps *s, ps_process *p) { pr_stop(s->life, p->life); }

void ps_halt(ps *s) {
	if (s == NULL || s->halted) return;
	s->halted = 1;
	pr_halt(s->life);
}

void ps_free(ps *s) {
	if (s == NULL) return;
	// a process never stopped: its runner's stop, its loads let go (processes' pr_free calls end)
	pr_free(s->life);
	for (size_t i = 0; i < s->n; i++) {
		ps_process *p = s->all[i];
		if (p->api != NULL && s->s.free_api != NULL) s->s.free_api(p->api, s->s.data);
		free(p->failure);
		op_free(p->value);
		op_free(p->nothing);
		for (size_t j = 0; j < p->nkeyed; j++) free(p->keyed[j].key), op_free(p->keyed[j].value);
		free(p->keyed);
		free(p->held);
		pg_chain_free(&p->chain);
		free(p);
	}
	free(s->all);
	for (size_t i = 0; i < s->nloads; i++) {
		close_load(s->loads[i]);
		free(s->loads[i]->key);
		op_free(s->loads[i]->value);
		free(s->loads[i]->error);
		free(s->loads[i]);
	}
	free(s->loads);
	op_free((op_value *)s->owner_info.value);
	free(s);
}
