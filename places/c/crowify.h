// crowify (places/typescript/crowify.ts), in C: crow (crow) and the graph. a scheduler's runs
// told to a crow, each a loan of what it reads, and an entry's write through it
//
// a read in a run tells crow nothing (a look costs nothing); what outlives the run is its result,
// fixed as its body returns: crow lets go of it then (cr_let_go_in), so a write after (its set's, or
// anyone's) never changes it in place. subtree_of: from a key a run tracked, the value that key gave
// it, as it came out of an entry (NULL: none, or not a container): the result's subtrees; with no
// function, results are walked whole. a run's own writes in its body come before its return: in
// place, as any. a run that stops to wait (it ends SC_PENDED) keeps what it read so far across the
// wait: those subtrees are let go of then, so a write while it waits copies them. the scheduler's
// values are taken as op_value * (as the harness world's are)
//
// memory: a run's set holds one reference (op_ref) on each value subtree_of gave, released when the
// run ends or pl_crowify_stop
#ifndef PL_CROWIFY_H
#define PL_CROWIFY_H

#include <stddef.h>

#include "../../crow/c/crow.h"
#include "../../graph/c/node.h"
#include "../../reactivity/c/scheduler.h"

typedef struct pl_crowified pl_crowified;
// s's runs told to c; ctx is passed to subtree_of (which may be NULL). the handle is the caller's
// until pl_crowify_stop
pl_crowified *pl_crowify(sc_scheduler *s, cr_crow *c, const op_value *(*subtree_of)(const void *key, void *ctx),
	void *ctx);
// its listeners removed (before the scheduler is freed), what it held let go of, the handle freed
void pl_crowify_stop(pl_crowified *w);

// nd_update (update.h) for an entry written through c, the entry its root: the patches, in order, to
// the entry's value; its change then the header with has_op, the patches as given and their undo
// (the patches' undos, the last patch's first). memory as nd_update's: patches and header pieces
// borrowed until the next update or nd_free_entry; the undo is the entry's own. op's code on an
// invalid patch, *failed its index in the whole write (may be NULL), and nothing changes
int pl_update_entry(cr_crow *c, nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed);

#endif
