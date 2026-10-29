// The C scheduler (scheduler.h) on the line protocol of reactivity/typescript/scheduler_harness.ts
// (conformance/c/harness.h has the loop). The programs are data, evaluated here as the reference
// does (see its header). Values are op_values, held; keys are interned strings.
//
// async: {"wait":[p]} makes a promise with sc_promise_new and names it p; the run returns it
// (SC_AWAIT); {"await":p} returns that one again, settled or not (kept to the end). {"wait":[p,e]} also keeps e and the run, and resolve evaluates e through the run
// first (the read is the global one: after the await it counts for nothing), then settles the promise with its value or
// error, as a then does. the rest (the result lands at the next pulse) is the scheduler's.
//
// the run, as the reference's: a computer's program takes sc_get_run at its start and keeps
// it in its context, so a write in a run (after an await too) names the run; in a set, act,
// teardown or run(), the computer's latest run (sc_latest); else none; "open": the run open
// (sc_get_run); a computation's name: its latest run (sc_latest). a scope's info is the
// request's own object, as pairs; every line is retained to the end, so what points into one stays good. a
// pulse past ENDLESS moments is left as the reference's is: every moment after throws (sc_throw),
// and what is thrown out leaves the pulse (sc_escaped): it answers {"error":"endless"}. what the
// scheduler throws out of a call (sc_escaped) is that request's error, or, in a program, thrown
// there, as the reference's throw is; but a making's (sc_create_computer, sc_create_effect) and a
// settling's (sc_resolve, sc_reject) are carried: the answer of the pulse going on, else the next,
// before its own, as the reference's scheduler holds them (it cannot throw them)
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scheduler.h"
#include "../../conformance/c/harness.h"

// the recorder: the scheduler's on... listeners as one list, in order, what happened (as
// typescript/scheduler_harness.ts's trace). due: a computer made due, by the run of the mark (by: its
// computer). a run's reads are kept while this listens; the sc_trace is the caller's
typedef enum { SC_T_DUE, SC_T_STARTS, SC_T_ENDS, SC_T_ACTS } sc_told_kind;

// one thing that happened, good for the call
typedef struct sc_told {
	sc_told_kind kind;
	sc_computer *c;
	// SC_T_DUE; by: the computer of the run that made the change, NULL when not told
	uint64_t tick;
	sc_computer *by;
	// SC_T_STARTS, SC_T_ENDS, SC_T_ACTS
	unsigned run;
	// SC_T_STARTS
	int rank;
	// SC_T_ENDS
	sc_ended ended;
	// -1: none, else 0 or 1
	int equal;
	// SC_T_ENDS, SC_T_ACTS: NULL for none
	const char *error;
	// SC_T_ACTS: an early effect's act
	bool early;
	// SC_T_ENDS stopped: the computer it waits after
	sc_computer *waits;
	// SC_T_ENDS looping: the computers on the loop, in the order made
	sc_computer *const *through;
	size_t nthrough;
	// SC_T_ENDS: every key the run tracked, in order
	const void *const *reads;
	size_t nreads;
} sc_told;

typedef struct sc_trace {
	void (*f)(const sc_told *told, void *data);
	void *data;
	sc_listener *on[4];
} sc_trace;

static inline void sc_trace_mark(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data) {
	(void)keys, (void)nkeys;
	sc_trace *t = data;
	for (size_t i = 0; i < ndue; i++)
		t->f(&(sc_told){.kind = SC_T_DUE, .c = due[i], .tick = tick, .by = run ? sc_run_computer(run) : NULL, .equal = -1},
			t->data);
}
static inline void sc_trace_start_run(sc_computer *c, unsigned n, int rank, ch_frame *frame, void *data) {
	(void)frame;
	sc_trace *t = data;
	t->f(&(sc_told){.kind = SC_T_STARTS, .c = c, .run = n, .rank = rank, .equal = -1}, t->data);
}
static inline void sc_trace_end_run(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data) {
	sc_trace *t = data;
	t->f(&(sc_told){.kind = SC_T_ENDS,
		.c = c,
		.run = n,
		.ended = ended,
		.equal = more->equal,
		.error = more->error,
		.waits = more->waits,
		.through = more->through,
		.nthrough = more->nthrough,
		.reads = reads,
		.nreads = nreads},
		t->data);
}
static inline void sc_trace_effect(sc_computer *c, unsigned n, const char *error, void *data) {
	sc_trace *t = data;
	t->f(&(sc_told){.kind = SC_T_ACTS, .c = c, .run = n, .error = error, .early = sc_scope_early(c), .equal = -1},
		t->data);
}

// f told each, in order
static inline void sc_trace_start(sc_scheduler *s, sc_trace *t, void (*f)(const sc_told *, void *),
	void *data) {
	t->f = f;
	t->data = data;
	t->on[0] = sc_on_mark(s, sc_trace_mark, t);
	t->on[1] = sc_on_run_start(s, sc_trace_start_run, t);
	t->on[2] = sc_on_run_end(s, sc_trace_end_run, t);
	t->on[3] = sc_on_effect(s, sc_trace_effect, t);
}

static inline void sc_trace_stop(sc_trace *t) {
	for (int i = 0; i < 4; i++) sc_remove_listener(t->on[i]);
}

static void *allocate(size_t size) {
	void *p = calloc(1, size ? size : 1);
	if (p == NULL) abort();
	return p;
}
static char *copyString(const char *s) { return strcpy(allocate(strlen(s) + 1), s); }
static char *formatString(const char *format, ...) __attribute__((format(printf, 1, 2)));
static char *formatString(const char *format, ...) {
	va_list args;
	va_start(args, format);
	int n = vsnprintf(NULL, 0, format, args);
	va_end(args);
	char *out = allocate((size_t)n + 1);
	va_start(args, format);
	vsnprintf(out, (size_t)n + 1, format, args);
	va_end(args);
	return out;
}
// the string a value is; NULL when it is none
static const char *text(const op_value *v) { return v && v->type == OP_STR ? v->str : NULL; }
static bool is(const op_value *v, op_type t) { return v && v->type == t; }
static op_value *integer(double n) { return op_num(n); }

static sc_scheduler *sch;

// the store, names ------------------------------------------------------------------------------

// the value kept at a key; the key's pointer is the scheduler's key
typedef struct entry {
	char *key;
	op_value *value;
} entry;
static entry **store;
static size_t nstore, capstore;

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// strings to what they name: open addressing, never more than half full. a key is kept as given:
// whoever gave it keeps it alive
typedef struct smap {
	const char **keys;
	void **vals;
	size_t cap, count;
} smap;
static size_t shash(const char *k) {
	size_t h = 1469598103934665603u;
	for (; *k; k++) h = (h ^ (unsigned char)*k) * 1099511628211u;
	return h;
}
// k's slot: where it is, or where it would go
static size_t sslot(const smap *m, const char *k) {
	size_t i = shash(k) & (m->cap - 1);
	while (m->keys[i] != NULL && strcmp(m->keys[i], k) != 0) i = (i + 1) & (m->cap - 1);
	return i;
}
static void *sget(const smap *m, const char *k) {
	if (m->cap == 0) return NULL;
	size_t i = sslot(m, k);
	return m->keys[i] ? m->vals[i] : NULL;
}
static void sput(smap *m, const char *k, void *v) {
	if (2 * (m->count + 1) > m->cap) {
		smap n = {allocate((m->cap ? 2 * m->cap : 64) * sizeof *n.keys), allocate((m->cap ? 2 * m->cap : 64) * sizeof *n.vals),
			m->cap ? 2 * m->cap : 64, m->count};
		for (size_t i = 0; i < m->cap; i++) {
			if (m->keys[i] == NULL) continue;
			size_t j = sslot(&n, m->keys[i]);
			n.keys[j] = m->keys[i];
			n.vals[j] = m->vals[i];
		}
		free(m->keys);
		free(m->vals);
		*m = n;
	}
	size_t i = sslot(m, k);
	if (m->keys[i] == NULL) m->count++;
	m->keys[i] = k;
	m->vals[i] = v;
}
static void sfree(smap *m) {
	free(m->keys);
	free(m->vals);
	*m = (smap){0};
}

// the store's entries by key
static smap entries;

static entry *entry_of(const char *key) {
	entry *e = sget(&entries, key);
	if (e) return e;
	e = allocate(sizeof *e);
	e->key = copyString(key);
	PUSH(store, nstore, capstore, e);
	sput(&entries, e->key, e);
	return e;
}

static void keep(const char *key, op_value *v) {
	entry *e = entry_of(key);
	op_value *was = e->value;
	e->value = v ? op_ref(v) : NULL;
	op_free(was);
}

static sc_scope **named;
static size_t nnamed, capnamed;

// each name's latest scope
static smap names;

// the latest named so
static sc_scope *scope_named(const char *name) { return sget(&names, name); }

// an error when the name is taken (by one not torn down and not old: else taken over): asked
// before anything is made, so a refused one makes nothing
// the names of the computers being made: taken till named (what an early one's run makes under
// the same name is refused, so a name is never held twice: the reference's)
static const char **naming;
static size_t nnaming, capnaming;

static char *taken(const char *name) {
	const char *n = name ? name : "";
	for (size_t i = 0; i < nnaming; i++)
		if (strcmp(naming[i], n) == 0) return formatString("name taken: %s", n);
	sc_scope *was = scope_named(n);
	return was && sc_scope_alive(was) && !sc_scope_old(was) ? formatString("name taken: %s", n) : NULL;
}
// names the scope
static char *name_it(sc_scope *o, const char *name) {
	char *n = copyString(name ? name : "");
	sc_scope_set(o, n);
	PUSH(named, nnamed, capnamed, o);
	sput(&names, n, o);
	return NULL;
}
// a scope freed (a plain one let go by every holder: the release op): its name forgotten, the
// string kept to the end (the names map may still point at it). computers are held by the harness
// too (their moments name them), so never freed before the end
static char **unnamed;
static size_t nunnamed, capunnamed;
static void freed(sc_scope *o, void *data) {
	(void)data;
	char *n = sc_scope_user(o);
	if (n == NULL) return;
	if (scope_named(n) == o) sput(&names, n, NULL);
	for (size_t i = 0; i < nnamed; i++)
		if (named[i] == o) {
			named[i] = named[--nnamed];
			break;
		}
	PUSH(unnamed, nunnamed, capunnamed, n);
}

static op_value **logged;
static size_t nlogged, caplogged;

// moments, as told (named when asked: a new computer is due before it has a name). returns: a
// run's body returned (sc_on_run_return; m.c and m.run only), not trace's, shown when asked.
// pulsed: a pulse ended (sc_on_after_pulse; nothing else set), shown when asked
typedef struct moment {
	sc_told m;
	bool returns, pulsed;
	char *error;
	sc_computer **through;
	const void **reads;
} moment;
static moment *moments;
static size_t nmoments, capmoments;

// a pulse past this many moments is endless
#define ENDLESS 10000
static size_t told;
static bool pulsing;

// a listener armed to throw, once: which, at what (a computation's name, or a key), its message
static char *armed_on, *armed_at, *armed_error;
static const char *const listeners[] = {"mark", "starts", "returns", "ends", "acts", "forgotten", "started", "settles", "pulsed"};

// what a listener threw in a making or a settling (sc_escaped after it): kept, the first, to be
// the answer of the pulse going on, else the next, as the reference's scheduler holds it
static char *carried;
static void carry(char *e) {
	if (e == NULL) return;
	if (carried == NULL) carried = e;
	else free(e);
}

static void disarm(void) {
	free(armed_on);
	free(armed_at);
	free(armed_error);
	armed_on = armed_at = armed_error = NULL;
}
// the armed listener on, told of at (NULL: of nothing it could name)
static void fire(const char *on, const char *at) {
	if (armed_on == NULL || strcmp(armed_on, on) != 0) return;
	if (armed_at != NULL && (at == NULL || strcmp(armed_at, at) != 0)) return;
	char *e = armed_error;
	armed_error = NULL;
	disarm();
	sc_throw(sch, e);
}

static void told_moment(const sc_told *m, void *data) {
	(void)data;
	if (pulsing && ++told > ENDLESS) sc_throw(sch, copyString("endless"));
	if (m->kind == SC_T_STARTS) fire("starts", sc_scope_user(m->c));
	else if (m->kind == SC_T_ENDS) fire("ends", sc_scope_user(m->c));
	else if (m->kind == SC_T_ACTS) fire("acts", sc_scope_user(m->c));
	moment x = {.m = *m};
	x.error = m->error ? copyString(m->error) : NULL;
	x.m.error = x.error;
	if (m->nthrough) {
		x.through = allocate(m->nthrough * sizeof *x.through);
		memcpy(x.through, m->through, m->nthrough * sizeof *x.through);
		x.m.through = x.through;
	}
	if (m->nreads) {
		x.reads = allocate(m->nreads * sizeof *x.reads);
		memcpy(x.reads, m->reads, m->nreads * sizeof *x.reads);
		x.m.reads = x.reads;
	}
	PUSH(moments, nmoments, capmoments, x);
}

// a run's body returned: a returns moment, not counted toward ENDLESS
static void run_returned(sc_computer *c, unsigned n, const void *value, void *data) {
	(void)value, (void)data;
	fire("returns", sc_scope_user(c));
	moment x = {.m = {.c = c, .run = n}, .returns = true};
	PUSH(moments, nmoments, capmoments, x);
}

// the keys untracked since last asked
static op_value **forgotten;
static size_t nforgotten, capforgotten;

static void untrack(const void *key, void *data) {
	(void)data;
	PUSH(forgotten, nforgotten, capforgotten, op_str(key));
	fire("forgotten", key);
}

// the keys that gained their first tracker since last asked
static op_value **started;
static size_t nstarted, capstarted;

static void first_track(const void *key, sc_run *run, void *data) {
	(void)run;
	(void)data;
	PUSH(started, nstarted, capstarted, op_str(key));
	fire("started", key);
}

static void settled(void *data) {
	(void)data;
	fire("settles", NULL);
}

// a pulse ended: a pulsed moment, not counted toward ENDLESS
static void pulsed(void *data) {
	(void)data;
	moment x = {.pulsed = true};
	PUSH(moments, nmoments, capmoments, x);
	fire("pulsed", NULL);
}

// the tick of the latest mark (each mark and each new computer takes the next)
static uint64_t latest_tick;
static sc_trace trace;

static void marked(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data) {
	(void)run, (void)due, (void)ndue, (void)data;
	latest_tick = tick;
	if (armed_on == NULL || strcmp(armed_on, "mark") != 0) return;
	const char *at = NULL;
	for (size_t i = 0; armed_at != NULL && at == NULL && i < nkeys; i++)
		if (strcmp(keys[i], armed_at) == 0) at = keys[i];
	if (armed_at == NULL || at != NULL) fire("mark", at);
}

static void drop(void *v, void *data) {
	(void)data;
	op_free(v);
}
static void keep_value(void *v, void *data) {
	(void)data;
	op_ref(v);
}

// equality --------------------------------------------------------------------------------------

// Object.is: scalars by value, the rest by identity
static bool object_is(const void *a, const void *b, void *data) {
	(void)data;
	if (a == b) return true;
	const op_value *x = a, *y = b;
	if (x == NULL || y == NULL || x->type != y->type) return false;
	switch (x->type) {
	case OP_NULL: return true;
	case OP_BOOL: return x->bool_ == y->bool_;
	case OP_NUM: return op_same_num(x, y);
	case OP_STR: return strcmp(x->str, y->str) == 0;
	default: return false;
	}
}

static bool same_json(const op_value *a, const op_value *b) {
	char *x = op_json_text(a), *y = op_json_text(b);
	bool same = strcmp(x, y) == 0;
	free(x);
	free(y);
	return same;
}
static bool json_equal(const void *a, const void *b, void *data) {
	(void)data;
	return same_json(a, b);
}

// programs --------------------------------------------------------------------------------------

// what an expression is evaluated in: the run (sc_get_run at its start), the computer, an act's values
typedef struct ctx {
	sc_run *run; // the run kept
	sc_scope *self;
	const op_value *value;
	const op_value *previous;
} ctx;

// V_THROW, V_STOP and V_PENDS (PENDING thrown) end the evaluation, as a throw does
typedef enum { V_OK, V_PENDING, V_PROMISE, V_THROW, V_STOP, V_PENDS } vkind;
#define ENDS(v) ((v).k == V_THROW || (v).k == V_STOP || (v).k == V_PENDS)
typedef struct val {
	vkind k;
	// V_OK: held
	op_value *j;
	// V_THROW: owned
	char *err;
	sc_promise *p;
} val;

static val ok(op_value *j) { return (val){V_OK, j, NULL, NULL}; }
static val thrown(char *e) { return (val){V_THROW, NULL, e, NULL}; }
static void release(val v) {
	op_free(v.j);
	free(v.err);
}

// a promise named by a program
typedef struct waiting {
	char *name;
	sc_promise *p;
	const op_value *then;
	ctx c;
} waiting;
static waiting **waits;
static size_t nwaits, capwaits;
// promises replaced under their name: never settled, freed at the end
static waiting **old;
static size_t nold, capold;
// promises settled: kept for await, freed at the end
static waiting **done;
static size_t ndone, capdone;

static void wait_free(waiting *w) {
	if (w->c.run) sc_run_unref(w->c.run);
	sc_promise_free(w->p);
	free(w->name);
	free(w);
}

static waiting *wait_for(const char *name) {
	for (size_t i = 0; i < nwaits; i++)
		if (strcmp(waits[i]->name, name) == 0) return waits[i];
	return NULL;
}
// the latest promise named so, settled or not
static waiting *made_as(const char *name) {
	waiting *w = wait_for(name);
	for (size_t i = ndone; w == NULL && i > 0; i--)
		if (strcmp(done[i - 1]->name, name) == 0) w = done[i - 1];
	return w;
}

// closures for cleanups: kept to the end
typedef struct closure {
	const op_value *e;
	ctx c;
} closure;
static closure **closures;
static size_t nclosures, capclosures;

// a promise named name (owned), then evaluated after it: replacing one of that name
static waiting *make_wait(char *name, const op_value *then, const ctx *c) {
	waiting *w = allocate(sizeof *w);
	w->name = name;
	w->p = sc_promise_new(sch);
	if (then) {
		w->then = then;
		w->c = *c;
		if (w->c.run) sc_run_ref(w->c.run);
	}
	waiting *was = wait_for(name);
	if (was) {
		PUSH(old, nold, capold, was);
		for (size_t i = 0; i < nwaits; i++)
			if (waits[i] == was) waits[i] = w;
	} else {
		PUSH(waits, nwaits, capwaits, w);
	}
	return w;
}

static val evaluate(const op_value *e, const ctx *c);
// the effect form
static val made_in(const char *form, const op_value *a0, const op_value *a1, const op_value *a2,
	const op_value *arg);

// the pair lists made from requests: kept to the end
static sc_pair **infos;
static size_t ninfos, capinfos;

// a request's info object as pairs, its own keys and values (unique: a map's); NULL, *n 0: none
static const sc_pair *info_of(const op_value *map, size_t *n) {
	*n = 0;
	if (!is(map, OP_MAP) || map->count == 0) return NULL;
	sc_pair *out = allocate(map->count * sizeof *out);
	PUSH(infos, ninfos, capinfos, out);
	for (size_t i = 0; i < map->count; i++) out[(*n)++] = (sc_pair){map->keys[i], map->items[i]};
	return out;
}

// an info as an object: its values the request's, or numbers the scheduler made
static op_value *object_of(const ch_frame *frame) {
	op_value *out = op_map();
	for (size_t j = 0; j < frame->n; j++) {
		const sc_pair *q = &frame->pairs[j];
		op_set(out, q->key, op_ref((op_value *)q->value));
	}
	return out;
}

// what is open: {scope, info, writer?}, by the computer of the run; nothing: null
static op_value *current(void) {
	sc_scope *open = sc_get_current_scope(sch);
	if (open == NULL) return op_null();
	op_value *out = op_map();
	const char *name = sc_scope_user(open);
	op_set(out, "scope", name ? op_str(name) : op_null());
	op_set(out, "info", object_of(sc_get_current_frame(sch)));
	sc_run *writer = sc_get_run(sch);
	const char *by = writer ? sc_scope_user(sc_run_computer(writer)) : NULL;
	if (by) op_set(out, "writer", op_str(by));
	return out;
}

// why nothing could be made under parent (NULL: the scope open): none open, it is gone, or no pairs
static char *unmade(const sc_scope *parent) {
	if (parent == NULL) parent = sc_get_current_scope(sch);
	if (parent == NULL) return copyString(SC_UNSCOPED);
	return copyString(sc_scope_alive(parent) ? SC_EMPTY : SC_DISPOSED);
}

// who a change in this code is by: the run, else the computer's latest
static sc_run *writer_of(const ctx *c) {
	if (c->run) return c->run;
	return c->self ? sc_latest(c->self) : NULL;
}

static double num(const op_value *j) {
	if (j == NULL || j->type == OP_NULL) return 0;
	return j->type == OP_NUM ? j->num : NAN;
}

#define EVAL(var, expr) \
	val var = evaluate((expr), c); \
	if (ENDS(var)) return var

// e evaluated to a string, copied; NULL when it is not one
static val string_of(const op_value *e, const ctx *c, char **out) {
	*out = NULL;
	EVAL(v, e);
	if (v.j && is(v.j, OP_STR)) *out = copyString(text(v.j));
	release(v);
	return ok(NULL);
}

struct inrun {
	const op_value *e;
	const ctx *c;
	val v;
};
// a teardown registered on a scope, with it open
struct incleanup {
	sc_scope *o;
	char *(*f)(void *);
	void *data;
	char *bad;
};
static void in_cleanup(void *data) {
	struct incleanup *k = data;
	k->bad = sc_register_teardown(sch, k->o, k->f, k->data);
}
static void in_run(void *data) {
	struct inrun *r = data;
	ctx inner = *r->c;
	inner.run = NULL;
	r->v = evaluate(r->e, &inner);
}

// a value's error, if it threw ("pending" for PENDING); the rest let go
static char *error_of(val v) {
	char *e = v.k == V_THROW ? v.err : v.k == V_PENDS ? copyString("pending") : NULL;
	if (v.k == V_THROW) v.err = NULL;
	release(v);
	return e;
}

static char *cleanup_run(void *data) {
	closure *k = data;
	ctx inner = k->c;
	inner.run = NULL;
	return error_of(evaluate(k->e, &inner));
}

static closure *closure_of(const op_value *e, const ctx *c) {
	closure *k = allocate(sizeof *k);
	k->e = e;
	k->c = *c;
	k->c.run = NULL;
	// held: a value given to the run or act may be let go before the cleanup runs
	if (k->c.value) op_ref((op_value *)k->c.value);
	if (k->c.previous) op_ref((op_value *)k->c.previous);
	PUSH(closures, nclosures, capclosures, k);
	return k;
}

static val evaluate(const op_value *e, const ctx *c) {
	if (e == NULL || e->type == OP_NULL || e->type == OP_BOOL || e->type == OP_NUM ||
		e->type == OP_STR)
		return ok(e ? op_ref((op_value *)e) : op_null());
	if (e->type == OP_LIST) {
		op_value *out = op_list();
		for (size_t i = 0; i < e->count; i++) {
			val v = evaluate(e->items[i], c);
			if (ENDS(v)) return op_free(out), v;
			op_push(out, v.j ? v.j : op_null());
		}
		return ok(out);
	}
	if (e->type != OP_MAP || e->count == 0) return thrown(copyString("unknown form undefined"));
	const char *form = e->keys[0];
	const op_value *arg = e->items[0];
	const op_value *a0 = NULL, *a1 = NULL, *a2 = NULL;
	if (is(arg, OP_LIST)) {
		if (arg->count > 0) a0 = arg->items[0];
		if (arg->count > 1) a1 = arg->items[1];
		if (arg->count > 2) a2 = arg->items[2];
	}
	if (strcmp(form, "read") == 0) {
		char *k;
		val r = string_of(arg, c, &k);
		if (r.k != V_OK) return r;
		if (k == NULL) return thrown(copyString("read of a non-string"));
		entry *en = entry_of(k);
		free(k);
		sc_track_status st = sc_track(sch, en->key);
		char *out = sc_escaped(sch);
		if (out) return thrown(out);
		if (st == SC_STOP) return (val){V_STOP, NULL, NULL, NULL};
		return ok(en->value ? op_ref(en->value) : op_null());
	}
	if (strcmp(form, "sum") == 0 || strcmp(form, "mod") == 0) {
		bool sum = form[0] == 's';
		double n = 0, first = 0;
		for (size_t i = 0; i < (is(arg, OP_LIST) ? arg->count : 0); i++) {
			EVAL(v, arg->items[i]);
			double x = num(v.j);
			release(v);
			// numbers only: null is 0, anything else an error; mod by 0 an error
			if (isnan(x)) return thrown(copyString("not a number"));
			if (sum) n += x;
			else if (i == 0) first = x;
			else if (x == 0) return thrown(copyString("mod by 0"));
			else n = fmod(first, x);
		}
		return ok(op_num(n));
	}
	if (strcmp(form, "eq") == 0) {
		EVAL(x, a0);
		EVAL(y, a1);
		bool same = x.j && y.j ? same_json(x.j, y.j) : x.j == y.j;
		release(x);
		release(y);
		return ok(op_bool(same));
	}
	if (strcmp(form, "if") == 0) {
		EVAL(t, a0);
		bool yes = t.j && t.j->type == OP_BOOL && t.j->bool_;
		release(t);
		return evaluate(yes ? a1 : a2, c);
	}
	if (strcmp(form, "given") == 0) {
		const char *which = text(arg);
		const op_value *j = which && strcmp(which, "value") == 0 ? c->value
			: which && strcmp(which, "previous") == 0 ? c->previous : NULL;
		return ok(j ? op_ref((op_value *)j) : op_null());
	}
	if (strcmp(form, "log") == 0) {
		EVAL(v, arg);
		PUSH(logged, nlogged, caplogged, v.j ? op_ref(v.j) : op_null());
		return v;
	}
	if (strcmp(form, "do") == 0) {
		val last = ok(op_null());
		for (size_t i = 0; i < (is(arg, OP_LIST) ? arg->count : 0); i++) {
			release(last);
			last = evaluate(arg->items[i], c);
			if (ENDS(last)) return last;
		}
		return last;
	}
	if (strcmp(form, "write") == 0) {
		char *k;
		val r = string_of(a0, c, &k);
		if (r.k != V_OK) return r;
		EVAL(v, a1);
		if (k == NULL) {
			release(v);
			return thrown(copyString("write to a non-string"));
		}
		// the writer first: one not there writes nothing
		const char *said = text(a2);
		sc_run *writer = NULL;
		if (a2 == NULL) writer = writer_of(c);
		else if (said && strcmp(said, "open") == 0) writer = sc_get_run(sch);
		else if (said) {
			// a computation by name: its latest run (none yet: from outside)
			sc_scope *o = scope_named(said);
			if (o == NULL) {
				release(v);
				free(k);
				return thrown(formatString("no scope %s", said));
			}
			writer = sc_latest(o);
		}
		keep(k, v.j);
		const void *key = entry_of(k)->key;
		free(k);
		sc_mark(sch, &key, 1, writer);
		char *out = sc_escaped(sch);
		if (out) {
			release(v);
			return thrown(out);
		}
		return v;
	}
	if (strcmp(form, "throw") == 0) {
		EVAL(v, arg);
		if (v.k == V_PENDING) return (val){V_PENDS, NULL, NULL, NULL};
		char *why = copyString(v.j && text(v.j) ? text(v.j) : "null");
		release(v);
		return thrown(why);
	}
	if (strcmp(form, "pending") == 0) return (val){V_PENDING, NULL, NULL, NULL};
	if (strcmp(form, "wait") == 0) {
		char *name;
		val r = string_of(a0, c, &name);
		if (r.k != V_OK) return r;
		if (name == NULL) return thrown(copyString("wait on a non-string"));
		return (val){V_PROMISE, NULL, NULL, make_wait(name, a1, c)->p};
	}
	if (strcmp(form, "await") == 0) {
		char *name;
		val r = string_of(arg, c, &name);
		if (r.k != V_OK) return r;
		waiting *w = name ? made_as(name) : NULL;
		val out = w ? (val){V_PROMISE, NULL, NULL, w->p} : thrown(formatString("no promise %s", name ? name : "null"));
		free(name);
		return out;
	}
	if (strcmp(form, "run") == 0) {
		if (c->self == NULL) return thrown(copyString("run outside a computation"));
		struct inrun r = {arg, c, ok(NULL)};
		const char *bad = sc_run_with_scope(c->self, in_run, &r);
		if (bad) return thrown(copyString(bad));
		return r.v;
	}
	if (strcmp(form, "in") == 0) {
		const char *name = text(a0);
		sc_scope *o = name ? scope_named(name) : NULL;
		if (o == NULL) return thrown(formatString("no scope %s", name ? name : "null"));
		struct inrun r = {a1, c, ok(NULL)};
		const char *bad = sc_run_with_scope(o, in_run, &r);
		if (bad) return thrown(copyString(bad));
		return r.v;
	}
	if (strcmp(form, "scope") == 0) {
		const char *name = text(a0);
		const char *up = text(a2);
		sc_scope *parent = up ? scope_named(up) : NULL;
		if (up && parent == NULL) return thrown(formatString("no scope %s", up));
		char *was = taken(name);
		if (was) return thrown(was);
		size_t n;
		const sc_pair *info = info_of(a1, &n);
		sc_scope *o = sc_create_scope(sch, info, n, parent);
		if (o == NULL) return thrown(unmade(parent));
		char *bad = name_it(o, name ? name : "");
		if (bad) return thrown(bad);
		return ok(op_null());
	}
	if (strcmp(form, "within") == 0) {
		size_t n;
		const sc_pair *info = info_of(a0, &n);
		sc_scope *o = sc_create_scope(sch, info, n, NULL);
		if (o == NULL) return thrown(unmade(NULL));
		struct inrun r = {a1, c, ok(NULL)};
		const char *bad = sc_run_with_scope(o, in_run, &r);
		if (bad) return thrown(copyString(bad));
		return r.v;
	}
	if (strcmp(form, "current") == 0) return ok(current());
	if (strcmp(form, "cleanup") == 0) {
		// on the scope open when it is the one named (or none is), else with that one open
		const char *name = text(a0);
		sc_scope *o = name ? scope_named(name) : NULL;
		if (o == NULL && !is(a0, OP_NULL)) return thrown(formatString("no scope %s", name ? name : "null"));
		if (o == NULL) o = sc_get_current_scope(sch);
		if (o == NULL) return thrown(copyString(SC_UNSCOPED));
		struct incleanup k = {o, cleanup_run, closure_of(a1, c), NULL};
		if (sc_get_current_scope(sch) == o) in_cleanup(&k);
		else {
			const char *why = sc_run_with_scope(o, in_cleanup, &k);
			if (why) return thrown(copyString(why));
		}
		if (k.bad) return thrown(k.bad);
		return ok(op_null());
	}
	if (strcmp(form, "dispose") == 0) {
		const char *name = text(arg);
		sc_scope *o = name ? scope_named(name) : NULL;
		if (o == NULL) return thrown(formatString("no scope %s", name ? name : "null"));
		char *bad = sc_teardown(o);
		if (bad) return thrown(bad);
		return ok(op_null());
	}
	if (strcmp(form, "effect") == 0 || strcmp(form, "compute") == 0) return made_in(form, a0, a1, a2, arg);
	if (strcmp(form, "quote") == 0) return ok(op_ref((op_value *)arg));
	return thrown(formatString("unknown form %s", form));
}

// a computer's program

typedef struct prog {
	const op_value *f;
	const op_value *act;
	// a compute's set: e evaluated after its result is kept, given it as value
	const op_value *set;
	const char *to;
	sc_computer *self;
	// made as an effect, or claimed as one
	bool effect;
} prog;
static prog **progs;
static size_t nprogs, capprogs;

// itself: an early effect runs and acts before it is given back, the scope open then
static sc_scope *self_of(prog *p) { return p->self ? p->self : sc_get_current_scope(sch); }

static sc_out out_of(val v) {
	switch (v.k) {
	case V_OK: return (sc_out){.kind = SC_VALUE, .value = v.j};
	case V_PROMISE: return (sc_out){.kind = SC_AWAIT, .promise = v.p};
	case V_THROW: return (sc_out){.kind = SC_FAILED, .error = v.err};
	default: return (sc_out){.kind = SC_PENDING};
	}
}

// {"steps":[e..]}: a generator compute's body. each in order; {"yield":p} pauses the run on a
// promise named p (made as wait makes it), and what it settles with is taken; the last one's value
// is the result
typedef struct stepper {
	const op_value *list;
	size_t i;
	prog *p;
	ctx c;
	// held
	op_value *last;
} stepper;

static void stepper_free(stepper *t) {
	op_free(t->last);
	free(t);
}
static void stepper_quit(void *data) { stepper_free(data); }
static sc_out stepper_next(void *data, bool settled, void *value, char *error);

static sc_out stepper_go(stepper *t) {
	t->c.run = sc_get_run(sch);
	t->c.self = self_of(t->p);
	while (t->i < t->list->count) {
		const op_value *x = t->list->items[t->i++];
		if (is(x, OP_MAP) && x->count > 0 && strcmp(x->keys[0], "yield") == 0) {
			char *name;
			val r = string_of(x->items[0], &t->c, &name);
			if (r.k != V_OK) {
				stepper_free(t);
				return out_of(r);
			}
			if (name == NULL) {
				stepper_free(t);
				return (sc_out){.kind = SC_FAILED, .error = copyString("yield of a non-string")};
			}
			sc_promise *p = make_wait(name, NULL, &t->c)->p;
			return (sc_out){.kind = SC_PAUSE, .promise = p, .step = {stepper_next, stepper_quit, t}};
		}
		val v = evaluate(x, &t->c);
		if (v.k != V_OK) {
			stepper_free(t);
			return out_of(v);
		}
		op_free(t->last);
		t->last = v.j ? v.j : op_null();
	}
	op_value *last = t->last;
	t->last = NULL;
	stepper_free(t);
	return (sc_out){.kind = SC_VALUE, .value = last ? last : op_null()};
}

static sc_out stepper_next(void *data, bool settled, void *value, char *error) {
	stepper *t = data;
	if (!settled) {
		stepper_free(t);
		return (sc_out){.kind = SC_FAILED, .error = error};
	}
	op_free(t->last);
	t->last = value;
	return stepper_go(t);
}

static sc_out program_f(void *previous, void *data) {
	prog *p = data;
	ctx c = {sc_get_run(sch), self_of(p), NULL, previous};
	if (is(p->f, OP_MAP) && p->f->count > 0 && strcmp(p->f->keys[0], "steps") == 0 &&
		is(p->f->items[0], OP_LIST)) {
		stepper *t = allocate(sizeof *t);
		t->list = p->f->items[0];
		t->p = p;
		t->c = c;
		t->last = NULL;
		return stepper_go(t);
	}
	return out_of(evaluate(p->f, &c));
}

static char *program_set(void *value, void *data) {
	prog *p = data;
	if (p->to != NULL) {
		keep(p->to, value);
		sc_mark(sch, (const void *[]){p->to}, 1, sc_latest(p->self));
		char *out = sc_escaped(sch);
		if (out) return out;
	}
	if (p->set == NULL) return NULL;
	ctx c = {NULL, p->self, value, NULL};
	return error_of(evaluate(p->set, &c));
}

static char *program_effect(void *value, void *previous, void *data) {
	prog *p = data;
	ctx c = {NULL, self_of(p), value, previous};
	return error_of(evaluate(p->act, &c));
}

// requests --------------------------------------------------------------------------------------

// the lines asked, kept to the end: the programs and pairs point into them
static hh_line **lines;
static size_t nlines, caplines;

static op_value *answer_error(char *e) {
	op_value *o = op_map();
	op_set(o, "error", op_str(e));
	free(e);
	return o;
}
static op_value *answer_tick(uint64_t t) {
	op_value *o = op_map();
	op_set(o, "tick", integer((int64_t)t));
	return o;
}

static const char *ended_name(sc_ended e) {
	switch (e) {
	case SC_DONE: return "done";
	case SC_PENDED: return "pending";
	case SC_FAIL: return "failed";
	case SC_STOPPED_RUN: return "stopped";
	default: return "looping";
	}
}
static op_value *name_json(const sc_computer *c) { return op_str((const char *)sc_scope_user(c)); }

// reads: an ends moment with its reads, the keys (the store's strings)
static op_value *moment_json(const moment *x, bool reads) {
	const sc_told *m = &x->m;
	op_value *o = op_map();
	if (x->pulsed) {
		op_set(o, "pulsed", op_bool(true));
		return o;
	}
	if (x->returns) {
		op_set(o, "returns", name_json(m->c));
		op_set(o, "run", integer(m->run));
		return o;
	}
	switch (m->kind) {
	case SC_T_DUE:
		op_set(o, "due", name_json(m->c));
		op_set(o, "tick", integer((int64_t)m->tick));
		if (m->by) op_set(o, "writer", name_json(m->by));
		break;
	case SC_T_STARTS:
		op_set(o, "starts", name_json(m->c));
		op_set(o, "run", integer(m->run));
		op_set(o, "rank", integer(m->rank));
		break;
	case SC_T_ACTS:
		op_set(o, "acts", name_json(m->c));
		op_set(o, "run", integer(m->run));
		if (m->early) op_set(o, "early", op_bool(true));
		if (m->error) op_set(o, "error", op_str(m->error));
		break;
	case SC_T_ENDS:
		op_set(o, "ends", name_json(m->c));
		op_set(o, "run", integer(m->run));
		op_set(o, "ended", op_str(ended_name(m->ended)));
		if (m->equal >= 0) op_set(o, "equal", op_bool(m->equal));
		if (m->error) op_set(o, "error", op_str(m->error));
		if (m->waits) op_set(o, "waits", name_json(m->waits));
		if (m->nthrough) {
			op_value *t = op_list();
			for (size_t i = 0; i < m->nthrough; i++) op_push(t, name_json(m->through[i]));
			op_set(o, "through", t);
		}
		if (reads) {
			op_value *k = op_list();
			for (size_t i = 0; i < m->nreads; i++) op_push(k, op_str(m->reads[i]));
			op_set(o, "reads", k);
		}
		break;
	}
	return o;
}

static sc_scope *need_scope(const op_value *name, char **bad) {
	const char *n = text(name);
	sc_scope *o = n ? scope_named(n) : NULL;
	if (o == NULL) *bad = formatString("no scope %s", n ? n : "null");
	return o;
}

// a computer made with a scope open
struct making {
	sc_def def;
	bool effect;
	sc_computer *c;
	const sc_pair *info;
	size_t n;
};
static void in_making(void *data) {
	struct making *m = data;
	m->c = m->effect ? sc_create_effect(sch, m->def, m->info, m->n)
	                 : sc_create_computer(sch, m->def, m->info, m->n);
}

static op_value *make_computer(const op_value *r, bool effect) {
	char *bad = NULL;
	sc_scope *o = need_scope(op_get(r, "scope"), &bad);
	if (!o) return answer_error(bad);
	if ((bad = taken(text(op_get(r, "name"))))) return answer_error(bad);
	prog *p = allocate(sizeof *p);
	PUSH(progs, nprogs, capprogs, p);
	p->f = op_get(r, "f");
	p->act = op_get(r, "act");
	p->set = op_get(r, "set");
	p->effect = effect;
	const char *to = text(op_get(r, "to"));
	p->to = to ? entry_of(to)->key : NULL;
	const char *eq = text(op_get(r, "equal"));
	const op_value *declared = op_get(r, "declared");
	const op_value *early = op_get(r, "early");
	sc_def def = {.f = program_f,
		.equal = eq && strcmp(eq, "json") == 0 ? json_equal : object_is,
		.key = !effect && p->to && is(declared, OP_BOOL) && declared->bool_ ? p->to : NULL,
		.data = p,
		.early = effect && is(early, OP_BOOL) && early->bool_};
	if (effect) def.effect = program_effect;
	else def.set = program_set;
	struct making m = {def, effect, NULL, NULL, 0};
	m.info = info_of(op_get(r, "info"), &m.n);
	const char *name = text(op_get(r, "name"));
	PUSH(naming, nnaming, capnaming, name ? name : "");
	const char *why = sc_run_with_scope(o, in_making, &m);
	nnaming--;
	if (why) return answer_error(copyString(why));
	sc_computer *c = m.c;
	if (c == NULL) return answer_error(copyString(SC_DISPOSED));
	sc_retain(c);
	p->self = c;
	bad = name_it(c, name);
	if (bad) return answer_error(bad);
	carry(sc_escaped(sch));
	return op_map();
}

// the computation named, old under the scope open: its program, else NULL
static prog *old_here(const char *name) {
	sc_scope *o = scope_named(name);
	if (o == NULL || !sc_scope_old(o) || sc_scope_parent(o) != sc_get_current_scope(sch)) return NULL;
	for (size_t i = 0; i < nprogs; i++)
		if (progs[i]->self == o) return progs[i];
	return NULL;
}

// {"effect":[c,f,act,early?]}: an effect under the scope open; {"compute":[c,f,to?]}: a compute,
// its results kept at to. c old under the scope open: claimed, given the new code. c taken by one
// torn down or old elsewhere: taken over
static val made_in(const char *form, const op_value *a0, const op_value *a1, const op_value *a2,
	const op_value *arg) {
	const char *name = text(a0);
	if (name == NULL) return thrown(formatString("a %s with no name", form));
	bool effect = strcmp(form, "effect") == 0;
	prog *old = old_here(name);
	if (old != NULL) {
		old->f = a1;
		old->act = effect ? a2 : NULL;
		if (old->effect == effect) {
			sc_claim(old->self);
		} else {
			// made again as the other kind: it takes that kind too
			sc_def def = {.f = program_f, .equal = object_is, .data = old};
			if (effect) {
				def.effect = program_effect;
				const op_value *early = is(arg, OP_LIST) && arg->count > 3 ? arg->items[3] : NULL;
				def.early = is(early, OP_BOOL) && early->bool_;
			} else {
				const char *to = text(a2);
				old->to = to ? entry_of(to)->key : NULL;
				old->set = NULL;
				def.set = program_set;
			}
			old->effect = effect;
			sc_claim_as(old->self, effect, def);
		}
		char *out = sc_escaped(sch);
		return out ? thrown(out) : ok(op_null());
	}
	char *was = taken(name);
	if (was) return thrown(was);
	prog *p = allocate(sizeof *p);
	PUSH(progs, nprogs, capprogs, p);
	p->f = a1;
	p->effect = effect;
	sc_def def = {.f = program_f, .equal = object_is, .data = p};
	if (effect) {
		p->act = a2;
		def.effect = program_effect;
		const op_value *early = is(arg, OP_LIST) && arg->count > 3 ? arg->items[3] : NULL;
		def.early = is(early, OP_BOOL) && early->bool_;
	} else {
		const char *to = text(a2);
		p->to = to ? entry_of(to)->key : NULL;
		def.set = program_set;
	}
	// an early one runs and acts before it is given back: itself, the scope open then (self_of)
	PUSH(naming, nnaming, capnaming, name);
	sc_computer *c = effect ? sc_create_effect(sch, def, NULL, 0) : sc_create_computer(sch, def, NULL, 0);
	nnaming--;
	if (c == NULL) return thrown(unmade(NULL));
	sc_retain(c);
	p->self = c;
	char *bad = name_it(c, name);
	if (bad) return thrown(bad);
	carry(sc_escaped(sch));
	return ok(op_null());
}

static op_value *settle(const op_value *r, bool resolve) {
	const char *name = text(op_get(r, "promise"));
	waiting *w = name ? wait_for(name) : NULL;
	if (w == NULL) return answer_error(formatString("no promise %s", name ? name : "null"));
	for (size_t i = 0; i < nwaits; i++)
		if (waits[i] == w) waits[i] = waits[--nwaits];
	if (!resolve) {
		const char *why = text(op_get(r, "error"));
		sc_reject(w->p, copyString(why ? why : "null"));
	} else if (w->then) {
		val v = evaluate(w->then, &w->c);
		if (v.k == V_THROW) sc_reject(w->p, v.err);
		else if (v.k == V_PENDING || v.k == V_PENDS) sc_resolve_pending(w->p);
		else sc_resolve(w->p, v.j ? v.j : op_null());
	} else {
		const op_value *value = op_get(r, "value");
		sc_resolve(w->p, value ? op_ref((op_value *)value) : op_null());
	}
	carry(sc_escaped(sch));
	if (w->c.run) sc_run_unref(w->c.run);
	w->c.run = NULL;
	PUSH(done, ndone, capdone, w);
	return op_map();
}

static op_value *answer(const op_value *r) {
	const char *op = text(op_get(r, "op"));
	if (op == NULL) return answer_error(copyString("no op"));
	char *bad = NULL;
	if (strcmp(op, "root") == 0 || strcmp(op, "scope") == 0) {
		const op_value *parent = op_get(r, "parent");
		sc_scope *p = NULL;
		if (parent && parent->type != OP_NULL && !(p = need_scope(parent, &bad))) return answer_error(bad);
		if ((bad = taken(text(op_get(r, "name"))))) return answer_error(bad);
		size_t n;
		const sc_pair *info = info_of(op_get(r, "info"), &n);
		sc_scope *o = op[0] == 'r' ? sc_create_root_scope(sch, info, n) : sc_create_scope(sch, info, n, p);
		if (o == NULL) return answer_error(op[0] == 'r' ? copyString(SC_EMPTY) : unmade(p));
		bad = name_it(o, text(op_get(r, "name")));
		return bad ? answer_error(bad) : op_map();
	}
	if (strcmp(op, "current") == 0) {
		op_value *out = op_map();
		op_set(out, "value", current());
		return out;
	}
	if (strcmp(op, "compute") == 0) return make_computer(r, false);
	if (strcmp(op, "effect") == 0) return make_computer(r, true);
	if (strcmp(op, "cleanup") == 0 || strcmp(op, "run") == 0) {
		sc_scope *o = need_scope(op_get(r, "scope"), &bad);
		if (!o) return answer_error(bad);
		ctx c = {NULL, o, NULL, NULL};
		if (op[0] == 'c') {
			struct incleanup k = {o, cleanup_run, closure_of(op_get(r, "do"), &c), NULL};
			const char *why = sc_run_with_scope(o, in_cleanup, &k);
			if (why) return answer_error(copyString(why));
			return k.bad ? answer_error(k.bad) : op_map();
		}
		struct inrun in = {op_get(r, "do"), &c, ok(NULL)};
		const char *why = sc_run_with_scope(o, in_run, &in);
		if (why) return answer_error(copyString(why));
		if (in.v.k == V_THROW) return answer_error(in.v.err);
		if (in.v.k == V_PENDS) return answer_error(copyString("pending"));
		// PENDING or a promise: no value
		if (in.v.k == V_PENDING || in.v.k == V_PROMISE) {
			release(in.v);
			return op_map();
		}
		op_value *out = op_map();
		op_set(out, "value", in.v.j ? in.v.j : op_null());
		return out;
	}
	if (strcmp(op, "retain") == 0 || strcmp(op, "release") == 0) {
		sc_scope *o = need_scope(op_get(r, "scope"), &bad);
		if (!o) return answer_error(bad);
		if (op[2] == 't') sc_retain(o);
		else sc_release(o);
		return op_map();
	}
	if (strcmp(op, "dispose") == 0) {
		sc_scope *o = need_scope(op_get(r, "scope"), &bad);
		if (!o) return answer_error(bad);
		bad = sc_teardown(o);
		return bad ? answer_error(bad) : op_map();
	}
	if (strcmp(op, "write") == 0 || strcmp(op, "changed") == 0) {
		bool write = op[0] == 'w';
		const op_value *list = op_get(r, write ? "values" : "keys");
		size_t n = write ? (is(list, OP_MAP) ? list->count : 0)
			: (is(list, OP_LIST) ? list->count : 0);
		const void **keys = allocate((n + 1) * sizeof *keys);
		for (size_t i = 0; i < n; i++) {
			const char *k = write ? list->keys[i] : text(list->items[i]);
			if (k == NULL) {
				free(keys);
				return answer_error(copyString("bad key"));
			}
			if (write) keep(k, list->items[i]);
			keys[i] = entry_of(k)->key;
		}
		uint64_t t = sc_mark(sch, keys, n, NULL);
		free(keys);
		char *out = sc_escaped(sch);
		return out ? answer_error(out) : answer_tick(t);
	}
	if (strcmp(op, "pulse") == 0) {
		told = 0;
		pulsing = true;
		sc_pulse(sch);
		pulsing = false;
		char *out = sc_escaped(sch);
		// what was carried for it first, then its own
		if (carried) {
			free(out);
			out = carried;
			carried = NULL;
		}
		return out ? answer_error(out) : op_map();
	}
	if (strcmp(op, "listener") == 0) {
		const char *on = text(op_get(r, "on"));
		bool known = false;
		for (size_t i = 0; on && i < sizeof listeners / sizeof *listeners; i++) known = known || strcmp(on, listeners[i]) == 0;
		if (!known) return answer_error(formatString("unknown listener %s", on ? on : "undefined"));
		disarm();
		armed_on = copyString(on);
		const char *at = text(op_get(r, "at"));
		armed_at = at ? copyString(at) : NULL;
		const char *why = text(op_get(r, "throw"));
		armed_error = copyString(why ? why : "null");
		return op_map();
	}
	if (strcmp(op, "resolve") == 0) return settle(r, true);
	if (strcmp(op, "reject") == 0) return settle(r, false);
	if (strcmp(op, "get") == 0) {
		const char *k = text(op_get(r, "key"));
		entry *e = k ? entry_of(k) : NULL;
		op_value *out = op_map();
		op_set(out, "value", e && e->value ? op_ref(e->value) : op_null());
		return out;
	}
	if (strcmp(op, "log") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < nlogged; i++) op_push(list, logged[i]);
		nlogged = 0;
		op_value *out = op_map();
		op_set(out, "log", list);
		return out;
	}
	if (strcmp(op, "moments") == 0) {
		const op_value *reads = op_get(r, "reads"), *returns = op_get(r, "returns"), *pulses = op_get(r, "pulses");
		bool showReturns = is(returns, OP_BOOL) && returns->bool_;
		bool showPulses = is(pulses, OP_BOOL) && pulses->bool_;
		op_value *list = op_list();
		for (size_t i = 0; i < nmoments; i++) {
			if ((showReturns || !moments[i].returns) && (showPulses || !moments[i].pulsed))
				op_push(list, moment_json(&moments[i], is(reads, OP_BOOL) && reads->bool_));
			free(moments[i].error);
			free(moments[i].through);
			free(moments[i].reads);
		}
		nmoments = 0;
		op_value *out = op_map();
		op_set(out, "moments", list);
		return out;
	}
	if (strcmp(op, "forgotten") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < nforgotten; i++) op_push(list, forgotten[i]);
		nforgotten = 0;
		op_value *out = op_map();
		op_set(out, "keys", list);
		return out;
	}
	if (strcmp(op, "started") == 0) {
		op_value *list = op_list();
		for (size_t i = 0; i < nstarted; i++) op_push(list, started[i]);
		nstarted = 0;
		op_value *out = op_map();
		op_set(out, "keys", list);
		return out;
	}
	if (strcmp(op, "tick") == 0) return answer_tick(latest_tick);
	return answer_error(formatString("unknown op %s", op));
}

void hh_answer(const op_value *r, FILE *out) {
	if (sch == NULL) {
		sch = sc_new((sc_options){.drop = drop, .keep = keep_value});
		sc_trace_start(sch, &trace, told_moment, NULL);
		sc_on_tracking_end(sch, untrack, NULL);
		sc_on_run_return(sch, run_returned, NULL);
		sc_on_tracking_start(sch, first_track, NULL);
		sc_on_settle(sch, settled, NULL);
		sc_on_after_pulse(sch, pulsed, NULL);
		sc_on_mark(sch, marked, NULL);
		sc_on_free(sch, freed, NULL);
	}
	PUSH(lines, nlines, caplines, hh_retain());
	op_value *a = answer(r);
	op_json_write(out, a);
	op_free(a);
}

void hh_finish(void) {
	disarm();
	free(carried);
	free(naming);
	sfree(&names);
	sfree(&entries);
	if (sch == NULL) return;
	for (size_t i = 0; i < nwaits; i++) wait_free(waits[i]);
	for (size_t i = 0; i < nold; i++) wait_free(old[i]);
	for (size_t i = 0; i < ndone; i++) wait_free(done[i]);
	for (size_t i = 0; i < nnamed; i++) free(sc_scope_user(named[i]));
	for (size_t i = 0; i < nunnamed; i++) free(unnamed[i]);
	free(unnamed);
	sc_free(sch);
	for (size_t i = 0; i < nmoments; i++) {
		free(moments[i].error);
		free(moments[i].through);
		free(moments[i].reads);
	}
	for (size_t i = 0; i < nlogged; i++) op_free(logged[i]);
	for (size_t i = 0; i < nforgotten; i++) op_free(forgotten[i]);
	free(forgotten);
	for (size_t i = 0; i < nstarted; i++) op_free(started[i]);
	free(started);
	for (size_t i = 0; i < nstore; i++) {
		op_free(store[i]->value);
		free(store[i]->key);
		free(store[i]);
	}
	for (size_t i = 0; i < nprogs; i++) free(progs[i]);
	for (size_t i = 0; i < nclosures; i++) {
		if (closures[i]->c.value) op_free((op_value *)closures[i]->c.value);
		if (closures[i]->c.previous) op_free((op_value *)closures[i]->c.previous);
		free(closures[i]);
	}
	for (size_t i = 0; i < ninfos; i++) free(infos[i]);
	free(infos);
	for (size_t i = 0; i < nlines; i++) hh_release(lines[i]);
	free(store);
	free(named);
	free(logged);
	free(moments);
	free(waits);
	free(old);
	free(done);
	free(progs);
	free(closures);
	free(lines);
}
