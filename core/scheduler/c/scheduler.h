// the scheduler (typescript/scheduler.ts), in C; prefix sc_. it runs code, and knows nothing
// else. a compute is tracked: it runs again when a key it tracked was marked. an effect is a
// compute whose value is acted on after the round's last run. a setup runs once, untracked. the
// scopes tree holds them: tearing a scope down takes everything under it.
//
// a scope is two things: an owner (what is made in it is put under it; the tree is
// sc_scope_parent) and the info of the changes made in it: an object as key/value pairs, keys
// unique (the caller's to keep: never checked), their order no meaning, opaque, nothing added. a
// write's info: the info of the scope open (sc_get_info). sc_create_scope makes one under a
// parent, else under the one open; sc_create_root_scope one with no parent. no pairs given: it
// fails (empty). a scope is open only while sc_run_with_scope or the scheduler runs code in it: a
// computer's runs, sets and acts open it, written by itself. its info: one block, made as it is
// made: its own pairs (given, copied once; none: none) and "mark", the tick of the mark that made
// it due; as each run starts, "run", its number, and "mark" set in that block, never a new one. a
// scope is made once; under a
// computer, it belongs to that run (a plain scope is never claimed: it goes once a later run is
// done; what an act made, before the next act). a teardown opens its scope, and what is under a scope goes with it open: a teardown on a
// plain scope under a computer, run by the computer's teardown, its run's end or its act, is
// written by it. nothing open: making a scope or a computer fails (unscoped).
//
// early effects: the reference's rules (typescript/scheduler.ts), the same here: sc_def's early
// ("acts at once and is in an earlier queue so it goes compute, early, effect"): made, it is due,
// runs and acts in sc_create_effect; after, a round is three queues: the runs by rank, the early
// acts, the other acts, each owners first (an act waits while one above it is due in the same
// queue).
//
// keys are opaque: const void *, compared by identity, never NULL. values are opaque: void *,
// compared by the computer's equal, else by pointer.
//
// the run: who made a change, told by the caller of sc_mark, never guessed from what is running.
// a caller who knows it passes the run: the one open (sc_get_run), the one f was taken at f's
// start (held past its end with sc_run_ref, after an await), or a computer's latest (sc_latest).
// a compute's run named so makes it the keys' writer (its readers wait for it while it is due),
// and the change carries the run's cause (loops). NULL: from outside (the host, sync): no writer
// learned, no cause. in a set, act or teardown, sc_get_run is the computer's latest run.
//
// no exceptions in C, so:
//   - a failure is an error string (malloc'd; whoever is handed one frees it), NULL for none.
//     the scheduler's own are "disposed", "unscoped" and "empty" (SC_DISPOSED, SC_UNSCOPED,
//     SC_EMPTY). a create answers NULL for any: with nothing open and no parent, unscoped; a
//     parent gone (or the one open), disposed; else no pairs, empty
//   - a track answers SC_OK or SC_STOP (its writer is due: the run must end now, returning
//     anything). a track outside a run, or after it returned, counts for nothing
//   - async: a run may return a promise (sc_promise_new) to be settled later by the host
//     (sc_resolve, sc_reject); the run ends pending, and the result lands at the next pulse
//   - pending: where the reference's f returns or throws PENDING, f returns SC_PENDING (a track
//     of something pending returns it up through each f above, as a throw would unwind); a
//     promise settles pending with sc_resolve_pending, where the reference's is resolved to or
//     rejected with PENDING
//
// listeners (sc_on_...): each kind a small list, told in the order added; adding gives back a
// handle, sc_remove_listener takes it away (not from inside a call of its own kind).
//
// thrown out ("finish, then rethrow"): what a listener throws (sc_throw, as no C function can),
// or a computer's cleanup run once its next run is done (below), is held while what was going on
// finishes (every listener told; the run, act, mark or teardown all done), then it comes out:
// the first, the rest let go. sc_teardown returns it; sc_pulse, sc_mark, sc_track,
// sc_create_computer, sc_create_effect, sc_resolve and the like leave it for sc_escaped. a pulse
// is left there: what is still due, or to act, waits for the next. a teardown's: what a listener
// threw (under it too), else a cleanup's. before an act, what its last act made goes: a cleanup's
// error is the act's (told with it), a listener's comes out once the act is done. (the reference
// cannot throw from a making or a settling: it holds those for a pulse; a harness carries
// sc_escaped there to agree)
//
// a rerun keeps what it makes again: the reference's rules (typescript/scheduler.ts), the same
// here. as a run starts, what the computer's earlier runs made is old (a compute's all; an
// effect's, not what its act made), still alive while the run goes, and its own cleanups are set
// aside; sc_claim, in the run, takes an old child back and makes it due. the run done: what is
// still old goes at its end, before its end
// is told; the cleanups set aside run once the round's runs are done (before its acts), newest
// first, and the first that fails ends the rest of that computer's, its error thrown out. a run
// ending any other way keeps both. a computer torn down takes what is old and set aside with
// it. before each act, what its last act made goes, and the cleanups made in it run.
//
// what a run read stays tracked till a run is done: the reference's rules
// (typescript/scheduler.ts), the same here. links a run does not read again are old. a run done
// (its latest; an awaited one as it lands done) lets the old ones go; one ending any other way
// holds them too (a mark of one is a retry, no loop), no repeats.
//
// memory: values a run gives (its result, a promise's value) are the scheduler's until it lets
// go of them with options.drop (replaced as last, equal, failed, torn down, or at sc_free).
// set and act are lent them for the call. a scope or computer lives while something holds it, as
// a WeakMap's key does in the reference [chee 10-26: "the C should "garbage collect" via
// something like a weakmap"]: its maker (the one hold sc_create_* gives, let go with sc_release),
// each sc_retain, each scope under it, each of its runs (sc_run_ref, a promise's, a queued act's),
// a loop that names it, and, alive, the tree. torn down and held by nothing, it is freed: a plain
// scope at once, a computer as the pulse ends (the pulse it went in, else the next: a pulse's
// causes and order name it till then), the free listeners told first (sc_on_free). a maker that
// never lets go keeps it till sc_free, as before. a scope's info is the scheduler's: the pairs
// given are copied, but each key and value is borrowed, the caller keeps them alive as long as
// the scope (let go as it is freed). a computer's info changes in place as each run starts. free
// promises and held runs first.
// single threaded.
#ifndef SCHEDULER_H
#define SCHEDULER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SC_DISPOSED "disposed"
#define SC_UNSCOPED "unscoped"
#define SC_EMPTY "empty"

typedef struct sc_scheduler sc_scheduler;
typedef struct sc_scope sc_scope;
// a computer is a scope too
typedef struct sc_scope sc_computer;
// one time a computer ran (its computer, sc_run_computer, and its number, sc_run_n): the run open
// while it runs (sc_get_run), held with sc_run_ref past its end
typedef struct sc_run sc_run;
typedef struct sc_promise sc_promise;
// a registered listener, to give to sc_remove_listener
typedef struct sc_listener sc_listener;

typedef enum { SC_OK = 0, SC_STOP = 1 } sc_track_status;

// one of a scope's info: a key, and its value, opaque
typedef struct {
	const char *key;
	const void *value;
} sc_pair;

// a scope's info: n pairs, keys unique, those given. a computer's: its own pairs, then "run" (from
// its first run) and "mark", each value a const uint64_t * (the run's number; the tick of the
// mark that made it due), set in place
typedef struct {
	const sc_pair *pairs;
	size_t n;
} sc_info;

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

// what a computer is made of
typedef struct sc_def {
	// each run. keys are tracked through sc_track (after SC_STOP, return at once: what is returned
	// is dropped); a track after an await counts for nothing. the run: sc_get_run at f's start,
	// kept by f if it writes after an await.
	// previous: the computer's last result (a compute's: the last given to set; an effect's: the
	// last acted on), NULL for none. a result equal to the last is not kept, so it stays the last set
	sc_out (*f)(void *previous, void *data);
	// a compute's: a result not equal to the last. effects leave it NULL
	char *(*set)(void *value, void *data);
	// an effect's: a result not equal to the one last acted on, after the round's last run.
	// previous: the one acted on before, NULL for none
	char *(*effect)(void *value, void *previous, void *data);
	// NULL: pointers compared
	bool (*equal)(const void *a, const void *b, void *data);
	// a compute's: where set's results land, when known (NULL: learned from the writer of marks)
	const void *key;
	void *data;
	// an effect's: acted on in the round's early queue; its first run and act in sc_create_effect
	bool early;
} sc_def;

typedef enum { SC_DONE, SC_PENDED, SC_FAIL, SC_STOPPED_RUN, SC_LOOPING } sc_ended;

// what more a run's end says. equal: -1 none, else 0 or 1. error: NULL for none. waits (stopped):
// the computer it waits after. through (looping): the computers on the loop, in the order made.
// kept (has_kept): its result, when held past the run (a compute's given to set, even one that
// failed; an effect's to be acted on): only when not equal to the last. borrowed for the call
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
	// lets go of a value the scheduler was given
	void (*drop)(void *value, void *data);
	void *data;
} sc_options;

sc_scheduler *sc_new(sc_options options);
void sc_free(sc_scheduler *s);

// listeners, each told as it happens. data is given back to each call; reads, keys and due are good
// for the call only
// a key tracked in a run
typedef void (*sc_track_fn)(const void *key, sc_run *run, void *data);
sc_listener *sc_on_track(sc_scheduler *s, sc_track_fn f, void *data);
// a key that gets its first tracker (none had it, or never before): told in the reading run, after the
// track. Mirrors TS' onTrackingStart
sc_listener *sc_on_tracking_start(sc_scheduler *s, sc_track_fn f, void *data);
// a mark, and a new computer (due at once: no keys): what it made due, and its tick. run: who made
// it, NULL for none
typedef void (*sc_mark_fn)(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data);
sc_listener *sc_on_mark(sc_scheduler *s, sc_mark_fn f, void *data);
typedef void (*sc_run_start_fn)(sc_computer *c, unsigned n, int rank, void *data);
sc_listener *sc_on_run_start(sc_scheduler *s, sc_run_start_fn f, void *data);
// a run's body returned a value (an awaited one: its promise landed with it), told before anything
// is done with it (compared, given to set, queued to act; value: still the scheduler's): once per
// run at most, for computes and effects. not told for a failure, SC_PENDING, a stopped run, or one
// torn down in its body. a write made in the run before this is the run's own; one after, its
// set's (un_keeping tells them apart this way). Mirrors TS' onRunReturn
typedef void (*sc_run_return_fn)(sc_computer *c, unsigned n, const void *value, void *data);
sc_listener *sc_on_run_return(sc_scheduler *s, sc_run_return_fn f, void *data);
// reads: every key the run tracked, in order, a key tracked again tracked again (the tracker keeps
// it once). kept only while someone listens here
typedef void (*sc_run_end_fn)(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data);
sc_listener *sc_on_run_end(sc_scheduler *s, sc_run_end_fn f, void *data);
// an effect acted; error: NULL for none
typedef void (*sc_effect_fn)(sc_computer *c, unsigned n, const char *error, void *data);
sc_listener *sc_on_effect(sc_scheduler *s, sc_effect_fn f, void *data);
// a promise settled: its result waits for the next pulse
typedef void (*sc_settle_fn)(void *data);
sc_listener *sc_on_settle(sc_scheduler *s, sc_settle_fn f, void *data);
// a pulse ended: nothing due, every act done (not told when one threw out of it). a pulse called
// here is a new one. Mirrors TS' onAfterPulse
typedef void (*sc_after_pulse_fn)(void *data);
sc_listener *sc_on_after_pulse(sc_scheduler *s, sc_after_pulse_fn f, void *data);
// a key nobody tracks any more: at once when its last tracker's run that ended done did not track
// it again, or it was torn down (a sweep now and then catches any other)
typedef void (*sc_tracking_end_fn)(const void *key, void *data);
sc_listener *sc_on_tracking_end(sc_scheduler *s, sc_tracking_end_fn f, void *data);
// a scope or computer freed: torn down, held by nothing. told as it goes, its info, parent and user
// still there to read; never held again. what is kept by it (a WeakMap's entry) goes here
typedef void (*sc_free_fn)(sc_scope *o, void *data);
sc_listener *sc_on_free(sc_scheduler *s, sc_free_fn f, void *data);
void sc_remove_listener(sc_listener *l);

// scopes: n pairs of info, copied (not their keys or values). a new one with no parent. NULL: n 0
sc_scope *sc_create_root_scope(sc_scheduler *s, const sc_pair *info, size_t n);
// a new one under parent, else under the one open. NULL: none open, the parent is gone, or n 0
sc_scope *sc_create_scope(sc_scheduler *s, const sc_pair *info, size_t n, sc_scope *parent);
// one hold more on o, and one let go (memory, above). the maker's hold is let go with sc_release
// too; a scope gone and held by nothing is freed
sc_scope *sc_retain(sc_scope *o);
void sc_release(sc_scope *o);
// the host's own pointer on a scope or computer
void sc_scope_set(sc_scope *o, void *user);
void *sc_scope_user(const sc_scope *o);
bool sc_scope_alive(const sc_scope *o);
// made by an earlier run of its computer, not made again (claimed) by the run going on yet, nor gone
bool sc_scope_old(const sc_scope *o);
// an early effect
bool sc_scope_early(const sc_scope *o);
sc_scope *sc_scope_parent(const sc_scope *o);
// its info, live. a computer's: changed in place as each run starts
const sc_info *sc_scope_info(const sc_scope *o);

// the scope open (NULL: none)
sc_scope *sc_get_current_scope(const sc_scheduler *s);
// the run open (NULL: from outside)
sc_run *sc_get_run(const sc_scheduler *s);
// the info of a write made now: the info of the scope open (NULL: none), live, not copied: read it
// now, do not keep it (a computer's changes as its runs start)
const sc_info *sc_get_info(const sc_scheduler *s);

// on scope o; it gone already, f runs now (its error, if it ran)
char *sc_register_teardown(sc_scheduler *s, sc_scope *o, char *(*f)(void *data), void *data);
// children first, newest first, then o's teardowns, newest first. every teardown runs; the first
// error is returned (a listener's thrown while it went first: sc_throw)
char *sc_teardown(sc_scope *o);
// a computer its owner's earlier run made (old), made again by the run going on: kept, back under
// the owner, the newest, and due (a tick, told to the mark listeners as a new computer is, by the
// run open). false: not old (made or
// claimed in this run already, or no run of its owner since), gone, or a plain scope
bool sc_claim(sc_computer *c);
// sc_claim, and c takes def whole (its key not read) and that kind (effect: an effect, else a
// compute; a compute made again as an effect, or the reverse). a new kind: its last result is let
// go (its next is set or acted on, equal or not); become an effect, it is the writer of nothing;
// become a compute, what its last act made is old at its next run, and the cleanups made in that
// act are set aside with its own then. an act queued is dropped. false as sc_claim, and nothing
// taken
bool sc_claim_as(sc_computer *c, bool effect, sc_def def);

// f once, untracked, with o open, the run open the same: a setup, a host's write, a call.
// SC_DISPOSED (and f not called) when o is gone, else 0
const char *sc_run_with_scope(sc_scope *o, void (*f)(void *data), void *data);

// tracked, under the scope open; first runs at the next pulse (early: now). info: its own n pairs
// (keys unique, none "run" or "mark"), before its run's, copied (not their keys or values: kept alive as long as it); NULL: n 0. NULL:
// none open, or it is gone
sc_computer *sc_create_computer(sc_scheduler *s, sc_def def, const sc_pair *info, size_t n);
sc_computer *sc_create_effect(sc_scheduler *s, sc_def def, const sc_pair *info, size_t n);

// the running computer tracked this key; outside a run, or in sc_run_with_scope, nothing
sc_track_status sc_track(sc_scheduler *s, const void *key);
// holds on a run past its end (a promise's settling may use it for a mark)
sc_run *sc_run_ref(sc_run *run);
void sc_run_unref(sc_run *run);
// the computer a run is of, and its number
sc_computer *sc_run_computer(const sc_run *run);
unsigned sc_run_n(const sc_run *run);
// a computer's latest run (good until it runs again; sc_run_ref to keep it); NULL when it has not
// run, is gone, or o is a plain scope
sc_run *sc_latest(sc_scope *o);

// these keys were marked: what tracked them is due, at the next tick. run: who made the change
// (above); a compute's run becomes their writer. an effect is no one's writer: it writes in its
// acts, after the round's runs. the tick it took
uint64_t sc_mark(sc_scheduler *s, const void *const *keys, size_t count, sc_run *run);

// rounds until nothing is due: the settled promises land, the due run by rank, the effects act.
// a pulse in a pulse does nothing. what is thrown out leaves it (sc_escaped)
void sc_pulse(sc_scheduler *s);

// a listener's throw: held while what was going on finishes, then out (above). error is the
// scheduler's
void sc_throw(sc_scheduler *s, char *error);
// what was thrown out of the last call that leaves it here, taken (the caller frees it); NULL:
// none
char *sc_escaped(sc_scheduler *s);

// promises. one is the host's until sc_promise_free
sc_promise *sc_promise_new(sc_scheduler *s);
// settles it, once; the value is the scheduler's. unless its run was run again or is gone, the
// result lands at the next pulse (and the settle listeners are told)
void sc_resolve(sc_promise *p, void *value);
// settles it to pending
void sc_resolve_pending(sc_promise *p);
void sc_reject(sc_promise *p, char *error);
void sc_promise_free(sc_promise *p);

#endif
