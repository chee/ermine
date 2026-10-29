// ermine (system/typescript: system/, ermine.ts, context.ts, calls.ts, features.ts,
// handles.ts, registry.ts), in C. prefix es_. the TypeScript is the reference; the suite,
// system/conformance/ermine/, holds both to it, on the line protocol of
// typescript/ermine_harness.ts (c/ermine_harness.c speaks it). the plan and the choices:
// ermine-plans/ermine/system-c-plan.org. this header is what the five files are written against.
//
//   es_options o = {.id = ids, .may = policy};
//   es_ermine *e;  es_create(&o, &e);                         // D
//   es_started *s;  es_start(e, setup, ctx, es_text("/work/clock"), NULL, &s, &no);
//   es_context *c = es_host_context(e);                       // process 0's
//   es_handle *n;  es_ensure_node(c, es_text("/a"), value, &n);
//   const op_value *v;  es_read(c, es_on_node(n), NULL, 0, &v);
//   es_close(e);
//
// THE FIVE FILES. each function is in exactly one; the sections below follow this order. the
// functions under a file are its to define, in full (a stub returns es_not_yet). the types, the
// macros and the inline helpers (es_alloc, es_map, es_live …) are the header's.
//
//   A nodes.c  contexts, handles, paths and seen, reads and writes of nodes
//     contexts (context.ts): es_context_new es_context_free es_resolve es_names_free es_within
//       es_inside es_owner es_context_write_at es_context_remove_at es_context_ask es_context_put
//       es_context_writer: where and as whom, and what a context does as itself
//     handles (handles.ts): es_mint es_handle_lookup es_handle_in es_handle_make es_handle_by_id
//       es_node_data_copy es_node_data_free: opaque, their data in the ermine's table
//     paths and seen (system/addressing.ts' up, seenIn): es_nodes_new es_nodes_free es_running_set
//       es_running_clear es_seen_in: a node's path from the root, up its names and through the
//       processes running
//     shared: es_node_of es_id_of es_id_through es_ask_placing es_place_under es_build
//       es_folder_slot: what the reads and writes, and B and D, are made from
//     reads: es_get_node es_has_node es_read es_read_attributes es_read_children es_read_all
//       es_read_all_attributes es_read_all_children es_read_entries es_peep es_list
//       es_get_args es_children_free es_versions_free es_items_free
//     writes: es_ensure_node_at es_create_node_at es_ref_at es_patch_at es_patch_attributes_at
//       es_patch_children_at es_place_at es_unplace_at es_rename_at es_remove_at, and the placement
//       asks (place on the slot, then read and edit of the node)
//
//   B computers.c  memos, effects, their nodes and names, status, runs
//     state: es_computers_new es_computers_free es_computer_forget
//     computers: es_create_memo_at es_create_effect_at ({ early }): the node at its name, claimed
//       again by its owner's next run, gone when not made again
//       an act makes nothing (es_not_in_act es_acting): its cleanup is es_cleanup's
//     known: es_is_computer es_is_memo es_computer_context es_awaiting
//     status and runs: es_get_status es_status_free es_latest_run: the base's status, then
//       features' (onStatus)
//
//   C actions.c  actions, the call frame, call records, getCaller, explain, teardowns, promises
//     state: es_actions_new es_actions_free es_is_action
//     actions: es_create_action_at es_execute_action_at es_get_caller es_caller_free
//       es_add_teardown: the call frame, waits, PENDING, the record, a promise's call lasting
//     explain and its views: es_explain es_explain_attributes es_explain_children es_explain_view
//       es_explained_free es_change_view_of es_view_change es_run_view_of es_call_view_of
//       es_run_view_free es_call_view_free es_show: the writer, the run view, the call view with
//       handles shown as paths
//     call records (calls.ts): es_calls_new es_calls_free es_calls_next es_calls_begin es_calls_end
//       es_calls_calling es_calls_open es_calls_read es_calls_made es_calls_latest
//       es_calls_drop es_calls_wait es_calls_answered es_calls_waits es_waits_free es_calls_stop
//     writers (system/process.ts createWriter): es_create_writer es_with_writer es_drop_writer es_cleanup
//     promises: es_promise_new es_promise_release es_promise_value es_promise_resolve
//       es_promise_reject es_promise_then
//
//   D host.c  createErmine and everything the host has
//     errors: es_fail es_fail_refusal es_fail_feature es_fail_text es_thrown es_clear_thrown
//       es_not_yet es_code_name es_out_code (written: what every stub returns)
//     lifecycle: es_create (in ermine.ts' order) es_close es_start es_start_in es_child_stop
//       es_child_status es_child_free es_refused_free es_stop
//       es_started_status es_started_free es_pulse
//     the host's side: es_host_context es_get_process_context es_handle_of es_data_of
//       es_records_run es_records_run_held es_records_call es_records_waits es_calling es_features
//     features: es_on_table es_on_read es_on_write es_on_teardown es_on_record es_on_status
//       es_api_places es_api_processes es_api_get_process_context es_api_handle_of es_api_data_of
//       es_api_seen es_reserve_slot es_slot_get es_slot_set es_next_table es_next_read
//       es_next_write es_next_teardown es_next_record es_next_status: installed needs first,
//       setup-only, the chains with next
//     what the other four call: es_hook_write es_hook_read es_hook_teardown es_hook_status
//       es_hook_record es_held_at es_held_status es_held_row es_held_drop es_header es_enter
//       es_alive es_queue_pulse es_new_id es_uuidv7 es_drop es_why_of
//     the registry: es_register_scope es_context_at es_found (nothing-open)
//
//   E ermine_harness.c  the line protocol of ermine_harness.ts: every op, the program steps and
//     forms, handles minted for the host's steps, logs, the test features (features_fixture.ts),
//     "plain" answers. hh_start hh_answer hh_finish (conformance/c/harness.h); defines nothing of
//     this header
//
// CODES, NOT EXCEPTIONS. a function that can fail returns int: 0, or an es_code, and then
// es_thrown() says what (the TypeScript's thrown value: its class, code and message). ES_PENDING
// is the scheduler's PENDING thrown, ES_STOP a track that must end the run now (sc_track's
// SC_STOP, pl_status): both carry no message; a compute returns at once on either. what a function
// gives back (*out) is set only on 0. a program's functions (below) give an es_out instead, and
// es_out_code turns a code into one. a result the TypeScript calls "none" (undefined): 0 and *out
// NULL; a function that cannot fail and may answer none returns 1 for found, 0 for none.
//
// THE FIRST ARGUMENT. every process api function is given the context it acts as: a process's
// (the program is given it, or finds it with es_found, as @ermine/system's imports do), or the
// host's (es_host_context). there is no api object.
//
// PROGRAMS. a program, a computer's function and an action's function are each a C function
// pointer and a ctx pointer: es_program, es_compute (+ es_act, es_equal), es_action. the harness'
// are the interpreted steps of a request; a native program is plain C. they are given their
// context, and nothing else of the api.
//
// LIVE VALUES. what a value cannot be (a node handle, a function placed as an action's value, a
// promise) is a stand-in (op_stand) whose kind is a map {"live": what, "at": the pointer's bytes}:
// es_live, es_live_of. never data: a sync that finds one finds a leaf. a handle in a value
// (an action's args, what it returned) is a stand-in of that kind; es_handle_in checks that it is
// one of this ermine's.
//
// LOCATIONS. a writing call is a macro over its _at, which takes the caller's line (CH_HERE); a
// write's frame is the one open (a run's, a setup's, a call's, a handler's), shared, never copied;
// from outside the graph (no run open, no frame up the chain holding locations) the line is a
// frame more on top, or in the info of what the call makes (a process, a computer, a call, a
// handler). the _at calls set it for their duration (es_enter).
//
// MEMORY. values given are borrowed for the call, and held (op_ref) by a callee that holds on to
// them. values given back are borrowed from the table, good until the node changes, unless the
// struct says they are its own (op_free them with it: es_*_free); a change's view too. what the
// reference keeps in WeakMaps goes, here, with what it is kept by [chee 10-26: "the C should
// "garbage collect" via something like a weakmap"]: a scope's info and records as the
// scheduler frees the scope (sc_on_free), a process's context with its scope, a view with its
// change, a promise once settled and let go of, an entry out of the table after the pulse. handles
// (one a name) and functions are the ermine's until es_close. strings in result structs are
// malloc'd, freed with the struct. out of memory aborts (es_alloc).
#ifndef ERMINE_SYSTEM_H
#define ERMINE_SYSTEM_H

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "../../graph/c/node.h"
#include "../../changeable/c/apply.h"
#include "../../changeable/c/value.h"
#include "../../processes/c/guard.h"
#include "../../places/c/places.h"
#include "../../processes/c/status.h"
#include "../../protect/c/protect.h"
#include "../../reactivity/c/paths.h"
#include "../../changeable/c/ptrmap.h"
#include "../../reactivity/c/scheduler.h"
#include "../../graph/c/table.h"
#include "../../processes/c/runs.h"
#include "../../processes/c/scopes.h"
#include "../../processes/c/start.h"

// --- codes and errors ------------------------------------------------------------------------

// places' codes keep their numbers. the rest follow the TypeScript's classes: Refusal, PENDING,
// SendError, FeatureError, ErmineError (features.ts' Code), and any other Error a program threw
typedef enum {
	ES_OK = 0,
	ES_NOT_A_NAME = PL_NOT_A_NAME,
	ES_NOTHING_THERE = PL_NOTHING_THERE,
	ES_ALREADY_THERE = PL_ALREADY_THERE,
	ES_REFUSED = 16,
	ES_PENDING,
	ES_STOP,
	ES_NOT_A_METHOD,
	ES_FEATURE,
	// any other Error: es_thrown()->message is its message
	ES_FAILED,
	// es_start: the path is taken (es_refused says more)
	ES_TAKEN,
	ES_MISSING_FEATURE,
	ES_FEATURE_TWICE,
	ES_NEEDS_LOOP,
	ES_SETUP_ONLY,
	ES_NOT_YET,
	ES_NOTHING_OPEN,
	ES_NOT_A_HANDLE,
	ES_NOT_A_VALUE,
	ES_NOT_PATCHES,
	ES_NOT_A_FUNCTION,
	ES_CLOSED,
	// something made, or a teardown added, in an effect's act (an act makes nothing)
	ES_IN_ACT,
	// an act gave back something that is no cleanup (C's acts give none: a harness's interpreted one can)
	ES_BAD_CLEANUP,
	// createWriter or start called where a process can't (a compute, an act)
	ES_NOT_HERE,
	// a writer called after its parent ended
	ES_GONE,
	// a writer called while a scope or run is open
	ES_ALREADY_INSIDE,
	// a memo, effect or pipe made outside its maker's own node (es_inside_only)
	ES_OUTSIDE,
} es_code;

// what was thrown last, by the function that last returned a code (one slot, single threaded).
// message: Error.message as the TypeScript has it ("nothing-open: patch: nothing is open here ...",
// "edit refused: denied", "nothing-there (n7)"). feature and hook: a Refusal a hook threw (the first
// to throw it), and a FeatureError's (cause: the message of what the hook threw). op and reason:
// a Refusal's
typedef struct {
	int code;
	char *message;
	char *op, *reason;
	char *feature, *hook;
	char *cause;
} es_error;

// --- small things every file uses ---------------------------------------------------------------

static inline void *es_alloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static inline char *es_dup(const char *s) { return strcpy(es_alloc(strlen(s) + 1), s); }
// room for one more item in a growing array: *items, *n used, *cap room
#define ES_PUSH(items, n, cap, item) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(items) = realloc((items), (cap) * sizeof *(items)); \
			if ((items) == NULL) abort(); \
		} \
		(items)[(n)++] = (item); \
	} while (0)

// a map from a string to a pointer, in the order added; a set is a map whose values are ignored. a
// zeroed map is empty. keys are copied. del moves the last item into the hole. for ids (the TypeScript's
// Map<Id, …> and Set<Id>); pm (ptrmap.h) is the one for addresses
typedef struct {
	char **keys;
	void **vals;
	size_t n, cap;
	// open addressing over keys: slot = position + 1, 0 empty, SIZE_MAX a gap
	size_t *slots;
	size_t nslots, used;
} es_map;

static inline size_t es_hash(const char *s) {
	uint64_t h = 14695981039346656037u;
	for (; *s; s++) h = (h ^ (unsigned char)*s) * 1099511628211u;
	return (size_t)h;
}
static inline void es_map_index(es_map *m) {
	free(m->slots);
	m->nslots = 16;
	while (m->nslots < m->n * 3) m->nslots *= 2;
	m->slots = es_alloc(m->nslots * sizeof *m->slots);
	m->used = m->n;
	for (size_t i = 0; i < m->n; i++) {
		size_t at = es_hash(m->keys[i]) & (m->nslots - 1);
		while (m->slots[at] != 0) at = (at + 1) & (m->nslots - 1);
		m->slots[at] = i + 1;
	}
}
// the slot holding key (and then *found), else the first free one for it
static inline size_t es_map_find(const es_map *m, const char *key, int *found) {
	*found = 0;
	if (m->nslots == 0) return 0;
	size_t at = es_hash(key) & (m->nslots - 1), gap = SIZE_MAX;
	while (m->slots[at] != 0) {
		size_t s = m->slots[at];
		if (s == SIZE_MAX) {
			if (gap == SIZE_MAX) gap = at;
		} else if (strcmp(m->keys[s - 1], key) == 0) {
			*found = 1;
			return at;
		}
		at = (at + 1) & (m->nslots - 1);
	}
	return gap != SIZE_MAX ? gap : at;
}
// the value at key; NULL when absent
static inline void *es_map_get(const es_map *m, const char *key) {
	int found;
	size_t at = es_map_find(m, key, &found);
	return found ? m->vals[m->slots[at] - 1] : NULL;
}
static inline int es_map_has(const es_map *m, const char *key) {
	int found;
	es_map_find(m, key, &found);
	return found;
}
// sets key (copied if new); 1 if it was new
static inline int es_map_set(es_map *m, const char *key, void *val) {
	int found;
	size_t at = es_map_find(m, key, &found);
	if (found) {
		m->vals[m->slots[at] - 1] = val;
		return 0;
	}
	if (m->n == m->cap) {
		m->cap = m->cap ? m->cap * 2 : 8;
		m->keys = realloc(m->keys, m->cap * sizeof *m->keys);
		m->vals = realloc(m->vals, m->cap * sizeof *m->vals);
		if (m->keys == NULL || m->vals == NULL) abort();
	}
	m->keys[m->n] = es_dup(key);
	m->vals[m->n++] = val;
	if (m->nslots == 0 || (m->used + 1) * 4 > m->nslots * 3) {
		es_map_index(m);
		return 1;
	}
	if (m->slots[at] == 0) m->used++;
	m->slots[at] = m->n;
	return 1;
}
// removes key; 1 if it was there
static inline int es_map_del(es_map *m, const char *key) {
	int found;
	size_t at = es_map_find(m, key, &found);
	if (!found) return 0;
	size_t i = m->slots[at] - 1;
	m->slots[at] = SIZE_MAX;
	free(m->keys[i]);
	if (i != m->n - 1) {
		m->keys[i] = m->keys[m->n - 1];
		m->vals[i] = m->vals[m->n - 1];
		size_t last = es_map_find(m, m->keys[i], &found);
		m->slots[last] = i + 1;
	}
	m->n--;
	return 1;
}
// walk: for (size_t i = 0; i < m->n; i++) m->keys[i], m->vals[i]. changing the map ends the walk
static inline void es_map_free(es_map *m) {
	for (size_t i = 0; i < m->n; i++) free(m->keys[i]);
	free(m->keys);
	free(m->vals);
	free(m->slots);
	*m = (es_map){0};
}

// --- paths and targets ---------------------------------------------------------------------------

// a path as a function is given it (the TypeScript's string | Path): its text ("./a/b", "../x",
// "/y", "name": a bare name is inside the process's node), or its steps. steps if text is NULL
typedef struct {
	const char *text;
	const char *const *steps;
	size_t nsteps;
} es_at;
static inline es_at es_text(const char *text) { return (es_at){text, NULL, 0}; }
static inline es_at es_steps(const char *const *steps, size_t n) { return (es_at){NULL, steps, n}; }

// a path resolved: names from the root, malloc'd
typedef struct {
	char **names;
	size_t n;
} es_names;

// a node handle: opaque. given only by the functions, or minted by the host (es_handle_of). its
// data is in its ermine's table, so a pointer of any other kind is no handle (ES_NOT_A_HANDLE)
typedef struct es_handle es_handle;

// what a function is aimed at (Target): a node handle, else a path
typedef struct {
	es_at at;
	const es_handle *node;
} es_target;
static inline es_target es_on_path(es_at at) { return (es_target){at, NULL}; }
static inline es_target es_on_node(const es_handle *h) { return (es_target){{NULL, NULL, 0}, h}; }

// what a handle reaches (NodeData): walked to by its path at each use (has_path), or its id (a node
// with no place); never both. part: the table read and written ("value", "attributes", "children",
// or a feature's own such as "patch"). the strings are its own
typedef struct {
	int has_path;
	char **path;
	size_t npath;
	char *id;
	char *part;
} es_node_data;

// a node a write is at (At): its id, and the path it was reached by when there is one
typedef struct {
	const char *id;
	int has_path;
	const char *const *path;
	size_t npath;
} es_aim;

// --- values a program makes or is given -------------------------------------------------------------

// what a program's function gives back, as sc_out does: a value (the receiver's to op_free, NULL for
// none), PENDING, a failure (error: its message, malloc'd, the receiver's), or a promise, which is
// a value (es_promise_value)
//
// a compute's function may also give ES_OUT_PAUSE (a generator that yielded a promise): value is the
// promise, step what goes on with it. next: given how the promise settled (ok: value, the step's to
// op_free; else error, malloc'd, its to free), it gives what the run comes to, any kind (PAUSE again
// too). quit: let go instead, once, when the computer ran again, is gone, or the ermine closes.
// exactly one of next and quit is called, once. computes only: the run goes on, the same run
struct es_out;
struct es_context;
typedef struct es_step {
	struct es_out (*next)(struct es_context *c, void *ctx, int ok, op_value *value, char *error);
	void (*quit)(void *ctx);
	void *ctx;
} es_step;
typedef enum { ES_OUT_VALUE, ES_OUT_PENDING, ES_OUT_FAILED, ES_OUT_PAUSE } es_out_kind;
typedef struct es_out {
	es_out_kind kind;
	op_value *value;
	char *error;
	es_step step;
} es_out;
static inline es_out es_out_of(op_value *v) { return (es_out){.kind = ES_OUT_VALUE, .value = v}; }
static inline es_out es_out_pending(void) { return (es_out){.kind = ES_OUT_PENDING}; }
static inline es_out es_out_failed(char *message) { return (es_out){.kind = ES_OUT_FAILED, .error = message}; }

typedef struct es_ermine es_ermine;
typedef struct es_context es_context;

// a program: the setup, run once with the process's scope open; what it gives is the process's value
typedef es_out (*es_program)(es_context *c, void *ctx);
// a computer's function: previous is its last result (NULL: none)
typedef es_out (*es_compute)(es_context *c, void *ctx, const op_value *previous);
// an effect's act, after the round: 0, or a code (it threw: the effect's status is failed, phase act)
typedef int (*es_act)(es_context *c, void *ctx, const op_value *value, const op_value *before);
// two results the same (NULL: identical, by pointer)
typedef int (*es_equal)(void *ctx, const op_value *a, const op_value *b);
// an action's function, the args borrowed for the call. c: the context its call frame is under (the
// one that placed it, not the caller's: the call frame is made alone, under the placer's)
typedef es_out (*es_action)(es_context *c, void *ctx, const op_value *const *args, size_t nargs);
// ref's maker: a new value, the receiver's
typedef op_value *(*es_make)(void *ctx);
// a teardown: why is "replaced", "ended", or the reason a stop was given
typedef void (*es_teardown)(void *ctx, const char *why);
// f run with something open or untracked (within, inside, peep): its code
typedef int (*es_thunk)(void *ctx);

// a function placed as an action's value (C allocates them, one per createAction)
typedef struct {
	es_action fn;
	void *ctx;
} es_function;

// stand-ins: what, and the pointer
static inline op_value *es_live(const char *what, const void *p) {
	op_value *kind = op_map();
	op_set(kind, "live", op_str(what));
	op_set(kind, "at", op_bytes(&p, sizeof p));
	return op_stand(kind);
}
// the pointer a stand-in of this kind holds; NULL: v is no such thing
static inline void *es_live_of(const op_value *v, const char *what) {
	if (v == NULL || v->type != OP_STAND || v->count != 1) return NULL;
	const op_value *kind = v->items[0];
	if (kind == NULL || kind->type != OP_MAP) return NULL;
	const op_value *w = op_get(kind, "live"), *at = op_get(kind, "at");
	if (w == NULL || w->type != OP_STR || strcmp(w->str, what) != 0) return NULL;
	if (at == NULL || at->type != OP_BYTES || at->bytes != sizeof(void *)) return NULL;
	void *p;
	memcpy(&p, at->data, sizeof p);
	return p;
}
static inline op_value *es_handle_value(const es_handle *h) { return es_live("handle", h); }
static inline op_value *es_function_value(const es_function *f) { return es_live("function", f); }
// a function placed as a value; NULL: v holds none
static inline es_function *es_function_of(const op_value *v) { return es_live_of(v, "function"); }

// a promise a program made, settled once; callbacks are called at once as it settles, in the order
// added (C has no microtask). a promise is a value: es_promise_value. the compute, action and program
// that gives one ends pending, and its settling is its result (B for computes, C for calls and
// processes' setups)
typedef struct es_promise es_promise;
// its stand-in: es_live's, and the promise's serial (a stand-in of one freed names no other)
op_value *es_promise_value(const es_promise *p);
// the promise a value is the stand-in of, when this ermine made it (es_promise_new); NULL: v is none,
// or a stand-in it did not make, which is data, as a handle it did not make is
es_promise *es_promise_of(es_ermine *e, const op_value *v);

// --- writes and contexts -------------------------------------------------------------------------------

// one write, every table write (Write): patches on (part, id), the path it was reached by when known
// (protect asks by it). header: the change as its writer made it, none: made from the scope open as
// it lands. gone: the entry taken out (no patches). features: the onWrite hooks that changed it,
// outermost first (a write a hook changed has one more frame on top, { ES_FEATURES }). borrowed
typedef struct {
	const char *part;
	const char *id;
	int has_path;
	const char *const *path;
	size_t npath;
	const op_patch *patches;
	size_t npatches;
	const ch_header *header;
	int gone;
	const char *const *features;
	size_t nfeatures;
} es_write;

// the info key the base sets in the frame it puts on a write a hook changed
#define ES_FEATURES "features"
// the attribute a memo's or effect's node holds its scope in: the PL_NODE key's id of the nearest
// scope above it with one, written once as the node is made
#define ES_SCOPE "ermine.computer.scope"
// what a pending process waits on, written by what started it
#define ES_WAITING "ermine.process.waiting"
// the host's node's attributes
#define ES_ARGS "ermine.host.args"
#define ES_FEATURES_ATTRIBUTE "ermine.features"

// a process context (ProcessContext) with its inner side (Inner): where and as whom a thing is done.
// the public fields first (features are given it: onWrite); the inner side is the functions'. one per
// process, one for the host (process 0). a process's lasts while its scope does: freed with it
// (torn down, held by nothing: es_started_free, and no record of it); the host's, and any
// not freed by es_close, till es_free. made by es_context_new
struct es_context {
	es_ermine *ermine;
	// public ----------------------------------------------------------------------------------
	sc_scope *scope;
	// the folder the process is in, its path (the host's: none), its args
	char **folder;
	size_t nfolder;
	char **at;
	size_t nat;
	char **args;
	size_t nargs;
	// NULL: the host's (process 0)
	pr_process *process;
	// inner -----------------------------------------------------------------------------------
	// the host's places; who it acts as: the process's node, or the host's; the policy is asked of it
	pl *places;
	// the box it is in: its places' root, when that is not the ermine's (NULL: the ermine's own); what
	// an ask from it says (from.box)
	char *box;
	char *node;
	int guarded;
	gd *guard;
	// what the functions keep per context (B's: the memos, effects and earlies its owners' runs made, by
	// name), and a peep going (>0: nothing read is tracked)
	void *named;
	int peeping;
};

// a context made: where it runs (the process's scope, places and paths), who it acts as
typedef struct {
	sc_scope *scope;
	pl *places;
	const char *const *folder;
	size_t nfolder;
	const char *const *at;
	size_t nat;
	const char *const *args;
	size_t nargs;
	pr_process *process;
	// the process's node id, or the host's
	const char *node;
} es_context_options;

// --- changes, reads, results ---------------------------------------------------------------------------------

// a change as a program sees it (ChangeView): when, who, and where it began (locations); one per change
// (the change is places' shared value, pl_change_value, by identity), made once; explain takes it
// back to its change. owned by the ermine
typedef struct es_change_view {
	const op_value *change;
	int64_t time;
	const op_value *actor;
	// the nearest locations up its frames, a list (borrowed from change); NULL: none
	const op_value *locations;
	// made through a writer that ran while the host said a person's event was going on
	int user_activated;
} es_change_view;

// where a value is from (From): the change it came from, by reference (change: places' value of it, as
// a hook is given it; view: as a program is given it, made from change), and for a feature's item what
// it says: kind, its name, and the rest of its fields (a map, or NULL). read's own has none of those
typedef struct {
	const op_value *change;
	const es_change_view *view;
	const char *kind;
	const char *feature;
	op_value *more;
} es_from;

// one value a path holds, and where it is from (Version). gone: a delete; inside: a write under it is not
// its own. held: a value made for it (a feature's), the version's own reference, let go with it
typedef struct {
	const op_value *value;
	es_from from;
	int gone, inside;
	op_value *held;
} es_version;
typedef struct {
	es_version *items;
	size_t n, cap;
} es_versions;

// one node a path reaches: its value, where it was found ("id", or the contributor's name), a handle to it
// (reached by this process's own path); refused by the policy: no value, no handle
typedef struct {
	const op_value *value;
	const char *from;
	es_handle *node;
	int refused;
} es_item;
typedef struct {
	es_item *items;
	size_t n;
} es_items;

// a folder's children, each a handle (readChildren): names and handles in the folder's order
typedef struct {
	char **names;
	es_handle **nodes;
	size_t n;
} es_children;

// what a pending one waits on (Waiting): a memo it read that is pending (its node by path, none: outside),
// a send to nothing (path, none: outside; since), a process's code not at its path yet (path), a
// promise, or nothing it says
typedef enum { ES_WAIT_NODE, ES_WAIT_SEND, ES_WAIT_CODE, ES_WAIT_PROMISE, ES_WAIT_PENDING } es_waiting_kind;
typedef struct {
	es_waiting_kind kind;
	int has_path;
	char **path;
	size_t npath;
	double since;
} es_waiting;

// status (Status). state: "done", "pending", "failed" or "looping". held: what it shows is so because a
// feature held a write back (held_write "status" or "row"). error: its message. phase: "run" or "act"
// (failed). n: a computer's latest run's. more: a feature's own fields (onStatus), a map or NULL
typedef struct {
	const char *state;
	int has_held;
	char *held_feature;
	const char *held_write;
	char *error;
	const char *phase;
	es_waiting *waiting;
	size_t nwaiting;
	int has_n;
	unsigned n;
	op_value *more;
} es_status;

// a record's read or write, as the process asking sees it (Touched)
typedef struct {
	char *part;
	int has_path;
	char **path;
	size_t npath;
} es_touched;
// a run's record, as a process sees it (RunView); act: CRN_ACT_*
typedef struct {
	unsigned n;
	int has_started;
	double started, ended;
	const char *end;
	char *error;
	int act;
	char *act_error;
	es_touched *reads;
	size_t nreads;
	es_touched *writes;
	size_t nwrites;
} es_run_view;
typedef struct {
	// "memo", "effect" or "early"
	const char *kind;
	int has_path;
	char **path;
	size_t npath;
} es_made_view;
// a call's record, as a process sees it (CallView): handles in args and returned are shown as the path
// they reach as this process sees it (a null: nothing reaches it), never as the handle (es_show)
typedef struct {
	unsigned n;
	op_value **args;
	size_t nargs;
	const char *end;
	int has_returned;
	op_value *returned;
	char *error;
	double started, ended;
	int has_ended;
	es_touched *reads;
	size_t nreads;
	es_touched *writes;
	size_t nwrites;
	es_made_view *made;
	size_t nmade;
} es_call_view;

// what made a change, one step (Writer). the protocol's names: "computer", "method", "outside"
typedef enum { ES_WRITER_COMPUTER, ES_WRITER_ACTION, ES_WRITER_OUTSIDE } es_writer_kind;
typedef struct {
	es_writer_kind kind;
	int has_path;
	char **path;
	size_t npath;
	// a computer's run, an action's call: its latest record, when that still holds the change; else NULL
	es_run_view *run;
	es_call_view *call;
	// outside: where it began, the nearest locations up its frames (borrowed from the change view); NULL: none
	const op_value *locations;
} es_writer;
// a change explained (Explained): it and its writer; held: the latest write there a feature held back
// (a node's only; with no change, only that)
typedef struct {
	const es_change_view *change;
	int has_writer;
	es_writer writer;
	int has_held;
	char *held_feature;
} es_explained;

// who called the action running now (Caller): the actor its writes carry, and its process's node by path
// as the action sees it (has_process 0: nothing reaches it, or the host)
typedef struct {
	const op_value *actor;
	int has_process;
	es_names process;
} es_caller;

// --- the call records (calls.ts) ----------------------------------------------------------------------------------

typedef struct {
	const char *kind;
	char *id;
	char **path;
	size_t npath;
} es_made;
typedef struct {
	char *part, *id;
	op_key *path;
	size_t npath;
	int has_path, keys;
	op_value *change;
} es_call_read;
typedef struct {
	char *part, *id;
	op_value *change;
} es_call_write;

// a call's record: the latest per handler (older ones history's, through onRecord). caller: the
// sending process's id, the host's node's for the host's; context: the caller's (what a service
// acting for its caller resolves paths in and asks protect as); handler: its node, and its value's
// change as called; args: as given, held; end: "done", "failed" or "pending"; error: its message;
// started, ended: ms since 1970
typedef struct {
	unsigned n;
	char *caller;
	es_context *context;
	char *handler;
	op_value *handler_change;
	op_value **args;
	size_t nargs;
	const char *end;
	int has_returned;
	op_value *returned;
	char *error;
	double started, ended;
	int has_ended;
	es_call_read *reads;
	size_t nreads;
	es_call_write *writes;
	size_t nwrites;
	es_made *made;
	size_t nmade;
	// the call's frame (held): its info { caller, handler, call }, with locations when called from
	// outside the graph, under the handler's or the scope it ran in
	ch_frame *frame;
} es_call;

// a send to a node holding nothing, waiting: the caller, the path or id, since
typedef struct {
	char *caller;
	int has_path;
	char **path;
	size_t npath;
	char *id;
	double since;
} es_wait;

// a call going: its record so far (calls.ts' Going), C's. run: the run open as it began
typedef struct es_going es_going;

// what calling() gives: a call going, its record so far (Omit<Call, end, reads, writes, made, ended>)
typedef struct {
	unsigned n;
	const char *caller;
	es_context *context;
	const char *handler;
	const op_value *handler_change;
	const op_value *const *args;
	size_t nargs;
	double started;
} es_calling_view;

// --- features and their hooks (features.ts) -----------------------------------------------------------------------

typedef enum { ES_ON_TABLE, ES_ON_READ, ES_ON_WRITE, ES_ON_TEARDOWN, ES_ON_RECORD, ES_ON_STATUS, ES_HOOKS } es_hook;

// a layer over the table places reads (Layer): the table it gives places, and where table events and
// commits go first. the raw table's events go to the first layer's; each layer's on to the next
typedef struct {
	tb_table *front;
	tb_event event;
	void (*commit)(void *ctx, const pl_changed *changed);
	void *ctx;
} es_layer;
// what onTable is given (Under): the table under it, and where its own events and commits go on to
// (what is in front of the layer it gives, or places)
typedef struct {
	tb_table *table;
	tb_event ahead_event;
	void (*ahead_commit)(void *ctx, const pl_changed *changed);
	void *ahead_ctx;
} es_under;

// the node reads is reading, and who reads it (Reading); asked: the node status is asked of (Asked)
typedef struct {
	const es_node_data *node;
	const char *part;
	const char *id;
	const op_key *path;
	size_t npath;
	es_context *context;
} es_reading;
typedef struct {
	const es_node_data *node;
	const char *id;
} es_asked;
// a record as it is written (Recorded): a run, or a call, by its node's id. run: runs.h's
typedef struct {
	const char *id;
	const crn_run *run;
	const es_call *call;
	// a run whose status write was held back: the feature
	const char *held;
} es_recorded;

// the continuation of a hook: what is after it in its chain, the base last. not calling it: what the
// hook guards does not happen. each is called with the hook's own arguments, as given or changed
typedef struct es_table_next es_table_next;
typedef struct es_read_next es_read_next;
typedef struct es_write_next es_write_next;
typedef struct es_teardown_next es_teardown_next;
typedef struct es_record_next es_record_next;
typedef struct es_status_next es_status_next;
int es_next_table(es_table_next *next, const es_under *under, es_layer *out);
int es_next_read(es_read_next *next, const es_reading *x, const es_versions *items, es_versions *out);
int es_next_write(es_write_next *next, es_context *o, const es_write *w);
int es_next_teardown(es_teardown_next *next, sc_scope *scope, const char *why);
int es_next_record(es_record_next *next, const es_recorded *r);
int es_next_status(es_status_next *next, const es_asked *x, const es_status *st, es_status *out);

// the hooks: middleware with next, every one. each returns 0, or a code (it threw): a code is
// rethrown as a FeatureError naming the feature and hook, except ES_PENDING, ES_STOP, a FeatureError,
// and what next gave (a hook that returns next's code passes it as it is), and a Refusal, which gets
// its feature and hook named. onTable: *out is the layer it gives. onRead: *out the items it shows.
// onStatus: *out the status. ctx: the one given at registration
typedef int (*es_on_table_fn)(void *ctx, const es_under *under, es_table_next *next, es_layer *out);
typedef int (*es_on_read_fn)(void *ctx, const es_reading *x, const es_versions *items,
	es_read_next *next, es_versions *out);
typedef int (*es_on_write_fn)(void *ctx, es_context *o, const es_write *w, es_write_next *next);
typedef int (*es_on_teardown_fn)(void *ctx, sc_scope *scope, const char *why, es_teardown_next *next);
typedef int (*es_on_record_fn)(void *ctx, const es_recorded *r, es_record_next *next);
typedef int (*es_on_status_fn)(void *ctx, const es_asked *x, const es_status *st,
	es_status_next *next, es_status *out);

// what a feature acts with, in its setup (and, once es_create has returned, in its hooks): hooks are
// setup-only (ES_SETUP_ONLY); places, processes, the contexts, handles and seen are made after setup
// (ES_NOT_YET before). scheduler is the scheduler as features see it: its on… listeners are taken
// out at close
typedef struct es_feature_api {
	sc_scheduler *scheduler;
	tb_table *table;
	// D's
	void *private_;
} es_feature_api;
int es_on_table(es_feature_api *f, es_on_table_fn fn, void *ctx);
int es_on_read(es_feature_api *f, es_on_read_fn fn, void *ctx);
int es_on_write(es_feature_api *f, es_on_write_fn fn, void *ctx);
int es_on_teardown(es_feature_api *f, es_on_teardown_fn fn, void *ctx);
int es_on_record(es_feature_api *f, es_on_record_fn fn, void *ctx);
int es_on_status(es_feature_api *f, es_on_status_fn fn, void *ctx);
int es_api_places(es_feature_api *f, pl **out);
int es_api_processes(es_feature_api *f, pr **out);
// the host's context (process NULL), or a running process's (NULL out: stopped, or not this ermine's)
int es_api_get_process_context(es_feature_api *f, pr_process *process, es_context **out);
int es_api_handle_of(es_feature_api *f, const es_node_data *node, es_handle **out);
// 1 and *node: a handle of this ermine's; 0: none
int es_api_data_of(es_feature_api *f, const void *x, es_node_data *node);
// a node's path as context's process sees it (has_path 0: nothing reaches it, moved, or placed by no names)
int es_api_seen(es_feature_api *f, const char *id, es_context *context, es_names *out);
// 0 and *out when the node is reached from the root; ES_NOTHING_THERE (out empty) when nothing is
// (the root is a path of no names: tell them apart by the code)
// a listener a feature added to the scheduler (sc_on_…), taken away at es_close as ermine's own are
int es_listened(es_feature_api *f, sc_listener *l);

// per-process state only the feature that reserved it reaches, by context
typedef struct es_slot es_slot;
int es_reserve_slot(es_feature_api *f, es_slot **out);
int es_slot_get(const es_slot *s, es_context *c, long *out);
void es_slot_set(es_slot *s, es_context *c, long value);

// a feature (Feature): its name, the files the sites skip (listed only: sites are explicit in C),
// the names it needs (set up first), and its setup
typedef struct {
	const char *name;
	const char *const *files;
	size_t nfiles;
	const char *const *needs;
	size_t nneeds;
	int (*setup)(void *ctx, es_feature_api *f);
	void *ctx;
} es_feature;
// what es_features shows: each feature's name, its needs and its hooks, in chain order (Shown)
typedef struct {
	char *name;
	char **needs;
	size_t nneeds;
	es_hook *hooks;
	size_t nhooks;
} es_shown;

// --- the ermine ------------------------------------------------------------------------------------------------------------

// what onCreateFunction is told: kind ("memo", "effect", "action"), the computer (NULL for an action),
// its node, and who made it (the process's id, or the host's node's)
typedef struct {
	const char *kind;
	sc_computer *computer;
	const es_node_data *node;
	const char *id;
	const char *process;
} es_created;

// createErmine's options (Options), each with a default
typedef struct {
	const es_feature *const *features;
	size_t nfeatures;
	// NULL: a new one. one given must have es_drop as its options.drop
	sc_scheduler *scheduler;
	// a new node's id, processes' too, malloc'd; NULL: uuidv7 (nodes), proc:<boot>-<n> (processes)
	char *(*id)(void *ctx);
	void *id_ctx;
	// the policy every read and write is asked of; NULL: all allowed. not freed
	const pr_policy *may;
	// how a pulse is asked for: f(data) run soon, once; NULL: run at once
	void (*schedule)(void *ctx, void (*f)(void *data), void *data);
	void *schedule_ctx;
	void (*on_create_function)(void *ctx, const es_created *made);
	void *on_create_function_ctx;
	// the root's id; NULL: a new one
	const char *root;
	// the host's node: where it is placed (NULL: nowhere), the host's args
	// (NULL: none)
	struct {
		const char *at;
		const char *const *args;
		size_t nargs;
	} host;
	// the host's scope's info (actor, …), beside its node: values are op_values, held by the caller
	const sc_pair *info;
	size_t ninfo;
	// 1: call records not held (onRecord is still told)
	int calls_never;
	// whether a person just interacted with the page now (a writer asks as it runs: its changes
	// say userActivated). NULL: never. the host says; the ermine does not look
	int (*user_activated)(void *ctx);
	void *user_activated_ctx;
} es_options;

// the base: everything one ermine's contexts share (Base and Parts, and createErmine's closure). made
// by es_create (D); the other four keep their state in the pointers at the end
struct es_ermine {
	int closed;
	sc_scheduler *scheduler;
	// the table written to, and what places reads (the frontmost layer's, else the same)
	tb_table *table;
	tb_table *front;
	pt_paths *paths;
	pl *places;
	sn *scopes;
	cst *statuses;
	crn *runs;
	pr *processes;
	const pr_policy *may;
	char *root;
	// the host's node, scope and context
	char *node;
	sc_scope *host_scope;
	es_context *host_context;
	char *(*id)(void *ctx);
	void *id_ctx;
	void (*on_create_function)(void *ctx, const es_created *made);
	void *on_create_function_ctx;
	int (*user_activated)(void *ctx);
	void *user_activated_ctx;
	// the location of the call in progress (es_enter), for a write's header made from outside
	const ch_location *site;
	// every handle, by address → its es_handle_data (A's); handles last till es_close, one a name
	// (es_mint)
	pm handles;
	// why a process is stopping, by its node's id (strings), said by stop before its scope goes
	es_map whys;
	// state of the files: A's, B's, C's and D's own
	struct es_nodes *nodes;
	struct es_computers *computers;
	struct es_calls *calls;
	struct es_actions *actions;
	struct es_hosting *hosting;
};

// start's options (StartOptions): args (has_args 0: none); places: the places the process lives in, a view
// of this ermine's (pl_view): its "/" and its rows are that view's root, and what it starts is in it
// too (NULL: the ermine's own)
typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	pl *places;
} es_start_options;
// a process started
typedef struct {
	es_ermine *ermine;
	pr_process *process;
} es_started;
// start refused (Refused, + held): "taken" or a name code, and the path; held: a stopped process's row a
// feature held back is what it is taken by
typedef struct {
	const char *refused;
	char **at;
	size_t nat;
	int has_held;
	char *held_process, *held_feature;
} es_refused;

// a held write (Held): the feature, and what shows it ("status" or "row")
typedef struct {
	const char *feature;
	const char *write;
} es_held;

// --- A: nodes.c -------------------------------------------------------------------------------------------------------------

// its state (the processes running, by node: where seen finds them), made by es_create, let go at close
struct es_nodes *es_nodes_new(es_ermine *e);
void es_nodes_free(struct es_nodes *x);
// a context made. its scope, places and paths copied; the guard made when the ermine has a policy
es_context *es_context_new(es_ermine *e, const es_context_options *o);
void es_context_free(es_context *c);
// p resolved: bare, inside at; ./ and ../ from folder; / the root; above "/": ES_NOTHING_THERE
int es_resolve(es_context *c, es_at p, es_names *out);
void es_names_free(es_names *names);
// f with c's scope open (explicit: for the host's and features' code); f's code
int es_within(es_context *c, es_thunk f, void *ctx);
// f with a scope open: the one open, else the fallen scope (a process's: ES_NOTHING_OPEN; the host's:
// its own scope)
int es_inside(es_context *c, es_thunk f, void *ctx);
// the scope what is made now belongs to: the scope open; else the context's
sc_scope *es_owner(es_context *c);
// the frame open now (a call's, a writer's run's, or the scope open's own), else the context's
// scope's own: the info a write carries is found from it
ch_frame *es_open_frame(es_context *c);
// asked as c "place" on the slot of the name last in path (npath names), in the folder parent
int es_ask_slot(es_context *c, const char *parent, const char *const *path, size_t npath);
// one write at a node (its id, and the path it was reached by), asked "edit" on it, through onWrite,
// committed, a pulse asked for. remove: the entry taken out, asked "edit" as write is
int es_context_write_at(es_context *c, const char *part, const es_aim *at, const op_patch *patches,
	size_t n, const ch_location *site);
int es_context_remove_at(es_context *c, const char *part, const es_aim *at, const ch_location *site);
#define es_context_write(...) es_context_write_at(__VA_ARGS__, CH_HERE)
#define es_context_remove(...) es_context_remove_at(__VA_ARGS__, CH_HERE)
// protect asked (the host's may; none: all allowed): ES_REFUSED, ES_PENDING or 0
int es_context_ask(es_context *c, const char *op, const gd_target *targets, size_t n);
// one write, unasked (a memo's own, an action's after its ask), through onWrite
int es_context_put(es_context *c, const es_write *w);
// the same, as places' Writer: for the libraries that write for this context
void es_context_writer(es_context *c, const char *part, tb_key id, const op_patch *patches, size_t n,
	const ch_header *header);

// handles: a new one for node (data copied). a handle is a name, not power: its path is from the
// ermine's root (or an id), and it holds no maker [chee 10-26: "take the maker out now"]
es_handle *es_mint(es_ermine *e, const es_node_data *node);
// what a handle reaches; NULL: no handle of this ermine's. good till es_close
typedef struct {
	es_node_data node;
} es_handle_data;
const es_handle_data *es_handle_lookup(es_ermine *e, const void *h);
// the handle a value holds, if it is a stand-in of one of this ermine's; NULL: none
es_handle *es_handle_in(es_ermine *e, const op_value *v);
// a handle for n; and for the node at id
es_handle *es_handle_make(es_context *c, const es_node_data *n);
es_handle *es_handle_by_id(es_context *c, const char *id, const char *part);
// the id a handle reaches, walked from the root (a path is from it); 1 and *out, 0: nothing there
int es_handle_id(es_ermine *e, const es_node_data *n, const char **out);
es_node_data es_node_data_copy(const es_node_data *n);
void es_node_data_free(es_node_data *n);

// a process's node, where it runs: its path from the root (its row names it, not a children entry,
// so places' names_of has not): seen's
void es_running_set(es_ermine *e, const char *process, const char *const *at, size_t nat);
void es_running_clear(es_ermine *e, const char *process);
// id's path from the root: up its names, then walked down (tracked). 1 and *out; 0: nothing
// reaches it
int es_seen_in(es_ermine *e, es_context *reader, const char *id, es_names *out);

// what the functions share. x resolved to what it reaches as c reaches it (nodeOf): a path resolved
// by c; a handle's place (its path from the root) or its id; ES_NOT_A_HANDLE for an object no handle
int es_node_of(es_context *c, es_target x, es_node_data *out);
// the id n reaches in c's places; 1 and *out, 0: nothing there
int es_id_of(es_context *c, const es_node_data *n, const char **out);
// x's id, as c reaches it; ES_NOTHING_THERE. *out is malloc'd: the caller's
int es_id_through(es_context *c, es_target x, char **out);
// a node already there given a name in a folder: asked as c "place" of the slot with the node
// beside, then read and edit of the node (an action's: execute too)
int es_ask_placing(es_context *c, const gd_target *slot, es_target x, const char *id);
// id placed under name in the folder parent (at path, its name the last), its children entry made
// when it has none
int es_place_under(es_context *c, const char *parent, const char *name, const char *id,
	const char *const *path, size_t npath);
// a node at path holding value (NULL: nothing in it), the nodes on the way made; its id (given, else
// new), malloc'd
int es_build(es_context *c, const char *const *path, size_t npath, const op_value *value,
	const char *given, char **id);
// the children entry of the folder a path is in, and the name; ES_NOTHING_THERE
int es_folder_slot(es_context *c, const char *const *path, size_t npath, nd_entry **children,
	const char **name);

// what a reader waits on, the nodes it read that were not there (base.missing): by the reader (a
// computer's node, in which run: n; else the context's node), the paths from the root. a read of a node
// not there is ES_PENDING, tracked, with this held; a status shows each as the reader's path
typedef struct {
	int has_n;
	unsigned n;
	es_names *paths;
	size_t npaths;
	// the paths as text, each once (a set of keys; the values are not used)
	es_map keys;
} es_missing;
// the reader's, borrowed; NULL: none. held only where it is shown: a computer's, for its latest run
// (gone with it: es_missing_drop), and a process's while its setup runs (es_setting); a read anywhere
// else holds nothing
const es_missing *es_missing_of(es_ermine *e, const char *id);
void es_missing_drop(es_ermine *e, const char *id);
// process's setup is running (1) or has ended (0, its entry let go)
void es_setting(es_ermine *e, const char *process, int running);
// reads. paths: a bare name inside the process's node (the host's: the root), ./ its folder, ../ above, /
// the root. a pending memo with no value: ES_PENDING
int es_get_node(es_context *c, es_at p, es_handle **out);
int es_has_node(es_context *c, es_target x, int *out);
int es_read(es_context *c, es_target x, const op_key *key, size_t nkey, const op_value **out);
int es_read_attributes(es_context *c, es_target x, const op_key *key, size_t nkey,
	const op_value **out);
int es_read_children(es_context *c, es_target x, es_children *out);
int es_read_all(es_context *c, es_target x, const op_key *key, size_t nkey, es_versions *out);
int es_read_all_attributes(es_context *c, es_target x, const op_key *key, size_t nkey,
	es_versions *out);
int es_read_all_children(es_context *c, es_target x, es_versions *out);
int es_read_entries(es_context *c, es_target x, es_items *out);
// f with nothing it reads tracked; a pending memo it reads is none, not ES_PENDING
int es_peep(es_context *c, es_thunk f, void *ctx);
int es_list(es_context *c, es_target x, es_names *out);
const char *const *es_get_args(es_context *c, size_t *n);
void es_children_free(es_children *c);
void es_versions_free(es_versions *v);
void es_items_free(es_items *i);

// writes (each a macro over its _at: the caller's line is the write's site). patches only
int es_ensure_node_at(es_context *c, es_at p, const op_value *value, es_handle **out,
	const ch_location *site);
int es_create_node_at(es_context *c, es_at folder, const op_value *value, es_handle **out,
	const ch_location *site);
int es_ref_at(es_context *c, es_at p, es_make make, void *ctx, es_handle **out,
	const ch_location *site);
int es_patch_at(es_context *c, es_target x, const op_patch *patches, size_t n, const ch_location *site);
int es_patch_attributes_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_location *site);
// one name a patch: { path: [name], value: node } placing it there, { path: [name] } unplacing it;
// anything else ES_NOT_PATCHES. node is an op_value holding a handle, or a string path
int es_patch_children_at(es_context *c, es_target x, const op_patch *patches, size_t n,
	const ch_location *site);
int es_place_at(es_context *c, es_at p, es_target x, const ch_location *site);
int es_unplace_at(es_context *c, es_at p, const ch_location *site);
int es_rename_at(es_context *c, es_at from, es_at to, const ch_location *site);
// the host's only: x unplaced and its entries deleted
int es_remove_at(es_context *c, es_target x, const ch_location *site);
#define es_ensure_node(...) es_ensure_node_at(__VA_ARGS__, CH_HERE)
#define es_create_node(...) es_create_node_at(__VA_ARGS__, CH_HERE)
#define es_ref(...) es_ref_at(__VA_ARGS__, CH_HERE)
#define es_patch(...) es_patch_at(__VA_ARGS__, CH_HERE)
#define es_patch_attributes(...) es_patch_attributes_at(__VA_ARGS__, CH_HERE)
#define es_patch_children(...) es_patch_children_at(__VA_ARGS__, CH_HERE)
#define es_place(...) es_place_at(__VA_ARGS__, CH_HERE)
#define es_unplace(...) es_unplace_at(__VA_ARGS__, CH_HERE)
#define es_rename(...) es_rename_at(__VA_ARGS__, CH_HERE)
#define es_remove(...) es_remove_at(__VA_ARGS__, CH_HERE)

// --- B: computers.c ------------------------------------------------------------------------------------------------------------

// its state (the memos, effects, their nodes, contexts and promises out): made by es_create, let go at close
struct es_computers *es_computers_new(es_ermine *e);
void es_computers_free(struct es_computers *x);
// c's names for what its owners' runs made, let go with c (es_context_free calls it)
void es_computer_forget(es_context *c);

// options of a memo or effect: equal (NULL: identical), early (effects only: run and acted at once,
// and later acted before other effects')
typedef struct {
	es_equal equal;
	void *equal_ctx;
	int early;
} es_computed_options;
// a compute at its own node at name: its result, status and latest run. made again by its owner's next
// run: the same node, the new f. a name not made again goes after the run. a second at a name in one run:
// ES_ALREADY_THERE. f giving a promise ends the run pending till it settles
int es_create_memo_at(es_context *c, es_at name, es_compute f, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_location *site);
int es_create_effect_at(es_context *c, es_at name, es_compute f, es_act act, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_location *site);
#define es_create_memo(...) es_create_memo_at(__VA_ARGS__, CH_HERE)
#define es_create_effect(...) es_create_effect_at(__VA_ARGS__, CH_HERE)
// an effect's act makes nothing: ES_IN_ACT when own is the scope an act is running in. fn names what was
// called (createMemo, createEffect, createAction, addTeardown)
int es_not_in_act(es_ermine *e, sc_scope *own, const char *fn);
// a memo, effect or pipe is made inside its maker's node (a process's, by a bare name; the host's is
// the root), never beside or above it, where it would outlive its maker with no context of its own
// to run as [chee 10-28: "maybe subcomputations can't live alone but subprocesses can?"]:
// ES_OUTSIDE otherwise. path: where it would be; fn names what was called
int es_inside_only(es_context *c, const es_names *path, const char *fn);
// the scope an effect's act is running in now; NULL: none
sc_scope *es_acting(es_ermine *e);
// what is known of a node: a memo or effect's; a memo's (a read of one pending with no value is ES_PENDING);
// the context that made a computer; its latest run gave a promise not settled yet
int es_is_computer(es_ermine *e, const char *id);
int es_is_memo(es_ermine *e, const char *id);
es_context *es_computer_context(es_ermine *e, const char *id);
int es_awaiting(es_ermine *e, const char *id);
// status: the base's, then what features show (onStatus). x not there: 0 and *out has no state (NULL)
int es_get_status(es_context *c, es_target x, es_status *out);
// es_get_status, key the field wanted ("state", "error", "phase", "waiting", "n"; NULL: all): the
// base reads only what that field takes, so a reader of it is told only when it may change. *out
// holds that field, state with it
int es_get_status_of(es_context *c, es_target x, const char *key, es_status *out);
void es_status_free(es_status *s);
// a computer's latest run (tracked); 1 and *out, 0: none. borrowed from runs.h
int es_latest_run(es_ermine *e, const char *id, const crn_run **out);

// --- C: actions.c ---------------------------------------------------------------------------------------------------------------

struct es_actions *es_actions_new(es_ermine *e);
void es_actions_free(struct es_actions *x);
// whether the node holds a function an action's owner placed (the placement's scope is still there)
int es_is_action(es_ermine *e, const char *id);
// a value at a node going (written over or taken out): held is what es_action_held gave before, the
// action's record let go unless now (the value after, NULL: none) is still its stand-in
void *es_action_held(es_ermine *e, const op_value *was);
void es_action_let_go(es_ermine *e, void *held, const op_value *now);

// fn as the value of the node at p, run by es_execute_action in a call frame under the owner's (the
// one open). placed again by the same owner: the node as it is, the new fn. gone with the owner
int es_create_action_at(es_context *c, es_at p, es_action fn, void *ctx, es_handle **out,
	const ch_location *site);
// the action at x called with args, in a call frame { caller: { node, actor }, handler, call }. its
// return in *out (a promise is a value: the call lasts till it settles), the caller's to op_free
// (NULL: none). nothing
// there: a wait recorded, ES_PENDING (a memo or effect running it reruns when the action comes). a
// value no function: ES_NOT_A_METHOD
int es_execute_action_at(es_context *c, es_target x, const op_value *const *args, size_t nargs,
	op_value **out, const ch_location *site);
#define es_create_action(...) es_create_action_at(__VA_ARGS__, CH_HERE)
#define es_execute_action(...) es_execute_action_at(__VA_ARGS__, CH_HERE)
// in an action: who called it. 1 and *out, 0: not in one
int es_get_caller(es_context *c, es_caller *out);
// where the open call's caller is placed, as guard's caller hook has it (ctx: the context asking): the
// nearest call frame's caller node, a process's at, the host's none. 1 and *from, *nfrom
// (*from NULL: the host); 0: no call open. *box is core's hook's, never set here. the path is
// the caller's context's own
int es_caller_place(void *ctx, const char *const **from, size_t *nfrom, tb_key *box);
void es_caller_free(es_caller *c);
// fn as the scope open goes (through onTeardown): why "replaced" (the owner ran again), "ended", or the
// reason a stop was given
int es_add_teardown(es_context *c, es_teardown fn, void *ctx);
// in an effect's act: fn(why) as the effect goes, and before its next act (the TypeScript's act returns
// its cleanup; C's calls this). ES_NOT_HERE out of an act
int es_cleanup(es_context *c, es_teardown fn, void *ctx);

// createWriter: in setup or an action (not a memo, an effect or an act: ES_NOT_HERE), a writer for code that
// runs with nothing open (a timer, a listener, a promise settling). *writer is a stand-in (a value,
// never data), the caller's to op_free; it is good while c's owner is alive, then es_with_writer says
// ES_GONE. what it runs is the owner's: it asks as it, makes what it makes the owner's, and its writes
// carry the mark es_create_writer was called under (an action's call: call, handler, caller). while the host says a person just interacted
// (options.user_activated) they say so
int es_create_writer_at(es_context *c, op_value **writer, const ch_location *site);
#define es_create_writer(...) es_create_writer_at(__VA_ARGS__, CH_HERE)
// f as the writer's owner, with nothing open, each write at the writer's site. ES_ALREADY_INSIDE with a scope or
// run open; ES_GONE after the owner ended; f's code
int es_with_writer(es_ermine *e, const op_value *writer, es_thunk f, void *ctx);
// the program is done with a writer (a timer that fired, a listener taken off): its memory goes now, not
// when its owner does. a writer made once in setup need not be; one made in an action called again
// and again should be. a stand-in of one let go of is gone
void es_drop_writer(es_ermine *e, const op_value *writer);

// who made the change at x (a node's part), one step: tracked. 0 with *out NULL: nothing there.
// key is the field read
int es_explain(es_context *c, es_target x, const op_key *key, size_t nkey, es_explained **out);
int es_explain_attributes(es_context *c, es_target x, es_explained **out);
int es_explain_children(es_context *c, es_target x, es_explained **out);
// the same, for a change a program was shown (a read's from.view)
int es_explain_view(es_context *c, const es_change_view *v, es_explained **out);
void es_explained_free(es_explained *x);
// a change's view, made once (held, so explain can take it back); and its change
const es_change_view *es_change_view_of(es_ermine *e, const op_value *change);
const op_value *es_view_change(es_ermine *e, const es_change_view *v);
// records as the process c sees them: nodes by path (has_path 0: nothing reaches it)
es_run_view *es_run_view_of(es_context *c, const crn_run *r);
es_call_view *es_call_view_of(es_context *c, const es_call *call);
void es_run_view_free(es_run_view *v);
void es_call_view_free(es_call_view *v);
// v as c is shown it: a handle in it the path it reaches as c sees it (none: null), never the handle;
// lists and plain maps looked through. new
op_value *es_show(es_context *c, const op_value *v);

// promises. settling a second time: nothing. then: fn(ctx, ok, value, error) at once if settled, else as it
// settles (value borrowed for the call; error a message)
// a promise is held by its maker (from es_promise_new) and by each then not told yet: settled and
// held by nothing, it is freed, and a stand-in of it is data. es_promise_release lets go of the
// maker's hold (never let go: kept till es_close) [builder's pick, 10-26: the reference's promise
// goes with its last reference]
es_promise *es_promise_new(es_ermine *e);
void es_promise_release(es_promise *p);
void es_promise_resolve(es_promise *p, op_value *value);
void es_promise_reject(es_promise *p, const char *message);
void es_promise_then(es_promise *p,
	void (*fn)(void *ctx, int ok, const op_value *value, const char *error), void *ctx);

// the call records (calls.ts' Calls). the records are the latest per handler; history keeps older
// ones through onRecord. keep 0: none held (options.calls_never; onRecord is still told)
struct es_calls *es_calls_new(es_ermine *e, int keep);
void es_calls_free(struct es_calls *x);
unsigned es_calls_next(es_ermine *e);
// call n begins in frame (made alone, its info { caller, handler, call: n }, borrowing the values of
// info): the record is theirs, and frees both; the run open is the one it began in
struct call_info;
es_going *es_calls_begin(es_ermine *e, unsigned n, ch_frame *frame, struct call_info *info,
	const es_calling_view *base);
// it returned (a promise: pending till it settles), threw, or threw PENDING
void es_calls_end(es_ermine *e, es_going *g, const es_out *out);
// the call being answered at frame (or the nearest under it), its record so far; NULL: none
int es_calls_calling(es_ermine *e, ch_frame *frame, es_calling_view *out);
// the call open now: the innermost, no run begun inside it
es_going *es_calls_open(es_ermine *e);
// a read function called: the open call's read (recorded once each)
void es_calls_read(es_ermine *e, const char *part, const char *id, const op_key *path, size_t npath,
	int has_path, int keys);
// a memo, effect or early made in the call open: the call's record says so (made by it, owned by the
// scope above)
void es_calls_made(es_ermine *e, const char *kind, const char *id, const char *const *path,
	size_t npath);
// the handler's latest call, tracked; NULL: none. borrowed till the next record there
const es_call *es_calls_latest(es_ermine *e, const char *id);
// a handler gone (its placement's scope gone, or its node removed): its record let go, its readers
// marked; a call of it still going holds none as it ends
void es_calls_drop(es_ermine *e, const char *id);
// a send to nothing: waiting from caller (a computer's node, in its run) at the target (at: its path,
// or its id with has_path 0), till scope goes. answered: a send
// from caller there answered, its wait gone
void es_calls_wait(es_ermine *e, const char *caller, const es_aim *at, sc_scope *scope);
void es_calls_answered(es_ermine *e, const char *caller, const es_aim *at);
// every wait, or caller's; tracked. new
es_wait *es_calls_waits(es_ermine *e, const char *caller, size_t *n);
void es_waits_free(es_wait *waits, size_t n);
void es_calls_stop(es_ermine *e);

// --- D: host.c ----------------------------------------------------------------------------------------------------------------------

// an ErmineError: code and message "<code>: <message>"
int es_fail_ermine(int code, const char *format, ...) __attribute__((format(printf, 2, 3)));
// errors: the code returned and es_thrown() set. message as printf has it
int es_fail(int code, const char *format, ...) __attribute__((format(printf, 2, 3)));
// ES_REFUSED, from the policy's refusal; feature and hook NULL unless a hook threw it
int es_fail_refusal(const gd_refusal *why, const char *feature, const char *hook);
// a hook's throw: ES_FEATURE naming the feature and hook, cause the message
int es_fail_feature(const char *feature, const char *hook, const char *cause);
// ES_FAILED with message as given (an Error a program threw)
int es_fail_text(const char *message);
const es_error *es_thrown(void);
void es_clear_thrown(void);
// ES_NOT_YET, for a stub: naming what is not written
int es_not_yet(const char *what);
// the TypeScript's code: "nothing-there", "refused", "pending", "not-a-method", "feature", "nothing-open" …
const char *es_code_name(int code);
// a code as a program's function gives it: ES_PENDING pending, ES_STOP a value of none, else failed
// with es_thrown()'s message
es_out es_out_code(int code);

// createErmine, in ermine.ts' order: the scheduler; sites; the table, each feature's setup, then
// onTable's layers; places over the front layer, with the processes' rows; the root node and the
// host's node, written as the host; scope nodes, processes, statuses, runs and calls; the host's context;
// the registry
int es_create(const es_options *o, es_ermine **out);
// every process started stopped ("ended"), newest first, then the host's scope, then ermine's own
// listeners and what features listen to on the scheduler. everything after throws ES_CLOSED
int es_close(es_ermine *e);
// a closed ermine's last memory: its contexts, handles and records, and itself. es_close lets go of the
// libraries and the scheduler (when it made it) but keeps these, as a closed ermine is still asked and
// says closed. nothing may be used after
void es_free(es_ermine *e);
es_context *es_host_context(es_ermine *e);
// a process at at running fn, its setup, given c, with the process's scope
// open. its folder: the one it is in. setup giving PENDING: the process pending, what it waits on in
// ES_WAITING; failing: its error in the status, the process still there; a promise: pending till it
// settles. refused (taken, or a name code): ES_TAKEN, and *refused says which
// site: where it is started, its frame's (es_start: the caller's line)
int es_start_at(es_ermine *e, es_program fn, void *ctx, es_at at, const es_start_options *o,
	es_started **out, es_refused *refused, const ch_location *site);
#define es_start(...) es_start_at(__VA_ARGS__, CH_HERE)
void es_refused_free(es_refused *r);
// a process started by a program (system/process.ts' start): asked as c "place", belonging to the scope that
// started it (c's owner: setup's, the scope that placed an action, a writer's parent). it stops as
// that ends (told "ended"), or by es_child_stop; its record is freed with its own scope. not in a memo or
// an effect's act: ES_NOT_HERE. taken (or a name code): 0, *out empty and *refused says which
typedef struct {
	char *id;
	es_names at, folder;
} es_child;
int es_start_in_at(es_context *c, es_program fn, void *ctx, es_at at, const es_start_options *o,
	es_child *out, es_refused *refused, const ch_location *site);
#define es_start_in(...) es_start_in_at(__VA_ARGS__, CH_HERE)
void es_child_free(es_child *k);
// the child's stop(why), asked as c (the starter); none running there: nothing. its status as c reads it
int es_child_stop(es_context *c, const char *id, const char *why);
int es_child_status(es_context *c, const char *id, es_status *out);
// stop (why NULL: "ended"); status: getStatus of its node. its teardown's throw: ES_FAILED, its
// message (stop rethrows it), as es_child_stop, es_stop_id and es_close too
int es_stop(es_started *s, const char *why);
// a running process stopped by its node's id (unplace and remove of its path: nodes.c)
int es_stop_node(es_ermine *e, const char *id);
// a memo or effect stopped by its node (unplace and remove: nodes.c): its scope torn down, its
// teardowns told "ended" (whoever made it: its maker's process keeps running), its node and name gone.
// none there: nothing
void es_stop_computer(es_ermine *e, const char *id);
// every name holding id taken out of its folder, as the folder is now: the first failure's text (freed
// by the caller), else NULL
char *es_unplace_names(es_context *c, const char *id);
// an action stopped by its node: its placement let go, its call record with it. 1 if it was one (its
// node's parts are the caller's to take out), else 0
int es_stop_action(es_ermine *e, const char *id);
// the same, told why (NULL: "ended"); none running there, or the ermine closed: nothing
int es_stop_id(es_ermine *e, const char *id, const char *why);
int es_started_status(es_started *s, es_status *out);
// the host lets go of a process it started (the TypeScript's Process, gone with its last
// reference): stopped first if it runs ("ended"). its memory goes once nothing waits on it (its
// setup's promise settled); never let go: at es_free
void es_started_free(es_started *s);
// one pulse now
int es_pulse(es_context *c);
// a running process's context (NULL: the host's); NULL: stopped, or not this ermine's
es_context *es_get_process_context(es_ermine *e, pr_process *process);
// a running process's context by its node's id; NULL: none (stopped, or the host's)
es_context *es_process_context_of(es_ermine *e, const char *id);
// a handle minted for node: any id, any part. and what a handle reaches (0: not this ermine's)
es_handle *es_handle_of(es_ermine *e, const es_node_data *node);
int es_data_of(es_ermine *e, const void *x, es_node_data *node);
// records, tracked: a computer's latest run (NULL: none), a handler's latest call, every wait
const crn_run *es_records_run(es_ermine *e, const char *id);
// the feature that held back the status write of the run that record is of (NULL: none)
const char *es_records_run_held(es_ermine *e, const char *id);
const es_call *es_records_call(es_ermine *e, const char *id);
es_wait *es_records_waits(es_ermine *e, size_t *n);
// the call being answered where the code runs now (the scope open, or one above it): its record so far
// and the caller's context; for a service acting for its caller. 1, 0: none
int es_calling(es_ermine *e, es_calling_view *out);
// every feature, in chain order (ermine.features)
const es_shown *es_features(es_ermine *e, size_t *n);

// what the other four call. the hooks around: a write (land at the end), reads' items, a teardown (fn),
// a status, a record (keep). each is the chain of that kind, the base's own last
// the entries changed, said written: the layers' commits, innermost first, then places'
void es_commit_changed(es_ermine *e, const pl_changed *changed);
int es_hook_write(es_ermine *e, es_context *o, const es_write *w,
	int (*land)(void *ctx, const es_write *w), void *ctx);
int es_hook_read(es_ermine *e, const es_reading *x, const es_versions *items, es_versions *out);
int es_hook_teardown(es_ermine *e, sc_scope *scope, const char *why,
	void (*fn)(void *ctx, const char *why), void *ctx);
int es_hook_status(es_ermine *e, const es_asked *x, const es_status *st, es_status *out);
int es_hook_record(es_ermine *e, const es_recorded *r,
	void (*keep)(void *ctx, const es_recorded *r), void *ctx);
// writes held back by onWrite, tracked: at (part, id); a node's status write; a stopped process's row. 1
// and *out, else 0. drop: a node gone, what was held at its parts holding nothing goes with it
int es_held_at(es_ermine *e, const char *part, const char *id, es_held *out);
int es_held_status(es_ermine *e, const char *id, es_held *out);
int es_held_row(es_ermine *e, const char *id, es_held *out);
void es_held_drop(es_ermine *e, const char *id);
// a write's header now: the open scope's, its frame the one open; from outside the graph, the
// call's location (es_enter) in a frame more on top. *made: its block, for pl_hold on the entry written
int es_header(es_ermine *e, ch_header *out, pl_made **made);
// the location of the call in progress, set; gives the one before, to put back
const ch_location *es_enter(es_ermine *e, const ch_location *site);
// whether a thing made now is from outside the graph (no run open, no frame up the chain from the
// one open holding locations), and then its locations value (the call's, from es_enter; NULL
// when no call gave one): *locations, new, the caller's to op_free
int es_outside(es_ermine *e, op_value **locations);
// ES_CLOSED once closed
int es_alive(es_ermine *e);
// one pulse soon, however many ask
void es_queue_pulse(es_ermine *e);
// a new node's id (options.id, else uuidv7), malloc'd; a uuidv7
char *es_new_id(es_ermine *e);
char *es_uuidv7(void);
// the scheduler's options.drop: lets go of a result (an op_value)
void es_drop(void *value, void *data);
// the process's why, if a stop said one; NULL: none
const char *es_why_of(es_ermine *e, const char *process);

// the registry: a scope found to its context (held while the scope is). the context a function acts as
// is the one found from the scope open: es_found, which gives NULL and ES_NOTHING_OPEN (naming the
// function) when no scope of a registered scheduler is open. es_context_at: the context scope, or one
// above it, is found by; NULL: none
void es_register_scope(sc_scope *scope, es_context *c);
es_context *es_context_at(sc_scope *scope);
es_context *es_found(const char *name);

// small things shared by the files (host.c; es_thing_of: nodes.c)
#define CP(x) ((const char *const *)(x))
// a path's steps as text: a leading "/" is the root, empty pieces are skipped (path.ts' parse)
char **es_parse_steps(const char *text, size_t *n);
// names copied, NULL after the last (pr_names_free frees them)
char **es_dup_names(const char *const *src, size_t n);
// the names joined by "/", for a message
char *es_join(const char *const *names, size_t n);
// the names as a key two paths share only if they are the same
char *es_path_key(const char *const *path, size_t n);
// an Error as a status holds it
op_value *es_error_value(const char *message);
// a pair of a scope's info; NULL: none
const void *es_pair_of(const sc_scope *o, const char *key);
// the id (and path of n, if it has one) as the policy is asked of it
gd_thing es_thing_of(const char *id, const es_node_data *n);

#endif
