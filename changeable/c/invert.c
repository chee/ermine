// invert (invert.h), in C: op_apply with its undo option (apply.c builds the undo as the patches
// land), the value made let go of
#include "invert.h"

int op_invert(const op_value *value, const op_patch *patches, size_t n, op_undo *out,
	size_t *failed) {
	op_undo undo = {0};
	op_apply_options o = {.undo = &undo};
	op_value *end = NULL;
	int code = op_apply(value, patches, n, &o, &end, failed);
	if (code != OP_OK) return code;
	op_free(end);
	*out = undo;
	return OP_OK;
}
