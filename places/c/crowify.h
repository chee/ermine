// crowify: connects the scheduler's runs to a crow, so that a run's result is let go of (and a
// later write copies it) when the run's body returns or it stops to wait.
// subtree_of maps a key a run tracked to the value it gave the run (NULL: none, or not a
// container). Without it, results are walked whole.
#ifndef PL_CROWIFY_H
#define PL_CROWIFY_H

#include <stddef.h>

#include "../../crow/c/crow.h"
#include "../../graph/c/node.h"
#include "../../reactivity/c/scheduler.h"

typedef struct pl_crowified pl_crowified;
pl_crowified *pl_crowify(sc_scheduler *s, cr_crow *c, const op_value *(*subtree_of)(const void *key, void *ctx),
	void *ctx);
// Call before freeing the scheduler.
void pl_crowify_stop(pl_crowified *w);

// nd_update through c. On an invalid patch returns op's code, sets *failed (may be NULL), and
// changes nothing.
int pl_update_entry(cr_crow *c, nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed);

#endif
