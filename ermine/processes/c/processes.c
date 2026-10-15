// Processes at paths (processes.h), in C.
#include "processes.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("processes: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

// the keys of a path and one name more (extra NULL: none)
static op_key *keys_of(const char *const *path, size_t n, const char *extra) {
	op_key *keys = xalloc((n + 1) * sizeof *keys);
	for (size_t i = 0; i < n; i++) keys[i] = (op_key){.type = OP_STR_KEY, .s = path[i]};
	if (extra != NULL) keys[n] = (op_key){.type = OP_STR_KEY, .s = extra};
	return keys;
}

static int step(void *ctx, const pl_here *here, const char *name, pl *l, tb_key *out) {
	const pr_processes *p = ctx;
	if (!here->has_path) return 0;
	op_key *keys = keys_of(here->path, here->length, name);
	const op_value *v = pl_read(l, tb_string(PR_PART), p->root, keys, here->length + 1);
	free(keys);
	if (v == NULL || v->type != OP_STR) return 0;
	*out = tb_string(v->str);
	return 1;
}

static void names(void *ctx, const pl_here *here, pl *l, pl_namelist *out) {
	const pr_processes *p = ctx;
	if (!here->has_path) return;
	op_key *keys = keys_of(here->path, here->length, NULL);
	pl_keys(l, tb_string(PR_PART), p->root, keys, here->length, 1, out);
	free(keys);
}

void pr_processes_init(pr_processes *p, tb_key root) {
	p->root = root;
	p->contributor = (pl_contributor){"process", step, names, p};
}

// writes --------------------------------------------------------------------------------------

static int bad(const char *name) { return !pl_is_name(name); }

int pr_add(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n, tb_key id,
	ch_header header, pl_changed *changed, nd_entry **made) {
	*changed = (pl_changed){0};
	if (made != NULL) *made = NULL;
	if (n == 0) return PL_NOT_A_NAME;
	for (size_t i = 0; i < n; i++) {
		if (bad(path[i])) return PL_NOT_A_NAME;
	}
	nd_entry *there = tb_get(table, tb_string(PR_PART), root);
	op_value *leaf = op_str(id.string);
	if (there == NULL) {
		op_value *trie = leaf;
		for (size_t i = n; i-- > 0;) {
			op_value *m = op_map();
			op_set(m, path[i], trie);
			trie = m;
		}
		nd_entry *node = nd_make_entry(trie, &header, &(nd_entry_options){.in_place = 1});
		op_free(trie);
		pl_own(l, node);
		tb_add(table, tb_string(PR_PART), root, node);
		if (made != NULL) *made = node;
		return 0;
	}
	const op_value *v = there->value;
	for (size_t i = 0; i < n && is_map(v); i++) {
		v = op_get(v, path[i]);
		if (v != NULL && v->type == OP_STR) {
			op_free(leaf);
			return PL_ALREADY_THERE;
		}
	}
	if (is_map(v) && v->count > 0) {
		op_free(leaf);
		return PL_ALREADY_THERE;
	}
	pl_upsert(l, tb_string(PR_PART), root, path, n, leaf, header, changed, NULL);
	op_free(leaf);
	return 0;
}

// what a stop's patch refers to: kept by the node till its next update
typedef struct {
	op_patch patch;
	op_key *keys;
	char **names;
	size_t n;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < k->n; i++) free(k->names[i]);
	free(k->names);
	free(k->keys);
	free(k);
}

int pr_remove(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n,
	ch_header header, pl_changed *changed) {
	*changed = (pl_changed){0};
	nd_entry *entry = tb_get(table, tb_string(PR_PART), root);
	const op_value **levels = xalloc((n + 1) * sizeof *levels);
	const op_value *v = entry != NULL ? entry->value : NULL;
	for (size_t i = 0; i < n; i++) {
		if (!is_map(v) || op_get(v, path[i]) == NULL) {
			free(levels);
			return PL_NOTHING_THERE;
		}
		levels[i] = v;
		v = op_get(v, path[i]);
	}
	if (entry == NULL || n == 0 || v == NULL || v->type != OP_STR) {
		free(levels);
		return PL_NOTHING_THERE;
	}
	size_t d = n - 1;
	while (d > 0 && levels[d]->count == 1) d--;
	free(levels);
	block *b = xalloc(sizeof *b);
	b->n = d + 1;
	b->names = xalloc(b->n * sizeof *b->names);
	for (size_t i = 0; i < b->n; i++) b->names[i] = xdup(path[i]);
	b->keys = keys_of((const char *const *)b->names, b->n, NULL);
	b->patch = (op_patch){.place = {.path = b->keys, .length = b->n}};
	size_t failed;
	int code = nd_update(entry, &b->patch, 1, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "processes: stop: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(l, entry, b, block_free);
	changed->entries[changed->n++] = entry;
	return 0;
}
