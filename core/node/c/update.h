// Patches applied to a node's value (core/node/typescript/update.ts), in C: op's apply
// (core/op/c/apply.h) on the value, and the change given with the patches and their undo (apply's
// undo option, invert.h's). Same rules as update.ts.
//
// Memory: as apply.h. The new value is the node's: it takes the hold apply made, and lets go of
// the old (a caller may op_free its own hold of the old value, and of the patches' values, and the
// new stays whole). The patches are borrowed, not copied: the node's change refers to them (and
// their keys and values) until the next update or nd_free, so the caller keeps them alive until
// then. The header's pieces (external, metadata, actor, ...) are borrowed the same way. The undo is the
// node's own, let go of by the next update or nd_free. A failed call changes nothing and takes
// no reference.
#ifndef ND_UPDATE_H
#define ND_UPDATE_H

#include <stddef.h>

#include "node.h"

typedef struct {
	// as apply's: nothing there starts as [], anything but a list is wrong-kind, and a list
	// left empty is nothing
	int list;
} nd_update_options;

// the patches, in order, to the node's value; its change is then the header given with has_op, the
// patches as given and their undo. The value: none there, a put at [] makes it; nothing left (a
// removal at [], or a list left empty), the value is NULL. An invalid patch: op's code
// (op_code_name), *failed the patch's index (may be NULL), and nothing changes. options may be
// NULL. The header's own op fields, if any, are replaced
int nd_update(nd_node *node, const op_patch *patches, size_t n, ch_header header,
	const nd_update_options *options, size_t *failed);

#endif
