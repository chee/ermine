#include "saved.h"

#include <stdlib.h>
#include <string.h>

// entries in order, a name twice: its first place, the last versions
static sd_entry *entries(const sd_entry *given, size_t length, size_t *out) {
	*out = 0;
	if (length == 0) return NULL;
	sd_entry *es = malloc(length * sizeof *es);
	if (es == NULL) return NULL;
	size_t n = 0;
	for (size_t i = 0; i < length; i++) {
		size_t j = 0;
		while (j < n && strcmp(es[j].name, given[i].name) != 0) j++;
		es[j] = given[i];
		if (j == n) n++;
	}
	*out = n;
	return es;
}

sd_node *sd_make(const char *id, const sd_contents *contents, const sd_header *header,
	const sd_site *outside) {
	sd_node *n = calloc(1, sizeof *n);
	if (n == NULL) return NULL;
	n->id = id;
	if (contents != NULL) {
		n->value = contents->value;
		n->info = entries(contents->info, contents->info_length, &n->info_length);
		n->children = entries(contents->children, contents->children_length, &n->children_length);
		if ((contents->info_length && n->info == NULL) ||
			(contents->children_length && n->children == NULL)) {
			sd_free(n);
			return NULL;
		}
	}
	if (header != NULL) n->header = *header;
	if (outside != NULL && !n->header.has_site) {
		n->header.has_site = 1;
		n->header.site = *outside;
	}
	return n;
}

void sd_free(sd_node *n) {
	if (n == NULL) return;
	free(n->info);
	free(n->children);
	free(n);
}
