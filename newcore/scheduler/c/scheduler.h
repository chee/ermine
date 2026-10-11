// The scheduler (newcore/scheduler.ts, SCHEDULER.tex), in C. Same order of operations as the
// reference: every change, node made, intro, outro and release ticks the clock where scheduler.ts
// does. It holds the table, places, a trackgraph and one notify per node, and hooks them up; the
// host's interface is below.
//
// memory: an arena per scheduler, freed by sc_free. Values (nt_value) are made with notify's
// constructors and shared between versions by mutate, so nothing owns them: they are not freed.
// Everything is single threaded; there is no async, so a compute cannot return a promise.
//
// values: nt_value. A live value (a function a process placed as a handler) is an nt_value of
// type NT_NULL that carries an sc_fn: sc_live makes one, sc_live_fn gets it back. null,
// booleans, numbers and strings are the same by value; lists, maps and live values by identity.
#ifndef SCHEDULER_H
#define SCHEDULER_H

#include <stddef.h>
#include <stdint.h>

#include "../../c/node.h"
#include "../../notify/c/notify.h"
#include "../../graph/places/c/places.h"
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

// a fresh error in the scheduler's arena. scheduler: its message is "code: message"
const sc_error *sc_error_new(sc_sched *s, const char *code, const char *message, int scheduler);

// what a function is: called with what a part is given; sets *out to its value (NULL: none) or
// *pending. an error is returned (NULL: none)
struct sc_fn {
	const sc_error *(*call)(sc_fn *self, sc_given *g, nt_value **out, int *pending);
};
nt_value *sc_live(sc_fn *f);
sc_fn *sc_live_fn(const nt_value *v); // NULL if not live

// whether two values are the same (Object.is)
int sc_is(const nt_value *a, const nt_value *b);

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

// a change: its time, who by, and the node it is in
typedef struct sc_change {
	int64_t time;
	const sc_agent *actor;
	const char *reader;
	const char *cause;
	const char *node;
	int has_which; // a mark's: where
	const char *which;
} sc_change;
// a change for a node of the host's own making, at a time
const sc_change *sc_change_new(sc_sched *s, int64_t time, const char *node);

// the version of a status has this because
extern const char sc_status_because[];

typedef enum { SC_DONE, SC_PENDING, SC_FAILED, SC_STOPPED, SC_PARKED } sc_ended;

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
} sc_options;

sc_sched *sc_new(const sc_options *o);
void sc_free(sc_sched *s);
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
	const nt_value *args; // a map, or NULL
	int (*equal)(const nt_value *a, const nt_value *b);
	const char *const *place; // where the address is read from; default the root
	size_t nplace;
} sc_startop;
typedef struct {
	const char *const *address;
	size_t naddress;
	nt_value *args; // NULL: none
	const sc_agent *actor; // NULL: the host's
	const char *person;
	int has_trusted;
	int trusted;
	const char *const *place;
	size_t nplace;
} sc_callop;

const sc_error *sc_start(sc_sched *s, const sc_startop *op, const char **id);
// *out: the handler's answer (NULL: none, or the call was queued)
const sc_error *sc_call(sc_sched *s, const sc_callop *op, nt_value **out);
const sc_error *sc_replace(sc_sched *s, const char *const *address, size_t naddress);
const sc_error *sc_batch(sc_sched *s, const sc_error *(*fn)(void *ctx), void *ctx);

// what an interface gives: items as the actor may have them. refused: why a node is not given
typedef struct {
	pl_item it;
	const pr_value *refused;
} sc_item;
typedef struct {
	sc_item *items;
	size_t n;
} sc_items;

const sc_error *sc_look(sc_api *a, const char *const *address, size_t n, sc_items *out);
const sc_error *sc_lookup(sc_api *a, const char *const *path, size_t n, sc_items *out);
const sc_error *sc_lookups(sc_api *a, const char *const *path, size_t n, sc_items *out);
// every name, or with a name that list's items
const sc_error *sc_names(sc_api *a, const char *const *address, size_t n, pl_namelist *out);
const sc_error *sc_children(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out);
const sc_error *sc_content(sc_api *a, const char *const *address, size_t n, sc_items *out);
const sc_error *sc_info(sc_api *a, const char *const *address, size_t n, const char *name,
	sc_items *out);
// index: the item (default its first loaded); slotindex as insert's. *time: the change's
const sc_error *sc_write(sc_api *a, const char *const *address, size_t n, const nt_patch *patches,
	size_t np, const long *index, const pl_span *slotindex, int64_t *time);
const sc_error *sc_set(sc_api *a, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex,
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
// a new node holding value (NULL: no value); a process may make it ephemeral
const sc_error *sc_create(sc_api *a, const nt_value *value, const char *id, int ephemeral,
	const char **out);

// what a part does with what it is given: start, call, onCleanup. a part that has no right to
// one is stopped or wrong-field
const sc_error *sc_given_start(sc_given *g, const sc_startop *op, const char **id);
const sc_error *sc_given_call(sc_given *g, const char *const *address, size_t naddress,
	const nt_value *args, nt_value **out);
const sc_error *sc_given_cleanup(sc_given *g, sc_fn *f);

struct sc_given {
	sc_sched *s;
	sc_api *api; // tracked in a compute
	sc_api *peep; // a compute's: the same, untracked
	void *ctx; // the scheduler's
	const char *self;
	const char *name;
	nt_value *value; // an effect's; NULL: not given
	nt_value *previous;
	nt_value *args; // a handler's
	int has_killed; // a cleanup's
	int killed;
	int64_t *by; // a compute's: the times of the changes that marked it
	size_t nby;
	void *user; // the part's own (steps)
};

#endif
