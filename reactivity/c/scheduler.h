// The scheduler (typescript/scheduler.ts) in C, prefix sc_. It runs code and knows nothing else.
// A compute is tracked and runs again when a key it tracked is marked. An effect is a compute
// whose value is acted on after the round's last run. A setup runs once, untracked. The scopes
// tree holds them all, and tearing a scope down takes everything under it. Keys are opaque
// const void * compared by identity, never NULL. Values are opaque void * compared by the
// computer's equal, else by pointer. Single threaded. The rules are scheduler.ts's and
// reactivity/conformance/scheduler's.
//
// Each scope has a frame (changeable/c/frame.h) holding its info. Making a scope or computer with
// nothing open fails (unscoped).
//
// Runs: the caller of sc_mark says who made a change; it is never guessed from what is running.
// Pass the run open (sc_get_run), the one f was given at its start (held past its end with
// sc_run_ref), or a computer's latest (sc_latest). A compute's run makes it the keys' writer. NULL
// means from outside (the host, sync): no writer and no cause.
//
// There are no exceptions in C, so:
//   - A failure is a malloc'd error string, which whoever is handed it frees; NULL means none.
//     The scheduler's own are SC_DISPOSED, SC_UNSCOPED and SC_EMPTY. A create returns NULL for
//     any of them.
//   - A track returns SC_OK or SC_STOP. After SC_STOP (its writer is due) the run must end now.
//     A track outside a run, or after it returned, counts for nothing.
//   - A run may return a promise (sc_promise_new) that the host settles later with sc_resolve or
//     sc_reject. The run ends pending and the result lands at the next pulse.
//   - Where the reference's f returns or throws PENDING, f returns SC_PENDING. A promise settles
//     pending with sc_resolve_pending.
//
// Errors thrown by a listener (sc_throw) or by a cleanup are held until what was going on has
// finished, then come out: the first, with the rest let go. sc_teardown returns it; sc_pulse,
// sc_mark, sc_track and the like leave it for sc_escaped. An unfinished pulse leaves what is
// still due or to act for the next one.
//
// Memory: values a run gives are the scheduler's until it lets go with options.drop. A scope or
// computer is freed once it is torn down and nothing holds it (its maker, sc_retain, an open
// sc_run_with_scope, scopes under it, its runs, promises, queued acts). A plain scope is freed
// at once, a computer as the pulse ends, after the free listeners (sc_on_free) are told.
#ifndef SCHEDULER_H
#define SCHEDULER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../changeable/c/frame.h"

#define SC_DISPOSED "disposed"
#define SC_UNSCOPED "unscoped"
#define SC_EMPTY "empty"

typedef struct sc_scheduler sc_scheduler;
typedef struct sc_scope sc_scope;
typedef struct sc_scope sc_computer;
// One run of a computer (its computer is sc_run_computer, its number sc_run_n). The run open while
// it runs is sc_get_run; hold it past its end with sc_run_ref.
typedef struct sc_run sc_run;
typedef struct sc_promise sc_promise;
typedef struct sc_listener sc_listener;

typedef enum { SC_OK = 0, SC_STOP = 1 } sc_track_status;

typedef ch_pair sc_pair;

typedef enum {
	SC_VALUE,
	SC_PENDING,
	SC_FAILED,
	// promise: the run ends pending; its settling is the result.
	SC_AWAIT,
	// promise and step: the run ends pending; when the promise settles the same run goes on, in step.
	SC_PAUSE,
} sc_out_kind;

// What carries on a run once its promise has settled (SC_PAUSE). next is given what the promise
// settled with (ok: its value, owned by next, maybe NULL; else its malloc'd error, for next to
// free) and returns what the run comes to next. quit is called instead, with nothing open, if the
// step is let go (the computer ran or became due again, was torn down, or its promise never settled
// or settled to pending). Exactly one of next and quit is called, once.
typedef struct sc_step {
	struct sc_out (*next)(void *data, bool ok, void *value, char *error);
	void (*quit)(void *data);
	void *data;
} sc_step;

typedef struct sc_out {
	sc_out_kind kind;
	void *value;
	char *error;
	sc_promise *promise;
	sc_step step;
} sc_out;

typedef struct sc_def {
	// Each run. Keys are tracked through sc_track; after SC_STOP, return at once (what is returned
	// is dropped). A track after an await counts for nothing. Call sc_get_run at f's start and
	// hold the run if f writes after an await. previous is the computer's last result (a compute's:
	// the last given to set; an effect's: the last acted on), NULL for none. A result equal to the
	// last is not held, so it stays the last set.
	sc_out (*f)(void *previous, void *data);
	// A compute's: takes a result not equal to the last. Effects leave it NULL.
	char *(*set)(void *value, void *data);
	// An effect's: acts on a result not equal to the one last acted on, after the round's last run.
	// previous is the one acted on before, NULL for none.
	char *(*effect)(void *value, void *previous, void *data);
	bool (*equal)(const void *a, const void *b, void *data);
	// A compute's: where set's results land, when known. NULL means learn it from the writer of marks.
	const void *key;
	void *data;
	// An effect's: acted on in the round's early queue; its first run and act are in sc_create_effect.
	bool early;
} sc_def;

typedef enum { SC_DONE, SC_PENDED, SC_FAIL, SC_STOPPED_RUN, SC_LOOPING } sc_ended;

// What more a run's end says. equal: -1 for none, else 0 or 1. error: NULL for none. waits (when
// stopped): the computer it waits after. through (when looping): the computers on the loop, in
// the order made. kept (has_kept): the result held past the run (a compute's given to set, even
// a failed one, or an effect's to be acted on), only when not equal to the last. Borrowed for
// the call.
typedef struct sc_more {
	int equal;
	const char *error;
	sc_computer *waits;
	sc_computer *const *through;
	size_t nthrough;
	bool has_kept;
	const void *kept;
} sc_more;

typedef struct sc_options {
	void (*drop)(void *value, void *data);
	// Adds a hold on a value the scheduler was given, for each run a promise's value lands at. If
	// NULL, the first run it lands at takes the promise's hold and any other gets the value
	// unheld. A host that drops values and awaits a promise twice must give keep.
	void (*keep)(void *value, void *data);
	void *data;
} sc_options;

sc_scheduler *sc_new(sc_options options);
void sc_free(sc_scheduler *s);

typedef void (*sc_track_fn)(const void *key, sc_run *run, void *data);
sc_listener *sc_on_track(sc_scheduler *s, sc_track_fn f, void *data);
// A key got its first tracker (none had it, or never before). Told in the reading run, after the
// track. Mirrors TS onTrackingStart.
sc_listener *sc_on_tracking_start(sc_scheduler *s, sc_track_fn f, void *data);
// A mark, or a new computer (due at once, with no keys): what it made due, and the tick. run is
// who made it, NULL for none.
typedef void (*sc_mark_fn)(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data);
sc_listener *sc_on_mark(sc_scheduler *s, sc_mark_fn f, void *data);
typedef void (*sc_run_start_fn)(sc_computer *c, unsigned n, int rank, ch_frame *frame, void *data);
sc_listener *sc_on_run_start(sc_scheduler *s, sc_run_start_fn f, void *data);
// A run's body returned a value (for an awaited run, its promise landed with it). Told before
// the value is compared, given to set or queued to act, and still the scheduler's. At most once
// per run, for computes and effects; not for a failure, SC_PENDING, a stopped run, or one torn
// down in its body. A write made in the run before this is the run's own; one after is its
// set's. Mirrors TS onRunReturn.
typedef void (*sc_run_return_fn)(sc_computer *c, unsigned n, const void *value, void *data);
sc_listener *sc_on_run_return(sc_scheduler *s, sc_run_return_fn f, void *data);
// reads: every key the run tracked, in order; a key tracked twice appears twice. Only collected
// while someone listens here.
typedef void (*sc_run_end_fn)(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data);
sc_listener *sc_on_run_end(sc_scheduler *s, sc_run_end_fn f, void *data);
typedef void (*sc_effect_fn)(sc_computer *c, unsigned n, const char *error, void *data);
sc_listener *sc_on_effect(sc_scheduler *s, sc_effect_fn f, void *data);
typedef void (*sc_settle_fn)(void *data);
sc_listener *sc_on_settle(sc_scheduler *s, sc_settle_fn f, void *data);
// A pulse ended: nothing due and every act done (not told if one threw out of it). A pulse
// started here is a new one. Mirrors TS onAfterPulse.
typedef void (*sc_after_pulse_fn)(void *data);
sc_listener *sc_on_after_pulse(sc_scheduler *s, sc_after_pulse_fn f, void *data);
// A key nobody tracks any more: its last tracker's run ended done without tracking it again, or
// was torn down. A periodic sweep catches any other case.
typedef void (*sc_tracking_end_fn)(const void *key, void *data);
sc_listener *sc_on_tracking_end(sc_scheduler *s, sc_tracking_end_fn f, void *data);
// A scope or computer was freed: torn down and held by nothing. Told as it goes, while its frame,
// parent and user pointer can still be read. Anything the host keyed on it should go here.
typedef void (*sc_free_fn)(sc_scope *o, void *data);
sc_listener *sc_on_free(sc_scheduler *s, sc_free_fn f, void *data);
void sc_remove_listener(sc_listener *l);

// Creates a scope with no parent, copying n pairs of info (not their keys or values). NULL when n
// is 0.
sc_scope *sc_create_root_scope(sc_scheduler *s, const sc_pair *info, size_t n);
// Creates a scope under parent, else under the one open. NULL when none is open, the parent is
// gone, or n is 0.
sc_scope *sc_create_scope(sc_scheduler *s, const sc_pair *info, size_t n, sc_scope *parent);
// Adds a hold on o, or lets one go (see memory in the header). The maker's hold is let go with
// sc_release too. A gone scope held by nothing is freed.
sc_scope *sc_retain(sc_scope *o);
void sc_release(sc_scope *o);
void sc_scope_set(sc_scope *o, void *user);
void *sc_scope_user(const sc_scope *o);
bool sc_scope_alive(const sc_scope *o);
bool sc_scope_old(const sc_scope *o);
bool sc_scope_early(const sc_scope *o);
sc_scope *sc_scope_parent(const sc_scope *o);
sc_scope *sc_get_current_scope(const sc_scheduler *s);
ch_frame *sc_get_current_frame(const sc_scheduler *s);
// A scope's own frame, held by it: its info under the frame its parent had open when it was
// made, else its parent's own. A computer's frame never changes: its pairs plus "mark", the tick
// that made it due.
ch_frame *sc_scope_frame(sc_scope *o);
ch_frame *sc_run_frame(const sc_run *run);
// A frame of its own: n pairs under up, else under the frame open. n may be 0, for a frame that
// says nothing. The caller holds the one reference and frees it with ch_frame_free.
ch_frame *sc_create_frame(sc_scheduler *s, const sc_pair *info, size_t n, ch_frame *up);
sc_run *sc_get_run(const sc_scheduler *s);
// Registers a teardown on o. If o is already gone, f runs now and its error is returned.
char *sc_register_teardown(sc_scheduler *s, sc_scope *o, char *(*f)(void *data), void *data);
// Tears down children first, newest first, then o's teardowns, newest first. Every teardown
// runs; the first error is returned (a listener's thrown error, from sc_throw, comes first).
char *sc_teardown(sc_scope *o);
// Takes back a computer an earlier run of its owner made (it is old) in the run going on: it goes
// back under the owner as the newest and becomes due (a tick, announced to mark listeners as a
// new computer is, by the run open). False when it is not old (already made or claimed in this
// run, or its owner has not run since), is gone, or is a plain scope.
bool sc_claim(sc_computer *c);
// Like sc_claim but not made due: it is made again the same (as a name's nominal match in
// Adapton), so it runs when what it read changes, not because its owner ran.
bool sc_claim_same(sc_computer *c);
// Like sc_claim, and c takes def whole (its key is not read) and the new kind: an effect or a
// compute, so one can be made again as the other. A new kind lets go of its last result, and its
// next one is set or acted on whether equal or not. Becoming an effect makes it the writer of
// nothing. Becoming a compute makes what its last act made old at its next run, and the cleanups
// made in that act are set aside with its own. A queued act is dropped. False as sc_claim, and
// nothing is taken.
bool sc_claim_as(sc_computer *c, bool effect, sc_def def);

// Runs f once, untracked, with o and its frame open: a setup, a host's write, a call. Returns
// SC_DISPOSED (and does not call f) when o is gone, else 0.
const char *sc_run_with_scope(sc_scope *o, void (*f)(void *data), void *data);
// Like sc_run_with_scope but with frame open instead of o's own: what is made is o's, a change
// made is frame's. A NULL frame means o's own.
const char *sc_run_with(sc_scope *o, ch_frame *frame, void (*f)(void *data), void *data);

// Tracked, and made under the scope open; first runs at the next pulse (early effects run now).
// info gives its own n pairs, before its run's. Keys must be unique and not "run" or "mark".
// Pairs are copied but not their keys or values, which must live as long as it does. NULL when
// none is open or it is gone.
sc_computer *sc_create_computer(sc_scheduler *s, sc_def def, const sc_pair *info, size_t n);
sc_computer *sc_create_effect(sc_scheduler *s, sc_def def, const sc_pair *info, size_t n);

sc_track_status sc_track(sc_scheduler *s, const void *key);
sc_run *sc_run_ref(sc_run *run);
void sc_run_unref(sc_run *run);
sc_computer *sc_run_computer(const sc_run *run);
unsigned sc_run_n(const sc_run *run);
// A computer's latest run, good until it runs again (sc_run_ref to hold it). NULL when it has not
// run, is gone, or o is a plain scope.
sc_run *sc_latest(sc_scope *o);

// Marks these keys, so whatever tracked them is due at the next tick. run says who made the
// change (see the header); a compute's run becomes the writer of the keys. An effect writes in
// its acts, not its runs, so it is no one's writer. Returns the tick taken.
uint64_t sc_mark(sc_scheduler *s, const void *const *keys, size_t count, sc_run *run);

// Runs rounds until nothing is due: settled promises land, due computers run by rank, effects act.
// Does nothing when called inside a pulse. Anything thrown out is left for sc_escaped.
void sc_pulse(sc_scheduler *s);

// Holds an error thrown by a listener until what was going on finishes, then lets it out (see the
// header). The error is the scheduler's.
void sc_throw(sc_scheduler *s, char *error);
// Takes what was thrown out of the calls that leave it: the first one, the rest let go. The
// caller frees it. NULL when there is none.
char *sc_escaped(sc_scheduler *s);

sc_promise *sc_promise_new(sc_scheduler *s);
// Settles it, once; the scheduler takes the value. The result lands at the next pulse in each run
// awaiting it (unless that run ran again or is gone), and the settle listeners are told.
void sc_resolve(sc_promise *p, void *value);
void sc_resolve_pending(sc_promise *p);
void sc_reject(sc_promise *p, char *error);
void sc_promise_free(sc_promise *p);

#endif
