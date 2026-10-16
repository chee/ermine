// The C scheduler (scheduler.h) on the line protocol of core/scheduler/typescript/scheduler_harness.ts
// (conformance/c/harness.h has the loop). The programs are data, evaluated here as the reference
// does (see its header). Values are op_values, held; keys are interned strings.
//
// async: {"wait":[p]} makes a promise with sc_promise_new and names it p; the run returns it
// (SC_AWAIT). {"wait":[p,e]} also keeps e and the run, and resolve evaluates e through the run
// first (the read is the global one: after the await it counts for nothing), then settles the promise with its value or
// error, as a then does. the rest (the result lands at the next pulse) is the scheduler's.
//
// the run, as the reference's: a computer's program takes sc_get_run at its start and keeps
// it in its context, so a write in a run (after an await too) names the run; in a set, act,
// teardown or run(), the computer's latest run (sc_latest); else none; "open": the run open
// (sc_get_run); a computation's name: its latest run (sc_latest). a scope's info is the
// request's own pairs; every line is retained to the end, so what points into one stays good. a pulse past ENDLESS
// moments is left by a longjmp out of a listener: it answers {"error":"endless"}, and the
// scheduler is not used again reliably (it leaks)
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scheduler.h"
#include "trace.h"
#include "../../../conformance/c/harness.h"

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

static entry *entry_of(const char *key) {
	for (size_t i = 0; i < nstore; i++)
		if (strcmp(store[i]->key, key) == 0) return store[i];
	entry *e = allocate(sizeof *e);
	e->key = copyString(key);
	PUSH(store, nstore, capstore, e);
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

// the latest named so
static sc_scope *scope_named(const char *name) {
	for (size_t i = nnamed; i > 0; i--)
		if (strcmp((char *)sc_scope_user(named[i - 1]), name) == 0) return named[i - 1];
	return NULL;
}

// an error when the name is taken (by one not torn down: else taken over): asked before anything
// is made, so a refused one makes nothing
static char *taken(const char *name) {
	sc_scope *was = scope_named(name ? name : "");
	return was && sc_scope_alive(was) ? formatString("name taken: %s", name ? name : "") : NULL;
}
// names the scope
static char *name_it(sc_scope *o, const char *name) {
	sc_scope_set(o, copyString(name ? name : ""));
	PUSH(named, nnamed, capnamed, o);
	return NULL;
}

static op_value **logged;
static size_t nlogged, caplogged;

// moments, as told (named when asked: a new computer is due before it has a name)
typedef struct moment {
	sc_told m;
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
static jmp_buf endless;

static void told_moment(const sc_told *m, void *data) {
	(void)data;
	if (pulsing && ++told > ENDLESS) longjmp(endless, 1);
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

// the keys untracked since last asked
static op_value **forgotten;
static size_t nforgotten, capforgotten;

static void untrack(const void *key, void *data) {
	(void)data;
	PUSH(forgotten, nforgotten, capforgotten, op_str(key));
}

// the tick of the latest mark (each mark and each new computer takes the next)
static uint64_t latest_tick;
static sc_trace trace;

static void marked(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data) {
	(void)keys, (void)nkeys, (void)run, (void)due, (void)ndue, (void)data;
	latest_tick = tick;
}

static void drop(void *v, void *data) {
	(void)data;
	op_free(v);
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
	case OP_NUM: return (x->num == y->num && signbit(x->num) == signbit(y->num)) || (isnan(x->num) && isnan(y->num));
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

// closures for cleanups: kept to the end
typedef struct closure {
	const op_value *e;
	ctx c;
} closure;
static closure **closures;
static size_t nclosures, capclosures;

static val evaluate(const op_value *e, const ctx *c);
// the effect form
static val made_in(const char *form, const op_value *a0, const op_value *a1, const op_value *a2,
	const op_value *arg);

// the pair lists made from requests: kept to the end
static sc_pair **infos;
static size_t ninfos, capinfos;

// a request's [[key, value]..] as pairs, its own keys and values; NULL, *n 0: none
static const sc_pair *info_of(const op_value *list, size_t *n) {
	*n = 0;
	if (!is(list, OP_LIST) || list->count == 0) return NULL;
	sc_pair *out = allocate(list->count * sizeof *out);
	PUSH(infos, ninfos, capinfos, out);
	for (size_t i = 0; i < list->count; i++) {
		const op_value *p = list->items[i];
		if (!is(p, OP_LIST) || p->count != 2 || !is(p->items[0], OP_STR)) continue;
		out[(*n)++] = (sc_pair){text(p->items[0]), p->items[1]};
	}
	return out;
}

// an info as [[key, value]..], nested: a computer's run and mark are the scheduler's numbers, any
// other value a request's; "owner" is the owner's info
static op_value *pairs_of(const sc_info *info) {
	op_value *pairs = op_list();
	for (size_t j = 0; j < info->n; j++) {
		const sc_pair *q = &info->pairs[j];
		op_value *p = op_list();
		op_push(p, op_str(q->key));
		if (strcmp(q->key, "owner") == 0 && j == info->n - 1) op_push(p, pairs_of(q->value));
		else if (strcmp(q->key, "run") == 0 || strcmp(q->key, "mark") == 0)
			op_push(p, integer((int64_t)*(const uint64_t *)q->value));
		else op_push(p, op_ref((op_value *)q->value));
		op_push(pairs, p);
	}
	return pairs;
}

// what is open: {scope, pairs, writer?}, by the computer of the run; nothing: null
static op_value *current(void) {
	sc_scope *open = sc_get_current_scope(sch);
	if (open == NULL) return op_null();
	// the scheduler's own answers agree
	if (sc_get_info(sch) != sc_scope_info(open)) abort();
	op_value *out = op_map();
	const char *name = sc_scope_user(open);
	op_set(out, "scope", name ? op_str(name) : op_null());
	op_set(out, "pairs", pairs_of(sc_get_info(sch)));
	sc_run *writer = sc_get_run(sch);
	if (writer) op_set(out, "writer", op_str(sc_scope_user(sc_run_computer(writer))));
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
			if (sum) n += x;
			else if (i == 0) first = x;
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
		keep(k, v.j);
		const void *key = entry_of(k)->key;
		free(k);
		const char *said = text(a2);
		sc_run *writer = NULL;
		if (a2 == NULL) writer = writer_of(c);
		else if (said && strcmp(said, "open") == 0) writer = sc_get_run(sch);
		else if (said) {
			// a computation by name: its latest run (none yet: from outside)
			sc_scope *o = scope_named(said);
			if (o == NULL) {
				release(v);
				return thrown(formatString("no scope %s", said));
			}
			writer = sc_latest(o);
		}
		sc_mark(sch, &key, 1, writer);
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
		waiting *w = allocate(sizeof *w);
		w->name = name;
		w->p = sc_promise_new(sch);
		if (a1) {
			w->then = a1;
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
		return (val){V_PROMISE, NULL, NULL, w->p};
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
	if (strcmp(form, "effect") == 0) return made_in(form, a0, a1, a2, arg);
	if (strcmp(form, "quote") == 0) return ok(op_ref((op_value *)arg));
	return thrown(formatString("unknown form %s", form));
}

// a computer's program

typedef struct prog {
	const op_value *f;
	const op_value *act;
	const char *to;
	sc_computer *self;
} prog;
static prog **progs;
static size_t nprogs, capprogs;

// itself: an early effect runs and acts before it is given back, the scope open then
static sc_scope *self_of(prog *p) { return p->self ? p->self : sc_get_current_scope(sch); }

static sc_out program_f(void *previous, void *data) {
	prog *p = data;
	ctx c = {sc_get_run(sch), self_of(p), NULL, previous};
	val v = evaluate(p->f, &c);
	switch (v.k) {
	case V_OK: return (sc_out){.kind = SC_VALUE, .value = v.j};
	case V_PROMISE: return (sc_out){.kind = SC_AWAIT, .promise = v.p};
	case V_THROW: return (sc_out){.kind = SC_FAILED, .error = v.err};
	default: return (sc_out){.kind = SC_PENDING};
	}
}

static char *program_set(void *value, void *data) {
	prog *p = data;
	if (p->to == NULL) return NULL;
	keep(p->to, value);
	sc_mark(sch, (const void *[]){p->to}, 1, sc_latest(p->self));
	return NULL;
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
};
static void in_making(void *data) {
	struct making *m = data;
	m->c = m->effect ? sc_create_effect(sch, m->def) : sc_create_computer(sch, m->def);
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
	struct making m = {def, effect, NULL};
	const char *why = sc_run_with_scope(o, in_making, &m);
	if (why) return answer_error(copyString(why));
	sc_computer *c = m.c;
	if (c == NULL) return answer_error(copyString(SC_DISPOSED));
	p->self = c;
	bad = name_it(c, text(op_get(r, "name")));
	return bad ? answer_error(bad) : op_map();
}

// {"effect":[c,f,act,early?]}: an effect under the scope open. c taken by one torn down: taken over
static val made_in(const char *form, const op_value *a0, const op_value *a1, const op_value *a2,
	const op_value *arg) {
	const char *name = text(a0);
	if (name == NULL) return thrown(formatString("a %s with no name", form));
	char *was = taken(name);
	if (was) return thrown(was);
	prog *p = allocate(sizeof *p);
	PUSH(progs, nprogs, capprogs, p);
	p->f = a1;
	p->act = a2;
	const op_value *early = is(arg, OP_LIST) && arg->count > 3 ? arg->items[3] : NULL;
	sc_def def = {.f = program_f, .equal = object_is, .data = p, .effect = program_effect};
	def.early = is(early, OP_BOOL) && early->bool_;
	// an early one runs and acts before it is given back: itself, the scope open then (self_of)
	sc_computer *c = sc_create_effect(sch, def);
	if (c == NULL) return thrown(unmade(NULL));
	p->self = c;
	char *bad = name_it(c, name);
	if (bad) return thrown(bad);
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
	wait_free(w);
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
		op_value *out = op_map();
		op_set(out, "value", in.v.j ? in.v.j : op_null());
		return out;
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
		return answer_tick(t);
	}
	if (strcmp(op, "pulse") == 0) {
		told = 0;
		pulsing = true;
		if (setjmp(endless) != 0) {
			pulsing = false;
			return answer_error(copyString("endless"));
		}
		sc_pulse(sch);
		pulsing = false;
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
		const op_value *reads = op_get(r, "reads");
		op_value *list = op_list();
		for (size_t i = 0; i < nmoments; i++) {
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
	if (strcmp(op, "tick") == 0) return answer_tick(latest_tick);
	return answer_error(formatString("unknown op %s", op));
}

void hh_answer(const op_value *r, FILE *out) {
	if (sch == NULL) {
		sch = sc_new((sc_options){.drop = drop});
		sc_trace_start(sch, &trace, told_moment, NULL);
		sc_on_tracking_end(sch, untrack, NULL);
		sc_on_mark(sch, marked, NULL);
	}
	PUSH(lines, nlines, caplines, hh_retain());
	op_value *a = answer(r);
	op_json_write(out, a);
	op_free(a);
}

void hh_finish(void) {
	if (sch == NULL) return;
	for (size_t i = 0; i < nwaits; i++) wait_free(waits[i]);
	for (size_t i = 0; i < nold; i++) wait_free(old[i]);
	for (size_t i = 0; i < nnamed; i++) free(sc_scope_user(named[i]));
	sc_free(sch);
	for (size_t i = 0; i < nmoments; i++) {
		free(moments[i].error);
		free(moments[i].through);
		free(moments[i].reads);
	}
	for (size_t i = 0; i < nlogged; i++) op_free(logged[i]);
	for (size_t i = 0; i < nforgotten; i++) op_free(forgotten[i]);
	free(forgotten);
	for (size_t i = 0; i < nstore; i++) {
		op_free(store[i]->value);
		free(store[i]->key);
		free(store[i]);
	}
	for (size_t i = 0; i < nprogs; i++) free(progs[i]);
	for (size_t i = 0; i < nclosures; i++) free(closures[i]);
	for (size_t i = 0; i < ninfos; i++) free(infos[i]);
	free(infos);
	for (size_t i = 0; i < nlines; i++) hh_release(lines[i]);
	free(store);
	free(named);
	free(logged);
	free(moments);
	free(waits);
	free(old);
	free(progs);
	free(closures);
	free(lines);
}
