// Patches applied to an entry's value (changeable/typescript/update.ts), in C: op's apply
// (changeable/c/apply.h) on the value, with the change given along with the patches and their
// undo.
//
// Memory is as in apply.h. The new value is the entry's, and the old is let go, so a caller may
// op_free its own hold of the old value and of the patches' values. The patches are borrowed:
// the entry's change refers to them until the next update or nd_free_entry, so the caller keeps
// them alive until then. The header's actor and reader are borrowed the same way; its frame is
// held by the entry. The undo is the entry's own. A failed call changes nothing.
#ifndef ND_UPDATE_H
#define ND_UPDATE_H

#include <stddef.h>

#include "./node.h"

// Applies the patches in order to the entry's value; its change becomes the header given with
// has_op, the patches as given and their undo. A put at [] makes a missing value, and a removal
// at [] leaves it NULL. An invalid patch returns op's code (op_code_name), sets *failed (may be
// NULL) to the patch's index, and changes nothing. Any op fields in the header are replaced.
int nd_update(nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed);

#endif
