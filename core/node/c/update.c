// update (update.h), in C: op's apply and invert on a node's value.
#include "update.h"

#include <stdio.h>
#include <stdlib.h>

// the facts of each patch, kept until the node has its value
typedef struct {
	op_facts *facts;
	size_t count;
} kept;

static void keep(void *ctx, const op_patch *patch, const op_facts *facts) {
	(void)patch;
	kept *k = ctx;
	k->facts[k->count++] = *facts;
}

int nd_update(nd_node *node, const op_patch *patches, size_t n, ch_header header,
	const nd_update_options *options, size_t *failed) {
	int list = options != NULL && options->list;
	int telling = options != NULL && options->each != NULL;
	kept seen = {NULL, 0};
	op_apply_options ao = {.list = list};
	if (telling) {
		seen.facts = malloc((n ? n : 1) * sizeof *seen.facts);
		if (seen.facts == NULL) {
			fputs("update: out of memory\n", stderr);
			abort();
		}
		ao.each = keep;
		ao.ctx = &seen;
	}
	op_value *after = NULL;
	int code = op_apply(node->value, patches, n, &ao, &after, failed);
	if (code != OP_OK) {
		free(seen.facts);
		return code;
	}
	op_undo undo = {0};
	op_invert_options io = {.list = list};
	code = op_invert(node->value, patches, n, &io, &undo, failed);
	if (code != OP_OK) {
		// apply decided the patches are valid: not reached
		op_free(after);
		free(seen.facts);
		return code;
	}
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
	for (size_t i = 0; i < seen.count; i++) options->each(options->ctx, &patches[i], &seen.facts[i]);
	free(seen.facts);
	return OP_OK;
}
