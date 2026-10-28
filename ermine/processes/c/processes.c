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

// the key a level holds the id of a process at the level's own path under (no name is "")
#define SELF ""

// the keys of a path and one name more (extra NULL: none)
static op_key *keys_of(const char *const *path, size_t n, const char *extra) {
	op_key *keys = xalloc((n + 1) * sizeof *keys);
	for (size_t i = 0; i < n; i++) keys[i] = (op_key){.type = OP_STR_KEY, .s = path[i]};
	if (extra != NULL) keys[n] = (op_key){.type = OP_STR_KEY, .s = extra};
	return keys;
}

// a leaf: 1 and *out; a level (a map): its own id, else 0 (a walk goes on); nothing, or under a
// leaf: PL_NONE, so the walk asks it nothing more under there (a walk from an id alone: at once, it
// has no path). it reads only what it steps on: what is at the path + name itself, and a level's
// own id, so a start or a stop elsewhere under a level tells a walk through it nothing (the
// hedgehog's wall 2, 10-28: a sibling started reran every reader of a cell)
static int step(void *ctx, const pl_here *here, const char *name, pl *l, tb_key *out) {
	const pr_processes *p = ctx;
	// "" is the key a level holds its own process under, never a name
	if (!here->has_path || strcmp(name, SELF) == 0) return PL_NONE;
	// the path, the name, and room for SELF after it
	op_key *keys = xalloc((here->length + 2) * sizeof *keys);
	for (size_t i = 0; i < here->length; i++) keys[i] = (op_key){.type = OP_STR_KEY, .s = here->path[i]};
	keys[here->length] = (op_key){.type = OP_STR_KEY, .s = name};
	const op_value *v = pl_read_here(l, tb_string(p->part), p->root, keys, here->length + 1);
	if (v == pl_a_map()) {
		keys[here->length + 1] = (op_key){.type = OP_STR_KEY, .s = SELF};
		v = pl_read(l, tb_string(p->part), p->root, keys, here->length + 2);
		free(keys);
		if (v == NULL || v->type != OP_STR) return 0;
		*out = tb_string(v->str);
		return 1;
	}
	free(keys);
	if (v != NULL && v->type == OP_STR) {
		*out = tb_string(v->str);
		return 1;
	}
	return PL_NONE;
}

// no names under here's path: none
static void names(void *ctx, const pl_here *here, pl *l, pl_namelist *out) {
	const pr_processes *p = ctx;
	if (!here->has_path) {
		out->none = 1;
		return;
	}
	op_key *keys = keys_of(here->path, here->length, NULL);
	size_t had = out->n;
	pl_keys(l, tb_string(p->part), p->root, keys, here->length, 0, out);
	free(keys);
	for (size_t i = had; i < out->n; i++) {
		if (strcmp(out->items[i], SELF) == 0) out->items[i--] = out->items[--out->n];
	}
	if (out->n == had) out->none = 1;
}

// a level of the trie (processes deeper, no id of its own): a walk goes on through it
static int level(void *ctx, const pl_here *here, const char *name, pl *l) {
	const pr_processes *p = ctx;
	if (!here->has_path || strcmp(name, SELF) == 0) return 0;
	op_key *keys = keys_of(here->path, here->length, name);
	const op_value *v = pl_read_here(l, tb_string(p->part), p->root, keys, here->length + 1);
	free(keys);
	return v == pl_a_map();
}

void pr_trie_init(pr_processes *p, const char *part, tb_key root, const char *from) {
	p->root = root;
	p->part = part;
	p->contributor = (pl_contributor){from, step, names, level, p};
}

void pr_processes_init(pr_processes *p, tb_key root) { pr_trie_init(p, PR_PART, root, "process"); }

// writes --------------------------------------------------------------------------------------

static int bad(const char *name) { return !pl_is_name(name); }

// what a start's or a stop's patch refers to: kept by the node till its next update
typedef struct {
	op_patch patch;
	op_key *keys;
	char **names;
	size_t n;
	// what a start puts (a stop puts nothing: NULL)
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

// inner under the names, the first outermost: { a: { b: inner } }; inner is taken
static op_value *nest(const char *const *names, size_t n, op_value *inner) {
	for (size_t i = n; i-- > 0;) {
		op_value *m = op_map();
		op_set(m, names[i], inner);
		inner = m;
	}
	return inner;
}

static int add(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, tb_key id, ch_header header, pl_changed *changed, nd_entry **made, int nested);

int pr_add(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n, tb_key id,
	ch_header header, pl_changed *changed, nd_entry **made) {
	return add(l, table, PR_PART, root, path, n, id, header, changed, made, 1);
}

int pr_add_in(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, tb_key id, ch_header header, pl_changed *changed, nd_entry **made) {
	return add(l, table, part, root, path, n, id, header, changed, made, 0);
}

// nested: a process may have processes under it (and be under one); else a leaf above the path or a
// level under it is refused
static int add(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, tb_key id, ch_header header, pl_changed *changed, nd_entry **made, int nested) {
	*changed = (pl_changed){0};
	if (made != NULL) *made = NULL;
	if (n == 0) return PL_NOT_A_NAME;
	for (size_t i = 0; i < n; i++) {
		if (bad(path[i])) return PL_NOT_A_NAME;
	}
	nd_entry *there = tb_get(table, tb_string(part), root);
	op_value *leaf = op_str(id.string);
	if (there == NULL) {
		op_value *trie = nest(path, n, leaf);
		nd_entry *node = nd_make_entry(trie, &header);
		op_free(trie);
		pl_own(l, node);
		if (made != NULL) *made = node;
		tb_add(table, tb_string(part), root, node);
		return 0;
	}
	// the one patch: value at the first at names of the path. the id at the path, unless the path is
	// not all there: then the rest of it, nested, at the first level that is no map (put over) or has
	// no such name
	const op_value *v = there->value;
	op_value *value = leaf;
	size_t at = n;
	int whole = 1;
	for (size_t i = 0; i < n; i++) {
		if (v != NULL && v->type == OP_STR) {
			if (!nested) {
				op_free(leaf);
				return PL_ALREADY_THERE;
			}
			// a leaf above becomes a level: its id under "", the rest of the path beside it
			value = op_map();
			op_set(value, SELF, op_str(v->str));
			op_set(value, path[i], nest(path + i + 1, n - i - 1, leaf));
			at = i, whole = 0;
			break;
		}
		if (!is_map(v)) {
			value = nest(path + i, n - i, leaf);
			at = i, whole = 0;
			break;
		}
		const op_value *next = op_get(v, path[i]);
		if (next == NULL) {
			value = nest(path + i + 1, n - i - 1, leaf);
			at = i + 1, whole = 0;
			break;
		}
		v = next;
	}
	if (whole) {
		if (v->type == OP_STR || (is_map(v) && op_get(v, SELF) != NULL)) {
			op_free(leaf);
			return PL_ALREADY_THERE;
		}
		// a level of processes under the path: the process goes in beside them, under ""
		if (is_map(v) && v->count > 0) {
			if (!nested) {
				op_free(leaf);
				return PL_ALREADY_THERE;
			}
			at = n + 1;
		}
	}
	block *b = xalloc(sizeof *b);
	b->n = at;
	b->names = xalloc(at * sizeof *b->names);
	for (size_t i = 0; i < at; i++) b->names[i] = xdup(i < n ? path[i] : SELF);
	b->keys = keys_of((const char *const *)b->names, at, NULL);
	b->value = value;
	b->patch = (op_patch){.place = {.path = b->keys, .length = at}, .has_value = 1, .value = value};
	size_t failed;
	int code = un_update(pl_unread(l), there, &b->patch, 1, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "processes: add: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(l, there, b, block_free);
	changed->entries[changed->n++] = there;
	return 0;
}

int pr_remove(pl *l, tb_table *table, tb_key root, const char *const *path, size_t n,
	ch_header header, pl_changed *changed) {
	return pr_remove_in(l, table, PR_PART, root, path, n, header, changed);
}

int pr_remove_in(pl *l, tb_table *table, const char *part, tb_key root, const char *const *path,
	size_t n, ch_header header, pl_changed *changed) {
	*changed = (pl_changed){0};
	nd_entry *entry = tb_get(table, tb_string(part), root);
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
	// a process with processes under it: its id is under "" in its level
	const char *const *path_own = path;
	const char **grown = NULL;
	if (is_map(v) && op_get(v, SELF) != NULL) {
		levels[n] = v;
		v = op_get(v, SELF);
		grown = xalloc((n + 1) * sizeof *grown);
		memcpy(grown, path, n * sizeof *grown);
		grown[n] = SELF;
		path_own = (const char *const *)grown;
		n++;
	}
	path = path_own;
	if (entry == NULL || n == 0 || v == NULL || v->type != OP_STR) {
		free(levels);
		free(grown);
		return PL_NOTHING_THERE;
	}
	size_t d = n - 1;
	while (d > 0 && levels[d]->count == 1) d--;
	free(levels);
	block *b = xalloc(sizeof *b);
	b->n = d + 1;
	b->names = xalloc(b->n * sizeof *b->names);
	for (size_t i = 0; i < b->n; i++) b->names[i] = xdup(path[i]);
	free(grown);
	b->keys = keys_of((const char *const *)b->names, b->n, NULL);
	b->patch = (op_patch){.place = {.path = b->keys, .length = b->n}};
	size_t failed;
	int code = un_update(pl_unread(l), entry, &b->patch, 1, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "processes: stop: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(l, entry, b, block_free);
	changed->entries[changed->n++] = entry;
	return 0;
}
