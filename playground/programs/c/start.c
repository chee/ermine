// Start (start.h), in C.
#include "start.h"

#include <string.h>

#include "../../compilers/c/mem.h"

typedef struct ps_slot ps_slot;

// a step keyed at start (a loaded one, or a by of one): its key; a loaded one's value, read then
typedef struct {
	const pg_step *step;
	char *key;
	op_value *value;
} ps_keyed;

// a process being built (start.ts' State): its process (software's; NULL: refused), the way it runs
// and the program's value read at start; the chain's steps keyed at start, its loaded steps (by
// key); the chain's runner, live, once built; gone: its scope torn down, what it was loading lands
// for no one
struct ps_process {
	ps *owner;
	sw_process *process;
	op_value *value;
	op_value *nothing;
	pg_chain chain;
	ps_keyed *keyed;
	size_t nkeyed, capkeyed;
	ps_slot **slots;
	size_t nslots, capslots;
	hf_entry runner;
	int gone;
};

// a loaded step in one process (start.ts' Slot): its key, what loads it (its by's runner, carried:
// its id and live form as read), the code given and the keys of its by; landed, its live form (as
// bd_fold takes a loaded compiler's) or its failure (malloc'd); its hold on software's load
struct ps_slot {
	char *key;
	ps_process *p;
	const pg_step *step;
	const char *by_id;
	hf_entry by;
	op_value *code;
	const char **chain;
	size_t nchain;
	int landed;
	bd_loaded loaded;
	char *error;
	sw_loaded *hold;
};

struct ps {
	ps_setup s;
	// the processes' scope, its info [["programs", "start"]]: software's setup.scope
	sc_scope *owner;
	sc_pair owner_info;
	sw *software;
	ps_process **all;
	size_t n, cap;
	// loads wanted in a run, asked of software as it ends
	sc_listener *ends;
	ps_slot **wanted;
	size_t nwanted, capwanted;
	int asking, halted;
};

// a run's end: the loads wanted asked of software (start.ts' onRunEnd)
static void ask_loads(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data);

ps *ps_new_at(const ps_setup *setup, const char *file, int line, const char *func) {
	ps *p = pg_alloc(sizeof *p);
	p->s = *setup;
	p->owner_info = (sc_pair){"programs", op_str("start")};
	p->owner = sc_create_scope(setup->scheduler, &p->owner_info, 1, NULL);
	if (setup->sites != NULL) st_note(setup->sites, p->owner, file, line, func);
	p->software = sw_new(&(sw_setup){.scheduler = setup->scheduler, .table = setup->table,
		.places = setup->places, .scopes = setup->scopes, .functions = setup->functions,
		.scope = p->owner, .sites = setup->sites, .schedule = setup->schedule,
		.schedule_ctx = setup->schedule_ctx, .commit = setup->commit,
		.commit_ctx = setup->commit_ctx, .runs = setup->runs});
	p->ends = sc_on_run_end(setup->scheduler, ask_loads, p);
	return p;
}

const char *ps_id(const ps_process *p) { return sw_process_id(p->process); }
sc_scope *ps_scope(const ps_process *p) { return sw_process_scope(p->process); }
size_t ps_at(const ps_process *p, const char *const **out) { return sw_process_at(p->process, out); }

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

static op_value *pin_of(ps *s, const char *root, char *const *folder, size_t nfolder, const pg_way *way,
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
	op_set(pin, "folder", names_value(folder, nfolder));
	return pin;
}

// keys ---------------------------------------------------------------------------------------------

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

// live forms and the fold ----------------------------------------------------------------------------

typedef enum { K_OK, K_PENDING, K_FAILED, K_STOP } ps_kind;

// a live form, or why none yet: pending, failed (error malloc'd), or the run told to end. slot: a
// loaded one's
typedef struct {
	ps_kind kind;
	hf_live live;
	ps_slot *slot;
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

static ps_slot *slot_of(ps_process *p, const char *key) {
	for (size_t i = 0; i < p->nslots; i++) {
		if (strcmp(p->slots[i]->key, key) == 0) return p->slots[i];
	}
	return NULL;
}

// a step's live form (start.ts' liveOf): a host's, its node's function's (none: not-a-runner); a
// loaded one's, its load's, asked of software as this run ends (its by's runner with no load:
// not-a-loader); pending while it loads; its failure no one's but its holders'
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
	ps_slot *slot = slot_of(p, key);
	if (slot == NULL) {
		const pg_step *runner = &st->by.steps[st->by.n - 1];
		lived by = live_of(p, runner);
		if (by.kind != K_OK) return by;
		if (by.live.run == NULL) return not_live(K_FAILED, pg_dup("not-a-runner"));
		if (by.live.load == NULL) return not_live(K_FAILED, pg_dup("not-a-loader"));
		folded code = fold(p, st->by.steps, st->by.n - 1, value_of(p, st));
		if (code.kind != K_OK) return not_live(code.kind, code.error);
		slot = pg_alloc(sizeof *slot);
		slot->key = pg_dup(key);
		slot->p = p;
		slot->step = st;
		slot->by_id = runner->place.id;
		slot->by = (hf_entry){.runner = by.live.run, .load = by.live.load, .data = by.live.data};
		slot->code = op_ref((op_value *)(code.value != NULL ? code.value : p->nothing));
		slot->chain = pg_alloc((st->by.n + 1) * sizeof *slot->chain);
		for (size_t i = 0; i < st->by.n; i++) slot->chain[slot->nchain++] = key_of(p, &st->by.steps[i]);
		PG_PUSH(p->slots, p->nslots, p->capslots, slot);
		PG_PUSH(s->wanted, s->nwanted, s->capwanted, slot);
	}
	if (!slot->landed) {
		if (sc_track(s->s.scheduler, slot) == SC_STOP) return not_live(K_STOP, NULL);
		return not_live(K_PENDING, NULL);
	}
	if (slot->error != NULL) return not_live(K_FAILED, pg_dup(slot->error));
	return (lived){.kind = K_OK, .live = slot->loaded.live, .slot = slot};
}

// what fold hands bd_fold: the process, and the chain's steps
typedef struct {
	ps_process *p;
	const pg_step *steps;
} folding;

// a live form's why-none-yet, as bd_fold takes it
static bd_kind fold_kind(ps_kind k) {
	return k == K_PENDING ? BD_PENDING : k == K_STOP ? BD_STOP : k == K_FAILED ? BD_FAILED : BD_VALUE;
}

// compiler i for bd_fold (start.ts' compilerOf): a host's, its id; a loaded one's, its load (its
// live form with no compile: not-a-compiler) and its value as read at start
static bd_compiler compiler_of(size_t i, void *data) {
	folding *f = data;
	const pg_step *c = &f->steps[i];
	if (c->by.n == 0) return (bd_compiler){.kind = BD_VALUE, .id = c->place.id};
	lived l = live_of(f->p, c);
	if (l.kind != K_OK) return (bd_compiler){.kind = fold_kind(l.kind), .error = l.error};
	if (l.live.compile == NULL) return (bd_compiler){.kind = BD_FAILED, .error = pg_dup("not-a-compiler")};
	ps_keyed *k = keyed_of(f->p, c);
	return (bd_compiler){.kind = BD_VALUE, .id = c->place.id, .load = &l.slot->loaded,
		.value = k != NULL ? k->value : NULL};
}

// the value through the compilers (start.ts' folded): the compilers library's bd_fold
static folded fold(ps_process *p, const pg_step *steps, size_t n, const op_value *v) {
	ps *s = p->owner;
	folding f = {p, steps};
	bd_folded r = bd_fold(&(bd_folding){s->s.builds, s->s.table, compiler_of, &f}, n, v);
	switch (r.kind) {
	case BD_VALUE: return (folded){.kind = K_OK, .value = r.value};
	case BD_PENDING: return (folded){.kind = K_PENDING};
	case BD_STOP: return (folded){.kind = K_STOP};
	default: return (folded){.kind = K_FAILED, .error = r.error};
	}
}

// loads ------------------------------------------------------------------------------------------------

// how a slot's load landed (live, else error: taken), its readers marked. a failure is no one's but
// its holders': let go now, so a later start loads it again. its process gone: nothing
static void land(ps *s, ps_slot *slot, const hf_live *live, char *error) {
	if (slot->p->gone) {
		free(error);
		return;
	}
	slot->landed = 1;
	if (live != NULL) slot->loaded.live = *live;
	slot->error = error;
	if (error != NULL && slot->hold != NULL) sw_release(s->software, slot->hold), slot->hold = NULL;
	const void *key = slot;
	sc_mark(s->s.scheduler, &key, 1, NULL);
}

// a slot's load asked of software, held by its process. its process gone by now: nothing asked
static void load(ps *s, ps_slot *slot) {
	ps_process *p = slot->p;
	if (p->process == NULL || p->gone) return;
	const char *const *at;
	size_t nat = sw_process_at(p->process, &at);
	sw_place by = {sw_process_id(p->process), at, nat, sw_process_scope(p->process), 0};
	sw_refusal no;
	sw_loaded *l = sw_load_carried(s->software, &by, &(sw_carried){slot->by_id, &slot->by},
		&(sw_program){.id = slot->step->place.id, .code = slot->code},
		&(sw_load_options){.chain = slot->chain, .nchain = slot->nchain}, &no);
	if (l == NULL) {
		const char *why = strcmp(no.refused, "failed") == 0 ? no.error : NULL;
		char *error;
		if (why != NULL) error = pg_dup(why);
		else {
			error = pg_alloc(strlen(no.refused) + 13);
			strcpy(error, "not loaded: ");
			strcat(error, no.refused);
		}
		land(s, slot, NULL, error);
		return;
	}
	slot->hold = l;
	land(s, slot, sw_loaded_live(l), NULL);
}

static void ask_loads(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data) {
	(void)c, (void)n, (void)ended, (void)reads, (void)nreads, (void)more;
	ps *s = data;
	if (s->asking) return;
	s->asking = 1;
	for (size_t i = 0; i < s->nwanted; i++) load(s, s->wanted[i]);
	s->nwanted = 0;
	s->asking = 0;
}

// the build -------------------------------------------------------------------------------------------

static sc_out out_of(ps_kind k, char *error) {
	if (k == K_PENDING) return (sc_out){.kind = SC_PENDING};
	if (k == K_FAILED) return (sc_out){.kind = SC_FAILED, .error = error};
	// told to end now: return at once
	return (sc_out){.kind = SC_VALUE};
}

// a step as a runner (start.ts' runnerAt): its live form's run (none: not-a-runner); pending while
// it loads
static lived runner_at(ps_process *p, const pg_step *st) {
	lived l = live_of(p, st);
	if (l.kind == K_OK && l.live.run == NULL) return not_live(K_FAILED, pg_dup("not-a-runner"));
	return l;
}

// the program's code (software's build): its value through the chain's compilers, once the runner
// is live too; pending while either is
static sc_out build_f(void *data) {
	ps_process *p = data;
	const op_value *v = p->value != NULL ? p->value : p->nothing;
	folded f = fold(p, p->chain.steps, p->chain.n - 1, v);
	if (f.kind != K_OK) return out_of(f.kind, f.error);
	lived r = runner_at(p, &p->chain.steps[p->chain.n - 1]);
	if (r.kind != K_OK) return out_of(r.kind, r.error);
	p->runner = (hf_entry){.runner = r.live.run, .load = r.live.load, .data = r.live.data};
	const op_value *code = f.value != NULL ? f.value : p->nothing;
	return (sc_out){.kind = SC_VALUE, .value = op_ref((op_value *)code)};
}

// the runner software starts: the chain's, as the build found it
static hf_run start_f(const op_value *code, void *api, void *data) {
	ps_process *p = data;
	if (p->runner.runner == NULL) return (hf_run){.error = pg_dup("not-a-runner")};
	return p->runner.runner(code, api, p->runner.data);
}

// start ------------------------------------------------------------------------------------------------

// its scope gone: what it was still loading lands for no one, its loaded live forms closed to bd_fold
static char *gone(void *data) {
	ps_process *p = data;
	p->gone = 1;
	for (size_t i = 0; i < p->nslots; i++) p->slots[i]->loaded.closed = 1;
	return NULL;
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
	// the pin, from the path and folder as processes' start resolves them
	size_t nat, nfolder;
	char **at = pr_names(steps, nsteps, &nat);
	char **folder = pr_folder_of((const char *const *)at, nat, o->folder, o->nfolder, o->has_folder, &nfolder);
	op_value *pin = pin_of(s, pl_root(where).string, folder, nfolder, way, p->value);
	// the runner as the build finds it, started by software; the program built
	hf_entry live = {.runner = start_f, .data = p};
	const pg_step *runner = &p->chain.steps[p->chain.n - 1];
	sw_refusal no;
	p->process = sw_run_carried_at(s->software, &(sw_carried){runner->place.id, &live},
		&(sw_program){.id = way->program.id, .build = build_f, .build_data = p}, steps, nsteps,
		&(sw_options){.args = o->args, .nargs = o->nargs, .has_args = o->has_args,
			.folder = (const char *const *)folder, .nfolder = nfolder, .has_folder = 1, .box = where, .pin = pin},
		&no, &(ch_site){file, line, 0, func, 0});
	op_free(pin);
	pr_names_free(at, nat);
	pr_names_free(folder, nfolder);
	if (p->process == NULL) {
		// refused: made no more (its pieces freed at ps_free)
		p->gone = 1;
		refused->refused = no.refused;
		refused->at = no.at, refused->nat = no.nat;
		return NULL;
	}
	free(sc_register_teardown(s->s.scheduler, sw_process_scope(p->process), gone, p));
	return p;
}

void ps_stop_at(ps *s, ps_process *p, const op_value *reason, const ch_site *site) {
	if (p == NULL || p->process == NULL) return;
	sw_stop_at(s->software, sw_process_id(p->process), reason, site);
}

void ps_halt(ps *s) {
	if (s == NULL || s->halted) return;
	s->halted = 1;
	sc_remove_listener(s->ends);
	sw_halt(s->software);
}

void ps_free(ps *s) {
	if (s == NULL) return;
	// a process never stopped: its runner's stop, its loads let go (software's)
	sw_free(s->software);
	for (size_t i = 0; i < s->n; i++) {
		ps_process *p = s->all[i];
		op_free(p->value);
		op_free(p->nothing);
		for (size_t j = 0; j < p->nkeyed; j++) free(p->keyed[j].key), op_free(p->keyed[j].value);
		free(p->keyed);
		for (size_t j = 0; j < p->nslots; j++) {
			ps_slot *slot = p->slots[j];
			free(slot->key);
			op_free(slot->code);
			free(slot->chain);
			free(slot->error);
			free(slot);
		}
		free(p->slots);
		pg_chain_free(&p->chain);
		free(p);
	}
	free(s->all);
	free(s->wanted);
	op_free((op_value *)s->owner_info.value);
	free(s);
}
