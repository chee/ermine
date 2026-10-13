// The core runtime (main.ts), in C: the libraries hooked up. It holds the table, places, a
// trackgraph and one notify per node; no library knows another. places says what a read rested
// on (depend), the graph tracks it in the trackgraph and asks that node's notify to watch it;
// the graph tells the node's notify of each change, and notify's reads mark the owners that read
// there. protect is asked as the actor before each operation, through a bound interface.
//
// An owner is anything that reads tracked (the scheduler's processes): a pointer the graph
// never reads, only compares, and hands to marked. Same order of operations as main.ts: every
// change, node made and intro ticks the clock where main.ts does.
//
// memory: what a node holds is held, and let go when nothing holds it.
//   - Held: each version a node in the table has holds its content (op_ref; a children list, the
//     graph's own copy of it), its change and its because. A version replaced or removed lets go
//     of them; a node released lets go of all it holds, and a node the graph made (gr_make) goes
//     with it. A node the host introduced keeps what it was given held: the host may read it after.
//   - Borrowed: whatever is given to a call (values, patches, actors, causes, sites, names) is
//     the caller's. The graph takes its own hold on a value it keeps, and copies a change's
//     actor, cause, site and texts into the change. A change is the graph's: gr_change_hold keeps
//     one past the next sweep, gr_change_drop lets that go.
//   - Scratch: what a call gives back (items, names, errors, the interfaces made with scratch)
//     is good until the next gr_sweep, or, made inside gr_enter, until its gr_leave. A hold let go
//     (a version replaced, a node released) is let go at the next gr_sweep, so what was read
//     stays readable until then. A host that never sweeps keeps everything, as before.
// The graph's own (its spots, readers, the ids and names it keeps) stays until gr_free.
// Single threaded. Notify tells each changed object whole (not patch by patch): a write of
// several patches to one object marks its readers once.
#ifndef MAIN_H
#define MAIN_H

#include <stddef.h>
#include <stdint.h>

#include "../../node/c/node.h"
#include "../../scheduler/c/notify.h"
#include "../../places/c/places.h"
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
	// the author's clock, whole seconds since 1970, and a message: optional, never read (CHANGE.tex)
	int has_wallclock;
	int64_t wallclock;
	const char *message;
} gr_change;

// one object a change changed (WIRING.tex, Out), as `changed` is told it: the patches mutate applied,
// in order (none where the operation patched nothing: pop); at: a version (from), a span of
// versions [from, to) replaced by the one made, or versions popped (from, to; a number, or a
// span). Valid for the call only
typedef enum { GR_AT_VERSION, GR_AT_SPAN, GR_AT_POP } gr_at;
typedef struct {
	const char *node;
	gr_where where; // GR_VALUE, GR_INFO or GR_CHILDREN
	const char *name; // info, children
	const op_patch *patches;
	size_t npatches;
	const gr_change *header;
	gr_at at;
	long from, to;
	int ephemeral;
} gr_record;

// a version sync gives gr_versions (WIRING.tex, In). content: an op_value (under children a list of
// ids, a null for a symbol); change: its fields, the graph copies it and sets its time; because:
// where it is in the histories, NULL: none. All borrowed: the graph holds the contents it keeps and
// copies the rest
typedef struct {
	const char *layer;
	int64_t lamport;
	const char *name;
	const char *signer; // NULL: none
} gr_synced;
typedef struct {
	const op_value *content;
	const gr_change *change;
	const gr_synced *because;
} gr_incoming;
// the blop just taken in: its header, signer and name. Its cause comes wrapped as {sync: {signer,
// name}, cause}
typedef struct {
	const pr_value *actor;
	const char *reader;
	const pr_value *site;
	const pr_value *cause;
	const char *signer;
	const char *name;
	// the blop's wallclock and message, when it has them
	int has_wallclock;
	int64_t wallclock;
	const char *message;
} gr_from;

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
	// told, after an operation lands, each object it changed; not by gr_versions, and not for an
	// operation refused or that fails. NULL: none
	void (*changed)(void *ctx, const gr_record *r);
	void *ctx; // given to all of the above
} gr_options;

gr_graph *gr_new(const gr_options *o);
void gr_free(gr_graph *g);
// scratch made between these (the scheduler's request) goes at the last gr_leave
void gr_enter(gr_graph *g);
void gr_leave(gr_graph *g);
// the host's scratch freed, and every hold let go since the last sweep let go now: call it where
// nothing the graph gave is still in use. Inside gr_enter: nothing
void gr_sweep(gr_graph *g);
// a hold of v let go at the next sweep (op_free then)
void gr_later(gr_graph *g, op_value *v);
// an error copied into the host's scratch: good until the next sweep, past gr_leave. A "stop"
// is given back as it is
const gr_error *gr_error_keep(gr_graph *g, const gr_error *e);
// a copy of c of the graph's own (actor, cause, site and texts with it); its one hold goes at the
// next sweep
const gr_change *gr_change_copy(gr_graph *g, const gr_change *c);
// a change of the graph's kept past the next sweep, until the drop (let go of at the sweep after);
// any other pointer: nothing
void gr_change_hold(gr_graph *g, const gr_change *c);
void gr_change_drop(gr_graph *g, const gr_change *c);
// kept until gr_free
pr_arena *gr_pr_arena(gr_graph *g);
void *gr_alloc(gr_graph *g, size_t n);
char *gr_dup(gr_graph *g, const char *s);
// protect's value from ours, in scratch (null for a live value or absent)
pr_value *gr_pr(gr_graph *g, const op_value *v);

nd_node *gr_get(gr_graph *g, const char *id);
int gr_ephemeral(gr_graph *g, const char *id);
void *gr_owner(gr_graph *g, const char *id);
// a change for a node of the host's own making, at a time: the host's, never let go of
const gr_change *gr_change_new(gr_graph *g, int64_t time, const pr_value *actor, const char *node);
// the object of a node given these versions (value: name NULL); an entry is made if needed,
// and gone if no versions. children: versions' contents are nd_list
void gr_object_set(gr_graph *g, nd_node *n, gr_where where, const char *name,
	const nd_version *vs, size_t count);

// loading: a node in (as who, at the next time), or out (cause is its change)
const gr_error *gr_intro(gr_graph *g, nd_node *node, const gr_acting *who);
void gr_release(gr_graph *g, const char *id, const gr_change *cause);
// a node made as who: loaded, not yet placed. id NULL: a fresh one; has_value 0: none
const gr_error *gr_make(gr_graph *g, const char *id, const op_value *value, int has_value,
	const gr_acting *who, const char **out);
// the same, ephemeral if own, owned by owner if not NULL: the record a node made with a value makes
// (WIRING.tex, Out) is then ephemeral
const gr_error *gr_make_own(gr_graph *g, const char *id, const op_value *value, int has_value,
	const gr_acting *who, int own, void *owner, const char **out);
// an ephemeral node, owned by owner if given
void gr_own(gr_graph *g, const char *id, void *owner);

// INTERNAL AND DANGEROUS (WIRING.tex, In): not in the interface a host or a program gets. Only sync
// calls it, and only with APPLY.tex's versions of that object, from the histories. It throws away the
// object's versions and puts list in their place, local ones included: anything not in list is
// gone. It is not a patch: no mutate, so nothing checks that list follows from what was there.
// protect is not asked: sync is a privileged runner. It makes no record, so what it writes is never
// sent: called with anything but what the histories say, the device silently differs from every other
// until a blop for that object is taken in, and a change made in between is committed against the
// wrong version.
// from: the blop just taken in; its header marks the readers. NULL: the header of the first version
// that has a because. Versions already there (the same place, a because's name) are kept as they
// are; the others get the time of this one change from elsewhere. An id not in memory: nothing
void gr_versions(gr_graph *g, const char *id, gr_where where, const char *name,
	const gr_incoming *list, size_t count, const gr_from *from);

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
	// the operation reports its own records (the api's); else the changes made here are reported
	// (WIRING.tex, Out), so that every change makes them
	int reported;
	int has_snap;
	const gr_snap *snap;
	size_t nsnap;
} gr_changing_opts;
const gr_error *gr_changing(gr_graph *g, const gr_acting *who, const gr_changing_opts *o,
	const gr_error *(*fn)(void *ctx), void *ctx);
// a change header for a node, in a changing (ticks the clock); NULL outside one
const gr_change *gr_by(gr_graph *g, const char *node);
// the same, told as what touched that object of the node: a changing that tells it whole (snap)
// tells it by this change (name NULL for the value)
const gr_change *gr_by_at(gr_graph *g, const char *node, gr_where where, const char *name);
// the places the graph reads and places by: its table, its root, gr_by
const pl_places *gr_places(gr_graph *g);

// places' writes, in a changing, at place [], asked nothing. times: the changes'
const gr_error *gr_do_write(gr_graph *g, const char *const *address, size_t n,
	const op_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time);
const gr_error *gr_do_set(gr_graph *g, const char *const *address, size_t n, const char *name,
	const op_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
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

typedef struct gr_items gr_items;
typedef struct gr_read gr_read;

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
	int scratch;             // the interface made in scratch (main.h, memory); else kept until gr_free
	// around each read (NULL: made, tracked by depend): it makes it with gr_read_make
	const gr_error *(*reading)(void *ctx, gr_read *r);
	// around each change (NULL: fn run): runs fn(arg) and answers its error
	const gr_error *(*around)(void *ctx, const gr_error *(*fn)(void *arg), void *arg);
	void *ctx; // given to reading and around
} gr_bind;
gr_api *gr_bound(gr_graph *g, const gr_bind *b);

// what an interface gives: items as the actor may have them. refused: why a node is not given
typedef struct {
	pl_item it;
	const pr_value *refused;
} gr_item;
struct gr_items {
	gr_item *items;
	size_t n;
};

// a read an interface makes, as reading is handed it: its op (look lookup lookups children
// content info), address and name (children's, info's; NULL: none); once made, what it gave:
// items, or for children with no name the names
struct gr_read {
	const char *op;
	const char *const *address;
	size_t n;
	const char *name;
	int is_names;
	gr_items items;
	pl_namelist names;
	gr_api *api;
	int kind;
};
// the read made as its interface makes it, tracked by depend (NULL: untracked)
const gr_error *gr_read_make(gr_read *r, const pl_depend *depend);

const gr_error *gr_look(gr_api *a, const char *const *address, size_t n, gr_items *out);
const gr_error *gr_lookup(gr_api *a, const char *const *path, size_t n, gr_items *out);
const gr_error *gr_lookups(gr_api *a, const char *const *path, size_t n, gr_items *out);
const gr_error *gr_names(gr_api *a, const char *const *address, size_t n, pl_namelist *out);
// the names of a node's "info" or "children" (else wrong-field), in order; children's is gr_names.
// each node must be listable (protect's list ask), as for gr_names
const gr_error *gr_names_of(gr_api *a, const char *const *address, size_t n, const char *part,
	pl_namelist *out);
const gr_error *gr_children(gr_api *a, const char *const *address, size_t n, const char *name,
	gr_items *out);
const gr_error *gr_content(gr_api *a, const char *const *address, size_t n, gr_items *out);
const gr_error *gr_info(gr_api *a, const char *const *address, size_t n, const char *name,
	gr_items *out);
const gr_error *gr_write(gr_api *a, const char *const *address, size_t n, const op_patch *patches,
	size_t np, const long *index, const pl_span *slotindex, int span,
	int64_t *time);
const gr_error *gr_set(gr_api *a, const char *const *address, size_t n, const char *name,
	const op_patch *patches, size_t np, const long *index, const pl_span *slotindex, int span,
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
// the whole node of an id (*out NULL: not loaded, or refused), read as a look by id is: every
// object of it said read. reading is handed it as op "node", address {pl_id, id}
const gr_error *gr_node(gr_api *a, const char *id, const nd_node **out);
// the same interface, its changes carrying cause (borrowed, as a bind's); in scratch (memory,
// above), as long as a is and scratch lasts
gr_api *gr_as(gr_api *a, const pr_value *cause);
// a new node holding value (has_value 0: none); an owner may make it ephemeral
const gr_error *gr_create(gr_api *a, const op_value *value, int has_value, const char *id,
	int ephemeral, const char **out);

#endif
