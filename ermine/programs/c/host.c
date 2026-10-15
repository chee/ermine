// Host functions (host.h), in C.
#include "host.h"

#include <string.h>

#include "mem.h"

typedef struct {
	char *name;
	hf_entry entry;
} named;

struct hf {
	named *items;
	size_t n, cap;
};

hf *hf_new(void) { return pg_alloc(sizeof(hf)); }

void hf_free(hf *fs) {
	if (fs == NULL) return;
	for (size_t i = 0; i < fs->n; i++) free(fs->items[i].name);
	free(fs->items);
	free(fs);
}

static void add(hf *fs, const char *name, hf_entry entry) {
	named n = {pg_dup(name), entry};
	PG_PUSH(fs->items, fs->n, fs->cap, n);
}

void hf_add_compiler(hf *fs, const char *name, hf_compiler fn, void *data) {
	add(fs, name, (hf_entry){.compiler = fn, .data = data});
}
void hf_add_runner(hf *fs, const char *name, hf_runner fn, void *data) {
	add(fs, name, (hf_entry){.runner = fn, .data = data});
}

op_value *hf_value(const char *name) {
	op_value *kind = op_map();
	op_set(kind, "function", op_str(name));
	return op_stand(kind);
}

const char *hf_name(const op_value *v) {
	if (v == NULL || v->type != OP_STAND || v->count != 1 || v->items[0]->type != OP_MAP) return NULL;
	const op_value *n = op_get(v->items[0], "function");
	return n != NULL && n->type == OP_STR ? n->str : NULL;
}

bool hf_holds(const op_value *v) {
	if (v == NULL) return false;
	if (hf_name(v) != NULL) return true;
	if (v->type == OP_LIST || v->type == OP_MAP || v->type == OP_STAND) {
		for (size_t i = 0; i < v->count; i++) {
			if (hf_holds(v->items[i])) return true;
		}
	}
	return false;
}

const hf_entry *hf_find(const hf *fs, const op_value *v) {
	const char *name = hf_name(v);
	if (name == NULL || fs == NULL) return NULL;
	for (size_t i = 0; i < fs->n; i++) {
		if (strcmp(fs->items[i].name, name) == 0) return &fs->items[i].entry;
	}
	return NULL;
}
