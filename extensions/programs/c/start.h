// Start (typescript/start.ts), in C: a process from a way (satisfy's program with one of its chains, or
// one of open_with's), in a box or plain places (the root is the outermost box), at a path from its
// root; and its stop. Same rules as start.ts (its header says them once), which the scenarios in
// extensions/programs/conformance/start hold both to. The process's life (its scope, node, row,
// args, cwd, pin, status and stop) is ermine/processes' start.h's; this runs the way in it. A box
// here is its places (bx_places): places rooted at its folder, asked its processes and children; any
// places stands in for one.
//
//   ps *p = ps_new(&setup);                                  // with a scope open
//   pg_way way = {found->program, found->chains.items[0]};
//   ps_refusal no;
//   ps_process *x = ps_start(p, bx_places(b), &way, at, nat, &(ps_options){..}, &no);   // NULL: refused
//   ps_stop(p, x);
//   ps_stop_all(p);  /* listeners */  ...  ps_free(p);      // ps_halt before sc_free, ps_free after tb_free and pl_free
//
// Runners are host functions (host.h's hf_runner) returning a stop, or a loaded step's run, called with
// the built code and the api create_api gave (what the program is given: its return, and nothing
// else). Refused, nothing made: "taken" (a process at the path, above it or under it), "no-runner" (an
// empty chain; program).
// Another place's code (not-a-name) is refused under its own name. A runner that gives no promise
// only: its stop at once. Not here: a runner returning a promise (hf_run has none).
//
// LOADING. A step whose by is not empty is loaded, as start.ts' is: its value (read at start) folded
// through its by's compilers, then its by's runner's load (host.h's hf_add_loader: a host runner's;
// a loaded runner's, its live form's) gives its live form (hf_live), used as the step is: a compiler's
// compile, through bd_step under its identity (ermine.programs.compiler; none: { id, hash } of its
// value; no encoding: its id); a runner's run, given the code and the api. Each load is keyed (the
// step's id, its value's hash, its by's keys) and made once, held by the processes asking; at the
// last one's stop its live form's close is called (the dlopen runner: dlclose, its file removed). A
// load's failure is its holders' status (the next start loads again); a runner with no load,
// "not-a-loader"; a live form with no compile or run, "not-a-compiler" or "not-a-runner". C's loads
// are synchronous: called in the build's run, with no computer of their own. The dlopen runner
// (dlopen.h) loads native libraries (native.h); conformance/native holds both languages to it, and
// conformance/load (JavaScript and wasm) is the TypeScript's only.
//
// WRITES. processes' start.h's.
//
// MEMORY. A process is the programs' until ps_free; one stopped stays a stopped one. ps_free calls the
// runner's stop of a process never stopped, then lets go of the loads (their close). The pieces of a way
// are copied (at, args and cwd: processes'); the places it runs in outlive it. Out of memory aborts.
#ifndef PROGRAMS_START_H
#define PROGRAMS_START_H

#include "../../../ermine/processes/c/start.h"
#include "../../../ermine/programs/c/build.h"
#include "programs.h"

typedef struct ps ps;
typedef struct ps_process ps_process;

// what create_api is handed: the host's own, for making what the program gets
typedef struct {
	// where it runs: the places given, and their root
	pl *places;
	const char *root;
	struct {
		const char *id;
		const char *const *at;
		size_t nat;
		const char *const *args;
		size_t nargs;
		const char *const *cwd;
		size_t ncwd;
	} process;
	sc_scheduler *scheduler;
	tb_table *table;
	sc_scope *scope;
} ps_context;

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// where status.h's writes are committed, and what makes headers
	pl *places;
	bd *builds;
	sn *scopes;
	const hf *functions;
	// what the program is given; free_api lets it go (NULL: nothing to free), after the process stops
	void *(*create_api)(const ps_context *ctx, void *data);
	void (*free_api)(void *api, void *data);
	void *data;
	// told every write's changed entries (the host's places, a box's shares it)
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// where the scopes made here are noted (ermine/sites); NULL: not noted. the programs' own scope's
	// site is where ps_new was called, a process's where ps_start was
	st_sites *sites;
	// 1: each build's latest run on the process's node too (runs.h), as start.ts does when the
	// places given name reads
	int runs;
} ps_setup;

typedef struct {
	// "taken", "no-runner", or another code's name
	const char *refused;
	const pg_place *program;
	// taken: the path, names from the root (the programs' until ps_free)
	const char *const *at;
	size_t nat;
} ps_refusal;

// a start's own: args (has_args 0: none written, the program given none); cwd, steps from the root
// as at's (has_cwd 0: the folder at is in)
typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	const char *const *cwd;
	size_t ncwd;
	int has_cwd;
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
// its path from its root, and its cwd, names: how many, *out borrowed (the programs' until ps_free)
size_t ps_at(const ps_process *p, const char *const **out);
size_t ps_cwd(const ps_process *p, const char *const **out);
// the runner's stop, the row taken out, the scope torn down; twice: nothing
void ps_stop(ps *p, ps_process *process);
// listeners away, with the scheduler alive
void ps_halt(ps *p);
void ps_free(ps *p);

#endif
