// the scheduler in C: scheduler.h. a port of typescript/scheduler.ts, step for step.
#include "scheduler.h"

#include <stdlib.h>
#include <string.h>

#include "causes.h"
#include "order.h"
#include "ptrmap.h"
#include "tracker.h"

#define VEC_PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

typedef enum { ALIVE, DISPOSING, GONE } state_t;
typedef enum { PLAIN, COMPUTE, EFFECT } kind_t;

typedef struct cleanup {
	char *(*f)(void *);
	void *data;
} cleanup;

// an effect's value waiting for the round's acts
typedef struct act {
	sc_run *r;
	void *value;
} act;

// a scope; a computation is one with a kind and the rest
struct sc_scope {
	sc_scheduler *s;
	uint64_t n;
	sc_scope *parent;
	// its info, borrowed; a computation's: run_info, its latest run's
	const sc_pair *info;
	size_t ninfo;
	sc_scope **children;
	size_t nchildren, capchildren;
	cleanup *cleanups;
	size_t ncleanups, capcleanups;
	state_t state;
	kind_t kind;
	void *user;
	// computations
	od_item od;
	cs_item cs;
	sc_def def;
	tg_node *node;
	unsigned runs;
	// a compute's: the last result given to set; an effect's: the last acted on
	bool has_last;
	void *last;
	// its latest run, held: what by names for it (sc_latest)
	sc_run *ran;
	// its latest run's info, and what its values point at
	sc_pair run_info[2];
	uint64_t run_number, run_mark;
	// an effect's: at its last act, the scopes made up to then and its cleanups' count. what was
	// made under it since goes before each run
	uint64_t acted_n;
	size_t acted_cleanups;
	// the keys it is the writer of
	pm wrote;
	sc_scope **loop;
	size_t nloop;
	bool looping;
	act *acting;
};

// pulse: the pulse its cause is of (cause_of). cut: a loop mark it made was dropped
struct sc_run {
	sc_scheduler *s;
	sc_scope *c;
	unsigned n;
	uint64_t mark;
	uint64_t pulse;
	bool cut;
	// the causes of the marks this run was given
	cs_cause **given;
	size_t ngiven;
	cs_cause *cause;
	// the writers of the keys it read; once order has them, they are order's
	pm *values;
	bool adopted;
	bool open;
	sc_scope *stopped;
	sc_scope **loop;
	size_t nloop;
	// the keys it read, in order, for the moment it ends (kept only for a hook)
	const void **reads;
	size_t nreads, capreads;
	size_t refs;
};

typedef struct landed {
	sc_run *r;
	sc_out_kind kind;
	void *value;
	char *error;
} landed;

struct sc_promise {
	sc_scheduler *s;
	// the run awaiting it, held
	sc_run *r;
	bool settled;
	sc_out_kind kind;
	void *value;
	char *error;
};

struct sc_scheduler {
	sc_options opt;
	// a node per key read
	pm nodes;
	// each key's writer: the computation whose run or set last said it changed
	pm writers;
	order *order;
	causes *causes;
	size_t nlive;
	sc_scope **all;
	size_t nall, capall;
	// the effects to act, in the order their runs ended
	act **acts;
	size_t nacts, headacts, capacts;
	// settled promises, for the next pulse
	landed *landed;
	size_t nlanded, headlanded, caplanded;
	uint64_t made;
	uint64_t tick;
	// pulses ended: the one going on, or next
	uint64_t pulses;
	bool pulsing;
	// the run whose reads are tracked; the run whose f, set, act or cleanups are going on (what
	// is made then carries its cause)
	sc_run *reading;
	sc_run *running;
	// what is open: the scope, and its writer
	sc_scope *open;
	sc_run *open_by;
	size_t swept;
};

static void *xalloc(size_t n) {
	void *p = calloc(1, n);
	if (p == NULL) abort();
	return p;
}

static void tell(sc_scheduler *s, sc_moment m) {
	if (s->opt.hook) s->opt.hook(&m, s->opt.data);
}

static void drop_value(sc_scheduler *s, void *v) {
	if (v != NULL && s->opt.drop) s->opt.drop(v, s->opt.data);
}

static bool same(const sc_scope *c, const void *a, const void *b) {
	return c->def.equal ? c->def.equal(a, b, c->def.data) : a == b;
}

// runs

static sc_run *ran_ref(sc_run *r) {
	r->refs++;
	return r;
}

static void ran_release(sc_run *r) {
	if (--r->refs > 0) return;
	for (size_t i = 0; i < r->ngiven; i++) cs_release(r->given[i]);
	free(r->given);
	cs_release(r->cause);
	if (!r->adopted && r->values) {
		pm_clear(r->values);
		free(r->values);
	}
	free(r->loop);
	free(r->reads);
	free(r);
}

sc_run *sc_run_ref(sc_run *run) { return ran_ref(run); }
void sc_run_unref(sc_run *run) { ran_release(run); }
sc_run *sc_latest(sc_scope *o) { return o->kind == PLAIN ? NULL : o->ran; }
sc_computation *sc_run_of(const sc_run *run) { return run->c; }

// a key nobody reads now: forgotten
static void unread(sc_scheduler *s, const void *key) {
	tg_node *node = pm_get(&s->nodes, key);
	if (node == NULL || node->first != NULL) return;
	tg_node_free(node);
	pm_delete(&s->nodes, key);
	if (s->opt.forget) s->opt.forget(key, s->opt.data);
}

// the keys of the links from l on
static const void **keys_from(tg_link *l, size_t *n) {
	*n = 0;
	for (tg_link *x = l; x != NULL; x = x->next) (*n)++;
	if (*n == 0) return NULL;
	const void **keys = xalloc(*n * sizeof *keys);
	size_t k = 0;
	for (tg_link *x = l; x != NULL; x = x->next) keys[k++] = x->to->owner;
	return keys;
}

// a run's end: the tracker drops the links after its cursor, what the run did not read again;
// the keys nobody reads now are forgotten
static void end_run(sc_scheduler *s, tg_node *f) {
	size_t n;
	const void **stale = keys_from(f->cursor != NULL ? f->cursor->next : f->reads, &n);
	tg_end(f);
	for (size_t i = 0; i < n; i++) unread(s, stale[i]);
	free(stale);
}

// scopes

static sc_scope *make_scope(sc_scheduler *s, kind_t kind, sc_scope *parent, const sc_pair *info,
	size_t n) {
	sc_scope *o = xalloc(sizeof *o);
	o->s = s;
	o->n = ++s->made;
	o->parent = parent;
	o->info = info;
	o->ninfo = n;
	o->kind = kind;
	o->state = ALIVE;
	o->od.owner = o;
	o->od.n = o->n;
	o->od.alive = true;
	o->cs.owner = o;
	o->cs.n = o->n;
	if (parent) VEC_PUSH(parent->children, parent->nchildren, parent->capchildren, o);
	VEC_PUSH(s->all, s->nall, s->capall, o);
	return o;
}

sc_scheduler *sc_new(sc_options options) {
	sc_scheduler *s = xalloc(sizeof *s);
	s->opt = options;
	s->order = od_new();
	s->causes = cs_new();
	return s;
}

sc_scope *sc_root(sc_scheduler *s, const sc_pair *info, size_t n) {
	return make_scope(s, PLAIN, NULL, info, n);
}

sc_scope *sc_scope_new(sc_scheduler *s, const sc_pair *info, size_t n, sc_scope *parent) {
	if (parent == NULL) parent = s->open;
	if (parent == NULL || parent->state != ALIVE) return NULL;
	return make_scope(s, PLAIN, parent, info, n);
}

void sc_scope_set(sc_scope *o, void *user) { o->user = user; }
void *sc_scope_user(const sc_scope *o) { return o->user; }
bool sc_scope_alive(const sc_scope *o) { return o->state == ALIVE; }
sc_scope *sc_scope_parent(const sc_scope *o) { return o->parent; }
const sc_pair *sc_scope_info(const sc_scope *o, size_t *n) {
	*n = o->ninfo;
	return o->info;
}

sc_scope *sc_current(const sc_scheduler *s) { return s->open; }
sc_run *sc_current_by(const sc_scheduler *s) { return s->open_by; }

size_t sc_pairs(const sc_scheduler *s, sc_pair *out, size_t cap) {
	size_t total = 0;
	for (const sc_scope *o = s->open; o != NULL; o = o->parent) total += o->ninfo;
	// from the one open up, each scope's info into its place from the end
	size_t end = total;
	for (const sc_scope *o = s->open; o != NULL; o = o->parent) {
		end -= o->ninfo;
		for (size_t i = 0; i < o->ninfo; i++)
			if (end + i < cap) out[end + i] = o->info[i];
	}
	return total;
}

// what was open, to put back
typedef struct {
	sc_scope *scope;
	sc_run *by;
} opened;

// o open as a cleanup opens it: a computation's written by it, any other's by the writer open
static opened opens(sc_scope *o) {
	sc_scheduler *s = o->s;
	opened was = {s->open, s->open_by};
	s->open = o;
	if (o->kind != PLAIN) s->open_by = o->ran;
	return was;
}

static void reopen(sc_scheduler *s, opened was) {
	s->open = was.scope;
	s->open_by = was.by;
}

// a cleanup opens its scope
static char *call_cleanup(sc_scope *o, cleanup k) {
	opened was = opens(o);
	char *e = k.f(k.data);
	reopen(o->s, was);
	return e;
}

char *sc_cleanup(sc_scheduler *s, char *(*f)(void *), void *data) {
	sc_scope *o = s->open;
	if (o == NULL) {
		char *e = xalloc(sizeof SC_UNSCOPED);
		memcpy(e, SC_UNSCOPED, sizeof SC_UNSCOPED);
		return e;
	}
	if (o->state == ALIVE) {
		VEC_PUSH(o->cleanups, o->ncleanups, o->capcleanups, ((cleanup){f, data}));
		return NULL;
	}
	return call_cleanup(o, (cleanup){f, data});
}

static void unact(sc_scheduler *s, sc_scope *c) {
	act *a = c->acting;
	for (size_t i = s->headacts; i < s->nacts; i++) {
		if (s->acts[i] != a) continue;
		memmove(&s->acts[i], &s->acts[i + 1], (s->nacts - i - 1) * sizeof *s->acts);
		s->nacts--;
		break;
	}
	c->acting = NULL;
	drop_value(s, a->value);
	ran_release(a->r);
	free(a);
}

// a computation going: not due, untracked, the writer of nothing, its act undone. the keys
// nobody reads now are forgotten
static void drop_computation(sc_scheduler *s, sc_scope *c) {
	s->nlive--;
	od_gone(s->order, &c->od);
	size_t nread;
	const void **read = keys_from(c->node->reads, &nread);
	tg_untrack(c->node, NULL);
	for (size_t i = 0; i < nread; i++) unread(s, read[i]);
	free(read);
	for (size_t i = 0; i < c->wrote.cap; i++) {
		const void *k = c->wrote.keys[i];
		if (k != NULL && pm_get(&s->writers, k) == c) pm_delete(&s->writers, k);
	}
	pm_clear(&c->wrote);
	if (c->acting) unact(s, c);
	cs_forget(&c->cs);
}

static char *dispose(sc_scope *o);

// the first error is kept, the rest freed
static void first_error(char **failed, char *e) {
	if (e == NULL) return;
	if (*failed == NULL) *failed = e;
	else free(e);
}

// what is under o, newest first, then its cleanups, newest first; o stays. the first error.
// after, from: only the scopes made after the after-th, and the cleanups from the from-th on.
// what is under o goes with o open, as its cleanups do: under a computation, written by it
static char *clean(sc_scope *o, uint64_t after, size_t from) {
	char *failed = NULL;
	size_t k = o->nchildren;
	while (k > 0 && o->children[k - 1]->n > after) k--;
	size_t nkids = o->nchildren - k;
	sc_scope **kids = NULL;
	if (nkids > 0) {
		kids = xalloc(nkids * sizeof *kids);
		memcpy(kids, o->children + k, nkids * sizeof *kids);
	}
	o->nchildren = k;
	opened was = opens(o);
	for (size_t i = nkids; i > 0; i--) first_error(&failed, dispose(kids[i - 1]));
	reopen(o->s, was);
	free(kids);
	size_t nfs = o->ncleanups > from ? o->ncleanups - from : 0;
	cleanup *fs = NULL;
	if (nfs > 0) {
		fs = xalloc(nfs * sizeof *fs);
		memcpy(fs, o->cleanups + from, nfs * sizeof *fs);
	}
	if (o->ncleanups > from) o->ncleanups = from;
	for (size_t i = nfs; i > 0; i--) first_error(&failed, call_cleanup(o, fs[i - 1]));
	free(fs);
	return failed;
}

static char *dispose(sc_scope *o) {
	if (o->state != ALIVE) return NULL;
	o->state = DISPOSING;
	if (o->kind != PLAIN) {
		o->od.alive = false;
		drop_computation(o->s, o);
	}
	char *failed = clean(o, 0, 0);
	o->state = GONE;
	// gone: by it names no run
	if (o->kind != PLAIN && o->ran) {
		ran_release(o->ran);
		o->ran = NULL;
	}
	sc_scope *p = o->parent;
	if (p) {
		for (size_t i = p->nchildren; i > 0; i--) {
			if (p->children[i - 1] != o) continue;
			memmove(&p->children[i - 1], &p->children[i], (p->nchildren - i) * sizeof *p->children);
			p->nchildren--;
			break;
		}
	}
	return failed;
}

char *sc_dispose(sc_scope *o) { return dispose(o); }

const char *sc_setup(sc_scope *o, void (*f)(void *), void *data) {
	if (o->state != ALIVE) return SC_DISPOSED;
	sc_scheduler *s = o->s;
	sc_run *was = s->reading;
	sc_scope *wasopen = s->open;
	s->reading = NULL;
	s->open = o;
	f(data);
	s->reading = was;
	s->open = wasopen;
	return NULL;
}

// marks

// a run's cause; one from an earlier pulse is cut to its computation alone, of this pulse:
// nothing is kept past the pulse
static cs_cause *cause_of(sc_scheduler *s, sc_run *r) {
	if (r->pulse != s->pulses) {
		cs_release(r->cause);
		r->cause = cs_run(s->causes, &r->c->cs, NULL, 0);
		r->pulse = s->pulses;
	}
	return r->cause;
}

// by: the run that made the change
static void mark(sc_scheduler *s, sc_scope *c, uint64_t t, sc_run *by) {
	if (c->state != ALIVE) return;
	cs_cause *cause = by ? cause_of(s, by) : NULL;
	if (cause) cs_keep(s->causes, &c->cs, cause);
	size_t n = 0;
	cs_item **items = cs_loop(s->causes, cause, &c->cs, &n);
	sc_scope **loop = NULL;
	if (items) {
		loop = xalloc(n * sizeof *loop);
		for (size_t i = 0; i < n; i++) loop[i] = items[i]->owner;
		free(items);
	}
	// a loop mark from a run known to loop: the loop is cut there, and the run ends looping
	if (loop && by->nloop > 0) {
		by->cut = true;
		free(loop);
		return;
	}
	free(c->loop);
	c->loop = loop;
	c->nloop = loop ? n : 0;
	// a looping computation is due again only by a change from outside the loop
	if (c->looping) {
		if (loop) return;
		c->looping = false;
	}
	if (od_has(s->order, &c->od)) return;
	od_set(s->order, &c->od, t);
	tell(s, (sc_moment){.kind = SC_DUE, .c = c, .tick = t, .equal = -1, .by = by ? by->c : NULL});
}

static void write(sc_scheduler *s, sc_scope *c, const void *key) {
	sc_scope *was = pm_get(&s->writers, key);
	if (was == c) return;
	if (was) pm_delete(&was->wrote, key);
	pm_set(&s->writers, key, c);
	pm_set(&c->wrote, key, NULL);
}

uint64_t sc_changed(sc_scheduler *s, const void *const *keys, size_t count, sc_run *by) {
	uint64_t t = ++s->tick;
	sc_scope *w = by && by->c->kind == COMPUTE && by->c->state == ALIVE ? by->c : NULL;
	for (size_t i = 0; i < count; i++) {
		const void *key = keys[i];
		if (w) write(s, w, key);
		tg_node *node = pm_get(&s->nodes, key);
		if (node == NULL) continue;
		for (tg_link *l = node->first; l != NULL; l = l->after) mark(s, l->from->owner, t, by);
	}
	return t;
}

// reads

static bool waits_after(sc_scheduler *s, od_item *w, sc_scope *c) {
	size_t steps = 0;
	for (od_item *x = w->after; x && steps <= s->nlive; x = x->after, steps++)
		if (x == &c->od) return true;
	return false;
}

// a key read in r: tracked. its writer due, the run stops: unless the writer waits after r's, or
// is due by r's own doing (a loop, with no after in it)
static sc_read_status track(sc_scheduler *s, sc_run *r, const void *key) {
	if (r->stopped) return SC_STOP;
	sc_scope *c = r->c;
	if (c->state != ALIVE) return SC_OK;
	tg_node *node = pm_get(&s->nodes, key);
	if (node == NULL) {
		node = tg_node_new((void *)key);
		if (node == NULL) abort();
		pm_set(&s->nodes, key, node);
	}
	if (tg_track(c->node, node) != 0) abort();
	if (s->opt.hook) VEC_PUSH(r->reads, r->nreads, r->capreads, key);
	sc_scope *w = pm_get(&s->writers, key);
	if (w == NULL || w == c) return SC_OK;
	if (r->values == NULL) r->values = xalloc(sizeof *r->values);
	pm_set(r->values, &w->od, NULL);
	if (od_has(s->order, &w->od) && !waits_after(s, &w->od, c) && !cs_from(s->causes, &w->cs, &c->cs)) {
		r->stopped = w;
		return SC_STOP;
	}
	return SC_OK;
}

sc_read_status sc_read(sc_scheduler *s, const void *key) {
	return s->reading ? track(s, s->reading, key) : SC_OK;
}

sc_read_status sc_run_read(sc_run *r, const void *key) {
	if (!r->open) return SC_CLOSED;
	return track(r->s, r, key);
}

// runs

static void finish(sc_scheduler *s, sc_run *r, sc_ended ended, int equal, char *error,
	sc_scope *waits, sc_scope *const *through, size_t nthrough) {
	sc_scope *c = r->c;
	if (c->state == ALIVE) {
		if (ended == SC_DONE) {
			for (size_t i = 0; i < r->ngiven; i++)
				if (pm_delete(&c->cs.kept, r->given[i])) cs_release(r->given[i]);
		}
		if (ended == SC_LOOPING) c->looping = true;
		if (ended != SC_STOPPED_RUN) {
			od_sees(s->order, &c->od, r->values);
			r->adopted = true;
		}
	}
	tell(s, (sc_moment){.kind = SC_ENDS,
		.c = c,
		.run = r->n,
		.ended = ended,
		.equal = equal,
		.error = error,
		.waits = waits,
		.through = through,
		.nthrough = nthrough,
		.reads = r->reads,
		.nreads = r->nreads});
	free(error);
}

// a result: equal to the last, it stops there. a compute's goes to set; an effect's waits for
// the acts, the latest one
static void result(sc_scheduler *s, sc_run *r, void *v) {
	sc_scope *c = r->c;
	bool equal = c->has_last && same(c, v, c->last);
	// flagged: a new result, or a loop it cut, ends looping
	if (r->nloop > 0 && (!equal || r->cut)) {
		drop_value(s, v);
		finish(s, r, SC_LOOPING, equal, NULL, NULL, r->loop, r->nloop);
		return;
	}
	if (c->kind == EFFECT) {
		if (!equal) {
			act *a = xalloc(sizeof *a);
			a->r = ran_ref(r);
			a->value = v;
			VEC_PUSH(s->acts, s->nacts, s->capacts, a);
			c->acting = a;
		} else {
			drop_value(s, v);
		}
		finish(s, r, SC_DONE, equal, NULL, NULL, NULL, 0);
		return;
	}
	if (!equal) {
		sc_run *was = s->reading, *wasRunning = s->running, *wasby = s->open_by;
		sc_scope *wasopen = s->open;
		s->reading = NULL;
		s->running = r;
		s->open = c;
		s->open_by = c->ran;
		char *failed = c->def.set(v, c->def.data);
		s->reading = was;
		s->running = wasRunning;
		s->open = wasopen;
		s->open_by = wasby;
		if (failed) {
			drop_value(s, v);
			// a set that threw may have written part: the last is forgotten, so the next result
			// is given to set, equal or not
			if (c->has_last) drop_value(s, c->last);
			c->last = NULL;
			c->has_last = false;
			finish(s, r, SC_FAIL, 0, failed, NULL, NULL, 0);
			return;
		}
		if (c->has_last) drop_value(s, c->last);
		c->last = v;
		c->has_last = true;
	} else {
		drop_value(s, v);
	}
	finish(s, r, SC_DONE, equal, NULL, NULL, NULL, 0);
}

// a promise: the run ends pending; its settling, unless run again or gone since, lands at the
// next pulse. due again by then (what it read changed): it lands nowhere, the next run does
static void deliver(sc_promise *p) {
	sc_scheduler *s = p->s;
	sc_run *r = p->r;
	p->r = NULL;
	if (r->c->state != ALIVE || r->c->runs != r->n) {
		drop_value(s, p->value);
		free(p->error);
		p->value = NULL;
		p->error = NULL;
		ran_release(r);
		return;
	}
	landed l = {r, p->kind, p->value, p->error};
	p->value = NULL;
	p->error = NULL;
	VEC_PUSH(s->landed, s->nlanded, s->caplanded, l);
	if (s->opt.wake) s->opt.wake(s->opt.data);
}

static void awaiting(sc_scheduler *s, sc_run *r, sc_promise *p) {
	finish(s, r, SC_PENDED, -1, NULL, NULL, NULL, 0);
	if (p->r) ran_release(p->r);
	p->r = ran_ref(r);
	if (p->settled) deliver(p);
}

static void land(sc_scheduler *s, landed l) {
	sc_run *r = l.r;
	if (r->c->state != ALIVE || r->c->runs != r->n || od_has(s->order, &r->c->od)) {
		drop_value(s, l.value);
		free(l.error);
	} else if (l.kind == SC_FAILED) {
		finish(s, r, SC_FAIL, -1, l.error, NULL, NULL, 0);
	} else if (l.kind == SC_PENDING) {
		finish(s, r, SC_PENDED, -1, NULL, NULL, NULL, 0);
	} else {
		result(s, r, l.value);
	}
	ran_release(r);
}

static void discard(sc_scheduler *s, sc_out out) {
	if (out.kind == SC_VALUE) drop_value(s, out.value);
	else if (out.kind == SC_FAILED) free(out.error);
}

static void first(sc_scheduler *s, sc_scope *c, int rank) {
	uint64_t mark = od_at(&c->od);
	od_delete(s->order, &c->od);
	od_waits(s->order, &c->od, NULL);
	unsigned n = ++c->runs;
	size_t ngiven = c->cs.kept.count;
	sc_run *r = xalloc(sizeof *r);
	r->refs = 1;
	r->s = s;
	r->c = c;
	r->n = n;
	r->mark = mark;
	r->open = true;
	r->pulse = s->pulses;
	if (ngiven > 0) {
		r->given = xalloc(ngiven * sizeof *r->given);
		size_t k = 0;
		for (size_t i = 0; i < c->cs.kept.cap; i++)
			if (c->cs.kept.keys[i] != NULL) r->given[k++] = cs_ref((cs_cause *)c->cs.kept.keys[i]);
		r->ngiven = k;
	}
	r->cause = cs_run(s->causes, &c->cs, r->given, r->ngiven);
	r->loop = c->loop;
	r->nloop = c->nloop;
	c->loop = NULL;
	c->nloop = 0;
	if (c->ran) ran_release(c->ran);
	c->ran = ran_ref(r);
	// an effect acts on its latest run's value only
	if (c->acting) unact(s, c);
	tell(s, (sc_moment){.kind = SC_STARTS, .c = c, .run = n, .rank = rank, .equal = -1});
	sc_run *was = s->reading, *wasRunning = s->running;
	s->running = r;
	// what is under it goes first: all of a compute's; of an effect's, what was made since its
	// last act. disposed by a cleanup: nothing more
	char *before = c->kind == COMPUTE ? clean(c, 0, 0) : clean(c, c->acted_n, c->acted_cleanups);
	if (c->state != ALIVE) {
		s->running = wasRunning;
		free(before);
		ran_release(r);
		return;
	}
	// its info, from here: this run's number, and the tick of the mark that made it due
	c->run_number = n;
	c->run_mark = mark;
	c->run_info[0] = (sc_pair){"run", &c->run_number};
	c->run_info[1] = (sc_pair){"mark", &c->run_mark};
	c->info = c->run_info;
	c->ninfo = 2;
	sc_scope *wasopen = s->open;
	sc_run *wasby = s->open_by;
	s->reading = r;
	s->open = c;
	s->open_by = r;
	tg_begin(c->node);
	sc_out out = c->def.f(r, c->def.data);
	r->open = false;
	s->reading = was;
	s->running = wasRunning;
	s->open = wasopen;
	s->open_by = wasby;
	end_run(s, c->node);
	if (c->state != ALIVE) {
		discard(s, out);
		free(before);
	} else if (r->stopped) {
		discard(s, out);
		free(before);
		// no mark reached it in the stopped run: it runs again as flagged as it was
		if (!od_has(s->order, &c->od)) {
			free(c->loop);
			c->loop = r->loop;
			c->nloop = r->nloop;
			r->loop = NULL;
			r->nloop = 0;
		}
		od_waits(s->order, &c->od, &r->stopped->od);
		od_set(s->order, &c->od, r->mark);
		finish(s, r, SC_STOPPED_RUN, -1, NULL, r->stopped, NULL, 0);
	} else if (before) {
		discard(s, out);
		finish(s, r, SC_FAIL, -1, before, NULL, NULL, 0);
	} else if (out.kind == SC_FAILED) {
		finish(s, r, SC_FAIL, -1, out.error, NULL, NULL, 0);
	} else if (out.kind == SC_PENDING) {
		finish(s, r, SC_PENDED, -1, NULL, NULL, NULL, 0);
	} else if (out.kind == SC_AWAIT) {
		awaiting(s, r, out.promise);
	} else {
		result(s, r, out.value);
	}
	ran_release(r);
}

// acts

// what is under the effect goes, then it acts, with the value it acted on last. due again (an
// earlier act this round changed what it read): its value is old, so it does not act; its next
// run does. disposed by a cleanup: nothing more
static void do_act(sc_scheduler *s, act *a) {
	sc_scope *c = a->r->c;
	c->acting = NULL;
	char *failed = NULL;
	sc_run *was = s->reading, *wasRunning = s->running;
	bool acts = c->state == ALIVE && !od_has(s->order, &c->od);
	if (acts) {
		s->reading = NULL;
		s->running = a->r;
		failed = clean(c, 0, 0);
		acts = c->state == ALIVE;
	}
	if (!acts) {
		s->reading = was;
		s->running = wasRunning;
		free(failed);
		drop_value(s, a->value);
		ran_release(a->r);
		free(a);
		return;
	}
	sc_scope *wasopen = s->open;
	sc_run *wasby = s->open_by;
	s->open = c;
	s->open_by = c->ran;
	char *error = c->def.act(a->value, c->has_last ? c->last : NULL, c->def.data);
	s->reading = was;
	s->running = wasRunning;
	s->open = wasopen;
	s->open_by = wasby;
	first_error(&failed, error);
	if (c->has_last) drop_value(s, c->last);
	c->last = a->value;
	c->has_last = true;
	c->acted_n = s->made;
	c->acted_cleanups = c->ncleanups;
	tell(s, (sc_moment){.kind = SC_ACTS, .c = c, .run = a->r->n, .error = failed, .equal = -1});
	free(failed);
	ran_release(a->r);
	free(a);
}

// pulses

// keys nobody reads, forgotten now and then: any the ends and disposals left
static void sweep(sc_scheduler *s) {
	if (s->nodes.count < 2 * s->swept + 64) return;
	size_t n = 0;
	const void **dead = xalloc((s->nodes.count + 1) * sizeof *dead);
	for (size_t i = 0; i < s->nodes.cap; i++)
		if (s->nodes.keys[i] != NULL && ((tg_node *)s->nodes.vals[i])->first == NULL) dead[n++] = s->nodes.keys[i];
	for (size_t i = 0; i < n; i++) unread(s, dead[i]);
	free(dead);
	s->swept = s->nodes.count;
}

void sc_pulse(sc_scheduler *s) {
	if (s->pulsing) return;
	s->pulsing = true;
	for (;;) {
		while (s->headlanded < s->nlanded) land(s, s->landed[s->headlanded++]);
		s->headlanded = s->nlanded = 0;
		if (!od_size(s->order) && s->headacts == s->nacts) break;
		while (od_size(s->order)) {
			int rank;
			od_item *p = od_next(s->order, &rank);
			first(s, p->owner, rank);
		}
		while (s->headacts < s->nacts) do_act(s, s->acts[s->headacts++]);
		s->headacts = s->nacts = 0;
	}
	s->pulsing = false;
	cs_end(s->causes);
	s->pulses++;
	sweep(s);
}

uint64_t sc_tick(const sc_scheduler *s) { return s->tick; }

// computations

// under the scope open
static sc_computation *make(sc_scheduler *s, kind_t kind, sc_def def) {
	sc_scope *o = s->open;
	if (o == NULL || o->state != ALIVE) return NULL;
	sc_scope *c = make_scope(s, kind, o, NULL, 0);
	c->def = def;
	c->acted_n = c->n;
	c->node = tg_node_new(c);
	if (c->node == NULL) abort();
	s->nlive++;
	// the key its results land at, given: its writer from the start, not learned
	if (def.key) write(s, c, def.key);
	od_started(s->order, &c->od);
	// made in a run, set, act or cleanup: it carries that run's cause, so a loop through what it
	// changes is seen. made in a run known to loop: the loop is cut there, as a dropped loop mark
	// cuts it
	if (s->running && s->running->nloop > 0) s->running->cut = true;
	mark(s, c, ++s->tick, s->running);
	return c;
}

sc_computation *sc_compute(sc_scheduler *s, sc_def def) { return make(s, COMPUTE, def); }
sc_computation *sc_effect(sc_scheduler *s, sc_def def) { return make(s, EFFECT, def); }

// promises

sc_promise *sc_promise_new(sc_scheduler *s) {
	sc_promise *p = xalloc(sizeof *p);
	p->s = s;
	return p;
}

static void settle(sc_promise *p, sc_out_kind kind, void *value, char *error) {
	if (p->settled) {
		drop_value(p->s, value);
		free(error);
		return;
	}
	p->settled = true;
	p->kind = kind;
	p->value = value;
	p->error = error;
	if (p->r) deliver(p);
}

void sc_resolve(sc_promise *p, void *value) { settle(p, SC_VALUE, value, NULL); }
void sc_resolve_pending(sc_promise *p) { settle(p, SC_PENDING, NULL, NULL); }
void sc_reject(sc_promise *p, char *error) { settle(p, SC_FAILED, NULL, error); }

void sc_promise_free(sc_promise *p) {
	if (p->r) ran_release(p->r);
	drop_value(p->s, p->value);
	free(p->error);
	free(p);
}

// the end

void sc_free(sc_scheduler *s) {
	cs_end(s->causes);
	for (size_t i = 0; i < s->nall; i++)
		if (s->all[i]->kind != PLAIN) tg_untrack(s->all[i]->node, NULL);
	for (size_t i = s->headacts; i < s->nacts; i++) {
		drop_value(s, s->acts[i]->value);
		ran_release(s->acts[i]->r);
		free(s->acts[i]);
	}
	for (size_t i = s->headlanded; i < s->nlanded; i++) {
		drop_value(s, s->landed[i].value);
		free(s->landed[i].error);
		ran_release(s->landed[i].r);
	}
	for (size_t i = 0; i < s->nall; i++) {
		sc_scope *o = s->all[i];
		free(o->children);
		free(o->cleanups);
		if (o->kind != PLAIN) {
			tg_node_free(o->node);
			pm_clear(&o->wrote);
			cs_forget(&o->cs);
			if (o->od.values) {
				pm_clear(o->od.values);
				free(o->od.values);
			}
			free(o->loop);
			if (o->ran) ran_release(o->ran);
			if (o->has_last) drop_value(s, o->last);
		}
		free(o);
	}
	for (size_t i = 0; i < s->nodes.cap; i++)
		if (s->nodes.keys[i] != NULL) tg_node_free(s->nodes.vals[i]);
	pm_clear(&s->nodes);
	pm_clear(&s->writers);
	od_free(s->order);
	cs_free(s->causes);
	free(s->all);
	free(s->acts);
	free(s->landed);
	free(s);
}
