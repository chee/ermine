// The undo of patches, in C (invert.ts), on op_values: the same as op_apply's undo option.
// Nothing given is changed. The undo holds its own copies (apply.h), so the caller may op_free the
// value and the patches' values and keep the undo, then op_undo_free it.
#ifndef OP_INVERT_H
#define OP_INVERT_H

#include <stddef.h>

#include "apply.h"

int op_invert(const op_value *value, const op_patch *patches, size_t n, op_undo *out,
	size_t *failed);

#endif
