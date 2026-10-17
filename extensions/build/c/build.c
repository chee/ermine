// Build (build.h), in C.
#include "build.h"

#include <string.h>

#include "../../../core/op/c/json.h"
#include "../../../core/scheduler/c/ptrmap.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/hash.h"
#include "../../../ermine/clingy/c/clingy.h"
#include "../../../ermine/encoding/c/pack.h"
#include "mem.h"

// what an output is typed with, and what a compiler says it gives (as build.ts reads them)
#define BD_TYPE "ermine.type"
#define BD_GIVES "ermine.programs.gives"

typedef struct bd_task task;

struct bd_task {
	bd *owner;
	char key[65];
	// the step's status node
	char *node;
	op_value *name, *code;
	// a step's run; a compile's: its compiler's id (its function looked up as it runs)
	bd_run run;
	void *data;
	char *compiler;
	// its outputs' ermine.type; NULL: none
	char *type;
	sc_computer *c;
	// how its last run ended; whether it was taken out
	int has_ended;
	sc_ended ended;
	int retired;
	// the reads of its run now
	const void **keys;
	size_t nkeys, capkeys;
};

struct bd {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	char *cache;
	const hf *functions;
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// the steps' owner, and its info's value
	sc_scope *scope;
	op_value *info;
	cst *statuses;
	// the steps out, by key
	task **tasks;
	size_t ntasks, captasks;
	// every step out: whether a run reads it (the last reader gone, it goes); the computer of each
	cl_clingy *steps;
	pm of;
	// every task, to free
	task **made;
	size_t nmade, capmade;
	// steps wanted in a run, made as it ends
	task **wanted;
	size_t nwanted, capwanted;
	// the step whose run is running now: its reads recorded
	task *recording;
	bd_found_fn found;
	void *found_ctx;
	sc_listener *listeners[3];
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

// hex of hash([name, code]); 0: no encoding
static int key_of(const op_value *name, const op_value *code, char out[65]) {
	if (unencodable(name) != NULL || unencodable(code) != NULL) return 0;
	Json *both = jsonArray();
	jsonPush(both, pk_to_json(name));
	jsonPush(both, pk_to_json(code));
	uint8_t h[32];
	const char *why;
	int ok = hashValue(both, h, &why);
	jsonFree(both);
	if (ok) hex_of(h, out);
	return ok;
}

static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

static char *refusal(const char *what, const char *why) {
	size_t n = strlen(what) + strlen(why) + 20;
	char *m = pg_alloc(n);
	snprintf(m, n, "uncacheable (%s%s)", what, why);
	return m;
}

// an entry's name as a number: newest first, names that are none last
static long number(const char *name) {
	if (name[0] < '1' || name[0] > '9') return 0;
	for (const char *p = name; *p; p++) {
		if (*p < '0' || *p > '9') return 0;
	}
	return strtol(name, NULL, 10);
}

typedef struct {
	const char *name;
	const char *id;
	long n;
} ent;

static int newest_first(const void *a, const void *b) {
	long x = ((const ent *)a)->n, y = ((const ent *)b)->n;
	return x < y ? 1 : x > y ? -1 : 0;
}

// a children map's names holding an id, newest first: the caller frees the array
static size_t entries_in(const op_value *kids, ent **out) {
	*out = NULL;
	if (!is_map(kids)) return 0;
	ent *es = pg_alloc(kids->count * sizeof *es);
	size_t n = 0;
	for (size_t i = 0; i < kids->count; i++) {
		if (kids->items[i] == NULL || kids->items[i]->type != OP_STR) continue;
		es[n++] = (ent){kids->keys[i], kids->items[i]->str, number(kids->keys[i])};
	}
	qsort(es, n, sizeof *es, newest_first);
	*out = es;
	return n;
}

// a step ---------------------------------------------------------------------------------------------

static void done_commit(bd *b, const pl_changed *changed) {
	if (b->commit != NULL) b->commit(b->commit_ctx, changed);
	else pl_commit(b->places, changed);
}

// the run's reads, named and hashed now: nothing it read has changed since, or it would be due
// again and not land. NULL, or a refusal
static char *traced(task *t, op_value **out) {
	bd *b = t->owner;
	op_value *reads = op_list(), *scratch = op_num(0);
	pl_set seen = {0};
	char *bad = NULL;
	for (size_t i = 0; i < t->nkeys && bad == NULL; i++) {
		if (!pl_set_add(&seen, t->keys[i])) continue;
		pl_where w;
		if (!pl_spot(b->places, t->keys[i], &w) || w.change || w.part.string == NULL || w.id.string == NULL) {
			bad = refusal("a read builds can't name", "");
			break;
		}
		const nd_entry *e = tb_get(b->table, w.part, w.id);
		const op_value *v = pl_at(e != NULL ? e->value : NULL, w.path, w.length, scratch);
		char h[65];
		if (v != NULL && !bd_hash_hex(v, h)) {
			bad = refusal("a read: ", unencodable(v));
			break;
		}
		op_value *path = op_list();
		for (size_t k = 0; k < w.length; k++) {
			op_push(path, w.path[k].type == OP_NUM_KEY ? op_num((double)w.path[k].n) : op_str(w.path[k].s));
		}
		op_value *read = op_list();
		op_push(read, op_str(w.part.string));
		op_push(read, op_str(w.id.string));
		op_push(read, path);
		op_push(read, v == NULL ? op_null() : op_str(h));
		op_push(reads, read);
	}
	pl_set_free(&seen);
	op_free(scratch);
	if (bad != NULL) {
		op_free(reads);
		return bad;
	}
	*out = reads;
	return NULL;
}

// a node made and added at (part, id), holding value (held), its header's block held
static void add(bd *b, const char *part, const char *id, op_value *value, ch_header *h, pl_made *made) {
	nd_entry *node = nd_make_entry(value, h, NULL);
	pl_own(b->places, node);
	pl_hold(b->places, node, pl_made_ref(made), pl_made_free);
	tb_add(b->table, tb_string(part), tb_string(id), node);
}

// value put at name in the entry under (part, id) (name NULL: the whole value), committed, the
// header's block held
static void put(bd *b, const char *part, const char *id, const char *name, const op_value *value,
	ch_header h, pl_made *made) {
	const char *at[] = {name};
	pl_changed changed;
	nd_entry *born;
	pl_upsert(b->places, tb_string(part), tb_string(id), at, name != NULL, value, h, &changed, &born);
	done_commit(b, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(b->places, changed.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (born != NULL) pl_hold(b->places, born, pl_made_ref(made), pl_made_free);
}

static char *fresh_id(void) {
	char *uuid = pg_uuid(), *id = pg_alloc(strlen(uuid) + 7);
	strcpy(id, "cache:");
	strcat(id, uuid);
	free(uuid);
	return id;
}

// whether a value is a leaf compared by what it is (equal ones are the same to any reader)
static int plain(const op_value *v) {
	return v->type == OP_NULL || v->type == OP_BOOL || v->type == OP_NUM || v->type == OP_STR;
}

// a new entry: the output and the run's trace. the step's node made, named in the cache folder,
// the first time; its value the output kept last. NULL, or a refusal
static char *keep(task *t, op_value *value) {
	bd *b = t->owner;
	const char *why = unencodable(value);
	if (why != NULL) return refusal("the output: ", why);
	op_value *reads;
	char *bad = traced(t, &reads);
	if (bad != NULL) return bad;
	const nd_entry *there = tb_get(b->table, tb_string("children"), tb_string(b->cache));
	const op_value *named = there != NULL && is_map(there->value) ? op_get(there->value, t->key) : NULL;
	char *folder = named != NULL && named->type == OP_STR ? pg_dup(named->str) : NULL;
	const nd_entry *kids = folder != NULL ? tb_get(b->table, tb_string("children"), tb_string(folder)) : NULL;
	ent *es;
	size_t n = entries_in(kids != NULL ? kids->value : NULL, &es);
	// the same reads kept already: nothing new
	char *shown = op_json_text(reads);
	int known = 0;
	long last = 0;
	for (size_t i = 0; i < n; i++) {
		if (es[i].n > last) last = es[i].n;
		const nd_entry *a = tb_get(b->table, tb_string("attributes"), tb_string(es[i].id));
		const op_value *trace = a != NULL && is_map(a->value) ? op_get(a->value, BD_TRACE) : NULL;
		if (trace == NULL || known) continue;
		char *text = op_json_text(trace);
		known = strcmp(text, shown) == 0;
		free(text);
	}
	free(shown);
	if (known) {
		free(es), free(folder);
		op_free(reads);
		return NULL;
	}
	// an output equal by bytes to one this step keeps: that one
	op_value *kept = value;
	char h[65], g[65];
	if (!plain(value) && bd_hash_hex(value, h)) {
		for (size_t i = 0; i < n && kept == value; i++) {
			const nd_entry *e = tb_get(b->table, tb_string("value"), tb_string(es[i].id));
			if (e != NULL && e->value != NULL && bd_hash_hex(e->value, g) && strcmp(g, h) == 0) kept = e->value;
		}
	}
	free(es);
	ch_header hd;
	pl_made *made;
	bad = pl_header(b->places, NULL, 0, CH_HERE, &hd, &made);
	if (bad != NULL) {
		free(folder);
		op_free(reads);
		return bad;
	}
	char *id = fresh_id();
	add(b, "value", id, kept, &hd, made);
	op_value *attrs = op_map();
	op_set(attrs, BD_TRACE, reads);
	if (t->type != NULL) op_set(attrs, BD_TYPE, op_str(t->type));
	add(b, "attributes", id, attrs, &hd, made);
	op_free(attrs);
	char name[24];
	snprintf(name, sizeof name, "%ld", last + 1);
	op_value *named_id = op_str(id);
	if (folder == NULL) {
		folder = fresh_id();
		add(b, "value", folder, kept, &hd, made);
		if (t->type != NULL) {
			op_value *typed = op_map();
			op_set(typed, BD_TYPE, op_str(t->type));
			add(b, "attributes", folder, typed, &hd, made);
			op_free(typed);
		}
		op_value *children = op_map();
		op_set(children, name, op_ref(named_id));
		add(b, "children", folder, children, &hd, made);
		op_free(children);
		op_value *f = op_str(folder);
		put(b, "children", b->cache, t->key, f, hd, made);
		op_free(f);
	} else {
		put(b, "children", folder, name, named_id, hd, made);
		put(b, "value", folder, NULL, kept, hd, made);
	}
	op_free(named_id);
	free(id), free(folder);
	pl_made_free(made);
	return NULL;
}

static char *step_set(void *value, void *data) { return keep(data, value); }

// a compile's run: the function its compiler's node holds now
static hf_out compile_run(task *t) {
	bd *b = t->owner;
	const nd_entry *e = tb_get(b->table, tb_string("value"), tb_string(t->compiler));
	const hf_entry *fn = e != NULL ? hf_find(b->functions, e->value) : NULL;
	if (fn == NULL || fn->compiler == NULL) return (hf_out){.kind = HF_FAILED, .error = pg_dup("not-a-compiler")};
	hf_context ctx = {t->key, t->compiler, t->name};
	return fn->compiler(t->code, &ctx, fn->data);
}

static sc_out step_f(void *previous, void *data) {
	(void)previous;
	task *t = data;
	bd *b = t->owner;
	t->nkeys = 0;
	task *was = b->recording;
	b->recording = t;
	hf_out out = t->compiler != NULL ? compile_run(t) : t->run(t->code, t->data);
	b->recording = was;
	switch (out.kind) {
	case HF_PENDING: return (sc_out){.kind = SC_PENDING};
	case HF_FAILED: return (sc_out){.kind = SC_FAILED, .error = out.error};
	case HF_AWAIT: return (sc_out){.kind = SC_AWAIT, .promise = out.promise};
	case HF_VALUE: break;
	}
	const char *why = unencodable(out.value);
	if (why != NULL) {
		char *m = refusal("the output: ", why);
		op_free(out.value);
		return (sc_out){.kind = SC_FAILED, .error = m};
	}
	return (sc_out){.kind = SC_VALUE, .value = out.value};
}

static void make_step(void *data) {
	task *t = data;
	t->c = sc_create_computer(t->owner->scheduler, (sc_def){.f = step_f, .set = step_set, .data = t});
}

// a step's computer, under the steps' scope. wanted in a run, made as the run ends, not in it: made
// in a run, it would carry that run's cause, and its output landing would be a loop through the run
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
	if (b->steps != NULL) cl_drop(b->steps, t);
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

static void on_track(const void *key, sc_run *run, void *data) {
	bd *b = data;
	task *t = b->recording;
	if (t != NULL && sc_run_computer(run) == t->c) PG_PUSH(t->keys, t->nkeys, t->capkeys, key);
}

// a step done goes (its entry kept); failed, once no run reads it; out, once no run reads it
static void run_end(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads, size_t nreads,
	const sc_more *more, void *data) {
	(void)n, (void)reads, (void)nreads, (void)more;
	bd *b = data;
	task *t = pm_get(&b->of, c);
	if (t != NULL && !t->retired) {
		t->has_ended = 1;
		t->ended = ended;
		if (ended == SC_DONE || (failed(ended) && !cl_tracked(b->steps, t))) retire(t);
	}
	drain(b);
}

static void effect(sc_computer *c, unsigned n, const char *error, void *data) {
	(void)c, (void)n, (void)error;
	drain(data);
}

// no run reads it now (clingy.h)
static void unread(const void *key, void *data) {
	(void)data;
	task *t = (task *)key;
	if (!t->retired) retire(t);
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
	b->info = op_str("steps");
	sc_pair info = {"builds", b->info};
	b->scope = sc_create_scope(b->scheduler, &info, 1, NULL);
	b->statuses = cst_new(&(cst_setup){setup->places, setup->table, setup->scheduler});
	b->listeners[0] = sc_on_run_end(b->scheduler, run_end, b);
	b->listeners[1] = sc_on_effect(b->scheduler, effect, b);
	b->steps = cl_new(b->scheduler, unread, b);
	b->listeners[2] = sc_on_track(b->scheduler, on_track, b);
	return b;
}

void bd_on_step(bd *b, bd_found_fn f, void *ctx) {
	b->found = f;
	b->found_ctx = ctx;
}

// steps -------------------------------------------------------------------------------------------------

static void tell(bd *b, const op_value *name, const char *key, const char *found, const char *entry,
	size_t checked, size_t entries) {
	if (b->found == NULL) return;
	bd_found f = {name, key, found, entry, checked, entries};
	b->found(&f, b->found_ctx);
}

// whether a read in a trace hashes the same now (read again, told): 1, 0, or -1 (the run must stop)
static int matches(bd *b, const op_value *r) {
	if (r == NULL || r->type != OP_LIST || r->count < 4) return 0;
	const op_value *part = r->items[0], *id = r->items[1], *path = r->items[2], *h = r->items[3];
	if (part->type != OP_STR || id->type != OP_STR || path->type != OP_LIST) return 0;
	op_key *keys = pg_alloc(path->count * sizeof *keys);
	int ok = 1;
	for (size_t i = 0; i < path->count; i++) {
		const op_value *k = path->items[i];
		if (k->type == OP_STR) keys[i] = (op_key){.type = OP_STR_KEY, .s = k->str};
		else if (k->type == OP_NUM) keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)k->num};
		else ok = 0;
	}
	const op_value *v = ok ? pl_read(b->places, tb_string(part->str), tb_string(id->str), keys, path->count) : NULL;
	free(keys);
	if (!ok) return 0;
	if (pl_status(b->places) == SC_STOP) return -1;
	if (v == NULL) return h->type == OP_NULL;
	char now[65];
	return h->type == OP_STR && bd_hash_hex(v, now) && strcmp(now, h->str) == 0;
}

// in the reader's run: the first entry whose reads all hash the same now, read again in order. 1 a
// hit (*out its value), 0 a miss, -1 the run must stop
static int lookup(bd *b, const op_value *name, const char *key, const op_value **out) {
	op_key ck = {.type = OP_STR_KEY, .s = key};
	const op_value *named = pl_read(b->places, tb_string("children"), tb_string(b->cache), &ck, 1);
	if (pl_status(b->places) == SC_STOP) return -1;
	if (named == NULL || named->type != OP_STR) {
		tell(b, name, key, "miss", NULL, 0, 0);
		return 0;
	}
	const op_value *kids = pl_read(b->places, tb_string("children"), tb_string(named->str), NULL, 0);
	ent *es;
	size_t n = entries_in(kids, &es);
	const op_value **traces = pg_alloc((n + 1) * sizeof *traces);
	op_key tk = {.type = OP_STR_KEY, .s = BD_TRACE};
	size_t m = 0;
	for (size_t i = 0; i < n; i++) {
		const op_value *reads = pl_read(b->places, tb_string("attributes"), tb_string(es[i].id), &tk, 1);
		if (reads == NULL || reads->type != OP_LIST) continue;
		es[m] = es[i];
		traces[m++] = reads;
	}
	int got = pl_status(b->places) == SC_STOP ? -1 : 0;
	size_t checked = 0;
	for (size_t i = 0; i < m && got == 0; i++) {
		checked++;
		int all = 1;
		for (size_t k = 0; k < traces[i]->count && all == 1; k++) all = matches(b, traces[i]->items[k]);
		if (all == -1) got = -1;
		else if (all == 1) {
			*out = pl_read(b->places, tb_string("value"), tb_string(es[i].id), NULL, 0);
			got = pl_status(b->places) == SC_STOP ? -1 : 1;
			if (got == 1) tell(b, name, key, "hit", es[i].name, checked, m);
		}
	}
	if (got == 0) tell(b, name, key, "miss", NULL, checked, m);
	free(traces);
	free(es);
	return got;
}

static int starts(const char *text, const char *code) {
	size_t n = strlen(code);
	return strncmp(text, code, n) == 0 && (text[n] == 0 || text[n] == ' ');
}

static bd_result ask(bd *b, const op_value *name, const op_value *code, bd_run run, void *data,
	const char *compiler) {
	char key[65];
	if (!key_of(name, code, key)) return (bd_result){.kind = BD_REFUSED, .text = "uncacheable"};
	const op_value *hit = NULL;
	int found = lookup(b, name, key, &hit);
	if (found == -1) return (bd_result){.kind = BD_STOP};
	if (found == 1) return (bd_result){.kind = BD_VALUE, .value = hit};
	task *t = NULL;
	for (size_t i = 0; i < b->ntasks; i++) {
		if (strcmp(b->tasks[i]->key, key) == 0) t = b->tasks[i];
	}
	if (t == NULL) {
		t = pg_alloc(sizeof *t);
		t->owner = b;
		strcpy(t->key, key);
		char *u = pg_uuid();
		t->node = pg_alloc(strlen(u) + 6);
		strcpy(t->node, "step:");
		strcat(t->node, u);
		free(u);
		t->name = op_ref((op_value *)name);
		t->code = op_ref((op_value *)code);
		t->run = run;
		t->data = data;
		if (compiler != NULL) {
			t->compiler = pg_dup(compiler);
			// its type: what the compiler gives (ermine.programs.gives), if it says; not in the key
			const nd_entry *a = tb_get(b->table, tb_string("attributes"), tb_string(compiler));
			const op_value *gives = a != NULL && is_map(a->value) ? op_get(a->value, BD_GIVES) : NULL;
			if (gives != NULL && gives->type == OP_STR) t->type = pg_dup(gives->str);
		}
		PG_PUSH(b->tasks, b->ntasks, b->captasks, t);
		PG_PUSH(b->made, b->nmade, b->capmade, t);
		cl_add(b->steps, t);
		// outside a run, at once
		if (sc_get_run(b->scheduler) == NULL) start(t);
		else PG_PUSH(b->wanted, b->nwanted, b->capwanted, t);
	}
	sc_track_status tracked = sc_track(b->scheduler, t);
	const op_value *st = cst_status(b->places, tb_string(t->node));
	if (tracked == SC_STOP || pl_status(b->places) == SC_STOP) return (bd_result){.kind = BD_STOP};
	const char *error = st != NULL ? cst_error(st) : NULL;
	if (error == NULL) return (bd_result){.kind = BD_PENDING};
	if (starts(error, "not-a-compiler")) return (bd_result){.kind = BD_REFUSED, .text = "not-a-compiler"};
	if (starts(error, "uncacheable")) return (bd_result){.kind = BD_REFUSED, .text = "uncacheable"};
	return (bd_result){.kind = BD_FAILED, .text = error};
}

bd_result bd_step(bd *b, const op_value *name, const op_value *code, bd_run run, void *data, int never) {
	if (!never) return ask(b, name, code, run, data, NULL);
	tell(b, name, NULL, "never", NULL, 0, 0);
	hf_out out = run(code, data);
	bd_result r = {.owned = 1};
	switch (out.kind) {
	case HF_VALUE: r.kind = BD_VALUE, r.value = out.value; break;
	case HF_PENDING: r.kind = BD_PENDING; break;
	case HF_AWAIT: r.kind = BD_PENDING, r.promise = out.promise; break;
	case HF_FAILED: r.kind = BD_FAILED, r.text = out.error; break;
	}
	if (pl_status(b->places) == SC_STOP) {
		op_free((op_value *)r.value);
		free((char *)r.text);
		return (bd_result){.kind = BD_STOP, .promise = r.promise};
	}
	return r;
}

bd_result bd_compile(bd *b, const char *compiler, const op_value *input) {
	op_key ik = {.type = OP_STR_KEY, .s = BD_COMPILER};
	const op_value *identity = pl_read(b->places, tb_string("attributes"), tb_string(compiler), &ik, 1);
	op_value *own = NULL;
	if (identity == NULL || identity->type == OP_NULL) identity = own = op_str(compiler);
	bd_result r = ask(b, identity, input, NULL, NULL, compiler);
	op_free(own);
	return r;
}

void bd_stop(bd *b) {
	if (b == NULL || b->stopped) return;
	b->stopped = 1;
	for (size_t i = 0; i < 3; i++) sc_remove_listener(b->listeners[i]);
	cl_free(b->steps);
	b->steps = NULL;
	cst_stop(b->statuses);
	b->found = NULL;
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
		free(t->type);
		free(t->keys);
		op_free(t->name);
		op_free(t->code);
		free(t);
	}
	free(b->made), free(b->tasks), free(b->wanted), free(b->cache);
	op_free(b->info);
	pm_clear(&b->of);
	free(b);
}
