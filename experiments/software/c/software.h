// software (typescript/software.ts) in C: running programs on runners, on processes. what can run
// here is offered as nodes (offers.c); a program runs on one of them as a process (run.c). no
// policy (whoever calls may), no den, no asking: what decides who may run what, and what takes work
// from elsewhere, is a program someone starts. same rules as software.ts, held to by
// experiments/software/conformance/software. the processes' life is ermine/processes' start.h's
// (pr_*), its own, made by sw_new; a box here is its places.
//
//   sw *s = sw_new(&(sw_setup){.scheduler = sc, .table = t, .places = p, .scopes = sn,
//     .functions = fs, .scope = host});
//   sw_refusal no;
//   const sw_offered *js = sw_offer(s, &session, SW_RUNNERS, "javascript", attrs,
//     hf_value("javascript"), &no);                                     // NULL: refused
//   sw_process *x = sw_run(s, runner, 4, &(sw_program){.at = prog, .nat = 2, .has_at = 1},
//     at, 2, &(sw_options){..}, &no);                                  // NULL: refused
//   sw_run_carried(s, &(sw_carried){.id = RUN, .live = fn}, &(sw_program){.id = CAT,
//     .build = build, .build_data = b}, at, 2, NULL, &no);            // carried: programs' way
//   sw_loaded *l = sw_load(s, &place, letter, 6, &(sw_program){.id = "e", .code = c, .type = t},
//     NULL, &no);                                                      // NULL: refused
//   sw_loaded_live(l)->run(...);  sw_release(s, l);                    // one hold; else at its
//                                                                      // owner's stop
//   sw_stop(s, sw_process_id(x), reason);
//   sw_halt(s);  /* before sc_free */  ...  sw_free(s);                // after tb_free, pl_free
//
// an owner (sw_place): a node things are offered under, with a scope they go with: a process (run
// here or not), or an install's node (stored: what is offered under it stays when its scope goes,
// only the live values go, as an install's does across sessions). made the first time it is named;
// a process run here is its own. its scope gone: refused nothing-there.
// sw_offer: a node <by id>/<kind>/<name> in the folder <by id>/<kind> (made at the first offer of
// that kind, upserted into the owner's children), its attributes as given and ermine.type
// ermine.runner | ermine.compiler | ermine.surface over them, its value live (NULL: no value). an
// offer is a scope under its folder's, under its owner's: what runs on it runs under it, so its node
// going takes them, newest first. a stored owner's offers: their folders and attributes stay when
// its scope goes, only the live value goes, and a later offer of the name goes over them. any other
// owner's go whole with it, the folder's name out of the owner's children too. a name taken
// (offered now; a live value there; for an owner not stored, any entry at its id): refused taken,
// nothing made. not a kind: not-a-kind; not a name: not-a-name; then an owner whose scope is gone:
// nothing-there.
// sw_withdraw: its name out of its folder and its attributes out, then its scope torn down, what
// runs on it stopped "withdrawn". an id none offers now but its folder (<owner>/<kind>, the id's
// own) names: every name pointing at it out of the folder, its attributes out. its owner going takes
// it with the rest of its scope, what runs on it stopped "runner-stopped".
// sw_run refused, nothing made, the first that holds: not-a-runner (nothing at runner, or its
// ermine.type is not ermine.runner); not-there (no program node, or no value; by id: none, or not
// the hash given; code given: not the hash given); wrong-form (the program's type does not fit the
// runner's takes, SW_TAKES; or it names an api, ermine.program.api, code given: api, the runner's
// ermine.runner.api is not); not-a-runner (the runner's value no runner hf_find knows; carried:
// its live none, or with no runner); taken (processes'). sw_run_carried: a runner carried (its id,
// its live form in hand, as programs holds a host's or a loaded runner): nothing of its node read,
// no type, takes or api asked (its form the caller's to have matched), so only not-there,
// not-a-runner (its id) and taken. the program's type: by an address, ermine/types' ty_type_of
// (its ermine.type, else its name's extension, by the nearest ermine/types from its folder); by
// id, its ermine.type; code or build given, type. it fits when the takes (a list; a string, a list
// of one) holds it or a type it conforms to (ty_conform), by the nearest ermine/types from the
// program's folder (none: from where's root); read untracked. else processes' start under a scope
// of its own (under the runner's offer's, when offered here; else setup.scope), with ermine.type
// ermine.process, ermine.process.runner { id, at } (carried: { id }), .program { id, at?, hash? }
// (hash: of its value; none: a live value, or built); the code read once now; at the first pulse,
// a one-shot effect, the process's scope open, the runner called with the code and its facts
// (sw_starting). build given (no code): the code is what build gives, in that effect's run,
// tracked: SC_PENDING, the process pending; failed, its status; the runner called once it gives
// one. a handle: held, its stop its stopper's teardown (landing after the stop: called then); an
// error, or a handle that lands later failing (sw_wait): the status. a run made outside a run
// (sc_get_run NULL): a pulse asked for (setup.schedule; NULL: none, the host pulses).
// sw_load: the program made live on the runner with no process, shared: one load per key, the
// program's id, its value's hash (none: the value itself), the runner's id and function's name
// (carried: its live form's functions and data), and the chain given (the keys of what else loads
// it, programs'). checked as sw_run is (no path, so never taken; a build is sw_run's alone, not
// read here); a runner with no load: not-a-runner. a key with no load standing: the entry's load
// called with the code, by's facts there to read (sw_loading) and a scope of the load's own (under
// setup.scope) open, its scope theirs; the load failing: refused "failed", error its message, the
// scope gone. a sw_loaded: one hold by by, let go at sw_release or at by's scope's teardown (after
// its handle's, newest first); the last hold let go, or setup.scope torn down: the load's scope
// torn down, its live form closed (hf_live.close) before what its load made goes. made: a pulse
// asked for, as sw_run's.
// sw_stop: the reason told, then where it runs torn down, in the scheduler's order: its offers and
// what runs on them ("runner-stopped"), its handle's stop(reason), then its own scope (what its
// program made, its loads closed, the row out, the node gone). twice, or none run here: nothing. a
// process gone with what it runs under, not told: its runner's offer going, the offer's why (none:
// "runner-stopped"); else none.
// writes: with the caller's scope open, or the owner's (an offer's), or the process's; a folder's
// name out of a place's children with setup.scope open.
//
// live values: hf stand-ins (experiments/software/c/functions.h). a runner here: hf_find gives an entry with
// a runner (and, to load, a load). it is handed the code and a sw_starting (borrowed for the call;
// its strings the process's, until sw_free) as its api: what the program gets is the runner's to
// make; its limits are its own, nothing here counts. hf_run.error: the status. a stop's reason:
// given to hf_run.stop_reason when set, else handle.stop. a promise of a handle (software.ts'
// start giving one): sw_wait in its start, sw_land when it lands. a load is given the code alone
// (hf_loader): its facts are sw_loading's, for the call.
// memory: a process, owner, offer, load or hold lives until sw_free; ids, paths, args copied; attributes,
// pins and codes held (op_ref); a sw_refusal's strings are the software's until its next call.
// sw_free with the table and places gone: a process never stopped has its handle's stop called, a
// load never let go its close, nothing written. out of memory aborts.
#ifndef SOFTWARE_H
#define SOFTWARE_H

#include "../../../core/places/c/places.h"
#include "functions.h"
#include "../../../ermine/processes/c/scopes.h"
#include "../../../ermine/sites/c/sites.h"

// the one field everything matches on (ermine/types' ATTRIBUTE)
#define SW_ATTRIBUTE "ermine.type"
#define SW_TYPE_PROCESS "ermine.process"
#define SW_TYPE_RUNNER "ermine.runner"
#define SW_TYPE_COMPILER "ermine.compiler"
#define SW_TYPE_SURFACE "ermine.surface"
// the attributes of an offer, as nodes carry them. takes and gives are programs' names for now
// (playground/programs' ATTRIBUTES), one set for both: a runner's and a compiler's takes, the UTIs
// it takes (a list; one string: a list of one); a compiler's gives, the UTI it gives. each name
// said here once
#define SW_TAKES "ermine.programs.takes"
#define SW_API "ermine.runner.api"
#define SW_WHERE "ermine.runner.where"
#define SW_COMPILER_TAKES "ermine.programs.takes"
#define SW_GIVES "ermine.programs.gives"
#define SW_KIND "ermine.surface.kind"
#define SW_SIZE "ermine.surface.size"
// a process's, as run writes them
#define SW_PROGRAM_API "ermine.program.api"
#define SW_RUNNER "ermine.process.runner"
#define SW_PROGRAM "ermine.process.program"
// the reasons a process is stopped with, not told
#define SW_WITHDRAWN "withdrawn"
#define SW_RUNNER_STOPPED "runner-stopped"

typedef struct sw sw;
typedef struct sw_process sw_process;
typedef struct sw_loaded sw_loaded;
typedef struct sw_late sw_late;
typedef enum { SW_RUNNERS, SW_COMPILERS, SW_SURFACES } sw_kind;

// what a runner is handed as its api (software.ts' Start), a load's facts (its owner's): the box it
// runs in (its places and their root), the process (its node, path, args, folder), the scheduler,
// table and its scope; and the software, for sw_wait
typedef struct {
	pl *places;
	const char *root;
	struct {
		const char *id;
		const char *const *at;
		size_t nat;
		const char *const *args;
		size_t nargs;
		const char *const *folder;
		size_t nfolder;
	} process;
	sc_scheduler *scheduler;
	tb_table *table;
	sc_scope *scope;
	sw *software;
} sw_starting;

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// where runners and programs are found from (and processes run, unless a box is given): the
	// host's places at its root, its contributors with the process trie
	pl *places;
	sn *scopes;
	// what live values are (hf_find)
	const hf *functions;
	// what runs goes under it (on a runner offered here, under its offer, under its owner's scope
	// too): torn down, everything run here goes
	sc_scope *scope;
	// where the scopes made here are noted; NULL: not noted
	st_sites *sites;
	// how a pulse is asked for: f(data) run soon, once. NULL: none asked (the host pulses: C has no
	// microtasks, software.ts' default)
	void (*schedule)(void *ctx, void (*f)(void *data), void *data);
	void *schedule_ctx;
	// told every write's changed entries (the host's places, a box's shares it); NULL: pl_commit on
	// places
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// 1: each process's latest first run on the runs' table (processes' runs.h) by its node's id
	// (software.ts' runs)
	int runs;
	// a new process's node id, malloc'd (processes' pr_setup.id). NULL: processes' own
	char *(*id)(void *ctx);
	void *id_ctx;
} sw_setup;

// an owner: its node, its path from the root, the scope what it offers goes with; stored: they stay
// when it goes (an install's node). borrowed for the call
typedef struct {
	const char *id;
	const char *const *at;
	size_t nat;
	sc_scope *scope;
	int stored;
} sw_place;

// an offer (software.ts' Offered): its node, its path, its kind and name, its owner's node. the
// software's until sw_free
typedef struct {
	const char *id;
	const char *const *at;
	size_t nat;
	sw_kind kind;
	const char *name;
	const char *by;
} sw_offered;

// a runner carried (software.ts' Carried): its node's id, and its live form in hand (borrowed for
// the call, copied; NULL: no runner)
typedef struct {
	const char *id;
	const hf_entry *live;
} sw_carried;

// a run's program: an address from where's root (has_at), or by id; hash NULL: any; code non-NULL:
// carried (nothing read), its form type and api. build (no code, sw_run's alone): carried, its code
// what build(build_data) gives in the process's first run, tracked (SC_VALUE its value, the
// scheduler's; SC_PENDING; SC_FAILED; SC_AWAIT), build_data the caller's while the process runs
typedef struct {
	const char *const *at;
	size_t nat;
	int has_at;
	const char *id;
	const char *hash;
	const op_value *code;
	const char *type;
	const char *api;
	sc_out (*build)(void *data);
	void *build_data;
} sw_program;

typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	const char *const *folder;
	size_t nfolder;
	int has_folder;
	// where it runs, and where program and at are from; NULL: setup's places
	pl *box;
	// ermine.process.pin; NULL: none
	const op_value *pin;
} sw_options;

typedef struct {
	// where the program is from; NULL: by's box
	pl *box;
	// the keys of what else loads it (programs' chain), part of the load's key; none: none
	const char *const *chain;
	size_t nchain;
} sw_load_options;

// refused: "not-a-runner" "not-there" "wrong-form" "taken", or "not-a-kind", "not-a-name" (offer:
// a bad kind, a bad name), "nothing-there" (offer or load, by an owner whose scope is gone),
// "failed" (a load's, error its message). the fields of the refusal given, the rest NULL or 0
typedef struct {
	const char *refused;
	// not-a-runner: the runner's path; carried, its id (runner_id, else NULL)
	const char *const *runner;
	size_t nrunner;
	const char *runner_id;
	// not-there: program_has_at: its path; else its id in program
	const char *program;
	const char *const *program_at;
	size_t nprogram_at;
	int program_has_at;
	// wrong-form: each NULL when not a string; takes, the runner's strings (ntakes 0: none)
	const char *type, *api, *runner_api;
	const char *const *takes;
	size_t ntakes;
	// taken
	const char *const *at;
	size_t nat;
	// failed
	const char *error;
} sw_refusal;

// sites: each call that writes is an _at function taking its caller's site (ch_site, borrowed for the
// call; NULL: none), and a macro of the plain name passing CH_HERE, so a write's site is the line
// that called. a wrapper over software passes its own caller's. the writes a call makes, and those it
// sets off at once (an offer's users stopped, a process's row out), carry it; a write with no call
// going on (a teardown from above, a pulse): the nearest site noted (setup.sites) up the run open's
// computer, else up the scope open; none noted: none

sw *sw_new(const sw_setup *setup);

// attributes: a map (held; NULL: none). live: a stand-in (held; NULL: none). the offer, or NULL and
// *refused (taken, not-a-kind, not-a-name, nothing-there)
const sw_offered *sw_offer_at(sw *s, const sw_place *by, sw_kind kind, const char *name,
	const op_value *attributes, const op_value *live, sw_refusal *refused, const ch_site *site);
#define sw_offer(...) sw_offer_at(__VA_ARGS__, CH_HERE)
// as above; unknown: nothing
void sw_withdraw_at(sw *s, const char *id, const ch_site *site);
#define sw_withdraw(...) sw_withdraw_at(__VA_ARGS__, CH_HERE)

// runner: nrunner steps from setup's places' root. NULL: refused (software.ts' order)
sw_process *sw_run_at(sw *s, const char *const *runner, size_t nrunner, const sw_program *program,
	const char *const *at, size_t nat, const sw_options *options, sw_refusal *refused,
	const ch_site *site);
#define sw_run(...) sw_run_at(__VA_ARGS__, CH_HERE)
// the same on a runner carried
sw_process *sw_run_carried_at(sw *s, const sw_carried *runner, const sw_program *program,
	const char *const *at, size_t nat, const sw_options *options, sw_refusal *refused,
	const ch_site *site);
#define sw_run_carried(...) sw_run_carried_at(__VA_ARGS__, CH_HERE)
// by: its owner. options NULL: none. NULL: refused
sw_loaded *sw_load_at(sw *s, const sw_place *by, const char *const *runner, size_t nrunner,
	const sw_program *program, const sw_load_options *options, sw_refusal *refused,
	const ch_site *site);
#define sw_load(...) sw_load_at(__VA_ARGS__, CH_HERE)
// the same on a runner carried
sw_loaded *sw_load_carried_at(sw *s, const sw_place *by, const sw_carried *runner,
	const sw_program *program, const sw_load_options *options, sw_refusal *refused,
	const ch_site *site);
#define sw_load_carried(...) sw_load_carried_at(__VA_ARGS__, CH_HERE)
// its live form, the load's (hf_live)
const hf_live *sw_loaded_live(const sw_loaded *l);
// the hold let go now, out of its owner's (the last: the load closed, hf_live.close); twice: nothing
void sw_release_at(sw *s, sw_loaded *l, const ch_site *site);
#define sw_release(...) sw_release_at(__VA_ARGS__, CH_HERE)
// id: a process run here. reason borrowed for the call (NULL: none)
void sw_stop_at(sw *s, const char *id, const op_value *reason, const ch_site *site);
#define sw_stop(...) sw_stop_at(__VA_ARGS__, CH_HERE)

// a handle that lands later (software.ts' start giving a promise of one): asked by a runner in its
// start, st its facts; what the start gives back is then not read (its error freed), the process
// pending till it lands. NULL: no start of a process going on for st, or it waits already
sw_late *sw_wait(const sw_starting *st);
// it landed: out's handle held (the process gone already: stopped now, with its reason), its status
// gone at the next pulse; out.error (taken): its status that failure. once: later ones let go
void sw_land(sw_late *l, hf_run out);
// the facts of the load being called (its owner's), for its hf_loader, which is given none; NULL:
// no load going on
const sw_starting *sw_loading(const sw *s);

// running, in start order; *out the software's until its next change. sc_track'd
size_t sw_running(sw *s, sw_process *const **out);
// standing, in the order offered; *out the software's until its next call. sc_track'd
size_t sw_offers(sw *s, const sw_offered *const **out);
// running; NULL: none
sw_process *sw_find(const sw *s, const char *id);
const char *sw_process_id(const sw_process *p);
size_t sw_process_at(const sw_process *p, const char *const **out);
sc_scope *sw_process_scope(const sw_process *p);
// a refusal as software.ts' Refused, new
op_value *sw_refusal_value(const sw_refusal *r);
// core candidate (ermine/encoding, beside bd_hash_hex): hex of a value's hash (software.ts' hashOf);
// 0: no encoding (a stand-in in it)
int sw_hash_hex(const op_value *v, char out[65]);

// listeners away, the promises of sw_wait let go, with the scheduler alive
void sw_halt(sw *s);
void sw_free(sw *s);

#endif
