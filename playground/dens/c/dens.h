// dens (typescript/dens.ts) in C: a den's node, what it offers, start by runner, stop, the asks,
// close. same rules as dens.ts, held to by playground/dens/conformance/{dens,away}. the processes'
// life is ermine/processes' start.h's (pr_*), inside dens.c only; a box here is its places.
//
//   const char *error;
//   dn *d = dn_new(&(dn_setup){.scheduler = s, .table = t, .places = p, .scopes = sn, .functions = fs,
//     .id = "mac", .may = policy}, &error);                                 // with a scope open
//   dn_refusal no;
//   const char *js = dn_offer(d, NULL, DN_RUNNERS, "javascript", attrs, hf_value("javascript"), &no);
//   dn_process *x = dn_start(d, runner, 4, &(dn_program){.at = prog, .nat = 2, .has_at = 1},
//     at, 2, &(dn_options){..}, &no);                                       // NULL: refused
//   dn_loaded *l = dn_load(d, x, letter, 6, &(dn_program){.id = "e", .code = c, .type = t},
//     NULL, &no);                                                           // NULL: refused
//   dn_loaded_live(l)->run(...);  dn_release(d, l);                         // else at x's stop
//   dn_stop(d, x, reason, &no);
//   dn_close(d, NULL);  dn_halt(d);  /* before sc_free */  ...  dn_free(d);  // after tb_free, pl_free
//
// dn_new, a scope open: an owner scope [["den", id]] under it; processes' start at /system/session
// under the owner, attributes { ermine.type: ermine.process, ermine.process.den: { id: the den's
// node, at: /system/dens/<id> } } (its status: gone at the first pulse); in its body: the den's node's
// attributes { ermine.type: ermine.den, ermine.den.id, .name?, .device? } written over what was
// there, its children { on }, the folder on { start, stop } (method nodes, then the asks stored under
// them answered: asks.h), and the leaves /system/dens/<id> and /system/den (pr_add, the den's node).
// the den's node is the install's: setup.install is its id (NULL: a fresh one). its attributes,
// children and offers' attributes are stored there and stay when the session ends; only the live
// values (offers', methods') go with it. id not a name: not-a-name; /system/session, /system/dens/<id>
// or /system/den taken: already-there.
// dn_offer: a node <owner id>/<kind>/<name> in the folder <owner id>/<kind> (made at the first offer
// of that kind, upserted into the owner's children; held, empty, after its last offer goes), its
// attributes as given and ermine.type ermine.runner | ermine.compiler | ermine.surface over them,
// its value live; a name taken (offered now; for a process's, entries at its id already; for the
// den's, a live value there): refused taken, nothing made. a process runs under the scope of the offer it runs on (dens.ts' start), so an offer's node
// going takes what runs on it, newest first. dn_withdraw: its name out, then its node gone, its
// users stopped "withdrawn" (its attributes out too). an owner's stop takes its offers first, newest first, their users
// stopped "runner-stopped", then its own handle.
// dn_start refused, nothing made, the first that holds: stopped; not-a-runner (nothing at runner,
// or its ermine.type no ermine.runner); not-there (no program node or no value; by id: none, or not
// the hash given; code given: not the hash given); wrong-form (the program's type is not the
// runner's ermine.runner.takes, both strings; or it names an api the runner's ermine.runner.api is
// not); not-a-runner (the runner's value no runner hf_find knows); no-permission (the policy asked
// start on the runner, then read on the program's value, not for code given: no, or pending, its
// need dropped); taken (processes'). else processes' start with ermine.type ermine.process,
// ermine.process.runner { id, at }, .program { id, at?, hash? }, .den { id, at }. a start made
// outside a run (sc_get_run NULL; an ask's too): a pulse asked for (setup.schedule; NULL: none, the
// host pulses).
// dn_load: the program made live on the runner with no process (dens.ts' load): checked as dn_start
// is (never taken; a runner with no load, hf_add_loader's: not-a-runner), the load called with the
// scope open (none: by's). by: a process of this den's (NULL: the den's own); not running: refused
// nothing-there. the load failing: refused "failed", error its message. held by by, closed
// (hf_live.close) at dn_release or at by's stop, after its handle's, newest first (the den's own at
// its close). made: a pulse asked for, as dn_start's. its live form's calls are its caller's: their
// cost and failures its caller's runs'.
// dn_stop: asked stop on its node (refused: still running); the reason told, then where it runs
// torn down: its offers' users stopped, its handle given the reason, then its scope (what its
// program made, its loads closed, the row out, the node gone); twice, or not running: nothing; the
// den's own: dn_close. a process gone with what it runs under, not told: the den closing (or its
// owner torn down), the den's reason ("den-stopped", or dn_close's); its runner's offer going, the
// offer's ("withdrawn", else "runner-stopped"); else none.
// dn_ask: another den's start or stop, its who given (device: the transport's); no policy: refused
// no "no policy". a start's fields (dn_ask's, dn_on's body's) as given: runner and at no address:
// none; program neither an address nor a map: { id: "" } (an id that is no string: ""; a type or
// api that is no string: none; a hash given that is no string: none's); a step that is no string,
// args given that are no list of strings, a cwd given that is no address: refused not-a-name.
// dn_close: every process's scope torn down, newest first, each handle given the reason; then the
// owner: the session's process and the leaves last. the den's node stays with what is stored on it. after it: start, load, ask, offer refused stopped.
// unplace or move never stops a process: its row is in the process part, not in children.
// writes: with the owner's scope open (the den, its offers) or the process's. policy reads: the
// table, untracked.
//
// live values: hf stand-ins (extensions/build/c/host.h). a runner here: hf_find gives an entry with
// a runner. it is called at the process's first pulse (a one-shot effect), the process's scope
// open, with the code and the start's facts (a dn_starting, borrowed for the call; its strings the
// process's, until dn_free) as its api: what the program gets is the runner's to make, from its
// data (hf_add_runner's) and the facts; no api here. its limits are its own too (fuel, a budget),
// nothing here counts. hf_run.error: the status. a stop's reason: given to hf_run.stop_reason when
// set, else handle.stop (a runner over ermine/api: api_stop with it, so its teardowns are told).
// a load: the entry's load, given the code alone (host.h's hf_loader: no facts, unlike dens.ts').
// no promises (hf_run has none). on/start and on/stop hold hf_value(""); their call is dn_on. the asks stored under them (asks.h) are answered as dn_ask answers. the policy: protect's (pr_ask_of), reading the
// table untracked. an ask's and an answer's shapes are dens.ts' (dn_ask, dn_refusal_value).
// memory: a process, offer or load lives until dn_free; ids, paths, args copied; attributes, device,
// pins and codes held (op_ref); a dn_refusal's strings are the den's until its next call; its
// answer is the policy's (until pr_policy_free). dn_free with the table and places gone: a process
// never stopped has its handle's stop called, a load never let go its close, nothing written. out of
// memory aborts.
// open: promises (hf_run has none); /system/den inside a box; boxed processes in dn_nodes
#ifndef DENS_H
#define DENS_H

#include "../../../filesystem/places/c/places.h"
#include "../../../filesystem/protect/c/protect.h"
#include "../../../extensions/build/c/host.h"
#include "../../../ermine/processes/c/scopes.h"
#include "../../../ermine/sites/c/sites.h"

// /system/dens and /system/den, from the root
extern const char *const dn_dens[2];
extern const char *const dn_here[2];
// /system/session: this session's process
extern const char *const dn_session[2];
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
typedef struct dn_loaded dn_loaded;
typedef enum { DN_RUNNERS, DN_COMPILERS, DN_SURFACES } dn_kind;

// a start's facts, what a runner is handed as its api (dens.ts' Start): programs' ps_context's
// fields, and the den. a load's: its by's
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
} dn_starting;

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// the host's places at its root, its contributors with the process trie (and away's)
	pl *places;
	sn *scopes;
	const hf *functions;
	// a name, copied
	const char *id;
	// the install's id: the den's node's, the same every start (copied); NULL: a fresh one
	const char *install;
	// ermine.den.name (copied), ermine.den.device (held); NULL: not written
	const char *name;
	const op_value *device;
	// NULL: a local ask yes, another den's no ("no policy")
	const pr_policy *may;
	// how a pulse is asked for: f(data) run soon, once. NULL: none asked (the host pulses: C has no
	// microtasks, dens.ts' default)
	void (*schedule)(void *ctx, void (*f)(void *data), void *data);
	void *schedule_ctx;
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
// "not-a-name" (offer, a bad name; start, a path with none), "nothing-there" (offer or load, by no
// running process of this den's), "failed" (a load's, error its message). the fields of the refusal
// given, the rest NULL or 0
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
	// failed
	const char *error;
} dn_refusal;

// sites: each call that writes is an _at function taking its caller's site (ch_site, borrowed for the
// call; NULL: none), and a macro of the plain name passing CH_HERE, so a write's site is the line
// that called. a wrapper over dens passes its own caller's. the writes a call makes, and those it
// sets off at once (an offer's users stopped, a process's row out), carry it; a write with no call
// going on (a teardown from above, a pulse): the nearest site noted (setup.sites) up the run open's
// computer, else up the scope open; none noted: none

// with a scope open. NULL: *error says (not-a-name, already-there)
dn *dn_new_at(const dn_setup *setup, const char **error, const ch_site *site);
#define dn_new(...) dn_new_at(__VA_ARGS__, CH_HERE)
const char *dn_id(const dn *d);
const char *dn_node(const dn *d);
// this session's process (at /system/session): its id
const char *dn_session_id(const dn *d);
dn_process *dn_self(const dn *d);
sc_scope *dn_scope(const dn *d);
pl *dn_places(const dn *d);
sc_scheduler *dn_scheduler(const dn *d);
tb_table *dn_table(const dn *d);

// by: a process of the den's, NULL: the den. attributes: a map (held; NULL: none). live: a stand-in
// (held; NULL: none). the id (the den's until dn_free), or NULL and *refused (taken, not-a-name,
// nothing-there, stopped)
const char *dn_offer_at(dn *d, dn_process *by, dn_kind kind, const char *name,
	const op_value *attributes, const op_value *live, dn_refusal *refused, const ch_site *site);
#define dn_offer(...) dn_offer_at(__VA_ARGS__, CH_HERE)
// an offer's path from the root; 0: no such offer
size_t dn_offered_at(dn *d, const char *id, const char *const **out);
// its name out, its node gone, its users stopped (newest first, "withdrawn"); unknown: nothing
void dn_withdraw_at(dn *d, const char *id, const ch_site *site);
#define dn_withdraw(...) dn_withdraw_at(__VA_ARGS__, CH_HERE)

// runner: nrunner steps from the den's root. NULL: refused (dens.ts' order)
dn_process *dn_start_at(dn *d, const char *const *runner, size_t nrunner, const dn_program *program,
	const char *const *at, size_t nat, const dn_options *options, dn_refusal *refused,
	const ch_site *site);
#define dn_start(...) dn_start_at(__VA_ARGS__, CH_HERE)
// by: a process of the den's, NULL: the den. options: only box is read (where program is from; NULL:
// by's places). NULL: refused
dn_loaded *dn_load_at(dn *d, dn_process *by, const char *const *runner, size_t nrunner,
	const dn_program *program, const dn_options *options, dn_refusal *refused, const ch_site *site);
#define dn_load(...) dn_load_at(__VA_ARGS__, CH_HERE)
// its live form, the load's (hf_live)
const hf_live *dn_loaded_live(const dn_loaded *l);
// closed now (hf_live.close), out of by's; twice: nothing
void dn_release_at(dn *d, dn_loaded *l, const ch_site *site);
#define dn_release(...) dn_release_at(__VA_ARGS__, CH_HERE)
// with a scope open: asked op stop. 0: stopped, or nothing to stop; 1: refused (no-permission).
// reason borrowed for the call (NULL: none). p the den's own: dn_close
int dn_stop_at(dn *d, dn_process *p, const op_value *reason, dn_refusal *refused,
	const ch_site *site);
#define dn_stop(...) dn_stop_at(__VA_ARGS__, CH_HERE)
// another den's ask, as dens.ts' Ask (a map: op, runner, program, at, args?, cwd? | op, process,
// reason?), who given: the answer, new ({ id, at } | {} | a refusal's value). NULL: op neither
op_value *dn_ask_at(dn *d, const op_value *who, const op_value *ask, const ch_site *site);
#define dn_ask(...) dn_ask_at(__VA_ARGS__, CH_HERE)
// the method at <den>/on/<op> ("start" | "stop"), the scope open's who: the answer, new. NULL: no
// such method
op_value *dn_on_at(dn *d, const char *op, const op_value *body, const ch_site *site);
#define dn_on(...) dn_on_at(__VA_ARGS__, CH_HERE)
// a refusal as dens.ts' Refused, new
op_value *dn_refusal_value(const dn_refusal *r);

// asks (asks.h): an ask written in the graph under a den's method, answered by the den. the name
// of an ask's answer, under the ask
#define DN_ANSWER "answer"

// where an ask is written: the table and places, and the scope it is written in (its header's actor)
typedef struct {
	tb_table *table;
	pl *places;
	sc_scope *scope;
} dn_world;

// the ask written under the den's method (site: the caller's, as above): its id, new. NULL: an ask
// that does not encode, has no op, or has an op that is neither "start" nor "stop"; and with no scope
// open (the header cannot be made): nothing is written
char *dn_ask_write_at(const dn_world *w, const char *den, const op_value *ask, const ch_site *site);
#define dn_ask_write(...) dn_ask_write_at(__VA_ARGS__, CH_HERE)
// the answer to the ask n, the read told; NULL until there. borrowed
const op_value *dn_ask_answer(const dn_world *w, const char *n);

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
void dn_close_at(dn *d, const op_value *reason, const ch_site *site);
#define dn_close(...) dn_close_at(__VA_ARGS__, CH_HERE)
void dn_halt(dn *d);
void dn_free(dn *d);
// core candidate (ermine/encoding, beside bd_hash_hex): hex of a value's hash; 0: no encoding (a
// stand-in in it)
int dn_hash_hex(const op_value *v, char out[65]);

#endif
