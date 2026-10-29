#include "frame.h"

#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}

ch_frame *ch_frame_make(const ch_pair *pairs, size_t n, ch_frame *parent) {
	ch_frame *f = xalloc(sizeof *f + n * sizeof(ch_pair));
	f->refs = 1;
	f->parent = ch_frame_ref(parent);
	f->pairs = (ch_pair *)(f + 1);
	f->n = n;
	for (size_t i = 0; i < n; i++) {
		f->pairs[i].key = op_name(pairs[i].key);
		f->pairs[i].value = op_ref((op_value *)pairs[i].value);
	}
	return f;
}

ch_frame *ch_frame_ref(ch_frame *f) {
	if (f != NULL) f->refs++;
	return f;
}

void ch_frame_free(ch_frame *f) {
	// up the chain, each frame this one was the last hold of
	while (f != NULL && --f->refs == 0) {
		ch_frame *up = f->parent;
		for (size_t i = 0; i < f->n; i++) {
			op_name_free((char *)f->pairs[i].key);
			op_free((op_value *)f->pairs[i].value);
		}
		free(f);
		f = up;
	}
}

const void *ch_frame_get(const ch_frame *f, const char *key) {
	for (size_t i = 0; f != NULL && i < f->n; i++) {
		if (strcmp(f->pairs[i].key, key) == 0) return f->pairs[i].value;
	}
	return NULL;
}

const void *ch_frame_find(const ch_frame *f, const char *key) {
	for (; f != NULL; f = f->parent) {
		const void *v = ch_frame_get(f, key);
		if (v != NULL) return v;
	}
	return NULL;
}

op_value *ch_locations(const ch_location *at) {
	op_value *place = op_map();
	op_set(place, "file", op_str(at->file != NULL ? at->file : ""));
	op_set(place, "line", op_num((double)at->line));
	if (at->has_column) op_set(place, "column", op_num((double)at->column));
	if (at->function != NULL) op_set(place, "function", op_str(at->function));
	op_set(place, "external", op_bool(1));
	op_value *list = op_list();
	op_push(list, place);
	return list;
}

ch_frame *ch_frame_at(const ch_location *at, ch_frame *parent) {
	op_value *list = ch_locations(at);
	ch_pair pair = {CH_LOCATIONS, list};
	ch_frame *f = ch_frame_make(&pair, 1, parent);
	op_free(list);
	return f;
}

int ch_frame_located(const ch_frame *f) {
	for (; f != NULL; f = f->parent) {
		if (ch_frame_get(f, CH_LOCATIONS) != NULL) return 1;
	}
	return 0;
}

op_value *ch_frame_value(const ch_frame *f) {
	op_value *list = op_list();
	for (; f != NULL; f = f->parent) {
		op_value *info = op_map();
		for (size_t i = 0; i < f->n; i++) {
			op_set(info, f->pairs[i].key, op_ref((op_value *)f->pairs[i].value));
		}
		op_push(list, info);
	}
	return list;
}
