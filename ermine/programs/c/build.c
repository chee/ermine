// Build (build.h), in C.
#include "build.h"

#include <string.h>

#include "../../../core/scheduler/c/ptrmap.h"
#include "../../encoding/c/cbor.h"
#include "../../encoding/c/hash.h"
#include "../../encoding/c/pack.h"
#include "mem.h"
#include "programs.h"

typedef struct bd_task task;

struct bd_task {
	bd *owner;
	char key[65];
	// the step's status node
	char *node;
	char *compiler;
	hf_compiler fn;
	void *data;
	op_value *input;
	op_value *identity;
	sc_computer *c;
	// how its last run ended; whether a run reads it; whether it was taken out
	int has_ended;
	sc_ended ended;
	int held;
	int retired;
};

struct bd {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	char *cache;
	const hf *functions;
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// the steps' owner
	sc_scope *scope;
	cst *statuses;
	// the steps not done yet, by key
	task **tasks;
	size_t ntasks, captasks;
	// every task made (the keys the scheduler tells of), and the computer of each
	pm all, of;
	// every task, to free
	task **made;
	size_t nmade, capmade;
	// steps wanted in a run, made as it ends
	task **wanted;
	size_t nwanted, capwanted;
	sc_listener *listeners[4];
	int stopped;
};

// values --------------------------------------------------------------------------------------------

// why canonical CBOR does not encode a value; NULL: it does
static const char *unencodable(const op_value *v) {
	if (v == NULL) return "no value";
	if (hf_holds(v)) return "a function";
	Json *j = pk_to_json(v);
	if (j == NULL) return "no encoding";
	size_t length;
	const char *why = NULL;
	int ok = cborEncode(j, NULL, 0, &length, &why);
	jsonFree(j);
	return ok ? NULL : why;
}

static void hex_of(const uint8_t *b, char out[65]) {
	static const char hex[] = "0123456789abcdef";
	for (size_t i = 0; i < 32; i++) {
		out[2 * i] = hex[b[i] >> 4];
		out[2 * i + 1] = hex[b[i] & 15];
	}
	out[64] = 0;
}

int bd_hash_hex(const op_value *v, char out[65]) {
	if (unencodable(v) != NULL) return 0;
	Json *j = pk_to_json(v);
	uint8_t h[32];
	const char *why;
	int ok = hashValue(j, h, &why);
	jsonFree(j);
	if (ok) hex_of(h, out);
	return ok;
}

// hex of hash([identity, input]); 0: no encoding
static int key_of(const op_value *identity, const op_value *input, char out[65]) {
	if (unencodable(identity) != NULL || unencodable(input) != NULL) return 0;
	Json *both = jsonArray();
	jsonPush(both, pk_to_json(identity));
	jsonPush(both, pk_to_json(input));
	uint8_t h[32];
	const char *why;
	int ok = hashValue(both, h, &why);
	jsonFree(both);
	if (ok) hex_of(h, out);
	return ok;
}

static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

// a step ---------------------------------------------------------------------------------------------

static void done_commit(bd *b, const pl_changed *changed) {
	if (b->commit != NULL) b->commit(b->commit_ctx, changed);
	else pl_commit(b->places, changed);
}

// the result kept: a value entry, named in the cache folder. one there already: nothing
static char *keep(task *t, const op_value *value) {
	bd *b = t->owner;
	const char *why = unencodable(value);
	if (why != NULL) {
		char *m = pg_alloc(strlen(why) + 40);
		snprintf(m, strlen(why) + 40, "uncacheable (the result: %s)", why);
		return m;
	}
	const nd_entry *there = tb_get(b->table, tb_string("children"), tb_string(b->cache));
	if (there != NULL && is_map(there->value) && op_get(there->value, t->key) != NULL) return NULL;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(b->places, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) return bad;
	char *uuid = pg_uuid(), *id = pg_alloc(strlen(uuid) + 7);
	strcpy(id, "cache:");
	strcat(id, uuid);
	free(uuid);
	nd_entry *node = nd_make_entry((op_value *)value, &h, NULL);
	pl_own(b->places, node);
	pl_hold(b->places, node, pl_made_ref(made), pl_made_free);
	tb_add(b->table, tb_string("value"), tb_string(id), node);
	// its type: what the compiler gives (ermine.programs.gives), if it says; not in the key
	op_key gk = {.type = OP_STR_KEY, .s = PG_GIVES};
	const op_value *gives = pl_read(b->places, tb_string("attributes"), tb_string(t->compiler), &gk, 1);
	if (gives != NULL && gives->type == OP_STR) {
		op_value *m = op_map();
		op_set(m, PG_TYPE, op_str(gives->str));
		nd_entry *typed = nd_make_entry(m, &h, NULL);
		pl_own(b->places, typed);
		pl_hold(b->places, typed, pl_made_ref(made), pl_made_free);
		tb_add(b->table, tb_string("attributes"), tb_string(id), typed);
	}
	op_value *named = op_str(id);
	const char *at[] = {t->key};
	pl_changed changed;
	nd_entry *born;
	pl_upsert(b->places, tb_string("children"), tb_string(b->cache), at, 1, named, h, &changed, &born);
	op_free(named);
	free(id);
	done_commit(b, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(b->places, changed.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (born != NULL) pl_hold(b->places, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
	return NULL;
}

static char *step_set(void *value, void *data) { return keep(data, value); }

static sc_out step_f(void *previous, void *data) {
	(void)previous;
	task *t = data;
	hf_context ctx = {t->key, t->compiler, t->identity};
	hf_out out = t->fn(t->input, &ctx, t->data);
	switch (out.kind) {
	case HF_PENDING: return (sc_out){.kind = SC_PENDING};
	case HF_FAILED: return (sc_out){.kind = SC_FAILED, .error = out.error};
	case HF_AWAIT: return (sc_out){.kind = SC_AWAIT, .promise = out.promise};
	case HF_VALUE: break;
	}
	const char *why = unencodable(out.value);
	if (why != NULL) {
		op_free(out.value);
		char *m = pg_alloc(strlen(why) + 40);
		snprintf(m, strlen(why) + 40, "uncacheable (the result: %s)", why);
		return (sc_out){.kind = SC_FAILED, .error = m};
	}
	return (sc_out){.kind = SC_VALUE, .value = out.value};
}

static void make_step(void *data) {
	task *t = data;
	t->c = sc_create_computer(t->owner->scheduler,
		(sc_def){.f = step_f, .set = step_set, .data = t});
}

// a step's computer, under the steps' scope. wanted in a run, made as the run ends, not in it: made
// in a run, it would carry that run's cause, and its result landing would be a loop through the run
// that reads it
static void start(task *t) {
	bd *b = t->owner;
	if (!sc_scope_alive(b->scope)) return;
	sc_run_with_scope(b->scope, make_step, t);
	if (t->c == NULL) return;
	pm_set(&b->of, t->c, t);
	cst_give(b->statuses, t->c, tb_string(t->node));
}

// a step gone: its computer torn down, its status taken out
static void retire(task *t) {
	bd *b = t->owner;
	for (size_t i = 0; i < b->ntasks; i++) {
		if (b->tasks[i] == t) {
			b->tasks[i] = b->tasks[--b->ntasks];
			break;
		}
	}
	t->retired = 1;
	if (t->c != NULL && sc_scope_alive(t->c)) {
		char *bad = sc_teardown(t->c);
		free(bad);
	}
	if (tb_get(b->table, tb_string("attributes"), tb_string(t->node)) != NULL) {
		tb_del(b->table, tb_string("attributes"), tb_string(t->node));
	}
}

static int failed(sc_ended e) { return e == SC_FAIL || e == SC_LOOPING; }

static void drain(bd *b) {
	while (b->nwanted) {
		task *t = b->wanted[0];
		memmove(b->wanted, b->wanted + 1, --b->nwanted * sizeof *b->wanted);
		start(t);
	}
}

// a step done (its result landed) goes; failed, once no run reads it
static void run_end(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads, size_t nreads,
	const sc_more *more, void *data) {
	(void)n, (void)reads, (void)nreads, (void)more;
	bd *b = data;
	task *t = pm_get(&b->of, c);
	if (t != NULL) {
		t->has_ended = 1;
		t->ended = ended;
		if (ended == SC_DONE || (failed(ended) && !t->held)) retire(t);
	}
	drain(b);
}

static void effect(sc_computer *c, unsigned n, const char *error, void *data) {
	(void)c, (void)n, (void)error;
	drain(data);
}

static void tracking_start(const void *key, sc_run *run, void *data) {
	(void)run;
	bd *b = data;
	task *t = pm_get(&b->all, key);
	if (t != NULL) t->held = 1;
}

static void tracking_end(const void *key, void *data) {
	bd *b = data;
	task *t = pm_get(&b->all, key);
	if (t == NULL) return;
	t->held = 0;
	if (t->has_ended && failed(t->ended) && !t->retired) retire(t);
}

bd *bd_new(const bd_setup *setup) {
	bd *b = pg_alloc(sizeof *b);
	b->places = setup->places;
	b->table = setup->table;
	b->scheduler = setup->scheduler;
	b->cache = pg_dup(setup->cache);
	b->functions = setup->functions;
	b->commit = setup->commit;
	b->commit_ctx = setup->commit_ctx;
	b->scope = sc_create_scope(b->scheduler, NULL, 0, NULL);
	b->statuses = cst_new(&(cst_setup){setup->places, setup->table, setup->scheduler});
	b->listeners[0] = sc_on_run_end(b->scheduler, run_end, b);
	b->listeners[1] = sc_on_effect(b->scheduler, effect, b);
	b->listeners[2] = sc_on_tracking_start(b->scheduler, tracking_start, b);
	b->listeners[3] = sc_on_tracking_end(b->scheduler, tracking_end, b);
	return b;
}

// compile ----------------------------------------------------------------------------------------------

static int starts(const char *text, const char *code) {
	size_t n = strlen(code);
	return strncmp(text, code, n) == 0 && (text[n] == 0 || text[n] == ' ');
}

bd_result bd_compile(bd *b, const char *compiler, const op_value *input) {
	op_key ik = {.type = OP_STR_KEY, .s = BD_COMPILER};
	const op_value *identity = pl_read(b->places, tb_string("attributes"), tb_string(compiler), &ik, 1);
	op_value *own = NULL;
	if (identity == NULL || identity->type == OP_NULL) identity = own = op_str(compiler);
	char key[65];
	bd_result r = {0};
	if (!key_of(identity, input, key)) {
		op_free(own);
		return (bd_result){.kind = BD_REFUSED, .text = "uncacheable"};
	}
	op_key ck = {.type = OP_STR_KEY, .s = key};
	const op_value *named = pl_read(b->places, tb_string("children"), tb_string(b->cache), &ck, 1);
	if (named != NULL && named->type == OP_STR) {
		const op_value *v = pl_read(b->places, tb_string("value"), tb_string(named->str), NULL, 0);
		op_free(own);
		if (pl_status(b->places) == SC_STOP) return (bd_result){.kind = BD_STOP};
		return v == NULL ? (bd_result){.kind = BD_PENDING} : (bd_result){.kind = BD_VALUE, .value = v};
	}
	task *t = NULL;
	for (size_t i = 0; i < b->ntasks; i++) {
		if (strcmp(b->tasks[i]->key, key) == 0) t = b->tasks[i];
	}
	if (t == NULL) {
		const nd_entry *e = tb_get(b->table, tb_string("value"), tb_string(compiler));
		const hf_entry *fn = e != NULL ? hf_find(b->functions, e->value) : NULL;
		if (fn == NULL || fn->compiler == NULL) {
			op_free(own);
			return (bd_result){.kind = BD_REFUSED, .text = "not-a-compiler"};
		}
		t = pg_alloc(sizeof *t);
		t->owner = b;
		strcpy(t->key, key);
		char *u = pg_uuid();
		t->node = pg_alloc(strlen(u) + 6);
		strcpy(t->node, "step:");
		strcat(t->node, u);
		free(u);
		t->compiler = pg_dup(compiler);
		t->fn = fn->compiler;
		t->data = fn->data;
		t->input = op_ref((op_value *)input);
		t->identity = own != NULL ? own : op_ref((op_value *)identity);
		own = NULL;
		PG_PUSH(b->tasks, b->ntasks, b->captasks, t);
		PG_PUSH(b->made, b->nmade, b->capmade, t);
		pm_set(&b->all, t, t);
		// outside a run, at once
		if (sc_get_run(b->scheduler) == NULL) start(t);
		else PG_PUSH(b->wanted, b->nwanted, b->capwanted, t);
	}
	op_free(own);
	sc_track_status tracked = sc_track(b->scheduler, t);
	const op_value *st = cst_status(b->places, tb_string(t->node));
	if (tracked == SC_STOP || pl_status(b->places) == SC_STOP) return (bd_result){.kind = BD_STOP};
	const char *error = st != NULL ? cst_error(st) : NULL;
	if (error == NULL) return (bd_result){.kind = BD_PENDING};
	if (starts(error, "not-a-compiler")) return (bd_result){.kind = BD_REFUSED, .text = "not-a-compiler"};
	if (starts(error, "uncacheable")) return (bd_result){.kind = BD_REFUSED, .text = "uncacheable"};
	r.kind = BD_FAILED;
	r.text = error;
	return r;
}

void bd_stop(bd *b) {
	if (b == NULL || b->stopped) return;
	b->stopped = 1;
	for (size_t i = 0; i < 4; i++) sc_remove_listener(b->listeners[i]);
	cst_stop(b->statuses);
	b->nwanted = 0;
	while (b->ntasks) retire(b->tasks[0]);
	if (sc_scope_alive(b->scope)) free(sc_teardown(b->scope));
}

void bd_free(bd *b) {
	if (b == NULL) return;
	cst_free(b->statuses);
	for (size_t i = 0; i < b->nmade; i++) {
		task *t = b->made[i];
		free(t->node);
		free(t->compiler);
		op_free(t->input);
		op_free(t->identity);
		free(t);
	}
	free(b->made), free(b->tasks), free(b->wanted), free(b->cache);
	pm_clear(&b->all);
	pm_clear(&b->of);
	free(b);
}
