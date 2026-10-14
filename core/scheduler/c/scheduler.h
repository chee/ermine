// the scheduler (typescript/scheduler.ts), in C; prefix sc_. it runs code, and knows nothing
// else. a compute is tracked: it runs again when a key it read changed. an effect is a compute
// whose value is acted on after the round's last run. a setup runs once, untracked. the scopes
// tree holds them: disposing a scope takes everything under it.
//
// a scope is two things, one tree: an owner (what is made in it is put under it) and the info of
// the changes made in it: pairs, in order, opaque. a write's pairs: the info of each scope from
// the root down to the one open (sc_pairs). a scope is open only while sc_setup or the scheduler
// runs code in it: a computation's runs, sets and acts open it, written by itself; a cleanup
// opens its scope, and what is under a scope goes with it open: a cleanup on a plain scope under a
// computation, run by the computation's clean or dispose, is written by it. nothing open: making
// a scope, a computation or a cleanup fails (unscoped).
//
// keys are opaque: const void *, compared by identity, never NULL. values are opaque: void *,
// compared by the computation's equal, else by pointer.
//
// by: who made a change, told by the caller of sc_changed, never guessed from what is running.
// a caller who knows the writer passes the run: the writer open (sc_current_by), the one f was
// given (held past its end with sc_run_ref, after an await), or a computation's latest
// (sc_latest). a compute's run named so
// makes it the keys' writer (its readers wait for it while it is due), and the change carries
// the run's cause (loops). NULL: from outside (the host, sync): no writer learned, no cause.
//
// no exceptions in C, so:
//   - a failure is an error string (malloc'd; whoever is handed one frees it), NULL for none.
//     the scheduler's own are "stopped", "disposed" and "unscoped" (SC_STOPPED, SC_DISPOSED,
//     SC_UNSCOPED)
//   - a read answers SC_OK, SC_STOP (its writer is due: the run must end now, returning
//     anything) or SC_CLOSED (the run has returned: the read is refused with "stopped")
//   - async: a run may return a promise (sc_promise_new) to be settled later by the host
//     (sc_resolve, sc_reject); the run ends pending, and the result lands at the next pulse
//   - pending: where the reference's f returns or throws PENDING, f returns SC_PENDING (a read
//     of something pending returns it up through each f above, as a throw would unwind); a
//     promise settles pending with sc_resolve_pending, where the reference's is resolved to or
//     rejected with PENDING
//
// memory: values a run gives (its result, a promise's value) are the scheduler's until it lets
// go of them with options.drop (replaced as last, equal, failed, disposed, or at sc_free).
// set and act are lent them for the call. scopes and computations are the scheduler's until
// sc_free, disposed or not (a host may keep a disposed scope's pointer). a scope's info is
// borrowed: the caller keeps the pairs, and each key and value, alive as long as the scope. free
// promises first.
// single threaded.
#ifndef SCHEDULER_H
#define SCHEDULER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SC_DISPOSED "disposed"
#define SC_STOPPED "stopped"
#define SC_UNSCOPED "unscoped"

typedef struct sc_scheduler sc_scheduler;
typedef struct sc_scope sc_scope;
// a computation is a scope too
typedef struct sc_scope sc_computation;
// one run of a computation: what a compute's f reads through
typedef struct sc_run sc_run;
typedef struct sc_promise sc_promise;

typedef enum { SC_OK = 0, SC_STOP = 1, SC_CLOSED = 2 } sc_read_status;

// one of a scope's info: a key, and its value, opaque
typedef struct {
	const char *key;
	const void *value;
} sc_pair;

typedef enum {
	// a value (maybe NULL): the result
	SC_VALUE,
	// the run ends pending: nothing given
	SC_PENDING,
	// error: the run failed
	SC_FAILED,
	// promise: the run ends pending; its settling is the result
	SC_AWAIT,
} sc_out_kind;

typedef struct sc_out {
	sc_out_kind kind;
	void *value;
	char *error;
	sc_promise *promise;
} sc_out;

// what a computation is made of
typedef struct sc_def {
	// each run. read through the run; after SC_STOP, return at once (what is returned is dropped)
	sc_out (*f)(sc_run *run, void *data);
	// a compute's: a result not equal to the last. effects leave it NULL
	char *(*set)(void *value, void *data);
	// an effect's: a result not equal to the one last acted on, after the round's last run.
	// previous: the one acted on before, NULL for none
	char *(*act)(void *value, void *previous, void *data);
	// NULL: pointers compared
	bool (*equal)(const void *a, const void *b, void *data);
	// a compute's: where set's results land, when known (NULL: learned from the by of changes)
	const void *key;
	void *data;
} sc_def;

typedef enum { SC_DUE, SC_STARTS, SC_ENDS, SC_ACTS } sc_moment_kind;
typedef enum { SC_DONE, SC_PENDED, SC_FAIL, SC_STOPPED_RUN, SC_LOOPING } sc_ended;

// a moment, told to options.hook; good for the call
typedef struct sc_moment {
	sc_moment_kind kind;
	sc_computation *c;
	// SC_DUE; by: the computation of the run that made the change, NULL when not told
	uint64_t tick;
	sc_computation *by;
	// SC_STARTS, SC_ENDS, SC_ACTS
	unsigned run;
	// SC_STARTS
	int rank;
	// SC_ENDS
	sc_ended ended;
	// -1: none, else 0 or 1
	int equal;
	// SC_ENDS, SC_ACTS: NULL for none
	const char *error;
	// SC_ENDS stopped: the computation it waits after
	sc_computation *waits;
	// SC_ENDS looping: the computations on the loop, in the order made
	sc_computation *const *through;
	size_t nthrough;
	// SC_ENDS: every read the run made, in order, a key read again read again (the tracker keeps
	// it once): the keys as read. kept only when there is a hook
	const void *const *reads;
	size_t nreads;
} sc_moment;

typedef struct sc_options {
	// told each moment
	void (*hook)(const sc_moment *moment, void *data);
	// told when a promise settled: its result waits for the next pulse
	void (*wake)(void *data);
	// lets go of a value the scheduler was given
	void (*drop)(void *value, void *data);
	// told each key it stops tracking: one nobody reads any more, when a sweep drops it, and at
	// once for the keys a disposed computation was the last reader of
	void (*forget)(const void *key, void *data);
	void *data;
} sc_options;

sc_scheduler *sc_new(sc_options options);
void sc_free(sc_scheduler *s);

// scopes: n pairs of info, borrowed. a new one with no parent
sc_scope *sc_root(sc_scheduler *s, const sc_pair *info, size_t n);
// a new one under parent, else under the one open. NULL: none open, or the parent is gone
sc_scope *sc_scope_new(sc_scheduler *s, const sc_pair *info, size_t n, sc_scope *parent);
// the host's own pointer on a scope or computation
void sc_scope_set(sc_scope *o, void *user);
void *sc_scope_user(const sc_scope *o);
bool sc_scope_alive(const sc_scope *o);
sc_scope *sc_scope_parent(const sc_scope *o);
// its info, *n pairs. a computation's: its latest run's, two pairs: "run" and "mark", each value
// a const uint64_t * it keeps (the run's number; the tick of the mark that made it due), good
// until its next run; none before its first
const sc_pair *sc_scope_info(const sc_scope *o, size_t *n);

// what is open: the scope (NULL: none), and its writer (NULL: from outside)
sc_scope *sc_current(const sc_scheduler *s);
sc_run *sc_current_by(const sc_scheduler *s);
// the pairs of a write made now: the info of each scope from the root down to the one open, into
// out, up to cap of them; how many there are. borrowed: good while the scopes are, and a
// computation's until its next run
size_t sc_pairs(const sc_scheduler *s, sc_pair *out, size_t cap);

// on the scope open; it gone already, f runs now (its error, if it ran). none open: SC_UNSCOPED,
// a fresh string
char *sc_cleanup(sc_scheduler *s, char *(*f)(void *data), void *data);
// children first, newest first, then o's cleanups, newest first. every cleanup runs; the first
// error is returned
char *sc_dispose(sc_scope *o);

// f once, untracked, with o open, the writer open the same: a setup, a host's write, a call.
// SC_DISPOSED (and f not called) when o is gone, else 0
const char *sc_setup(sc_scope *o, void (*f)(void *data), void *data);

// tracked, under the scope open; first runs at the next pulse. NULL: none open, or it is gone
sc_computation *sc_compute(sc_scheduler *s, sc_def def);
sc_computation *sc_effect(sc_scheduler *s, sc_def def);

// the running computation read this key; outside a run, or in sc_run, nothing
sc_read_status sc_read(sc_scheduler *s, const void *key);
// a run's own read
sc_read_status sc_run_read(sc_run *run, const void *key);
// holds on a run past its end (a promise's settling may read through it: SC_CLOSED)
sc_run *sc_run_ref(sc_run *run);
void sc_run_unref(sc_run *run);
// the computation a run is of
sc_computation *sc_run_of(const sc_run *run);
// a computation's latest run (good until it runs again; sc_run_ref to keep it), what by names
// for it; NULL when it has not run, is gone, or o is a plain scope
sc_run *sc_latest(sc_scope *o);

// these keys changed: what read them is due, at the next tick. by: who made the change (above);
// a compute's run becomes their writer. an effect is no one's writer: it writes in its acts,
// after the round's runs. the tick
uint64_t sc_changed(sc_scheduler *s, const void *const *keys, size_t count, sc_run *by);

// rounds until nothing is due: the settled promises land, the due run by rank, the effects act.
// a pulse in a pulse does nothing
void sc_pulse(sc_scheduler *s);

// the scheduler's counter: each change and each new computation takes the next
uint64_t sc_tick(const sc_scheduler *s);

// promises. one is the host's until sc_promise_free
sc_promise *sc_promise_new(sc_scheduler *s);
// settles it, once; the value is the scheduler's. unless its run was run again or is gone, the
// result lands at the next pulse (and options.wake is told)
void sc_resolve(sc_promise *p, void *value);
// settles it to pending
void sc_resolve_pending(sc_promise *p);
void sc_reject(sc_promise *p, char *error);
void sc_promise_free(sc_promise *p);

#endif
