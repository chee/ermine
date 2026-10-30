// The C implementation of ermine, with the prefix es_. The TypeScript in system/typescript is the
// reference, and system/conformance/ermine/ holds both to it through the line protocol of
// ermine_harness.ts (ermine_harness.c speaks it).
//
//   es_options o = {.id = ids, .may = policy};
//   es_ermine *e;  es_create(&o, &e);
//   es_started *s;  es_start(e, setup, ctx, es_text("/work/clock"), NULL, &s, &no);
//   es_context *c = es_host_context(e);                       // process 0's
//   es_handle *n;  es_ensure_node(c, es_text("/a"), value, &n);
//   const op_value *v;  es_read(c, es_on_node(n), NULL, 0, &v);
//   es_close(e);
//
// A function that can fail returns 0 or an es_code, and es_thrown() says what. Results go through
// the out pointers and are set only on 0. A program's functions give an es_out instead.
//
// Every process api function takes the context it acts as: a process's (given to the program, or
// found with es_found) or the host's (es_host_context).
//
// A node handle, a function placed as an action's value and a promise cannot be data. They are
// stand-ins (op_stand) made by es_live, and a sync that finds one finds a leaf.
//
// A writing call is a macro over its _at function, which takes the caller's line (CH_HERE).
//
// Values passed in are borrowed for the call. Values handed back are borrowed from the table unless
// the struct says they are its own (free them with es_*_free). Handles and functions last until
// es_close. Out of memory aborts (es_alloc).
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

// --- codes and errors ----------

// Places' codes keep their numbers. The rest follow the TypeScript's error classes.
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
	ES_FAILED,
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
	ES_IN_ACT,
	// an act gave back something that is no cleanup
	ES_BAD_CLEANUP,
	ES_NOT_HERE,
	ES_GONE,
	ES_ALREADY_INSIDE,
	ES_OUTSIDE,
} es_code;

// The error behind the last code returned (one slot, single threaded). feature, hook and cause are
// set when a hook threw.
typedef struct {
	int code;
	char *message;
	char *op, *reason;
	char *feature, *hook;
	char *cause;
} es_error;

// --- small things every file uses ----------

static inline void *es_alloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static inline char *es_dup(const char *s) { return strcpy(es_alloc(strlen(s) + 1), s); }
#define ES_PUSH(items, n, cap, item) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(items) = realloc((items), (cap) * sizeof *(items)); \
			if ((items) == NULL) abort(); \
		} \
		(items)[(n)++] = (item); \
	} while (0)

// A string-keyed map in insertion order. A set is a map whose values are ignored. A zeroed map is
// empty, keys are copied, and del moves the last item into the hole.
typedef struct {
	char **keys;
	void **vals;
	size_t n, cap;
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
static inline void es_map_free(es_map *m) {
	for (size_t i = 0; i < m->n; i++) free(m->keys[i]);
	free(m->keys);
	free(m->vals);
	free(m->slots);
	*m = (es_map){0};
}

// --- paths and targets ----------

// A path as a function is given it: its text ("./a/b", "../x", "/y", or a bare name inside the
// process's node), or its steps when text is NULL.
typedef struct {
	const char *text;
	const char *const *steps;
	size_t nsteps;
} es_at;
static inline es_at es_text(const char *text) { return (es_at){text, NULL, 0}; }
static inline es_at es_steps(const char *const *steps, size_t n) { return (es_at){NULL, steps, n}; }

typedef struct {
	char **names;
	size_t n;
} es_names;

// A node handle: opaque, with its data in the ermine's table. A pointer of any other kind is
// ES_NOT_A_HANDLE.
typedef struct es_handle es_handle;

typedef struct {
	es_at at;
	const es_handle *node;
} es_target;
static inline es_target es_on_path(es_at at) { return (es_target){at, NULL}; }
static inline es_target es_on_node(const es_handle *h) { return (es_target){{NULL, NULL, 0}, h}; }

// What a handle reaches: a path walked at each use, or an id for a node with no place. part is the
// table part read and written ("value", "attributes", "children", or a feature's own).
typedef struct {
	int has_path;
	char **path;
	size_t npath;
	char *id;
	char *part;
} es_node_data;

typedef struct {
	const char *id;
	int has_path;
	const char *const *path;
	size_t npath;
} es_aim;

// --- values a program makes or is given ----------

// What a program's function gives back: a value (the receiver's to op_free; NULL for none),
// PENDING, a failure (error is malloc'd, the receiver's), or a promise (a value, see
// es_promise_value).
//
// A compute may also give ES_OUT_PAUSE (a generator that yielded a promise). value is the promise
// and step says how the run goes on. next is given how the promise settled and returns what the run
// comes to. quit is called instead if the computer reruns, is gone, or the ermine closes. Exactly
// one of the two is called, once.
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

typedef es_out (*es_program)(es_context *c, void *ctx);
typedef es_out (*es_compute)(es_context *c, void *ctx, const op_value *previous);
// an effect's act, after the round: 0, or a code (it threw: the effect's status is failed, phase act)
typedef int (*es_act)(es_context *c, void *ctx, const op_value *value, const op_value *before);
typedef int (*es_equal)(void *ctx, const op_value *a, const op_value *b);
// An action's function; args are borrowed. c is the context of the call frame, which is the
// placer's, not the caller's.
typedef es_out (*es_action)(es_context *c, void *ctx, const op_value *const *args, size_t nargs);
typedef op_value *(*es_make)(void *ctx);
typedef void (*es_teardown)(void *ctx, const char *why);
typedef int (*es_thunk)(void *ctx);

typedef struct {
	es_action fn;
	void *ctx;
} es_function;

static inline op_value *es_live(const char *what, const void *p) {
	op_value *kind = op_map();
	op_set(kind, "live", op_str(what));
	op_set(kind, "at", op_bytes(&p, sizeof p));
	return op_stand(kind);
}
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
static inline es_function *es_function_of(const op_value *v) { return es_live_of(v, "function"); }

// A promise a program made. It settles once, and its callbacks run at once as it settles, in the
// order added (C has no microtask). A function that gives one ends pending until it settles.
typedef struct es_promise es_promise;
op_value *es_promise_value(const es_promise *p);
// The promise a stand-in refers to, if this ermine made it; NULL otherwise.
es_promise *es_promise_of(es_ermine *e, const op_value *v);

// --- writes and contexts ----------

// One table write: patches on (part, id), with the path it was reached by when known. header is
// the change as its writer made it, or NULL to make it from the scope open. gone means the entry
// was taken out. features lists the onWrite hooks that changed it, outermost first.
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

#define ES_FEATURES "features"
#define ES_SCOPE "ermine.computer.scope"
#define ES_WAITING "ermine.process.waiting"
#define ES_ARGS "ermine.host.args"
#define ES_FEATURES_ATTRIBUTE "ermine.features"

// A process context: where and as whom a thing is done. There is one per process and one for the
// host (process 0). A process's is freed with its scope, the others at es_free. Made by
// es_context_new.
struct es_context {
	es_ermine *ermine;
	// public ----------
	sc_scope *scope;
	char **folder;
	size_t nfolder;
	char **at;
	size_t nat;
	char **args;
	size_t nargs;
	pr_process *process;
	// inner ----------
	// the places it acts in; node is who it acts as, and the policy is asked of it
	pl *places;
	char *box;
	char *node;
	int guarded;
	gd *guard;
	// per-context state of computers.c (memos, effects and earlies its owners' runs made, by name),
	// and how deep a peep is (>0: reads are not tracked)
	void *named;
	int peeping;
};

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
	const char *node;
} es_context_options;

// --- changes, reads, results ----------

// A change as a program sees it: when, who, and where it began. One per change, owned by the
// ermine.
typedef struct es_change_view {
	const op_value *change;
	int64_t time;
	const op_value *actor;
	const op_value *locations;
	int user_activated;
} es_change_view;

// Where a value is from: the change (as a hook gets it) and its view (as a program gets it).
// For a feature's item it also has the kind, the feature's name and other fields (a map or NULL).
typedef struct {
	const op_value *change;
	const es_change_view *view;
	const char *kind;
	const char *feature;
	op_value *more;
} es_from;

// One value a path holds, and where it is from. gone: a delete. inside: a write under it. held:
// a value made for it, let go with it.
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

// One node a path reaches: its value, where it was found, and a handle to it. refused: the policy
// said no, so there is no value and no handle.
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

typedef struct {
	char **names;
	es_handle **nodes;
	size_t n;
} es_children;

// What a pending process waits on: a memo it read, a send to nothing, process code not yet at its
// path, a promise, or nothing it says.
typedef enum { ES_WAIT_NODE, ES_WAIT_SEND, ES_WAIT_CODE, ES_WAIT_PROMISE, ES_WAIT_PENDING } es_waiting_kind;
typedef struct {
	es_waiting_kind kind;
	int has_path;
	char **path;
	size_t npath;
	double since;
} es_waiting;

// Status. state is done, pending, failed or looping. held: a feature held a write back
// (held_write is "status" or "row"). phase ("run" or "act") goes with failed. n is a computer's
// latest run. more holds a feature's own fields.
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

typedef struct {
	char *part;
	int has_path;
	char **path;
	size_t npath;
} es_touched;
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
	const char *kind;
	int has_path;
	char **path;
	size_t npath;
} es_made_view;
// A call's record as a process sees it. Handles in args and returned are shown as paths
// (es_show).
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
// A change explained: the change and its writer. held: the latest write there a feature held
// back.
typedef struct {
	const es_change_view *change;
	int has_writer;
	es_writer writer;
	int has_held;
	char *held_feature;
} es_explained;

// Who called the running action: the actor its writes carry, and the caller's process node by
// path.
typedef struct {
	const op_value *actor;
	int has_process;
	es_names process;
} es_caller;

// --- the call records (calls.ts) ----------

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

// A call's record, the latest per handler (older ones go to onRecord). caller is the sending
// process's id (the host's node for the host). context is the caller's. handler_change is the
// handler value's change as called. started and ended are ms since 1970.
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
	// the call's frame (held), with locations when called from outside the graph
	ch_frame *frame;
} es_call;

typedef struct {
	char *caller;
	int has_path;
	char **path;
	size_t npath;
	char *id;
	double since;
} es_wait;

typedef struct es_going es_going;

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

// --- features and their hooks (features.ts) ----------

typedef enum { ES_ON_TABLE, ES_ON_READ, ES_ON_WRITE, ES_ON_TEARDOWN, ES_ON_RECORD, ES_ON_STATUS, ES_HOOKS } es_hook;

// A layer over the table places reads: the table it gives places, and where table events and
// commits go. The raw table's events go to the first layer, and each layer's on to the next.
typedef struct {
	tb_table *front;
	tb_event event;
	void (*commit)(void *ctx, const pl_changed *changed);
	void *ctx;
} es_layer;
// What onTable is given: the table under it, and where its own events and commits go on to.
typedef struct {
	tb_table *table;
	tb_event ahead_event;
	void (*ahead_commit)(void *ctx, const pl_changed *changed);
	void *ahead_ctx;
} es_under;

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
typedef struct {
	const char *id;
	const crn_run *run;
	const es_call *call;
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

// Hooks are middleware. Each returns 0 or a code (it threw). A code is rethrown as a FeatureError
// naming the feature and hook, except ES_PENDING, ES_STOP, a FeatureError, and a code next gave,
// which pass as they are. A Refusal gets its feature and hook named. ctx is the one given at
// registration.
typedef int (*es_on_table_fn)(void *ctx, const es_under *under, es_table_next *next, es_layer *out);
typedef int (*es_on_read_fn)(void *ctx, const es_reading *x, const es_versions *items,
	es_read_next *next, es_versions *out);
typedef int (*es_on_write_fn)(void *ctx, es_context *o, const es_write *w, es_write_next *next);
typedef int (*es_on_teardown_fn)(void *ctx, sc_scope *scope, const char *why, es_teardown_next *next);
typedef int (*es_on_record_fn)(void *ctx, const es_recorded *r, es_record_next *next);
typedef int (*es_on_status_fn)(void *ctx, const es_asked *x, const es_status *st,
	es_status_next *next, es_status *out);

// What a feature acts with, in its setup and its hooks. Hooks can only be added in setup
// (ES_SETUP_ONLY). Places, processes, contexts and handles exist after setup (ES_NOT_YET before).
// Scheduler listeners it adds are removed at close.
typedef struct es_feature_api {
	sc_scheduler *scheduler;
	tb_table *table;
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
int es_api_get_process_context(es_feature_api *f, pr_process *process, es_context **out);
int es_api_handle_of(es_feature_api *f, const es_node_data *node, es_handle **out);
int es_api_data_of(es_feature_api *f, const void *x, es_node_data *node);
int es_api_seen(es_feature_api *f, const char *id, es_context *context, es_names *out);
// 0 and *out when the node is reached from the root; ES_NOTHING_THERE (out empty) when nothing is
// (the root is a path of no names: tell them apart by the code)
// a listener a feature added to the scheduler (sc_on_…), taken away at es_close as ermine's own are
int es_listened(es_feature_api *f, sc_listener *l);

typedef struct es_slot es_slot;
int es_reserve_slot(es_feature_api *f, es_slot **out);
int es_slot_get(const es_slot *s, es_context *c, long *out);
void es_slot_set(es_slot *s, es_context *c, long value);

// A feature: its name, the files it lists, the names it needs (set up first), and its setup.
typedef struct {
	const char *name;
	const char *const *files;
	size_t nfiles;
	const char *const *needs;
	size_t nneeds;
	int (*setup)(void *ctx, es_feature_api *f);
	void *ctx;
} es_feature;
typedef struct {
	char *name;
	char **needs;
	size_t nneeds;
	es_hook *hooks;
	size_t nhooks;
} es_shown;

// --- the ermine ----------

// what onCreateFunction is told: kind ("memo", "effect", "action"), the computer (NULL for an action),
// its node, and who made it (the process's id, or the host's node's)
typedef struct {
	const char *kind;
	sc_computer *computer;
	const es_node_data *node;
	const char *id;
	const char *process;
} es_created;

typedef struct {
	const es_feature *const *features;
	size_t nfeatures;
	sc_scheduler *scheduler;
	char *(*id)(void *ctx);
	void *id_ctx;
	int64_t (*now)(void *ctx);
	void *now_ctx;
	const pr_policy *may;
	void (*schedule)(void *ctx, void (*f)(void *data), void *data);
	void *schedule_ctx;
	void (*on_create_function)(void *ctx, const es_created *made);
	void *on_create_function_ctx;
	const char *root;
	// the host's node: where it is placed (NULL: nowhere), the host's args
	// (NULL: none)
	struct {
		const char *at;
		const char *const *args;
		size_t nargs;
	} host;
	const sc_pair *info;
	size_t ninfo;
	int calls_never;
	// whether a person just interacted with the page now (a writer asks as it runs: its changes
	// say userActivated). NULL: never. the host says; the ermine does not look
	int (*user_activated)(void *ctx);
	void *user_activated_ctx;
} es_options;

// The base: what one ermine's contexts share. Made by es_create. The other files keep their state
// behind the pointers at the end.
struct es_ermine {
	int closed;
	sc_scheduler *scheduler;
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
	char *node;
	sc_scope *host_scope;
	es_context *host_context;
	char *(*id)(void *ctx);
	void *id_ctx;
	void (*on_create_function)(void *ctx, const es_created *made);
	void *on_create_function_ctx;
	int (*user_activated)(void *ctx);
	void *user_activated_ctx;
	const ch_location *site;
	pm handles;
	es_map whys;
	struct es_nodes *nodes;
	struct es_computers *computers;
	struct es_calls *calls;
	struct es_actions *actions;
	struct es_hosting *hosting;
};

// Options for start: args (has_args 0: none), and the places the process lives in (a view of this
// ermine's, NULL for its own).
typedef struct {
	const char *const *args;
	size_t nargs;
	int has_args;
	pl *places;
} es_start_options;
typedef struct {
	es_ermine *ermine;
	pr_process *process;
} es_started;
// A refused start: "taken" or a name code, and the path. held: a stopped process's row that a
// feature held back.
typedef struct {
	const char *refused;
	char **at;
	size_t nat;
	int has_held;
	char *held_process, *held_feature;
} es_refused;

typedef struct {
	const char *feature;
	const char *write;
} es_held;

// --- A: nodes.c ----------

struct es_nodes *es_nodes_new(es_ermine *e);
void es_nodes_free(struct es_nodes *x);
es_context *es_context_new(es_ermine *e, const es_context_options *o);
void es_context_free(es_context *c);
int es_resolve(es_context *c, es_at p, es_names *out);
void es_names_free(es_names *names);
int es_within(es_context *c, es_thunk f, void *ctx);
// f with a scope open: the one open, else the fallen scope (a process's: ES_NOTHING_OPEN; the host's:
// its own scope)
int es_inside(es_context *c, es_thunk f, void *ctx);
sc_scope *es_owner(es_context *c);
// the frame open now (a call's, a writer's run's, or the scope open's own), else the context's
// scope's own: the info a write carries is found from it
ch_frame *es_open_frame(es_context *c);
int es_ask_slot(es_context *c, const char *parent, const char *const *path, size_t npath);
// one write at a node (its id, and the path it was reached by), asked "edit" on it, through onWrite,
// committed, a pulse asked for. remove: the entry taken out, asked "edit" as write is
int es_context_write_at(es_context *c, const char *part, const es_aim *at, const op_patch *patches,
	size_t n, const ch_location *site);
int es_context_remove_at(es_context *c, const char *part, const es_aim *at, const ch_location *site);
#define es_context_write(...) es_context_write_at(__VA_ARGS__, CH_HERE)
#define es_context_remove(...) es_context_remove_at(__VA_ARGS__, CH_HERE)
int es_context_ask(es_context *c, const char *op, const gd_target *targets, size_t n);
int es_context_put(es_context *c, const es_write *w);
void es_context_writer(es_context *c, const char *part, tb_key id, const op_patch *patches, size_t n,
	const ch_header *header);

// A new handle for node (data copied). A handle is a name, not a power: it holds no maker.
es_handle *es_mint(es_ermine *e, const es_node_data *node);
typedef struct {
	es_node_data node;
} es_handle_data;
const es_handle_data *es_handle_lookup(es_ermine *e, const void *h);
es_handle *es_handle_in(es_ermine *e, const op_value *v);
es_handle *es_handle_make(es_context *c, const es_node_data *n);
es_handle *es_handle_by_id(es_context *c, const char *id, const char *part);
int es_handle_id(es_ermine *e, const es_node_data *n, const char **out);
es_node_data es_node_data_copy(const es_node_data *n);
void es_node_data_free(es_node_data *n);

void es_running_set(es_ermine *e, const char *process, const char *const *at, size_t nat);
void es_running_clear(es_ermine *e, const char *process);
// id's path from the root: up its names, then walked down (tracked). 1 and *out; 0: nothing
// reaches it
int es_seen_in(es_ermine *e, es_context *reader, const char *id, es_names *out);

// x resolved to the node it reaches as c reaches it: a path resolved by c, or a handle's place or
// id. ES_NOT_A_HANDLE for an object that is no handle.
int es_node_of(es_context *c, es_target x, es_node_data *out);
int es_id_of(es_context *c, const es_node_data *n, const char **out);
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
int es_folder_slot(es_context *c, const char *const *path, size_t npath, nd_entry **children,
	const char **name);

// What a reader waits on: the nodes it read that were not there. A read of a missing node is
// ES_PENDING and tracked.
typedef struct {
	int has_n;
	unsigned n;
	es_names *paths;
	size_t npaths;
	es_map keys;
} es_missing;
// the reader's, borrowed (NULL: none). Held only for a computer's latest run and a process's
// setup.
const es_missing *es_missing_of(es_ermine *e, const char *id);
void es_missing_drop(es_ermine *e, const char *id);
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
int es_peep(es_context *c, es_thunk f, void *ctx);
int es_list(es_context *c, es_target x, es_names *out);
const char *const *es_get_args(es_context *c, size_t *n);
void es_children_free(es_children *c);
void es_versions_free(es_versions *v);
void es_items_free(es_items *i);

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

// --- B: computers.c ----------

// its state (the memos, effects, their nodes, contexts and promises out): made by es_create, let go at close
struct es_computers *es_computers_new(es_ermine *e);
void es_computers_free(struct es_computers *x);
void es_computer_forget(es_context *c);

// options of a memo or effect: equal (NULL: identical), early (effects only: run and acted at once,
// and later acted before other effects')
typedef struct {
	es_equal equal;
	void *equal_ctx;
	int early;
} es_computed_options;
// A compute at its own node at name. When its owner runs again and makes it again, it keeps the
// node and takes the new f; a name not made again goes after the run. A second at one name in a
// run is ES_ALREADY_THERE. An f that gives a promise ends the run pending until it settles.
int es_create_memo_at(es_context *c, es_at name, es_compute f, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_location *site);
int es_create_effect_at(es_context *c, es_at name, es_compute f, es_act act, void *ctx,
	const es_computed_options *o, es_handle **out, const ch_location *site);
#define es_create_memo(...) es_create_memo_at(__VA_ARGS__, CH_HERE)
#define es_create_effect(...) es_create_effect_at(__VA_ARGS__, CH_HERE)
// an effect's act makes nothing: ES_IN_ACT when own is the scope an act is running in. fn names what was
// called (createMemo, createEffect, createAction, addTeardown)
int es_not_in_act(es_ermine *e, sc_scope *own, const char *fn);
// A memo, effect or pipe is made inside its maker's node (a process's, by a bare name; the
// host's is the root), never beside or above it, or it would outlive its maker with no context of
// its own. Otherwise ES_OUTSIDE. path is where it would be; fn names what was called.
int es_inside_only(es_context *c, const es_names *path, const char *fn);
sc_scope *es_acting(es_ermine *e);
// what is known of a node: a memo or effect's; a memo's (a read of one pending with no value is ES_PENDING);
// the context that made a computer; its latest run gave a promise not settled yet
int es_is_computer(es_ermine *e, const char *id);
int es_is_memo(es_ermine *e, const char *id);
es_context *es_computer_context(es_ermine *e, const char *id);
int es_awaiting(es_ermine *e, const char *id);
int es_get_status(es_context *c, es_target x, es_status *out);
// es_get_status for one field (key: "state", "error", "phase", "waiting" or "n"; NULL: all), so
// a reader is told only when that field may change.
int es_get_status_of(es_context *c, es_target x, const char *key, es_status *out);
void es_status_free(es_status *s);
int es_latest_run(es_ermine *e, const char *id, const crn_run **out);

// --- C: actions.c ----------

struct es_actions *es_actions_new(es_ermine *e);
void es_actions_free(struct es_actions *x);
int es_is_action(es_ermine *e, const char *id);
// a value at a node going (written over or taken out): held is what es_action_held gave before, the
// action's record let go unless now (the value after, NULL: none) is still its stand-in
void *es_action_held(es_ermine *e, const op_value *was);
void es_action_let_go(es_ermine *e, void *held, const op_value *now);

// fn as the value of the node at p, run by es_execute_action in a call frame under the owner's (the
// one open). placed again by the same owner: the node as it is, the new fn. gone with the owner
int es_create_action_at(es_context *c, es_at p, es_action fn, void *ctx, es_handle **out,
	const ch_location *site);
// The action at x called with args in a call frame. Its return goes in *out (a promise is a
// value: the call lasts until it settles), the caller's to op_free. If nothing is there, a wait is
// recorded and the result is ES_PENDING. A value that is no function is ES_NOT_A_METHOD.
int es_execute_action_at(es_context *c, es_target x, const op_value *const *args, size_t nargs,
	op_value **out, const ch_location *site);
#define es_create_action(...) es_create_action_at(__VA_ARGS__, CH_HERE)
#define es_execute_action(...) es_execute_action_at(__VA_ARGS__, CH_HERE)
int es_get_caller(es_context *c, es_caller *out);
// Where the open call's caller is placed, for the guard's caller hook (ctx is the asking
// context). 1 with *from and *nfrom (*from NULL: the host), or 0 if no call is open. *box is never
// set here.
int es_caller_place(void *ctx, const char *const **from, size_t *nfrom, tb_key *box);
void es_caller_free(es_caller *c);
// fn as the scope open goes (through onTeardown): why "replaced" (the owner ran again), "ended", or the
// reason a stop was given
int es_add_teardown(es_context *c, es_teardown fn, void *ctx);
// in an effect's act: fn(why) as the effect goes, and before its next act (the TypeScript's act returns
// its cleanup; C's calls this). ES_NOT_HERE out of an act
int es_cleanup(es_context *c, es_teardown fn, void *ctx);

// createWriter: a writer for code that runs with nothing open (a timer, a listener, a promise
// settling). Only in setup or an action. *writer is a stand-in, the caller's to op_free, good while
// c's owner lives (then es_with_writer says ES_GONE). It runs as the owner, and its writes carry
// the mark it was created under. While the host says a person just interacted
// (options.user_activated), they say so.
int es_create_writer(es_context *c, op_value **writer);
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
int es_explain_view(es_context *c, const es_change_view *v, es_explained **out);
void es_explained_free(es_explained *x);
const es_change_view *es_change_view_of(es_ermine *e, const op_value *change);
const op_value *es_view_change(es_ermine *e, const es_change_view *v);
es_run_view *es_run_view_of(es_context *c, const crn_run *r);
es_call_view *es_call_view_of(es_context *c, const es_call *call);
void es_run_view_free(es_run_view *v);
void es_call_view_free(es_call_view *v);
// v as c is shown it: a handle in it the path it reaches as c sees it (none: null), never the handle;
// lists and plain maps looked through. new
op_value *es_show(es_context *c, const op_value *v);

// Promises. Settling twice does nothing. then calls fn at once if already settled, else as it
// settles. A promise is held by its maker (es_promise_new) and by each then not yet told. Once
// settled and held by nothing it is freed. es_promise_release lets go of the maker's hold.
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
void es_calls_end(es_ermine *e, es_going *g, const es_out *out);
int es_calls_calling(es_ermine *e, ch_frame *frame, es_calling_view *out);
es_going *es_calls_open(es_ermine *e);
void es_calls_read(es_ermine *e, const char *part, const char *id, const op_key *path, size_t npath,
	int has_path, int keys);
// a memo, effect or early made in the call open: the call's record says so (made by it, owned by the
// scope above)
void es_calls_made(es_ermine *e, const char *kind, const char *id, const char *const *path,
	size_t npath);
const es_call *es_calls_latest(es_ermine *e, const char *id);
// a handler gone (its placement's scope gone, or its node removed): its record let go, its readers
// marked; a call of it still going holds none as it ends
void es_calls_drop(es_ermine *e, const char *id);
// A send to nothing waits from caller at the target (a path, or an id with has_path 0) until
// scope goes. answered removes the wait.
void es_calls_wait(es_ermine *e, const char *caller, const es_aim *at, sc_scope *scope);
void es_calls_answered(es_ermine *e, const char *caller, const es_aim *at);
es_wait *es_calls_waits(es_ermine *e, const char *caller, size_t *n);
void es_waits_free(es_wait *waits, size_t n);
void es_calls_stop(es_ermine *e);

// --- D: host.c ----------

int es_fail_ermine(int code, const char *format, ...) __attribute__((format(printf, 2, 3)));
int es_fail(int code, const char *format, ...) __attribute__((format(printf, 2, 3)));
int es_fail_refusal(const gd_refusal *why, const char *feature, const char *hook);
int es_fail_feature(const char *feature, const char *hook, const char *cause);
int es_fail_text(const char *message);
const es_error *es_thrown(void);
void es_clear_thrown(void);
int es_not_yet(const char *what);
const char *es_code_name(int code);
// a code as a program's function gives it: ES_PENDING pending, ES_STOP a value of none, else failed
// with es_thrown()'s message
es_out es_out_code(int code);

// createErmine. Setup follows the order in ermine.ts.
int es_create(const es_options *o, es_ermine **out);
// every process started stopped ("ended"), newest first, then the host's scope, then ermine's own
// listeners and what features listen to on the scheduler. everything after throws ES_CLOSED
int es_close(es_ermine *e);
// a closed ermine's last memory: its contexts, handles and records, and itself. es_close lets go of the
// libraries and the scheduler (when it made it) but keeps these, as a closed ermine is still asked and
// says closed. nothing may be used after
void es_free(es_ermine *e);
es_context *es_host_context(es_ermine *e);
// Start a process at at, running fn (its setup) with the process's scope open. Setup giving
// PENDING makes the process pending (what it waits on goes in ES_WAITING). A failing setup puts
// the error in its status. A promise keeps it pending until it settles. A taken path or a name
// code gives ES_TAKEN, and *refused says which. site is where it was started.
int es_start_at(es_ermine *e, es_program fn, void *ctx, es_at at, const es_start_options *o,
	es_started **out, es_refused *refused, const ch_location *site);
#define es_start(...) es_start_at(__VA_ARGS__, CH_HERE)
void es_refused_free(es_refused *r);
// Start a process from a program, asked as c "place". It belongs to the scope that started it
// and stops when that ends, or by es_child_stop. ES_NOT_HERE in a memo or an effect's act. Taken
// or a name code: 0, *out is empty and *refused says which.
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
// A memo or effect stopped by its node: its scope torn down, its teardowns told "ended", its node
// and name gone. Nothing there: nothing.
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
int es_pulse(es_context *c);
es_context *es_get_process_context(es_ermine *e, pr_process *process);
es_context *es_process_context_of(es_ermine *e, const char *id);
es_handle *es_handle_of(es_ermine *e, const es_node_data *node);
int es_data_of(es_ermine *e, const void *x, es_node_data *node);
const crn_run *es_records_run(es_ermine *e, const char *id);
const char *es_records_run_held(es_ermine *e, const char *id);
const es_call *es_records_call(es_ermine *e, const char *id);
es_wait *es_records_waits(es_ermine *e, size_t *n);
// the call being answered where the code runs now (the scope open, or one above it): its record so far
// and the caller's context; for a service acting for its caller. 1, 0: none
int es_calling(es_ermine *e, es_calling_view *out);
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
const ch_location *es_enter(es_ermine *e, const ch_location *site);
// whether a thing made now is from outside the graph (no run open, no frame up the chain from the
// one open holding locations), and then its locations value (the call's, from es_enter; NULL
// when no call gave one): *locations, new, the caller's to op_free
int es_outside(es_ermine *e, op_value **locations);
int es_alive(es_ermine *e);
void es_queue_pulse(es_ermine *e);
char *es_new_id(es_ermine *e);
char *es_uuidv7(void);
void es_drop(void *value, void *data);
const char *es_why_of(es_ermine *e, const char *process);

// The registry: a scope found to its context. es_found gives the context of the scope open, or
// NULL and ES_NOTHING_OPEN naming the function. es_context_at gives the context of scope or the
// nearest one above it.
void es_register_scope(sc_scope *scope, es_context *c);
es_context *es_context_at(sc_scope *scope);
es_context *es_found(const char *name);

#define CP(x) ((const char *const *)(x))
char **es_parse_steps(const char *text, size_t *n);
char **es_dup_names(const char *const *src, size_t n);
char *es_join(const char *const *names, size_t n);
char *es_path_key(const char *const *path, size_t n);
op_value *es_error_value(const char *message);
const void *es_pair_of(const sc_scope *o, const char *key);
gd_thing es_thing_of(const char *id, const es_node_data *n);

#endif
