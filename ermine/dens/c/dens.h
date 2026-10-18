// dens (typescript/dens.ts) in C: a den's node, what it offers, start by runner, stop, the asks,
// close. same rules as dens.ts, held to by ermine/dens/conformance/{dens,away}. the processes'
// life is ermine/processes' start.h's (pr_*), inside dens.c only; a box here is its places.
//
//   const char *error;
//   dn *d = dn_new(&(dn_setup){.scheduler = s, .table = t, .places = p, .scopes = sn, .functions = fs,
//     .id = "mac", .create_api = api, .data = h, .may = policy}, &error);   // with a scope open
//   dn_refusal no;
//   const char *js = dn_offer(d, NULL, DN_RUNNERS, "javascript", attrs, hf_value("javascript"), &no);
//   dn_process *x = dn_start(d, runner, 4, &(dn_program){.at = prog, .nat = 2, .has_at = 1},
//     at, 2, &(dn_options){..}, &no);                                       // NULL: refused
//   dn_stop(d, x, reason, &no);
//   dn_close(d, NULL);  dn_halt(d);  /* before sc_free */  ...  dn_free(d);  // after tb_free, pl_free
//
// dn_new, a scope open: an owner scope [["den", id]] under it; processes' start at
// /system/dens/<id> under the owner, attributes { ermine.type: ermine.den, ermine.den.id, .name?,
// .device? }; in its body: its children { on }, the folder on { start, stop } (method nodes), and
// /system/den (pr_add, the same id). its status: gone at the first pulse. id not a name:
// not-a-name; /system/dens/<id> or /system/den taken: already-there.
// dn_offer: a node <owner id>/<kind>/<name> in the folder <owner id>/<kind> (made at the first offer
// of that kind, upserted into the owner's children; kept, empty, after its last offer goes), its
// attributes as given and ermine.type ermine.runner | ermine.compiler | ermine.surface over them,
// its value live. dn_withdraw: its users stopped (newest first, "withdrawn"), its name out, its node
// gone. an owner's stop withdraws its offers first, newest first, their users stopped
// "runner-stopped", then its own handle.
// dn_start refused, nothing made, the first that holds: stopped; not-a-runner (nothing at runner,
// or its ermine.type no ermine.runner); not-there (no program node or no value; by id: none, or not
// the hash given; code given: not the hash given); wrong-form (the program's type is not the
// runner's ermine.runner.takes, both strings; or it names an api the runner's ermine.runner.api is
// not); not-a-runner (the runner's value no runner hf_find knows); no-permission (the policy asked
// start on the runner, then read on the program's value, not for code given: no, or pending, its
// need dropped); taken (processes'). else processes' start with ermine.type ermine.process,
// ermine.process.runner { id, at }, .program { id, at?, hash? }, .den { id, at }.
// dn_stop: asked stop on its node (refused: still running); its offers' users stopped, its handle
// given the reason, the row out, the node gone; twice, or not running: nothing; the den's own:
// dn_close. a process torn down from above (the owner going): the den's reason ("den-stopped", or
// dn_close's); its own scope torn down directly: none.
// dn_ask: another den's start or stop, its who given (device: the transport's); no policy: refused
// no "no policy". dn_close: every process stopped, newest first, each handle given the reason; the
// den's rows last. after it: start, ask, offer refused stopped.
// unplace or move never stops a process: its row is in the process part, not in children.
// writes: with the owner's scope open (the den, its offers) or the process's. policy reads: the
// table, untracked.
//
// live values: hf stand-ins (extensions/build/c/host.h). a runner here: hf_find gives an entry with
// a runner. it is called at the process's first pulse (a one-shot effect), the process's scope
// open, with the code and create_api's api; hf_run.error: the status. a stop's reason: given to
// hf_run.stop_reason when set, else handle.stop. no promises (hf_run has none). on/start and
// on/stop hold hf_value(""); their call is dn_on. the policy: protect's (pr_ask_of), reading the
// table untracked. an ask's and an answer's shapes are dens.ts' (dn_ask, dn_refusal_value).
// memory: a process or offer lives until dn_free; ids, paths, args copied; attributes, device,
// pins and codes held (op_ref); a dn_refusal's strings are the den's until its next call; its
// answer is the policy's (until pr_policy_free). the apis create_api made: free_api'd at dn_free.
// dn_free with the table and places gone: a process never stopped has its handle's stop called,
// nothing written. out of memory aborts.
// open: promises (hf_run has none); /system/den inside a box; boxed processes in dn_nodes
#ifndef DENS_H
#define DENS_H

#include "../../../filesystem/places/c/places.h"
#include "../../../filesystem/protect/c/protect.h"
#include "../../../extensions/build/c/host.h"
#include "../../processes/c/scopes.h"
#include "../../sites/c/sites.h"

// /system/dens and /system/den, from the root
extern const char *const dn_dens[2];
extern const char *const dn_here[2];
#define DN_ON "on"

// the one field everything matches on (ermine/types' ATTRIBUTE)
#define DN_ATTRIBUTE "ermine.type"
#define DN_TYPE_DEN "ermine.den"
#define DN_TYPE_PROCESS "ermine.process"
#define DN_TYPE_RUNNER "ermine.runner"
#define DN_TYPE_COMPILER "ermine.compiler"
#define DN_TYPE_SURFACE "ermine.surface"
#define DN_ID "ermine.den.id"
#define DN_NAME "ermine.den.name"
#define DN_DEVICE "ermine.den.device"
#define DN_TAKES "ermine.runner.takes"
#define DN_API "ermine.runner.api"
#define DN_WHERE "ermine.runner.where"
#define DN_COMPILER_TAKES "ermine.compiler.takes"
#define DN_GIVES "ermine.compiler.gives"
#define DN_KIND "ermine.surface.kind"
#define DN_SIZE "ermine.surface.size"
#define DN_PROGRAM_API "ermine.program.api"
#define DN_RUNNER "ermine.process.runner"
#define DN_PROGRAM "ermine.process.program"
#define DN_DEN "ermine.process.den"
#define DN_WITHDRAWN "withdrawn"
#define DN_RUNNER_STOPPED "runner-stopped"
#define DN_DEN_STOPPED "den-stopped"

typedef struct dn dn;
typedef struct dn_process dn_process;
typedef enum { DN_RUNNERS, DN_COMPILERS, DN_SURFACES } dn_kind;

// what create_api is handed: programs' ps_context's fields, and the den
typedef struct {
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
	dn *den;
} dn_context;

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// the host's places at its root, its contributors with the process trie (and away's)
	pl *places;
	sn *scopes;
	const hf *functions;
	// a name, copied
	const char *id;
	// ermine.den.name (copied), ermine.den.device (held); NULL: not written
	const char *name;
	const op_value *device;
	// NULL: a local ask yes, another den's no ("no policy")
	const pr_policy *may;
	void *(*create_api)(const dn_context *ctx, void *data);
	// at dn_free, after its process stopped; NULL: nothing
	void (*free_api)(void *api, void *data);
	void *data;
	// NULL: pl_commit on places
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	st_sites *sites;
	int runs;
} dn_setup;

// a start's program: an address from where's root (has_at), or by id; hash NULL: any; code
// non-NULL: carried (nothing read), its form type and api
typedef struct {
	const char *const *at;
	size_t nat;
	int has_at;
	const char *id;
	const char *hash;
	const op_value *code;
	const char *type;
	const char *api;
} dn_program;

typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	const char *const *cwd;
	size_t ncwd;
	int has_cwd;
	// where it runs, and where program and at are from; NULL: the den's places
	pl *box;
	// ermine.process.pin; NULL: none
	const op_value *pin;
} dn_options;

// refused: "stopped" "not-a-runner" "not-there" "wrong-form" "no-permission" "taken", or
// "not-a-name" (offer, a bad name; start, a path with none), "nothing-there" (offer, by no running
// process of this den's). the fields of the refusal given, the rest NULL or 0
typedef struct {
	const char *refused;
	// not-a-runner: the runner's path
	const char *const *runner;
	size_t nrunner;
	// not-there (a start's): program_has_at: its path; else its id in program
	const char *program;
	const char *const *program_at;
	size_t nprogram_at;
	int program_has_at;
	// not-there (a stop's)
	const char *process;
	// wrong-form: each NULL when not a string
	const char *type, *api, *takes, *runner_api;
	// no-permission: op "start" | "read" | "stop"; answer PR_NO (reason) or PR_PENDING
	const char *op;
	pr_answer answer;
	// taken
	const char *const *at;
	size_t nat;
} dn_refusal;

// with a scope open. NULL: *error says (not-a-name, already-there). a macro: the site is the caller's
dn *dn_new_at(const dn_setup *setup, const char **error, const char *file, int line, const char *func);
#define dn_new(...) dn_new_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
const char *dn_id(const dn *d);
const char *dn_node(const dn *d);
dn_process *dn_self(const dn *d);
sc_scope *dn_scope(const dn *d);
pl *dn_places(const dn *d);
sc_scheduler *dn_scheduler(const dn *d);
tb_table *dn_table(const dn *d);

// by: a process of the den's, NULL: the den. attributes: a map (held; NULL: none). live: a stand-in
// (held; NULL: none). the id (the den's until dn_free), or NULL and *refused (taken, not-a-name,
// nothing-there, stopped)
const char *dn_offer(dn *d, dn_process *by, dn_kind kind, const char *name,
	const op_value *attributes, const op_value *live, dn_refusal *refused);
// an offer's path from the root; 0: no such offer
size_t dn_offered_at(dn *d, const char *id, const char *const **out);
// its users stopped (newest first, "withdrawn"), its name out, its node gone; unknown: nothing
void dn_withdraw(dn *d, const char *id);

// runner: nrunner steps from the den's root. NULL: refused (dens.ts' order)
dn_process *dn_start_at(dn *d, const char *const *runner, size_t nrunner, const dn_program *program,
	const char *const *at, size_t nat, const dn_options *options, dn_refusal *refused,
	const char *file, int line, const char *func);
#define dn_start(...) dn_start_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// with a scope open: asked op stop. 0: stopped, or nothing to stop; 1: refused (no-permission).
// reason borrowed for the call (NULL: none). p the den's own: dn_close
int dn_stop(dn *d, dn_process *p, const op_value *reason, dn_refusal *refused);
// another den's ask, as dens.ts' Ask (a map: op, runner, program, at, args?, cwd? | op, process,
// reason?), who given: the answer, new ({ id, at } | {} | a refusal's value). NULL: op neither
op_value *dn_ask(dn *d, const op_value *who, const op_value *ask);
// the method at <den>/on/<op> ("start" | "stop"), the scope open's who: the answer, new. NULL: no
// such method
op_value *dn_on(dn *d, const char *op, const op_value *body);
// a refusal as dens.ts' Refused, new
op_value *dn_refusal_value(const dn_refusal *r);

// running, not the den's own; NULL: none
dn_process *dn_find(const dn *d, const char *id);
// running, in start order (not the den's own); *out the den's until its next change
size_t dn_processes(const dn *d, dn_process *const **out);
const char *dn_process_id(const dn_process *p);
size_t dn_process_at(const dn_process *p, const char *const **out);
sc_scope *dn_process_scope(const dn_process *p);
// dens.ts' nodes(): new, its reads told (sc_track, pl_read); processes 0: left out
op_value *dn_nodes(dn *d, int processes);
// every process stopped (newest first), each handle given reason (NULL: "den-stopped"); its rows last
void dn_close(dn *d, const op_value *reason);
void dn_halt(dn *d);
void dn_free(dn *d);
// core candidate (ermine/encoding, beside bd_hash_hex): hex of a value's hash; 0: no encoding (a
// stand-in in it)
int dn_hash_hex(const op_value *v, char out[65]);

#endif
