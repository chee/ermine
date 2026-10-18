// start (typescript/start.ts) in C: a process from a way (satisfy's program with one of its chains,
// or one of open_with's), in a box or plain places, at a path from its root; and its stop. same
// rules as start.ts, held to by extensions/programs/conformance/start. the process's life is
// ermine/processes' start.h's; this runs the way in it. a box here is its places (bx_places); any
// places stands in for one.
//
//   ps *p = ps_new(&setup);                                  // with a scope open
//   pg_way way = {found->program, found->chains.items[0]};
//   ps_refusal no;
//   ps_process *x = ps_start(p, bx_places(b), &way, at, nat, &(ps_options){..}, &no);   // NULL: refused
//   ps_stop(p, x);
//   ps_stop_all(p);  /* listeners */  ...  ps_free(p);      // ps_halt before sc_free, ps_free after tb_free and pl_free
//
// runners: host functions (hf_runner) returning a stop, or a loaded step's run, given the built
// code and create_api's api (the program gets its return, nothing else). a runner that gives no
// promise only: its stop at once. not here: a runner returning a promise (hf_run has none).
// refused, nothing made: taken (a process at, above or under the path), no-runner (an empty
// chain); another place's code: not-a-name.
// loading, as start.ts': a step with a non-empty by: its value through by's compilers, then by's
// runner's load (hf_add_loader) gives its live form (hf_live), used as the step (a compiler through
// bd_step under its identity: ermine.programs.compiler, else { id, hash }, else its id). keyed by
// the step's id, its value's hash and by's keys; made once, held by its processes, closed at the
// last one's stop (dlopen: dlclose, file removed). a failure: its holders' status (the next start
// loads again); not-a-loader, not-a-compiler, not-a-runner. C loads are synchronous, in the
// build's run. dlopen.h loads native libraries (native.h; conformance/native).
// writes: processes' start.h's.
// memory: a process is the programs' until ps_free; stopped stays stopped. ps_free stops any never
// stopped, then lets go of the loads (their close). a way's pieces are copied (at, args, cwd:
// processes'); the places it runs in outlive it. out of memory aborts.
#ifndef PROGRAMS_START_H
#define PROGRAMS_START_H

#include "../../../ermine/processes/c/start.h"
#include "../../build/c/build.h"
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
	// 1: each build's latest run on the runs' table (runs.h) by the process's id, as start.ts does when the
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
// its path from its root, names: how many, *out borrowed (the programs' until ps_free)
size_t ps_at(const ps_process *p, const char *const **out);
// the runner's stop, the row taken out, the scope torn down; twice: nothing
void ps_stop(ps *p, ps_process *process);
// listeners away, with the scheduler alive
void ps_halt(ps *p);
void ps_free(ps *p);

#endif
