// The undo of patches (core/op/typescript/invert.ts), in C, on op_values (value.h): the patches
// that take what op_apply makes of a value back to the value. Same rules, the same undo, patch for
// patch, as invert.ts:
//   op_apply(op_apply(value, patches), undo) is value
// on op_apply's terms: NULL is nothing there, the list option is op_apply's, a string's positions
// are code points. Patches op_apply refuses: its code and index (op_apply decides).
// The undo is in the order to apply it, the last patch's first; a patch may take several, or none.
// A map's key put back goes last in its order (the canonical encoding sorts keys anyway). A move
// moves back where that is exact; else what it put is undone and what it took put back.
//
// Memory: nothing given is changed. The undo holds its own: its keys copied, and one reference
// (op_ref) on each value it holds, which may share with the value given and the patches' values,
// as op_apply's value does (apply.h). So a caller may op_free those and keep the undo; it lets the
// undo go with op_undo_free. A failed call makes no undo.
#ifndef OP_INVERT_H
#define OP_INVERT_H

#include <stddef.h>

#include "apply.h"

typedef struct {
	op_patch *patches;
	size_t n;
	size_t capacity;
} op_undo;

typedef struct {
	// op_apply's: nothing there starts as [], anything but a list is wrong-kind, a list left empty
	// is nothing
	int list;
} op_invert_options;

// the undo of the patches on value, into *out. invalid: op_apply's code, *failed the patch's
// index (may be NULL), *out left as it was. options may be NULL
int op_invert(const op_value *value, const op_patch *patches, size_t n,
	const op_invert_options *options, op_undo *out, size_t *failed);

// lets go of what the undo holds: its patches, their keys, a reference on each value
void op_undo_free(op_undo *undo);

#endif
