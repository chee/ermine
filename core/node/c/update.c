// update (update.h), in C: op's apply on a node's value, with its undo.
#include "update.h"

int nd_update(nd_node *node, const op_patch *patches, size_t n, ch_header header,
	size_t *failed) {
	op_undo undo = {0};
	op_apply_options ao = {.undo = &undo, .in_place = node->in_place};
	op_value *after = NULL;
	int code = op_apply(node->value, patches, n, &ao, &after, failed);
	if (code != OP_OK) return code;
	op_free(node->value);
	node->value = after;
	op_undo_free(&node->undo);
	node->undo = undo;
	node->change = header;
	node->change.has_op = 1;
	node->change.patches = patches;
	node->change.patches_length = n;
	node->change.undo = undo.patches;
	node->change.undo_length = undo.n;
	return OP_OK;
}
