// The graph (newcore/graph/ts/graph.ts), in C: the libraries hooked up. It holds the table, places, a
// trackgraph and one notify per node; no library knows another. places says what a read rested
// on (depend), the graph tracks it in the trackgraph and asks that node's notify to watch it;
// the graph tells the node's notify of each change, and notify's reads mark the owners that read
// there. protect is asked as the actor before each operation, through a bound interface.
//
// An owner is anything that reads tracked (the scheduler's processes): a pointer the graph
// never reads, only compares, and hands to marked. Same order of operations as graph.ts: every
// change, node made and intro ticks the clock where graph.ts does.
//
// memory: an arena per graph, freed by gr_free. Values (nt_value) are made with notify's
// constructors and shared between versions by mutate, so nothing owns them: they are not freed.
// Single threaded. Notify tells each changed object whole (not patch by patch): a write of
// several patches to one object marks its readers once.
#ifndef GRAPH_H
#define GRAPH_H

#include <stddef.h>
#include <stdint.h>

#include "../../nodes/c/node.h"
#include "../../notify/c/notify.h"
#include "places.h"
#include "../../protect/c/protect.h"

typedef struct gr_graph gr_graph;
typedef struct gr_api gr_api;
typedef struct gr_reader gr_reader;

// where a change was: an object of a node, or the node's loading
typedef enum { GR_NOWHERE, GR_VALUE, GR_INFO, GR_CHILDREN, GR_LOADED } gr_where;

// a change: its header, and the node it is in. Marks carry the object changed (where, name:
// the name of an info object or list). actor, cause and site are the caller's, never read here
typedef struct gr_change {
	int64_t time;
	const pr_value *actor;
	const char *reader;
	const pr_value *cause;
	const pr_value *site;
	const char *node;
	gr_where where;
	const char *name;
} gr_change;

// who a change is by, as places asks for it
typedef struct {
	const pr_value *actor;
	const char *reader;
	const pr_value *cause;
	const pr_value *site;
} gr_acting;

// an error: code ("refused", "stopped", "read-only", "not-a-process", places', mutate' and
// table's own); why: protect's, for refused. NULL from a call: none
typedef struct {
	const char *code;
	const char *message;
	const pr_value *why;
} gr_error;

// times, pushed (grown with realloc, freed by the owner)
typedef struct {
	int64_t *v;
	size_t n, cap;
} gr_times;

typedef struct {
	const char *root;       // the root's id; the host introduces its node, or one is made
	const pr_value *actor;  // who the host's own changes are by; NULL: "host"
	int64_t *clock;         // the last time given; each change takes the next. NULL: its own, at 0
	// a fresh id for a node made at a time; "@" and the time if NULL (in the arena)
	const char *(*id)(void *ctx, int64_t time);
	const pr_may *may;      // who may do what (copied); NULL: anyone
	// a change reached what owner read; tag: what it was made with
	void (*marked)(void *ctx, void *owner, const gr_change *by, const void *tag);
	// an ephemeral node now owned by owner
	void (*owned)(void *ctx, void *owner, const char *id);
	// a node gone, and its owner if ephemeral: before its loaded readers are marked
	void (*released)(void *ctx, const char *id, void *owner);
	// the host's site for its changes; NULL, or returns NULL: none
	const pr_value *(*site)(void *ctx);
	void *ctx; // given to all of the above
} gr_options;

gr_graph *gr_new(const gr_options *o);
void gr_free(gr_graph *g);
pr_arena *gr_pr_arena(gr_graph *g);
void *gr_alloc(gr_graph *g, size_t n);
char *gr_dup(gr_graph *g, const char *s);
// protect's value from ours, in the graph's arena (null for a live value or absent)
pr_value *gr_pr(gr_graph *g, const nt_value *v);

nd_node *gr_get(gr_graph *g, const char *id);
int gr_ephemeral(gr_graph *g, const char *id);
void *gr_owner(gr_graph *g, const char *id);
// a change for a node of the host's own making, at a time
const gr_change *gr_change_new(gr_graph *g, int64_t time, const pr_value *actor, const char *node);
// the object of a node given these versions (value: name NULL); an entry is made if needed,
// and gone if no versions. children: versions' contents are nd_list
void gr_object_set(gr_graph *g, nd_node *n, gr_where where, const char *name,
	const nd_version *vs, size_t count);

// loading: a node in (as who, at the next time), or out (cause is its change)
const gr_error *gr_intro(gr_graph *g, nd_node *node, const gr_acting *who);
void gr_release(gr_graph *g, const char *id, const gr_change *cause);
// a node made as who: loaded, not yet placed. id NULL: a fresh one; has_value 0: none
const gr_error *gr_make(gr_graph *g, const char *id, const nt_value *value, int has_value,
	const gr_acting *who, const char **out);
// an ephemeral node, owned by owner if given
void gr_own(gr_graph *g, const char *id, void *owner);

// what owner reads tracked through
gr_reader *gr_reader_new(gr_graph *g, void *owner);
const pl_depend *gr_depend(gr_reader *r);
void gr_begin(gr_reader *r);
void gr_end(gr_reader *r);
void gr_untrack(gr_reader *r);

// asked as actor; refused (or not known yet: why pending): an error
const gr_error *gr_asking(gr_graph *g, const pr_value *actor, const pr_ask *asks, size_t n,
	const char *op);

// an operation making changes: by whom, then notify told, the readers marked. fn makes the
// changes through the gr_do_* below, and returns an error (NULL: none): then the changes it made
// are kept but nothing is told. snap: objects told whole instead, if they changed
typedef struct {
	const char *id;
	gr_where where; // GR_VALUE, GR_INFO or GR_CHILDREN
	const char *name;
} gr_snap;
typedef struct {
	const void *tag;
	void *own; // not marked by this change
	gr_times *wrote; // the times of the changes made, pushed
	int has_snap;
	const gr_snap *snap;
	size_t nsnap;
} gr_changing_opts;
const gr_error *gr_changing(gr_graph *g, const gr_acting *who, const gr_changing_opts *o,
	const gr_error *(*fn)(void *ctx), void *ctx);
// a change header for a node, in a changing (ticks the clock); NULL outside one
const gr_change *gr_by(gr_graph *g, const char *node);

// places' writes, in a changing, at place [], asked nothing. times: the changes'
const gr_error *gr_do_write(gr_graph *g, const char *const *address, size_t n,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time);
const gr_error *gr_do_set(gr_graph *g, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time);
const gr_error *gr_do_insert(gr_graph *g, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time);
const gr_error *gr_do_remove(gr_graph *g, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time);
const gr_error *gr_do_pop(gr_graph *g, const char *id, const char *name, pl_span slotindex,
	int64_t *time);
const gr_error *gr_do_rename(gr_graph *g, const char *id, const char *name, const char *to,
	int64_t times[2]);
const gr_error *gr_do_move(gr_graph *g, const char *id, const char *name, long index,
	const char *toid, const char *toname, const long *toindex, int64_t times[2], size_t *ntimes);

// an interface: at a place, as an actor; it stops when *alive is 0 (NULL: never)
typedef struct {
	const char *const *place;
	size_t nplace;
	const pr_value *agent;
	const char *reader;
	const pr_value *cause;
	int site;                // the host's site captured on each change
	const pl_depend *depend; // reads tracked by it; NULL: untracked
	int writes;
	const int *alive;
	void *owner;             // may make, place and move ephemeral nodes, owning those it makes
	const void *tag;         // what changes are made with: given to marked
	gr_times *wrote;
} gr_bind;
gr_api *gr_bound(gr_graph *g, const gr_bind *b);

// what an interface gives: items as the actor may have them. refused: why a node is not given
typedef struct {
	pl_item it;
	const pr_value *refused;
} gr_item;
typedef struct {
	gr_item *items;
	size_t n;
} gr_items;

const gr_error *gr_look(gr_api *a, const char *const *address, size_t n, gr_items *out);
const gr_error *gr_lookup(gr_api *a, const char *const *path, size_t n, gr_items *out);
const gr_error *gr_lookups(gr_api *a, const char *const *path, size_t n, gr_items *out);
const gr_error *gr_names(gr_api *a, const char *const *address, size_t n, pl_namelist *out);
const gr_error *gr_children(gr_api *a, const char *const *address, size_t n, const char *name,
	gr_items *out);
const gr_error *gr_content(gr_api *a, const char *const *address, size_t n, gr_items *out);
const gr_error *gr_info(gr_api *a, const char *const *address, size_t n, const char *name,
	gr_items *out);
const gr_error *gr_write(gr_api *a, const char *const *address, size_t n, const nt_patch *patches,
	size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time);
const gr_error *gr_set(gr_api *a, const char *const *address, size_t n, const char *name,
	const nt_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time);
const gr_error *gr_insert(gr_api *a, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, int64_t *time);
const gr_error *gr_remove(gr_api *a, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, int64_t *time);
const gr_error *gr_pop(gr_api *a, const char *id, const char *name, pl_span slotindex,
	int64_t *time);
const gr_error *gr_rename(gr_api *a, const char *id, const char *name, const char *to,
	int64_t times[2]);
const gr_error *gr_move(gr_api *a, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, int64_t times[2], size_t *ntimes);
// a new node holding value (has_value 0: none); an owner may make it ephemeral
const gr_error *gr_create(gr_api *a, const nt_value *value, int has_value, const char *id,
	int ephemeral, const char **out);

#endif
