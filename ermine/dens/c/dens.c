// dens (dens.h), in C.
#include "dens.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../filesystem/places/c/status.h"
#include "../../encoding/c/cbor.h"
#include "../../encoding/c/hash.h"
#include "../../encoding/c/pack.h"
#include "../../processes/c/processes.h"
#include "../../processes/c/start.h"

const char *const dn_dens[2] = {"system", "dens"};
const char *const dn_here[2] = {"system", "den"};

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("dens: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// a and b, a "/" between: a derived id
static char *joined(const char *a, const char *b) {
	size_t n = strlen(a), m = strlen(b);
	char *s = xalloc(n + m + 2);
	memcpy(s, a, n);
	s[n] = '/';
	memcpy(s + n + 1, b, m + 1);
	return s;
}

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// x out of v, the rest kept in order
#define DROP(v, n, x) \
	do { \
		for (size_t i_ = 0; i_ < (n); i_++) { \
			if ((v)[i_] != (x)) continue; \
			memmove(&(v)[i_], &(v)[i_ + 1], ((n) - i_ - 1) * sizeof *(v)); \
			(n)--; \
			break; \
		} \
	} while (0)

static const char *const kinds[3] = {"runners", "compilers", "surfaces"};
static const char *const types[3] = {DN_TYPE_RUNNER, DN_TYPE_COMPILER, DN_TYPE_SURFACE};
enum { R_WITHDRAWN, R_RUNNER, R_DEN };

// an owner's folder of one kind: its node's id and scope, the scope's info
typedef struct {
	dn_kind kind;
	char *id;
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
} folder;

typedef struct offer offer;

// a process this den started, or the den's own (self): its node, its path, its scope and life; the
// folders of what it offers (in the order made) and its offers (in the order offered, while they
// stand). a started one's: where it runs, the offer it runs on (NULL: a runner node of no offer of
// this den's), the runner and the code as read at start, the handle once the runner gave one; ended,
// with the reason given (told: by a stop)
struct dn_process {
	dn *den;
	int self;
	char *id;
	char **at;
	size_t nat;
	sc_scope *scope;
	pr_process *life;
	folder folders[3];
	size_t nfolders;
	offer **offers;
	size_t noffers, capoffers;
	pl *where;
	offer *on;
	hf_entry fn;
	op_value *code;
	hf_handle handle;
	void (*stop_reason)(void *ctx, const op_value *reason);
	int has_handle;
	sc_computer *first;
	char *failure;
	op_value *reason;
	int ended, told;
	// the loads it holds, in the order made
	dn_loaded **loads;
	size_t nloads, caploads;
};

// a load: its live form, the process (or the den's own) holding it; released, closed
struct dn_loaded {
	dn *den;
	dn_process *by;
	hf_live live;
	int released;
};

// an offer: its node (id, path), its owner and folder, its scope and the scope's info, the processes
// running on it in start order; gone, its node torn down
struct offer {
	dn *den;
	char *id;
	char **at;
	size_t nat;
	dn_kind kind;
	char *name;
	dn_process *owner;
	folder *folder;
	sc_scope *scope;
	sc_pair info[2];
	op_value *values[2];
	dn_process **users;
	size_t nusers, capusers;
	int gone;
};

// what a refusal's strings are in, until the den's next call
typedef struct {
	char **names;
	size_t n;
	char *text;
} scrap;

struct dn {
	dn_setup s;
	char *id, *name;
	op_value *device;
	// the owner: [["den", id]], under the scope open at dn_new
	sc_scope *owner;
	sc_pair owner_info;
	op_value *owner_value;
	pr *life;
	dn_process *self;
	// on: the folder's and its methods' ids (start, stop), scopes, info
	char *on_ids[3];
	sc_scope *on_scopes[3];
	sc_pair on_info[3][2];
	op_value *on_values[3][2];
	// every process made (until dn_free); those running, in start order
	dn_process **all;
	size_t nall, capall;
	dn_process **running;
	size_t nrunning, caprunning;
	// every offer made (until dn_free); those standing
	offer **offers;
	size_t noffers, capoffers;
	offer **live;
	size_t nlive, caplive;
	// every load made (until dn_free)
	dn_loaded **loaded;
	size_t nloaded, caploaded;
	// what dn_nodes tracks, marked at every offer, withdraw, start and process end
	char version;
	int closed, here_placed, here_failed, freeing, queued;
	// the reason the den's own process goes with: dn_close's, else "den-stopped"
	op_value *pending;
	op_value *reasons[3];
	op_value *scratch;
	scrap *scraps;
	size_t nscraps, capscraps;
};

// small pieces ---------------------------------------------------------------------------------

static int is_str(const op_value *v) { return v != NULL && v->type == OP_STR; }
static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }
static const op_value *get(const op_value *map, const char *key) {
	return is_map(map) ? op_get(map, key) : NULL;
}
static const char *str_at(const op_value *map, const char *key) {
	const op_value *v = get(map, key);
	return is_str(v) ? v->str : NULL;
}

static char **copy_names(const char *const *names, size_t n) {
	char **copy = xalloc((n + 1) * sizeof *copy);
	for (size_t i = 0; i < n; i++) copy[i] = xdup(names[i]);
	return copy;
}

// names, then two more (a kind and a name): a path into what an owner holds
static char **names_and(const char *const *names, size_t n, const char *a, const char *b, size_t *out) {
	char **copy = xalloc((n + 3) * sizeof *copy);
	for (size_t i = 0; i < n; i++) copy[i] = xdup(names[i]);
	copy[n] = xdup(a);
	copy[n + 1] = xdup(b);
	*out = n + 2;
	return copy;
}

static op_value *names_value(const char *const *names, size_t n) {
	op_value *list = op_list();
	for (size_t i = 0; i < n; i++) op_push(list, op_str(names[i]));
	return list;
}

// an address as steps (copied): a string split as path.ts' parse does (a leading "/" is "/", empty
// pieces skipped), a list as it is (a step that is no string: ""); anything else: none
typedef struct {
	char **v;
	size_t n, cap;
} steps;

static steps steps_of(const op_value *a) {
	steps s = {0};
	if (is_str(a)) {
		const char *p = a->str;
		if (*p == '/') PUSH(s.v, s.n, s.cap, xdup("/"));
		while (*p) {
			const char *end = strchr(p, '/');
			size_t len = end != NULL ? (size_t)(end - p) : strlen(p);
			if (len > 0) {
				char *piece = xalloc(len + 1);
				memcpy(piece, p, len);
				PUSH(s.v, s.n, s.cap, piece);
			}
			p += len;
			if (*p == '/') p++;
		}
	} else if (a != NULL && a->type == OP_LIST) {
		for (size_t i = 0; i < a->count; i++) {
			PUSH(s.v, s.n, s.cap, xdup(is_str(a->items[i]) ? a->items[i]->str : ""));
		}
	}
	return s;
}

static void steps_free(steps *s) {
	for (size_t i = 0; i < s->n; i++) free(s->v[i]);
	free(s->v);
	*s = (steps){0};
}

// a refusal's strings, kept until the next call
static void forget(dn *d) {
	for (size_t i = 0; i < d->nscraps; i++) {
		if (d->scraps[i].names != NULL) pr_names_free(d->scraps[i].names, d->scraps[i].n);
		free(d->scraps[i].text);
	}
	d->nscraps = 0;
}
static const char *const *keep_names(dn *d, char **names, size_t n) {
	PUSH(d->scraps, d->nscraps, d->capscraps, ((scrap){names, n, NULL}));
	return (const char *const *)names;
}
static const char *keep_text(dn *d, const char *s) {
	if (s == NULL) return NULL;
	char *copy = xdup(s);
	PUSH(d->scraps, d->nscraps, d->capscraps, ((scrap){NULL, 0, copy}));
	return copy;
}

// a message taken (malloc'd), the den's until its next call
static const char *keep_owned(dn *d, char *s) {
	PUSH(d->scraps, d->nscraps, d->capscraps, ((scrap){NULL, 0, s}));
	return s;
}

static void pulse_now(void *data) {
	dn *d = data;
	d->queued = 0;
	sc_pulse(d->s.scheduler);
}
// one pulse asked for outside a run, however many ask (none to ask: the host pulses)
static void later(dn *d) {
	if (d->queued || d->s.schedule == NULL || sc_get_run(d->s.scheduler) != NULL) return;
	d->queued = 1;
	d->s.schedule(d->s.schedule_ctx, pulse_now, d);
}

static void set_reason(dn_process *p, const op_value *v) {
	op_value *was = p->reason;
	p->reason = v != NULL ? op_ref((op_value *)v) : NULL;
	op_free(was);
}

static offer *live_offer(const dn *d, const char *id) {
	for (size_t i = 0; id != NULL && i < d->nlive; i++) {
		if (strcmp(d->live[i]->id, id) == 0) return d->live[i];
	}
	return NULL;
}

static const op_value *attributes_of(const dn *d, const char *id) {
	const nd_entry *e = tb_get(d->s.table, tb_string("attributes"), tb_string(id));
	return e != NULL && is_map(e->value) ? e->value : NULL;
}

// told by the tracked reads of dn_nodes that what it says changed
static void changed(dn *d) {
	if (d->freeing) return;
	const void *keys[1] = {&d->version};
	sc_mark(d->s.scheduler, keys, 1, NULL);
}

// f with the scope open; torn down already (its own teardown): with what is open, as it is
static void within(sc_scope *o, void (*f)(void *data), void *data) {
	if (o != NULL && sc_scope_alive(o)) sc_run_with_scope(o, f, data);
	else f(data);
}

static void commit(dn *d, const pl_changed *changed) {
	if (d->s.commit != NULL) d->s.commit(d->s.commit_ctx, changed);
	else pl_commit(d->s.places, changed);
}

// writes, with a scope open ------------------------------------------------------------------------

enum { W_UPSERT, W_ADD, W_UNPLACE, W_HERE, W_UNHERE };

// one write: an upsert at path in (part, id); an entry added at (part, id); name out of id's
// children; the den at /system/den, or out of it. code: 0, places' code, -1 (no scope open)
typedef struct {
	dn *d;
	int what;
	const char *part, *id, *name;
	const char *const *path;
	size_t n;
	const op_value *value;
	int code;
} writing;

static void write_now(void *data) {
	writing *w = data;
	dn *d = w->d;
	pl *p = d->s.places;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(p, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) {
		free(bad);
		w->code = -1;
		return;
	}
	pl_changed changes = {0};
	nd_entry *born = NULL;
	switch (w->what) {
	case W_UPSERT:
		w->code = pl_upsert(p, tb_string(w->part), tb_string(w->id), w->path, w->n, w->value, h, &changes,
			&born);
		break;
	case W_ADD:
		born = nd_make_entry((op_value *)w->value, &h, NULL);
		pl_own(p, born);
		w->code = tb_add(d->s.table, tb_string(w->part), tb_string(w->id), born);
		break;
	case W_UNPLACE: {
		nd_entry *there = tb_get(d->s.table, tb_string("children"), tb_string(w->id));
		if (there != NULL && is_map(there->value) && op_get(there->value, w->name) != NULL) {
			w->code = pl_unplace(p, there, w->name, h, &changes);
		}
		break;
	}
	case W_HERE:
		w->code = pr_add(p, d->s.table, pl_root(p), dn_here, 2, tb_string(w->id), h, &changes, &born);
		break;
	case W_UNHERE:
		w->code = pr_remove(p, d->s.table, pl_root(p), dn_here, 2, h, &changes);
		break;
	}
	if (changes.n > 0) commit(d, &changes);
	for (size_t i = 0; i < changes.n; i++) {
		pl_hold_also(p, changes.entries[i], pl_made_ref(made), pl_made_free);
	}
	if (born != NULL) pl_hold(p, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

// the write with o open (o torn down: with what is open)
static int write_in(dn *d, sc_scope *o, writing w) {
	w.d = d;
	within(o, write_now, &w);
	return w.code;
}

// the policy -------------------------------------------------------------------------------------

// a read the policy makes: the table, untracked
static const op_value *quiet(void *ctx, const char *part, tb_key id, const op_value *path,
	const op_value *at) {
	(void)at;
	dn *d = ctx;
	size_t n = path != NULL && path->type == OP_LIST ? path->count : 0;
	op_key *keys = xalloc((n + 1) * sizeof *keys);
	for (size_t i = 0; i < n; i++) {
		const op_value *step = path->items[i];
		if (step->type == OP_STR) keys[i] = (op_key){.type = OP_STR_KEY, .s = step->str};
		else keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)step->num};
	}
	const nd_entry *e = tb_get(d->s.table, tb_string(part), id);
	const op_value *v = e != NULL ? pl_at(e->value, keys, n, d->scratch) : NULL;
	free(keys);
	return v;
}

static const char *const no_names[1] = {""};

// the policy asked; none: yes here, no for another den's. path NULL: not given
static pr_answer permit(dn *d, const op_value *who, const char *op, const char *part, const char *id,
	char *const *path, size_t npath, int remote) {
	if (d->s.may == NULL) {
		return remote ? (pr_answer){PR_NO, "no policy", NULL} : (pr_answer){PR_YES, NULL, NULL};
	}
	pr_ask ask = {.who = who, .op = op};
	ask.target.part = part;
	ask.target.id = tb_string(id);
	ask.target.path = path != NULL ? (const char *const *)path : NULL;
	if (path != NULL && npath == 0) ask.target.path = no_names;
	ask.target.npath = npath;
	return pr_ask_of(d->s.may, &ask, quiet, d);
}

// refused no-permission: the op asked, the answer (a pending's need dropped)
static void no_permission(dn_refusal *r, const char *op, pr_answer a) {
	r->refused = "no-permission";
	r->op = op;
	r->answer = a.verdict == PR_NO ? a : (pr_answer){PR_PENDING, NULL, NULL};
}

// stops, and the cascade -----------------------------------------------------------------------------

// its handle's stop, once, given the reason (a stop_reason: in place of handle.stop)
static void stop_handle(dn_process *p, const op_value *reason) {
	if (!p->has_handle) return;
	p->has_handle = 0;
	if (p->stop_reason != NULL) p->stop_reason(p->handle.ctx, reason);
	else if (p->handle.stop != NULL) p->handle.stop(p->handle.ctx);
}

static void retract(dn *d, offer *o, const op_value *why);

// a load closed, out of its holder's list; twice: nothing
static void release(dn_loaded *l) {
	if (l->released) return;
	l->released = 1;
	DROP(l->by->loads, l->by->nloads, l);
	if (l->live.close != NULL) l->live.close(l->live.data);
}

// every load an owner holds closed, newest first
static void let_go(dn_process *owner) {
	size_t n = owner->nloads;
	dn_loaded **copy = xalloc((n + 1) * sizeof *copy);
	if (n > 0) memcpy(copy, owner->loads, n * sizeof *copy);
	for (size_t i = n; i-- > 0;) release(copy[i]);
	free(copy);
}

// an owner's offers withdrawn, newest first
static void retract_all(dn *d, dn_process *owner, const op_value *why) {
	size_t n = owner->noffers;
	offer **copy = xalloc((n + 1) * sizeof *copy);
	if (n > 0) memcpy(copy, owner->offers, n * sizeof *copy);
	for (size_t i = n; i-- > 0;) retract(d, copy[i], why);
	free(copy);
}

// a process going (its stop, as processes' start calls it, or its scope torn down from above): its
// offers withdrawn newest first (their users stopped "runner-stopped"), then its handle's stop with
// the reason told (none told: the den's, the den going; else none), then its loads closed
static void process_end(pr_process *life, void *data) {
	(void)life;
	dn_process *p = data;
	dn *d = p->den;
	if (p->ended) return;
	p->ended = 1;
	if (d->freeing) {
		stop_handle(p, NULL);
		return;
	}
	if (!p->told) set_reason(p, sc_scope_alive(d->owner) ? NULL : d->pending);
	DROP(d->running, d->nrunning, p);
	if (p->on != NULL) DROP(p->on->users, p->on->nusers, p);
	retract_all(d, p, d->reasons[R_RUNNER]);
	stop_handle(p, p->reason);
	let_go(p);
	changed(d);
}

// a process stopped with a reason: processes' stop (its end, the row out, the scope gone)
static void halt(dn *d, dn_process *p, const op_value *why) {
	if (p->ended) return;
	p->told = 1;
	set_reason(p, why);
	if (p->life != NULL) pr_stop(d->life, p->life);
	else process_end(NULL, p);
}

// an offer's users stopped, newest first, with why
static void users(dn *d, offer *o, const op_value *why) {
	size_t n = o->nusers;
	dn_process **copy = xalloc((n + 1) * sizeof *copy);
	if (n > 0) memcpy(copy, o->users, n * sizeof *copy);
	for (size_t i = n; i-- > 0;) halt(d, copy[i], why);
	free(copy);
}

// its users stopped with why, its name out of its folder, its node gone
static void retract(dn *d, offer *o, const op_value *why) {
	if (o->gone) return;
	users(d, o, why);
	write_in(d, o->scope, (writing){.what = W_UNPLACE, .id = o->folder->id, .name = o->name});
	free(sc_teardown(o->scope));
}

// an offer's node going (withdrawn, or torn down from above): its users still running stopped
// "runner-stopped", it out of the lists
static char *offer_gone(void *data) {
	offer *o = data;
	dn *d = o->den;
	if (o->gone) return NULL;
	o->gone = 1;
	DROP(d->live, d->nlive, o);
	DROP(o->owner->offers, o->owner->noffers, o);
	users(d, o, d->reasons[R_RUNNER]);
	changed(d);
	return NULL;
}

// the den's own process going: its offers withdrawn (their users stopped with the den's reason),
// then /system/den out, if it was put there
static void den_end(pr_process *life, void *data) {
	(void)life;
	dn_process *self = data;
	dn *d = self->den;
	if (self->ended) return;
	self->ended = 1;
	d->closed = 1;
	if (d->freeing) return;
	retract_all(d, self, d->pending);
	let_go(self);
	if (d->here_placed) {
		d->here_placed = 0;
		writing w = {.d = d, .what = W_UNHERE};
		write_now(&w);
	}
	changed(d);
}

// running --------------------------------------------------------------------------------------------

// a one-shot effect's run: true, so it acts once
static sc_out once_f(void *previous, void *data) {
	(void)previous, (void)data;
	return (sc_out){.kind = SC_VALUE, .value = op_bool(1)};
}

static sc_out fail_f(void *previous, void *data) {
	(void)previous;
	return (sc_out){.kind = SC_FAILED, .error = xdup(data)};
}
static char *no_set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}

typedef struct {
	dn_process *p;
	hf_run out;
	sc_computer *outcome;
} calling;

// an owner's facts, as its runner is handed them
static dn_starting starting_of(dn_process *p) {
	dn *d = p->den;
	dn_starting st = {.places = pr_places(p->life), .root = pr_root(p->life),
		.scheduler = d->s.scheduler, .table = d->s.table, .scope = p->scope, .den = d};
	st.process.id = p->id;
	st.process.nat = pr_at(p->life, &st.process.at);
	st.process.nargs = pr_args(p->life, &st.process.args);
	st.process.ncwd = pr_cwd(p->life, &st.process.cwd);
	return st;
}

// the runner called with the code and the start's facts: the process's scope open
static void call_runner(void *data) {
	calling *c = data;
	dn_process *p = c->p;
	dn_starting st = starting_of(p);
	c->out = p->fn.runner(p->code, &st, p->fn.data);
}

// a computer that fails with the runner's failure, under the scope open
static void make_outcome(void *data) {
	calling *c = data;
	c->outcome = sc_create_computer(c->p->den->s.scheduler,
		(sc_def){.f = fail_f, .set = no_set, .data = c->p->failure}, NULL, 0);
}

// the runner called: a handle, kept (ended by now: stopped at once, with the reason); a failure, a
// computer that fails with it, its status the node's
static void run(dn_process *p) {
	dn *d = p->den;
	if (p->ended) return;
	calling c = {.p = p};
	sc_run_with_scope(p->scope, call_runner, &c);
	if (c.out.error != NULL) {
		free(p->failure);
		p->failure = c.out.error;
		if (p->ended) return;
		sc_run_with_scope(p->scope, make_outcome, &c);
		if (c.outcome != NULL) pr_give(d->life, p->life, c.outcome, 0);
		return;
	}
	if (c.out.handle.stop == NULL && c.out.stop_reason == NULL) return;
	p->handle = c.out.handle;
	p->stop_reason = c.out.stop_reason;
	p->has_handle = 1;
	if (p->ended) stop_handle(p, p->reason);
}

// the one act: the runner called, then the effect gone
static char *run_act(void *value, void *previous, void *data) {
	(void)value, (void)previous;
	dn_process *p = data;
	run(p);
	free(sc_teardown(p->first));
	return NULL;
}

// the den's status gone at the first pulse
static char *den_act(void *value, void *previous, void *data) {
	(void)value, (void)previous;
	dn_process *self = data;
	free(sc_teardown(self->first));
	return NULL;
}

// in the process's scope, as processes' start gives it: it running, on its offer, and the effect that
// calls the runner at the first pulse, its status (and run) the node's
static void process_body(pr_process *life, void *data) {
	dn_process *p = data;
	dn *d = p->den;
	p->life = life;
	p->id = xdup(pr_id(life));
	const char *const *at;
	p->nat = pr_at(life, &at);
	p->at = copy_names(at, p->nat);
	p->scope = pr_scope(life);
	PUSH(d->running, d->nrunning, d->caprunning, p);
	if (p->on != NULL) PUSH(p->on->users, p->on->nusers, p->on->capusers, p);
	p->first = sc_create_effect(d->s.scheduler, (sc_def){.f = once_f, .effect = run_act, .data = p},
		NULL, 0);
	if (p->first != NULL) pr_give(d->life, life, p->first, 1);
}

// the den -------------------------------------------------------------------------------------------

static sc_scope *scope_of(dn *d, sc_pair *info, op_value **values, const char *key, const char *what,
	const char *id, sc_scope *parent) {
	values[0] = op_str(what);
	values[1] = op_str(id);
	info[0] = (sc_pair){key, values[0]};
	info[1] = (sc_pair){PL_NODE, values[1]};
	sc_scope *o = sc_create_scope(d->s.scheduler, info, 2, parent);
	if (o != NULL) sn_give(d->s.scopes, o, id);
	return o;
}

// the den's children { on }, the folder on { start, stop }, each a method node holding hf_value("")
static void methods(dn *d) {
	dn_process *self = d->self;
	d->on_ids[0] = joined(self->id, DN_ON);
	d->on_ids[1] = joined(d->on_ids[0], "start");
	d->on_ids[2] = joined(d->on_ids[0], "stop");
	const char *on[1] = {DN_ON};
	op_value *folder_id = op_str(d->on_ids[0]);
	write_in(d, NULL, (writing){.what = W_UPSERT, .part = "children", .id = self->id, .path = on,
		.n = 1, .value = folder_id});
	op_free(folder_id);
	d->on_scopes[0] = scope_of(d, d->on_info[0], d->on_values[0], "den", DN_ON, d->on_ids[0],
		self->scope);
	op_value *ids = op_map();
	static const char *const names[2] = {DN_ON "/start", DN_ON "/stop"};
	for (size_t k = 1; k < 3; k++) {
		d->on_scopes[k] = scope_of(d, d->on_info[k], d->on_values[k], "den", names[k - 1], d->on_ids[k],
			d->on_scopes[0]);
		op_value *fn = hf_value("");
		write_in(d, d->on_scopes[k], (writing){.what = W_ADD, .part = "value", .id = d->on_ids[k],
			.value = fn});
		op_free(fn);
		op_set(ids, k == 1 ? "start" : "stop", op_str(d->on_ids[k]));
	}
	write_in(d, d->on_scopes[0], (writing){.what = W_ADD, .part = "children", .id = d->on_ids[0],
		.value = ids});
	op_free(ids);
}

// in the den's scope, as processes' start gives it: its methods, /system/den, and the effect that
// takes its status away at the first pulse
static void den_body(pr_process *life, void *data) {
	dn_process *self = data;
	dn *d = self->den;
	self->life = life;
	self->id = xdup(pr_id(life));
	const char *const *at;
	self->nat = pr_at(life, &at);
	self->at = copy_names(at, self->nat);
	self->scope = pr_scope(life);
	methods(d);
	writing w = {.d = d, .what = W_HERE, .id = self->id};
	write_now(&w);
	if (w.code != 0) {
		d->here_failed = w.code > 0 ? w.code : PL_ALREADY_THERE;
		return;
	}
	d->here_placed = 1;
	self->first = sc_create_effect(d->s.scheduler, (sc_def){.f = once_f, .effect = den_act, .data = self},
		NULL, 0);
	if (self->first != NULL) pr_give(d->life, life, self->first, 0);
}

dn *dn_new_at(const dn_setup *setup, const char **error, const char *file, int line, const char *func) {
	if (setup->id == NULL || !pl_is_name(setup->id)) {
		*error = pl_code_name(PL_NOT_A_NAME);
		return NULL;
	}
	dn *d = xalloc(sizeof *d);
	d->s = *setup;
	d->id = xdup(setup->id);
	d->s.id = d->id;
	d->name = setup->name != NULL ? xdup(setup->name) : NULL;
	d->s.name = d->name;
	d->device = setup->device != NULL ? op_ref((op_value *)setup->device) : NULL;
	d->s.device = d->device;
	d->reasons[R_WITHDRAWN] = op_str(DN_WITHDRAWN);
	d->reasons[R_RUNNER] = op_str(DN_RUNNER_STOPPED);
	d->reasons[R_DEN] = op_str(DN_DEN_STOPPED);
	d->pending = op_ref(d->reasons[R_DEN]);
	d->scratch = op_num(0);
	d->owner_value = op_str(d->id);
	d->owner_info = (sc_pair){"den", d->owner_value};
	d->self = xalloc(sizeof *d->self);
	d->self->den = d;
	d->self->self = 1;
	PUSH(d->all, d->nall, d->capall, d->self);
	d->owner = sc_create_scope(setup->scheduler, &d->owner_info, 1, NULL);
	if (d->owner == NULL) {
		*error = SC_UNSCOPED;
		d->self->ended = 1;
		dn_free(d);
		return NULL;
	}
	if (setup->sites != NULL) st_note(setup->sites, d->owner, file, line, func);
	d->life = pr_new_at(&(pr_setup){.scheduler = setup->scheduler, .table = setup->table,
		.places = setup->places, .scopes = setup->scopes, .commit = setup->commit,
		.commit_ctx = setup->commit_ctx, .sites = setup->sites, .runs = setup->runs, .owner = d->owner},
		file, line, func);
	op_value *attrs = op_map();
	op_set(attrs, DN_ATTRIBUTE, op_str(DN_TYPE_DEN));
	op_set(attrs, DN_ID, op_str(d->id));
	if (d->name != NULL) op_set(attrs, DN_NAME, op_str(d->name));
	if (d->device != NULL) op_set(attrs, DN_DEVICE, op_ref(d->device));
	const char *at[3] = {dn_dens[0], dn_dens[1], d->id};
	pr_refusal no;
	pr_process *life = pr_start_at(d->life, setup->places, at, 3,
		&(pr_options){.body = den_body, .stop = den_end, .data = d->self, .attributes = attrs}, &no,
		file, line, func);
	op_free(attrs);
	if (life == NULL || d->here_failed) {
		free(sc_teardown(d->owner));
		if (life != NULL) *error = pl_code_name(d->here_failed);
		else if (strcmp(no.refused, "taken") == 0) *error = pl_code_name(PL_ALREADY_THERE);
		else *error = no.refused;
		d->self->ended = 1;
		pr_halt(d->life);
		dn_free(d);
		return NULL;
	}
	return d;
}

const char *dn_id(const dn *d) { return d->id; }
const char *dn_node(const dn *d) { return d->self->id; }
dn_process *dn_self(const dn *d) { return d->self; }
sc_scope *dn_scope(const dn *d) { return d->owner; }
pl *dn_places(const dn *d) { return d->s.places; }
sc_scheduler *dn_scheduler(const dn *d) { return d->s.scheduler; }
tb_table *dn_table(const dn *d) { return d->s.table; }

// offers --------------------------------------------------------------------------------------------

// the owner's folder of the kind; NULL: none made yet
static folder *folder_of(dn_process *o, dn_kind kind) {
	for (size_t i = 0; i < o->nfolders; i++) {
		if (o->folders[i].kind == kind) return &o->folders[i];
	}
	return NULL;
}

const char *dn_offer(dn *d, dn_process *by, dn_kind kind, const char *name,
	const op_value *attributes, const op_value *live, dn_refusal *refused) {
	forget(d);
	*refused = (dn_refusal){0};
	if (d->closed) return refused->refused = "stopped", NULL;
	if ((unsigned)kind > DN_SURFACES || name == NULL || !pl_is_name(name)) {
		return refused->refused = pl_code_name(PL_NOT_A_NAME), NULL;
	}
	dn_process *o = by == NULL ? d->self : by;
	if (o->den != d || o->ended || o->life == NULL) {
		return refused->refused = pl_code_name(PL_NOTHING_THERE), NULL;
	}
	size_t nat;
	char **at = names_and((const char *const *)o->at, o->nat, kinds[kind], name, &nat);
	char *fid = joined(o->id, kinds[kind]);
	char *id = joined(fid, name);
	size_t there = 0;
	tb_at(d->s.table, tb_string(id), &there);
	if (live_offer(d, id) != NULL || there > 0) {
		free(fid);
		free(id);
		refused->refused = "taken";
		refused->at = keep_names(d, at, nat);
		refused->nat = nat;
		return NULL;
	}
	folder *f = folder_of(o, kind);
	if (f == NULL) {
		f = &o->folders[o->nfolders++];
		f->kind = kind;
		f->id = fid;
		f->scope = scope_of(d, f->info, f->values, "offers", kinds[kind], fid, o->scope);
		const char *path[1] = {kinds[kind]};
		op_value *v = op_str(fid);
		write_in(d, f->scope, (writing){.what = W_UPSERT, .part = "children", .id = o->id, .path = path,
			.n = 1, .value = v});
		op_free(v);
	} else free(fid);
	offer *x = xalloc(sizeof *x);
	x->den = d;
	x->id = id;
	x->at = at;
	x->nat = nat;
	x->kind = kind;
	x->name = xdup(name);
	x->owner = o;
	x->folder = f;
	x->scope = scope_of(d, x->info, x->values, "offer", name, id, f->scope);
	PUSH(d->offers, d->noffers, d->capoffers, x);
	PUSH(d->live, d->nlive, d->caplive, x);
	PUSH(o->offers, o->noffers, o->capoffers, x);
	if (x->scope != NULL) free(sc_register_teardown(d->s.scheduler, x->scope, offer_gone, x));
	// the attributes as given, the kind's type over them; the value; its name in the folder
	op_value *attrs = op_map();
	if (is_map(attributes)) {
		for (size_t i = 0; i < attributes->count; i++) {
			op_set_name(attrs, attributes->keys[i], op_ref(attributes->items[i]));
		}
	}
	op_set(attrs, DN_ATTRIBUTE, op_str(types[kind]));
	write_in(d, x->scope, (writing){.what = W_ADD, .part = "attributes", .id = id, .value = attrs});
	op_free(attrs);
	if (live != NULL) {
		write_in(d, x->scope, (writing){.what = W_ADD, .part = "value", .id = id, .value = live});
	}
	const char *path[1] = {name};
	op_value *v = op_str(id);
	write_in(d, x->scope, (writing){.what = W_UPSERT, .part = "children", .id = f->id, .path = path,
		.n = 1, .value = v});
	op_free(v);
	changed(d);
	return x->id;
}

size_t dn_offered_at(dn *d, const char *id, const char *const **out) {
	offer *o = live_offer(d, id);
	if (o == NULL) return 0;
	*out = (const char *const *)o->at;
	return o->nat;
}

void dn_withdraw(dn *d, const char *id) {
	offer *o = live_offer(d, id);
	if (o != NULL) retract(d, o, d->reasons[R_WITHDRAWN]);
}

// start ----------------------------------------------------------------------------------------------

// what a start found, as it checks: the runner, the program, its code, its form, its hash
typedef struct {
	char **rpath;
	size_t nr;
	char *rid;
	char **ppath;
	size_t npp;
	char *pid;
	const op_value *code;
	const op_value *type, *api;
	op_value *own_type, *own_api;
	int carried, hashed;
	char hex[65];
} found;

static void found_free(found *f) {
	if (f->rpath != NULL) pr_names_free(f->rpath, f->nr);
	if (f->ppath != NULL) pr_names_free(f->ppath, f->npp);
	free(f->rid);
	free(f->pid);
	op_free(f->own_type);
	op_free(f->own_api);
}

typedef struct {
	pl *places;
	const char *const *path;
	size_t n;
	char *id;
} getting;

// the id at the path (a string), copied
static void get_now(void *data) {
	getting *g = data;
	tb_key id;
	if (pl_get(g->places, g->path, g->n, &id) && id.symbol == NULL) g->id = xdup(id.string);
}

// the id at a path from the places' root, untracked; NULL: nothing there
static char *resolve(pl *p, char *const *path, size_t n) {
	getting g = {p, (const char *const *)path, n, NULL};
	pl_peep(p, get_now, &g);
	return g.id;
}

// a value the same as another, as === has it: a scalar's value; a list or map is only itself
static int same_scalar(const op_value *a, const op_value *b) {
	if (a == NULL || b == NULL) return a == b;
	if (a->type == OP_LIST || a->type == OP_MAP || a->type == OP_STAND || a->type == OP_BYTES ||
		a->type == OP_TYPED)
		return a == b;
	return pr_same(a, b);
}

// refused not-there: the program's path (kept), or its id
static int not_there_at(dn *d, found *f, dn_refusal *r) {
	r->refused = "not-there";
	r->program_has_at = 1;
	r->program_at = keep_names(d, f->ppath, f->npp);
	r->nprogram_at = f->npp;
	f->ppath = NULL;
	return 0;
}
static int not_there_id(dn *d, found *f, dn_refusal *r) {
	r->refused = "not-there";
	r->program = keep_text(d, f->pid);
	return 0;
}

// the program: its node (or the code carried), its code read once, its form; 0: refused
static int program_of(dn *d, pl *where, const dn_program *program, found *f, dn_refusal *r) {
	const nd_entry *e;
	f->carried = !program->has_at && program->code != NULL;
	if (program->has_at) {
		f->ppath = pr_names(program->at, program->nat, &f->npp);
		f->pid = resolve(where, f->ppath, f->npp);
		e = f->pid != NULL ? tb_get(d->s.table, tb_string("value"), tb_string(f->pid)) : NULL;
		if (e == NULL) return not_there_at(d, f, r);
		f->code = e->value;
	} else {
		f->pid = xdup(program->id != NULL ? program->id : "");
		if (f->carried) f->code = program->code;
		else {
			e = tb_get(d->s.table, tb_string("value"), tb_string(f->pid));
			if (e == NULL) return not_there_id(d, f, r);
			f->code = e->value;
		}
	}
	f->hashed = f->code != NULL && dn_hash_hex(f->code, f->hex);
	if (!program->has_at && program->hash != NULL &&
		(!f->hashed || strcmp(program->hash, f->hex) != 0))
		return not_there_id(d, f, r);
	if (f->carried) {
		f->type = f->own_type = program->type != NULL ? op_str(program->type) : NULL;
		f->api = f->own_api = program->api != NULL ? op_str(program->api) : NULL;
	} else {
		const op_value *attrs = attributes_of(d, f->pid);
		f->type = get(attrs, DN_ATTRIBUTE);
		f->api = get(attrs, DN_PROGRAM_API);
	}
	return 1;
}

// refused not-a-runner: the runner's path, kept
static dn_process *not_a_runner(dn *d, found *f, dn_refusal *r) {
	r->refused = "not-a-runner";
	r->runner = keep_names(d, f->rpath, f->nr);
	r->nrunner = f->nr;
	f->rpath = NULL;
	found_free(f);
	return NULL;
}

// start's checks in order, up to taken (processes'): the runner and its entry (load: one with a
// load), the program found, the policy asked. 0: refused, f let go; 1: f the caller's to let go
static int check(dn *d, const op_value *who, int remote, const char *const *runner, size_t nrunner,
	const dn_program *program, pl *where, int load, found *f, const hf_entry **out,
	dn_refusal *refused) {
	*refused = (dn_refusal){0};
	if (d->closed) return refused->refused = "stopped", 0;
	f->rpath = pr_names(runner, nrunner, &f->nr);
	f->rid = resolve(d->s.places, f->rpath, f->nr);
	const op_value *rattrs = f->rid != NULL ? attributes_of(d, f->rid) : NULL;
	const op_value *rtype = get(rattrs, DN_ATTRIBUTE);
	if (!is_str(rtype) || strcmp(rtype->str, DN_TYPE_RUNNER) != 0) {
		return not_a_runner(d, f, refused), 0;
	}
	if (!program_of(d, where, program, f, refused)) return found_free(f), 0;
	const op_value *takes = get(rattrs, DN_TAKES), *gives = get(rattrs, DN_API);
	int fits = is_str(f->type) && is_str(takes) && strcmp(f->type->str, takes->str) == 0;
	if (fits && f->api != NULL && !same_scalar(f->api, gives)) fits = 0;
	if (!fits) {
		refused->refused = "wrong-form";
		refused->type = is_str(f->type) ? keep_text(d, f->type->str) : NULL;
		refused->api = is_str(f->api) ? keep_text(d, f->api->str) : NULL;
		refused->takes = is_str(takes) ? keep_text(d, takes->str) : NULL;
		refused->runner_api = is_str(gives) ? keep_text(d, gives->str) : NULL;
		found_free(f);
		return 0;
	}
	const nd_entry *fv = tb_get(d->s.table, tb_string("value"), tb_string(f->rid));
	const hf_entry *fn = fv != NULL ? hf_find(d->s.functions, fv->value) : NULL;
	if (fn == NULL || (load ? fn->load == NULL : fn->runner == NULL)) {
		return not_a_runner(d, f, refused), 0;
	}
	pr_answer a = permit(d, who, "start", NULL, f->rid, f->rpath, f->nr, remote);
	if (a.verdict != PR_YES) return no_permission(refused, "start", a), found_free(f), 0;
	if (!f->carried) {
		a = permit(d, who, "read", "value", f->pid, f->ppath, f->npp, remote);
		if (a.verdict != PR_YES) return no_permission(refused, "read", a), found_free(f), 0;
	}
	*out = fn;
	return 1;
}

// start's checks, then processes' start. who: the policy's; remote: another den's ask
static dn_process *begin(dn *d, const op_value *who, int remote, const char *const *runner,
	size_t nrunner, const dn_program *program, const char *const *steps, size_t nsteps,
	const dn_options *options, dn_refusal *refused, const char *file, int line, const char *func) {
	dn_options none = {0};
	const dn_options *o = options != NULL ? options : &none;
	pl *where = o->box != NULL ? o->box : d->s.places;
	found f = {0};
	const hf_entry *fn = NULL;
	if (!check(d, who, remote, runner, nrunner, program, where, 0, &f, &fn, refused)) return NULL;
	op_value *attrs = op_map();
	op_set(attrs, DN_ATTRIBUTE, op_str(DN_TYPE_PROCESS));
	op_value *rv = op_map();
	op_set(rv, "id", op_str(f.rid));
	op_set(rv, "at", names_value((const char *const *)f.rpath, f.nr));
	op_set(attrs, DN_RUNNER, rv);
	op_value *pv = op_map();
	op_set(pv, "id", op_str(f.pid));
	if (f.ppath != NULL) op_set(pv, "at", names_value((const char *const *)f.ppath, f.npp));
	if (f.hashed) op_set(pv, "hash", op_str(f.hex));
	op_set(attrs, DN_PROGRAM, pv);
	op_value *dv = op_map();
	op_set(dv, "id", op_str(d->self->id));
	op_set(dv, "at", names_value((const char *const *)d->self->at, d->self->nat));
	op_set(attrs, DN_DEN, dv);
	dn_process *p = xalloc(sizeof *p);
	p->den = d;
	p->where = where;
	p->on = live_offer(d, f.rid);
	p->fn = *fn;
	p->code = f.code != NULL ? op_ref((op_value *)f.code) : NULL;
	PUSH(d->all, d->nall, d->capall, p);
	pr_refusal no;
	pr_process *life = pr_start_at(d->life, where, steps, nsteps,
		&(pr_options){.args = o->args, .nargs = o->nargs, .has_args = o->has_args, .cwd = o->cwd,
			.ncwd = o->ncwd, .has_cwd = o->has_cwd, .pin = o->pin, .body = process_body,
			.stop = process_end, .data = p, .attributes = attrs},
		&no, file, line, func);
	op_free(attrs);
	found_free(&f);
	if (life == NULL) {
		// refused: made no more (its pieces freed at dn_free)
		p->ended = 1;
		refused->refused = no.refused;
		refused->at = no.at, refused->nat = no.nat;
		return NULL;
	}
	changed(d);
	later(d);
	return p;
}

dn_process *dn_start_at(dn *d, const char *const *runner, size_t nrunner, const dn_program *program,
	const char *const *at, size_t nat, const dn_options *options, dn_refusal *refused,
	const char *file, int line, const char *func) {
	forget(d);
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	dn_process *p = begin(d, who, 0, runner, nrunner, program, at, nat, options, refused, file, line,
		func);
	op_free(who);
	return p;
}

// load -------------------------------------------------------------------------------------------------

typedef struct {
	const hf_entry *fn;
	const op_value *code;
	hf_loaded out;
} loading;

static void call_load(void *data) {
	loading *l = data;
	l->out = l->fn->load(l->code, l->fn->data);
}

dn_loaded *dn_load(dn *d, dn_process *by, const char *const *runner, size_t nrunner,
	const dn_program *program, const dn_options *options, dn_refusal *refused) {
	forget(d);
	*refused = (dn_refusal){0};
	if (d->closed) return refused->refused = "stopped", NULL;
	dn_process *o = by != NULL ? by : d->self;
	if (o->den != d || o->ended || o->life == NULL) return refused->refused = "nothing-there", NULL;
	pl *where = options != NULL && options->box != NULL ? options->box : pr_places(o->life);
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	found f = {0};
	const hf_entry *fn = NULL;
	int ok = check(d, who, 0, runner, nrunner, program, where, 1, &f, &fn, refused);
	op_free(who);
	if (!ok) return NULL;
	loading l = {.fn = fn, .code = f.code};
	if (sc_get_current_scope(d->s.scheduler) != NULL) call_load(&l);
	else sc_run_with_scope(o->scope, call_load, &l);
	found_free(&f);
	if (l.out.error != NULL) {
		refused->refused = "failed";
		refused->error = keep_owned(d, l.out.error);
		return NULL;
	}
	dn_loaded *x = xalloc(sizeof *x);
	x->den = d;
	x->by = o;
	x->live = l.out.live;
	PUSH(d->loaded, d->nloaded, d->caploaded, x);
	PUSH(o->loads, o->nloads, o->caploads, x);
	later(d);
	return x;
}

const hf_live *dn_loaded_live(const dn_loaded *l) { return &l->live; }

void dn_release(dn *d, dn_loaded *l) {
	if (l == NULL || l->den != d) return;
	release(l);
}

// stop -------------------------------------------------------------------------------------------------

// asked stop on its node; the den's own: close
static int stop_as(dn *d, const op_value *who, int remote, dn_process *p, const op_value *reason,
	dn_refusal *refused) {
	*refused = (dn_refusal){0};
	if (p == NULL || p->den != d || p->ended || p->life == NULL || (p->self && d->closed)) return 0;
	pr_answer a = permit(d, who, "stop", NULL, p->id, p->at, p->nat, remote);
	if (a.verdict != PR_YES) return no_permission(refused, "stop", a), 1;
	if (p->self) dn_close(d, reason);
	else halt(d, p, reason);
	return 0;
}

int dn_stop(dn *d, dn_process *p, const op_value *reason, dn_refusal *refused) {
	forget(d);
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	int r = stop_as(d, who, 0, p, reason, refused);
	op_free(who);
	return r;
}

void dn_close(dn *d, const op_value *reason) {
	if (d->closed) return;
	d->closed = 1;
	op_value *was = d->pending;
	d->pending = op_ref((op_value *)(reason != NULL ? reason : d->reasons[R_DEN]));
	op_free(was);
	size_t n = d->nrunning;
	dn_process **copy = xalloc((n + 1) * sizeof *copy);
	if (n > 0) memcpy(copy, d->running, n * sizeof *copy);
	for (size_t i = n; i-- > 0;) halt(d, copy[i], d->pending);
	free(copy);
	if (d->self->life != NULL) pr_stop(d->life, d->self->life);
	free(sc_teardown(d->owner));
}

// asks and methods ---------------------------------------------------------------------------------

static op_value *with_refused(const char *refused) {
	op_value *m = op_map();
	op_set(m, "refused", op_str(refused));
	return m;
}

// a start's answer: { id, at }
static op_value *id_at(const dn_process *p) {
	op_value *m = op_map();
	op_set(m, "id", op_str(p->id));
	op_set(m, "at", names_value((const char *const *)p->at, p->nat));
	return m;
}

// an address of strings: a string, or a list of strings
static int is_path(const op_value *a) {
	if (is_str(a)) return 1;
	if (a == NULL || a->type != OP_LIST) return 0;
	for (size_t i = 0; i < a->count; i++) {
		if (!is_str(a->items[i])) return 0;
	}
	return 1;
}

// steps as given: none, no address, or an address of strings (a list with a step that is no
// string: not)
static int steps_fit(const op_value *a) { return a == NULL || a->type != OP_LIST || is_path(a); }

// a start as a map gives it: runner, program (an address, or { id, hash?, type?, api?, code? }), at,
// args?, cwd?, and pin? (local only). runner and at no address: none; program neither: { id: "" };
// a step that is no string, args given that are no list of strings, a cwd given that is no address:
// refused not-a-name
static op_value *start_from(dn *d, const op_value *who, int remote, const op_value *b) {
	const op_value *given_args = get(b, "args"), *given_cwd = get(b, "cwd");
	if (!steps_fit(get(b, "runner")) || !steps_fit(get(b, "at")) || !steps_fit(get(b, "program")) ||
		(given_cwd != NULL && !is_path(given_cwd)) ||
		(given_args != NULL && (given_args->type != OP_LIST || !is_path(given_args))))
		return with_refused(pl_code_name(PL_NOT_A_NAME));
	steps runner = steps_of(get(b, "runner")), at = steps_of(get(b, "at"));
	steps cwd = steps_of(get(b, "cwd")), args = steps_of(get(b, "args")), program = {0};
	dn_program prog = {0};
	const op_value *pv = get(b, "program");
	if (pv != NULL && (pv->type == OP_STR || pv->type == OP_LIST)) {
		program = steps_of(pv);
		prog.at = (const char *const *)program.v, prog.nat = program.n, prog.has_at = 1;
	} else {
		prog.id = str_at(pv, "id");
		prog.hash = str_at(pv, "hash");
		// a hash that is no string: none's
		if (prog.hash == NULL && get(pv, "hash") != NULL) prog.hash = "";
		prog.type = str_at(pv, "type");
		prog.api = str_at(pv, "api");
		prog.code = get(pv, "code");
	}
	dn_options o = {.args = (const char *const *)args.v, .nargs = args.n,
		.has_args = get(b, "args") != NULL, .cwd = (const char *const *)cwd.v, .ncwd = cwd.n,
		.has_cwd = get(b, "cwd") != NULL, .pin = remote ? NULL : get(b, "pin")};
	dn_refusal r;
	dn_process *p = begin(d, who, remote, (const char *const *)runner.v, runner.n, &prog,
		(const char *const *)at.v, at.n, &o, &r, __FILE__, __LINE__, __func__);
	op_value *out = p != NULL ? id_at(p) : dn_refusal_value(&r);
	steps_free(&runner), steps_free(&at), steps_free(&cwd), steps_free(&args), steps_free(&program);
	return out;
}

op_value *dn_ask(dn *d, const op_value *who, const op_value *ask) {
	forget(d);
	const char *op = str_at(ask, "op");
	if (op == NULL || (strcmp(op, "start") != 0 && strcmp(op, "stop") != 0)) return NULL;
	if (d->closed) return with_refused("stopped");
	if (op[2] == 'a') return start_from(d, who, 1, ask);
	const char *id = str_at(ask, "process");
	dn_process *p = dn_find(d, id);
	if (p == NULL) {
		op_value *m = with_refused("not-there");
		const op_value *given = get(ask, "process");
		op_set(m, "process", given != NULL ? op_ref((op_value *)given) : op_null());
		return m;
	}
	dn_refusal r;
	if (stop_as(d, who, 1, p, get(ask, "reason"), &r)) return dn_refusal_value(&r);
	return op_map();
}

op_value *dn_on(dn *d, const char *op, const op_value *body) {
	forget(d);
	if (op == NULL || (strcmp(op, "start") != 0 && strcmp(op, "stop") != 0)) return NULL;
	op_value *who = pl_change_base(d->s.places, NULL, 0);
	op_value *out;
	if (op[2] == 'a') out = start_from(d, who, 0, body);
	else {
		const char *id = str_at(body, "process");
		dn_process *p = id != NULL && d->self->id != NULL && strcmp(id, d->self->id) == 0 ? d->self
		                                                                                  : dn_find(d, id);
		dn_refusal r;
		out = stop_as(d, who, 0, p, get(body, "reason"), &r) ? dn_refusal_value(&r) : op_map();
	}
	op_free(who);
	return out;
}

op_value *dn_refusal_value(const dn_refusal *r) {
	op_value *m = with_refused(r->refused);
	const char *k = r->refused;
	if (strcmp(k, "not-a-runner") == 0) op_set(m, "runner", names_value(r->runner, r->nrunner));
	else if (strcmp(k, "not-there") == 0) {
		if (r->process != NULL) op_set(m, "process", op_str(r->process));
		else if (r->program_has_at) op_set(m, "program", names_value(r->program_at, r->nprogram_at));
		else op_set(m, "program", op_str(r->program != NULL ? r->program : ""));
	} else if (strcmp(k, "wrong-form") == 0) {
		op_value *program = op_map(), *runner = op_map();
		if (r->type != NULL) op_set(program, "type", op_str(r->type));
		if (r->api != NULL) op_set(program, "api", op_str(r->api));
		if (r->takes != NULL) op_set(runner, "takes", op_str(r->takes));
		if (r->runner_api != NULL) op_set(runner, "api", op_str(r->runner_api));
		op_set(m, "program", program);
		op_set(m, "runner", runner);
	} else if (strcmp(k, "no-permission") == 0) {
		op_set(m, "op", op_str(r->op != NULL ? r->op : ""));
		op_value *a = op_map();
		if (r->answer.verdict == PR_NO) {
			op_set(a, "answer", op_str("no"));
			op_set(a, "reason", op_str(r->answer.reason != NULL ? r->answer.reason : ""));
		} else op_set(a, "answer", op_str("pending"));
		op_set(m, "answer", a);
	} else if (strcmp(k, "taken") == 0) op_set(m, "at", names_value(r->at, r->nat));
	return m;
}

// reads ----------------------------------------------------------------------------------------------

dn_process *dn_find(const dn *d, const char *id) {
	for (size_t i = 0; id != NULL && i < d->nrunning; i++) {
		if (strcmp(d->running[i]->id, id) == 0) return d->running[i];
	}
	return NULL;
}

size_t dn_processes(const dn *d, dn_process *const **out) {
	*out = d->running;
	return d->nrunning;
}

const char *dn_process_id(const dn_process *p) { return p->id; }
size_t dn_process_at(const dn_process *p, const char *const **out) {
	*out = (const char *const *)p->at;
	return p->nat;
}
sc_scope *dn_process_scope(const dn_process *p) { return p->scope; }

// whether a value has an encoding (what travels)
static int encodes(const op_value *v) {
	if (v == NULL || hf_holds(v)) return 0;
	Json *j = pk_to_json(v);
	if (j == NULL) return 0;
	size_t length;
	const char *why = NULL;
	int ok = cborEncode(j, NULL, 0, &length, &why);
	jsonFree(j);
	return ok;
}

// the attributes as they travel, the read told: the status as "pending" | { failed }, no other with
// no encoding. none: NULL
static op_value *shown(dn *d, const char *id) {
	const op_value *v = pl_read(d->s.places, tb_string("attributes"), tb_string(id), NULL, 0);
	if (!is_map(v)) return NULL;
	op_value *out = op_map();
	for (size_t i = 0; i < v->count; i++) {
		const op_value *x = v->items[i];
		if (strcmp(v->keys[i], CST_ATTRIBUTE) == 0) {
			if (cst_is_pending(x)) op_set(out, CST_ATTRIBUTE, op_str("pending"));
			else if (cst_error(x) != NULL) {
				op_value *failed = op_map();
				op_set(failed, "failed", op_str(cst_error(x)));
				op_set(out, CST_ATTRIBUTE, failed);
			}
		} else if (encodes(x)) op_set_name(out, v->keys[i], op_ref((op_value *)x));
	}
	return out;
}

// a node as seen: its attributes (if any), its children (kids, if any; taken)
static void seen(dn *d, op_value *nodes, const char *id, op_value *kids) {
	op_value *n = op_map();
	op_value *attributes = shown(d, id);
	if (attributes != NULL) op_set(n, "attributes", attributes);
	if (kids->count > 0) op_set(n, "children", kids);
	else op_free(kids);
	op_set(nodes, id, n);
}

// an owner, its folders and its offers, as seen; kids: its children dens wrote besides (taken)
static void offered(dn *d, op_value *nodes, dn_process *o, op_value *kids) {
	for (size_t i = 0; i < o->nfolders; i++) {
		op_set(kids, kinds[o->folders[i].kind], op_str(o->folders[i].id));
	}
	seen(d, nodes, o->id, kids);
	for (size_t i = 0; i < o->nfolders; i++) {
		op_value *names = op_map();
		for (size_t k = 0; k < o->noffers; k++) {
			if (o->offers[k]->kind == o->folders[i].kind) {
				op_set(names, o->offers[k]->name, op_str(o->offers[k]->id));
			}
		}
		op_value *n = op_map();
		op_set(n, "children", names);
		op_set(nodes, o->folders[i].id, n);
	}
	for (size_t k = 0; k < o->noffers; k++) seen(d, nodes, o->offers[k]->id, op_map());
}

op_value *dn_nodes(dn *d, int processes) {
	sc_track(d->s.scheduler, &d->version);
	op_value *nodes = op_map();
	op_value *kids = op_map();
	op_set(kids, DN_ON, op_str(d->on_ids[0]));
	offered(d, nodes, d->self, kids);
	op_value *on = op_map(), *methods = op_map();
	op_set(methods, "start", op_str(d->on_ids[1]));
	op_set(methods, "stop", op_str(d->on_ids[2]));
	op_set(on, "children", methods);
	op_set(nodes, d->on_ids[0], on);
	op_value *out = op_map();
	op_set(out, "den", op_str(d->self->id));
	op_set(out, "nodes", nodes);
	if (!processes) return out;
	op_value *list = op_list();
	const char *root = pl_root(d->s.places).string;
	for (size_t i = 0; i < d->nrunning; i++) {
		dn_process *p = d->running[i];
		if (root == NULL || strcmp(pr_root(p->life), root) != 0) continue;
		op_push(list, id_at(p));
		offered(d, nodes, p, op_map());
	}
	op_set(out, "processes", list);
	return out;
}

int dn_hash_hex(const op_value *v, char out[65]) {
	if (v == NULL || hf_holds(v)) return 0;
	Json *j = pk_to_json(v);
	if (j == NULL) return 0;
	uint8_t h[32];
	const char *why;
	int ok = hashValue(j, h, &why);
	jsonFree(j);
	if (!ok) return 0;
	static const char hex[] = "0123456789abcdef";
	for (size_t i = 0; i < 32; i++) {
		out[2 * i] = hex[h[i] >> 4];
		out[2 * i + 1] = hex[h[i] & 15];
	}
	out[64] = 0;
	return 1;
}

// the end ---------------------------------------------------------------------------------------------

void dn_halt(dn *d) {
	if (d != NULL) pr_halt(d->life);
}

// a scope's info values let go
static void free_values(op_value **values, size_t n) {
	for (size_t i = 0; i < n; i++) op_free(values[i]);
}

void dn_free(dn *d) {
	if (d == NULL) return;
	d->freeing = 1;
	// a process never stopped: its handle's stop (processes' pr_free calls its end)
	pr_free(d->life);
	// a load never let go: its close
	for (size_t i = 0; i < d->nloaded; i++) {
		dn_loaded *l = d->loaded[i];
		if (!l->released && l->live.close != NULL) l->live.close(l->live.data);
		free(l);
	}
	free(d->loaded);
	for (size_t i = 0; i < d->nall; i++) {
		dn_process *p = d->all[i];
		free(p->loads);
		for (size_t k = 0; k < p->nfolders; k++) {
			free(p->folders[k].id);
			free_values(p->folders[k].values, 2);
		}
		free(p->offers);
		free(p->id);
		if (p->at != NULL) pr_names_free(p->at, p->nat);
		op_free(p->code);
		op_free(p->reason);
		free(p->failure);
		free(p);
	}
	for (size_t i = 0; i < d->noffers; i++) {
		offer *o = d->offers[i];
		free(o->id);
		pr_names_free(o->at, o->nat);
		free(o->name);
		free_values(o->values, 2);
		free(o->users);
		free(o);
	}
	for (size_t k = 0; k < 3; k++) {
		free(d->on_ids[k]);
		free_values(d->on_values[k], 2);
	}
	forget(d);
	free(d->scraps);
	free(d->all);
	free(d->running);
	free(d->offers);
	free(d->live);
	free_values(d->reasons, 3);
	op_free(d->pending);
	op_free(d->scratch);
	op_free(d->owner_value);
	op_free(d->device);
	free(d->name);
	free(d->id);
	free(d);
}
