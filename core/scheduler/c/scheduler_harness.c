// The C scheduler (scheduler.h) on the line protocol of conformance/scheduler/harness.ts: one JSON
// request per line in, one answer per line out, in order. The programs are data, evaluated here
// as the reference does (see its header). Values are Json, held; keys are interned strings.
//
// async: {"wait":[p]} makes a promise with sc_promise_new and names it p; the run returns it
// (SC_AWAIT). {"wait":[p,e]} also keeps e and the run, and resolve evaluates e through the run
// first (a closed run refuses the read: stopped), then settles the promise with its value or
// error, as a then does. the rest (the result lands at the next pulse) is the scheduler's.
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scheduler.h"
#include "../../../ermine/encoding/c/json.h"

static sc_scheduler *sch;

// the store, names ------------------------------------------------------------------------------

// the value kept at a key; the key's pointer is the scheduler's key
typedef struct entry {
	char *key;
	Json *value;
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

static void keep(const char *key, Json *v) {
	entry *e = entry_of(key);
	Json *was = e->value;
	e->value = v ? jsonRef(v) : NULL;
	jsonFree(was);
}

static sc_owner **named;
static size_t nnamed, capnamed;

static sc_owner *owner_named(const char *name) {
	for (size_t i = 0; i < nnamed; i++)
		if (strcmp((char *)sc_owner_user(named[i]), name) == 0) return named[i];
	return NULL;
}

// names the owner; an error when the name is taken
static char *name_it(sc_owner *o, const char *name) {
	if (owner_named(name)) return formatString("name taken: %s", name);
	sc_owner_set(o, copyString(name));
	PUSH(named, nnamed, capnamed, o);
	return NULL;
}

static Json **logged;
static size_t nlogged, caplogged;

// moments, as told (named when asked: a new computation is due before it has a name)
typedef struct moment {
	sc_moment m;
	char *error;
	sc_computation **through;
} moment;
static moment *moments;
static size_t nmoments, capmoments;

static void hook(const sc_moment *m, void *data) {
	(void)data;
	moment x = {.m = *m};
	x.error = m->error ? copyString(m->error) : NULL;
	x.m.error = x.error;
	if (m->nthrough) {
		x.through = allocate(m->nthrough * sizeof *x.through);
		memcpy(x.through, m->through, m->nthrough * sizeof *x.through);
		x.m.through = x.through;
	}
	PUSH(moments, nmoments, capmoments, x);
}

static void drop(void *v, void *data) {
	(void)data;
	jsonFree(v);
}

// equality --------------------------------------------------------------------------------------

// Object.is: scalars by value, the rest by identity
static bool object_is(const void *a, const void *b, void *data) {
	(void)data;
	if (a == b) return true;
	const Json *x = a, *y = b;
	if (x == NULL || y == NULL || x->type != y->type) return false;
	switch (x->type) {
	case JSON_NULL: return true;
	case JSON_BOOLEAN: return x->boolean == y->boolean;
	case JSON_NUMBER: return jsonSameNumber(x->number, y->number);
	case JSON_STRING:
		return x->stringLength == y->stringLength && memcmp(x->string, y->string, x->stringLength) == 0;
	default: return false;
	}
}

static bool same_json(const Json *a, const Json *b) {
	char *x = jsonPrint(a), *y = jsonPrint(b);
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

// what an expression is evaluated in: the run it reads through, the computation, an act's values
typedef struct ctx {
	sc_run *run;
	sc_owner *self;
	const Json *value;
	const Json *previous;
} ctx;

// V_THROW and V_STOP end the evaluation, as a throw does
typedef enum { V_OK, V_PENDING, V_PROMISE, V_THROW, V_STOP } vkind;
typedef struct val {
	vkind k;
	// V_OK: held
	Json *j;
	// V_THROW: owned
	char *err;
	sc_promise *p;
} val;

static val ok(Json *j) { return (val){V_OK, j, NULL, NULL}; }
static val thrown(char *e) { return (val){V_THROW, NULL, e, NULL}; }
static void release(val v) {
	jsonFree(v.j);
	free(v.err);
}

// a promise named by a program
typedef struct waiting {
	char *name;
	sc_promise *p;
	const Json *then;
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
	const Json *e;
	ctx c;
} closure;
static closure **closures;
static size_t nclosures, capclosures;

static val evaluate(const Json *e, const ctx *c);

static double num(const Json *j) {
	if (j == NULL || j->type == JSON_NULL) return 0;
	return j->type == JSON_NUMBER ? j->number : NAN;
}

#define EVAL(var, expr) \
	val var = evaluate((expr), c); \
	if (var.k == V_THROW || var.k == V_STOP) return var

// e evaluated to a string, copied; NULL when it is not one
static val string_of(const Json *e, const ctx *c, char **out) {
	*out = NULL;
	EVAL(v, e);
	if (v.j && jsonIsString(v.j)) *out = copyString(jsonText(v.j));
	release(v);
	return ok(NULL);
}

struct inrun {
	const Json *e;
	const ctx *c;
	val v;
};
static void in_run(void *data) {
	struct inrun *r = data;
	ctx inner = *r->c;
	inner.run = NULL;
	r->v = evaluate(r->e, &inner);
}

// a value's error, if it threw; the rest let go
static char *error_of(val v) {
	char *e = v.k == V_THROW ? v.err : NULL;
	v.err = NULL;
	release(v);
	return e;
}

static char *cleanup_run(void *data) {
	closure *k = data;
	ctx inner = k->c;
	inner.run = NULL;
	return error_of(evaluate(k->e, &inner));
}

static closure *closure_of(const Json *e, const ctx *c) {
	closure *k = allocate(sizeof *k);
	k->e = e;
	k->c = *c;
	k->c.run = NULL;
	PUSH(closures, nclosures, capclosures, k);
	return k;
}

static val evaluate(const Json *e, const ctx *c) {
	if (e == NULL || e->type == JSON_NULL || e->type == JSON_BOOLEAN || e->type == JSON_NUMBER ||
		e->type == JSON_STRING)
		return ok(e ? jsonRef((Json *)e) : jsonNull());
	if (e->type == JSON_ARRAY) {
		Json *out = jsonArray();
		for (int i = 0; i < e->array.count; i++) {
			val v = evaluate(e->array.items[i], c);
			if (v.k == V_THROW || v.k == V_STOP) return jsonFree(out), v;
			jsonPush(out, v.j ? v.j : jsonNull());
		}
		return ok(out);
	}
	if (e->type != JSON_OBJECT || e->object.count == 0) return thrown(copyString("unknown form undefined"));
	const char *form = e->object.members[0].key;
	const Json *arg = e->object.members[0].value;
	const Json *a0 = NULL, *a1 = NULL, *a2 = NULL;
	if (jsonIsArray(arg)) {
		if (arg->array.count > 0) a0 = arg->array.items[0];
		if (arg->array.count > 1) a1 = arg->array.items[1];
		if (arg->array.count > 2) a2 = arg->array.items[2];
	}
	if (strcmp(form, "read") == 0) {
		char *k;
		val r = string_of(arg, c, &k);
		if (r.k != V_OK) return r;
		if (k == NULL) return thrown(copyString("read of a non-string"));
		entry *en = entry_of(k);
		free(k);
		sc_read_status st = c->run ? sc_run_read(c->run, en->key) : sc_read(sch, en->key);
		if (st == SC_STOP) return (val){V_STOP, NULL, NULL, NULL};
		if (st == SC_CLOSED) return thrown(copyString(SC_STOPPED));
		return ok(en->value ? jsonRef(en->value) : jsonNull());
	}
	if (strcmp(form, "sum") == 0 || strcmp(form, "mod") == 0) {
		bool sum = form[0] == 's';
		double n = 0, first = 0;
		for (int i = 0; i < (jsonIsArray(arg) ? arg->array.count : 0); i++) {
			EVAL(v, arg->array.items[i]);
			double x = num(v.j);
			release(v);
			if (sum) n += x;
			else if (i == 0) first = x;
			else n = fmod(first, x);
		}
		return ok(jsonNumber(n));
	}
	if (strcmp(form, "eq") == 0) {
		EVAL(x, a0);
		EVAL(y, a1);
		bool same = x.j && y.j ? same_json(x.j, y.j) : x.j == y.j;
		release(x);
		release(y);
		return ok(jsonBoolean(same));
	}
	if (strcmp(form, "if") == 0) {
		EVAL(t, a0);
		bool yes = t.j && t.j->type == JSON_BOOLEAN && t.j->boolean;
		release(t);
		return evaluate(yes ? a1 : a2, c);
	}
	if (strcmp(form, "given") == 0) {
		const char *which = jsonText(arg);
		const Json *j = which && strcmp(which, "value") == 0 ? c->value
			: which && strcmp(which, "previous") == 0 ? c->previous : NULL;
		return ok(j ? jsonRef((Json *)j) : jsonNull());
	}
	if (strcmp(form, "log") == 0) {
		EVAL(v, arg);
		PUSH(logged, nlogged, caplogged, v.j ? jsonRef(v.j) : jsonNull());
		return v;
	}
	if (strcmp(form, "do") == 0) {
		val last = ok(jsonNull());
		for (int i = 0; i < (jsonIsArray(arg) ? arg->array.count : 0); i++) {
			release(last);
			last = evaluate(arg->array.items[i], c);
			if (last.k == V_THROW || last.k == V_STOP) return last;
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
		sc_changed(sch, &key, 1);
		return v;
	}
	if (strcmp(form, "throw") == 0) return thrown(copyString(jsonText(arg) ? jsonText(arg) : "null"));
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
		const char *bad = sc_setup(c->self, in_run, &r);
		if (bad) return thrown(copyString(bad));
		return r.v;
	}
	if (strcmp(form, "cleanup") == 0) {
		const char *name = jsonText(a0);
		sc_owner *o = name ? owner_named(name) : NULL;
		if (o == NULL) return thrown(formatString("no owner %s", name ? name : "null"));
		char *bad = sc_cleanup(o, cleanup_run, closure_of(a1, c));
		if (bad) return thrown(bad);
		return ok(jsonNull());
	}
	if (strcmp(form, "dispose") == 0) {
		const char *name = jsonText(arg);
		sc_owner *o = name ? owner_named(name) : NULL;
		if (o == NULL) return thrown(formatString("no owner %s", name ? name : "null"));
		char *bad = sc_dispose(o);
		if (bad) return thrown(bad);
		return ok(jsonNull());
	}
	if (strcmp(form, "quote") == 0) return ok(jsonRef((Json *)arg));
	return thrown(formatString("unknown form %s", form));
}

// a computation's program

typedef struct prog {
	const Json *f;
	const Json *act;
	const char *to;
	sc_computation *self;
} prog;
static prog **progs;
static size_t nprogs, capprogs;

static sc_out program_f(sc_run *run, void *data) {
	prog *p = data;
	ctx c = {run, p->self, NULL, NULL};
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
	sc_changed(sch, (const void *[]){p->to}, 1);
	return NULL;
}

static char *program_act(void *value, void *previous, void *data) {
	prog *p = data;
	ctx c = {NULL, p->self, value, previous};
	return error_of(evaluate(p->act, &c));
}

// requests --------------------------------------------------------------------------------------

static Json **requests;
static size_t nrequests, caprequests;

static Json *answer_error(char *e) {
	Json *o = jsonObject();
	jsonAdd(o, "error", jsonStringTaking(e, strlen(e)));
	return o;
}
static Json *answer_tick(uint64_t t) {
	Json *o = jsonObject();
	jsonAdd(o, "tick", jsonInteger((int64_t)t));
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
static Json *name_json(const sc_computation *c) { return jsonString((const char *)sc_owner_user(c)); }

static Json *moment_json(const moment *x) {
	const sc_moment *m = &x->m;
	Json *o = jsonObject();
	switch (m->kind) {
	case SC_DUE:
		jsonAdd(o, "due", name_json(m->c));
		jsonAdd(o, "tick", jsonInteger((int64_t)m->tick));
		break;
	case SC_STARTS:
		jsonAdd(o, "starts", name_json(m->c));
		jsonAdd(o, "run", jsonInteger(m->run));
		jsonAdd(o, "rank", jsonInteger(m->rank));
		break;
	case SC_ACTS:
		jsonAdd(o, "acts", name_json(m->c));
		jsonAdd(o, "run", jsonInteger(m->run));
		if (m->error) jsonAdd(o, "error", jsonString(m->error));
		break;
	case SC_ENDS:
		jsonAdd(o, "ends", name_json(m->c));
		jsonAdd(o, "run", jsonInteger(m->run));
		jsonAdd(o, "ended", jsonString(ended_name(m->ended)));
		if (m->equal >= 0) jsonAdd(o, "equal", jsonBoolean(m->equal));
		if (m->error) jsonAdd(o, "error", jsonString(m->error));
		if (m->waits) jsonAdd(o, "waits", name_json(m->waits));
		if (m->nthrough) {
			Json *t = jsonArray();
			for (size_t i = 0; i < m->nthrough; i++) jsonPush(t, name_json(m->through[i]));
			jsonAdd(o, "through", t);
		}
		break;
	}
	return o;
}

static sc_owner *need_owner(const Json *name, char **bad) {
	const char *n = jsonText(name);
	sc_owner *o = n ? owner_named(n) : NULL;
	if (o == NULL) *bad = formatString("no owner %s", n ? n : "null");
	return o;
}

static Json *make_computation(const Json *r, bool effect) {
	char *bad = NULL;
	sc_owner *o = need_owner(jsonGet(r, "owner"), &bad);
	if (!o) return answer_error(bad);
	prog *p = allocate(sizeof *p);
	PUSH(progs, nprogs, capprogs, p);
	p->f = jsonGet(r, "f");
	p->act = jsonGet(r, "act");
	const char *to = jsonText(jsonGet(r, "to"));
	p->to = to ? entry_of(to)->key : NULL;
	const char *eq = jsonText(jsonGet(r, "equal"));
	sc_def def = {.f = program_f,
		.equal = eq && strcmp(eq, "json") == 0 ? json_equal : object_is,
		.data = p};
	if (effect) def.act = program_act;
	else def.set = program_set;
	sc_computation *c = effect ? sc_effect(o, def) : sc_compute(o, def);
	if (c == NULL) return answer_error(copyString(SC_DISPOSED));
	p->self = c;
	bad = name_it(c, jsonText(jsonGet(r, "name")));
	return bad ? answer_error(bad) : jsonObject();
}

static Json *settle(const Json *r, bool resolve) {
	const char *name = jsonText(jsonGet(r, "promise"));
	waiting *w = name ? wait_for(name) : NULL;
	if (w == NULL) return answer_error(formatString("no promise %s", name ? name : "null"));
	for (size_t i = 0; i < nwaits; i++)
		if (waits[i] == w) waits[i] = waits[--nwaits];
	if (!resolve) {
		const char *why = jsonText(jsonGet(r, "error"));
		sc_reject(w->p, copyString(why ? why : "null"));
	} else if (w->then) {
		val v = evaluate(w->then, &w->c);
		if (v.k == V_THROW) sc_reject(w->p, v.err);
		else if (v.k == V_PENDING) sc_resolve_pending(w->p);
		else sc_resolve(w->p, v.j ? v.j : jsonNull());
	} else {
		const Json *value = jsonGet(r, "value");
		sc_resolve(w->p, value ? jsonRef((Json *)value) : jsonNull());
	}
	wait_free(w);
	return jsonObject();
}

static Json *answer(const Json *r) {
	const char *op = jsonText(jsonGet(r, "op"));
	if (op == NULL) return answer_error(copyString("no op"));
	char *bad = NULL;
	if (strcmp(op, "owner") == 0) {
		const Json *parent = jsonGet(r, "parent");
		sc_owner *p = NULL;
		if (parent && parent->type != JSON_NULL && !(p = need_owner(parent, &bad))) return answer_error(bad);
		sc_owner *o = sc_owner_new(sch, p);
		if (o == NULL) return answer_error(copyString(SC_DISPOSED));
		bad = name_it(o, jsonText(jsonGet(r, "name")));
		return bad ? answer_error(bad) : jsonObject();
	}
	if (strcmp(op, "compute") == 0) return make_computation(r, false);
	if (strcmp(op, "effect") == 0) return make_computation(r, true);
	if (strcmp(op, "cleanup") == 0 || strcmp(op, "run") == 0) {
		sc_owner *o = need_owner(jsonGet(r, "owner"), &bad);
		if (!o) return answer_error(bad);
		ctx c = {NULL, o, NULL, NULL};
		if (op[0] == 'c') {
			bad = sc_cleanup(o, cleanup_run, closure_of(jsonGet(r, "do"), &c));
			return bad ? answer_error(bad) : jsonObject();
		}
		struct inrun in = {jsonGet(r, "do"), &c, ok(NULL)};
		const char *why = sc_setup(o, in_run, &in);
		if (why) return answer_error(copyString(why));
		if (in.v.k == V_THROW) return answer_error(in.v.err);
		Json *out = jsonObject();
		jsonAdd(out, "value", in.v.j ? in.v.j : jsonNull());
		return out;
	}
	if (strcmp(op, "dispose") == 0) {
		sc_owner *o = need_owner(jsonGet(r, "owner"), &bad);
		if (!o) return answer_error(bad);
		bad = sc_dispose(o);
		return bad ? answer_error(bad) : jsonObject();
	}
	if (strcmp(op, "write") == 0 || strcmp(op, "changed") == 0) {
		bool write = op[0] == 'w';
		const Json *list = jsonGet(r, write ? "values" : "keys");
		size_t n = write ? (jsonIsObject(list) ? (size_t)list->object.count : 0)
			: (jsonIsArray(list) ? (size_t)list->array.count : 0);
		const void **keys = allocate((n + 1) * sizeof *keys);
		for (size_t i = 0; i < n; i++) {
			const char *k = write ? list->object.members[i].key : jsonText(list->array.items[i]);
			if (k == NULL) {
				free(keys);
				return answer_error(copyString("bad key"));
			}
			if (write) keep(k, list->object.members[i].value);
			keys[i] = entry_of(k)->key;
		}
		uint64_t t = sc_changed(sch, keys, n);
		free(keys);
		return answer_tick(t);
	}
	if (strcmp(op, "pulse") == 0) {
		sc_pulse(sch);
		return jsonObject();
	}
	if (strcmp(op, "resolve") == 0) return settle(r, true);
	if (strcmp(op, "reject") == 0) return settle(r, false);
	if (strcmp(op, "get") == 0) {
		const char *k = jsonText(jsonGet(r, "key"));
		entry *e = k ? entry_of(k) : NULL;
		Json *out = jsonObject();
		jsonAdd(out, "value", e && e->value ? jsonRef(e->value) : jsonNull());
		return out;
	}
	if (strcmp(op, "log") == 0) {
		Json *list = jsonArray();
		for (size_t i = 0; i < nlogged; i++) jsonPush(list, logged[i]);
		nlogged = 0;
		Json *out = jsonObject();
		jsonAdd(out, "log", list);
		return out;
	}
	if (strcmp(op, "moments") == 0) {
		Json *list = jsonArray();
		for (size_t i = 0; i < nmoments; i++) {
			jsonPush(list, moment_json(&moments[i]));
			free(moments[i].error);
			free(moments[i].through);
		}
		nmoments = 0;
		Json *out = jsonObject();
		jsonAdd(out, "moments", list);
		return out;
	}
	if (strcmp(op, "tick") == 0) return answer_tick(sc_tick(sch));
	return answer_error(formatString("unknown op %s", op));
}

int main(void) {
	sch = sc_new((sc_options){.hook = hook, .drop = drop});
	char *line = NULL;
	size_t cap = 0;
	ssize_t n;
	while ((n = getline(&line, &cap, stdin)) >= 0) {
		size_t len = (size_t)n;
		while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r' || line[len - 1] == ' ')) len--;
		if (len == 0) continue;
		char *why = NULL;
		Json *r = jsonParse(line, len, &why);
		Json *out;
		if (r == NULL) {
			out = answer_error(why);
		} else {
			PUSH(requests, nrequests, caprequests, r);
			out = answer(r);
		}
		char *text = jsonPrint(out);
		fputs(text, stdout);
		fputc('\n', stdout);
		fflush(stdout);
		free(text);
		jsonFree(out);
	}
	free(line);
	for (size_t i = 0; i < nwaits; i++) wait_free(waits[i]);
	for (size_t i = 0; i < nold; i++) wait_free(old[i]);
	for (size_t i = 0; i < nnamed; i++) free(sc_owner_user(named[i]));
	sc_free(sch);
	for (size_t i = 0; i < nmoments; i++) {
		free(moments[i].error);
		free(moments[i].through);
	}
	for (size_t i = 0; i < nlogged; i++) jsonFree(logged[i]);
	for (size_t i = 0; i < nstore; i++) {
		jsonFree(store[i]->value);
		free(store[i]->key);
		free(store[i]);
	}
	for (size_t i = 0; i < nprogs; i++) free(progs[i]);
	for (size_t i = 0; i < nclosures; i++) free(closures[i]);
	for (size_t i = 0; i < nrequests; i++) jsonFree(requests[i]);
	free(store);
	free(named);
	free(logged);
	free(moments);
	free(waits);
	free(old);
	free(progs);
	free(closures);
	free(requests);
	return 0;
}
