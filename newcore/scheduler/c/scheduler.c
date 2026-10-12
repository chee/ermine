// The scheduler (newcore/scheduler/ts/scheduler.ts), in C. Ported in the same order of operations: the clock
// ticks wherever scheduler.ts's does. Comments say what the reference's say, tersely.
//
// It sits on the graph (graph/c/graph.c) as scheduler.ts on graph.ts: the graph reads, writes,
// places, tracks and tells, and calls back when a change reached what a process read (marked), an
// ephemeral node is owned (owned) or a node goes (released). What is the scheduler's: processes,
// runs, rounds, ranks, hooks, its own protect asks, and the host's interface.
#include "scheduler.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>


// memory (scheduler.h says the rules): arenas, and growing things

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

// every block given back: what was in it is gone (the sanitizers see a use after)
static void afree(arena *a) {
	while (a->head) {
		block *b = a->head;
		a->head = b->next;
		free(b);
	}
	a->cur = NULL;
	a->left = 0;
}

static void *regrow(void *p, size_t n) {
	p = realloc(p, n ? n : 1);
	if (!p) die("out of memory");
	return p;
}

// a growing list: vpush on the heap (kept: free v when done), tpush in scratch (gone with it)
typedef struct {
	void **v;
	size_t n, cap;
} vec;

// ordered maps by string, on the heap: insertion order, deleting and setting again moves to the end
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

// an actor of the scheduler's shape (SCHEDULER.tex, What a process acts as). pr: as protect and
// the graph see it, made once (a copy starts without)
struct sc_agent {
	int kept; // made by sc_agent_of, kept as long as the scheduler: its pr kept too
	pr_value actor;
	int has_peer, has_person, has_trusted;
	pr_value peer, person;
	int trusted;
	const sc_step *code;
	size_t ncode;
	const pr_value *pr;
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
	int looping;
	int has_loop;
	vec loop; // const char *
	int state; // 0 running, 1 killing, 2 gone
	int busy;
	gr_reader *track; // what it reads tracked through
	int64_t due; // when due, its time (the due map points here)
};

enum { RUNNING, KILLING, GONE };

struct sc_run {
	sc_proc *p;
	long n;
	int64_t mark;
	vec given; // sc_kept *
	sc_cause *causes;
	vec reads; // sc_read *
	gr_times wrote;
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
	int has_loop;
	vec loop;
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

// an interface: the graph's, bound to a place as an actor; ctx: the process's part it is given
// to (NULL: the host's). tracked: its reads tracked by the process
struct sc_api {
	sc_sched *s;
	gr_api *g;
	sc_ctx *ctx;
	int tracked;
};

typedef struct {
	sc_proc *p;
	int *alive;
	sc_ctx *ctx;
} sc_gctx;

// a kill's cause: its change, and who by as the scheduler has them
typedef struct {
	const sc_change *by;
	const sc_agent *agent;
} sc_kill;

struct sc_sched {
	arena a; // kept as long as the scheduler
	arena req, hosts; // scratch: a request's (gone at its end), the host's (gone at sc_sweep)
	pr_arena preq, phost;
	int inside; // a request runs: scratch is its
	vec all; // sc_proc *, every one made
	vec dead; // sc_kept * let go of, freed when the request ends
	gr_graph *g;
	// a run's agent with its status: the last made, again while the process, run and status are
	struct {
		sc_proc *p;
		long n;
		const nt_value *status;
		const sc_agent *agent;
	} kept;
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
	void (*changed)(void *, const gr_record *);
	void *changed_ctx;

	omap procs;
	omap due; // int64 *
	omap runs; // sc_proc *
	vec waiting; // sc_run *
	struct qitem *queue;
	size_t nqueue, qcap, qhead;
	vec deferred; // struct defer *
	vec wrote; // gr_times *: each run's, freed by sc_free

	int depth;
	int in_round;
	int active;
	omap ran;
	vec stamped; // sc_kept *

	// rank
	int rank_valid;
	omap named; // long *

	sc_api host;
};
// containers

static void *amem(sc_sched *s, size_t n) { return aalloc(&s->a, n); }
char *sc_dup(sc_sched *s, const char *str) {
	size_t n = strlen(str) + 1;
	return memcpy(amem(s, n), str, n);
}
void *sc_alloc(sc_sched *s, size_t n) { return amem(s, n); }
pr_arena *sc_pr_arena(sc_sched *s) { return &s->pra; }

// scratch: the request's while one runs, else the host's
static void *tmem(sc_sched *s, size_t n) { return aalloc(s->inside ? &s->req : &s->hosts, n); }
static pr_arena *tpra(sc_sched *s) { return s->inside ? &s->preq : &s->phost; }
static char *tdup(sc_sched *s, const char *str) {
	size_t n = strlen(str) + 1;
	return memcpy(tmem(s, n), str, n);
}

static void vpush(vec *v, void *x) {
	if (v->n == v->cap) {
		v->cap = v->cap ? v->cap * 2 : 4;
		v->v = regrow(v->v, v->cap * sizeof *v->v);
	}
	v->v[v->n++] = x;
}
static void tpush(sc_sched *s, vec *v, void *x) {
	if (v->n == v->cap) {
		size_t cap = v->cap ? v->cap * 2 : 4;
		void **nv = tmem(s, cap * sizeof *nv);
		if (v->n) memcpy(nv, v->v, v->n * sizeof *nv);
		v->v = nv;
		v->cap = cap;
	}
	v->v[v->n++] = x;
}
// a scratch copy
static vec vcopy(sc_sched *s, const vec *v) {
	vec c = {0};
	for (size_t i = 0; i < v->n; i++) tpush(s, &c, v->v[i]);
	return c;
}
// a kept list made what from holds
static void vkeep(vec *to, const vec *from) {
	to->n = 0;
	for (size_t i = 0; i < from->n; i++) vpush(to, from->v[i]);
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
// a vec of strings as a set, in scratch
static void sadd(sc_sched *s, vec *v, const char *x) {
	if (sfind(v, x) < 0) tpush(s, v, (void *)x);
}

static size_t hashs(const char *k) {
	size_t h = 5381;
	for (; *k; k++) h = h * 33 + (unsigned char)*k;
	return h;
}

static void om_reindex(omap *m) {
	size_t live = 0;
	for (size_t i = 0; i < m->n; i++) {
		if (!m->e[i].key) continue;
		m->e[live++] = m->e[i];
	}
	m->n = live;
	size_t slots = 16;
	while (slots < 4 * (m->cap ? m->cap : 4)) slots *= 2;
	m->slots = slots;
	free(m->idx);
	m->idx = calloc(slots, sizeof *m->idx);
	if (!m->idx) die("out of memory");
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
static void om_set(omap *m, const char *key, void *val) {
	long i = om_find(m, key);
	if (i >= 0) {
		m->e[i].val = val;
		return;
	}
	if (m->n == m->cap) {
		size_t cap = m->live * 2 > 4 ? m->live * 2 : 4;
		size_t k = 0;
		for (size_t j = 0; j < m->n; j++)
			if (m->e[j].key) m->e[k++] = m->e[j];
		m->n = k;
		m->e = regrow(m->e, cap * sizeof *m->e);
		m->cap = cap;
		om_reindex(m);
	}
	m->e[m->n] = (ent){key, val};
	size_t h = hashs(key) & (m->slots - 1);
	while (m->idx[h] && m->idx[h] != TOMB) h = (h + 1) & (m->slots - 1);
	m->idx[h] = ++m->n;
	m->live++;
}
static void om_free(omap *m) {
	free(m->e);
	free(m->idx);
	*m = (omap){0};
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

// held for good: a live value is never freed (its keys are no keys)
nt_value *sc_live(sc_fn *f) {
	nt_value *v = nt_null();
	v->count = LIVE_TAG;
	v->keys = (char **)(void *)f;
	v->refs = (size_t)1 << (sizeof(size_t) * 4);
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

// two values are the same when their members are; a live value only as itself. a status
// (SCHEDULER.tex, Status) is a map of pending, error, new, loop; empty: the value is current
static int same_value(const nt_value *a, const nt_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	if (a->type == NT_LIST) {
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++)
			if (!same_value(a->items[i], b->items[i])) return 0;
		return 1;
	}
	if (a->type == NT_MAP) {
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) {
			nt_value *y = nt_get(b, a->keys[i]);
			if (!y || !same_value(a->items[i], y)) return 0;
		}
		return 1;
	}
	return sc_is(a, b);
}
// errors

const sc_error *sc_error_new(sc_sched *s, const char *code, const char *message, int scheduler) {
	sc_error *e = tmem(s, sizeof *e);
	e->name = "Error";
	e->code = code;
	e->scheduler = scheduler;
	if (scheduler && message) {
		size_t n = strlen(code) + strlen(message) + 3;
		char *m = tmem(s, n);
		snprintf(m, n, "%s: %s", code, message);
		e->message = m;
	} else e->message = message ? message : code;
	return e;
}
static const sc_error *fail(sc_sched *s, const char *code, const char *message) {
	return sc_error_new(s, code, message, 1);
}
static const sc_error STOP_ERR = {"Stop", "stop", "stop", NULL, 0};
// a compute's read stopped, as the graph passes it on
static const gr_error GR_STOP = {"stop", "stop", NULL};

// the graph's error as ours: one with its own message is the scheduler's (SchedulerError)
static const sc_error *from_gr(sc_sched *s, const gr_error *e) {
	if (!e) return NULL;
	if (e == &GR_STOP) return &STOP_ERR;
	int own = e->message && strcmp(e->message, e->code);
	sc_error *x = (sc_error *)sc_error_new(s, e->code, own ? e->message : NULL, own);
	x->why = e->why;
	return x;
}

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

// agents

const char sc_status_because[] = "scheduler:status";

const sc_agent *sc_agent_of(sc_sched *s, const char *actor) {
	sc_agent *a = amem(s, sizeof *a);
	a->kept = 1;
	a->actor = pr_lit(sc_dup(s, actor));
	return a;
}
const sc_agent *sc_agent_with(sc_sched *s, const sc_agent *a, const char *person, int has_trusted,
	int trusted) {
	sc_agent *c = tmem(s, sizeof *c);
	*c = *a;
	c->kept = 0;
	c->pr = NULL;
	if (person) c->has_person = 1, c->person = pr_lit(tdup(s, person));
	if (has_trusted) c->has_trusted = 1, c->trusted = trusted;
	return c;
}

// the agent as protect sees an actor, in ar
static pr_value agent_pr(pr_arena *ar, const sc_agent *a) {
	pr_value m = pr_map();
	pr_put(ar, &m, "actor", a->actor);
	if (a->has_peer) pr_put(ar, &m, "peer", a->peer);
	if (a->has_person) pr_put(ar, &m, "person", a->person);
	if (a->has_trusted) pr_put(ar, &m, "trusted", pr_bool(a->trusted));
	pr_value code = pr_list();
	for (size_t i = 0; i < a->ncode; i++) {
		const sc_step *st = &a->code[i];
		pr_value x = pr_map();
		if (st->process) pr_put(ar, &x, "process", pr_lit(st->process));
		if (st->prog_node) {
			pr_value pg = pr_map();
			pr_put(ar, &pg, "node", pr_lit(st->prog_node));
			pr_put(ar, &pg, "time", pr_num((double)st->prog_time));
			pr_put(ar, &x, "program", pg);
		}
		pr_push(ar, &code, x);
	}
	pr_put(ar, &m, "code", code);
	return m;
}
// the agent as the graph is given it, made once: as long as the agent is (kept, or scratch)
static const pr_value *actor_of(sc_sched *s, const sc_agent *a) {
	if (!a->pr) {
		pr_arena *ar = a->kept ? &s->pra : tpra(s);
		pr_value *v = pr_alloc(ar, sizeof *v);
		*v = agent_pr(ar, a);
		((sc_agent *)a)->pr = v;
	}
	return a->pr;
}

// the agent of a process for a step of its own
static const sc_agent *agent_of(sc_sched *s, sc_proc *p, long run, const nt_value *status,
	const char *handler, int cleanup) {
	sc_agent *a = tmem(s, sizeof *a);
	*a = p->base;
	a->kept = 0;
	a->pr = NULL;
	sc_step *code = tmem(s, (p->nprefix + 1) * sizeof *code);
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
static const sc_agent *agent_at(sc_sched *s, sc_proc *p, long n, const nt_value *status) {
	n = n > 0 ? n : 0;
	if (s->kept.agent && s->kept.p == p && s->kept.n == n && same_value(s->kept.status, status))
		return s->kept.agent;
	const sc_agent *a = agent_of(s, p, n, status, NULL, 0);
	s->kept.p = p, s->kept.n = n, s->kept.status = status, s->kept.agent = a;
	return a;
}

// the agent with fields added to its last step; an empty code becomes that one step
static const sc_agent *stepped_kill(sc_sched *s, const sc_agent *a, const char *kill) {
	sc_agent *c = tmem(s, sizeof *c);
	*c = *a;
	c->kept = 0;
	c->pr = NULL;
	sc_step *code = tmem(s, (a->ncode ? a->ncode : 1) * sizeof *code);
	if (a->ncode) memcpy(code, a->code, a->ncode * sizeof *code);
	code[a->ncode ? a->ncode - 1 : 0].kill = kill;
	c->code = code;
	c->ncode = a->ncode ? a->ncode : 1;
	return c;
}

// changes

static int64_t tick(sc_sched *s) { return ++*s->clock; }

const sc_change *sc_change_new(sc_sched *s, int64_t time, const char *node) {
	return gr_change_new(s->g, time, actor_of(s, s->host_actor), node);
}

// a change the scheduler tells of itself: a mark's, a kill's. The graph's (a copy), held until the
// next sweep: what keeps it holds it (gr_change_hold)
static const sc_change *change_at(sc_sched *s, const sc_agent *actor, const char *reader,
	int64_t time, const char *node, gr_where where, const char *name, const pr_value *cause) {
	sc_change c = {0};
	c.time = time;
	c.actor = actor_of(s, actor);
	c.reader = reader;
	c.node = node;
	c.where = where;
	c.name = name;
	c.cause = cause;
	return gr_change_copy(s->g, &c);
}

// a cause as the graph keeps it
static const pr_value *cause_pr(sc_sched *s, const char *cause) {
	if (!cause) return NULL;
	pr_value *v = pr_alloc(tpra(s), sizeof *v);
	*v = pr_lit(cause);
	return v;
}

nd_node *sc_get(sc_sched *s, const char *id) { return gr_get(s->g, id); }

static void pass(sc_sched *s, const sc_moment *m) {
	for (size_t i = 0; i < s->nhooks; i++) s->hooks[i].fn(s->hooks[i].ctx, m);
}

// protect, as the programs side is given it: one check for each thing it does. each passes the
// item's route, then asks the one thing

typedef struct {
	pr_ask *v;
	size_t n, cap;
} asks_t;

static void asks_add(sc_sched *s, asks_t *a, pr_ask x) {
	if (a->n == a->cap) {
		size_t cap = a->cap ? a->cap * 2 : 8;
		pr_ask *nv = pr_alloc(tpra(s), cap * sizeof *nv);
		if (a->n) memcpy(nv, a->v, a->n * sizeof *nv);
		a->v = nv;
		a->cap = cap;
	}
	a->v[a->n++] = x;
}
static void asks_addall(sc_sched *s, asks_t *a, pr_asks x) {
	for (size_t i = 0; i < x.n; i++) asks_add(s, a, x.items[i]);
}
static pr_asks route_asks(sc_sched *s, const pl_step *route, size_t n) {
	pr_step *st = pr_alloc(tpra(s), (n ? n : 1) * sizeof *st);
	for (size_t i = 0; i < n; i++) st[i] = (pr_step){route[i].node, route[i].name};
	return pr_pass(tpra(s), st, n);
}
static const sc_error *asking(sc_sched *s, const sc_agent *agent, const asks_t *as, const char *op) {
	return from_gr(s, gr_asking(s->g, actor_of(s, agent), as->v, as->n, op));
}

// the first loaded item an address reaches from place
static const sc_error *reach(sc_sched *s, const char *const *place, size_t nplace,
	const char *const *address, size_t n, const pl_item **out) {
	pl_spot at = {place, nplace, 0, NULL, 0};
	pl_items items;
	int code = pl_look(gr_places(s->g), &at, address, n, NULL, &items);
	if (code) return sc_error_new(s, pl_code_name(code), NULL, 0);
	*out = NULL;
	for (size_t i = 0; i < items.n && !*out; i++)
		if (items.items[i].node) *out = &items.items[i];
	if (!*out) return fail(s, "nothing-there", "the address reaches nothing");
	return NULL;
}
// causes and loops

static sc_cause *cause_new(sc_sched *s, const char *id, sc_cause **parents, size_t n) {
	sc_cause *c = tmem(s, sizeof *c);
	c->id = id;
	c->parents = parents;
	c->n = n;
	return c;
}
// the causes from c down, each once
static void cause_walk(sc_sched *s, sc_cause *c, vec *seen) {
	tpush(s, seen, c);
	for (size_t i = 0; i < seen->n; i++) {
		sc_cause *x = seen->v[i];
		for (size_t k = 0; k < x->n; k++)
			if (vfind(seen, x->parents[k]) < 0) tpush(s, seen, x->parents[k]);
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

// how many name id: the count itself is the map's value. id is kept (a process's own)
static void name_add(sc_sched *s, const char *id, int d) {
	long v = (long)(intptr_t)om_get(&s->named, id) + d;
	if (v > 0) om_set(&s->named, id, (void *)(intptr_t)v);
	else om_del(&s->named, id);
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
	vkeep(&p->values, next);
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

// records: status, value and the latest run, written at the process's node, each in a changing
// told whole (snap)

// the status's version, in front of the value, put, replaced or taken away
static void put_status(sc_sched *s, sc_proc *p, nd_node *node, nt_value *status) {
	int had = p->status->count > 0, has = status->count > 0;
	const sc_change *change = gr_by_at(s->g, p->id, GR_VALUE, NULL);
	nd_version v = {status, change, sc_status_because};
	size_t len = node->value.length;
	nd_version *vs;
	size_t count;
	if (!had && has) {
		vs = tmem(s, (len + 1) * sizeof *vs);
		vs[0] = v;
		if (len) memcpy(vs + 1, node->value.versions, len * sizeof *vs);
		count = len + 1;
	} else if (had && has) {
		vs = tmem(s, (len ? len : 1) * sizeof *vs);
		if (len) memcpy(vs, node->value.versions, len * sizeof *vs);
		vs[0] = v;
		count = len ? len : 1;
	} else if (had && !has) {
		vs = tmem(s, (len ? len : 1) * sizeof *vs);
		if (len > 1) memcpy(vs, node->value.versions + 1, (len - 1) * sizeof *vs);
		count = len ? len - 1 : 0;
	} else {
		vs = tmem(s, (len ? len : 1) * sizeof *vs);
		for (size_t i = 0; i < len; i++) {
			vs[i] = node->value.versions[i];
			vs[i].change = change;
		}
		count = len;
	}
	node->value = (nd_object){vs, count};
}

// what a record's changing does: a status put, a version set at the value of a node
typedef struct {
	sc_sched *s;
	sc_proc *p;
	nd_node *node;
	nt_value *status; // NULL: none put
	nd_node *at;
	size_t slot;
	const nt_value *value;
	int64_t time;
} record_t;
static const gr_error *record_run(void *arg) {
	record_t *r = arg;
	sc_sched *s = r->s;
	if (r->status) put_status(s, r->p, r->node, r->status);
	if (!r->at) return NULL;
	const sc_change *change = gr_by_at(s->g, r->at->id, GR_VALUE, NULL);
	size_t len = r->at->value.length;
	size_t count = len > r->slot ? len : r->slot + 1;
	nd_version *vs = tmem(s, count * sizeof *vs);
	if (len) memcpy(vs, r->at->value.versions, len * sizeof *vs);
	vs[r->slot] = (nd_version){r->value, change, NULL};
	r->at->value = (nd_object){vs, count};
	return NULL;
}
static void record(sc_sched *s, sc_proc *p, const sc_agent *agent, sc_cause *causes,
	const gr_snap *snap, size_t nsnap, record_t *r) {
	gr_acting who = {actor_of(s, agent), p->id, NULL, NULL};
	gr_changing_opts co = {0};
	co.tag = causes;
	co.own = p;
	co.has_snap = 1;
	co.snap = snap;
	co.nsnap = nsnap;
	gr_changing(s->g, &who, &co, record_run, r);
}

// the status kept as the process's: the one before let go (at the next sweep)
static void status_is(sc_sched *s, sc_proc *p, nt_value *status) {
	gr_later(s->g, p->status);
	p->status = status;
}

// the status a process's node shows, as a version in front of its value. Takes the caller's hold of
// status: kept as the process's, or let go
static void write_status(sc_sched *s, sc_proc *p, nt_value *status, long n, sc_cause *causes,
	int force) {
	nd_node *node = p->state == RUNNING ? gr_get(s->g, p->id) : NULL;
	if (!node || (!force && !p->status->count && !status->count)) {
		gr_later(s->g, status);
		return;
	}
	gr_snap snap[1] = {{p->id, GR_VALUE, NULL}};
	record_t r = {s, p, node, status, NULL, 0, NULL, 0};
	record(s, p, agent_at(s, p, n, status), causes, snap, 1, &r);
	status_is(s, p, status);
}

// its value, behind its status; then the status, if not the same. value is borrowed (the last
// is held); status, the caller's hold, taken
static void write_value(sc_sched *s, sc_proc *p, const nt_value *value, nt_value *status,
	sc_run *run) {
	nd_node *node = gr_get(s->g, p->id);
	if (p->state != RUNNING || !node) {
		gr_later(s->g, status);
		return;
	}
	if (p->has_last) gr_later(s->g, (nt_value *)p->last);
	p->has_last = 1;
	p->last = nt_ref((nt_value *)value);
	const sc_agent *agent = agent_at(s, p, run->n, status);
	gr_snap snap[1] = {{p->id, GR_VALUE, NULL}};
	record_t r = {s, p, node, NULL, node, p->status->count > 0 ? 1 : 0, value, 0};
	record(s, p, agent, run->causes, snap, 1, &r);
	if (!same_value(status, p->status)) write_status(s, p, status, run->n, run->causes, 0);
	else gr_later(s->g, status);
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
		} else nt_set(st, p->status->keys[i], nt_ref(p->status->items[i]));
	}
	if (!put) nt_set(st, "pending", nt_num((double)since));
	if (!same_value(st, p->status)) write_status(s, p, st, p->runs, NULL, 0);
	else gr_later(s->g, st);
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

static const char *ended_name(sc_ended e) {
	switch (e) {
	case SC_DONE: return "done";
	case SC_PENDING: return "pending";
	case SC_FAILED: return "failed";
	case SC_STOPPED: return "stopped";
	default: return "looping";
	}
}

// the run node placed in its process, as the scheduler's own change
typedef struct {
	sc_sched *s;
	const char *id, *name, *child;
	int64_t time;
} insert_t;
static const gr_error *insert_run(void *arg) {
	insert_t *x = arg;
	return gr_do_insert(x->s->g, x->id, x->name, x->child, NULL, NULL, &x->time);
}

// the latest run, the value of a node named run inside the process. status: the process's new
// status, if it changed, written in the same operation (the caller's hold, taken)
static void write_run(sc_sched *s, sc_proc *p, sc_run *run, sc_ended ended, const sc_error *error,
	nt_value *status) {
	nd_node *node = gr_get(s->g, p->id);
	if (p->state != RUNNING || !node) {
		gr_later(s->g, status);
		return;
	}
	nt_value *v = nt_map();
	// the graph holds what it keeps: this hold goes at the next sweep
	gr_later(s->g, v);
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
		nt_set(e, "tracked", nt_bool(r->tracked));
		nt_value *ts = nt_list();
		for (size_t k = 0; k < r->ntimes; k++) nt_push(ts, nt_num((double)r->times[k]));
		nt_set(e, "times", ts);
		if (r->has_address) {
			nt_value *ad = nt_list();
			for (size_t k = 0; k < r->naddress; k++) nt_push(ad, nt_str(r->address[k]));
			nt_set(e, "address", ad);
		}
		if (r->name) nt_set(e, "name", nt_str(r->name));
		nt_push(reads, e);
	}
	nt_set(v, "reads", reads);
	nt_value *wrote = nt_list();
	for (size_t i = 0; i < run->wrote.n; i++) nt_push(wrote, nt_num((double)run->wrote.v[i]));
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
	nd_node *there = p->run ? gr_get(s->g, p->run) : NULL;
	if (there) {
		gr_snap snap[2] = {{p->id, GR_VALUE, NULL}, {there->id, GR_VALUE, NULL}};
		record_t r = {s, p, node, status, there, 0, v, 0};
		record(s, p, agent_at(s, p, run->n, status ? status : p->status), run->causes,
			status ? snap : snap + 1, status ? 2 : 1, &r);
		if (status) status_is(s, p, status);
		return;
	}
	if (status) write_status(s, p, status, run->n, run->causes, 0);
	gr_acting who = {actor_of(s, agent_at(s, p, run->n, p->status)), p->id, NULL, NULL};
	const char *id;
	if (gr_make(s->g, NULL, v, 1, &who, &id)) return;
	gr_own(s->g, id, p);
	p->run = id;
	om_set(&s->runs, id, p);
	gr_changing_opts co = {0};
	co.tag = run->causes;
	co.own = p;
	insert_t x = {s, p->id, "run", id, 0};
	gr_changing(s->g, &who, &co, insert_run, &x);
}
// marks

static void becomes(sc_sched *s, sc_proc *q, int64_t time) {
	if (om_has(&s->due, q->id)) return;
	q->due = time;
	om_set(&s->due, q->id, &q->due);
	if (!q->has_since) q->has_since = 1, q->since = time;
	sc_moment m = {.kind = SC_DUE, .id = q->id, .by = time};
	pass(s, &m);
}

static sc_kept *kept_find(sc_proc *q, int64_t time) {
	for (size_t i = 0; i < q->kept.n; i++)
		if (((sc_kept *)q->kept.v[i])->by->time == time) return q->kept.v[i];
	return NULL;
}

// a change that marked q kept (held) until a run takes it
static void keep_mark(sc_sched *s, sc_proc *q, const sc_change *change, sc_cause *causes) {
	sc_kept *k = malloc(sizeof *k);
	if (!k) die("out of memory");
	gr_change_hold(s->g, change);
	k->by = change;
	k->causes = causes;
	vpush(&q->kept, k);
	if (causes) vpush(&s->stamped, k);
}
// taken: let go of when the request ends (a run may still read it)
static void let_mark(sc_sched *s, sc_kept *k) {
	gr_change_drop(s->g, k->by);
	vpush(&s->dead, k);
}

static void mark(sc_sched *s, sc_proc *q, const sc_change *change, sc_cause *causes) {
	if (!kept_find(q, change->time)) keep_mark(s, q, change, causes);
	int loop = caused(s, causes, q->id);
	q->has_loop = 0;
	if (loop) {
		q->has_loop = 1;
		vec ids = {0};
		ids_of(s, causes, &ids);
		vkeep(&q->loop, &ids);
	}
	if (q->looping) {
		if (loop) return;
		q->looping = 0;
	}
	becomes(s, q, change->time);
}

// what the graph tells: a change reached what a process read; an ephemeral node owned; a node gone

static void on_marked(void *ctx, void *owner, const gr_change *by, const void *tag) {
	sc_proc *q = owner;
	if (q->state == RUNNING) mark(ctx, q, by, (sc_cause *)tag);
}
static void on_owned(void *ctx, void *owner, const char *id) {
	(void)ctx;
	sc_proc *p = owner;
	vpush(&p->owned, (void *)id);
}
// a kill releases newest first: the last, popped
static void on_released(void *ctx, const char *id, void *owner) {
	sc_sched *s = ctx;
	if (owner) {
		vec *o = &((sc_proc *)owner)->owned;
		for (size_t i = o->n; i-- > 0;)
			if (!strcmp(o->v[i], id)) {
				vdel(o, i);
				break;
			}
	}
	sc_proc *r = om_get(&s->runs, id);
	if (r) {
		om_del(&s->runs, id);
		r->run = NULL;
	}
}
// an agent that is only an actor (no person, peer, trusted or code) is its actor, as the host's own
// changes are by it (the actor the host gave)
const pr_value *sc_actor(const pr_value *agent) {
	if (!agent || agent->kind != PR_MAP || agent->n != 2) return agent;
	const pr_value *actor = pr_get(agent, "actor"), *code = pr_get(agent, "code");
	return actor && code && code->kind == PR_LIST && code->n == 0 ? actor : agent;
}
static void on_changed(void *ctx, const gr_record *r) {
	sc_sched *s = ctx;
	gr_record x = *r;
	gr_change h = *r->header;
	h.actor = sc_actor(h.actor);
	x.header = &h;
	s->changed(s->changed_ctx, &x);
}
static const char *on_id(void *ctx, int64_t time) {
	sc_sched *s = ctx;
	return s->fresh ? s->fresh(s->fresh_ctx, time) : NULL;
}

// reads

// items of process nodes that are due: a compute's read stops, unless that process waits after
// it; otherwise their pending is written first
static void reached(sc_sched *s, const sc_items *items, vec *out) {
	for (size_t i = 0; i < items->n; i++) {
		const sc_item *it = &items->items[i];
		sc_proc *q = proc_of(s, it->it.id);
		if (q && it->it.node && om_has(&s->due, q->id) && vfind(out, q) < 0) tpush(s, out, q);
	}
}

static int waits_after(sc_sched *s, sc_proc *q, sc_proc *r) {
	vec seen = {0};
	for (sc_proc *x = q->after; x && vfind(&seen, x) < 0; x = x->after) {
		if (x == r) return 1;
		tpush(s, &seen, x);
	}
	return 0;
}

// the times of the changes that set what a read got
static void add_time(int64_t **ts, size_t *n, const sc_change *c) {
	if (!c) return;
	for (size_t i = 0; i < *n; i++)
		if ((*ts)[i] == c->time) return;
	*ts = realloc(*ts, (*n + 1) * sizeof **ts);
	if (!*ts) die("out of memory");
	(*ts)[(*n)++] = c->time;
}
static void times_of(sc_sched *s, const sc_items *items, sc_read *r) {
	int64_t *ts = NULL;
	size_t n = 0;
	for (size_t i = 0; i < items->n; i++) {
		const pl_item *it = &items->items[i].it;
		if (it->has_versions)
			for (size_t k = 0; k < it->nversions; k++) add_time(&ts, &n, it->versions[k].change);
		if (it->nroute) {
			const pl_step *st = &it->route[it->nroute - 1];
			nd_node *node = gr_get(s->g, st->node);
			if (node)
				for (size_t k = 0; k < node->children_length; k++)
					if (!strcmp(node->children[k].name, st->name)) {
						const nd_object *o = &node->children[k].object;
						if (o->length) add_time(&ts, &n, o->versions[0].change);
					}
		}
	}
	r->times = tmem(s, (n ? n : 1) * sizeof *ts);
	if (n) memcpy(r->times, ts, n * sizeof *ts);
	r->ntimes = n;
	free(ts);
}

// a read: as ctx's process, tracked when its interface is; the hooks and the run see it
static const gr_error *reading(void *arg, gr_read *r) {
	sc_api *a = arg;
	sc_sched *s = a->s;
	sc_ctx *ctx = a->ctx;
	const pl_depend *d = a->tracked ? gr_depend(ctx->p->track) : NULL;
	const gr_error *e = gr_read_make(r, d);
	if (e) return e;
	int children = !strcmp(r->op, "children");
	sc_items first = r->is_names ? (sc_items){0} : r->items;
	vec due = {0};
	if (!children) reached(s, &first, &due);
	if (due.n) {
		if (ctx && ctx->compute && ctx->run) {
			for (size_t i = 0; i < due.n; i++) {
				sc_proc *q = due.v[i];
				if (q != ctx->p && !waits_after(s, q, ctx->p)) {
					ctx->run->stopped = q;
					return &GR_STOP;
				}
			}
		}
		int64_t before = *s->clock;
		for (size_t i = 0; i < due.n; i++) pending_at(s, due.v[i]);
		if (*s->clock != before) {
			e = gr_read_make(r, NULL);
			if (e) return e;
		}
	}
	if (ctx) {
		sc_moment m = {.kind = SC_READS, .id = ctx->p->id, .op = r->op, .tracked = a->tracked};
		if (ctx->run_n > 0) m.has_run = 1, m.run = ctx->run_n;
		m.handler = ctx->handler;
		m.cleanup = ctx->cleanup;
		pass(s, &m);
		sc_run *run = ctx->run;
		if (run) {
			sc_read *rd = tmem(s, sizeof *rd);
			rd->op = r->op;
			rd->tracked = a->tracked;
			if (!r->is_names) times_of(s, &r->items, rd);
			const char **ad = tmem(s, (r->n ? r->n : 1) * sizeof *ad);
			for (size_t i = 0; i < r->n; i++) ad[i] = tdup(s, r->address[i]);
			rd->has_address = 1, rd->address = ad, rd->naddress = r->n;
			rd->name = r->name ? tdup(s, r->name) : NULL;
			tpush(s, &run->reads, rd);
			// the process's own id: kept, where an item's is the graph's scratch
			sc_proc *q;
			if (ctx->compute && !children)
				for (size_t i = 0; i < first.n; i++)
					if (first.items[i].it.node && (q = proc_of(s, first.items[i].it.id)))
						sadd(s, &run->values, q->id);
		}
	}
	return NULL;
}

// requests and rounds: declared here, below

typedef const sc_error *(*req_fn)(void *);
static const sc_error *request(sc_sched *s, req_fn fn, void *ctx);

// each change an interface makes, as a request. The host's: its error kept past the request
typedef struct {
	const gr_error *(*fn)(void *);
	void *arg;
	const gr_error *e;
	sc_sched *s;
	int host;
} around_t;
static const sc_error *around_run(void *p) {
	around_t *x = p;
	x->e = x->fn(x->arg);
	if (x->host) x->e = gr_error_keep(x->s->g, x->e);
	return NULL;
}
static const gr_error *around(void *ctx, const gr_error *(*fn)(void *), void *arg) {
	sc_api *a = ctx;
	around_t x = {fn, arg, NULL, a->s, !a->s->inside};
	request(a->s, around_run, &x);
	return x.e;
}

// the interface: the graph's, the hooks around its reads and changes

const sc_error *sc_look(sc_api *a, const char *const *address, size_t n, sc_items *out) {
	return from_gr(a->s, gr_look(a->g, address, n, out));
}
const sc_error *sc_lookup(sc_api *a, const char *const *path, size_t n, sc_items *out) {
	return from_gr(a->s, gr_lookup(a->g, path, n, out));
}
const sc_error *sc_lookups(sc_api *a, const char *const *path, size_t n, sc_items *out) {
	return from_gr(a->s, gr_lookups(a->g, path, n, out));
}
const sc_error *sc_names(sc_api *a, const char *const *address, size_t n, pl_namelist *out) {
	return from_gr(a->s, gr_names(a->g, address, n, out));
}
const sc_error *sc_children(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out) {
	return from_gr(a->s, gr_children(a->g, address, n, name, out));
}
const sc_error *sc_content(sc_api *a, const char *const *address, size_t n, sc_items *out) {
	return from_gr(a->s, gr_content(a->g, address, n, out));
}
const sc_error *sc_info(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out) {
	return from_gr(a->s, gr_info(a->g, address, n, name, out));
}
const sc_error *sc_write(sc_api *a, const char *const *address, size_t n, const nt_patch *patches,
	size_t np, const long *index, const pl_span *slotindex, int span, int64_t *time) {
	return from_gr(a->s, gr_write(a->g, address, n, patches, np, index, slotindex, span, time));
}
const sc_error *sc_set(sc_api *a, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time) {
	return from_gr(a->s,
		gr_set(a->g, address, n, name, patches, np, index, slotindex, span, time));
}
const sc_error *sc_insert(sc_api *a, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time) {
	return from_gr(a->s, gr_insert(a->g, id, name, child, index, slotindex, time));
}
const sc_error *sc_remove(sc_api *a, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time) {
	return from_gr(a->s, gr_remove(a->g, id, name, index, slotindex, time));
}
const sc_error *sc_pop(sc_api *a, const char *id, const char *name, pl_span slotindex,
	int64_t *time) {
	return from_gr(a->s, gr_pop(a->g, id, name, slotindex, time));
}
const sc_error *sc_rename(sc_api *a, const char *id, const char *name, const char *to,
	int64_t times[2]) {
	return from_gr(a->s, gr_rename(a->g, id, name, to, times));
}
const sc_error *sc_move(sc_api *a, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, int64_t times[2], size_t *ntimes) {
	return from_gr(a->s, gr_move(a->g, id, name, index, toid, toname, toindex, times, ntimes));
}
const sc_error *sc_create(sc_api *a, const nt_value *value, const char *id, int ephemeral,
	const char **out) {
	return from_gr(a->s, gr_create(a->g, value, value != NULL, id, ephemeral, out));
}

// the interface handed to code, at a place, as an actor; it stops when alive says so
static sc_api *process_api(sc_sched *s, sc_ctx *ctx, int tracked, int writes, int *alive) {
	sc_api *a = tmem(s, sizeof *a);
	sc_proc *p = ctx->p;
	a->s = s;
	a->ctx = ctx;
	a->tracked = tracked;
	gr_bind b = {0};
	b.place = p->place;
	b.nplace = p->nplace;
	b.agent = actor_of(s, ctx->agent);
	b.reader = p->id;
	b.cause = cause_pr(s, ctx->cause);
	b.depend = tracked ? gr_depend(p->track) : NULL;
	b.writes = writes;
	b.alive = alive;
	b.owner = p;
	b.tag = ctx->causes;
	b.wrote = ctx->run ? &ctx->run->wrote : NULL;
	b.reading = reading;
	b.around = around;
	b.ctx = a;
	b.scratch = 1;
	a->g = gr_bound(s->g, &b);
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

// replacing: an empty write at its pid, its status without new; due by it, run as replaced
static const sc_error *replacing(sc_sched *s, sc_proc *p, const sc_agent *actor, const char *reader,
	sc_cause *causes) {
	nt_value *st = nt_map();
	for (size_t i = 0; i < p->status->count; i++)
		if (strcmp(p->status->keys[i], "new")) nt_set(st, p->status->keys[i], nt_ref(p->status->items[i]));
	write_status(s, p, st, p->runs, causes, 1);
	p->replaced = 1;
	p->replacements++;
	mark(s, p, change_at(s, actor, reader, *s->clock, p->id, GR_VALUE, NULL, NULL), causes);
	return NULL;
}
static sc_partcall *partcall(sc_sched *s, sc_proc *p, const char *name, int replaced) {
	sc_partcall *c = tmem(s, sizeof *c);
	c->part = name;
	c->replaced = replaced;
	for (size_t i = 0; i < p->children.n; i++) {
		sc_child *ch = p->children.v[i];
		if (!strcmp(ch->part, name)) tpush(s, &c->before, ch);
	}
	return c;
}

static int is_code(const sc_code *c) { return c->setup || c->compute; }

static int never_name(const char *s) { return !strcmp(s, ".") || !strcmp(s, "..") || strchr(s, '/'); }


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
				child->proc->state != RUNNING || !gr_get(s->g, child->proc->id))
				continue;
			tpush(s, &call->matched, child);
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
	const pl_item *where;
	const sc_error *e = reach(s, place, nplace, op->address, op->naddress, &where);
	if (e) return e;
	const sc_agent *agent = ctx ? ctx->agent : s->host_actor;
	gr_acting who = {actor_of(s, agent), caller ? caller->id : NULL, cause_pr(s, ctx ? ctx->cause : NULL),
		NULL};
	// its name: checked before anything is made
	if (op->name && never_name(op->name)) {
		size_t mn = strlen(op->name) + 20;
		char *m = tmem(s, mn);
		snprintf(m, mn, "start: %s is no name", op->name);
		return fail(s, "wrong-field", m);
	}
	{
		asks_t as = {0};
		asks_addall(s, &as, route_asks(s, where->route, where->nroute));
		pr_value args = pr_map();
		pr_put(tpra(s), &args, "node", pr_lit(where->id));
		if (op->name) pr_put(tpra(s), &args, "name", pr_lit(op->name));
		if (op->id) pr_put(tpra(s), &args, "id", pr_lit(op->id));
		asks_add(s, &as, (pr_ask){"place", args});
		e = asking(s, agent, &as, "start");
		if (e) return e;
	}
	const char *pid;
	e = from_gr(s, gr_make(s->g, op->id, nt_null(), 1, &who, &pid));
	if (e) return e;
	gr_own(s->g, pid, NULL);
	sc_proc *p = amem(s, sizeof *p);
	vpush(&s->all, p);
	p->id = pid;
	p->name = op->name ? sc_dup(s, op->name) : pid;
	p->place = absolute(s, place, nplace, op->address, op->naddress, &p->nplace);
	p->base = *agent;
	p->base.code = NULL;
	p->base.ncode = 0;
	p->base.has_person = 0;
	p->base.has_trusted = 0;
	p->base.kept = 0;
	p->base.pr = NULL;
	// the steps it starts with, kept: the agent's are scratch
	sc_step *prefix = amem(s, (agent->ncode + 1) * sizeof *prefix);
	for (size_t i = 0; i < agent->ncode; i++) {
		prefix[i] = agent->code[i];
		if (prefix[i].prog_node) prefix[i].prog_node = sc_dup(s, prefix[i].prog_node);
		if (prefix[i].handler) prefix[i].handler = sc_dup(s, prefix[i].handler);
		if (prefix[i].kill) prefix[i].kill = sc_dup(s, prefix[i].kill);
		prefix[i].status = NULL;
	}
	p->prefix = prefix;
	p->nprefix = agent->ncode;
	p->started = *s->clock;
	p->status = nt_map();
	p->equal = op->equal;
	p->track = gr_reader_new(s->g, p);
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
	om_set(&s->procs, p->id, p);
	started_rank(s, p);
	if (caller && caller->state != GONE) {
		p->parent = caller;
		sc_child *ch = amem(s, sizeof *ch);
		ch->proc = p;
		ch->name = p->name;
		ch->part = call ? call->part : "request";
		ch->replaced = caller->replacements;
		vpush(&caller->children, ch);
		gr_own(s->g, pid, caller);
	}
	gr_changing_opts co = {0};
	co.tag = ctx ? ctx->causes : NULL;
	co.wrote = ctx && ctx->run ? &ctx->run->wrote : NULL;
	insert_t x = {s, where->id, p->name, pid, 0};
	e = from_gr(s, gr_changing(s->g, &who, &co, insert_run, &x));
	if (e) return e;
	const sc_change *change = change_at(s, agent, who.reader, x.time, where->id, GR_CHILDREN, p->name,
		who.cause);
	keep_mark(s, p, change, ctx ? ctx->causes : NULL);
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
	// a value handed with its hold: let go once every holder has taken its own (the next sweep)
	if (g->hands) gr_later(s->g, o.value);
	p->busy--;
	s->active--;
	unwind(s);
	return o;
}

// release and end: below
static void release(sc_sched *s, const char *id, const sc_change *cause);
static void end(sc_sched *s, sc_proc *p, const sc_kill *cause);

// handler calls

typedef struct qitem {
	const char *const *address;
	size_t naddress;
	nt_value *args;
	const char *const *place;
	size_t nplace;
	const sc_agent *agent;
	sc_cause *causes;
	sc_ctx *ctx; // prepared: the handler's
	sc_fn *f;
} qitem;

static void *g_new(sc_sched *s, sc_ctx *ctx, int *alive) {
	sc_gctx *g = tmem(s, sizeof *g);
	g->p = ctx->p;
	g->alive = alive;
	g->ctx = ctx;
	return g;
}

static sc_given *given_new(sc_sched *s, sc_ctx *ctx, int *alive) {
	sc_given *g = tmem(s, sizeof *g);
	g->s = s;
	g->ctx = g_new(s, ctx, alive);
	g->self = ctx->p->id;
	g->name = ctx->p->name;
	return g;
}

// a call checked now, run later (go): what is wrong before it starts is the caller's error
static const sc_error *prepare(sc_sched *s, qitem *op) {
	const pl_item *item;
	const sc_error *e = reach(s, op->place, op->nplace, op->address, op->naddress, &item);
	if (e) return e;
	{
		asks_t as = {0};
		asks_addall(s, &as, route_asks(s, item->route, item->nroute));
		pr_value args = pr_map();
		pr_put(tpra(s), &args, "node", pr_lit(item->id));
		pr_put(tpra(s), &args, "object", pr_lit("value"));
		asks_add(s, &as, (pr_ask){"read", args});
		e = asking(s, op->agent, &as, "call");
		if (e) return e;
	}
	sc_proc *definer = gr_owner(s->g, item->id);
	const nt_value *fv = item->node->value.length ? item->node->value.versions[0].content : NULL;
	sc_fn *f = sc_live_fn(fv);
	if (!gr_ephemeral(s->g, item->id) || !definer || definer->state != RUNNING || !f)
		return fail(s, "not-a-handler", "the node is not a handler a process placed");
	const char *handler = op->naddress ? op->address[op->naddress - 1] : "";
	sc_agent *agent = tmem(s, sizeof *agent);
	*agent = *op->agent;
	agent->kept = 0;
	agent->pr = NULL;
	sc_step *code2 = tmem(s, (op->agent->ncode + 1) * sizeof *code2);
	if (op->agent->ncode) memcpy(code2, op->agent->code, op->agent->ncode * sizeof *code2);
	sc_step *st = &code2[op->agent->ncode];
	st->process = definer->id;
	if (definer->has_program) st->prog_node = definer->prog_node, st->prog_time = definer->prog_time;
	st->handler = handler;
	agent->code = code2;
	agent->ncode = op->agent->ncode + 1;
	sc_ctx *ctx = tmem(s, sizeof *ctx);
	ctx->p = definer;
	ctx->agent = agent;
	ctx->handler = handler;
	ctx->causes = op->causes;
	op->ctx = ctx;
	op->f = f;
	return NULL;
}

// a prepared call run: as the process that placed the handler
static const sc_error *go(sc_sched *s, const qitem *op, nt_value **out) {
	*out = NULL;
	sc_ctx *ctx = op->ctx;
	sc_moment m = {.kind = SC_STARTS, .id = ctx->p->id, .handler = ctx->handler};
	pass(s, &m);
	int *alive = tmem(s, sizeof *alive);
	*alive = 1;
	sc_given *g = given_new(s, ctx, alive);
	g->api = process_api(s, ctx, 0, 1, alive);
	g->args = op->args;
	pout done = part_call(s, ctx->p, op->f, g);
	*alive = 0;
	sc_moment ends = {.kind = SC_ENDS, .id = ctx->p->id, .handler = ctx->handler,
		.ended = done.error ? SC_FAILED : SC_DONE};
	ends.error = done.error;
	pass(s, &ends);
	if (done.error) return done.error;
	*out = done.value;
	return NULL;
}

static qitem *qitem_new(sc_sched *s, const char *const *address, size_t n, nt_value *args,
	const char *const *place, size_t np, const sc_agent *agent, sc_cause *causes) {
	qitem *q = tmem(s, sizeof *q);
	const char **ad = tmem(s, (n + 1) * sizeof *ad);
	for (size_t i = 0; i < n; i++) ad[i] = tdup(s, address[i]);
	const char **pl = tmem(s, (np + 1) * sizeof *pl);
	for (size_t i = 0; i < np; i++) pl[i] = tdup(s, place[i]);
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
		s->qcap = s->qcap ? s->qcap * 2 : 8;
		s->queue = regrow(s->queue, s->qcap * sizeof(qitem *));
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
	const sc_error *e = prepare(c->s, (qitem *)c->q);
	return e ? e : go(c->s, c->q, &c->out);
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
		const sc_error *e = prepare(s, q);
		if (e) return e;
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
	vpush(&gc->p->cleanups, f);
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
		sc_ctx *ctx = tmem(s, sizeof *ctx);
		ctx->p = p;
		ctx->agent = agent;
		if (run) ctx->run_n = run->n;
		else ctx->cleanup = 1;
		ctx->run = run;
		ctx->causes = run ? run->causes : NULL;
		int *alive = tmem(s, sizeof *alive);
		*alive = 1;
		sc_given *g = given_new(s, ctx, alive);
		g->api = process_api(s, ctx, 0, 1, alive);
		g->has_killed = 1;
		g->killed = killed;
		pout done = part_call(s, p, f, g);
		*alive = 0;
		if (done.error && !first) first = done.error;
	}
	free(list.v);
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
	const sc_kill *cause;
} defer;

// a node released by a kill: the cause's, with kill added to its actor's last step, now
static const sc_change *killing(sc_sched *s, const sc_kill *cause, const char *kill,
	const char *node) {
	sc_change c = *cause->by;
	c.actor = actor_of(s, stepped_kill(s, cause->agent, kill));
	c.time = tick(s);
	c.node = node;
	c.where = GR_LOADED;
	c.name = NULL;
	return gr_change_copy(s->g, &c);
}

// unwinding, newest first: not due; children; cleanups; its ephemeral nodes; untracked
static void end(sc_sched *s, sc_proc *p, const sc_kill *cause) {
	if (p->state != RUNNING) return;
	if (busy(p)) {
		defer *d = amem(s, sizeof *d);
		d->p = p;
		d->cause = cause;
		vpush(&s->deferred, d);
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
		if (gr_get(s->g, id)) release(s, id, killing(s, cause, p->id, id));
	}
	gr_untrack(p->track);
	p->state = GONE;
	for (size_t i = 0; i < p->values.n; i++) name_add(s, p->values.v[i], -1);
	p->values.n = 0;
	// its marks, its status, its last value and the one before: let go
	for (size_t i = 0; i < p->kept.n; i++) let_mark(s, p->kept.v[i]);
	p->kept.n = 0;
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
	gr_release(s->g, id, cause);
}

// no longer loaded; a process whose node it was, killed; ephemeral nodes it owned, released
static const sc_error *outro_(sc_sched *s, const char *id, const sc_agent *who) {
	sc_kill *cause = tmem(s, sizeof *cause);
	cause->agent = who;
	cause->by = change_at(s, who, NULL, tick(s), id, GR_LOADED, NULL, NULL);
	release(s, id, cause->by);
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
	sc_kill *cause = tmem(s, sizeof *cause);
	cause->agent = stepped_kill(s, ctx->agent, ctx->p->id);
	sc_change *by = tmem(s, sizeof *by);
	*by = (sc_change){0, actor_of(s, cause->agent), ctx->p->id, NULL, NULL, "", GR_NOWHERE, NULL};
	cause->by = by;
	vec before = vcopy(s, &call->before);
	for (size_t i = before.n; i-- > 0;) {
		sc_child *c = before.v[i];
		if (vfind(&call->matched, c) >= 0 || c->proc->state != RUNNING) continue;
		sc_change k = *cause->by;
		k.time = tick(s);
		k.node = c->proc->id;
		k.where = GR_LOADED;
		release(s, c->proc->id, gr_change_copy(s->g, &k));
		end(s, c->proc, cause);
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
	if (run->has_shown) nt_set(st, "new", run->shown ? nt_ref((nt_value *)run->shown) : nt_null());
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
						let_mark(s, p->kept.v[j]);
						vdel(&p->kept, j);
						break;
					}
			}
			p->replaced = 0;
		}
		if (ended == SC_LOOPING) p->looping = 1;
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
		if (ended == SC_LOOPING) {
			nt_value *loop = nt_map();
			nt_value *through = nt_list();
			if (run->has_loop)
				for (size_t i = 0; i < run->loop.n; i++) nt_push(through, nt_str(run->loop.v[i]));
			else nt_push(through, nt_str(p->id));
			nt_set(loop, "through", through);
			if (!is_live(run->value)) nt_set(loop, "value", nt_ref((nt_value *)run->value));
			nt_set(status, "loop", loop);
		}
		if (run->has_shown) nt_set(status, "new", run->shown ? nt_ref((nt_value *)run->shown) : nt_null());
		int same = same_value(status, p->status);
		if (same) gr_later(s->g, status);
		write_run(s, p, run, ended, error, same ? NULL : status);
	}
	// what the run showed was its own: the statuses hold it
	if (run->has_shown) gr_later(s->g, (nt_value *)run->shown);
	run->has_shown = 0;
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
		om_del(&s->due, p->id);
		p->due = run->mark;
		om_set(&s->due, p->id, &p->due);
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
	if (run->has_loop && !equals) {
		run->value = v;
		{ finish(s, run, SC_LOOPING, NULL, 0); return; }
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
		vpush(&s->waiting, run);
		return;
	}
	finish(s, run, SC_DONE, NULL, 0);
}

static long rank_of(sc_sched *s, sc_proc *p);

static void first_body(sc_sched *s, sc_proc *p, sc_run *run, vec *given) {
	sc_ctx *ctx = tmem(s, sizeof *ctx);
	ctx->p = p;
	ctx->agent = run_agent(s, p, run->n);
	ctx->run_n = run->n;
	ctx->run = run;
	ctx->compute = 1;
	ctx->causes = run->causes;
	if (p->has_path) {
		int *alive = tmem(s, sizeof *alive);
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
				p->prog_node = sc_dup(s, found.node);
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
		vpush(&s->waiting, run);
		return;
	}
	// the compute
	sc_ctx *cctx = tmem(s, sizeof *cctx);
	*cctx = *ctx;
	cctx->call = partcall(s, p, "compute", run->replaced);
	int *open = tmem(s, sizeof *open);
	*open = 1;
	sc_given *g = given_new(s, cctx, open);
	g->api = process_api(s, cctx, 1, 0, open);
	g->peep = process_api(s, cctx, 0, 0, open);
	g->nby = given->n;
	g->by = tmem(s, (given->n + 1) * sizeof *g->by);
	g->marks = tmem(s, (given->n + 1) * sizeof *g->marks);
	for (size_t i = 0; i < given->n; i++) {
		g->by[i] = ((sc_kept *)given->v[i])->by->time;
		g->marks[i] = ((sc_kept *)given->v[i])->by;
	}
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
		if (k->causes && vfind(&parents, k->causes) < 0) tpush(s, &parents, k->causes);
	}
	sc_cause **ps = tmem(s, (parents.n + 1) * sizeof *ps);
	for (size_t i = 0; i < parents.n; i++) ps[i] = parents.v[i];
	sc_cause *causes = cause_new(s, p->id, ps, parents.n);
	om_set(&s->ran, p->id, (void *)1);
	sc_run *run = tmem(s, sizeof *run);
	vpush(&s->wrote, &run->wrote);
	run->p = p;
	run->n = n;
	run->mark = mark_time;
	run->rank = rank;
	run->given = given;
	run->causes = causes;
	run->replaced = p->replaced;
	run->has_loop = p->has_loop;
	run->loop = vcopy(s, &p->loop);
	p->has_loop = 0;
	sc_moment m = {.kind = SC_STARTS, .id = p->id, .has_run = 1, .run = n, .has_rank = 1, .rank = rank};
	pass(s, &m);
	gr_begin(p->track);
	first_body(s, p, run, &given);
	gr_end(p->track);
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
	sc_ctx *ctx = tmem(s, sizeof *ctx);
	ctx->p = p;
	ctx->agent = agent;
	ctx->run_n = run->n;
	ctx->run = run;
	ctx->causes = run->causes;
	ctx->call = partcall(s, p, run->part, run->replaced);
	int is_effect = !strcmp(run->part, "effect");
	if (is_effect) ctx->cause = run->why;
	int *alive = tmem(s, sizeof *alive);
	*alive = 1;
	sc_given *g = given_new(s, ctx, alive);
	g->api = process_api(s, ctx, 0, 1, alive);
	if (is_effect) {
		g->value = (nt_value *)run->value;
		if (p->has_previous) g->previous = (nt_value *)p->previous;
		pout out = part_call(s, p, p->code.effect, g);
		*alive = 0;
		if (p->has_previous) gr_later(s->g, (nt_value *)p->previous);
		p->has_previous = 1;
		p->previous = nt_ref((nt_value *)run->value);
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
		if (q && q->state == RUNNING) tpush(s, out, q);
	}
	if (p->after && p->after != p && p->after->state == RUNNING) tpush(s, out, p->after);
}

typedef struct {
	long next;
	vec stack;
} tj;

static void visit(sc_sched *s, tj *t, sc_proc *p) {
	p->tj_seen = 1;
	p->tj_index = p->tj_low = t->next++;
	tpush(s, &t->stack, p);
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
		tpush(s, &members, m);
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
		go(s, q, &out);
	}
	s->qhead = s->nqueue = 0;
	return ok;
}

// a protect value copied into a
static pr_value pr_keep(pr_arena *a, const pr_value *v) {
	pr_value c = *v;
	if (v->kind == PR_STR) return pr_str(a, v->str, v->n);
	if (v->kind == PR_LIST) {
		c = pr_list();
		for (size_t i = 0; i < v->n; i++) pr_push(a, &c, pr_keep(a, &v->items[i]));
	} else if (v->kind == PR_MAP) {
		c = pr_map();
		for (size_t i = 0; i < v->n; i++)
			pr_put(a, &c, pr_str(a, v->keys[i], strlen(v->keys[i])).str, pr_keep(a, &v->items[i]));
	}
	return c;
}
static const char *text_keep(arena *a, const char *t) {
	if (!t) return NULL;
	size_t n = strlen(t) + 1;
	return memcpy(aalloc(a, n), t, n);
}
// an error a request gives the host: copied into the host's scratch, the request's going now
static const sc_error *error_keep(sc_sched *s, const sc_error *e) {
	if (!e || e == &STOP_ERR) return e;
	sc_error *c = aalloc(&s->hosts, sizeof *c);
	*c = *e;
	c->name = text_keep(&s->hosts, e->name);
	c->code = text_keep(&s->hosts, e->code);
	c->message = text_keep(&s->hosts, e->message);
	if (e->why) {
		pr_value *w = pr_alloc(&s->phost, sizeof *w);
		*w = pr_keep(&s->phost, e->why);
		c->why = w;
	}
	return c;
}

// what a request made that nothing keeps, gone as it ends: its runs' times, the marks let go of,
// the agent kept for the last run, its scratch and the graph's
static void request_end(sc_sched *s) {
	for (size_t i = 0; i < s->wrote.n; i++) free(((gr_times *)s->wrote.v[i])->v);
	s->wrote.n = 0;
	for (size_t i = 0; i < s->dead.n; i++) free(s->dead.v[i]);
	s->dead.n = 0;
	s->kept.agent = NULL;
	s->kept.p = NULL;
	s->kept.status = NULL;
	afree(&s->req);
	pr_free(&s->preq);
	s->inside = 0;
	gr_leave(s->g);
}

void sc_sweep(sc_sched *s) {
	if (s->inside) return;
	s->kept.agent = NULL;
	s->kept.p = NULL;
	s->kept.status = NULL;
	afree(&s->hosts);
	pr_free(&s->phost);
	gr_sweep(s->g);
}

static const sc_error *request(sc_sched *s, req_fn fn, void *ctx) {
	if (s->depth > 0 || s->active > 0) return fn(ctx);
	// outside a request the scratch was the host's: the agent kept for a run may be in it
	s->kept.agent = NULL;
	s->kept.p = NULL;
	s->kept.status = NULL;
	s->inside = 1;
	gr_enter(s->g);
	s->depth++;
	// a request that fails still runs what its changes made due; then its error goes on
	const sc_error *out = fn(ctx);
	while (s->due.live || s->qhead < s->nqueue)
		if (!round_(s)) break;
	s->depth--;
	vec ids = {0};
	for (size_t i = 0; i < s->due.n; i++)
		if (s->due.e[i].key) tpush(s, &ids, (void *)s->due.e[i].key);
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
	out = error_keep(s, out);
	request_end(s);
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
	gr_acting who = {actor_of(r->s, r->s->host_actor), NULL, NULL, NULL};
	return from_gr(r->s, gr_intro(r->s->g, r->node, &who));
}
static const sc_error *outro_run(void *p) {
	hreq *r = p;
	return outro_(r->s, r->id, r->s->host_actor);
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
int sc_ephemeral(sc_sched *s, const char *id) { return gr_ephemeral(s->g, id); }

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
		const sc_error *e = prepare(s, q);
		if (e) return e;
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
	const pl_item *item;
	const sc_error *e = reach(s, NULL, 0, r->address, r->n, &item);
	if (e) return e;
	asks_t as = {0};
	asks_addall(s, &as, route_asks(s, item->route, item->nroute));
	pr_value ov = pr_lit("value"), av = pr_num(0);
	asks_add(s, &as, pr_edit(tpra(s), "write", item->id, &ov, &av));
	e = asking(s, s->host_actor, &as, "replace");
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

// INTERNAL AND DANGEROUS (WIRING.tex, In): see gr_versions
typedef struct {
	sc_sched *s;
	const char *id;
	gr_where where;
	const char *name;
	const gr_incoming *list;
	size_t count;
	const gr_from *from;
} vreq;
static const sc_error *versions_run(void *p) {
	vreq *r = p;
	gr_versions(r->s->g, r->id, r->where, r->name, r->list, r->count, r->from);
	return NULL;
}
void sc_versions(sc_sched *s, const char *id, gr_where where, const char *name,
	const gr_incoming *list, size_t count, const gr_from *from) {
	vreq r = {s, id, where, name, list, count, from};
	request(s, versions_run, &r);
}

sc_sched *sc_new(const sc_options *o) {
	sc_sched *s = calloc(1, sizeof *s);
	if (!s) die("out of memory");
	s->own_clock = 0;
	s->clock = o->clock ? o->clock : &s->own_clock;
	s->host_actor = o->actor ? o->actor : sc_agent_of(s, o->host ? o->host : "host");
	if (o->nhooks) {
		s->hooks = amem(s, o->nhooks * sizeof *s->hooks);
		memcpy(s->hooks, o->hooks, o->nhooks * sizeof *s->hooks);
		s->nhooks = o->nhooks;
	}
	s->finder = o->finder;
	s->finder_ctx = o->finder_ctx;
	s->fresh = o->id;
	s->fresh_ctx = o->id_ctx;
	s->changed = o->changed;
	s->changed_ctx = o->changed_ctx;
	gr_options go = {0};
	go.root = o->root;
	go.actor = actor_of(s, s->host_actor);
	go.clock = s->clock;
	go.id = on_id;
	go.may = o->may;
	go.marked = on_marked;
	go.owned = on_owned;
	go.released = on_released;
	if (o->changed) go.changed = on_changed;
	go.ctx = s;
	s->g = gr_new(&go);
	gr_bind b = {0};
	b.agent = go.actor;
	b.site = 1;
	b.writes = 1;
	b.reading = reading;
	b.around = around;
	b.ctx = &s->host;
	s->host = (sc_api){s, gr_bound(s->g, &b), NULL, 0};
	return s;
}

void sc_free(sc_sched *s) {
	for (size_t i = 0; i < s->wrote.n; i++) free(((gr_times *)s->wrote.v[i])->v);
	for (size_t i = 0; i < s->dead.n; i++) free(s->dead.v[i]);
	// each process's holds let go, and what it grew
	for (size_t i = 0; i < s->all.n; i++) {
		sc_proc *p = s->all.v[i];
		nt_free(p->status);
		if (p->has_last) nt_free((nt_value *)p->last);
		if (p->has_previous) nt_free((nt_value *)p->previous);
		for (size_t k = 0; k < p->kept.n; k++) free(p->kept.v[k]);
		vec *vs[] = {&p->children, &p->owned, &p->kept, &p->values, &p->cleanups, &p->loop};
		for (size_t k = 0; k < sizeof vs / sizeof *vs; k++) free(vs[k]->v);
	}
	vec *vs[] = {&s->all, &s->dead, &s->waiting, &s->deferred, &s->wrote, &s->stamped};
	for (size_t k = 0; k < sizeof vs / sizeof *vs; k++) free(vs[k]->v);
	free(s->queue);
	omap *maps[] = {&s->procs, &s->due, &s->runs, &s->ran, &s->named};
	for (size_t k = 0; k < sizeof maps / sizeof *maps; k++) om_free(maps[k]);
	gr_free(s->g);
	pr_free(&s->pra);
	pr_free(&s->preq);
	pr_free(&s->phost);
	afree(&s->a);
	afree(&s->req);
	afree(&s->hosts);
	free(s);
}
