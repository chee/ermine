// Upsert (upsert.h), after typescript/upsert.ts.
#include "upsert.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("upsert: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

// whether two values are the same: maps by their keys (in any order), lists, bytes and typed arrays
// by their elements, a stand-in by its kind
static int same(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return !a->bool_ == !b->bool_;
	case OP_NUM: return op_same_num(a, b);
	case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
	case OP_BYTES: return a->bytes == b->bytes && (!a->bytes || memcmp(a->data, b->data, a->bytes) == 0);
	case OP_TYPED:
		return a->kind == b->kind && a->bytes == b->bytes && (!a->bytes || memcmp(a->data, b->data, a->bytes) == 0);
	case OP_LIST:
	case OP_STAND:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) {
			if (!same(a->items[i], b->items[i])) return 0;
		}
		return 1;
	case OP_MAP:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) {
			if (!same(a->items[i], op_get(b, a->keys[i]))) return 0;
		}
		return 1;
	}
	return 0;
}

// the value nested under names: {a: {b: value}}; a new hold, the caller's
static op_value *nest(const char *const *names, size_t n, const op_value *value) {
	op_value *v = op_ref((op_value *)value);
	for (size_t i = n; i-- > 0;) {
		op_value *m = op_map();
		op_set(m, names[i], v);
		v = m;
	}
	return v;
}

// what the patch of an upsert refers to: kept by the node till its next update
typedef struct {
	op_patch patch;
	op_key *keys;
	char **names;
	size_t n;
	op_value *value;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < k->n; i++) free(k->names[i]);
	free(k->names);
	free(k->keys);
	op_free(k->value);
	free(k);
}

// the one patch of an upsert applied to the entry and held by it
static void write_one(pl *p, nd_entry *entry, block *b, ch_header header, pl_changed *changed,
	int through_unread) {
	size_t failed;
	int code = through_unread ? un_update(pl_unread(p), entry, &b->patch, 1, header, &failed)
	                          : nd_update(entry, &b->patch, 1, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "upsert: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(p, entry, b, block_free);
	changed->entries[changed->n++] = entry;
}

static int upsert(pl *p, tb_table *table, tb_key part, tb_key id, const char *const *path, size_t n,
	const op_value *value, ch_header header, pl_changed *changed, nd_entry **made, int through_unread) {
	*changed = (pl_changed){0};
	if (made != NULL) *made = NULL;
	nd_entry *there = tb_get(table, part, id);
	if (there == NULL) {
		op_value *nested = nest(path, n, value);
		nd_entry *node = nd_make_entry(nested, &header);
		op_free(nested);
		pl_own(p, node);
		if (made != NULL) *made = node;
		tb_add(table, part, id, node);
		return 0;
	}
	// the first level the entry has no map for, or no key at: the nested remainder goes there
	size_t at = n;
	const op_value *v = there->value;
	int missing = 0;
	for (size_t i = 0; i < n; i++) {
		if (!is_map(v)) {
			at = i, missing = 1;
			break;
		}
		const op_value *next = op_get(v, path[i]);
		if (next == NULL) {
			at = i + 1, missing = 1;
			break;
		}
		v = next;
	}
	if (!missing && same(v, value)) return 0;
	block *b = xalloc(sizeof *b);
	b->n = at;
	b->names = xalloc(at * sizeof *b->names);
	b->keys = xalloc(at * sizeof *b->keys);
	for (size_t i = 0; i < at; i++) {
		b->names[i] = xdup(path[i]);
		b->keys[i] = (op_key){.type = OP_STR_KEY, .s = b->names[i]};
	}
	b->value = nest(path + at, n - at, value);
	b->patch = (op_patch){.place = {.path = b->keys, .length = at}, .has_value = 1, .value = b->value};
	write_one(p, there, b, header, changed, through_unread);
	return 0;
}

int up_upsert(pl *p, tb_table *table, tb_key part, tb_key id, const char *const *path, size_t n,
	const op_value *value, ch_header header, pl_changed *changed, nd_entry **made) {
	return upsert(p, table, part, id, path, n, value, header, changed, made, 0);
}

int up_upsert_unread(pl *p, tb_table *table, tb_key part, tb_key id, const char *const *path,
	size_t n, const op_value *value, ch_header header, pl_changed *changed, nd_entry **made) {
	return upsert(p, table, part, id, path, n, value, header, changed, made, 1);
}
