// The undo of patches (core/changeable/typescript/invert.ts), in C, on op_values (value.h): the patches
// that take what op_apply makes of a value back to the value. Same rules, the same undo, patch for
// patch, as invert.ts:
//   op_apply(op_apply(value, patches), undo) is value
// on op_apply's terms: NULL is nothing there, a string's positions
// are code points. Patches op_apply refuses: its code and index (op_apply decides).
// The undo is in the order to apply it, the last patch's first; a patch may take several, or none.
// A map's key put back goes last in its order (the canonical encoding sorts keys anyway). A move
// moves back where that is exact; else what it put is undone and what it took put back.
//
// op_apply builds it as the patches land (its undo option, apply.h): this is that, as a function.
// Memory: nothing given is changed. The undo holds its own (apply.h): a caller may op_free the
// value and the patches' values and keep the undo; it lets the undo go with op_undo_free. A
// failed call makes no undo.
#ifndef OP_INVERT_H
#define OP_INVERT_H

#include <stddef.h>

#include "apply.h"

// the undo of the patches on value, into *out. invalid: op_apply's code, *failed the patch's
// index (may be NULL), *out left as it was
int op_invert(const op_value *value, const op_patch *patches, size_t n, op_undo *out,
	size_t *failed);

#endif
