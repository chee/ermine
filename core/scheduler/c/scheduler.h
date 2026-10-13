// the scheduler (typescript/scheduler.ts), in C; prefix sc_. it runs code, and knows nothing
// else. a compute is tracked: it runs again when a key it read changed. an effect is a compute
// whose value is acted on after the round's last run. a setup runs once, untracked. the owners
// tree holds them: disposing an owner takes everything under it.
//
// keys are opaque: const void *, compared by identity, never NULL. values are opaque: void *,
// compared by the computation's equal, else by pointer.
//
// no exceptions in C, so:
//   - a failure is an error string (malloc'd; whoever is handed one frees it), NULL for none.
//     the scheduler's own are "stopped" and "disposed" (SC_STOPPED, SC_DISPOSED)
//   - a read answers SC_OK, SC_STOP (its writer is due: the run must end now, returning
//     anything) or SC_CLOSED (the run has returned: the read is refused with "stopped")
//   - async: a run may return a promise (sc_promise_new) to be settled later by the host
//     (sc_resolve, sc_reject); the run ends pending, and the result lands at the next pulse
//
// memory: values a run gives (its result, a promise's value) are the scheduler's until it lets
// go of them with options.drop (replaced as last, equal, failed, disposed, or at sc_free).
// set and act are lent them for the call. owners and computations are the scheduler's until
// sc_free, disposed or not (a host may keep a disposed owner's pointer). free promises first.
// single threaded.
#ifndef SCHEDULER_H
#define SCHEDULER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SC_DISPOSED "disposed"
#define SC_STOPPED "stopped"

typedef struct sc_scheduler sc_scheduler;
typedef struct sc_owner sc_owner;
// a computation is an owner too
typedef struct sc_owner sc_computation;
// one run of a computation: what a compute's f reads through
typedef struct sc_run sc_run;
typedef struct sc_promise sc_promise;

typedef enum { SC_OK = 0, SC_STOP = 1, SC_CLOSED = 2 } sc_read_status;

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
	// a compute's: where set's results land, when known (NULL: learned from who says changed)
	const void *key;
	void *data;
} sc_def;

typedef enum { SC_DUE, SC_STARTS, SC_ENDS, SC_ACTS } sc_moment_kind;
typedef enum { SC_DONE, SC_PENDED, SC_FAIL, SC_STOPPED_RUN, SC_LOOPING } sc_ended;

// a moment, told to options.hook; good for the call
typedef struct sc_moment {
	sc_moment_kind kind;
	sc_computation *c;
	// SC_DUE
	uint64_t tick;
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
} sc_moment;

typedef struct sc_options {
	// told each moment
	void (*hook)(const sc_moment *moment, void *data);
	// told when a promise settled: its result waits for the next pulse
	void (*wake)(void *data);
	// lets go of a value the scheduler was given
	void (*drop)(void *value, void *data);
	void *data;
} sc_options;

sc_scheduler *sc_new(sc_options options);
void sc_free(sc_scheduler *s);

// owners. NULL: the parent is disposed
sc_owner *sc_owner_new(sc_scheduler *s, sc_owner *parent);
// the host's own pointer on an owner or computation
void sc_owner_set(sc_owner *o, void *user);
void *sc_owner_user(const sc_owner *o);
bool sc_owner_alive(const sc_owner *o);

// on an owner already gone, f runs now. its error, if it ran
char *sc_cleanup(sc_owner *o, char *(*f)(void *data), void *data);
// children first, newest first, then o's cleanups, newest first. every cleanup runs; the first
// error is returned
char *sc_dispose(sc_owner *o);

// f once, untracked: a setup. SC_DISPOSED (and f not called) when o is gone, else 0
const char *sc_setup(sc_owner *o, void (*f)(void *data), void *data);

// tracked; first runs at the next pulse. NULL: the owner is disposed
sc_computation *sc_compute(sc_owner *o, sc_def def);
sc_computation *sc_effect(sc_owner *o, sc_def def);

// the running computation read this key; outside a run, or in sc_run, nothing
sc_read_status sc_read(sc_scheduler *s, const void *key);
// a run's own read
sc_read_status sc_run_read(sc_run *run, const void *key);
// holds on a run past its end (a promise's settling may read through it: SC_CLOSED)
sc_run *sc_run_ref(sc_run *run);
void sc_run_unref(sc_run *run);

// these keys changed: what read them is due, at the next tick. said in a computation's run or
// a compute's set, that computation becomes their writer. the tick
uint64_t sc_changed(sc_scheduler *s, const void *const *keys, size_t count);

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
