// Link (typescript/link.ts), in C: the connections between the store, the tracked paths and the
// scheduler, set up once by whoever makes them. It makes none of them and wraps none of their calls:
// callers use places and the store themselves, with a scope open. Same rules as link.ts, which the
// suite in ermine/link/conformance/link/ holds both to.
//
//   lk *l = lk_new();                                  // only itself: it is the ctx of the hooks
//   st_store *store = st_new(lk_event, l);
//   pl *places = pl_new(&(pl_setup){.., .read = lk_read, .ctx = l});
//   sc_scheduler *s = sc_new((sc_options){.., .forget = lk_forget, .data = l});
//   lk_connect(l, &(lk_setup){store, paths, s});
//   ...
//   lk_wrote(l, &changed);                             // after pl_place(.., header, .., &changed)
//
// A read is told to the scheduler as a spot (paths.h), so a run reading tracks it; a read outside a
// run counts for nothing. A write says changed the spots its patches mark, at every key the node is
// under; a table event, the spots of its key. Both by the writer open (sc_current_by), none: from
// outside. The status of the reads told (SC_STOP: the run must end now; SC_CLOSED: it has returned)
// is given by lk_status.
//
// Paths keys a spot by two parts, (source, id); the store by three. The first two go into one pair
// per (source, part), made once and kept: the same address always, so the same key by identity. The
// store's part is a name, any string; "children" is places' hole. A spot nobody reads any more is
// let go: the scheduler's forget calls lk_forget with each key it stops tracking. A spot read
// outside a run is tracked by none, so never let go.
//
// lk_spot names a key told to the scheduler: one of this link's spots, held, is where it reads, so
// a run's reads (the scheduler's ends moment) can be named as places in the graph. Anything else,
// or a spot let go, is none.
//
// WHO. The pairs of a write are the info of the scopes open, from the root down (sc_pairs), then
// the call's own. Their values are op_values (value.h), the host's own, except the scheduler's:
// "run" and "mark" are numbers it keeps as uint64_t, and are given on as op_value numbers. The
// first "actor" pair is the actor, the first "reader" (a string) the reader, every other pair
// metadata, in order. A write with no scope open has no who: unscoped.
//
// MEMORY. A header made (lk_header) refers to a block, an lk_made: the metadata, the site, a hold
// on each value. The node it is written to refers to the block until its next update: lk_hold keeps
// it till then. A value a read gives is borrowed from the store. Out of memory aborts.
#ifndef LINK_H
#define LINK_H

#include <stddef.h>

#include "../../../core/places/c/places.h"
#include "../../../core/scheduler/c/paths.h"
#include "../../../core/scheduler/c/scheduler.h"
#include "../../store/c/store.h"

typedef struct lk lk;
// only the link, so that it can be the ctx of the hooks below
lk *lk_new(void);
// forgets the holds and the pairs; none of what it was connected to
void lk_free(lk *l);

// what the hooks were given to, made already; the link keeps none of them
typedef struct {
	st_store *store;
	pt_paths *paths;
	sc_scheduler *scheduler;
} lk_setup;
// once: before anything is read or written
void lk_connect(lk *l, const lk_setup *setup);

// hooks, ctx the lk
// places' read: the spot of the children of id as source has them, at name (NULL: the whole
// value), or only which names there are (keys); told to the scheduler
void lk_read(void *ctx, tb_key source, tb_key id, const char *name, int keys);
// the store's: a table event says changed every spot of its key
void lk_event(void *ctx, tb_key source, const char *part, tb_key id);
// the scheduler's: a key that is one of this link's spots is released; any other is left alone
void lk_forget(const void *key, void *ctx);

// the first answer that was not SC_OK to the reads told since this was last asked; then SC_OK
sc_read_status lk_status(lk *l);

// writes ----------------------------------------------------------------------------------------

// after a write: the spots its patches mark, said changed
void lk_wrote(lk *l, const pl_changed *changed);

// reads -----------------------------------------------------------------------------------------

// what is at path in a value: a number into a list or a typed array, a name into a map; nothing
// there: NULL. Bytes are one whole value: a number into them is nothing. A typed array's element
// is no op_value of the value, so it is made in scratch (a number, set each time) and scratch is
// returned: good until the next call with it. 64-bit elements come as doubles, rounded past 2^53.
// scratch NULL: a typed array's element is nothing
const op_value *lk_at(const op_value *v, const op_key *path, size_t n, op_value *scratch);
// what is at path in the value of the node under (source, part, id), the read told. The path is
// copied by paths. NULL: nothing there. Borrowed: good until the node changes, or, for a typed
// array's element (the link's one scratch number), until the next lk_get on this link
const op_value *lk_get(lk *l, tb_key source, const char *part, tb_key id, const op_key *path,
	size_t n);
// the change of the node under (source, part, id), the read told at its change spot: any write to
// the node reruns it. NULL: none there. Borrowed
const ch_header *lk_change(lk *l, tb_key source, const char *part, tb_key id);

// where a spot reads: the node under (source, part, id), and the path in its value, length keys;
// change: the change spot, reads of the change itself, no path. The link's and paths' own, good
// while the spot is held
typedef struct {
	tb_key source;
	const char *part;
	tb_key id;
	const op_key *path;
	size_t length;
	int change;
} lk_where;
// a key told to the scheduler (as a run's ends moment has it): when it is one of this link's
// spots, held, 1 and *out where it reads; anything else, or a spot let go: 0
int lk_spot(const lk *l, const void *key, lk_where *out);

// who ------------------------------------------------------------------------------------------

// who the scope open says a write is, extra (n pairs) after its pairs: a map of actor, reader and
// metadata (a list of [key, value]) where there are some. New, the caller's to op_free. NULL: no
// scope open
op_value *lk_who(lk *l, const sc_pair *extra, size_t n);

// a header made now, with the scope open
typedef struct lk_made lk_made;
// the header of a write made now: who (above), the time now in whole seconds, and the site (copied;
// NULL: none; CH_HERE is the caller's own). *made is its block: the caller's, to lk_made_free, or
// to lk_hold. A failure is an error string (fresh; the caller frees it), SC_UNSCOPED when no scope
// is open; *out and *made are not set
char *lk_header(lk *l, const sc_pair *extra, size_t n, const ch_site *site, ch_header *out,
	lk_made **made);
// one more hold of the block, for one more node to refer to it
lk_made *lk_made_ref(lk_made *made);
// lets one hold go; the last frees the block. For lk_hold's release
void lk_made_free(void *made);

// keeps something alive for the node's change to refer to (a header's block, a write's patches):
// release(block) is called when the next lk_hold for the same node comes, or at lk_free
void lk_hold(lk *l, const nd_entry *node, void *block, void (*release)(void *block));

#endif
