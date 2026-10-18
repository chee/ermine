// update (update.h), in C: op's apply on an entry's value, with its undo.
#include "update.h"

int nd_update(nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed) {
	op_undo undo = {0};
	op_apply_options ao = {.undo = &undo};
	op_value *after = NULL;
	int code = op_apply(entry->value, patches, n, &ao, &after, failed);
	if (code != OP_OK) return code;
	op_free(entry->value);
	entry->value = after;
	op_undo_free(&entry->undo);
	entry->undo = undo;
	entry->change = header;
	entry->change.has_op = 1;
	entry->change.patches = patches;
	entry->change.patches_length = n;
	entry->change.undo = undo.patches;
	entry->change.undo_length = undo.n;
	return OP_OK;
}
