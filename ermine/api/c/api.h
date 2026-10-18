// the process api (typescript/api.ts) in C: what a program is given. prefix api_. api.ts's header
// is the spec; ermine/api/conformance/api/ holds both to it.
//
//   api_apis *x = api_apis_new(&setup);            // once, by the host
//   api *a = api_new(x, &context);                 // one per process
//   api_node notes;
//   api_open(a, "./notes", value, &notes);
//   api_read(a, api_of(&notes), NULL, 0, &v);
//   api_node_free(&notes); api_free(a); api_apis_free(x);
//
// errors: returned codes, 0 none: nothing-there, already-there, not-a-name, refused, pending (a
// compute returns SC_PENDING), not-a-method, stop (return at once, result dropped), failed
// (api_why says why, good until the next call).
// api_node: a path or id, and a part. api_target: a path string or a node.
// memory: values given are held (op_ref) if kept, else the caller's; values given back are
// borrowed until the node changes (api_items, api_layers hold their own). api_node: the caller's,
// api_node_free. options.drop must be api_drop. patches borrowed for the call and copied.
// teardown: every process's scope, then api_apis_free, then the scheduler.
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
#include "../../../extensions/presence/c/presence.h"
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

typedef enum { API_ENDED, API_REPLACED } api_why_stopped;

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
	// the host's stop of a process: its row out, its scope torn down (programs' stop)
	void (*stop)(void *ctx, const api_process *p);
	void *stop_ctx;
	// what a send's scope holds beside the caller (the caller over it), keys unique: the host's
	// ("trusted-event"). NULL: none
	const sc_pair *(*info)(void *ctx, size_t *n);
	void *info_ctx;
	// the policy every process's reads and writes are asked of, from where it is; NULL: all allowed
	const pr_policy *may;
	// the host's presence world; NULL: present, absent and presence fail
	pres_world *presence;
	// who a process's presence row is, unless it says (the device); NULL: the process's id
	const char *who;
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
} api_setup;

// the attribute a memo's or effect's node holds its scope in: the PL_NODE key's id of the nearest
// scope above it with one, written once as the node is made (beside status.h's and runs.h's). a
// memo or effect is made with {PL_NODE: its node's id}, so a header's metadata stops at it
#define API_SCOPE "ermine.computer.scope"

typedef struct api_apis api_apis;
typedef struct api api;

api_apis *api_apis_new(const api_setup *setup);
void api_apis_free(api_apis *x);

// the scheduler's options.drop: lets go of a memo's or effect's result
void api_drop(void *value, void *data);

// a process's api: process borrowed, places NULL: the setup's
typedef struct {
	api_process process;
	pl *places;
} api_context;
api *api_new(api_apis *x, const api_context *context);
void api_free(api *a);

// a process stopped by the host: its teardowns told why. calls setup.stop
void api_stop(api_apis *x, const api_process *p, api_why_stopped why);

const char *api_why(const api *a);

// nodes and targets --------------------------------------------------------------------------

#define API_VALUE "value"
#define API_ATTRIBUTES "attributes"

// a node: walked to by its path at each use, or its id (a node with no place); part: the table read
// and written. path NULL and id set: no place
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
// patches: one change on the part (none there: made)
int api_edit(api *a, api_target x, const op_patch *patches, size_t n);

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

typedef void (*api_teardown_fn)(api_why_stopped why, void *ctx);
// fn as the scope open goes: ended (the process stopped), replaced (a computer running again)
int api_teardown(api *a, api_teardown_fn fn, void *ctx);
// the node at at, make() its value if nothing is there (the caller's, which this lets go of)
int api_ref(api *a, const char *at, op_value *(*make)(void *ctx), void *ctx, api_node *out);

// presence (the host's world)
int api_presence(api *a, api_target x, pres_lives *out);
typedef struct {
	// ms; 0: ten seconds
	int64_t ttl;
	const char *who;
} api_present;
int api_present_at(api *a, api_target x, const op_value *value, const api_present *options);
int api_absent(api *a, api_target x, const char *who);

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
