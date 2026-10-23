// the process api (typescript/api.ts) in C: what a program is given. prefix api_. api.ts's header
// is the spec; ermine/api/conformance/api/ holds both to it.
//
//   api_context *x = api_context_new(&setup);      // once, by the host: what every process's shares
//   api *a = api_new(x, &start);                   // one per process (api.ts' createProcessAPI)
//   api_node notes;
//   api_open(a, "./notes", value, &notes);
//   api_read(a, api_of(&notes), NULL, 0, &v);
//   api_node_free(&notes); api_free(a); api_context_free(x);
//
// errors: returned codes, 0 none: nothing-there, already-there, not-a-name, refused, pending (a
// compute returns SC_PENDING), not-a-method, stop (return at once, result dropped), failed
// (api_why says why, good until the next call).
// api_node: a path or id, and a part. api_target: a path string or a node.
// memory: values given are held (op_ref) if kept, else the caller's; values given back are
// borrowed until the node changes (api_items, api_layers hold their own). api_node: the caller's,
// api_node_free. options.drop must be api_drop. patches borrowed for the call and copied.
// teardown: every process's scope, then its api (api_free), then api_context_free, then the
// scheduler.
// a teardown is told why (api_teardown): "replaced" (its owner ran again), the reason api_stop was
// given (a den's through its handle's stop_reason: runner-stopped, den-stopped, the caller's), else
// "ended". no runner here (a C program is native): a den's runner over this makes an api with
// api_new from the start's facts (dens.h's dn_starting) and gives api_stop the reason its handle is
// stopped with (dens_harness.c's teller).
// not yet (not in the suite): start, stop, openwith, box, async memos.
#ifndef API_H
#define API_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../../core/op/c/apply.h"
#include "../../../core/op/c/value.h"
#include "../../../core/scheduler/c/scheduler.h"
#include "../../../core/table/c/table.h"
#include "../../../filesystem/places/c/places.h"
#include "../../../filesystem/protect/c/protect.h"
#include "../../../extensions/patch-nodes/c/patch.h"
#include "../../sites/c/sites.h"

typedef enum {
	API_OK = 0,
	API_NOTHING_THERE,
	API_ALREADY_THERE,
	API_NOT_A_NAME,
	API_REFUSED,
	API_PENDING,
	API_NOT_A_METHOD,
	API_STOP,
	API_FAILED,
} api_code;
// "nothing-there", "already-there", "not-a-name", "refused", "pending", "not-a-method", "stop",
// "failed"; "" for 0
const char *api_code_name(int code);

// a process, as the host knows it: its id, where it is, its working folder, its arguments, its
// scope. borrowed: the host keeps them alive as long as its api
typedef struct {
	const char *id;
	const char *const *at;
	size_t nat;
	const char *const *cwd;
	size_t ncwd;
	const char *const *args;
	size_t nargs;
	sc_scope *scope;
} api_process;

typedef struct {
	sc_scheduler *scheduler;
	tb_table *table;
	// the host's places (root and all), over table (or over an overlay of it)
	pl *places;
	// the host's commit (an overlay's pn_commit); NULL: pl_commit on places
	void (*commit)(void *ctx, const pl_changed *changed);
	void *commit_ctx;
	// the host's stop of a process: its row out, its scope torn down (programs' stop). NULL (a den's
	// world): api_stop tells the teardowns only, the starter stops it
	void (*stop)(void *ctx, const api_process *p);
	void *stop_ctx;
	// what a send's scope holds beside the caller (the caller over it), keys unique: the host's
	// ("trusted-event"). NULL: none
	const sc_pair *(*info)(void *ctx, size_t *n);
	void *info_ctx;
	// the policy every process's reads and writes are asked of, from where it is; NULL: all allowed
	const pr_policy *may;
	// the overlay in front of places' table (patch nodes); NULL: patch, land and layers have none
	pn *overlay;
	// how the automatic pulse is asked for: f(data) run soon, once. NULL: run at once
	void (*schedule)(void *ctx, void (*f)(void *data), void *data);
	void *schedule_ctx;
	// a new node's id (copied); NULL: a uuidv7, time-ordered
	const char *(*id)(void *ctx);
	void *id_ctx;
	// where memos, effects and send's scopes are noted (ermine/sites); NULL: not noted. a memo's site
	// is the line that called api_memo (a macro), the program's
	st_sites *sites;
	// 1: no run records (runs.h) for its processes' computers, to save the memory (a small device);
	// 0, the default: kept, as always
	int no_runs;
} api_setup;

// the attribute a memo's or effect's node holds its scope in: the PL_NODE key's id of the nearest
// scope above it with one, written once as the node is made (beside status.h's and runs.h's). a
// memo or effect is made with {PL_NODE: its node's id}, so a header's metadata stops at it
#define API_SCOPE "ermine.computer.scope"

// the world every process's api shares (statuses, runs, methods, stop reasons): api.ts' context
typedef struct api_context api_context;
typedef struct api api;

api_context *api_context_new(const api_setup *setup);
void api_context_free(api_context *x);

// the scheduler's options.drop: lets go of a memo's or effect's result
void api_drop(void *value, void *data);

// a start's facts, what api_new is handed (@ermine/processes/start's Context): process borrowed,
// places NULL: the setup's
typedef struct {
	api_process process;
	pl *places;
} api_starting;
api *api_new(api_context *x, const api_starting *start);
// after its process's scope is gone
void api_free(api *a);

// a process stopped: its teardowns told why (borrowed for the call, held till then; NULL: "ended",
// or a why given before), then setup.stop (NULL: told only, its starter's stop under way)
void api_stop(api_context *x, const api_process *p, const op_value *why);

const char *api_why(const api *a);

// nodes and targets --------------------------------------------------------------------------

#define API_VALUE "value"
#define API_ATTRIBUTES "attributes"

// a node: walked to by its path at each use, or its id (a node with no place); part: the table read
// and written. path NULL and id set: no place; both set: nothing-there
typedef struct {
	char **path;
	size_t npath;
	char *id;
	const char *part;
} api_node;
void api_node_free(api_node *n);

// a target: a path string, or a node
typedef struct {
	const char *path;
	const api_node *node;
} api_target;
static inline api_target api_at(const char *path) { return (api_target){path, NULL}; }
static inline api_target api_of(const api_node *node) { return (api_target){NULL, node}; }

// the api -------------------------------------------------------------------------------------

// the node at at: made if nothing is there, with a value (the first only), folders on the way; no
// value (NULL): open only, nothing made
int api_open(api *a, const char *at, const op_value *value, api_node *out);
// a new node in folder, named by its own id
int api_create(api *a, const char *folder, const op_value *value, api_node *out);
// its value at path, tracked; *out NULL: nothing there
int api_read(api *a, api_target x, const op_key *path, size_t n, const op_value **out);
// api_read, untracked (a write there reruns nothing); a pending memo: *out NULL, 0
int api_peep(api *a, api_target x, const op_key *path, size_t n, const op_value **out);

// where a value a path holds is from (api.ts' From): the commit of the first item sync has there,
// or none listed, its entry's change (Shown); or another value sync has there (a conflict). a field
// not known: NULL, has_when 0
typedef struct {
	int conflict;
	// the commit's name (hex); NULL: an entry's change
	char *head;
	// actor (sync's may be null)
	op_value *who;
	int has_when;
	int64_t when;
	// external: sites as values, [{file, line, column?, function?}]
	op_value *where;
	// a conflict's: by, the sync engine (NULL for now: the sync process's id once sync is one);
	// signer hex; lamport; differs, the parts
	char *by;
	char *signer;
	int64_t lamport;
	char **differs;
	size_t ndiffers;
} api_from;
// one value a path holds (api.ts' Version). gone: a delete; inside: a write under it is not its own
typedef struct {
	op_value *value;
	api_from from;
	int gone;
	int inside;
} api_version;
typedef struct {
	api_version *items;
	size_t n;
} api_versions;
// every value at path, tracked: sync's items there (its "values" table at the id: the path's row,
// or the nearest open path's above it, each item's value at path). position 0 is api_read's (NULL
// too) from its item, else from its entry's change; then the rest, each from its commit. none: n 0
int api_reads(api *a, api_target x, const op_key *path, size_t n, api_versions *out);
void api_versions_free(api_versions *versions);

typedef struct {
	op_value *value;
	char *from;
	// NULL when refused
	char *id;
	int refused;
} api_item;
typedef struct {
	api_item *items;
	size_t n;
} api_items;
// every item at x (reads are lists); none: n 0
int api_entries(api *a, api_target x, api_items *out);
void api_items_free(api_items *items);

typedef struct {
	char **items;
	size_t n;
} api_names;
// the names under x, tracked
int api_list(api *a, api_target x, api_names *out);
void api_names_free(api_names *names);

// x's attributes, as a node
int api_info(api *a, api_target x, api_node *out);
// patches: one change on the part (none there: made). synced, it replaces what reads showed first
// at each path it writes
int api_edit(api *a, api_target x, const op_patch *patches, size_t n);
// api_edit's, its change saying what it replaces (metadata "replaces"): every value reads gives at
// each path it writes (which NULL: "all"), or the ones given (their heads; none with one: [])
int api_edits(api *a, api_target x, const op_patch *patches, size_t n, const api_version *which,
	size_t nwhich);

typedef struct api_watching api_watching;
// fn is told each write landing at x, as it lands; stopped by its scope's teardown
int api_watch(api *a, api_target x, void (*fn)(const pl_fact *fact, void *ctx), void *ctx,
	api_watching **out);

int api_place(api *a, const char *at, api_target x);
int api_unplace(api *a, const char *at);
int api_move(api *a, const char *from, const char *to);
// x unplaced, and its entries deleted
int api_remove(api *a, api_target x);

// a compute: previous is its last result. returns SC_VALUE (the result, an op_value the
// scheduler owns, NULL for none), SC_PENDING, or SC_FAILED; api_read's PENDING is SC_PENDING and
// its STOP is SC_VALUE with nothing
typedef sc_out (*api_compute)(api *a, const op_value *previous, void *ctx);
// an effect's act, after the round
typedef void (*api_act)(api *a, const op_value *value, const op_value *before, void *ctx);
typedef struct {
	bool (*equal)(const op_value *a, const op_value *b, void *ctx);
	void *equal_ctx;
} api_options;
// macros: the site noted (setup.sites) is the caller's line
// each is placed at name, its first argument (NULL: not-a-name); its id a new one. one alive there
// made in the same run (none: under the same scope): already-there. made again there by a later
// run of the same scope: the one there kept (sc_claim), given f, act, ctx and options, and run
// again into its node: the reference's rules (typescript/api.ts)
int api_memo_at(api *a, const char *name, api_compute f, void *ctx, const api_options *options,
	api_node *out, const char *file, int line, const char *func);
#define api_memo(...) api_memo_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
int api_effect_at(api *a, const char *name, api_compute f, api_act act, void *ctx,
	const api_options *options, api_node *out, const char *file, int line, const char *func);
#define api_effect(...) api_effect_at(__VA_ARGS__, __FILE__, __LINE__, __func__)
// an effect made early: its first run and act here, at once, then its act in the round's early
// queue, before the other effects'
int api_early_at(api *a, const char *name, api_compute f, api_act act, void *ctx,
	const api_options *options, api_node *out, const char *file, int line, const char *func);
#define api_early(...) api_early_at(__VA_ARGS__, __FILE__, __LINE__, __func__)

// a method: returns a code; *out its return (the caller's), maybe NULL
typedef int (*api_method_fn)(api *a, const op_value *const *args, size_t nargs, op_value **out,
	void *ctx);
int api_method(api *a, const char *at, api_method_fn fn, void *ctx, api_node *out);
// the method at x called, in a scope under the one open when it was made, with the caller's id and
// the host's info. *out its return (the caller's). a macro: the call scope's site is the caller's
int api_send_at(api *a, api_target x, const op_value *const *args, size_t nargs, op_value **out,
	const char *file, int line, const char *func);
#define api_send(...) api_send_at(__VA_ARGS__, __FILE__, __LINE__, __func__)

// why: borrowed for the call, a string "replaced" | "ended", or the reason api_stop was given
typedef void (*api_teardown_fn)(const op_value *why, void *ctx);
// fn as the scope open goes: replaced (a computer running again), the reason its process was stopped
// with (api_stop's why), else ended
int api_teardown(api *a, api_teardown_fn fn, void *ctx);
// the node at at, make() its value if nothing is there (the caller's, which this lets go of)
int api_ref(api *a, const char *at, op_value *(*make)(void *ctx), void *ctx, api_node *out);

// patch nodes. patches: the JSON form (patch.h), a list
int api_patch(api *a, const char *at, api_target over, const op_value *patches, api_node *out);
int api_land(api *a, api_target x);
typedef struct {
	op_value *value;
	char *from;
	int stale;
	char *error;
} api_layer;
typedef struct {
	api_layer *items;
	size_t n;
} api_layers;
int api_layers_of(api *a, api_target x, const op_key *path, size_t n, api_layers *out);
void api_layers_free(api_layers *layers);

// one pulse now
void api_pulse(api *a);

#endif
