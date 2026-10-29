// crow (crow/typescript/crow.ts), in C: a root's writes change in place what its own earlier
// writes copied, until someone else has the value. a write copies what it changes that it does not
// own (along its patches' paths only, each container shallowly: a new list, map or typed array
// holding one reference on each item) and owns the copies; the next write changes those in place,
// as op_apply's in_place does. cr_let_go lets go of all of a root's: what someone else holds is never
// changed under it, and the next write copies again. crow knows nothing of the graph or the scheduler
//
// root: any pointer the caller picks to stand for what it writes through (an entry, with places),
// used only as a key for what crow owns; never looked inside, never freed here
//
// owned: only copies made here, from the root down along the paths written, and the list a span
// move takes out (op_apply gives it to owned as it lands). never a patch's value (op puts it in as
// given: the caller's; an owned container in one, of any root, is let go of first: a walk over
// every container in each patch's value), nor what a write takes out (its undo holds it). each
// patch is owned and applied in the tree the ones before it left. a write that fails puts back
// what landed and changes nothing, which container is where and what is owned too
//
// memory: the owned set of a root holds one reference (op_ref) on every container in it, so
// a container in a set is never freed and its address never reused; released when it leaves the
// set (a write took it out, cr_let_go, cr_free). nothing else is held: so a root's copies live
// until its cr_let_go or cr_free. the root is the caller's; let go of it before it goes
#ifndef CR_CROW_H
#define CR_CROW_H

#include <stddef.h>

#include "../../changeable/c/apply.h"

typedef struct cr_crow cr_crow;

// NULL when out of memory
cr_crow *cr_new(void);
// lets go of everything owned, for every root
void cr_free(cr_crow *c);

// the patches, in order, to value (what root holds now), in place where this owns it. memory as
// op_apply's (apply.h): on success *after is the value after (one reference for the caller, who
// lets go of its hold of value, which may be *after itself in place) and *undo the patches' undos
// (the last patch's first), the caller's own (op_undo_free). patches borrowed. an invalid patch:
// op's code (op_code_name), *failed its index in the whole write (may be NULL), and nothing
// changes, nothing is out, no reference is taken
int cr_update(cr_crow *c, const void *root, const op_value *value, const op_patch *patches, size_t n,
	op_value **after, op_undo *undo, size_t *failed);

// someone else has all of root's value: nothing under it is owned, the next write copies
void cr_let_go(cr_crow *c, const void *root);

// someone else has value (a computation's result, held past now): every owned container in it, of
// any root, let go (its reference released), with all under it. subtrees, n of them (NULL, 0:
// none): containers in it as they came out of a root; at one, what is owned under it is let go
// (only owned ones are walked) and no deeper. the rest walked (lists, maps, typed arrays), a
// container seen twice once: the seen set is made at the first step into a nested container, so a
// flat value makes none
void cr_let_go_in(cr_crow *c, const op_value *value, const op_value *const *subtrees, size_t n);

#endif
