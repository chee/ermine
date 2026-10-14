#include "node.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

nd_entry *nd_make_entry(op_value *value, const ch_header *header, const nd_entry_options *options) {
	nd_entry *n = calloc(1, sizeof *n);
	if (n == NULL) return NULL;
	if (header != NULL) n->change = *header;
	if (!n->change.has_time) {
		n->change.has_time = 1;
		n->change.time = (int64_t)time(NULL);
	}
	n->in_place = options != NULL && options->in_place;
	n->value = op_ref(value);
	return n;
}

void nd_free_entry(nd_entry *n) {
	if (n == NULL) return;
	op_free(n->value);
	op_undo_free(&n->undo);
	free(n);
}

nd_node nd_make_node(const nd_slot *slots, size_t length) {
	return (nd_node){slots, length};
}

nd_entry *nd_find(const nd_node *n, const char *table) {
	for (size_t i = 0; i < n->length; i++) {
		if (strcmp(n->slots[i].table, table) == 0) return n->slots[i].entry;
	}
	return NULL;
}
