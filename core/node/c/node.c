#include "node.h"

#include <stdlib.h>
#include <string.h>

nd_entry *nd_make_entry(op_value *value, const ch_header *header, const nd_entry_options *options) {
	nd_entry *n = calloc(1, sizeof *n);
	if (n == NULL) return NULL;
	if (header != NULL) n->change = *header;
	if (!n->change.has_time) {
		n->change.has_time = 1;
		n->change.time = ND_NOW();
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

nd_node *nd_make_node(const nd_value *values, size_t length, const ch_header *header,
	const nd_entry_options *options) {
	nd_node *n = calloc(1, sizeof *n);
	if (n == NULL) return NULL;
	n->slots = calloc(length ? length : 1, sizeof *n->slots);
	if (n->slots == NULL) return free(n), NULL;
	// one time for every table
	ch_header h = header != NULL ? *header : (ch_header){0};
	if (!h.has_time) h.has_time = 1, h.time = ND_NOW();
	for (size_t i = 0; i < length; i++) {
		if (values[i].value == NULL) continue;
		nd_entry *e = nd_make_entry(values[i].value, &h, options);
		if (e == NULL) return nd_free_node(n), NULL;
		n->slots[n->length++] = (nd_slot){values[i].table, e};
	}
	return n;
}

void nd_free_node(nd_node *n) {
	if (n == NULL) return;
	for (size_t i = 0; i < n->length; i++) nd_free_entry(n->slots[i].entry);
	free(n->slots);
	free(n);
}

