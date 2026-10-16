// Start (typescript/start.ts), in C: a process's life, at a path in a box or plain places (the root
// is the outermost box), and its stop. Same rules as start.ts (its header says them once). What runs
// in a process is its starter's: this knows no programs, chains, loaders, builds or types. A box here
// is its places (bx_places): places rooted at its folder; any places stands in for one.
//
//   pr *s = pr_new(&setup);                                   // with a scope open
//   pr_refusal no;
//   pr_process *p = pr_start(s, bx_places(b), at, nat, &(pr_options){..}, &no);   // NULL: refused
//   pr_give(s, p, computer, 0);                               // its status on the process's node
//   pr_stop(s, p);
//   pr_halt(s);  /* before sc_free */  ...  pr_free(s);     // after tb_free and pl_free
//
// pr_start: refused, nothing made: "taken" (a process at the path, above it or under it), or another
// code's name (a name that is not one). Else a scope ([["process", at]] under the owner) and its node
// (sn_give: proc:<uuid>), the row (pr_add, through setup.commit), the node's attributes
// (ermine.process.args when given, ermine.process.cwd, ermine.process.pin when given, the status
// pending), then options.body with the scope open. pr_stop: options.stop with the scope open, the
// row out, the scope torn down; twice: nothing. The scope torn down another way: the same, its
// computers gone first.
//
// WRITES. Each with the process's scope open: the attributes entry (a table event), the row (committed
// through setup.commit: the host's places, whose views a box's places are), status.h's through the
// places given.
//
// MEMORY. A process is the life's until pr_free; one stopped (or refused) stays a stopped one. pr_free
// calls the stop of a process never stopped (no scope open: the scheduler is gone). at, args, cwd
// and the root are copied; the pin is the attributes'; the places it runs in outlive it. Out of
// memory aborts.
#ifndef PROCESSES_START_H
#define PROCESSES_START_H

#include "../../boxes/c/boxes.h"
#include "../../sites/c/sites.h"
#include "scopes.h"

// the attributes written on a process's node
#define PR_ARGS "ermine.process.args"
#define PR_CWD "ermine.process.cwd"
#define PR_PIN "ermine.process.pin"

typedef struct pr pr;
typedef struct pr_process pr_process;

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// where status.h's writes are committed, and what makes headers
	pl *places;
	sn *scopes;
	// told every write's changed entries (the host's places, a box's shares it); NULL: pl_commit on
	// places
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// where the scopes made here are noted (ermine/sites); NULL: not noted
	st_sites *sites;
	// 1: pr_give's run, a computer's latest run, on the process's node too (runs.h)
	int runs;
	// the scope the processes' are made under (torn down: every process goes); NULL: one of its own,
	// made under the scope open, its info [["processes", "start"]], noted where pr_new was called
	sc_scope *owner;
} pr_setup;

// a start's own: args (has_args 0: none written); cwd, steps from the root as at's (has_cwd 0: the
// folder at is in); pin, written as ermine.process.pin (NULL: none; borrowed). body, called once
// its node and row are there, and stop, called at its stop, each with the scope open and data
// (NULL: nothing)
typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	const char *const *cwd;
	size_t ncwd;
	int has_cwd;
	const op_value *pin;
	void (*body)(pr_process *p, void *data);
	void (*stop)(pr_process *p, void *data);
	void *data;
} pr_options;

typedef struct {
	// "taken", or another code's name
	const char *refused;
	// the path, names from the root (the life's until pr_free)
	const char *const *at;
	size_t nat;
} pr_refusal;

// with a scope open. a macro: the site noted is the caller's
pr *pr_new_at(const pr_setup *setup, const char *file, int line, const char *func);
#define pr_new(...) pr_new_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// where: the places it runs in (a box's, or plain places). at: nat steps from its root (a name, ".",
// "..", "/": bx_inside, ".." at the root staying there). options may be NULL. a macro: the site
// noted is the caller's
pr_process *pr_start_at(pr *s, pl *where, const char *const *at, size_t nat,
	const pr_options *options, pr_refusal *refused, const char *file, int line, const char *func);
#define pr_start(...) pr_start_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// the computer's status on the process's node; run 1: its latest run too, when setup.runs
void pr_give(pr *s, pr_process *p, sc_computer *c, int run);
// its scope, its node's id, the places it runs in and their root
sc_scope *pr_scope(const pr_process *p);
const char *pr_id(const pr_process *p);
pl *pr_places(const pr_process *p);
const char *pr_root(const pr_process *p);
// its path from its root, its cwd, its args: how many, *out borrowed (the life's until pr_free)
size_t pr_at(const pr_process *p, const char *const **out);
size_t pr_cwd(const pr_process *p, const char *const **out);
size_t pr_args(const pr_process *p, const char *const **out);
// options.stop called, the row taken out, the scope torn down; twice: nothing
void pr_stop(pr *s, pr_process *p);
// listeners away, with the scheduler alive
void pr_halt(pr *s);
void pr_free(pr *s);

// a process's path and its working folder (has_cwd 0: the folder at is in), as pr_start resolves
// them: names, copied (pr_names_free)
char **pr_names(const char *const *steps, size_t n, size_t *out);
char **pr_cwd_of(const char *const *at, size_t nat, const char *const *cwd, size_t ncwd,
	int has_cwd, size_t *out);
void pr_names_free(char **names, size_t n);

#endif
