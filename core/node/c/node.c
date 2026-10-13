#include "node.h"

#include <stdlib.h>
#include <time.h>

nd_node *nd_make(op_value *value, const ch_header *header) {
	nd_node *n = calloc(1, sizeof *n);
	if (n == NULL) return NULL;
	if (header != NULL) n->change = *header;
	if (!n->change.has_time) {
		n->change.has_time = 1;
		n->change.time = (int64_t)time(NULL);
	}
	n->value = op_ref(value);
	return n;
}

void nd_free(nd_node *n) {
	if (n == NULL) return;
	op_free(n->value);
	op_undo_free(&n->undo);
	free(n);
}
