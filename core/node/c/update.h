// Patches applied to an entry's value (core/node/typescript/update.ts), in C: op's apply
// (core/changeable/c/apply.h) on the value, and the change given with the patches and their undo (apply's
// undo option, invert.h's). Same rules as update.ts.
//
// Memory: as apply.h. The new value is the entry's: it takes the hold apply made, and lets go of
// the old (a caller may op_free its own hold of the old value, and of the patches' values, and the
// new stays whole). The patches are borrowed, not copied: the entry's change refers to them (and
// their keys and values) until the next update or nd_free_entry, so the caller keeps them alive until
// then. The header's pieces (external, metadata, actor, ...) are borrowed the same way. The undo is the
// entry's own, let go of by the next update or nd_free_entry. A failed call changes nothing and takes
// no reference.
#ifndef ND_UPDATE_H
#define ND_UPDATE_H

#include <stddef.h>

#include "node.h"

// the patches, in order, to the entry's value; its change is then the header given with has_op, the
// patches as given and their undo. The value: none there, a put at [] makes it; nothing left (a
// removal at []), the value is NULL. An invalid patch: op's code
// (op_code_name), *failed the patch's index (may be NULL), and nothing changes. The header's own
// op fields, if any, are replaced
int nd_update(nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed);

#endif
