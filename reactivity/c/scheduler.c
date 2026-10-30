// The scheduler: see scheduler.h. A port of typescript/scheduler.ts.
#include "scheduler.h"

#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#include "causes.h"
#include "order.h"
#include "../../changeable/c/ptrmap.h"
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

typedef struct teardown_fn {
	char *(*f)(void *);
	void *data;
} teardown_fn;

typedef struct act {
	sc_run *r;
	void *value;
	size_t at;
} act;

#define PLAIN_SIZE offsetof(struct sc_scope, od)

static void *xalloc(size_t n);

// A scope. A computer is a scope with a kind and the fields from od on, which a plain scope never
// allocates or reads (PLAIN_SIZE).
struct sc_scope {
	sc_scheduler *s;
	uint64_t n;
	sc_scope *parent;
	ch_frame *frame;
	sc_scope *newest, *older, *newer;
	teardown_fn *teardowns;
	void *user;
	unsigned nteardowns, capteardowns;
	// Holds on it (its maker's, sc_retain's, children, runs). at is its index in all.
	size_t refs, at;
	unsigned char state;
	unsigned char kind;
	// old: made by an earlier run of its computer and not yet claimed; alive till that run is done.
	// deed: made in its effect's act, gone before the next act. listed: in unheld, to be freed as the
	// pulse ends.
	bool old, deed, listed;
	od_item od;
	cs_item cs;
	pm *spare;
	sc_def def;
	tg_node *node;
	unsigned runs;
	bool has_last;
	void *last;
	sc_run *ran;
	sc_scope *before;
	teardown_fn *deeds;
	unsigned ndeeds, capdeeds;
	bool doing;
	pm wrote;
	sc_scope **loop;
	size_t nloop;
	bool looping;
	// Cleanups going just before an act, and whether the last act skipped for one of their writes
	// (twice in a row is a loop).
	bool cleaning, cleaned;
	act *acting;
	teardown_fn *aside;
	unsigned naside, capaside;
	teardown_fn *queuedCleanups;
	unsigned nqueuedCleanups, capqueuedCleanups;
	// The loop of a run known to loop that queued them: their loop marks are cut, as its own are.
	sc_scope **cuts;
	size_t ncuts;
};

// Whether the scheduler is still there, shared with its runs. A run held past sc_free lets go of
// nothing the scheduler owned, and the last of them frees this.
typedef struct life {
	bool gone;
	size_t refs;
} life;

struct sc_run {
	sc_scheduler *s;
	life *life;
	sc_scope *c;
	unsigned n;
	uint64_t mark;
	uint64_t pulse;
	bool cut;
	ch_frame *frame;
	cs_cause **given;
	size_t ngiven, capgiven;
	cs_cause *cause;
	pm *values;
	bool adopted;
	sc_scope *stopped;
	sc_scope **loop;
	size_t nloop;
	const void **reads;
	size_t nreads, capreads;
	bool has_kept;
	const void *kept;
	bool has_step;
	sc_step step;
	size_t refs;
};

typedef struct landed {
	sc_run *r;
	sc_out_kind kind;
	void *value;
	char *error;
	bool step;
} landed;

struct sc_promise {
	sc_scheduler *s;
	sc_run **rs;
	size_t nrs, caprs;
	bool settled, given;
	sc_out_kind kind;
	void *value;
	char *error;
};

// Effects to act, in the order their runs ended, from head to n. One taken out leaves a NULL hole;
// live counts the others.
typedef struct queue {
	act **v;
	size_t n, head, cap, live;
} queue;

typedef enum { ON_TRACK, ON_MARK, ON_START, ON_RETURN, ON_END, ON_EFFECT, ON_SETTLE, ON_UNTRACK, ON_FIRST, ON_PULSED, ON_FREE, ON_KINDS } listening;

struct sc_listener {
	sc_scheduler *s;
	listening kind;
	union {
		sc_track_fn track;
		sc_mark_fn mark;
		sc_run_start_fn start;
		sc_run_return_fn ret;
		sc_run_end_fn end;
		sc_effect_fn effect;
		sc_settle_fn settle;
		sc_tracking_end_fn untrack;
		sc_after_pulse_fn pulsed;
		sc_free_fn freed;
	} f;
	void *data;
};

struct sc_scheduler {
	sc_options opt;
	sc_listener **listeners[ON_KINDS];
	size_t nlisteners[ON_KINDS], caplisteners[ON_KINDS];
	pm nodes;
	pm writers;
	order *order;
	causes *causes;
	size_t nlive;
	// Every scope not freed yet, and the computers gone and held by nothing, freed as the pulse ends
	// (causes and order may still name them until then).
	sc_scope **all;
	size_t nall, capall;
	sc_scope **unheld;
	size_t nunheld, capunheld;
	queue acts, earlies;
	landed *landed;
	size_t nlanded, headlanded, caplanded;
	sc_scope **queued;
	size_t nqueued, capqueued;
	uint64_t made;
	uint64_t tick;
	bool freeing;
	life *life;
	uint64_t pulses;
	uint64_t steps;
	bool pulsing;
	// reading: the run whose reads are tracked. running: the run whose f, set, act or teardowns are
	// going on; what is made then carries its cause.
	sc_run *reading;
	sc_run *running;
	sc_scope *open;
	ch_frame *open_frame;
	sc_run *open_writer;
	size_t swept;
	// thrown: the first error from a listener (sc_throw) or a cleanup, held until what was going on
	// finishes. escaped: what came out of the last call, for sc_escaped.
	char *thrown;
	char *escaped;
};

static sc_scope *of_od(od_item *p) { return (sc_scope *)((char *)p - offsetof(struct sc_scope, od)); }
static sc_scope *of_cs(cs_item *p) { return (sc_scope *)((char *)p - offsetof(struct sc_scope, cs)); }

static void *xalloc(size_t n) {
	void *p = calloc(1, n);
	if (p == NULL) abort();
	return p;
}

static void hold(sc_scheduler *s, char *e) {
	if (e == NULL) return;
	if (s->thrown == NULL) s->thrown = e;
	else free(e);
}
static char *unbracket(sc_scheduler *s, char *outer) {
	char *t = s->thrown;
	s->thrown = outer;
	return t;
}
static void escape(sc_scheduler *s, char *e) {
	if (e == NULL) return;
	if (s->escaped == NULL) s->escaped = e;
	else free(e);
}

void sc_throw(sc_scheduler *s, char *error) { hold(s, error); }

char *sc_escaped(sc_scheduler *s) {
	char *e = s->escaped;
	s->escaped = NULL;
	return e;
}

static sc_listener *listen(sc_scheduler *s, listening kind, sc_listener l) {
	sc_listener *x = xalloc(sizeof *x);
	*x = l;
	x->s = s;
	x->kind = kind;
	VEC_PUSH(s->listeners[kind], s->nlisteners[kind], s->caplisteners[kind], x);
	return x;
}

void sc_remove_listener(sc_listener *l) {
	sc_scheduler *s = l->s;
	sc_listener **v = s->listeners[l->kind];
	for (size_t i = 0; i < s->nlisteners[l->kind]; i++) {
		if (v[i] != l) continue;
		memmove(&v[i], &v[i + 1], (s->nlisteners[l->kind] - i - 1) * sizeof *v);
		s->nlisteners[l->kind]--;
		free(l);
		return;
	}
}

sc_listener *sc_on_track(sc_scheduler *s, sc_track_fn f, void *data) {
	return listen(s, ON_TRACK, (sc_listener){.f.track = f, .data = data});
}
sc_listener *sc_on_mark(sc_scheduler *s, sc_mark_fn f, void *data) {
	return listen(s, ON_MARK, (sc_listener){.f.mark = f, .data = data});
}
sc_listener *sc_on_run_start(sc_scheduler *s, sc_run_start_fn f, void *data) {
	return listen(s, ON_START, (sc_listener){.f.start = f, .data = data});
}
sc_listener *sc_on_run_return(sc_scheduler *s, sc_run_return_fn f, void *data) {
	return listen(s, ON_RETURN, (sc_listener){.f.ret = f, .data = data});
}
sc_listener *sc_on_run_end(sc_scheduler *s, sc_run_end_fn f, void *data) {
	return listen(s, ON_END, (sc_listener){.f.end = f, .data = data});
}
sc_listener *sc_on_effect(sc_scheduler *s, sc_effect_fn f, void *data) {
	return listen(s, ON_EFFECT, (sc_listener){.f.effect = f, .data = data});
}
sc_listener *sc_on_settle(sc_scheduler *s, sc_settle_fn f, void *data) {
	return listen(s, ON_SETTLE, (sc_listener){.f.settle = f, .data = data});
}
sc_listener *sc_on_tracking_start(sc_scheduler *s, sc_track_fn f, void *data) {
	return listen(s, ON_FIRST, (sc_listener){.f.track = f, .data = data});
}
sc_listener *sc_on_tracking_end(sc_scheduler *s, sc_tracking_end_fn f, void *data) {
	return listen(s, ON_UNTRACK, (sc_listener){.f.untrack = f, .data = data});
}
sc_listener *sc_on_after_pulse(sc_scheduler *s, sc_after_pulse_fn f, void *data) {
	return listen(s, ON_PULSED, (sc_listener){.f.pulsed = f, .data = data});
}
sc_listener *sc_on_free(sc_scheduler *s, sc_free_fn f, void *data) {
	return listen(s, ON_FREE, (sc_listener){.f.freed = f, .data = data});
}

#define EACH(s, K, member, ...) \
	for (size_t i_ = 0; i_ < (s)->nlisteners[K]; i_++) \
		(s)->listeners[K][i_]->f.member(__VA_ARGS__, (s)->listeners[K][i_]->data)

static void drop_value(sc_scheduler *s, void *v) {
	if (v != NULL && s->opt.drop) s->opt.drop(v, s->opt.data);
}

static bool same(const sc_scope *c, const void *a, const void *b) {
	return c->def.equal ? c->def.equal(a, b, c->def.data) : a == b;
}


static void free_scope(sc_scope *o);

static void let_go(sc_scope *o) {
	if (o->state != GONE || o->refs > 0 || o->listed) return;
	sc_scheduler *s = o->s;
	if (o->kind == PLAIN) {
		free_scope(o);
		return;
	}
	o->listed = true;
	VEC_PUSH(s->unheld, s->nunheld, s->capunheld, o);
}

static void unhold(sc_scope *o) {
	if (o->s->freeing) return;
	o->refs--;
	let_go(o);
}

sc_scope *sc_retain(sc_scope *o) {
	o->refs++;
	return o;
}
void sc_release(sc_scope *o) { unhold(o); }

static sc_scope **loop_hold(sc_scope **v, size_t n) {
	for (size_t i = 0; i < n; i++) v[i]->refs++;
	return v;
}
static void loop_drop(sc_scheduler *s, sc_scope **v, size_t n) {
	if (!s->freeing)
		for (size_t i = 0; i < n; i++) unhold(v[i]);
	free(v);
}


static sc_run *ran_ref(sc_run *r) {
	r->refs++;
	return r;
}

static void quit_step(sc_run *r) {
	if (!r->has_step) return;
	r->has_step = false;
	r->step.quit(r->step.data);
}

static void ran_release(sc_run *r) {
	if (--r->refs > 0) return;
	quit_step(r);
	for (size_t i = 0; i < r->ngiven; i++) cs_release(r->given[i]);
	free(r->given);
	cs_release(r->cause);
	if (!r->adopted && r->values) {
		pm_clear(r->values);
		free(r->values);
	}
	free(r->reads);
	ch_frame_free(r->frame);
	sc_scope *c = r->c;
	sc_scheduler *s = r->s;
	life *l = r->life;
	if (!l->gone) loop_drop(r->s, r->loop, r->nloop);
	else free(r->loop);
	free(r);
	if (!l->gone && !s->freeing) unhold(c);
	if (--l->refs == 0) free(l);
}

static void retire(sc_scope *c, pm *m) {
	pm_reset(m);
	if (c->spare == NULL) {
		c->spare = m;
	} else {
		pm_clear(m);
		free(m);
	}
}

static void run_reset(sc_run *r) {
	for (size_t i = 0; i < r->ngiven; i++) cs_release(r->given[i]);
	r->ngiven = 0;
	cs_release(r->cause);
	r->cause = NULL;
	if (!r->adopted && r->values) retire(r->c, r->values);
	r->values = NULL;
	r->adopted = false;
	loop_drop(r->s, r->loop, r->nloop);
	r->loop = NULL;
	r->nloop = 0;
	r->nreads = 0;
	r->stopped = NULL;
	r->cut = false;
	r->has_kept = false;
	r->kept = NULL;
	quit_step(r);
}

sc_run *sc_run_ref(sc_run *run) { return ran_ref(run); }
void sc_run_unref(sc_run *run) { ran_release(run); }
sc_run *sc_latest(sc_scope *o) { return o->kind == PLAIN ? NULL : o->ran; }
sc_computer *sc_run_computer(const sc_run *run) { return run->c; }
unsigned sc_run_n(const sc_run *run) { return run->n; }

static void unread(sc_scheduler *s, const void *key) {
	tg_node *node = pm_get(&s->nodes, key);
	if (node == NULL || node->first != NULL) return;
	tg_node_free(node);
	pm_delete(&s->nodes, key);
	EACH(s, ON_UNTRACK, untrack, key);
}

static const void **keys_from(tg_link *l, size_t *n) {
	*n = 0;
	for (tg_link *x = l; x != NULL; x = x->next) (*n)++;
	if (*n == 0) return NULL;
	const void **keys = xalloc(*n * sizeof *keys);
	size_t k = 0;
	for (tg_link *x = l; x != NULL; x = x->next) keys[k++] = x->to->owner;
	return keys;
}

static void trim_run(sc_scheduler *s, tg_node *f) {
	size_t n;
	const void **stale = keys_from(f->cursor != NULL ? f->cursor->next : f->reads, &n);
	if (n == 0) return;
	tg_trim(f);
	for (size_t i = 0; i < n; i++) unread(s, stale[i]);
	free(stale);
}


static ch_frame *frame_under(sc_scheduler *s, sc_scope *up) {
	if (up == NULL) return NULL;
	return s->open == up ? s->open_frame : up->frame;
}

static sc_scope *make_scope(sc_scheduler *s, kind_t kind, sc_scope *parent, const sc_pair *info,
	size_t n) {
	if (kind == PLAIN && n == 0) return NULL;
	sc_scope *o = xalloc(kind == PLAIN ? PLAIN_SIZE : sizeof *o);
	o->s = s;
	o->n = ++s->made;
	o->refs = 1;
	o->parent = parent;
	if (parent) parent->refs++;
	if (kind == PLAIN) o->frame = ch_frame_make(info, n, frame_under(s, parent));
	o->kind = kind;
	o->state = ALIVE;
	o->deed = parent && parent->kind == EFFECT && parent->doing;
	if (kind != PLAIN) {
		o->od.owner = o;
		o->od.n = o->n;
		o->od.alive = true;
		o->cs.n = o->n;
	}
	if (parent) {
		o->older = parent->newest;
		if (o->older) o->older->newer = o;
		parent->newest = o;
	}
	o->at = s->nall;
	VEC_PUSH(s->all, s->nall, s->capall, o);
	return o;
}

sc_scheduler *sc_new(sc_options options) {
	sc_scheduler *s = xalloc(sizeof *s);
	s->opt = options;
	s->order = od_new();
	s->causes = cs_new();
	s->life = xalloc(sizeof *s->life);
	s->life->refs = 1;
	return s;
}

sc_scope *sc_create_root_scope(sc_scheduler *s, const sc_pair *info, size_t n) {
	return make_scope(s, PLAIN, NULL, info, n);
}

sc_scope *sc_create_scope(sc_scheduler *s, const sc_pair *info, size_t n, sc_scope *parent) {
	if (parent == NULL) parent = s->open;
	if (parent == NULL || parent->state != ALIVE) return NULL;
	return make_scope(s, PLAIN, parent, info, n);
}

void sc_scope_set(sc_scope *o, void *user) { o->user = user; }
void *sc_scope_user(const sc_scope *o) { return o->user; }
bool sc_scope_alive(const sc_scope *o) { return o->state == ALIVE; }
bool sc_scope_old(const sc_scope *o) { return o->old; }
bool sc_scope_early(const sc_scope *o) { return o->kind == EFFECT && o->def.early; }
sc_scope *sc_scope_parent(const sc_scope *o) { return o->parent; }
sc_scope *sc_get_current_scope(const sc_scheduler *s) { return s->open; }
sc_run *sc_get_run(const sc_scheduler *s) { return s->open_writer; }

ch_frame *sc_get_current_frame(const sc_scheduler *s) { return s->open_frame; }
ch_frame *sc_scope_frame(sc_scope *o) { return o->frame; }
ch_frame *sc_run_frame(const sc_run *run) { return run->frame; }

ch_frame *sc_create_frame(sc_scheduler *s, const sc_pair *info, size_t n, ch_frame *up) {
	return ch_frame_make(info, n, up != NULL ? up : s->open_frame);
}

static ch_frame *latest(const sc_scope *c) { return c->ran != NULL ? c->ran->frame : c->frame; }

typedef struct {
	sc_scope *scope;
	ch_frame *frame;
	sc_run *writer;
} opened;

static opened opens(sc_scope *o) {
	sc_scheduler *s = o->s;
	opened was = {s->open, s->open_frame, s->open_writer};
	s->open = o;
	s->open_frame = o->kind != PLAIN ? latest(o) : o->frame;
	if (o->kind != PLAIN) s->open_writer = o->ran;
	return was;
}

static void reopen(sc_scheduler *s, opened was) {
	s->open = was.scope;
	s->open_frame = was.frame;
	s->open_writer = was.writer;
}

static char *call_teardown(sc_scope *o, teardown_fn k) {
	opened was = opens(o);
	char *e = k.f(k.data);
	reopen(o->s, was);
	return e;
}

char *sc_register_teardown(sc_scheduler *s, sc_scope *o, char *(*f)(void *), void *data) {
	(void)s;
	if (o->state != ALIVE) return call_teardown(o, (teardown_fn){f, data});
	if (o->kind == EFFECT && o->doing) VEC_PUSH(o->deeds, o->ndeeds, o->capdeeds, ((teardown_fn){f, data}));
	else VEC_PUSH(o->teardowns, o->nteardowns, o->capteardowns, ((teardown_fn){f, data}));
	return NULL;
}

static act *unqueue(sc_scheduler *s, sc_scope *c) {
	act *a = c->acting;
	queue *q = c->def.early ? &s->earlies : &s->acts;
	q->v[a->at] = NULL;
	q->live--;
	c->acting = NULL;
	return a;
}

static void unlink_scope(sc_scope *o) {
	sc_scope *p = o->parent;
	if (o->newer) o->newer->older = o->older;
	else if (p && p->newest == o) p->newest = o->older;
	else if (p && p->kind != PLAIN && p->before == o) p->before = o->older;
	if (o->older) o->older->newer = o->newer;
	o->older = o->newer = NULL;
	o->old = false;
}

static sc_scope **list_of(sc_scope *x, size_t *n) {
	*n = 0;
	for (sc_scope *y = x; y != NULL; y = y->older) (*n)++;
	if (*n == 0) return NULL;
	sc_scope **kids = xalloc(*n * sizeof *kids);
	for (size_t i = 0; i < *n; i++, x = x->older) kids[i] = x;
	for (size_t i = 0; i < *n; i++) {
		kids[i]->older = kids[i]->newer = NULL;
		kids[i]->old = false;
	}
	return kids;
}

static sc_scope **cut(sc_scope *o, size_t *n) {
	size_t nk, ni = 0;
	sc_scope **kids = list_of(o->newest, &nk);
	o->newest = NULL;
	sc_scope **old = NULL;
	if (o->kind != PLAIN) {
		old = list_of(o->before, &ni);
		o->before = NULL;
	}
	*n = nk + ni;
	if (ni == 0) return kids;
	if (nk == 0) return old;
	kids = realloc(kids, *n * sizeof *kids);
	if (kids == NULL) abort();
	memcpy(kids + nk, old, ni * sizeof *old);
	free(old);
	return kids;
}

static void unact(sc_scheduler *s, sc_scope *c) {
	act *a = unqueue(s, c);
	drop_value(s, a->value);
	ran_release(a->r);
	free(a);
}

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
	pm_clear(&c->cs.kept);
}

static char *dispose(sc_scope *o);

static void first_error(char **failed, char *e) {
	if (e == NULL) return;
	if (*failed == NULL) *failed = e;
	else free(e);
}

// Tears down n kids, newest first, then nfs functions, newest first, each with o open. Returns the
// first cleanup error. Each kid is held while the walk goes, so one torn down earlier is skipped,
// not freed under it.
static char *down(sc_scope *o, sc_scope **kids, size_t n, const teardown_fn *fs, size_t nfs) {
	char *failed = NULL;
	if (n > 0) {
		opened was = opens(o);
		for (size_t i = 0; i < n; i++) kids[i]->refs++;
		for (size_t i = 0; i < n; i++) first_error(&failed, dispose(kids[i]));
		reopen(o->s, was);
		for (size_t i = 0; i < n; i++) unhold(kids[i]);
	}
	for (size_t i = nfs; i > 0; i--) first_error(&failed, call_teardown(o, fs[i - 1]));
	return failed;
}

static void put_fns(teardown_fn *all, size_t *k, const teardown_fn *fs, size_t n) {
	if (n == 0) return;
	memcpy(all + *k, fs, n * sizeof *fs);
	*k += n;
}

static char *teardown(sc_scope *o) {
	if (o->state != ALIVE) return NULL;
	sc_scheduler *s = o->s;
	char *outer = s->thrown;
	s->thrown = NULL;
	char *failed = dispose(o);
	char *t = unbracket(s, outer);
	if (t) {
		free(failed);
		return t;
	}
	return failed;
}

static char *dispose(sc_scope *o) {
	if (o->state != ALIVE) return NULL;
	sc_scheduler *s = o->s;
	o->state = DISPOSING;
	teardown_fn *fs = o->teardowns;
	size_t nfs = o->nteardowns;
	o->teardowns = NULL;
	o->nteardowns = o->capteardowns = 0;
	if (o->kind != PLAIN) {
		o->od.alive = false;
		drop_computation(s, o);
		size_t more = (size_t)o->nqueuedCleanups + o->naside + o->ndeeds;
		if (more > 0) {
			teardown_fn *all = xalloc((more + nfs) * sizeof *all);
			size_t k = 0;
			put_fns(all, &k, o->queuedCleanups, o->nqueuedCleanups);
			put_fns(all, &k, o->aside, o->naside);
			put_fns(all, &k, o->deeds, o->ndeeds);
			put_fns(all, &k, fs, nfs);
			free(fs);
			fs = all;
			nfs = k;
			free(o->queuedCleanups);
			free(o->aside);
			free(o->deeds);
			o->queuedCleanups = o->aside = o->deeds = NULL;
			o->nqueuedCleanups = o->capqueuedCleanups = o->naside = o->capaside = o->ndeeds = o->capdeeds = 0;
		}
		loop_drop(s, o->cuts, o->ncuts);
		o->cuts = NULL;
		o->ncuts = 0;
		loop_drop(s, o->loop, o->nloop);
		o->loop = NULL;
		o->nloop = 0;
	}
	size_t nkids;
	sc_scope **kids = cut(o, &nkids);
	char *failed = down(o, kids, nkids, fs, nfs);
	free(kids);
	free(fs);
	o->state = GONE;
	if (o->kind != PLAIN && o->ran) {
		sc_run *r = o->ran;
		o->ran = NULL;
		quit_step(r);
		ran_release(r);
	}
	unlink_scope(o);
	let_go(o);
	return failed;
}

static void liftChildren(sc_scope *c) {
	sc_scope *head = NULL, *tail = NULL;
	for (sc_scope *x = c->newest; x != NULL;) {
		sc_scope *next = x->older;
		if (!x->deed) {
			unlink_scope(x);
			x->old = true;
			if (tail) {
				tail->older = x;
				x->newer = tail;
			} else {
				head = x;
			}
			tail = x;
		}
		x = next;
	}
	if (tail) {
		tail->older = c->before;
		if (c->before) c->before->newer = tail;
		c->before = head;
	}
	for (size_t i = 0; i < c->nteardowns; i++) VEC_PUSH(c->aside, c->naside, c->capaside, c->teardowns[i]);
	c->nteardowns = 0;
}

static void dropUnclaimedChildren(sc_scheduler *s, sc_scope *c, sc_run *r) {
	if (c->before) {
		size_t n;
		sc_scope **kids = list_of(c->before, &n);
		c->before = NULL;
		sc_run *was = s->reading, *wasRunning = s->running;
		s->reading = NULL;
		s->running = r;
		hold(s, down(c, kids, n, NULL, 0));
		s->reading = was;
		s->running = wasRunning;
		free(kids);
	}
	if (c->naside > 0 && c->state == ALIVE) {
		if (c->nqueuedCleanups == 0) VEC_PUSH(s->queued, s->nqueued, s->capqueued, c);
		for (size_t i = 0; i < c->naside; i++) VEC_PUSH(c->queuedCleanups, c->nqueuedCleanups, c->capqueuedCleanups, c->aside[i]);
		free(c->aside);
		c->aside = NULL;
		c->naside = c->capaside = 0;
		if (r->nloop > 0) {
			loop_drop(s, c->cuts, c->ncuts);
			c->cuts = xalloc(r->nloop * sizeof *c->cuts);
			memcpy(c->cuts, r->loop, r->nloop * sizeof *c->cuts);
			c->ncuts = r->nloop;
			loop_hold(c->cuts, c->ncuts);
		}
	}
}

static char *runQueuedCleanups(sc_scheduler *s) {
	if (s->nqueued == 0) return NULL;
	char *outer = s->thrown;
	s->thrown = NULL;
	sc_run *was = s->reading, *wasRunning = s->running;
	for (size_t i = 0; i < s->nqueued; i++) {
		sc_scope *c = s->queued[i];
		teardown_fn *fs = c->queuedCleanups;
		size_t n = c->nqueuedCleanups;
		sc_scope **cuts = c->cuts;
		size_t ncuts = c->ncuts;
		c->queuedCleanups = NULL;
		c->nqueuedCleanups = c->capqueuedCleanups = 0;
		c->cuts = NULL;
		c->ncuts = 0;
		if (n > 0 && c->state == ALIVE) {
			sc_run *r = ran_ref(c->ran);
			sc_scope **flag = r->loop;
			size_t nflag = r->nloop;
			if (ncuts > 0) {
				r->loop = cuts;
				r->nloop = ncuts;
			}
			s->reading = NULL;
			s->running = r;
			for (size_t j = n; j > 0; j--) {
				char *e = call_teardown(c, fs[j - 1]);
				if (e) {
					hold(s, e);
					break;
				}
			}
			r->loop = flag;
			r->nloop = nflag;
			ran_release(r);
		}
		free(fs);
		loop_drop(s, cuts, ncuts);
	}
	s->nqueued = 0;
	s->reading = was;
	s->running = wasRunning;
	return unbracket(s, outer);
}

char *sc_teardown(sc_scope *o) { return teardown(o); }

const char *sc_run_with_scope(sc_scope *o, void (*f)(void *), void *data) {
	return sc_run_with(o, NULL, f, data);
}

const char *sc_run_with(sc_scope *o, ch_frame *frame, void (*f)(void *), void *data) {
	if (o->state != ALIVE) return SC_DISPOSED;
	sc_scheduler *s = o->s;
	sc_run *was = s->reading;
	sc_scope *wasopen = s->open;
	ch_frame *wasframe = s->open_frame;
	s->reading = NULL;
	s->open = sc_retain(o);
	s->open_frame = frame != NULL ? frame : o->frame;
	f(data);
	s->reading = was;
	s->open = wasopen;
	s->open_frame = wasframe;
	unhold(o);
	return NULL;
}


// A run's cause. A cause from an earlier pulse is cut to its computer alone, so nothing lasts past
// the pulse.
static cs_cause *cause_of(sc_scheduler *s, sc_run *r) {
	if (r->pulse != s->pulses) {
		cs_release(r->cause);
		r->cause = cs_run(s->causes, &r->c->cs, NULL, 0);
		r->pulse = s->pulses;
	}
	return r->cause;
}

// Makes c due by the run that made the change; true if it was not already due. An old link (its
// latest run did not read it and that run is not done) is a retry: no loop through c is flagged.
static bool due(sc_scheduler *s, sc_scope *c, uint64_t t, sc_run *writer, bool old) {
	if (c->state != ALIVE) return false;
	cs_cause *cause = writer && writer == writer->c->ran ? cause_of(s, writer) : NULL;
	if (cause) cs_keep(s->causes, &c->cs, cause);
	size_t n = 0;
	cs_item **items = cs_loop(s->causes, cause, &c->cs, &n);
	sc_scope **loop = NULL;
	if (items) {
		loop = xalloc(n * sizeof *loop);
		for (size_t i = 0; i < n; i++) loop[i] = of_cs(items[i]);
		free(items);
		loop_hold(loop, n);
	}
	if (loop && writer && writer->c == c && c->cleaning && !c->cleaned) {
		loop_drop(s, loop, n);
		loop = NULL;
	}
	if (loop && writer->nloop > 0) {
		if (!old) writer->cut = true;
		loop_drop(s, loop, n);
		return false;
	}
	bool on = loop != NULL;
	if (!old) {
		loop_drop(s, c->loop, c->nloop);
		c->loop = loop;
		c->nloop = loop ? n : 0;
	} else if (loop) {
		loop_drop(s, loop, n);
	}
	if (c->looping) {
		if (on) return false;
		c->looping = false;
	}
	if (od_has(s->order, &c->od)) return false;
	if (c->ran) quit_step(c->ran);
	od_set(s->order, &c->od, t);
	return true;
}

typedef struct {
	sc_computer **v;
	size_t n, cap;
} dues;

static void told_mark(sc_scheduler *s, const void *const *keys, size_t count, sc_run *run, dues *d,
	uint64_t t) {
	EACH(s, ON_MARK, mark, keys, count, run, d->v, d->n, t);
	free(d->v);
}

static void write(sc_scheduler *s, sc_scope *c, const void *key) {
	sc_scope *was = pm_get(&s->writers, key);
	if (was == c) return;
	if (was) pm_delete(&was->wrote, key);
	pm_set(&s->writers, key, c);
	pm_set(&c->wrote, key, NULL);
}

uint64_t sc_mark(sc_scheduler *s, const void *const *keys, size_t count, sc_run *writer) {
	char *outer = s->thrown;
	s->thrown = NULL;
	uint64_t t = ++s->tick;
	dues now = {0};
	bool told = s->nlisteners[ON_MARK] > 0;
	sc_scope *w = writer && writer->c->kind == COMPUTE && writer->c->state == ALIVE ? writer->c : NULL;
	for (size_t i = 0; i < count; i++) {
		const void *key = keys[i];
		if (w) write(s, w, key);
		tg_node *node = pm_get(&s->nodes, key);
		if (node == NULL) continue;
		// An old link (its reader's latest run did not read it and that run is over) is a retry. A reader
		// whose own set, act or cleanup is going on is not reached; it lets the link go when done.
		for (tg_link *l = node->first; l != NULL; l = l->after) {
			sc_scope *c = l->from->owner;
			bool old = tg_old(l);
			if (old && s->running != NULL && s->running->c == c) continue;
			if (due(s, c, t, writer, old) && told) VEC_PUSH(now.v, now.n, now.cap, c);
		}
	}
	if (told) told_mark(s, keys, count, writer, &now, t);
	escape(s, unbracket(s, outer));
	return t;
}


static bool waits_after(sc_scheduler *s, od_item *w, sc_scope *c) {
	size_t steps = 0;
	for (od_item *x = w->after; x && steps <= s->nlive; x = x->after, steps++)
		if (x == &c->od) return true;
	return false;
}

// A key tracked in r. If its writer is due the run stops, unless the writer waits after r's or is
// due by r's own doing.
static sc_track_status follow(sc_scheduler *s, sc_run *r, const void *key) {
	if (r->stopped) return SC_STOP;
	sc_scope *c = r->c;
	if (c->state != ALIVE) return SC_OK;
	tg_node *node = pm_get(&s->nodes, key);
	bool first = node == NULL;
	if (node == NULL) {
		node = tg_node_new((void *)key);
		if (node == NULL) abort();
		pm_set(&s->nodes, key, node);
	}
	if (tg_track(c->node, node) != 0) abort();
	if (s->nlisteners[ON_END]) VEC_PUSH(r->reads, r->nreads, r->capreads, key);
	if (first) EACH(s, ON_FIRST, track, key, r);
	EACH(s, ON_TRACK, track, key, r);
	sc_scope *w = pm_get(&s->writers, key);
		if (w == NULL || w == c) return SC_OK;
	if (r->values == NULL) {
		r->values = c->spare;
		c->spare = NULL;
		if (r->values == NULL) r->values = xalloc(sizeof *r->values);
	}
	pm_set(r->values, &w->od, NULL);
	if (od_has(s->order, &w->od) && !waits_after(s, &w->od, c) && !cs_from(s->causes, &w->cs, &c->cs)) {
		r->stopped = w;
		return SC_STOP;
	}
	return SC_OK;
}

sc_track_status sc_track(sc_scheduler *s, const void *key) {
	if (s->reading == NULL) return SC_OK;
	char *outer = s->thrown;
	s->thrown = NULL;
	sc_track_status st = follow(s, s->reading, key);
	escape(s, unbracket(s, outer));
	return st;
}


static void finish(sc_scheduler *s, sc_run *r, sc_ended ended, int equal, char *error,
	sc_scope *waits, sc_scope *const *through, size_t nthrough) {
	sc_scope *c = r->c;
	if (r->nloop > 0 && r->cut && (ended == SC_FAIL || (ended == SC_DONE && equal == 1))) {
		finish(s, r, SC_LOOPING, equal, error, waits, r->loop, r->nloop);
		return;
	}
	// Done as its latest run: old links go (untracked), what it did not make again goes, and its old
	// cleanups are queued. Ended any other way, what it read and the old links all stay.
	if (c->ran == r && c->state == ALIVE) {
		if (ended == SC_DONE) {
			trim_run(s, c->node);
			dropUnclaimedChildren(s, c, r);
		} else {
			tg_dedupe(c->node);
		}
	}
	if (c->state == ALIVE) {
		// Not done: what it was given is held again beside what was held since it began.
		if (ended != SC_DONE)
			for (size_t i = 0; i < r->ngiven; i++) cs_keep(s->causes, &c->cs, r->given[i]);
		for (size_t i = 0; i < r->ngiven; i++) cs_release(r->given[i]);
		r->ngiven = 0;
		if (ended == SC_LOOPING) c->looping = true;
		if (ended != SC_STOPPED_RUN) {
			od_sees(s->order, &c->od, r->values);
			r->adopted = true;
		}
	}
	sc_more more = {.equal = equal, .error = error, .waits = waits, .through = through, .nthrough = nthrough,
		.has_kept = r->has_kept, .kept = r->kept};
	r->has_kept = false;
	r->kept = NULL;
	EACH(s, ON_END, end, c, r->n, ended, (const void *const *)r->reads, r->nreads, &more);
	free(error);
	if (ended != SC_PENDED) {
		loop_drop(s, r->loop, r->nloop);
		r->loop = NULL;
		r->nloop = 0;
	}
}

static void result(sc_scheduler *s, sc_run *r, void *v) {
	sc_scope *c = r->c;
	EACH(s, ON_RETURN, ret, c, r->n, v);
	if (c->state != ALIVE) {
		drop_value(s, v);
		return;
	}
	bool equal = c->has_last && same(c, v, c->last);
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
			queue *q = c->def.early ? &s->earlies : &s->acts;
			a->at = q->n;
			VEC_PUSH(q->v, q->n, q->cap, a);
			q->live++;
			c->acting = a;
			r->has_kept = true;
			r->kept = v;
		} else {
			drop_value(s, v);
		}
		finish(s, r, SC_DONE, equal, NULL, NULL, NULL, 0);
		return;
	}
	if (!equal) {
		sc_run *was = s->reading, *wasRunning = s->running, *waswriter = s->open_writer;
		sc_scope *wasopen = s->open;
		ch_frame *wasframe = s->open_frame;
		s->reading = NULL;
		s->running = r;
		s->open = c;
		s->open_frame = latest(c);
		s->open_writer = c->ran;
		char *failed = c->def.set(v, c->def.data);
		s->reading = was;
		s->running = wasRunning;
		s->open = wasopen;
		s->open_frame = wasframe;
		s->open_writer = waswriter;
		r->has_kept = true;
		r->kept = v;
		if (failed) {
			// A set that threw may have written part: the last is forgotten so the next result is given to
			// set, equal or not. The result is let go once its end is said.
			if (c->has_last) drop_value(s, c->last);
			c->last = NULL;
			c->has_last = false;
			finish(s, r, SC_FAIL, 0, failed, NULL, NULL, 0);
			drop_value(s, v);
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

// A promise: the run ends pending. Its settling lands at the next pulse in every run awaiting it
// (unless that run ran again or is gone), each with its own hold on the value (keep).
static void deliver(sc_promise *p, sc_run *r) {
	sc_scheduler *s = p->s;
	if (r->c->state != ALIVE || r->c->runs != r->n) {
		quit_step(r);
		ran_release(r);
		return;
	}
	landed l = {r, p->kind, NULL, NULL, r->has_step};
	if (p->kind == SC_VALUE && p->value != NULL) {
		if (s->opt.keep) s->opt.keep(p->value, s->opt.data);
		else p->given = true;
		l.value = p->value;
	}
	if (p->kind == SC_FAILED && p->error != NULL) {
		size_t n = strlen(p->error) + 1;
		l.error = memcpy(xalloc(n), p->error, n);
	}
	VEC_PUSH(s->landed, s->nlanded, s->caplanded, l);
	for (size_t i = 0; i < s->nlisteners[ON_SETTLE]; i++)
		s->listeners[ON_SETTLE][i]->f.settle(s->listeners[ON_SETTLE][i]->data);
}

static void awaiting(sc_scheduler *s, sc_run *r, sc_promise *p) {
	finish(s, r, SC_PENDED, -1, NULL, NULL, NULL, 0);
	if (p->settled) deliver(p, ran_ref(r));
	else VEC_PUSH(p->rs, p->nrs, p->caprs, ran_ref(r));
}

static void discard(sc_scheduler *s, sc_out out) {
	if (out.kind == SC_VALUE) drop_value(s, out.value);
	else if (out.kind == SC_FAILED) free(out.error);
	else if (out.kind == SC_PAUSE) out.step.quit(out.step.data);
}

static void conclude(sc_scheduler *s, sc_run *r, sc_out out) {
	sc_scope *c = r->c;
	if (c->state != ALIVE) {
		discard(s, out);
	} else if (r->stopped) {
		discard(s, out);
		if (!od_has(s->order, &c->od)) {
			loop_drop(s, c->loop, c->nloop);
			c->loop = r->loop;
			c->nloop = r->nloop;
			r->loop = NULL;
			r->nloop = 0;
		}
		od_waits(s->order, &c->od, &r->stopped->od);
		od_set(s->order, &c->od, r->mark);
		finish(s, r, SC_STOPPED_RUN, -1, NULL, r->stopped, NULL, 0);
	} else if (out.kind == SC_FAILED) {
		finish(s, r, SC_FAIL, -1, out.error, NULL, NULL, 0);
	} else if (out.kind == SC_PENDING) {
		finish(s, r, SC_PENDED, -1, NULL, NULL, NULL, 0);
	} else if (out.kind == SC_AWAIT) {
		awaiting(s, r, out.promise);
	} else if (out.kind == SC_PAUSE) {
		r->step = out.step;
		r->has_step = true;
		awaiting(s, r, out.promise);
		if (od_has(s->order, &c->od)) quit_step(r);
	} else {
		result(s, r, out.value);
	}
}

// The same run goes on: the paused step's next is given what the promise settled with, and the
// run's reads are tracked as before. It is let go if the run ran again or is gone.
static void resume(sc_scheduler *s, sc_run *r, landed l) {
	sc_scope *c = r->c;
	sc_step step = r->step;
	r->has_step = false;
	op_value *number = op_num((double)++s->steps);
	sc_pair info = {"step", number};
	sc_run *was = s->reading, *wasRunning = s->running, *waswriter = s->open_writer;
	sc_scope *wasopen = s->open;
	ch_frame *wasframe = s->open_frame;
	ch_frame *frame = sc_create_frame(s, &info, 1, r->frame);
	op_free(number);
	s->reading = r;
	s->running = r;
	s->open = c;
	s->open_frame = frame;
	s->open_writer = r;
	tg_resume(c->node);
	if (r->adopted) {
		pm *mine = c->spare;
		c->spare = NULL;
		if (mine == NULL) mine = xalloc(sizeof *mine);
		if (r->values) {
			for (size_t i = 0; i < r->values->cap; i++)
				if (r->values->keys[i] != NULL) pm_set(mine, r->values->keys[i], NULL);
		}
		r->values = mine;
		r->adopted = false;
	}
	sc_out out = step.next(step.data, l.kind != SC_FAILED, l.value, l.error);
	s->reading = was;
	s->running = wasRunning;
	s->open = wasopen;
	s->open_frame = wasframe;
	s->open_writer = waswriter;
	ch_frame_free(frame);
	tg_leave(c->node);
	conclude(s, r, out);
}

static char *land(sc_scheduler *s, landed l) {
	char *outer = s->thrown;
	s->thrown = NULL;
	sc_run *r = l.r;
	if (r->c->state != ALIVE || r->c->runs != r->n || od_has(s->order, &r->c->od)) {
		drop_value(s, l.value);
		free(l.error);
		quit_step(r);
	} else if (l.step) {
		if (l.kind == SC_PENDING) {
			quit_step(r);
			finish(s, r, SC_PENDED, -1, NULL, NULL, NULL, 0);
		} else {
			resume(s, r, l);
		}
	} else if (l.kind == SC_FAILED) {
		finish(s, r, SC_FAIL, -1, l.error, NULL, NULL, 0);
	} else if (l.kind == SC_PENDING) {
		finish(s, r, SC_PENDED, -1, NULL, NULL, NULL, 0);
	} else {
		result(s, r, l.value);
	}
	ran_release(r);
	return unbracket(s, outer);
}


static void begin(sc_scheduler *s, sc_scope *c, int rank);

static ch_frame *run_frame(sc_scope *c, unsigned n, uint64_t mark) {
	op_value *run = op_num((double)n), *at = op_num((double)mark);
	sc_pair info[2] = {{"run", run}, {"mark", at}};
	ch_frame *f = ch_frame_make(info, 2, c->frame);
	op_free(run);
	op_free(at);
	return f;
}

static char *first(sc_scheduler *s, sc_scope *c, int rank) {
	char *outer = s->thrown;
	s->thrown = NULL;
	begin(s, c, rank);
	return unbracket(s, outer);
}

static void begin(sc_scheduler *s, sc_scope *c, int rank) {
	uint64_t mark = od_at(&c->od);
	od_delete(s->order, &c->od);
	od_waits(s->order, &c->od, NULL);
	unsigned n = ++c->runs;
	size_t ngiven = c->cs.kept.count;
	sc_run *r = c->ran;
	if (r != NULL) quit_step(r);
	bool reuse = r != NULL && r->refs == 1;
	if (reuse) {
		run_reset(r);
	} else {
		r = xalloc(sizeof *r);
		r->s = s;
		r->life = s->life;
		s->life->refs++;
		r->c = c;
		c->refs++;
	}
	r->refs = 1;
	r->n = n;
	r->mark = mark;
	ch_frame_free(r->frame);
	r->frame = run_frame(c, n, mark);
	r->pulse = s->pulses;
	if (ngiven > r->capgiven) {
		r->given = realloc(r->given, ngiven * sizeof *r->given);
		if (r->given == NULL) abort();
		r->capgiven = ngiven;
	}
	if (ngiven > 0) {
		size_t k = 0;
		for (size_t i = 0; i < c->cs.kept.cap; i++)
			if (c->cs.kept.keys[i] != NULL) r->given[k++] = cs_ref((cs_cause *)c->cs.kept.keys[i]);
		r->ngiven = k;
		cs_forget(&c->cs);
	}
	r->cause = cs_run(s->causes, &c->cs, r->given, r->ngiven);
	r->loop = c->loop;
	r->nloop = c->nloop;
	c->loop = NULL;
	c->nloop = 0;
	if (reuse) {
		r->refs++;
	} else {
		if (c->ran) ran_release(c->ran);
		c->ran = ran_ref(r);
	}
	if (c->acting) unact(s, c);
	EACH(s, ON_START, start, c, n, rank, r->frame);
	sc_run *was = s->reading, *wasRunning = s->running;
	s->running = r;
	// What its runs made is old and its cleanups set aside until a run is done.
	if (c->state != ALIVE) {
		s->running = wasRunning;
		ran_release(r);
		return;
	}
	liftChildren(c);
	sc_scope *wasopen = s->open;
	ch_frame *wasframe = s->open_frame;
	sc_run *waswriter = s->open_writer;
	s->reading = r;
	s->open = c;
	s->open_frame = r->frame;
	s->open_writer = r;
	tg_begin(c->node);
	sc_out out = c->def.f(c->has_last ? c->last : NULL, c->def.data);
	s->reading = was;
	s->running = wasRunning;
	s->open = wasopen;
	s->open_frame = wasframe;
	s->open_writer = waswriter;
	tg_leave(c->node);
	conclude(s, r, out);
	ran_release(r);
}


// Acts for an effect: what its last act made goes and the cleanups made in it run (a cleanup's
// error is the act's). Then it acts with the value it acted on last. If it is due again, its value
// is old, so it does not act and its next run does.
static void do_act(sc_scheduler *s, act *a) {
	sc_scope *c = a->r->c;
	c->acting = NULL;
	char *failed = NULL;
	sc_run *was = s->reading, *wasRunning = s->running;
	bool acts = c->state == ALIVE && !od_has(s->order, &c->od);
	if (acts) {
		s->reading = NULL;
		s->running = a->r;
		size_t n = 0;
		for (sc_scope *x = c->newest; x != NULL; x = x->older) n += x->deed;
		sc_scope **deeds = n ? xalloc(n * sizeof *deeds) : NULL;
		size_t k = 0;
		for (sc_scope *x = c->newest; x != NULL;) {
			sc_scope *next = x->older;
			if (x->deed) {
				unlink_scope(x);
				deeds[k++] = x;
			}
			x = next;
		}
		teardown_fn *fs = c->deeds;
		size_t nfs = c->ndeeds;
		c->deeds = NULL;
		c->ndeeds = c->capdeeds = 0;
		c->cleaning = true;
		failed = down(c, deeds, n, fs, nfs);
		c->cleaning = false;
		free(deeds);
		free(fs);
		acts = c->state == ALIVE;
		if (acts && od_has(s->order, &c->od)) {
			acts = false;
			c->cleaned = true;
			hold(s, failed);
			failed = NULL;
		}
	}
	if (!acts) {
		s->reading = was;
		s->running = wasRunning;
		hold(s, failed);
		drop_value(s, a->value);
		ran_release(a->r);
		free(a);
		return;
	}
	sc_scope *wasopen = s->open;
	ch_frame *wasframe = s->open_frame;
	sc_run *waswriter = s->open_writer;
	s->open = c;
	s->open_frame = latest(c);
	s->open_writer = c->ran;
	c->cleaned = false;
	c->doing = true;
	char *error = c->def.effect(a->value, c->has_last ? c->last : NULL, c->def.data);
	c->doing = false;
	s->reading = was;
	s->running = wasRunning;
	s->open = wasopen;
	s->open_frame = wasframe;
	s->open_writer = waswriter;
	first_error(&failed, error);
	if (c->has_last) drop_value(s, c->last);
	c->last = a->value;
	c->has_last = true;
	EACH(s, ON_EFFECT, effect, c, a->r->n, failed);
	free(failed);
	ran_release(a->r);
	free(a);
}

static void owners(sc_scheduler *s, sc_scope *c) {
	for (sc_scope *o = c->parent; o != NULL; o = o->parent) {
		if (o->kind != EFFECT || o->acting == NULL || o->def.early != c->def.early) continue;
		act *x = unqueue(s, o);
		owners(s, o);
		do_act(s, x);
		return;
	}
}

// The next act of q, owners first: what an owner's act tears down does not act.
static char *take(sc_scheduler *s, queue *q) {
	char *outer = s->thrown;
	s->thrown = NULL;
	while (q->v[q->head] == NULL) q->head++;
	act *a = q->v[q->head];
	q->v[q->head++] = NULL;
	q->live--;
	a->r->c->acting = NULL;
	if (q->live > 0) owners(s, a->r->c);
	do_act(s, a);
	return unbracket(s, outer);
}


static void computer_free(sc_scheduler *s, sc_scope *o) {
	tg_node_free(o->node);
	pm_clear(&o->wrote);
	cs_forget(&o->cs);
	pm_clear(&o->cs.kept);
	if (o->od.values) {
		pm_clear(o->od.values);
		free(o->od.values);
	}
	if (o->spare) {
		pm_clear(o->spare);
		free(o->spare);
	}
	pm_clear(&o->od.rev);
	free(o->aside);
	free(o->queuedCleanups);
	free(o->deeds);
	loop_drop(s, o->cuts, o->ncuts);
	loop_drop(s, o->loop, o->nloop);
	if (o->ran) ran_release(o->ran);
	if (o->has_last) drop_value(s, o->last);
}

static void free_scope(sc_scope *o) {
	sc_scheduler *s = o->s;
	EACH(s, ON_FREE, freed, o);
	sc_scope *last = s->all[--s->nall];
	s->all[o->at] = last;
	last->at = o->at;
	sc_scope *parent = o->parent;
	free(o->teardowns);
	ch_frame_free(o->frame);
	if (o->kind != PLAIN) computer_free(s, o);
	free(o);
	if (parent) unhold(parent);
}

// Frees the computers gone and held by nothing, as the pulse ends; this may free their parents too.
static void free_unheld(sc_scheduler *s) {
	for (size_t i = 0; i < s->nunheld; i++) {
		sc_scope *o = s->unheld[i];
		o->listed = false;
		if (o->state == GONE && o->refs == 0) free_scope(o);
	}
	s->nunheld = 0;
}


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
	char *outer = s->thrown;
	s->thrown = NULL;
	char *failed = NULL;
	// What settled before lands in this pulse; what settles in it (a promise settled, or awaited once
	// settled) lands at the next, as in the reference.
	size_t upto = s->nlanded;
	for (;;) {
		while (!failed && s->headlanded < upto) failed = land(s, s->landed[s->headlanded++]);
		if (failed) break;
		if (upto > 0) {
			s->nlanded -= upto;
			memmove(s->landed, s->landed + upto, s->nlanded * sizeof *s->landed);
			s->headlanded = upto = 0;
		}
		if (!od_size(s->order) && s->earlies.live == 0 && s->acts.live == 0) break;
		while (!failed && od_size(s->order)) {
			int rank;
			od_item *p = od_next(s->order, &rank);
			failed = first(s, of_od(p), rank);
		}
		if (!failed) failed = runQueuedCleanups(s);
		while (!failed && s->earlies.live > 0) failed = take(s, &s->earlies);
		if (failed) break;
		s->earlies.head = s->earlies.n = 0;
		while (!failed && s->acts.live > 0) failed = take(s, &s->acts);
		if (failed) break;
		s->acts.head = s->acts.n = 0;
	}
	char *late = runQueuedCleanups(s);
	if (failed) free(late);
	else failed = late;
	s->pulsing = false;
	cs_end(s->causes);
	s->pulses++;
	sweep(s);
	free_unheld(s);
	// Over: told unless it was left early. What they throw is held like any listener's.
	if (!failed) {
		for (size_t i = 0; i < s->nlisteners[ON_PULSED]; i++)
			s->listeners[ON_PULSED][i]->f.pulsed(s->listeners[ON_PULSED][i]->data);
	}
	char *t = unbracket(s, outer);
	if (failed) {
		free(t);
		t = failed;
	}
	escape(s, t);
}

// Gives c a new def and kind. A queued act is dropped. A new kind lets go of its last result. A
// compute made an effect writes nothing. An effect made a compute treats what its last act made as
// its runs' (old at its next run), and the cleanups made in that act as set aside with its own.
static void become(sc_scheduler *s, sc_scope *c, kind_t kind, sc_def def) {
	if (c->acting) unact(s, c);
	if (kind != EFFECT) def.early = false;
	kind_t was = c->kind;
	c->kind = kind;
	c->def = def;
	if (was == kind) return;
	if (c->has_last) drop_value(s, c->last);
	c->last = NULL;
	c->has_last = false;
	if (kind == EFFECT) {
		for (size_t i = 0; i < c->wrote.cap; i++) {
			const void *k = c->wrote.keys[i];
			if (k != NULL && pm_get(&s->writers, k) == c) pm_delete(&s->writers, k);
		}
		pm_clear(&c->wrote);
		return;
	}
	for (sc_scope *x = c->newest; x != NULL; x = x->older) x->deed = false;
	for (unsigned i = 0; i < c->ndeeds; i++) VEC_PUSH(c->teardowns, c->nteardowns, c->capteardowns, c->deeds[i]);
	free(c->deeds);
	c->deeds = NULL;
	c->ndeeds = c->capdeeds = 0;
}

bool sc_claim_as(sc_computer *c, bool effect, sc_def def) {
	if (c->kind == PLAIN || !c->old || c->state != ALIVE) return false;
	become(c->s, c, effect ? EFFECT : COMPUTE, def);
	return sc_claim(c);
}

// Claims an old child of the run open's computer: back under it as the newest, and due unless again
// is false. False if it is not old.
static bool claim(sc_computer *c, bool again) {
	if (c->kind == PLAIN || !c->old || c->state != ALIVE) return false;
	sc_scheduler *s = c->s;
	unlink_scope(c);
	sc_scope *p = c->parent;
	c->older = p->newest;
	if (c->older) c->older->newer = c;
	p->newest = c;
	if (!again) return true;
	if (s->running && s->running->nloop > 0) s->running->cut = true;
	uint64_t t = ++s->tick;
	dues now = {0};
	bool told = s->nlisteners[ON_MARK] > 0;
	bool now_due = due(s, c, t, s->running, false);
	char *outer = s->thrown;
	s->thrown = NULL;
	if (now_due && told) VEC_PUSH(now.v, now.n, now.cap, c);
	if (told) told_mark(s, NULL, 0, s->running, &now, t);
	escape(s, unbracket(s, outer));
	return true;
}

bool sc_claim(sc_computer *c) { return claim(c, true); }
bool sc_claim_same(sc_computer *c) { return claim(c, false); }


static sc_computer *make(sc_scheduler *s, kind_t kind, sc_def def, const sc_pair *info, size_t n) {
	sc_scope *o = s->open;
	if (o == NULL || o->state != ALIVE) return NULL;
	if (kind != EFFECT) def.early = false;
	sc_scope *c = make_scope(s, kind, o, NULL, 0);
	c->def = def;
	c->node = tg_node_new(c);
	if (c->node == NULL) abort();
	s->nlive++;
	if (def.key) write(s, c, def.key);
	od_started(s->order, &c->od);
	// Made in a run, set, act or teardown, it carries that run's cause so a loop through what it
	// changes is seen. In a run known to loop, the loop is cut here, as a dropped loop mark cuts it.
	if (s->running && s->running->nloop > 0) s->running->cut = true;
	uint64_t t = ++s->tick;
	if (info == NULL) n = 0;
	sc_pair *own = xalloc((n + 1) * sizeof *own);
	for (size_t i = 0; i < n; i++) own[i] = info[i];
	op_value *mark = op_num((double)t);
	own[n] = (sc_pair){"mark", mark};
	c->frame = ch_frame_make(own, n + 1, frame_under(s, o));
	op_free(mark);
	free(own);
	dues now = {0};
	bool told = s->nlisteners[ON_MARK] > 0;
	bool now_due = due(s, c, t, s->running, false);
	char *outer = s->thrown;
	s->thrown = NULL;
	if (now_due && told) VEC_PUSH(now.v, now.n, now.cap, c);
	if (told) told_mark(s, NULL, 0, s->running, &now, t);
	if (def.early && now_due) {
		hold(s, first(s, c, od_rank(s->order, &c->od)));
		if (c->acting) do_act(s, unqueue(s, c));
	}
	escape(s, unbracket(s, outer));
	return c;
}

sc_computer *sc_create_computer(sc_scheduler *s, sc_def def, const sc_pair *info, size_t n) {
	return make(s, COMPUTE, def, info, n);
}
sc_computer *sc_create_effect(sc_scheduler *s, sc_def def, const sc_pair *info, size_t n) {
	return make(s, EFFECT, def, info, n);
}


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
	sc_scheduler *s = p->s;
	char *outer = s->thrown;
	s->thrown = NULL;
	sc_run **rs = p->rs;
	size_t n = p->nrs;
	p->rs = NULL;
	p->nrs = p->caprs = 0;
	for (size_t i = 0; i < n; i++) deliver(p, rs[i]);
	free(rs);
	escape(s, unbracket(s, outer));
}

void sc_resolve(sc_promise *p, void *value) { settle(p, SC_VALUE, value, NULL); }
void sc_resolve_pending(sc_promise *p) { settle(p, SC_PENDING, NULL, NULL); }
void sc_reject(sc_promise *p, char *error) { settle(p, SC_FAILED, NULL, error); }

void sc_promise_free(sc_promise *p) {
	for (size_t i = 0; i < p->nrs; i++) ran_release(p->rs[i]);
	free(p->rs);
	if (!p->given) drop_value(p->s, p->value);
	free(p->error);
	free(p);
}


void sc_free(sc_scheduler *s) {
	s->freeing = true;
	for (size_t i = 0; i < s->nall; i++)
		if (s->all[i]->kind != PLAIN && s->all[i]->ran) quit_step(s->all[i]->ran);
	cs_end(s->causes);
	for (size_t i = 0; i < s->nall; i++)
		if (s->all[i]->kind != PLAIN) tg_untrack(s->all[i]->node, NULL);
	queue *qs[] = {&s->earlies, &s->acts};
	for (int k = 0; k < 2; k++)
		for (size_t i = qs[k]->head; i < qs[k]->n; i++) {
			if (qs[k]->v[i] == NULL) continue;
			drop_value(s, qs[k]->v[i]->value);
			ran_release(qs[k]->v[i]->r);
			free(qs[k]->v[i]);
		}
	for (size_t i = s->headlanded; i < s->nlanded; i++) {
		drop_value(s, s->landed[i].value);
		free(s->landed[i].error);
		ran_release(s->landed[i].r);
	}
	for (size_t i = 0; i < s->nall; i++) {
		sc_scope *o = s->all[i];
		free(o->teardowns);
		ch_frame_free(o->frame);
		if (o->kind != PLAIN) computer_free(s, o);
		free(o);
	}
	for (size_t i = 0; i < s->nodes.cap; i++)
		if (s->nodes.keys[i] != NULL) tg_node_free(s->nodes.vals[i]);
	pm_clear(&s->nodes);
	pm_clear(&s->writers);
	od_free(s->order);
	cs_free(s->causes);
	for (int k = 0; k < ON_KINDS; k++) {
		for (size_t i = 0; i < s->nlisteners[k]; i++) free(s->listeners[k][i]);
		free(s->listeners[k]);
	}
	free(s->all);
	free(s->unheld);
	free(s->acts.v);
	free(s->earlies.v);
	free(s->landed);
	free(s->queued);
	free(s->thrown);
	free(s->escaped);
	s->life->gone = true;
	if (--s->life->refs == 0) free(s->life);
	free(s);
}
