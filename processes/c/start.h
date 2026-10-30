// A process's life at a path in places, and its stop (typescript/start.ts) in C.
//
//   pr *s = pr_new(&setup);                                   // with a scope open
//   pr_process *p = pr_start(s, places, at, nat, &(pr_options){..}, &no);   // NULL: refused
//   pr_stop(s, p);
//   pr_halt(s);  /* before sc_free */  ...  pr_free(s);     // after tb_free and pl_free
//
// at, args, folder and root are copied. The places must outlive the processes. Out of memory aborts.
#ifndef PROCESSES_START_H
#define PROCESSES_START_H

#include "processes.h"
#include "scopes.h"

#define PR_ARGS "ermine.process.args"
#define PR_FOLDER "ermine.process.folder"
#define PR_PIN "ermine.process.pin"

typedef struct pr pr;
typedef struct pr_process pr_process;

// A write handed over (places' Writer). Patches and header are borrowed for the call; copy to hold.
typedef void (*pr_writer)(void *ctx, const char *part, tb_key id, const op_patch *patches, size_t n,
	const ch_header *header);

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	pl *places;
	sn *scopes;
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	pr_writer write;
	void *write_ctx;
	int runs;
	sc_scope *owner;
	const ch_location *(*site)(void *ctx, ch_location *buf);
	void *site_ctx;
	char *(*id)(void *ctx);
	void *id_ctx;
} pr_setup;

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
	const char *refused;
	const char *const *at;
	size_t nat;
} pr_refusal;

pr *pr_new_at(const pr_setup *setup, const char *file, int line, const char *func);
#define pr_new(...) pr_new_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// A macro, so the location is the caller's, and its scope's if it began outside the graph.
pr_process *pr_start_at(pr *s, pl *where, const char *const *at, size_t nat,
	const pr_options *options, pr_refusal *refused, const char *file, int line, const char *func);
#define pr_start(...) pr_start_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
void pr_give(pr *s, pr_process *p, sc_computer *c, int run);
sc_scope *pr_scope(const pr_process *p);
const char *pr_id(const pr_process *p);
pl *pr_places(const pr_process *p);
const char *pr_root(const pr_process *p);
size_t pr_at(const pr_process *p, const char *const **out);
size_t pr_folder(const pr_process *p, const char *const **out);
size_t pr_args(const pr_process *p, const char *const **out);
// A macro, so the location of the row's going is the caller's. Returns the first teardown error,
// malloc'd for the caller to free (NULL: none).
char *pr_stop_at(pr *s, pr_process *p, const char *file, int line, const char *func);
#define pr_stop(...) pr_stop_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// Lets go of p (stopping it first); p's pointer is no good after. Returns what the stop threw.
char *pr_drop(pr *s, pr_process *p);
// The same, but p goes on running; for a process something else owns.
void pr_let_go(pr *s, pr_process *p);
void pr_halt(pr *s);
void pr_free(pr *s);

char **pr_names(const char *const *steps, size_t n, size_t *out);
char **pr_folder_of(const char *const *at, size_t nat, const char *const *folder, size_t nfolder,
	int has_folder, size_t *out);
void pr_names_free(char **names, size_t n);

#endif
