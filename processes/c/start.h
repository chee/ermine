// start (typescript/start.ts) in C: a process's life at a path in places, and its stop. same rules
// as start.ts. knows no programs or loaders.
//
//   pr *s = pr_new(&setup);                                   // with a scope open
//   pr_refusal no;
//   pr_process *p = pr_start(s, places, at, nat, &(pr_options){..}, &no);   // NULL: refused
//   pr_give(s, p, computer, 0);                               // its status on the process's node
//   pr_stop(s, p);
//   pr_halt(s);  /* before sc_free */  ...  pr_free(s);     // after tb_free and pl_free
//
// pr_start refused, nothing made: "taken" (a process already at exactly the path; above or under it is fine, whether it may is protect's) or a name code.
// else: its node's id proc:<uuid>, a scope [["process", at], [CH_NODE, id]] (sn_give; started from
// outside the graph, with no run open and no frame up the chain holding locations, [CH_LOCATIONS,
// the call's one location] too) under options.under (NULL: the owner), the row, attributes (options.attributes, then
// ermine.process.args, .folder, .pin, status pending: processes' own win), then options.body. pr_stop:
// options.stop, row out, scope torn down, its run record out; its scope torn down from above: what
// is under it first, then the same; twice: nothing.
// writes: all with the process's scope open. setup.write given (start.ts' write): the row, the
// attributes and the status entry are each handed to it to do and say, and not made here nor committed
// (setup.commit not asked); NULL: made here. statuses (status.h) get the same writer.
// memory: a process lives until pr_drop's scope is freed, or pr_free (which stops one never stopped). at, args, folder, root are
// copied; the pin and options.attributes' values are the attributes' (op_ref); the places must
// outlive it. out of memory aborts.
#ifndef PROCESSES_START_H
#define PROCESSES_START_H

#include "processes.h"
#include "scopes.h"

// the attributes written on a process's node
#define PR_ARGS "ermine.process.args"
#define PR_FOLDER "ermine.process.folder"
#define PR_PIN "ermine.process.pin"

typedef struct pr pr;
typedef struct pr_process pr_process;

// a write handed over (places' Writer): patches on (part, id), with the header of the write; it does
// the write, commits it and tells the places. patches and header are borrowed, good for the call
// (a writer that holds one copies it); the header's block is held here on the node it landed on
typedef void (*pr_writer)(void *ctx, const char *part, tb_key id, const op_patch *patches, size_t n,
	const ch_header *header);

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// where status.h's writes are committed, and what makes headers
	pl *places;
	sn *scopes;
	// told every write's changed entries (the host's places); NULL: pl_commit on
	// places
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// every write of a start or stop (the row, the node's attributes, its status entry), handed to it
	// with the scope open; NULL: each made here, and committed as above
	pr_writer write;
	void *write_ctx;
	// 1: pr_give's run, a computer's latest run, on the runs' table (runs.h) by the process's id
	int runs;
	// the scope the processes' are made under (torn down: every process goes); NULL: one of its own,
	// made under the scope open, its info [["processes", "start"]], noted where pr_new was called
	sc_scope *owner;
	// a row's going with no stop's caller (its scope torn down from above): its site, into buf (NULL
	// back, or no site: processes' own)
	const ch_location *(*site)(void *ctx, ch_location *buf);
	void *site_ctx;
	// a new process's node id, the host's, malloc'd (unique for as long as its nodes are kept).
	// NULL: "proc:<boot>-<n>", boot 16 hex random once per pr_new, n from 1
	char *(*id)(void *ctx);
	void *id_ctx;
} pr_setup;

// a start's own: args (has_args 0: none written); folder, steps from the root as at's (has_folder
// 0: the folder at is in); pin, written as ermine.process.pin (NULL: none; borrowed). body, called once
// its node and row are there, and stop, called at its stop, each with the scope open and data
// (NULL: nothing). attributes: a map (NULL: none; borrowed), its pairs written first, in the same
// entry: a name processes' own write too is theirs. under: the scope its scope is made under (torn
// down: it goes; NULL: the owner)
typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	const char *const *folder;
	size_t nfolder;
	int has_folder;
	const op_value *pin;
	void (*body)(pr_process *p, void *data);
	void (*stop)(pr_process *p, void *data);
	void *data;
	const op_value *attributes;
	sc_scope *under;
} pr_options;

typedef struct {
	// "taken", or another code's name
	const char *refused;
	// the path, names from the root (borrowed till the next pr_start or pr_free)
	const char *const *at;
	size_t nat;
} pr_refusal;

// with a scope open. a macro: the location is the caller's
pr *pr_new_at(const pr_setup *setup, const char *file, int line, const char *func);
#define pr_new(...) pr_new_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// where: the places it runs in. at: nat steps from its root (a name, ".", "..", "/": ".." at the
// root staying there). options may be NULL. a macro: the site
// is the caller's, and its scope's if it began outside the graph (file NULL: none)
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
// its path from its root, its folder, its args: how many, *out borrowed (the life's until pr_free)
size_t pr_at(const pr_process *p, const char *const **out);
size_t pr_folder(const pr_process *p, const char *const **out);
size_t pr_args(const pr_process *p, const char *const **out);
// options.stop called, the row taken out, the scope torn down; twice: nothing. a macro: the site of
// the row's going is the caller's (file NULL: processes' own). what the scope's teardown threw: its
// first error, malloc'd for the caller to free (NULL: none), as start.ts' stop rethrows it
char *pr_stop_at(pr *s, pr_process *p, const char *file, int line, const char *func);
#define pr_stop(...) pr_stop_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// the holder lets go of p (stopped first if it is not): its scope's maker's hold let go, and p
// freed as that scope is (torn down, held by nothing: what is under it, a record). its
// pointer is no good after. what the stop threw, as pr_stop gives it
char *pr_drop(pr *s, pr_process *p);
// the same, but p goes on running: its holder only lets go, and it is freed as its scope is (its
// starter's ending, or its stop). for a process something else owns
void pr_let_go(pr *s, pr_process *p);
// listeners away, with the scheduler alive
void pr_halt(pr *s);
void pr_free(pr *s);

// a process's path and its folder (has_folder 0: the one at is in), as pr_start resolves
// them: names, copied (pr_names_free)
char **pr_names(const char *const *steps, size_t n, size_t *out);
char **pr_folder_of(const char *const *at, size_t nat, const char *const *folder, size_t nfolder,
	int has_folder, size_t *out);
void pr_names_free(char **names, size_t n);

#endif
