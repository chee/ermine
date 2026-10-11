// The scheduler (newcore/scheduler.ts), in C. Ported in the same order of operations: the clock
// ticks wherever scheduler.ts's does. Comments say what the reference's say, tersely.
//
// notify is told object-level patches: the whole object at ["value"], ["info", name] or
// ["children", name], with a "before" that is a node view with only the keys that matter (the
// facts only look at the object's parent). Every read the scheduler watches is object-level:
// deep at the object, keys-only at ["children"].
#include "scheduler.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../c/trackgraph.h"
#include "../../opstreams/mutate/c/mutate.h"

// memory: an arena, and growing things in it

typedef struct block {
	struct block *next;
	size_t left;
	size_t size;
} block;

typedef struct {
	block *head;
	char *cur;
	size_t left;
} arena;

static void die(const char *why) {
	fprintf(stderr, "scheduler: %s\n", why);
	abort();
}

static void *aalloc(arena *a, size_t n) {
	n = (n + 15) & ~(size_t)15;
	if (n > a->left) {
		size_t size = n > 65536 ? n : 65536;
		block *b = malloc(sizeof *b + size + 16);
		if (!b) die("out of memory");
		b->next = a->head;
		a->head = b;
		a->cur = (char *)(((size_t)(b + 1) + 15) & ~(size_t)15);
		a->left = size;
	}
	void *p = a->cur;
	a->cur += n;
	a->left -= n;
	memset(p, 0, n);
	return p;
}

static void afree(arena *a) {
	while (a->head) {
		block *b = a->head;
		a->head = b->next;
		free(b);
	}
	a->cur = NULL;
	a->left = 0;
}

typedef struct {
	void **v;
	size_t n, cap;
} vec;

// ordered maps by string: insertion order, deleting and setting again moves to the end
typedef struct {
	const char *key; // NULL: deleted
	void *val;
} ent;
typedef struct {
	ent *e;
	size_t n, cap, live;
	size_t *idx; // entry + 1; 0 empty; SIZE_MAX deleted
	size_t slots;
} omap;

#define TOMB ((size_t)-1)

// the scheduler

typedef struct sc_proc sc_proc;
typedef struct sc_spot sc_spot;
typedef struct sc_run sc_run;
typedef struct sc_cause sc_cause;

// a step of an agent's code: the fields the scheduler adds
struct sc_step {
	const char *process;
	const char *prog_node; // NULL: no program
	int64_t prog_time;
	long run; // 0: none
	const char *handler;
	int cleanup;
	const char *kill;
	const nt_value *status;
};

// an actor of the scheduler's shape (SCHEDULER.tex, What a process acts as)
struct sc_agent {
	pr_value actor;
	int has_peer, has_person, has_trusted;
	pr_value peer, person;
	int trusted;
	const sc_step *code;
	size_t ncode;
};

// what caused a run in its request: its process, and the causes of each change that marked it
struct sc_cause {
	const char *id;
	sc_cause **parents;
	size_t n;
};

// a change that marked a process, and its causes
typedef struct {
	const sc_change *by;
	sc_cause *causes;
} sc_kept;

typedef struct {
	sc_proc *proc;
	const char *name;
	const char *part;
	long replaced;
} sc_child;

typedef struct {
	const char *op;
	int has_address;
	const char *const *address;
	size_t naddress;
	const char *name;
	int tracked;
	int64_t *times;
	size_t ntimes;
} sc_read;

struct sc_proc {
	int kind; // 0: a process (an owner's tag)
	const char *id;
	const char *name;
	const char *const *place;
	size_t nplace;
	sc_agent base;
	const sc_step *prefix;
	size_t nprefix;
	int64_t started;
	int has_path;
	const char *const *path;
	size_t npath;
	int has_code;
	sc_code code;
	int has_program;
	const char *prog_node;
	int64_t prog_time;
	int (*equal)(const nt_value *, const nt_value *);
	sc_proc *parent;
	vec children; // sc_child *
	vec owned; // const char *, in the order made
	long runs;
	int replaced;
	long replacements;
	int setup;
	vec kept; // sc_kept *, by time
	int has_last;
	const nt_value *last;
	nt_value *status; // a map of the fields it has
	int has_since;
	int64_t since;
	vec values; // const char *: the processes whose nodes its last run that did not stop read
	sc_run *waiting;
	vec cleanups; // sc_fn *
	sc_proc *after;
	long rank;
	long tj_index, tj_low;
	int tj_seen, tj_on;
	int has_previous;
	const nt_value *previous;
	const char *run;
	int parked;
	int has_looping;
	vec looping; // const char *
	int state; // 0 running, 1 killing, 2 gone
	int busy;
	tg_node *track;
};

enum { RUNNING, KILLING, GONE };

// a spot: a part of a node something read
struct sc_spot {
	int kind; // 1
	const char *id;
	pl_kind part;
	const char *name;
	const char *key;
	tg_node *track;
	nt_read *watch;
	struct sc_sched *s;
};

struct sc_run {
	sc_proc *p;
	long n;
	int64_t mark;
	vec given; // sc_kept *
	sc_cause *causes;
	vec reads; // sc_read *
	vec wrote; // int64 stored as pointers to int64
	vec values; // const char *
	long rank;
	const char *part; // NULL, "setup", "effect"
	const nt_value *value;
	int has_equal;
	int equal;
	const char *why;
	int has_shown;
	const nt_value *shown;
	sc_proc *stopped;
	int replaced;
	int has_looping;
	vec looping;
};

typedef struct {
	const char *part;
	vec before; // sc_child *
	vec matched;
	int replaced;
} sc_partcall;

typedef struct {
	sc_proc *p;
	const sc_agent *agent;
	long run_n; // base.run
	const char *handler;
	int cleanup;
	sc_run *run;
	int compute;
	sc_cause *causes;
	const char *cause;
	sc_partcall *call;
} sc_ctx;

// who a change is by, as places asks for it
typedef struct {
	const sc_agent *actor;
	const char *reader;
	const char *cause;
} acting_t;

// an interface bound to a place, as an actor
struct sc_api {
	sc_sched *s;
	sc_ctx *ctx;
	const char *const *place;
	size_t nplace;
	const sc_agent *agent;
	const char *reader;
	int tracked; // depend: tracks as the reader
	sc_proc *proc; // the tracker and owner
	int writes;
	int *alive; // NULL: always
	int owner;
};

typedef struct {
	sc_proc *p;
	int *alive;
	sc_ctx *ctx;
} sc_gctx;

struct sc_sched {
	arena a;
	pr_arena pra;
	int64_t own_clock;
	int64_t *clock;
	const sc_agent *host_actor;
	sc_hook *hooks;
	size_t nhooks;
	sc_finder finder;
	void *finder_ctx;
	const char *(*fresh)(void *, int64_t);
	void *fresh_ctx;
	pr_may may;
	const char *root;

	omap table; // nd_node *
	vec trackers; // every tg_node made, for freeing
	pl_places places;

	acting_t *acting;
	vec made; // sc_change *

	omap procs;
	omap due; // int64 *
	omap ephemeral;
	omap owners; // sc_proc *
	omap runs; // sc_proc *
	vec waiting; // sc_run *
	struct qitem *queue;
	size_t nqueue, qcap, qhead;
	vec deferred; // struct defer *

	int depth;
	int in_round;
	int active;
	omap ran;
	vec stamped; // sc_kept *

	omap spots;
	omap spots_of; // vec * of sc_spot *
	omap notifies; // nt_notify *

	struct telling_t *telling;

	// rank
	omap rank_of; // long * by proc id
	int rank_valid;
	omap named; // long *

	sc_api host;
	int64_t last_time_unused;
};

// containers

static void *amem(sc_sched *s, size_t n) { return aalloc(&s->a, n); }
char *sc_dup(sc_sched *s, const char *str) {
	size_t n = strlen(str) + 1;
	return memcpy(amem(s, n), str, n);
}
void *sc_alloc(sc_sched *s, size_t n) { return amem(s, n); }
pr_arena *sc_pr_arena(sc_sched *s) { return &s->pra; }

static void vpush(sc_sched *s, vec *v, void *x) {
	if (v->n == v->cap) {
		size_t cap = v->cap ? v->cap * 2 : 4;
		void **nv = amem(s, cap * sizeof *nv);
		if (v->n) memcpy(nv, v->v, v->n * sizeof *nv);
		v->v = nv;
		v->cap = cap;
	}
	v->v[v->n++] = x;
}
static vec vcopy(sc_sched *s, const vec *v) {
	vec c = {0};
	for (size_t i = 0; i < v->n; i++) vpush(s, &c, v->v[i]);
	return c;
}
static void vdel(vec *v, size_t i) {
	memmove(&v->v[i], &v->v[i + 1], (v->n - i - 1) * sizeof *v->v);
	v->n--;
}
static long vfind(const vec *v, const void *x) {
	for (size_t i = 0; i < v->n; i++)
		if (v->v[i] == x) return (long)i;
	return -1;
}
static long sfind(const vec *v, const char *x) {
	for (size_t i = 0; i < v->n; i++)
		if (!strcmp(v->v[i], x)) return (long)i;
	return -1;
}
// a vec of strings as a set
static void sadd(sc_sched *s, vec *v, const char *x) {
	if (sfind(v, x) < 0) vpush(s, v, (void *)x);
}

static size_t hashs(const char *k) {
	size_t h = 5381;
	for (; *k; k++) h = h * 33 + (unsigned char)*k;
	return h;
}

static void om_reindex(sc_sched *s, omap *m) {
	size_t live = 0;
	for (size_t i = 0; i < m->n; i++) {
		if (!m->e[i].key) continue;
		m->e[live++] = m->e[i];
	}
	m->n = live;
	size_t slots = 16;
	while (slots < 4 * (m->cap ? m->cap : 4)) slots *= 2;
	m->slots = slots;
	m->idx = amem(s, slots * sizeof *m->idx);
	for (size_t i = 0; i < m->n; i++) {
		size_t h = hashs(m->e[i].key) & (slots - 1);
		while (m->idx[h]) h = (h + 1) & (slots - 1);
		m->idx[h] = i + 1;
	}
}
static long om_find(const omap *m, const char *key) {
	if (!m->slots) return -1;
	for (size_t h = hashs(key) & (m->slots - 1); m->idx[h]; h = (h + 1) & (m->slots - 1)) {
		size_t i = m->idx[h];
		if (i == TOMB) continue;
		if (!strcmp(m->e[i - 1].key, key)) return (long)(i - 1);
	}
	return -1;
}
static void *om_get(const omap *m, const char *key) {
	long i = om_find(m, key);
	return i < 0 ? NULL : m->e[i].val;
}
static int om_has(const omap *m, const char *key) { return om_find(m, key) >= 0; }
// key must outlive the map
static void om_set(sc_sched *s, omap *m, const char *key, void *val) {
	long i = om_find(m, key);
	if (i >= 0) {
		m->e[i].val = val;
		return;
	}
	if (m->n == m->cap) {
		size_t cap = m->live * 2 > 4 ? m->live * 2 : 4;
		ent *ne = amem(s, cap * sizeof *ne);
		size_t k = 0;
		for (size_t j = 0; j < m->n; j++)
			if (m->e[j].key) ne[k++] = m->e[j];
		m->e = ne;
		m->n = k;
		m->cap = cap;
		om_reindex(s, m);
	}
	m->e[m->n] = (ent){key, val};
	size_t h = hashs(key) & (m->slots - 1);
	while (m->idx[h] && m->idx[h] != TOMB) h = (h + 1) & (m->slots - 1);
	m->idx[h] = ++m->n;
	m->live++;
}
static void om_del(omap *m, const char *key) {
	if (!m->slots) return;
	for (size_t h = hashs(key) & (m->slots - 1); m->idx[h]; h = (h + 1) & (m->slots - 1)) {
		size_t i = m->idx[h];
		if (i == TOMB) continue;
		if (!strcmp(m->e[i - 1].key, key)) {
			m->e[i - 1].key = NULL;
			m->idx[h] = TOMB;
			m->live--;
			return;
		}
	}
}

// values. a live value is a null that carries its function in keys, tagged by count

#define LIVE_TAG ((size_t)0x11fe)

nt_value *sc_live(sc_fn *f) {
	nt_value *v = nt_null();
	v->count = LIVE_TAG;
	v->keys = (char **)(void *)f;
	return v;
}
sc_fn *sc_live_fn(const nt_value *v) {
	if (v == NULL || v->type != NT_NULL || v->count != LIVE_TAG) return NULL;
	return (sc_fn *)(void *)v->keys;
}
int sc_is(const nt_value *a, const nt_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
	case NT_NULL: return sc_live_fn(a) == NULL && sc_live_fn(b) == NULL;
	case NT_BOOL: return a->bool_ == b->bool_;
	case NT_NUM:
		if (isnan(a->num) && isnan(b->num)) return 1;
		return a->num == b->num && signbit(a->num) == signbit(b->num);
	case NT_STR: return a->bytes == b->bytes && !memcmp(a->str, b->str, a->bytes);
	default: return 0;
	}
}

static int is_live(const nt_value *v) { return sc_live_fn(v) != NULL; }

// a growing string, for comparing statuses
typedef struct {
	char *s;
	size_t n, cap;
} sbuf;
static void sput(sbuf *b, const char *x, size_t n) {
	if (b->n + n + 1 > b->cap) {
		b->cap = (b->n + n + 1) * 2;
		b->s = realloc(b->s, b->cap);
		if (!b->s) die("out of memory");
	}
	memcpy(b->s + b->n, x, n);
	b->n += n;
	b->s[b->n] = 0;
}
static void jwrite(sbuf *b, const nt_value *v) {
	char t[40];
	if (v == NULL || v->type == NT_NULL) sput(b, is_live(v) ? "\"<live>\"" : "null", is_live(v) ? 8 : 4);
	else if (v->type == NT_BOOL) sput(b, v->bool_ ? "true" : "false", v->bool_ ? 4 : 5);
	else if (v->type == NT_NUM) {
		if (v->num == floor(v->num) && fabs(v->num) < 1e15) snprintf(t, sizeof t, "%.0f", v->num);
		else snprintf(t, sizeof t, "%.17g", v->num);
		sput(b, t, strlen(t));
	} else if (v->type == NT_STR) {
		sput(b, "\"", 1);
		for (size_t i = 0; i < v->bytes; i++) {
			char c = v->str[i];
			if (c == '"' || c == '\\') sput(b, "\\", 1);
			sput(b, &c, 1);
		}
		sput(b, "\"", 1);
	} else if (v->type == NT_LIST) {
		sput(b, "[", 1);
		for (size_t i = 0; i < v->count; i++) {
			if (i) sput(b, ",", 1);
			jwrite(b, v->items[i]);
		}
		sput(b, "]", 1);
	} else {
		sput(b, "{", 1);
		for (size_t i = 0; i < v->count; i++) {
			if (i) sput(b, ",", 1);
			sput(b, "\"", 1);
			sput(b, v->keys[i], strlen(v->keys[i]));
			sput(b, "\":", 2);
			jwrite(b, v->items[i]);
		}
		sput(b, "}", 1);
	}
}
static int json_same(const nt_value *a, const nt_value *b) {
	sbuf x = {0}, y = {0};
	jwrite(&x, a);
	jwrite(&y, b);
	int same = !strcmp(x.s, y.s);
	free(x.s);
	free(y.s);
	return same;
}

// a status (SCHEDULER.tex, Status): a map of pending, error, new, loop; empty: the value is
// current. two statuses are the same when their fields are
static int same_status(const nt_value *a, const nt_value *b) {
	for (size_t i = 0; i < a->count; i++) {
		nt_value *y = nt_get(b, a->keys[i]);
		if (!y || !json_same(a->items[i], y)) return 0;
	}
	for (size_t i = 0; i < b->count; i++)
		if (!nt_get(a, b->keys[i])) return 0;
	return 1;
}

// errors

const sc_error *sc_error_new(sc_sched *s, const char *code, const char *message, int scheduler) {
	sc_error *e = amem(s, sizeof *e);
	e->name = "Error";
	e->code = code;
	e->scheduler = scheduler;
	if (scheduler && message) {
		size_t n = strlen(code) + strlen(message) + 3;
		char *m = amem(s, n);
		snprintf(m, n, "%s: %s", code, message);
		e->message = m;
	} else e->message = message ? message : code;
	return e;
}
static const sc_error *fail(sc_sched *s, const char *code, const char *message) {
	return sc_error_new(s, code, message, 1);
}
static const sc_error *lib_error(sc_sched *s, const char *code, const char *id) {
	if (!id) return sc_error_new(s, code, code, 0);
	size_t n = strlen(code) + strlen(id) + 4;
	char *m = amem(s, n);
	snprintf(m, n, "%s (%s)", code, id);
	return sc_error_new(s, code, m, 0);
}
static const sc_error *pl_error(sc_sched *s, int code, const char *id) {
	return lib_error(s, pl_code_name(code), id);
}
static const sc_error STOP_ERR = {"Stop", "stop", "stop", NULL, 0};

// an error as a status holds it
static nt_value *error_value(const sc_error *e) {
	nt_value *m = nt_map();
	if (e->scheduler) {
		nt_set(m, "code", nt_str(e->code));
		nt_set(m, "message", nt_str(e->message));
		return m;
	}
	nt_set(m, "name", nt_str(e->name ? e->name : "Error"));
	nt_set(m, "message", nt_str(e->message ? e->message : ""));
	if (e->code) nt_set(m, "code", nt_str(e->code));
	return m;
}

// protect's values from ours: null for a live value
static pr_value to_pr(sc_sched *s, const nt_value *v) {
	if (v == NULL || v->type == NT_NULL) return pr_null();
	switch (v->type) {
	case NT_BOOL: return pr_bool(v->bool_);
	case NT_NUM: return pr_num(v->num);
	case NT_STR: return pr_str(&s->pra, v->str, v->bytes);
	case NT_LIST: {
		pr_value l = pr_list();
		for (size_t i = 0; i < v->count; i++) pr_push(&s->pra, &l, to_pr(s, v->items[i]));
		return l;
	}
	default: {
		pr_value m = pr_map();
		for (size_t i = 0; i < v->count; i++) pr_put(&s->pra, &m, v->keys[i], to_pr(s, v->items[i]));
		return m;
	}
	}
}

// agents

const char sc_status_because[] = "scheduler:status";

const sc_agent *sc_agent_of(sc_sched *s, const char *actor) {
	sc_agent *a = amem(s, sizeof *a);
	a->actor = pr_lit(sc_dup(s, actor));
	return a;
}
const sc_agent *sc_agent_with(sc_sched *s, const sc_agent *a, const char *person, int has_trusted,
	int trusted) {
	sc_agent *c = amem(s, sizeof *c);
	*c = *a;
	if (person) c->has_person = 1, c->person = pr_lit(sc_dup(s, person));
	if (has_trusted) c->has_trusted = 1, c->trusted = trusted;
	return c;
}

// the agent as protect sees an actor
static pr_value agent_pr(sc_sched *s, const sc_agent *a) {
	pr_value m = pr_map();
	pr_put(&s->pra, &m, "actor", a->actor);
	if (a->has_peer) pr_put(&s->pra, &m, "peer", a->peer);
	if (a->has_person) pr_put(&s->pra, &m, "person", a->person);
	if (a->has_trusted) pr_put(&s->pra, &m, "trusted", pr_bool(a->trusted));
	pr_value code = pr_list();
	for (size_t i = 0; i < a->ncode; i++) {
		const sc_step *st = &a->code[i];
		pr_value x = pr_map();
		if (st->process) pr_put(&s->pra, &x, "process", pr_lit(st->process));
		if (st->prog_node) {
			pr_value pg = pr_map();
			pr_put(&s->pra, &pg, "node", pr_lit(st->prog_node));
			pr_put(&s->pra, &pg, "time", pr_num((double)st->prog_time));
			pr_put(&s->pra, &x, "program", pg);
		}
		pr_push(&s->pra, &code, x);
	}
	pr_put(&s->pra, &m, "code", code);
	return m;
}

// the agent of a process for a step of its own
static const sc_agent *agent_of(sc_sched *s, sc_proc *p, long run, const nt_value *status,
	const char *handler, int cleanup) {
	sc_agent *a = amem(s, sizeof *a);
	*a = p->base;
	sc_step *code = amem(s, (p->nprefix + 1) * sizeof *code);
	if (p->nprefix) memcpy(code, p->prefix, p->nprefix * sizeof *code);
	sc_step *st = &code[p->nprefix];
	st->process = p->id;
	if (p->has_program) st->prog_node = p->prog_node, st->prog_time = p->prog_time;
	st->run = run;
	st->status = status;
	st->handler = handler;
	st->cleanup = cleanup;
	a->code = code;
	a->ncode = p->nprefix + 1;
	return a;
}
static const sc_agent *run_agent(sc_sched *s, sc_proc *p, long n) {
	return agent_of(s, p, n > 0 ? n : 0, NULL, NULL, 0);
}

// the agent with fields added to its last step; an empty code becomes that one step
static const sc_agent *stepped_kill(sc_sched *s, const sc_agent *a, const char *kill) {
	sc_agent *c = amem(s, sizeof *c);
	*c = *a;
	sc_step *code = amem(s, (a->ncode ? a->ncode : 1) * sizeof *code);
	if (a->ncode) memcpy(code, a->code, a->ncode * sizeof *code);
	code[a->ncode ? a->ncode - 1 : 0].kill = kill;
	c->code = code;
	c->ncode = a->ncode ? a->ncode : 1;
	return c;
}

// changes

static int64_t tick(sc_sched *s) { return ++*s->clock; }

const sc_change *sc_change_new(sc_sched *s, int64_t time, const char *node) {
	sc_change *c = amem(s, sizeof *c);
	c->time = time;
	c->actor = s->host_actor;
	c->node = sc_dup(s, node);
	return c;
}

static sc_change *by_node(sc_sched *s, const char *node) {
	if (!s->acting) die("a change made outside an operation");
	sc_change *c = amem(s, sizeof *c);
	c->time = tick(s);
	c->actor = s->acting->actor;
	c->reader = s->acting->reader;
	c->cause = s->acting->cause;
	c->node = node;
	vpush(s, &s->made, c);
	return c;
}
static const void *places_by(void *ctx, const char *node) { return by_node(ctx, node); }

static nd_node *tget(void *ctx, const char *id) {
	sc_sched *s = ctx;
	return om_get(&s->table, id);
}
nd_node *sc_get(sc_sched *s, const char *id) { return om_get(&s->table, id); }
static void *places_alloc(void *ctx, size_t n) { return amem(ctx, n); }

static void pass(sc_sched *s, const sc_moment *m) {
	for (size_t i = 0; i < s->nhooks; i++) s->hooks[i].fn(s->hooks[i].ctx, m);
}

// spots and notify: what was read, and the watch on it

typedef struct telling_t {
	const sc_change *by;
	sc_cause *causes;
	sc_proc *own;
} telling_t;

static const char *spot_key(sc_sched *s, const char *id, pl_part part) {
	// the id, a separator, the kind, the name
	size_t n = strlen(id) + 3 + (part.name ? strlen(part.name) : 0);
	char *k = amem(s, n + 1);
	snprintf(k, n + 1, "%s\x01%c%s", id, 'a' + (int)part.kind, part.name ? part.name : "");
	return k;
}

static void on_fire(nt_kind kind, void *user);

static void watch(sc_sched *s, sc_spot *sp) {
	if (sp->watch || sp->part == PL_LOADED) return;
	nd_node *n = om_get(&s->table, sp->id);
	if (!n) return;
	nt_notify *nf = om_get(&s->notifies, sp->id);
	if (!nf) {
		nf = nt_create(NULL, NULL);
		om_set(s, &s->notifies, sp->id, nf);
	}
	nt_key path[2];
	size_t len = 1;
	int names = 0;
	if (sp->part == PL_VALUE) path[0] = (nt_key){NT_STR_KEY, 0, "value", 0, 0};
	else if (sp->part == PL_INFO) {
		path[0] = (nt_key){NT_STR_KEY, 0, "info", 0, 0};
		path[1] = (nt_key){NT_STR_KEY, 0, sp->name, 0, 0};
		len = 2;
	} else {
		path[0] = (nt_key){NT_STR_KEY, 0, "children", 0, 0};
		if (sp->name) path[1] = (nt_key){NT_STR_KEY, 0, sp->name, 0, 0}, len = 2;
		else names = 1;
	}
	nt_options o = {0};
	o.deep = !names;
	sp->watch = nt_open(nf, path, len, &o);
	nt_on(sp->watch, on_fire, sp);
}

static sc_spot *spot(sc_sched *s, const char *id, pl_part part) {
	const char *key = spot_key(s, id, part);
	sc_spot *sp = om_get(&s->spots, key);
	if (sp) return sp;
	sp = amem(s, sizeof *sp);
	sp->kind = 1;
	sp->id = sc_dup(s, id);
	sp->part = part.kind;
	sp->name = part.name ? sc_dup(s, part.name) : NULL;
	sp->key = key;
	sp->s = s;
	sp->track = tg_node_new(sp);
	if (!sp->track) die("out of memory");
	vpush(s, &s->trackers, sp->track);
	om_set(s, &s->spots, key, sp);
	vec *of = om_get(&s->spots_of, sp->id);
	if (!of) {
		of = amem(s, sizeof *of);
		om_set(s, &s->spots_of, sp->id, of);
	}
	vpush(s, of, sp);
	watch(s, sp);
	return sp;
}

static void mark(sc_sched *s, sc_proc *q, const sc_change *change, sc_cause *causes);

// readers of a spot: marked by the change being told
static void fire(sc_sched *s, sc_spot *sp) {
	if (!s->telling) return;
	size_t n;
	tg_link *const *rs = tg_readers(sp->track, &n);
	vec copy = {0};
	for (size_t i = 0; i < n; i++)
		if (rs[i]) vpush(s, &copy, rs[i]->from);
	for (size_t i = 0; i < copy.n; i++) {
		tg_node *from = copy.v[i];
		int *kind = from->owner;
		if (*kind != 0) continue;
		sc_proc *q = from->owner;
		if (q->state != RUNNING || q == s->telling->own) continue;
		mark(s, q, s->telling->by, s->telling->causes);
	}
}
static void on_fire(nt_kind kind, void *user) {
	(void)kind;
	sc_spot *sp = user;
	fire(sp->s, sp);
}

static size_t object_len(const nd_node *n, int w, const char *name) {
	if (w == 0) return n->value.length;
	size_t cnt = w == 1 ? n->info_length : n->children_length;
	const nd_entry *es = w == 1 ? n->info : n->children;
	for (size_t i = 0; i < cnt; i++)
		if (!strcmp(es[i].name, name)) return es[i].object.length;
	return 0;
}

static sc_change *with_where(sc_sched *s, const sc_change *c, const char *node, const char *which) {
	sc_change *x = amem(s, sizeof *x);
	*x = *c;
	x->node = node;
	x->has_which = 1;
	x->which = which;
	return x;
}

static nt_value *nulls(size_t n) {
	nt_value *l = nt_list();
	for (size_t i = 0; i < n; i++) nt_push(l, nt_null());
	return l;
}

// a whole object of a node, from how many versions it had to what it has now
static void tell_whole(sc_sched *s, nd_node *n, int w, const char *name, size_t old_len,
	const sc_change *hdr) {
	static const char *const kinds[] = {"value", "info", "children"};
	s->telling->by = with_where(s, hdr, n->id, kinds[w]);
	size_t now = object_len(n, w, name);
	if (old_len == 0 && now == 0) return;
	nt_notify *nf = om_get(&s->notifies, n->id);
	if (!nf) return;
	nt_value *before = nt_map(), *info = nt_map(), *children = nt_map();
	nt_set(before, "value", nulls(w == 0 ? old_len : 0));
	if (w == 1 && old_len) nt_set(info, name, nulls(old_len));
	if (w == 2 && old_len) nt_set(children, name, nulls(old_len));
	nt_set(before, "info", info);
	nt_set(before, "children", children);
	nt_key path[2] = {{NT_STR_KEY, 0, kinds[w], 0, 0}, {NT_STR_KEY, 0, name, 0, 0}};
	nt_patch p = {0};
	p.place.path = path;
	p.place.length = w == 0 ? 1 : 2;
	nt_value *val = now ? nulls(now) : NULL;
	if (now) p.has_value = 1, p.value = val;
	nt_patched(nf, &p, before);
	nt_free(val);
	nt_free(before);
}

// an operation making changes: by whom, then notify told, the readers marked
typedef struct {
	nd_node *n;
	const char *id;
	int w;
	const char *name;
	size_t old_len;
	int hdr; // which of the changes made it was by; -1: the last
} target;
typedef struct {
	acting_t mine;
	acting_t *saved;
	size_t start;
	target t[2];
	size_t nt;
	sc_cause *causes;
	sc_proc *own;
	sc_run *run;
} chg;

static void chg_begin(sc_sched *s, chg *c, const acting_t *who, sc_cause *causes, sc_proc *own,
	sc_run *run) {
	memset(c, 0, sizeof *c);
	c->mine = *who;
	c->saved = s->acting;
	s->acting = &c->mine;
	c->start = s->made.n;
	c->causes = causes;
	c->own = own;
	c->run = run;
}
static void chg_target(sc_sched *s, chg *c, const char *id, int w, const char *name, int hdr) {
	target *t = &c->t[c->nt++];
	t->id = id;
	t->w = w;
	t->name = name;
	t->hdr = hdr;
	t->n = om_get(&s->table, id);
	t->old_len = t->n ? object_len(t->n, w, name) : 0;
}
static void chg_end(sc_sched *s, chg *c, int ok) {
	s->acting = c->saved;
	if (!ok) {
		s->made.n = c->start;
		return;
	}
	size_t count = s->made.n - c->start;
	sc_change **mine = (sc_change **)&s->made.v[c->start];
	const sc_change *header = count ? mine[count - 1] : NULL;
	sc_change none = {0};
	none.time = *s->clock;
	telling_t t = {header ? header : &none, c->causes, c->own};
	telling_t *was = s->telling;
	s->telling = &t;
	for (size_t i = 0; i < c->nt; i++) {
		target *tg = &c->t[i];
		nd_node *n = om_get(&s->table, tg->id);
		if (!n || !header) continue;
		const sc_change *h = tg->hdr >= 0 && (size_t)tg->hdr < count ? mine[tg->hdr] : header;
		tell_whole(s, n, tg->w, tg->name, tg->old_len, h);
	}
	s->telling = was;
	if (c->run) {
		for (size_t i = 0; i < count; i++) {
			int64_t *tm = amem(s, sizeof *tm);
			*tm = mine[i]->time;
			vpush(s, &c->run->wrote, tm);
		}
	}
	s->made.n = c->start;
}

// loading: a node in, or out, which kills the process it was

static void loaded(sc_sched *s, const char *id, const sc_change *change) {
	sc_spot *sp = om_get(&s->spots, spot_key(s, id, (pl_part){PL_LOADED, NULL}));
	if (!sp) return;
	telling_t t = {change, NULL, NULL};
	telling_t *was = s->telling;
	s->telling = &t;
	fire(s, sp);
	s->telling = was;
}

static sc_change *who_change(sc_sched *s, const acting_t *who, int64_t time, const char *node,
	const char *which) {
	sc_change *c = amem(s, sizeof *c);
	c->time = time;
	c->actor = who->actor;
	c->reader = who->reader;
	c->cause = who->cause;
	c->node = node;
	c->has_which = 1;
	c->which = which;
	return c;
}

// a node made now is loaded by its making's change
static const sc_error *intro_at(sc_sched *s, nd_node *node, const acting_t *who, int64_t time) {
	nd_node *there = om_get(&s->table, node->id);
	if (there && there != node) return lib_error(s, "already-there", node->id);
	om_set(s, &s->table, node->id, node);
	vec *of = om_get(&s->spots_of, node->id);
	if (of)
		for (size_t i = 0; i < of->n; i++) watch(s, of->v[i]);
	loaded(s, node->id, who_change(s, who, time, node->id, "loaded"));
	return NULL;
}

// protect: asked as the actor, before each operation not the scheduler's own. the policy's own
// reads are the asker's: tracked when it is

typedef struct {
	sc_sched *s;
	const pl_depend *d;
} policy;

static void depend(const pl_depend *d, const char *id, pl_kind kind, const char *name) {
	if (d) d->fn(d->ctx, id, (pl_part){kind, name});
}

static int policy_get(void *ctx, const char *id, const pr_value **value) {
	policy *p = ctx;
	depend(p->d, id, PL_LOADED, NULL);
	nd_node *n = om_get(&p->s->table, id);
	if (!n) return 0;
	depend(p->d, id, PL_VALUE, NULL);
	*value = NULL;
	if (n->value.length) {
		pr_value *v = pr_alloc(&p->s->pra, sizeof *v);
		*v = to_pr(p->s, n->value.versions[0].content);
		*value = v;
	}
	return 1;
}

typedef struct {
	pr_ask *v;
	size_t n, cap;
} asks_t;

static void asks_add(sc_sched *s, asks_t *a, pr_ask x) {
	if (a->n == a->cap) {
		size_t cap = a->cap ? a->cap * 2 : 8;
		pr_ask *nv = pr_alloc(&s->pra, cap * sizeof *nv);
		if (a->n) memcpy(nv, a->v, a->n * sizeof *nv);
		a->v = nv;
		a->cap = cap;
	}
	a->v[a->n++] = x;
}
static void asks_addall(sc_sched *s, asks_t *a, pr_asks x) {
	for (size_t i = 0; i < x.n; i++) asks_add(s, a, x.items[i]);
}

// an object of a node: "value", ["info", name], ["children", name]
typedef struct {
	const char *kind; // NULL: none
	const char *name;
} obj;
static const obj NO_OBJ = {NULL, NULL};
static const obj VALUE_OBJ = {"value", NULL};

static pr_value obj_pr(sc_sched *s, obj o) {
	if (!o.name) return pr_lit(o.kind);
	pr_value l = pr_list();
	pr_push(&s->pra, &l, pr_lit(o.kind));
	pr_push(&s->pra, &l, pr_lit(o.name));
	return l;
}
static pr_ask read_ask(sc_sched *s, const char *node, obj o) {
	pr_value args = pr_map();
	pr_put(&s->pra, &args, "node", pr_lit(node));
	pr_put(&s->pra, &args, "object", obj_pr(s, o));
	return (pr_ask){"read", args};
}
static pr_asks route_asks(sc_sched *s, const pl_step *route, size_t n) {
	pr_step *st = pr_alloc(&s->pra, (n ? n : 1) * sizeof *st);
	for (size_t i = 0; i < n; i++) st[i] = (pr_step){route[i].node, route[i].name};
	return pr_pass(&s->pra, st, n);
}

static pr_answer ask(sc_sched *s, const sc_agent *agent, const pr_ask *asks, size_t n,
	const pl_depend *d) {
	if (s->may.fn == pr_anyone.fn) return (pr_answer){PR_YES, {0}};
	pr_value *actor = pr_alloc(&s->pra, sizeof *actor);
	*actor = agent_pr(s, agent);
	policy p = {s, d};
	pr_read rd = {policy_get, &p};
	return pr_check(&s->may, &s->pra, actor, asks, n, &rd).answer;
}

static const sc_error *allowed(sc_sched *s, pr_answer a, const char *op) {
	if (a.kind == PR_YES) return NULL;
	const pr_value *why;
	static const pr_value pending_code = {0};
	pr_value *w = pr_alloc(&s->pra, sizeof *w);
	if (a.kind == PR_NO) why = &a.why;
	else {
		*w = pr_map();
		pr_put(&s->pra, w, "code", pr_lit("pending"));
		why = w;
	}
	(void)pending_code;
	pr_value *keep = pr_alloc(&s->pra, sizeof *keep);
	*keep = *why;
	const pr_value *code = pr_get(keep, "code");
	const char *c = code && code->kind == PR_STR ? code->str : "";
	size_t mn = strlen(op) + strlen(c) + 3;
	char *m = amem(s, mn);
	snprintf(m, mn, "%s: %s", op, c);
	sc_error *e = (sc_error *)fail(s, "refused", m);
	e->why = keep;
	return e;
}

// items as the actor may have them: passing each step of its route, and reading the object read;
// refused: no node, and why; pending: no node
static void guard(sc_sched *s, const sc_agent *agent, const pl_items *in, const pl_depend *d,
	obj object, sc_items *out) {
	out->n = in->n;
	out->items = amem(s, (in->n ? in->n : 1) * sizeof *out->items);
	for (size_t i = 0; i < in->n; i++) {
		const pl_item *it = &in->items[i];
		sc_item *o = &out->items[i];
		o->it = *it;
		if (s->may.fn == pr_anyone.fn) continue;
		asks_t asks = {0};
		asks_addall(s, &asks, route_asks(s, it->route, it->nroute));
		if (it->node && object.kind) asks_add(s, &asks, read_ask(s, it->id, object));
		pr_answer a = ask(s, agent, asks.v, asks.n, d);
		if (a.kind == PR_YES) continue;
		o->it.node = NULL;
		o->it.has_versions = 0;
		o->it.versions = NULL;
		o->it.nversions = 0;
		if (a.kind == PR_NO) {
			pr_value *w = pr_alloc(&s->pra, sizeof *w);
			*w = a.why;
			o->refused = w;
		}
	}
}

static pr_value ids_pr(sc_sched *s, const nd_list *l) {
	pr_value out = pr_list();
	if (l)
		for (size_t i = 0; i < l->length; i++)
			if (l->items[i].id) pr_push(&s->pra, &out, pr_lit(l->items[i].id));
	return out;
}

// the ids at a version of a node's list
static const nd_list *ids_at(sc_sched *s, const char *id, const char *name, pl_span slot,
	int has_slot) {
	nd_node *n = om_get(&s->table, id);
	if (!n) return NULL;
	long at = has_slot ? slot.from : 0;
	for (size_t i = 0; i < n->children_length; i++)
		if (!strcmp(n->children[i].name, name)) {
			const nd_object *o = &n->children[i].object;
			if (at >= 0 && (size_t)at < o->length) return o->versions[at].content;
		}
	return NULL;
}

static pr_value at_pr(sc_sched *s, const pl_span *sp) {
	(void)s;
	if (!sp) return pr_num(0);
	if (sp->to == sp->from + 1) return pr_num((double)sp->from);
	pr_value l = pr_list();
	pr_push(&s->pra, &l, pr_num((double)sp->from));
	pr_push(&s->pra, &l, pr_num((double)sp->to));
	return l;
}

// placing an id: and reading it, where its node is loaded (reads: for the ids placed)
static asks_t placing_asks(sc_sched *s, const char *node, const char *name, pr_value before,
	pr_value after, int reads) {
	asks_t out = {0};
	pr_asks placing = pr_placing(&s->pra, node, name, &before, &after);
	asks_addall(s, &out, placing);
	for (size_t i = 0; reads && i < placing.n; i++) {
		if (strcmp(placing.items[i].op, "place")) continue;
		const pr_value *id = pr_get(&placing.items[i].args, "id");
		nd_node *n = id ? om_get(&s->table, id->str) : NULL;
		if (!n) continue;
		const char **info = pr_alloc(&s->pra, (n->info_length + 1) * sizeof *info);
		const char **ch = pr_alloc(&s->pra, (n->children_length + 1) * sizeof *ch);
		for (size_t k = 0; k < n->info_length; k++) info[k] = n->info[k].name;
		for (size_t k = 0; k < n->children_length; k++) ch[k] = n->children[k].name;
		asks_addall(s, &out,
			pr_read_asks(&s->pra, n->id, n->value.length ? 1 : 0, info, n->info_length, ch,
				n->children_length));
	}
	return out;
}

// causes and loops

static sc_cause *cause_new(sc_sched *s, const char *id, sc_cause **parents, size_t n) {
	sc_cause *c = amem(s, sizeof *c);
	c->id = id;
	c->parents = parents;
	c->n = n;
	return c;
}
// the causes from c down, each once
static void cause_walk(sc_sched *s, sc_cause *c, vec *seen) {
	vpush(s, seen, c);
	for (size_t i = 0; i < seen->n; i++) {
		sc_cause *x = seen->v[i];
		for (size_t k = 0; k < x->n; k++)
			if (vfind(seen, x->parents[k]) < 0) vpush(s, seen, x->parents[k]);
	}
}
static int caused(sc_sched *s, sc_cause *c, const char *id) {
	if (!c || !om_has(&s->ran, id)) return 0;
	vec seen = {0};
	cause_walk(s, c, &seen);
	for (size_t i = 0; i < seen.n; i++)
		if (!strcmp(((sc_cause *)seen.v[i])->id, id)) return 1;
	return 0;
}
static int cmp_str(const void *a, const void *b) { return strcmp(*(const char *const *)a, *(const char *const *)b); }
static void ids_of(sc_sched *s, sc_cause *c, vec *out) {
	vec seen = {0};
	cause_walk(s, c, &seen);
	for (size_t i = 0; i < seen.n; i++) sadd(s, out, ((sc_cause *)seen.v[i])->id);
	if (out->n) qsort(out->v, out->n, sizeof *out->v, cmp_str);
}

// rank, kept: made again only where what some process is after changed

static void name_add(sc_sched *s, const char *id, int d) {
	long *n = om_get(&s->named, id);
	long v = (n ? *n : 0) + d;
	if (v > 0) {
		if (!n) {
			n = amem(s, sizeof *n);
			om_set(s, &s->named, sc_dup(s, id), n);
		}
		*n = v;
	} else om_del(&s->named, id);
}
static sc_proc *proc_of(sc_sched *s, const char *id) { return om_get(&s->procs, id); }
static int edge(sc_proc *p, sc_proc *q) { return q && q != p && q->state == RUNNING; }
static void started_rank(sc_sched *s, sc_proc *p) {
	if (om_has(&s->named, p->id)) s->rank_valid = 0;
	else if (s->rank_valid) p->rank = 0;
}
static void sees(sc_sched *s, sc_proc *p, const vec *next) {
	for (size_t i = 0; i < p->values.n; i++) {
		const char *id = p->values.v[i];
		if (sfind(next, id) >= 0) continue;
		name_add(s, id, -1);
		if (edge(p, proc_of(s, id))) s->rank_valid = 0;
	}
	for (size_t i = 0; i < next->n; i++) {
		const char *id = next->v[i];
		if (sfind(&p->values, id) >= 0) continue;
		name_add(s, id, 1);
		if (edge(p, proc_of(s, id))) s->rank_valid = 0;
	}
	p->values = *next;
}
static void waits(sc_sched *s, sc_proc *p, sc_proc *q) {
	if (p->after == q) return;
	if (p->after) {
		name_add(s, p->after->id, -1);
		if (edge(p, p->after)) s->rank_valid = 0;
	}
	p->after = q;
	if (q) {
		name_add(s, q->id, 1);
		if (edge(p, q)) s->rank_valid = 0;
	}
}

// bookkeeping at a process's node: its value behind its status, in front

// the status a process's node shows, as a version in front of its value
static void write_status(sc_sched *s, sc_proc *p, nt_value *status, long n, sc_cause *causes,
	int force) {
	if (p->state != RUNNING) return;
	nd_node *node = om_get(&s->table, p->id);
	if (!node) return;
	int had = p->status->count > 0, has = status->count > 0;
	if (!force && !had && !has) return;
	const sc_agent *agent = agent_of(s, p, n > 0 ? n : 0, status, NULL, 0);
	acting_t who = {agent, p->id, NULL};
	chg c;
	chg_begin(s, &c, &who, causes, p, NULL);
	chg_target(s, &c, p->id, 0, NULL, -1);
	sc_change *change = by_node(s, p->id);
	nd_version v = {status, change, sc_status_because};
	size_t len = node->value.length;
	nd_version *vs;
	size_t count;
	if (!had && has) {
		vs = amem(s, (len + 1) * sizeof *vs);
		vs[0] = v;
		if (len) memcpy(vs + 1, node->value.versions, len * sizeof *vs);
		count = len + 1;
	} else if (had && has) {
		vs = amem(s, (len ? len : 1) * sizeof *vs);
		if (len) memcpy(vs, node->value.versions, len * sizeof *vs);
		vs[0] = v;
		count = len ? len : 1;
	} else if (had && !has) {
		vs = amem(s, (len ? len : 1) * sizeof *vs);
		if (len > 1) memcpy(vs, node->value.versions + 1, (len - 1) * sizeof *vs);
		count = len ? len - 1 : 0;
	} else {
		vs = amem(s, (len ? len : 1) * sizeof *vs);
		for (size_t i = 0; i < len; i++) {
			vs[i] = node->value.versions[i];
			vs[i].change = change;
		}
		count = len;
	}
	node->value = (nd_object){vs, count};
	chg_end(s, &c, 1);
	p->status = status;
}

static void write_value(sc_sched *s, sc_proc *p, const nt_value *value, nt_value *status,
	sc_run *run) {
	nd_node *node = om_get(&s->table, p->id);
	if (p->state != RUNNING || !node) return;
	p->has_last = 1;
	p->last = value;
	int had = p->status->count > 0;
	const sc_agent *agent = agent_of(s, p, run->n, status, NULL, 0);
	size_t at = had ? 1 : 0;
	acting_t who = {agent, p->id, NULL};
	chg c;
	chg_begin(s, &c, &who, run->causes, p, NULL);
	chg_target(s, &c, p->id, 0, NULL, -1);
	sc_change *change = by_node(s, p->id);
	size_t len = node->value.length;
	size_t count = len > at ? len : at + 1;
	nd_version *vs = amem(s, count * sizeof *vs);
	if (len) memcpy(vs, node->value.versions, len * sizeof *vs);
	vs[at] = (nd_version){value, change, NULL};
	node->value = (nd_object){vs, count};
	chg_end(s, &c, 1);
	if (!same_status(status, p->status)) write_status(s, p, status, run->n, run->causes, 0);
}

static void pending_at(sc_sched *s, sc_proc *p) {
	int64_t *d = om_get(&s->due, p->id);
	int64_t since = p->has_since ? p->since : (d ? *d : 0);
	// {...p.status, pending}: pending keeps its place if it was there
	nt_value *st = nt_map();
	int put = 0;
	for (size_t i = 0; i < p->status->count; i++) {
		if (!strcmp(p->status->keys[i], "pending")) {
			nt_set(st, "pending", nt_num((double)since));
			put = 1;
		} else nt_set(st, p->status->keys[i], p->status->items[i]);
	}
	if (!put) nt_set(st, "pending", nt_num((double)since));
	if (!same_status(st, p->status)) write_status(s, p, st, p->runs, NULL, 0);
}

// a node made, as the acting one: loaded, not yet placed
static const sc_error *make_node(sc_sched *s, const char *id, const nt_value *value,
	const acting_t *who, int has, const char **out) {
	int64_t time = *s->clock + 1;
	const char *pid = id;
	if (!pid) {
		const char *base = s->fresh ? s->fresh(s->fresh_ctx, time) : NULL;
		if (!base) {
			char b[32];
			snprintf(b, sizeof b, "@%lld", (long long)time);
			base = sc_dup(s, b);
		}
		pid = base;
		for (int k = 1; om_get(&s->table, pid); k++) {
			size_t bn = strlen(base) + 24;
			char *b = amem(s, bn);
			snprintf(b, bn, "%s-%d", base, k);
			pid = b;
		}
	} else pid = sc_dup(s, pid);
	int64_t t = tick(s);
	sc_change *change = who_change(s, who, t, pid, NULL);
	change->has_which = 0;
	nd_node *node = amem(s, sizeof *node);
	node->id = pid;
	if (has) {
		nd_version *v = amem(s, sizeof *v);
		*v = (nd_version){value, change, NULL};
		node->value = (nd_object){v, 1};
	}
	node->header.has_time = 1;
	node->header.time = t;
	node->header.actor = who->actor;
	node->header.reader = who->reader;
	node->header.cause = who->cause;
	const sc_error *e = intro_at(s, node, who, t);
	if (e) return e;
	*out = pid;
	return NULL;
}

// order

static void after_of(sc_sched *s, sc_proc *p, vec *out) {
	for (size_t i = 0; i < p->values.n; i++) {
		const char *id = p->values.v[i];
		sc_proc *q = proc_of(s, id);
		if (strcmp(id, p->id) && q && q->state == RUNNING) sadd(s, out, id);
	}
	if (p->after && p->after != p && p->after->state == RUNNING) sadd(s, out, p->after->id);
	if (out->n) qsort(out->v, out->n, sizeof *out->v, cmp_str);
}

static const char *const ENDED[] = {"done", "pending", "failed", "stopped", "parked"};
// the enum's order is done pending failed stopped parked; sc_ended names them differently
static const char *ended_name(sc_ended e) {
	switch (e) {
	case SC_DONE: return "done";
	case SC_PENDING: return "pending";
	case SC_FAILED: return "failed";
	case SC_STOPPED: return "stopped";
	default: return "parked";
	}
}

// the latest run, the value of a node named run inside the process
static void write_run(sc_sched *s, sc_proc *p, sc_run *run, sc_ended ended, const sc_error *error) {
	(void)ENDED;
	if (p->state != RUNNING || !om_get(&s->table, p->id)) return;
	nt_value *v = nt_map();
	nt_set(v, "run", nt_num((double)run->n));
	if (p->has_program) {
		nt_value *pg = nt_map();
		nt_set(pg, "node", nt_str(p->prog_node));
		nt_set(pg, "time", nt_num((double)p->prog_time));
		nt_set(v, "program", pg);
	} else nt_set(v, "program", nt_null());
	nt_value *by = nt_list();
	for (size_t i = 0; i < run->given.n; i++)
		nt_push(by, nt_num((double)((sc_kept *)run->given.v[i])->by->time));
	nt_set(v, "by", by);
	nt_value *reads = nt_list();
	for (size_t i = 0; i < run->reads.n; i++) {
		sc_read *r = run->reads.v[i];
		nt_value *e = nt_map();
		nt_set(e, "op", nt_str(r->op));
		if (r->has_address) {
			nt_value *ad = nt_list();
			for (size_t k = 0; k < r->naddress; k++) nt_push(ad, nt_str(r->address[k]));
			nt_set(e, "address", ad);
		}
		if (r->name) nt_set(e, "name", nt_str(r->name));
		nt_set(e, "tracked", nt_bool(r->tracked));
		nt_value *ts = nt_list();
		for (size_t k = 0; k < r->ntimes; k++) nt_push(ts, nt_num((double)r->times[k]));
		nt_set(e, "times", ts);
		nt_push(reads, e);
	}
	nt_set(v, "reads", reads);
	nt_value *wrote = nt_list();
	for (size_t i = 0; i < run->wrote.n; i++) nt_push(wrote, nt_num((double)*(int64_t *)run->wrote.v[i]));
	nt_set(v, "wrote", wrote);
	nt_set(v, "rank", nt_num((double)run->rank));
	nt_set(v, "ended", nt_str(ended_name(ended)));
	vec af = {0};
	after_of(s, p, &af);
	nt_value *after = nt_list();
	for (size_t i = 0; i < af.n; i++) nt_push(after, nt_str(af.v[i]));
	nt_set(v, "after", after);
	if (ended == SC_STOPPED && run->stopped) nt_set(v, "waits", nt_str(run->stopped->id));
	if (run->has_equal) nt_set(v, "equal", nt_bool(run->equal));
	if (error) nt_set(v, "error", error_value(error));
	const sc_agent *agent = agent_of(s, p, run->n, p->status, NULL, 0);
	acting_t who = {agent, p->id, NULL};
	nd_node *there = p->run ? om_get(&s->table, p->run) : NULL;
	chg c;
	if (there) {
		chg_begin(s, &c, &who, run->causes, p, NULL);
		chg_target(s, &c, there->id, 0, NULL, -1);
		sc_change *change = by_node(s, there->id);
		nt_key none;
		nt_patch patch = {0};
		patch.place.path = &none;
		patch.place.length = 0;
		patch.has_value = 1;
		patch.value = v;
		mu_alloc al = {places_alloc, s};
		size_t failed;
		int code = mu_mutate(there, (mu_which){MU_VALUE, NULL}, &patch, 1, change, &al, NULL, &failed);
		chg_end(s, &c, code == MU_OK);
		return;
	}
	const char *id;
	make_node(s, NULL, v, &who, 1, &id);
	om_set(s, &s->ephemeral, id, (void *)1);
	p->run = id;
	om_set(s, &s->runs, id, p);
	chg_begin(s, &c, &who, run->causes, p, NULL);
	chg_target(s, &c, p->id, 2, "run", -1);
	int64_t t;
	const void *ch;
	(void)t;
	int code = pl_insert(&s->places, p->id, "run", id, NULL, NULL, &ch);
	chg_end(s, &c, code == PL_OK);
}

// marks

static void becomes(sc_sched *s, sc_proc *q, int64_t time) {
	if (om_has(&s->due, q->id)) return;
	int64_t *t = amem(s, sizeof *t);
	*t = time;
	om_set(s, &s->due, q->id, t);
	if (!q->has_since) q->has_since = 1, q->since = time;
	sc_moment m = {.kind = SC_DUE, .id = q->id, .by = time};
	pass(s, &m);
}

static sc_kept *kept_find(sc_proc *q, int64_t time) {
	for (size_t i = 0; i < q->kept.n; i++)
		if (((sc_kept *)q->kept.v[i])->by->time == time) return q->kept.v[i];
	return NULL;
}

static void mark(sc_sched *s, sc_proc *q, const sc_change *change, sc_cause *causes) {
	if (!kept_find(q, change->time)) {
		sc_kept *k = amem(s, sizeof *k);
		k->by = change;
		k->causes = causes;
		vpush(s, &q->kept, k);
		if (causes) vpush(s, &s->stamped, k);
	}
	int loop = caused(s, causes, q->id);
	q->has_looping = 0;
	if (loop) {
		q->has_looping = 1;
		q->looping = (vec){0};
		ids_of(s, causes, &q->looping);
	}
	if (q->parked) {
		if (loop) return;
		q->parked = 0;
	}
	becomes(s, q, change->time);
}

// reads

// items of process nodes that are due: a compute's read stops, unless that process waits after
// it; otherwise their pending is written first
static void reached(sc_sched *s, const sc_items *items, vec *out) {
	for (size_t i = 0; i < items->n; i++) {
		const sc_item *it = &items->items[i];
		sc_proc *q = proc_of(s, it->it.id);
		if (q && it->it.node && om_has(&s->due, q->id) && vfind(out, q) < 0) vpush(s, out, q);
	}
}

static int waits_after(sc_sched *s, sc_proc *q, sc_proc *r) {
	vec seen = {0};
	for (sc_proc *x = q->after; x && vfind(&seen, x) < 0; x = x->after) {
		if (x == r) return 1;
		vpush(s, &seen, x);
	}
	return 0;
}

// the times of the changes that set what a read got
static void add_time(sc_sched *s, int64_t **ts, size_t *n, const sc_change *c) {
	if (!c) return;
	for (size_t i = 0; i < *n; i++)
		if ((*ts)[i] == c->time) return;
	*ts = realloc(*ts, (*n + 1) * sizeof **ts);
	if (!*ts) die("out of memory");
	(*ts)[(*n)++] = c->time;
	(void)s;
}
static void times_of(sc_sched *s, const sc_items *items, sc_read *r) {
	int64_t *ts = NULL;
	size_t n = 0;
	for (size_t i = 0; i < items->n; i++) {
		const pl_item *it = &items->items[i].it;
		if (it->has_versions)
			for (size_t k = 0; k < it->nversions; k++) add_time(s, &ts, &n, it->versions[k].change);
		if (it->nroute) {
			const pl_step *st = &it->route[it->nroute - 1];
			nd_node *node = om_get(&s->table, st->node);
			if (node)
				for (size_t k = 0; k < node->children_length; k++)
					if (!strcmp(node->children[k].name, st->name)) {
						const nd_object *o = &node->children[k].object;
						if (o->length) add_time(s, &ts, &n, o->versions[0].change);
					}
		}
	}
	r->times = amem(s, (n ? n : 1) * sizeof *ts);
	if (n) memcpy(r->times, ts, n * sizeof *ts);
	r->ntimes = n;
	free(ts);
}

enum { R_LOOK, R_LOOKUP, R_LOOKUPS, R_CHILDREN, R_CONTENT, R_INFO };
static const char *const OPS[] = {"look", "lookup", "lookups", "children", "content", "info"};
typedef struct {
	int op;
	const char *const *address;
	size_t n;
	const char *name;
} rargs;
typedef struct {
	sc_items items;
	pl_namelist names;
	int is_names;
} rres;

static void dep_track(void *ctx, const char *id, pl_part part) {
	sc_api *a = ctx;
	sc_spot *sp = spot(a->s, id, part);
	if (tg_track(a->proc->track, sp->track) != 0) die("out of memory");
}

static pl_spot place_of(sc_api *a) { return (pl_spot){a->place, a->nplace, 0, NULL, 0}; }

// a read: guard over places
static const sc_error *do_read(sc_api *a, const rargs *r, const pl_depend *d, rres *out) {
	sc_sched *s = a->s;
	pl_spot at = place_of(a);
	pl_items pit = {0};
	int code = PL_OK;
	obj object = NO_OBJ;
	out->is_names = 0;
	memset(&out->items, 0, sizeof out->items);
	switch (r->op) {
	case R_LOOK: code = pl_look(&s->places, &at, r->address, r->n, d, &pit); break;
	case R_LOOKUP: code = pl_lookup(&s->places, &at, r->address, r->n, d, &pit); break;
	case R_LOOKUPS: code = pl_lookups(&s->places, &at, r->address, r->n, d, &pit); break;
	case R_CONTENT:
		code = pl_content(&s->places, &at, r->address, r->n, d, &pit);
		object = VALUE_OBJ;
		break;
	case R_INFO:
		code = pl_info(&s->places, &at, r->address, r->n, r->name, d, &pit);
		object = (obj){"info", r->name};
		break;
	default:
		if (r->name) {
			code = pl_children(&s->places, &at, r->address, r->n, r->name, d, &pit);
			break;
		}
		code = pl_look(&s->places, &at, r->address, r->n, d, &pit);
		if (code) return pl_error(s, code, NULL);
		sc_items g;
		guard(s, a->agent, &pit, d, NO_OBJ, &g);
		vec seen = {0};
		for (size_t i = 0; i < g.n; i++) {
			const pl_item *it = &g.items[i].it;
			if (!it->node) continue;
			pr_ask la = pr_list_ask(&s->pra, it->id);
			if (ask(s, a->agent, &la, 1, d).kind != PR_YES) continue;
			depend(d, it->id, PL_CHILDREN, NULL);
			for (size_t k = 0; k < it->node->children_length; k++)
				sadd(s, &seen, it->node->children[k].name);
		}
		out->is_names = 1;
		out->names.n = seen.n;
		out->names.names = (const char *const *)(void *)seen.v;
		return NULL;
	}
	if (code) return pl_error(s, code, NULL);
	guard(s, a->agent, &pit, d, object, &out->items);
	return NULL;
}

static const sc_error *live_check(sc_api *a, const char *op) {
	if (a->alive && !*a->alive) {
		char m[64];
		snprintf(m, sizeof m, "%s: this interface has stopped", op);
		return fail(a->s, "stopped", sc_dup(a->s, m));
	}
	return NULL;
}

// a read: as ctx's process, tracked when given a depend; the hooks and the run see it
static const sc_error *reading(sc_api *a, const rargs *r, rres *out) {
	sc_sched *s = a->s;
	pl_depend dd = {dep_track, a};
	const pl_depend *d = a->tracked ? &dd : NULL;
	const sc_error *e = do_read(a, r, d, out);
	if (e) return e;
	sc_items first = out->is_names ? (sc_items){0} : out->items;
	vec due = {0};
	if (r->op != R_CHILDREN) reached(s, &first, &due);
	sc_ctx *ctx = a->ctx;
	if (due.n) {
		if (ctx && ctx->compute && ctx->run) {
			for (size_t i = 0; i < due.n; i++) {
				sc_proc *q = due.v[i];
				if (q != ctx->p && !waits_after(s, q, ctx->p)) {
					ctx->run->stopped = q;
					return &STOP_ERR;
				}
			}
		}
		int64_t before = *s->clock;
		for (size_t i = 0; i < due.n; i++) pending_at(s, due.v[i]);
		if (*s->clock != before) {
			e = do_read(a, r, NULL, out);
			if (e) return e;
		}
	}
	if (ctx) {
		sc_moment m = {.kind = SC_READS, .id = ctx->p->id, .op = OPS[r->op], .tracked = a->tracked};
		if (ctx->run_n > 0) m.has_run = 1, m.run = ctx->run_n;
		m.handler = ctx->handler;
		m.cleanup = ctx->cleanup;
		pass(s, &m);
		sc_run *run = ctx->run;
		if (run) {
			sc_read *rd = amem(s, sizeof *rd);
			rd->op = OPS[r->op];
			rd->tracked = a->tracked;
			if (!out->is_names) times_of(s, &out->items, rd);
			if (r->address) {
				const char **ad = amem(s, (r->n ? r->n : 1) * sizeof *ad);
				for (size_t i = 0; i < r->n; i++) ad[i] = sc_dup(s, r->address[i]);
				rd->has_address = 1, rd->address = ad, rd->naddress = r->n;
			}
			rd->name = r->name ? sc_dup(s, r->name) : NULL;
			vpush(s, &run->reads, rd);
			if (ctx->compute && r->op != R_CHILDREN)
				for (size_t i = 0; i < first.n; i++)
					if (first.items[i].it.node && proc_of(s, first.items[i].it.id))
						sadd(s, &run->values, first.items[i].it.id);
		}
	}
	return NULL;
}

static const sc_error *api_read(sc_api *a, int op, const char *const *address, size_t n,
	const char *name, rres *out) {
	const sc_error *e = live_check(a, OPS[op]);
	if (e) return e;
	static const char *const empty[1] = {NULL};
	rargs r = {op, address ? address : empty, n, name};
	return reading(a, &r, out);
}

const sc_error *sc_look(sc_api *a, const char *const *address, size_t n, sc_items *out) {
	rres r;
	const sc_error *e = api_read(a, R_LOOK, address, n, NULL, &r);
	if (!e) *out = r.items;
	return e;
}
const sc_error *sc_lookup(sc_api *a, const char *const *path, size_t n, sc_items *out) {
	rres r;
	const sc_error *e = api_read(a, R_LOOKUP, path, n, NULL, &r);
	if (!e) *out = r.items;
	return e;
}
const sc_error *sc_lookups(sc_api *a, const char *const *path, size_t n, sc_items *out) {
	rres r;
	const sc_error *e = api_read(a, R_LOOKUPS, path, n, NULL, &r);
	if (!e) *out = r.items;
	return e;
}
const sc_error *sc_names(sc_api *a, const char *const *address, size_t n, pl_namelist *out) {
	rres r;
	const sc_error *e = api_read(a, R_CHILDREN, address, n, NULL, &r);
	if (!e) *out = r.names;
	return e;
}
const sc_error *sc_children(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out) {
	rres r;
	const sc_error *e = api_read(a, R_CHILDREN, address, n, name, &r);
	if (!e) *out = r.items;
	return e;
}
const sc_error *sc_content(sc_api *a, const char *const *address, size_t n, sc_items *out) {
	rres r;
	const sc_error *e = api_read(a, R_CONTENT, address, n, NULL, &r);
	if (!e) *out = r.items;
	return e;
}
const sc_error *sc_info(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out) {
	rres r;
	const sc_error *e = api_read(a, R_INFO, address, n, name, &r);
	if (!e) *out = r.items;
	return e;
}

// requests and rounds: declared here, below

typedef const sc_error *(*req_fn)(void *);
static const sc_error *request(sc_sched *s, req_fn fn, void *ctx);

// writes

static int never_name(const char *s) { return !strcmp(s, ".") || !strcmp(s, "..") || strchr(s, '/'); }

enum { W_WRITE, W_SET, W_INSERT, W_REMOVE, W_POP, W_RENAME, W_MOVE, W_CREATE };
static const char *const WOPS[] = {"write", "set", "insert", "remove", "pop", "rename", "move",
	"create"};
typedef struct {
	sc_api *a;
	int op;
	const char *const *address;
	size_t n;
	const char *name;
	const nt_patch *patches;
	size_t np;
	const long *index;
	const pl_span *ispan;
	const pl_span *slot;
	const char *id, *child, *to, *toid, *toname;
	pl_span span;
	long mindex;
	const long *toindex;
	const nt_value *value;
	int has_value;
	int ephemeral;
	int64_t times[2];
	size_t ntimes;
	const char *out;
} wop;

static const sc_error *mu_error(sc_sched *s, int code, size_t patch) {
	char m[64];
	snprintf(m, sizeof m, "%s (patch %zu)", mu_code_name(code), patch);
	return sc_error_new(s, mu_code_name(code), sc_dup(s, m), 0);
}

// patches to the version from of one object of n; the versions from to to replaced by what they
// make, at from: one change. no versions: slots 0 makes the first
static const sc_error *edit_object(sc_sched *s, nd_node *n, int w, const char *name,
	const pl_span *slots, const nt_patch *patches, size_t np, sc_change **change) {
	const nd_entry *entry = NULL;
	nd_object cur = {0};
	if (w == 0) cur = n->value;
	else {
		for (size_t i = 0; i < n->info_length; i++)
			if (!strcmp(n->info[i].name, name)) entry = &n->info[i];
		if (entry) cur = entry->object;
	}
	long from = slots ? slots->from : 0, to = slots ? slots->to : 1;
	size_t len = cur.length;
	int ok = len == 0 ? (from == 0 && to <= 1) : (from < to && (size_t)to <= len);
	if (!ok || from < 0) return lib_error(s, "range", n->id);
	nd_version base[1];
	size_t nbase = len ? 1 : 0;
	if (nbase) base[0] = cur.versions[from];
	nd_node scratch = {0};
	scratch.id = n->id;
	nd_entry se[1];
	if (w == 0) scratch.value = (nd_object){nbase ? base : NULL, nbase};
	else if (nbase) {
		se[0] = (nd_entry){name, {base, 1}};
		scratch.info = se;
		scratch.info_length = 1;
	}
	sc_change *ch = by_node(s, n->id);
	mu_alloc al = {places_alloc, s};
	size_t failed = 0;
	int code = mu_mutate(&scratch, (mu_which){w == 0 ? MU_VALUE : MU_INFO, name}, patches, np, ch,
		&al, NULL, &failed);
	if (code) return mu_error(s, code, failed);
	nd_object made = {0};
	if (w == 0) made = scratch.value;
	else
		for (size_t i = 0; i < scratch.info_length; i++)
			if (!strcmp(scratch.info[i].name, name)) made = scratch.info[i].object;
	size_t after = len > (size_t)to ? len - (size_t)to : 0;
	size_t total = (size_t)from + made.length + after;
	nd_version *vs = amem(s, (total ? total : 1) * sizeof *vs);
	if (from) memcpy(vs, cur.versions, (size_t)from * sizeof *vs);
	if (made.length) memcpy(vs + from, made.versions, made.length * sizeof *vs);
	if (after) memcpy(vs + from + made.length, cur.versions + to, after * sizeof *vs);
	if (w == 0) n->value = (nd_object){vs, total};
	else {
		// the entry set, or added, or gone
		size_t at = entry ? (size_t)(entry - n->info) : n->info_length;
		size_t cnt = n->info_length + (entry == NULL) - (total == 0);
		nd_entry *es = amem(s, (cnt ? cnt : 1) * sizeof *es);
		size_t m = 0;
		for (size_t j = 0; j < n->info_length; j++) {
			if (j != at) es[m++] = n->info[j];
			else if (total) es[m++] = (nd_entry){n->info[j].name, {vs, total}};
		}
		if (!entry && total) es[m++] = (nd_entry){sc_dup(s, name), {vs, total}};
		n->info = es;
		n->info_length = m;
	}
	*change = ch;
	return NULL;
}

// the item the index-th look gives, default its first loaded
static const sc_error *at_item(sc_api *a, const char *const *address, size_t n, const long *index,
	nd_node **out) {
	sc_sched *s = a->s;
	pl_spot at = place_of(a);
	pl_items items;
	int code = pl_look(&s->places, &at, address, n, NULL, &items);
	if (code) return pl_error(s, code, NULL);
	const pl_item *it = NULL;
	if (!index) {
		for (size_t i = 0; i < items.n && !it; i++)
			if (items.items[i].node) it = &items.items[i];
	} else {
		if (*index < 0 || (size_t)*index >= items.n) return lib_error(s, "range", NULL);
		it = &items.items[*index];
	}
	if (!it || !it->node) return lib_error(s, "nothing-there", it ? it->id : NULL);
	*out = (nd_node *)it->node;
	return NULL;
}

static const sc_error *wop_run(void *p) {
	wop *o = p;
	sc_api *a = o->a;
	sc_sched *s = a->s;
	acting_t who = {a->agent, a->reader, a->ctx ? a->ctx->cause : NULL};
	if (o->op == W_CREATE) {
		const char *id;
		const sc_error *e = make_node(s, o->id, o->value, &who, o->has_value, &id);
		if (e) return e;
		o->out = id;
		return NULL;
	}
	chg c;
	chg_begin(s, &c, &who, a->ctx ? a->ctx->causes : NULL, NULL, a->ctx ? a->ctx->run : NULL);
	const sc_error *e = NULL;
	int code = PL_OK;
	const void *changes[2] = {0};
	size_t nch = 1;
	switch (o->op) {
	case W_WRITE:
	case W_SET: {
		nd_node *n;
		if (o->op == W_SET && never_name(o->name)) {
			e = pl_error(s, PL_WRONG_FIELD, NULL);
			break;
		}
		e = at_item(a, o->address, o->n, o->index, &n);
		if (e) break;
		int w = o->op == W_WRITE ? 0 : 1;
		chg_target(s, &c, n->id, w, o->name, -1);
		sc_change *ch;
		e = edit_object(s, n, w, o->name, o->slot, o->patches, o->np, &ch);
		if (!e) changes[0] = ch;
		break;
	}
	case W_INSERT:
		chg_target(s, &c, o->id, 2, o->name, -1);
		code = pl_insert(&s->places, o->id, o->name, o->child, o->ispan, o->slot, &changes[0]);
		break;
	case W_REMOVE:
		chg_target(s, &c, o->id, 2, o->name, -1);
		code = pl_remove(&s->places, o->id, o->name, o->span, o->slot, &changes[0]);
		break;
	case W_POP:
		chg_target(s, &c, o->id, 2, o->name, -1);
		code = pl_pop(&s->places, o->id, o->name, o->span, &changes[0]);
		break;
	case W_RENAME:
		chg_target(s, &c, o->id, 2, o->name, -1);
		chg_target(s, &c, o->id, 2, o->to, -1);
		code = pl_rename(&s->places, o->id, o->name, o->to, changes);
		nch = 2;
		break;
	case W_MOVE:
		chg_target(s, &c, o->id, 2, o->name, 0);
		if (strcmp(o->id, o->toid) || strcmp(o->name, o->toname))
			chg_target(s, &c, o->toid, 2, o->toname, 1);
		code = pl_move(&s->places, o->id, o->name, o->mindex, o->toid, o->toname, o->toindex, changes,
			&nch);
		break;
	}
	if (!e && code) e = pl_error(s, code, o->id);
	chg_end(s, &c, e == NULL);
	if (e) return e;
	o->ntimes = nch;
	for (size_t i = 0; i < nch && i < 2; i++) o->times[i] = ((const sc_change *)changes[i])->time;
	return NULL;
}

// the asks of an operation: what reaching a node to write it asks, passing its route, then the edit
static asks_t writing_asks(sc_api *a, const char *const *address, size_t n, const long *index,
	obj object, const pl_span *slot) {
	sc_sched *s = a->s;
	asks_t out = {0};
	pl_spot at = place_of(a);
	pl_items items;
	if (pl_look(&s->places, &at, address, n, NULL, &items) != PL_OK) return out;
	const pl_item *it = NULL;
	if (!index) {
		for (size_t i = 0; i < items.n && !it; i++)
			if (items.items[i].node) it = &items.items[i];
	} else if (*index >= 0 && (size_t)*index < items.n) it = &items.items[*index];
	if (!it || !it->node) return out;
	asks_addall(s, &out, route_asks(s, it->route, it->nroute));
	pr_value ov = obj_pr(s, object), av = at_pr(s, slot);
	asks_add(s, &out, pr_edit(&s->pra, "write", it->id, &ov, &av));
	return out;
}

static const sc_error *may_place(sc_api *a, const char *child) {
	if (child && om_has(&a->s->ephemeral, child) && !a->owner)
		return fail(a->s, "not-a-process", "only a process makes, places or moves an ephemeral node");
	return NULL;
}

// a write: stopped, read only, asked, then a request making the changes
static const sc_error *w_do(sc_api *a, wop *o, asks_t *asks) {
	sc_sched *s = a->s;
	const sc_error *e = live_check(a, WOPS[o->op]);
	if (e) return e;
	if (!a->writes) {
		char m[64];
		snprintf(m, sizeof m, "%s: a compute only reads", WOPS[o->op]);
		return fail(s, "read-only", sc_dup(s, m));
	}
	if (asks) {
		e = allowed(s, ask(s, a->agent, asks->v, asks->n, NULL), WOPS[o->op]);
		if (e) return e;
	}
	o->a = a;
	return request(s, wop_run, o);
}

const sc_error *sc_write(sc_api *a, const char *const *address, size_t n, const nt_patch *patches,
	size_t np, const long *index, const pl_span *slotindex, int64_t *time) {
	wop o = {.op = W_WRITE, .address = address, .n = n, .patches = patches, .np = np, .index = index,
		.slot = slotindex};
	asks_t as = writing_asks(a, address, n, index, VALUE_OBJ, slotindex);
	const sc_error *e = w_do(a, &o, &as);
	if (!e && time) *time = o.times[0];
	return e;
}
const sc_error *sc_set(sc_api *a, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex,
	int64_t *time) {
	wop o = {.op = W_SET, .address = address, .n = n, .name = name, .patches = patches, .np = np,
		.index = index, .slot = slotindex};
	asks_t as = writing_asks(a, address, n, index, (obj){"info", name}, slotindex);
	const sc_error *e = w_do(a, &o, &as);
	if (!e && time) *time = o.times[0];
	return e;
}
const sc_error *sc_insert(sc_api *a, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time) {
	const sc_error *e = may_place(a, child);
	if (e) return e;
	wop o = {.op = W_INSERT, .id = id, .name = name, .child = child, .ispan = index,
		.slot = slotindex};
	nd_item it = {child, NULL};
	nd_list after = {&it, 1};
	asks_t as = placing_asks(a->s, id, name, pr_list(), ids_pr(a->s, &after), 1);
	e = w_do(a, &o, &as);
	if (!e && time) *time = o.times[0];
	return e;
}
const sc_error *sc_remove(sc_api *a, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time) {
	wop o = {.op = W_REMOVE, .id = id, .name = name, .span = index, .slot = slotindex};
	const nd_list *ids = ids_at(a->s, id, name, slotindex ? *slotindex : (pl_span){0, 1}, slotindex != NULL);
	size_t lo = (size_t)index.from, hi = (size_t)index.to;
	nd_list slice = {NULL, 0};
	if (ids && lo <= hi) {
		slice.items = ids->items + (lo < ids->length ? lo : ids->length);
		slice.length = (hi < ids->length ? hi : ids->length) - (lo < ids->length ? lo : ids->length);
	}
	asks_t as = placing_asks(a->s, id, name, ids_pr(a->s, &slice), pr_list(), 0);
	const sc_error *e = w_do(a, &o, &as);
	if (!e && time) *time = o.times[0];
	return e;
}
const sc_error *sc_pop(sc_api *a, const char *id, const char *name, pl_span slotindex,
	int64_t *time) {
	wop o = {.op = W_POP, .id = id, .name = name, .span = slotindex};
	asks_t as = {0};
	pr_value ov = obj_pr(a->s, (obj){"children", name}), av = at_pr(a->s, &slotindex);
	asks_add(a->s, &as, pr_edit(&a->s->pra, "pop", id, &ov, &av));
	const sc_error *e = w_do(a, &o, &as);
	if (!e && time) *time = o.times[0];
	return e;
}
const sc_error *sc_rename(sc_api *a, const char *id, const char *name, const char *to,
	int64_t times[2]) {
	wop o = {.op = W_RENAME, .id = id, .name = name, .to = to};
	const nd_list *ids = ids_at(a->s, id, name, (pl_span){0, 1}, 0);
	asks_t as = placing_asks(a->s, id, name, ids_pr(a->s, ids), pr_list(), 0);
	asks_t b = placing_asks(a->s, id, to, pr_list(), ids_pr(a->s, ids), 1);
	for (size_t i = 0; i < b.n; i++) asks_add(a->s, &as, b.v[i]);
	const sc_error *e = w_do(a, &o, &as);
	if (!e) times[0] = o.times[0], times[1] = o.times[1];
	return e;
}
const sc_error *sc_move(sc_api *a, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, int64_t times[2], size_t *ntimes) {
	sc_sched *s = a->s;
	const char *child = NULL;
	const nd_list *ids = ids_at(s, id, name, (pl_span){0, 1}, 0);
	if (ids && index >= 0 && (size_t)index < ids->length) child = ids->items[index].id;
	const sc_error *e = may_place(a, child);
	if (e) return e;
	int across = strcmp(id, toid) || strcmp(name, toname);
	wop o = {.op = W_MOVE, .id = id, .name = name, .mindex = index, .toid = toid, .toname = toname,
		.toindex = toindex};
	asks_t as = {0};
	if (across) {
		nd_item it = {child, NULL};
		nd_list one = {&it, child ? 1 : 0};
		asks_t x = placing_asks(s, id, name, ids_pr(s, &one), pr_list(), 0);
		asks_t y = placing_asks(s, toid, toname, pr_list(), ids_pr(s, &one), 1);
		for (size_t i = 0; i < x.n; i++) asks_add(s, &as, x.v[i]);
		for (size_t i = 0; i < y.n; i++) asks_add(s, &as, y.v[i]);
	}
	e = w_do(a, &o, &as);
	if (!e) times[0] = o.times[0], times[1] = o.times[1], *ntimes = o.ntimes;
	return e;
}

static void owns(sc_sched *s, sc_proc *p, const char *id) {
	om_set(s, &s->owners, id, p);
	vpush(s, &p->owned, (void *)id);
}

const sc_error *sc_create(sc_api *a, const nt_value *value, const char *id, int ephemeral,
	const char **out) {
	sc_sched *s = a->s;
	const sc_error *e = live_check(a, "create");
	if (e) return e;
	if (!a->writes) return fail(s, "read-only", "create: a compute only reads");
	if (ephemeral && !a->owner) return fail(s, "not-a-process", "only a process makes an ephemeral node");
	wop o = {.a = a, .op = W_CREATE, .id = id, .value = value, .has_value = value != NULL};
	e = request(s, wop_run, &o);
	if (e) return e;
	if (ephemeral) {
		om_set(s, &s->ephemeral, o.out, (void *)1);
		owns(s, a->proc, o.out);
	}
	*out = o.out;
	return NULL;
}

// the interface handed to code, at a place, as an actor; it stops when alive says so
static sc_api *process_api(sc_sched *s, sc_ctx *ctx, int tracked, int writes, int *alive) {
	sc_api *a = amem(s, sizeof *a);
	sc_proc *p = ctx->p;
	a->s = s;
	a->ctx = ctx;
	a->place = p->place;
	a->nplace = p->nplace;
	a->agent = ctx->agent;
	a->reader = p->id;
	a->tracked = tracked;
	a->proc = p;
	a->writes = writes;
	a->alive = alive;
	a->owner = 1;
	return a;
}

sc_api *sc_host(sc_sched *s) { return &s->host; }

// starting

static const char *const *absolute(sc_sched *s, const char *const *place, size_t np,
	const char *const *address, size_t na, size_t *out) {
	const char **names = amem(s, (np + na + 1) * sizeof *names);
	size_t n = 0, i = 0;
	if (na && !strcmp(address[0], "/")) i = 1;
	else
		for (; n < np; n++) names[n] = place[n];
	for (; i < na && !strcmp(address[i], ".."); i++)
		if (n) n--;
	for (; i < na; i++) names[n++] = address[i];
	*out = n;
	return names;
}

static const sc_error *replacing(sc_sched *s, sc_proc *p, const sc_agent *actor, const char *reader,
	sc_cause *causes) {
	nt_value *st = nt_map();
	for (size_t i = 0; i < p->status->count; i++)
		if (strcmp(p->status->keys[i], "new")) nt_set(st, p->status->keys[i], p->status->items[i]);
	write_status(s, p, st, p->runs, causes, 1);
	p->replaced = 1;
	p->replacements++;
	acting_t who = {actor, reader, NULL};
	sc_change *c = who_change(s, &who, *s->clock, p->id, "value");
	mark(s, p, c, causes);
	return NULL;
}

static sc_partcall *partcall(sc_sched *s, sc_proc *p, const char *name, int replaced) {
	sc_partcall *c = amem(s, sizeof *c);
	c->part = name;
	c->replaced = replaced;
	for (size_t i = 0; i < p->children.n; i++) {
		sc_child *ch = p->children.v[i];
		if (!strcmp(ch->part, name)) vpush(s, &c->before, ch);
	}
	return c;
}

static int is_code(const sc_code *c) { return c->setup || c->compute; }

static const sc_error *start_(sc_sched *s, const sc_startop *op, sc_ctx *ctx, const char **idout) {
	if (!op->address) return fail(s, "wrong-field", "address");
	if (!op->has_path && !is_code(&op->code))
		return fail(s, "wrong-field", "a program is a path or code");
	if (op->has_path && !s->finder)
		return fail(s, "wrong-field", "a program by path needs the host's code");
	sc_proc *caller = ctx ? ctx->p : NULL;
	sc_partcall *call = ctx ? ctx->call : NULL;
	if (call && op->name) {
		for (size_t i = 0; i < call->before.n; i++) {
			sc_child *child = call->before.v[i];
			if (strcmp(child->name, op->name) || vfind(&call->matched, child) >= 0 ||
				child->proc->state != RUNNING || !om_get(&s->table, child->proc->id))
				continue;
			vpush(s, &call->matched, child);
			if (op->has_path) {
				child->proc->has_path = 1;
				child->proc->path = op->path;
				child->proc->npath = op->npath;
			} else child->proc->has_code = 1, child->proc->code = op->code;
			if (call->replaced && child->replaced < caller->replacements) {
				child->replaced = caller->replacements;
				replacing(s, child->proc, ctx->agent, caller->id, ctx->causes);
			}
			*idout = child->proc->id;
			return NULL;
		}
	}
	const char *const *place = caller ? caller->place : op->place;
	size_t nplace = caller ? caller->nplace : op->nplace;
	pl_spot at = {place, nplace, 0, NULL, 0};
	pl_items items;
	int code = pl_look(&s->places, &at, op->address, op->naddress, NULL, &items);
	if (code) return pl_error(s, code, NULL);
	const pl_item *where = NULL;
	for (size_t i = 0; i < items.n && !where; i++)
		if (items.items[i].node) where = &items.items[i];
	if (!where) return fail(s, "nothing-there", "the address reaches nothing");
	acting_t who = {ctx ? ctx->agent : s->host_actor, caller ? caller->id : NULL, ctx ? ctx->cause : NULL};
	{
		asks_t as = {0};
		asks_addall(s, &as, route_asks(s, where->route, where->nroute));
		pr_value args = pr_map();
		pr_put(&s->pra, &args, "node", pr_lit(where->id));
		if (op->name) pr_put(&s->pra, &args, "name", pr_lit(op->name));
		if (op->id) pr_put(&s->pra, &args, "id", pr_lit(op->id));
		asks_add(s, &as, (pr_ask){"place", args});
		const sc_error *e = allowed(s, ask(s, who.actor, as.v, as.n, NULL), "start");
		if (e) return e;
	}
	const char *pid;
	const sc_error *e = make_node(s, op->id, nt_null(), &who, 1, &pid);
	if (e) return e;
	om_set(s, &s->ephemeral, pid, (void *)1);
	const sc_agent *agent = who.actor;
	sc_proc *p = amem(s, sizeof *p);
	p->id = pid;
	p->name = op->name ? sc_dup(s, op->name) : pid;
	p->place = absolute(s, place, nplace, op->address, op->naddress, &p->nplace);
	p->base = *agent;
	p->base.code = NULL;
	p->base.ncode = 0;
	p->base.has_person = 0;
	p->base.has_trusted = 0;
	p->prefix = agent->code;
	p->nprefix = agent->ncode;
	p->started = *s->clock;
	p->status = nt_map();
	p->equal = op->equal;
	p->track = tg_node_new(p);
	if (!p->track) die("out of memory");
	vpush(s, &s->trackers, p->track);
	if (op->has_path) {
		const char **path = amem(s, (op->npath + 1) * sizeof *path);
		for (size_t i = 0; i < op->npath; i++) path[i] = sc_dup(s, op->path[i]);
		p->has_path = 1;
		p->path = path;
		p->npath = op->npath;
	} else {
		p->has_code = 1;
		p->code = op->code;
		if (caller && caller->has_program) {
			p->has_program = 1;
			p->prog_node = caller->prog_node;
			p->prog_time = caller->prog_time;
		}
	}
	om_set(s, &s->procs, p->id, p);
	started_rank(s, p);
	if (caller && caller->state != GONE) {
		p->parent = caller;
		sc_child *ch = amem(s, sizeof *ch);
		ch->proc = p;
		ch->name = p->name;
		ch->part = call ? call->part : "request";
		ch->replaced = caller->replacements;
		vpush(s, &caller->children, ch);
		owns(s, caller, pid);
	}
	// its arguments: nodes inside it, its own
	if (op->args && op->args->type == NT_MAP) {
		for (size_t i = 0; i < op->args->count; i++) {
			const char *id;
			e = make_node(s, NULL, op->args->items[i], &who, 1, &id);
			if (e) return e;
			om_set(s, &s->ephemeral, id, (void *)1);
			owns(s, p, id);
			chg c;
			chg_begin(s, &c, &who, ctx ? ctx->causes : NULL, NULL, NULL);
			chg_target(s, &c, pid, 2, op->args->keys[i], -1);
			const void *ch;
			code = pl_insert(&s->places, pid, sc_dup(s, op->args->keys[i]), id, NULL, NULL, &ch);
			chg_end(s, &c, code == PL_OK);
			if (code) return pl_error(s, code, pid);
		}
	}
	chg c;
	chg_begin(s, &c, &who, ctx ? ctx->causes : NULL, NULL, ctx ? ctx->run : NULL);
	chg_target(s, &c, where->id, 2, p->name, -1);
	const void *ch;
	code = pl_insert(&s->places, where->id, p->name, pid, NULL, NULL, &ch);
	chg_end(s, &c, code == PL_OK);
	if (code) return pl_error(s, code, where->id);
	const sc_change *change = ch;
	sc_kept *mine = amem(s, sizeof *mine);
	mine->by = with_where(s, change, change->node, "children");
	mine->causes = ctx ? ctx->causes : NULL;
	vpush(s, &p->kept, mine);
	if (mine->causes) vpush(s, &s->stamped, mine);
	becomes(s, p, change->time);
	*idout = pid;
	return NULL;
}

// parts

typedef struct {
	const sc_error *error;
	nt_value *value;
	int pending;
} pout;

static void unwind(sc_sched *s);

static pout part_call(sc_sched *s, sc_proc *p, sc_fn *f, sc_given *g) {
	pout o = {0};
	p->busy++;
	s->active++;
	o.error = f->call(f, g, &o.value, &o.pending);
	p->busy--;
	s->active--;
	unwind(s);
	return o;
}

// release and end: below
static void release(sc_sched *s, const char *id, const sc_change *cause);
static void end(sc_sched *s, sc_proc *p, const sc_change *cause);

// handler calls

typedef struct qitem {
	const char *const *address;
	size_t naddress;
	nt_value *args;
	const char *const *place;
	size_t nplace;
	const sc_agent *agent;
	sc_cause *causes;
} qitem;

static void *g_new(sc_sched *s, sc_ctx *ctx, int *alive) {
	sc_gctx *g = amem(s, sizeof *g);
	g->p = ctx->p;
	g->alive = alive;
	g->ctx = ctx;
	return g;
}

static sc_given *given_new(sc_sched *s, sc_ctx *ctx, int *alive) {
	sc_given *g = amem(s, sizeof *g);
	g->s = s;
	g->ctx = g_new(s, ctx, alive);
	g->self = ctx->p->id;
	g->name = ctx->p->name;
	return g;
}

static const sc_error *calling(sc_sched *s, const qitem *op, nt_value **out) {
	*out = NULL;
	pl_spot at = {op->place, op->nplace, 0, NULL, 0};
	pl_items items;
	int code = pl_look(&s->places, &at, op->address, op->naddress, NULL, &items);
	if (code) return pl_error(s, code, NULL);
	const pl_item *item = NULL;
	for (size_t i = 0; i < items.n && !item; i++)
		if (items.items[i].node) item = &items.items[i];
	if (!item) return fail(s, "nothing-there", "the address reaches nothing");
	{
		asks_t as = {0};
		asks_addall(s, &as, route_asks(s, item->route, item->nroute));
		asks_add(s, &as, read_ask(s, item->id, VALUE_OBJ));
		const sc_error *e = allowed(s, ask(s, op->agent, as.v, as.n, NULL), "call");
		if (e) return e;
	}
	sc_proc *definer = om_get(&s->owners, item->id);
	const nt_value *fv = item->node->value.length ? item->node->value.versions[0].content : NULL;
	sc_fn *f = sc_live_fn(fv);
	if (!om_has(&s->ephemeral, item->id) || !definer || definer->state != RUNNING || !f)
		return fail(s, "not-a-handler", "the node is not a handler a process placed");
	const char *handler = op->naddress ? op->address[op->naddress - 1] : "";
	sc_agent *agent = amem(s, sizeof *agent);
	*agent = *op->agent;
	sc_step *code2 = amem(s, (op->agent->ncode + 1) * sizeof *code2);
	if (op->agent->ncode) memcpy(code2, op->agent->code, op->agent->ncode * sizeof *code2);
	sc_step *st = &code2[op->agent->ncode];
	st->process = definer->id;
	if (definer->has_program) st->prog_node = definer->prog_node, st->prog_time = definer->prog_time;
	st->handler = handler;
	agent->code = code2;
	agent->ncode = op->agent->ncode + 1;
	sc_ctx *ctx = amem(s, sizeof *ctx);
	ctx->p = definer;
	ctx->agent = agent;
	ctx->handler = handler;
	ctx->causes = op->causes;
	sc_moment m = {.kind = SC_STARTS, .id = definer->id, .handler = handler};
	pass(s, &m);
	int *alive = amem(s, sizeof *alive);
	*alive = 1;
	sc_given *g = given_new(s, ctx, alive);
	g->api = process_api(s, ctx, 0, 1, alive);
	g->args = op->args;
	pout done = part_call(s, definer, f, g);
	*alive = 0;
	sc_moment ends = {.kind = SC_ENDS, .id = definer->id, .handler = handler,
		.ended = done.error ? SC_FAILED : SC_DONE};
	ends.error = done.error;
	pass(s, &ends);
	if (done.error) return done.error;
	*out = done.value;
	return NULL;
}

static qitem *qitem_new(sc_sched *s, const char *const *address, size_t n, nt_value *args,
	const char *const *place, size_t np, const sc_agent *agent, sc_cause *causes) {
	qitem *q = amem(s, sizeof *q);
	const char **ad = amem(s, (n + 1) * sizeof *ad);
	for (size_t i = 0; i < n; i++) ad[i] = sc_dup(s, address[i]);
	const char **pl = amem(s, (np + 1) * sizeof *pl);
	for (size_t i = 0; i < np; i++) pl[i] = sc_dup(s, place[i]);
	q->address = ad;
	q->naddress = n;
	q->args = args;
	q->place = pl;
	q->nplace = np;
	q->agent = agent;
	q->causes = causes;
	return q;
}

static void queue_push(sc_sched *s, qitem *q) {
	if (s->nqueue == s->qcap) {
		size_t cap = s->qcap ? s->qcap * 2 : 8;
		qitem **nq = amem(s, cap * sizeof *nq);
		if (s->nqueue) memcpy(nq, s->queue, s->nqueue * sizeof *nq);
		s->queue = (struct qitem *)(void *)nq;
		s->qcap = cap;
	}
	((qitem **)(void *)s->queue)[s->nqueue++] = q;
}

typedef struct {
	sc_sched *s;
	const qitem *q;
	nt_value *out;
} callreq;
static const sc_error *call_run(void *p) {
	callreq *c = p;
	return calling(c->s, c->q, &c->out);
}

const sc_error *sc_given_start(sc_given *g, const sc_startop *op, const char **id) {
	sc_gctx *gc = g->ctx;
	sc_sched *s = g->s;
	if (!*gc->alive) return fail(s, "stopped", "start: this interface has stopped");
	sc_startop o = *op;
	o.place = NULL;
	o.nplace = 0;
	return start_(s, &o, gc->ctx, id);
}

const sc_error *sc_given_call(sc_given *g, const char *const *address, size_t naddress,
	const nt_value *args, nt_value **out) {
	sc_gctx *gc = g->ctx;
	sc_sched *s = g->s;
	sc_ctx *ctx = gc->ctx;
	*out = NULL;
	if (ctx->p->state == GONE) return fail(s, "stopped", "call: the process is gone");
	qitem *q = qitem_new(s, address, naddress, (nt_value *)args, ctx->p->place, ctx->p->nplace,
		ctx->agent, ctx->causes);
	if (s->in_round || s->active > 0) {
		queue_push(s, q);
		return NULL;
	}
	callreq c = {s, q, NULL};
	const sc_error *e = request(s, call_run, &c);
	*out = c.out;
	return e;
}

const sc_error *sc_given_cleanup(sc_given *g, sc_fn *f) {
	sc_gctx *gc = g->ctx;
	if (!*gc->alive) return fail(g->s, "stopped", "onCleanup: this interface has stopped");
	if (!f) return fail(g->s, "wrong-field", "a cleanup is a function");
	vpush(g->s, &gc->p->cleanups, f);
	return NULL;
}

// the cleanups of a process, newest first: the first error
static const sc_error *cleanups(sc_sched *s, sc_proc *p, int killed, sc_run *run) {
	vec list = p->cleanups;
	p->cleanups = (vec){0};
	const sc_error *first = NULL;
	for (size_t k = list.n; k-- > 0;) {
		sc_fn *f = list.v[k];
		const sc_agent *agent = run ? run_agent(s, p, run->n) : agent_of(s, p, 0, NULL, NULL, 1);
		sc_ctx *ctx = amem(s, sizeof *ctx);
		ctx->p = p;
		ctx->agent = agent;
		if (run) ctx->run_n = run->n;
		else ctx->cleanup = 1;
		ctx->run = run;
		ctx->causes = run ? run->causes : NULL;
		int *alive = amem(s, sizeof *alive);
		*alive = 1;
		sc_given *g = given_new(s, ctx, alive);
		g->api = process_api(s, ctx, 0, 1, alive);
		g->has_killed = 1;
		g->killed = killed;
		pout done = part_call(s, p, f, g);
		*alive = 0;
		if (done.error && !first) first = done.error;
	}
	return first;
}

// killing

static int busy(sc_proc *p) {
	if (p->busy > 0) return 1;
	for (size_t i = 0; i < p->children.n; i++) {
		sc_child *c = p->children.v[i];
		if (c->proc->state == RUNNING && busy(c->proc)) return 1;
	}
	return 0;
}

typedef struct {
	sc_proc *p;
	const sc_change *cause;
} defer;

static sc_change *killing(sc_sched *s, const sc_change *cause, const char *kill, const char *node) {
	sc_change *c = amem(s, sizeof *c);
	*c = *cause;
	c->actor = stepped_kill(s, cause->actor, kill);
	c->time = tick(s);
	c->node = node;
	c->has_which = 1;
	c->which = "loaded";
	return c;
}

// unwinding, newest first: not due; children; cleanups; its ephemeral nodes; untracked
static void end(sc_sched *s, sc_proc *p, const sc_change *cause) {
	if (p->state != RUNNING) return;
	if (busy(p)) {
		defer *d = amem(s, sizeof *d);
		d->p = p;
		d->cause = cause;
		vpush(s, &s->deferred, d);
		return;
	}
	p->state = KILLING;
	if (om_has(&s->named, p->id)) s->rank_valid = 0;
	om_del(&s->due, p->id);
	sc_run *w = p->waiting;
	if (w) {
		long i = vfind(&s->waiting, w);
		if (i >= 0) vdel(&s->waiting, (size_t)i);
		p->waiting = NULL;
		sc_moment m = {.kind = SC_ENDS, .id = p->id, .has_run = 1, .run = w->n, .ended = SC_STOPPED};
		pass(s, &m);
	}
	vec kids = vcopy(s, &p->children);
	for (size_t i = kids.n; i-- > 0;) {
		sc_proc *q = ((sc_child *)kids.v[i])->proc;
		if (q->state != RUNNING) continue;
		release(s, q->id, killing(s, cause, p->id, q->id));
		end(s, q, cause);
	}
	cleanups(s, p, 1, NULL);
	vec owned = vcopy(s, &p->owned);
	for (size_t i = owned.n; i-- > 0;) {
		const char *id = owned.v[i];
		if (om_get(&s->table, id)) release(s, id, killing(s, cause, p->id, id));
	}
	tg_untrack(p->track, NULL);
	p->state = GONE;
	for (size_t i = 0; i < p->values.n; i++) name_add(s, p->values.v[i], -1);
	p->values = (vec){0};
	if (p->after) name_add(s, p->after->id, -1);
	p->after = NULL;
	om_del(&s->procs, p->id);
	if (p->parent) {
		vec *c = &p->parent->children;
		for (size_t i = 0; i < c->n; i++)
			if (((sc_child *)c->v[i])->proc == p) {
				vdel(c, i);
				break;
			}
	}
}

static void unwind(sc_sched *s) {
	for (size_t i = 0; i < s->deferred.n;) {
		defer *d = s->deferred.v[i];
		if (d->p->state != RUNNING) vdel(&s->deferred, i);
		else if (busy(d->p)) i++;
		else {
			vdel(&s->deferred, i);
			end(s, d->p, d->cause);
			i = 0;
		}
	}
}

static void release(sc_sched *s, const char *id, const sc_change *cause) {
	if (!om_get(&s->table, id)) return;
	om_del(&s->table, id);
	nt_notify *nf = om_get(&s->notifies, id);
	if (nf) {
		om_del(&s->notifies, id);
		nt_destroy(nf);
	}
	vec *of = om_get(&s->spots_of, id);
	if (of)
		for (size_t i = 0; i < of->n; i++) ((sc_spot *)of->v[i])->watch = NULL;
	om_del(&s->ephemeral, id);
	sc_proc *owner = om_get(&s->owners, id);
	if (owner) {
		om_del(&s->owners, id);
		for (size_t i = 0; i < owner->owned.n; i++)
			if (!strcmp(owner->owned.v[i], id)) {
				vdel(&owner->owned, i);
				break;
			}
	}
	sc_proc *r = om_get(&s->runs, id);
	if (r) {
		om_del(&s->runs, id);
		r->run = NULL;
	}
	loaded(s, id, cause);
}

// no longer loaded; a process whose node it was, killed; ephemeral nodes it owned, released
static const sc_error *outro_(sc_sched *s, const char *id, const acting_t *who) {
	sc_change *cause = who_change(s, who, tick(s), id, "loaded");
	release(s, id, cause);
	sc_proc *p = proc_of(s, id);
	if (p && p->state == RUNNING) end(s, p, cause);
	return NULL;
}

// runs

static sc_process process_of(sc_proc *p) {
	return (sc_process){p->id, p->name, p->place, p->nplace, p->path, p->npath};
}

// when a part's call ends done, the children it started before and not again are released
static void settle_children(sc_sched *s, sc_ctx *ctx) {
	sc_partcall *call = ctx->call;
	vec before = vcopy(s, &call->before);
	for (size_t i = before.n; i-- > 0;) {
		sc_child *c = before.v[i];
		if (vfind(&call->matched, c) >= 0 || c->proc->state != RUNNING) continue;
		sc_change cause = {0};
		cause.actor = stepped_kill(s, ctx->agent, ctx->p->id);
		cause.reader = ctx->p->id;
		cause.node = "";
		sc_change *k = amem(s, sizeof *k);
		*k = cause;
		k->time = tick(s);
		k->node = c->proc->id;
		k->has_which = 1;
		k->which = "loaded";
		release(s, c->proc->id, k);
		end(s, c->proc, &cause);
	}
}

static int same(sc_proc *p, const nt_value *v) {
	if (!p->has_last) return 0;
	return p->equal ? p->equal(v, p->last) : sc_is(v, p->last);
}

static const char *why_new(const nt_value *v, int given) {
	if (given) return "not equal by its comparison";
	if (v && v->type == NT_LIST) return "a new list";
	if (v && v->type == NT_MAP) return "a new map";
	if (is_live(v)) return "a new live value";
	return "not equal";
}

static nt_value *shown_status(sc_run *run) {
	nt_value *st = nt_map();
	if (run->has_shown) nt_set(st, "new", (nt_value *)run->shown ? (nt_value *)run->shown : nt_null());
	return st;
}

static void finish(sc_sched *s, sc_run *run, sc_ended ended, const sc_error *error, int keep) {
	sc_proc *p = run->p;
	if (p->state == RUNNING) {
		if (ended == SC_DONE && !keep) {
			for (size_t i = 0; i < run->given.n; i++) {
				sc_kept *k = run->given.v[i];
				for (size_t j = 0; j < p->kept.n; j++)
					if (p->kept.v[j] == k || ((sc_kept *)p->kept.v[j])->by->time == k->by->time) {
						vdel(&p->kept, j);
						break;
					}
			}
			p->replaced = 0;
		}
		if (ended == SC_PARKED) p->parked = 1;
		if (ended != SC_STOPPED) sees(s, p, &run->values);
		if (ended != SC_PENDING && ended != SC_STOPPED) {
			int64_t *d = om_get(&s->due, p->id);
			p->has_since = d != NULL;
			if (d) p->since = *d;
		}
		nt_value *status = nt_map();
		if (ended == SC_PENDING || ended == SC_STOPPED)
			nt_set(status, "pending", nt_num((double)(p->has_since ? p->since : run->mark)));
		if (ended == SC_FAILED) nt_set(status, "error", error_value(error));
		if (ended == SC_PARKED) {
			nt_value *loop = nt_map();
			nt_value *through = nt_list();
			if (run->has_looping)
				for (size_t i = 0; i < run->looping.n; i++) nt_push(through, nt_str(run->looping.v[i]));
			else nt_push(through, nt_str(p->id));
			nt_set(loop, "through", through);
			if (!is_live(run->value)) nt_set(loop, "value", (nt_value *)run->value);
			nt_set(status, "loop", loop);
		}
		if (run->has_shown) nt_set(status, "new", (nt_value *)run->shown ? (nt_value *)run->shown : nt_null());
		if (!same_status(status, p->status)) write_status(s, p, status, run->n, run->causes, 0);
		write_run(s, p, run, ended, error);
	}
	sc_moment m = {.kind = SC_ENDS, .id = p->id, .has_run = 1, .run = run->n, .ended = ended};
	if (ended == SC_STOPPED && run->stopped) m.waits = run->stopped->id;
	if (run->has_equal) m.has_equal = 1, m.equal = run->equal;
	m.error = error;
	pass(s, &m);
}

static void stop_run(sc_sched *s, sc_run *run) {
	sc_proc *p = run->p;
	waits(s, p, run->stopped);
	if (p->state == RUNNING) {
		int64_t *t = amem(s, sizeof *t);
		*t = run->mark;
		om_del(&s->due, p->id);
		om_set(s, &s->due, p->id, t);
	}
	finish(s, run, SC_STOPPED, NULL, 0);
}

static const sc_error *value_of(sc_sched *s, const nt_value *v) {
	if (v == NULL) return fail(s, "wrong-field", "value: a part gives a value");
	return NULL;
}

// a compute's value: compared, written, its effect part waiting if new
static void computed(sc_sched *s, sc_run *run, sc_ctx *cctx, nt_value *v) {
	sc_proc *p = run->p;
	const sc_error *e = value_of(s, v);
	if (e) { finish(s, run, SC_FAILED, e, 0); return; }
	settle_children(s, cctx);
	int equals = same(p, v);
	run->has_equal = 1;
	run->equal = equals;
	if (run->has_looping && !equals) {
		run->value = v;
		{ finish(s, run, SC_PARKED, NULL, 0); return; }
	}
	if (!equals) {
		run->why = !p->has_last ? "a first value" : why_new(v, p->equal != NULL);
		write_value(s, p, v, shown_status(run), run);
	}
	if (p->code.effect && (!equals || run->replaced)) {
		if (run->replaced) run->why = "replaced";
		run->part = "effect";
		run->value = v;
		p->waiting = run;
		vpush(s, &s->waiting, run);
		return;
	}
	finish(s, run, SC_DONE, NULL, 0);
}

static long rank_of(sc_sched *s, sc_proc *p);

static void first_body(sc_sched *s, sc_proc *p, sc_run *run, vec *given) {
	sc_ctx *ctx = amem(s, sizeof *ctx);
	ctx->p = p;
	ctx->agent = run_agent(s, p, run->n);
	ctx->run_n = run->n;
	ctx->run = run;
	ctx->compute = 1;
	ctx->causes = run->causes;
	if (p->has_path) {
		int *alive = amem(s, sizeof *alive);
		*alive = 1;
		sc_api *view = process_api(s, ctx, 1, 0, alive);
		sc_process pr = process_of(p);
		sc_found found = {0};
		p->busy++;
		s->active++;
		const sc_error *fe = s->finder(s->finder_ctx, &pr, view, &found);
		p->busy--;
		s->active--;
		unwind(s);
		*alive = 0;
		if (run->stopped) { stop_run(s, run); return; }
		int takes = !p->has_code || p->replaced;
		if (fe) {
			if (takes) { finish(s, run, SC_FAILED, fe, 0); return; }
			run->has_shown = 1;
			run->shown = error_value(fe);
		} else if (found.pending) {
			if (takes) { finish(s, run, SC_PENDING, NULL, 0); return; }
			run->has_shown = 1;
			run->shown = nt_null();
		} else {
			if (takes) {
				p->has_code = 1;
				p->code = found.code;
				p->has_program = 1;
				p->prog_node = found.node;
				p->prog_time = found.time;
			} else if (!p->has_program || strcmp(found.node, p->prog_node) ||
				found.time != p->prog_time) {
				nt_value *pg = nt_map();
				nt_set(pg, "node", nt_str(found.node));
				nt_set(pg, "time", nt_num((double)found.time));
				run->has_shown = 1;
				run->shown = pg;
			}
		}
	}
	if (p->code.setup) {
		if (p->setup && !p->replaced) { finish(s, run, SC_DONE, NULL, 0); return; }
		run->part = "setup";
		p->waiting = run;
		vpush(s, &s->waiting, run);
		return;
	}
	// the compute
	sc_ctx *cctx = amem(s, sizeof *cctx);
	*cctx = *ctx;
	cctx->call = partcall(s, p, "compute", run->replaced);
	int *open = amem(s, sizeof *open);
	*open = 1;
	sc_given *g = given_new(s, cctx, open);
	g->api = process_api(s, cctx, 1, 0, open);
	g->peep = process_api(s, cctx, 0, 0, open);
	g->nby = given->n;
	g->by = amem(s, (given->n + 1) * sizeof *g->by);
	for (size_t i = 0; i < given->n; i++) g->by[i] = ((sc_kept *)given->v[i])->by->time;
	pout out = part_call(s, p, p->code.compute, g);
	*open = 0;
	if (run->stopped) { stop_run(s, run); return; }
	if (out.error) { finish(s, run, SC_FAILED, out.error, 0); return; }
	if (out.pending) { finish(s, run, SC_PENDING, NULL, 0); return; }
	computed(s, run, cctx, out.value);
}

// a run's first half: code, if the program is a path; then a compute runs, and a setup or an
// effect's part waits for the second half
static void first(sc_sched *s, sc_proc *p, long picked) {
	long rank = picked;
	sc_run *earlier = p->waiting;
	if (earlier) {
		long i = vfind(&s->waiting, earlier);
		if (i >= 0) vdel(&s->waiting, (size_t)i);
		p->waiting = NULL;
		finish(s, earlier, SC_DONE, NULL, 1);
		rank = rank_of(s, p);
	}
	int64_t *mt = om_get(&s->due, p->id);
	int64_t mark_time = *mt;
	om_del(&s->due, p->id);
	waits(s, p, NULL);
	long n = ++p->runs;
	vec given = vcopy(s, &p->kept);
	vec parents = {0};
	for (size_t i = 0; i < given.n; i++) {
		sc_kept *k = given.v[i];
		if (k->causes && vfind(&parents, k->causes) < 0) vpush(s, &parents, k->causes);
	}
	sc_cause **ps = amem(s, (parents.n + 1) * sizeof *ps);
	for (size_t i = 0; i < parents.n; i++) ps[i] = parents.v[i];
	sc_cause *causes = cause_new(s, p->id, ps, parents.n);
	om_set(s, &s->ran, p->id, (void *)1);
	sc_run *run = amem(s, sizeof *run);
	run->p = p;
	run->n = n;
	run->mark = mark_time;
	run->rank = rank;
	run->given = given;
	run->causes = causes;
	run->replaced = p->replaced;
	run->has_looping = p->has_looping;
	run->looping = p->looping;
	p->has_looping = 0;
	sc_moment m = {.kind = SC_STARTS, .id = p->id, .has_run = 1, .run = n, .has_rank = 1, .rank = rank};
	pass(s, &m);
	tg_begin(p->track);
	first_body(s, p, run, &given);
	tg_end(p->track);
}

// a run's second half: the cleanups before, then the setup, or the effect part
static void second(sc_sched *s, sc_run *run) {
	sc_proc *p = run->p;
	long wi = vfind(&s->waiting, run);
	if (wi >= 0) vdel(&s->waiting, (size_t)wi);
	p->waiting = NULL;
	if (p->state != RUNNING) return;
	const sc_agent *agent = run_agent(s, p, run->n);
	const sc_error *error = cleanups(s, p, 0, run);
	if (p->state != RUNNING) { finish(s, run, error ? SC_FAILED : SC_DONE, error, 0); return; }
	sc_ctx *ctx = amem(s, sizeof *ctx);
	ctx->p = p;
	ctx->agent = agent;
	ctx->run_n = run->n;
	ctx->run = run;
	ctx->causes = run->causes;
	ctx->call = partcall(s, p, run->part, run->replaced);
	int is_effect = !strcmp(run->part, "effect");
	if (is_effect) ctx->cause = run->why;
	int *alive = amem(s, sizeof *alive);
	*alive = 1;
	sc_given *g = given_new(s, ctx, alive);
	g->api = process_api(s, ctx, 0, 1, alive);
	if (is_effect) {
		g->value = (nt_value *)run->value;
		if (p->has_previous) g->previous = (nt_value *)p->previous;
		pout out = part_call(s, p, p->code.effect, g);
		*alive = 0;
		p->has_previous = 1;
		p->previous = run->value;
		if (out.error) {
			if (!error) error = out.error;
		} else if (p->state == RUNNING) settle_children(s, ctx);
		{ finish(s, run, error ? SC_FAILED : SC_DONE, error, 0); return; }
	}
	pout out = part_call(s, p, p->code.setup, g);
	*alive = 0;
	p->setup = 1;
	if (out.error) { finish(s, run, SC_FAILED, error ? error : out.error, 0); return; }
	const sc_error *e = value_of(s, out.value);
	if (e) { finish(s, run, SC_FAILED, error ? error : e, 0); return; }
	if (p->state != RUNNING) { finish(s, run, error ? SC_FAILED : SC_DONE, error, 0); return; }
	settle_children(s, ctx);
	int equals = same(p, out.value);
	run->has_equal = 1;
	run->equal = equals;
	if (!equals) write_value(s, p, out.value, shown_status(run), run);
	finish(s, run, error ? SC_FAILED : SC_DONE, error, 0);
}

// order: strongly connected components (Tarjan), each after the ones its members are after

static void edges_of(sc_sched *s, sc_proc *p, vec *out) {
	for (size_t i = 0; i < p->values.n; i++) {
		const char *id = p->values.v[i];
		sc_proc *q = strcmp(id, p->id) ? proc_of(s, id) : NULL;
		if (q && q->state == RUNNING) vpush(s, out, q);
	}
	if (p->after && p->after != p && p->after->state == RUNNING) vpush(s, out, p->after);
}

typedef struct {
	long next;
	vec stack;
} tj;

static void visit(sc_sched *s, tj *t, sc_proc *p) {
	p->tj_seen = 1;
	p->tj_index = p->tj_low = t->next++;
	vpush(s, &t->stack, p);
	p->tj_on = 1;
	vec out = {0};
	edges_of(s, p, &out);
	for (size_t i = 0; i < out.n; i++) {
		sc_proc *q = out.v[i];
		if (!q->tj_seen) {
			visit(s, t, q);
			if (q->tj_low < p->tj_low) p->tj_low = q->tj_low;
		} else if (q->tj_on && q->tj_index < p->tj_low) p->tj_low = q->tj_index;
	}
	if (p->tj_low != p->tj_index) return;
	vec members = {0};
	sc_proc *m;
	do {
		m = t->stack.v[--t->stack.n];
		m->tj_on = 0;
		vpush(s, &members, m);
	} while (m != p);
	long r = 0;
	for (size_t i = 0; i < members.n; i++) {
		vec es = {0};
		edges_of(s, members.v[i], &es);
		for (size_t k = 0; k < es.n; k++) {
			sc_proc *q = es.v[k];
			if (vfind(&members, q) < 0 && q->rank + 1 > r) r = q->rank + 1;
		}
	}
	for (size_t i = 0; i < members.n; i++) ((sc_proc *)members.v[i])->rank = r;
}

static void ranks(sc_sched *s) {
	if (s->rank_valid) return;
	tj t = {0};
	for (size_t i = 0; i < s->procs.n; i++) {
		sc_proc *p = s->procs.e[i].key ? s->procs.e[i].val : NULL;
		if (p) p->tj_seen = 0, p->tj_on = 0;
	}
	for (size_t i = 0; i < s->procs.n; i++) {
		sc_proc *p = s->procs.e[i].key ? s->procs.e[i].val : NULL;
		if (p && p->state == RUNNING && !p->tj_seen) visit(s, &t, p);
	}
	s->rank_valid = 1;
}
static long rank_of(sc_sched *s, sc_proc *p) {
	ranks(s);
	return p->rank;
}

static sc_proc *pick(sc_sched *s, long *rank) {
	ranks(s);
	sc_proc *best = NULL;
	int64_t best_mark = 0;
	for (size_t i = 0; i < s->due.n; i++) {
		if (!s->due.e[i].key) continue;
		sc_proc *p = proc_of(s, s->due.e[i].key);
		int64_t m = *(int64_t *)s->due.e[i].val;
		if (p->after && om_has(&s->due, p->after->id)) continue;
		if (!best || p->rank < best->rank ||
			(p->rank == best->rank &&
				(m < best_mark || (m == best_mark && strcmp(p->id, best->id) < 0)))) {
			best = p;
			best_mark = m;
		}
	}
	if (best) *rank = best->rank;
	return best;
}

// requests and rounds

static int round_(sc_sched *s) {
	s->in_round = 1;
	int ok = 1;
	while (s->due.live) {
		long rank = 0;
		sc_proc *p = pick(s, &rank);
		if (!p) {
			ok = 0;
			break;
		}
		first(s, p, rank);
	}
	while (s->waiting.n) second(s, s->waiting.v[0]);
	s->in_round = 0;
	while (s->qhead < s->nqueue) {
		qitem *q = ((qitem **)(void *)s->queue)[s->qhead++];
		nt_value *out;
		calling(s, q, &out);
	}
	s->qhead = s->nqueue = 0;
	return ok;
}

static const sc_error *request(sc_sched *s, req_fn fn, void *ctx) {
	if (s->depth > 0 || s->active > 0) return fn(ctx);
	s->depth++;
	const sc_error *out = fn(ctx);
	if (!out)
		while (s->due.live || s->qhead < s->nqueue)
			if (!round_(s)) break;
	s->depth--;
	vec ids = {0};
	for (size_t i = 0; i < s->due.n; i++)
		if (s->due.e[i].key) vpush(s, &ids, (void *)s->due.e[i].key);
	for (size_t i = 0; i < ids.n; i++) {
		sc_proc *p = proc_of(s, ids.v[i]);
		if (p && p->state == RUNNING) pending_at(s, p);
	}
	for (size_t i = 0; i < s->stamped.n; i++) ((sc_kept *)s->stamped.v[i])->causes = NULL;
	s->stamped.n = 0;
	if (s->qhead >= s->nqueue) {
		for (size_t i = 0; i < s->ran.n; i++) s->ran.e[i].key = NULL;
		s->ran.live = 0;
		s->ran.n = 0;
		memset(s->ran.idx, 0, s->ran.slots * sizeof *s->ran.idx);
	}
	return out;
}

// the host's

typedef struct {
	sc_sched *s;
	nd_node *node;
	const char *id;
	const sc_startop *op;
	const char *out;
} hreq;

static const sc_error *intro_run(void *p) {
	hreq *r = p;
	acting_t who = {r->s->host_actor, NULL, NULL};
	return intro_at(r->s, r->node, &who, tick(r->s));
}
static const sc_error *outro_run(void *p) {
	hreq *r = p;
	acting_t who = {r->s->host_actor, NULL, NULL};
	return outro_(r->s, r->id, &who);
}
static const sc_error *start_run(void *p) {
	hreq *r = p;
	return start_(r->s, r->op, NULL, &r->out);
}

const sc_error *sc_intro(sc_sched *s, nd_node *node) {
	hreq r = {.s = s, .node = node};
	// the id outlives the table
	node->id = sc_dup(s, node->id);
	return request(s, intro_run, &r);
}
const sc_error *sc_outro(sc_sched *s, const char *id) {
	hreq r = {.s = s, .id = id};
	return request(s, outro_run, &r);
}
int sc_ephemeral(sc_sched *s, const char *id) { return om_has(&s->ephemeral, id); }

const sc_error *sc_start(sc_sched *s, const sc_startop *op, const char **id) {
	hreq r = {.s = s, .op = op};
	const sc_error *e = request(s, start_run, &r);
	if (!e && id) *id = r.out;
	return e;
}

const sc_error *sc_call(sc_sched *s, const sc_callop *op, nt_value **out) {
	const sc_agent *agent = op->actor ? op->actor : s->host_actor;
	if (op->person || op->has_trusted) agent = sc_agent_with(s, agent, op->person, op->has_trusted, op->trusted);
	qitem *q = qitem_new(s, op->address, op->naddress, op->args, op->place, op->nplace, agent, NULL);
	*out = NULL;
	if (s->in_round || s->active > 0) {
		queue_push(s, q);
		return NULL;
	}
	callreq c = {s, q, NULL};
	const sc_error *e = request(s, call_run, &c);
	*out = c.out;
	return e;
}

typedef struct {
	sc_sched *s;
	const char *const *address;
	size_t n;
} rep;
static const sc_error *replace_run(void *ctx) {
	rep *r = ctx;
	sc_sched *s = r->s;
	pl_spot at = {NULL, 0, 0, NULL, 0};
	pl_items items;
	int code = pl_look(&s->places, &at, r->address, r->n, NULL, &items);
	if (code) return pl_error(s, code, NULL);
	const pl_item *item = NULL;
	for (size_t i = 0; i < items.n && !item; i++)
		if (items.items[i].node) item = &items.items[i];
	if (!item) return fail(s, "nothing-there", "the address reaches nothing");
	asks_t as = {0};
	asks_addall(s, &as, route_asks(s, item->route, item->nroute));
	pr_value ov = pr_lit("value"), av = pr_num(0);
	asks_add(s, &as, pr_edit(&s->pra, "write", item->id, &ov, &av));
	const sc_error *e = allowed(s, ask(s, s->host_actor, as.v, as.n, NULL), "replace");
	if (e) return e;
	sc_proc *p = proc_of(s, item->id);
	if (!p || p->state != RUNNING) return fail(s, "not-a-process", "the node is no process");
	return replacing(s, p, s->host_actor, NULL, NULL);
}
const sc_error *sc_replace(sc_sched *s, const char *const *address, size_t naddress) {
	rep r = {s, address, naddress};
	return request(s, replace_run, &r);
}

typedef struct {
	const sc_error *(*fn)(void *);
	void *ctx;
	const sc_error *thrown;
} batchreq;
static const sc_error *batch_run(void *p) {
	batchreq *b = p;
	b->thrown = b->fn(b->ctx);
	return NULL;
}
const sc_error *sc_batch(sc_sched *s, const sc_error *(*fn)(void *ctx), void *ctx) {
	batchreq b = {fn, ctx, NULL};
	request(s, batch_run, &b);
	return b.thrown;
}

sc_sched *sc_new(const sc_options *o) {
	sc_sched *s = calloc(1, sizeof *s);
	if (!s) die("out of memory");
	s->own_clock = 0;
	s->clock = o->clock ? o->clock : &s->own_clock;
	s->root = sc_dup(s, o->root);
	s->host_actor = o->actor ? o->actor : sc_agent_of(s, "host");
	if (o->nhooks) {
		s->hooks = amem(s, o->nhooks * sizeof *s->hooks);
		memcpy(s->hooks, o->hooks, o->nhooks * sizeof *s->hooks);
		s->nhooks = o->nhooks;
	}
	s->finder = o->finder;
	s->finder_ctx = o->finder_ctx;
	s->fresh = o->id;
	s->fresh_ctx = o->id_ctx;
	s->may = o->may ? *o->may : pr_anyone;
	s->places = (pl_places){tget, places_alloc, places_by, s, s->root, NULL};
	s->host = (sc_api){.s = s, .agent = s->host_actor, .writes = 1};
	if (!om_get(&s->table, s->root)) {
		nd_node *n = amem(s, sizeof *n);
		n->id = s->root;
		om_set(s, &s->table, s->root, n);
	}
	return s;
}

void sc_free(sc_sched *s) {
	for (size_t i = 0; i < s->trackers.n; i++) tg_untrack(s->trackers.v[i], NULL);
	for (size_t i = 0; i < s->trackers.n; i++) tg_node_free(s->trackers.v[i]);
	for (size_t i = 0; i < s->notifies.n; i++)
		if (s->notifies.e[i].key) nt_destroy(s->notifies.e[i].val);
	pr_free(&s->pra);
	afree(&s->a);
	free(s);
}
