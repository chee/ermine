// start (typescript/start.ts) in C: a process from a way (satisfy's program with one of its chains,
// or one of open_with's), in a box or plain places, at a path from its root; and its stop. same
// rules as start.ts, held to by playground/programs/conformance/start. the process is
// experiments/software's (software.h, sw_*): this builds the way and hands software the runner and
// the program as built. a box here is its places (bx_places); any places stands in for one.
//
//   ps *p = ps_new(&setup);                                  // with a scope open
//   pg_way way = {found->program, found->chains.items[0]};
//   ps_refusal no;
//   ps_process *x = ps_start(p, bx_places(b), &way, at, nat, &(ps_options){..}, &no);   // NULL: refused
//   ps_stop(p, x, NULL);
//   ps_halt(p);  /* listeners */  ...  ps_free(p);      // ps_halt before sc_free, ps_free after tb_free and pl_free
//
// refused, nothing made: no-runner (an empty chain), taken (software's: a process at, above or
// under the path); another place's code: not-a-name.
// pin: the program's and each step's id, place and hash, the root and folder; written at start.
// the run: sw_run_carried on the chain's runner, carried (a host runner is a node with no type, so
// software would not take it by its path), and the program carried with a build: the chain's
// compilers folded over the program's value (the compilers library's bd_fold), the value read once
// at start, the fold in the process's first run; status pending while building, the failure's
// text on failure. then the runner's start (hf_runner) once with the code and software's start
// facts (sw_starting) as its api, the process's scope open: what the program gets is the
// runner's to make from them. its failure: the status.
// a step a host holds (by empty): its node's value, live (a function, hf_find's). a loaded step (by
// not empty): sw_load_carried on its by's runner, carried, given the step's value through its by's
// compilers, held by the process; shared as software shares loads, the chain the keys of its by's
// steps (a step's key: its id, its value's hash, no encoding the value itself, and its by's keys),
// so a step is loaded once while any process holding it runs (its live form, hf_live: a compiler's
// compile through bd_fold, bd_step under bd_identity_of; a runner's run). asked as a run ends
// (sc_on_run_end), never in one. a load that fails is let go, so the next start loads it again.
// failures: not-a-runner, not-a-loader, not-a-compiler. C loads are synchronous. dlopen.h loads
// native libraries (native.h; conformance/native).
// stop: software's: the runner's handle's stop (hf_run.stop_reason given the reason when set),
// then the loads held let go (their close at the last). outputs stay cached.
// writes: software's (processes' start.h's).
// memory: a process is the programs' until ps_free; stopped stays stopped. ps_free stops any never
// stopped, then lets go of the loads (their close). a way's pieces are copied (at, args, folder:
// processes'); the places it runs in outlive it. out of memory aborts.
#ifndef PROGRAMS_START_H
#define PROGRAMS_START_H

#include "../../../ermine/processes/c/start.h"
#include "../../../experiments/software/c/software.h"
#include "../../compilers/c/compilers.h"
#include "programs.h"

typedef struct ps ps;
typedef struct ps_process ps_process;

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// where status.h's writes are committed, and what makes headers
	pl *places;
	bd *builds;
	sn *scopes;
	// what live values are (hf_find): host runners and compilers, and loaders
	const hf *functions;
	// told every write's changed entries (the host's places, a box's shares it); NULL: pl_commit on
	// places
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// where the scopes made here are noted (ermine/sites); NULL: not noted. the programs' own scope's
	// site is where ps_new was called, a process's where ps_start was
	st_sites *sites;
	// 1: each build's latest run on the runs' table (runs.h) by the process's id, as start.ts does when the
	// places given name reads (software's runs)
	int runs;
	// how a pulse is asked for after a start (software's setup.schedule; NULL: none, the host pulses)
	void (*schedule)(void *ctx, void (*f)(void *data), void *data);
	void *schedule_ctx;
} ps_setup;

typedef struct {
	// "taken", "no-runner", or another code's name
	const char *refused;
	const pg_place *program;
	// taken: the path, names from the root (the programs' until their next call)
	const char *const *at;
	size_t nat;
} ps_refusal;

// a start's own: args (has_args 0: none written, the program given none); folder, steps from the root
// as at's (has_folder 0: the folder at is in)
typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	const char *const *folder;
	size_t nfolder;
	int has_folder;
} ps_options;

// with a scope open (its owner's parent). a macro: the site noted is the caller's
ps *ps_new_at(const ps_setup *setup, const char *file, int line, const char *func);
#define ps_new(...) ps_new_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// where: the places it runs in (a box's, or plain places). at: nat steps from its root (a name, ".",
// "..", "/": bx_inside, ".." at the root staying there). options may be NULL. a macro: the site
// noted is the caller's
ps_process *ps_start_at(ps *p, pl *where, const pg_way *way, const char *const *at, size_t nat,
	const ps_options *options, ps_refusal *refused, const char *file, int line, const char *func);
#define ps_start(...) ps_start_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// its scope
sc_scope *ps_scope(const ps_process *p);
// its node's id
const char *ps_id(const ps_process *p);
// its path from its root, names: how many, *out borrowed (the programs' until ps_free)
size_t ps_at(const ps_process *p, const char *const **out);
// software's stop: its handle's stop told reason (borrowed; NULL: none), the row taken out, the
// scope torn down; twice, or refused: nothing. a macro: the site is the caller's
void ps_stop_at(ps *p, ps_process *process, const op_value *reason, const ch_site *site);
#define ps_stop(...) ps_stop_at(__VA_ARGS__, CH_HERE)
// listeners away, with the scheduler alive
void ps_halt(ps *p);
void ps_free(ps *p);

#endif
