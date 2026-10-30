// Crow (crow/typescript/crow.ts) in C: a root's writes change in place what its own earlier
// writes copied, until someone else has the value. A write copies what it changes and does not
// own, along its patches' paths only, each container shallowly, and owns the copies. cr_let_go
// lets go of all of a root's, so the next write copies again.
//
// root is any pointer standing for what is written through; it is only a key, never looked
// inside or freed here.
//
// Owned: copies made here, and the list a span move takes out. Never a patch's value (an owned
// container in one is let go of first) nor what a write takes out (its undo holds it). A write
// that fails puts back what landed and changes nothing, including what is owned.
//
// Memory: the owned set of a root holds one reference (op_ref) on every container in it, so a
// container in a set is never freed and its address never reused. The reference is released when
// the container leaves the set (a write took it out, cr_let_go, cr_free). The root is the
// caller's; let go of it before it goes.
#ifndef CR_CROW_H
#define CR_CROW_H

#include <stddef.h>

#include "../../changeable/c/apply.h"

typedef struct cr_crow cr_crow;

cr_crow *cr_new(void);
void cr_free(cr_crow *c);

// Applies the patches in order to value (what root holds now), in place where crow owns it.
// Memory is as in op_apply (apply.h): on success *after is the value after (one reference for
// the caller, who lets go of its hold of value) and *undo is the caller's own (op_undo_free).
// Patches are borrowed. An invalid patch returns op's code (op_code_name), sets *failed (may be
// NULL) to its index in the whole write, and changes nothing.
int cr_update(cr_crow *c, const void *root, const op_value *value, const op_patch *patches, size_t n,
	op_value **after, op_undo *undo, size_t *failed);

// Someone else has all of root's value: nothing under it is owned, so the next write copies.
void cr_let_go(cr_crow *c, const void *root);

// Someone else has value (such as a computation's result): every owned container in it, of any
// root, is let go (its reference released), with all under it. subtrees (n of them, or NULL, 0)
// are containers as they came out of a root; at one, only what is owned under it is let go. A
// container seen twice is walked once.
void cr_let_go_in(cr_crow *c, const op_value *value, const op_value *const *subtrees, size_t n);

#endif
