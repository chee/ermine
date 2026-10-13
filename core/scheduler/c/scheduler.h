// The scheduler (newcore/scheduler/ts/scheduler.ts, SCHEDULER.tex), in C. Same order of operations as the
// reference: every change, node made, intro, outro and release ticks the clock where scheduler.ts
// does. It sits on the graph (graph/c/main.h), as scheduler.ts on main.ts: the graph reads,
// writes, places, tracks and tells; the scheduler runs processes. The host's interface is below.
//
// memory: values are held (notify.h: op_ref, op_free) and let go when nothing holds them; the graph
// holds what its nodes hold (main.h, memory).
//   - Given: a value given to a call (args, patches, values to write or create) is borrowed: whoever
//     keeps it takes its own hold, so the caller lets go of its own when done. A part's value (what
//     a compute, setup or handler gives back) is lent the same way: the scheduler holds the last
//     value and the one an effect saw, the graph the versions made of it; the part's own hold, if
//     it made the value, is never let go (it may give back a value it only reads), unless it sets
//     sc_given's hands: then it is let go at the next sweep (a handler's, given to the host by
//     sc_call, too).
//   - A process's status, last value and marks (the changes that marked it, gr_change_hold) are
//     held while it runs, and let go of when replaced, taken by a run, or when it ends.
//   - A run, and everything a request made for it (agents, interfaces, causes, its reads and
//     errors), is scratch, gone when the request ends: what a part was given is good for the call.
//   - What the host's interface gives back (items, names, errors, the version contents read) is
//     good until the host calls sc_sweep, which also lets go of what was let go since the last
//     sweep. A host that never sweeps keeps all of it, as before.
// sc_alloc and sc_dup are kept until sc_free, as are the processes.
// Everything is single threaded; there is no async, so a compute cannot return a promise.
//
// values: op_value. A live value (a function a process placed as a handler) is an op_value of
// type OP_NULL that carries an sc_fn: sc_live makes one, sc_live_fn gets it back. null,
// booleans, numbers and strings are the same by value; lists, maps and live values by identity.
#ifndef SCHEDULER_H
#define SCHEDULER_H

#include <stddef.h>
#include <stdint.h>

#include "../../node/c/node.h"
#include "notify.h"
#include "../../places/c/places.h"
#include "../../graph/c/main.h"
#include "../../protect/c/protect.h"

typedef struct sc_sched sc_sched;
typedef struct sc_api sc_api;
typedef struct sc_given sc_given;
typedef struct sc_fn sc_fn;

// an error: what a part threw, or the scheduler's own (SchedulerError: scheduler set, code one of
// stopped read-only nothing-there not-a-handler not-a-process wrong-field refused). code NULL: none
// (reads as "thrown"). why: protect's, for refused
typedef struct sc_error {
	const char *name;
	const char *code;
	const char *message;
	const pr_value *why;
	int scheduler;
} sc_error;

// a fresh error, in scratch (memory, above). scheduler: its message is "code: message"
const sc_error *sc_error_new(sc_sched *s, const char *code, const char *message, int scheduler);

// what a function is: called with what a part is given; sets *out to its value (NULL: none) or
// *pending. an error is returned (NULL: none)
struct sc_fn {
	const sc_error *(*call)(sc_fn *self, sc_given *g, op_value **out, int *pending);
};
op_value *sc_live(sc_fn *f);
sc_fn *sc_live_fn(const op_value *v); // NULL if not live

// whether two values are the same (Object.is)
int sc_is(const op_value *a, const op_value *b);

// code: a setup (setup set), or a compute with an optional effect
typedef struct {
	sc_fn *setup;
	sc_fn *compute;
	sc_fn *effect;
} sc_code;

// the host's: who acts. person and trusted are added to what a person did
typedef struct sc_step sc_step;
typedef struct sc_agent sc_agent;
// an agent whose actor is the string actor, no code
const sc_agent *sc_agent_of(sc_sched *s, const char *actor);
const sc_agent *sc_agent_with(sc_sched *s, const sc_agent *a, const char *person, int has_trusted,
	int trusted);

// a change: the graph's (its time, who by as protect sees them, the node it is in)
typedef gr_change sc_change;
// a change for a node of the host's own making, at a time
const sc_change *sc_change_new(sc_sched *s, int64_t time, const char *node);

// the version of a status has this because
extern const char sc_status_because[];

typedef enum { SC_DONE, SC_PENDING, SC_FAILED, SC_STOPPED, SC_LOOPING } sc_ended;

// the moments (SCHEDULER.tex, Hooks)
typedef enum { SC_DUE, SC_STARTS, SC_READS, SC_ENDS } sc_moment_kind;
typedef struct {
	const pl_item *items;
	size_t n;
} sc_ritems;
typedef struct {
	sc_moment_kind kind;
	const char *id; // due, starts, reads, ends: the process
	int64_t by; // due
	int has_run;
	long run;
	const char *handler; // NULL: none
	int cleanup; // reads
	int has_rank;
	long rank; // starts
	const char *op; // reads
	int tracked;
	sc_ended ended; // ends
	int has_equal;
	int equal;
	const sc_error *error; // ends
	const char *waits; // ends
} sc_moment;
typedef struct {
	void (*fn)(void *ctx, const sc_moment *m);
	void *ctx;
} sc_hook;

// a process, as the host's finder is told of it
typedef struct {
	const char *id;
	const char *name;
	const char *const *place;
	size_t nplace;
	const char *const *program;
	size_t nprogram;
} sc_process;
// what a finder gives: pending, or code and the node and time it came from
typedef struct {
	int pending;
	sc_code code;
	const char *node;
	int64_t time;
} sc_found;
// finds a process's code by its program's path, reading through view (tracked). an error is
// returned (NULL: none)
typedef const sc_error *(*sc_finder)(void *ctx, const sc_process *p, sc_api *view, sc_found *out);

typedef struct {
	const char *root; // the root's id; the host introduces its node (sc_intro), or one is made
	const sc_agent *actor; // who the host's own changes are by; NULL: "host"
	const char *host; // actor NULL: the host's actor as this string; NULL: "host"
	int64_t *clock; // the last time given; each change takes the next. NULL: its own, at 0
	const sc_hook *hooks;
	size_t nhooks;
	sc_finder finder;
	void *finder_ctx;
	// a fresh id for a node made at a time; "@" and the time if NULL. in the arena
	const char *(*id)(void *ctx, int64_t time);
	void *id_ctx;
	// who may do what (protect), asked before each operation not the scheduler's own; NULL:
	// anyone. copied
	const pr_may *may;
	// the host's site for its changes, as protect's values ({file, line, column?, function?}); NULL,
	// or returns NULL: none. C reads no call stack: a host gives it (scheduler.ts reads one)
	const pr_value *(*site)(void *ctx);
	void *site_ctx;
	// told, after an operation lands, each object it changed (WIRING.tex, Out): sync's side. NULL: none.
	// The header's actor is sc_actor's
	void (*changed)(void *ctx, const gr_record *r);
	void *changed_ctx;
} sc_options;

sc_sched *sc_new(const sc_options *o);
void sc_free(sc_sched *s);
// the host's scratch freed, and what was let go of since the last sweep let go now (gr_sweep): call
// it where nothing the host's interface gave is still in use (a turn of the host's loop)
void sc_sweep(sc_sched *s);
// the scheduler's arena for protect: a may made with pr_rules and the like belongs there
pr_arena *sc_pr_arena(sc_sched *s);
void *sc_alloc(sc_sched *s, size_t n);
char *sc_dup(sc_sched *s, const char *str);

nd_node *sc_get(sc_sched *s, const char *id);
int sc_ephemeral(sc_sched *s, const char *id);
// a node of the host's own making loaded, or no longer
const sc_error *sc_intro(sc_sched *s, nd_node *node);
const sc_error *sc_outro(sc_sched *s, const char *id);
// the host's interface
sc_api *sc_host(sc_sched *s);
// an agent that is only an actor (no person, peer, trusted or code) as its actor; else the agent. What a
// change is by, as a change's header is told to sync
const pr_value *sc_actor(const pr_value *agent);
// INTERNAL AND DANGEROUS (WIRING.tex, In), for whoever made the scheduler to give to sync alone,
// never to hosts or programs: gr_versions (main.h says what it does and why it is dangerous)
void sc_versions(sc_sched *s, const char *id, gr_where where, const char *name,
	const gr_incoming *list, size_t count, const gr_from *from);

// the host's: start, call, replace, batch
typedef struct {
	const char *const *address;
	size_t naddress;
	int has_path; // the program is a path
	const char *const *path;
	size_t npath;
	sc_code code;
	const char *name; // NULL: the pid
	const char *id;
	int (*equal)(const op_value *a, const op_value *b);
	const char *const *place; // where the address is read from; default the root
	size_t nplace;
} sc_startop;
typedef struct {
	const char *const *address;
	size_t naddress;
	op_value *args; // NULL: none
	const sc_agent *actor; // NULL: the host's
	const char *person;
	int has_trusted;
	int trusted;
	const char *const *place;
	size_t nplace;
} sc_callop;

const sc_error *sc_start(sc_sched *s, const sc_startop *op, const char **id);
// *out: the handler's answer (NULL: none, or the call was queued)
const sc_error *sc_call(sc_sched *s, const sc_callop *op, op_value **out);
const sc_error *sc_replace(sc_sched *s, const char *const *address, size_t naddress);
const sc_error *sc_batch(sc_sched *s, const sc_error *(*fn)(void *ctx), void *ctx);

// what an interface gives: the graph's items as the actor may have them
typedef gr_item sc_item;
typedef gr_items sc_items;

const sc_error *sc_look(sc_api *a, const char *const *address, size_t n, sc_items *out);
const sc_error *sc_lookup(sc_api *a, const char *const *path, size_t n, sc_items *out);
const sc_error *sc_lookups(sc_api *a, const char *const *path, size_t n, sc_items *out);
// every name, or with a name that list's items
const sc_error *sc_names(sc_api *a, const char *const *address, size_t n, pl_namelist *out);
// "info" or "children" names (main.h, gr_names_of)
const sc_error *sc_names_of(sc_api *a, const char *const *address, size_t n, const char *part,
	pl_namelist *out);
const sc_error *sc_children(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out);
const sc_error *sc_content(sc_api *a, const char *const *address, size_t n, sc_items *out);
const sc_error *sc_info(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out);
// index: the item (default its first loaded); slotindex as insert's, span: given as a span.
// *time: the change's
const sc_error *sc_write(sc_api *a, const char *const *address, size_t n, const op_patch *patches,
	size_t np, const long *index, const pl_span *slotindex, int span, int64_t *time);
const sc_error *sc_set(sc_api *a, const char *const *address, size_t n, const char *name,
	const op_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time);
const sc_error *sc_insert(sc_api *a, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time);
const sc_error *sc_remove(sc_api *a, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time);
const sc_error *sc_pop(sc_api *a, const char *id, const char *name, pl_span slotindex,
	int64_t *time);
const sc_error *sc_rename(sc_api *a, const char *id, const char *name, const char *to,
	int64_t times[2]);
const sc_error *sc_move(sc_api *a, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, int64_t times[2], size_t *ntimes);
// the whole node of an id (*out NULL: not loaded, or refused); every object of it read
const sc_error *sc_node(sc_api *a, const char *id, const nd_node **out);
// the same interface, its changes carrying cause (borrowed); in scratch (memory, above): good for
// the call, or the host's until it sweeps
sc_api *sc_as(sc_api *a, const pr_value *cause);
// a new node holding value (NULL: no value); a process may make it ephemeral
const sc_error *sc_create(sc_api *a, const op_value *value, const char *id, int ephemeral,
	const char **out);

// what a part does with what it is given: start, call, onCleanup. a part that has no right to
// one is stopped or wrong-field
const sc_error *sc_given_start(sc_given *g, const sc_startop *op, const char **id);
const sc_error *sc_given_call(sc_given *g, const char *const *address, size_t naddress,
	const op_value *args, op_value **out);
const sc_error *sc_given_cleanup(sc_given *g, sc_fn *f);

struct sc_given {
	sc_sched *s;
	sc_api *api; // tracked in a compute
	sc_api *peep; // a compute's: the same, untracked
	void *ctx; // the scheduler's
	const char *self;
	const char *name;
	op_value *value; // an effect's; NULL: not given
	op_value *previous;
	op_value *args; // a handler's
	int has_killed; // a cleanup's
	int killed;
	int64_t *by; // a compute's: the times of the changes that marked it
	size_t nby;
	void *user; // the part's own (steps)
	const sc_change **marks; // a compute's: the changes that marked it (by's times, whole)
	// the part's to set: the value it gives comes with its hold, let go of once the scheduler is done
	// with it (memory, above); 0: lent, as before
	int hands;
};

#endif
