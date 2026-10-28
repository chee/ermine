// fronts.c: ephemeral members in front of a name (fronts.h, FRONTS.md).
#include "fronts.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../libraries/upsert/c/upsert.h"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("fronts: out of memory\n", stderr);
		abort();
	}
	return p;
}

static int is_list(const op_value *v) { return v != NULL && v->type == OP_LIST; }

// the list at name under parent, the read told; NULL: none
static const op_value *list_at(pl *l, const char *part, tb_key parent, const char *name) {
	op_key key = {.type = OP_STR_KEY, .s = name};
	const op_value *v = pl_read(l, tb_string(part), parent, &key, 1);
	return is_list(v) ? v : NULL;
}

static int step(void *ctx, const pl_here *here, const char *name, pl *l, tb_key *out) {
	const fr_fronts *f = ctx;
	const op_value *v = list_at(l, f->part, here->id, name);
	if (v == NULL || v->count == 0 || v->items[0]->type != OP_STR) return 0;
	*out = tb_string(v->items[0]->str);
	return 1;
}

static void names(void *ctx, const pl_here *here, pl *l, pl_namelist *out) {
	const fr_fronts *f = ctx;
	pl_keys(l, tb_string(f->part), here->id, NULL, 0, 0, out);
}

void fr_init(fr_fronts *f, const char *part) {
	f->part = part;
	f->contributor = (pl_contributor){"front", step, names, NULL, f};
}

// the list at name, read told to no one (a write's own look)
static const op_value *held(tb_table *table, const char *part, tb_key parent, const char *name) {
	const nd_entry *e = tb_get(table, tb_string(part), parent);
	const op_value *v = e != NULL && e->value != NULL && e->value->type == OP_MAP ? op_get(e->value, name) : NULL;
	return is_list(v) ? v : NULL;
}

static long find(const op_value *list, tb_key id) {
	for (size_t i = 0; list != NULL && i < list->count; i++)
		if (list->items[i]->type == OP_STR && !strcmp(list->items[i]->str, id.string)) return (long)i;
	return -1;
}

int fr_add(pl *l, tb_table *table, const char *part, tb_key parent, const char *name, tb_key id, long at,
	ch_header header, pl_changed *changed, nd_entry **made) {
	*changed = (pl_changed){0};
	if (made != NULL) *made = NULL;
	if (!pl_is_name(name)) return PL_NOT_A_NAME;
	const op_value *was = held(table, part, parent, name);
	if (find(was, id) >= 0) return PL_ALREADY_THERE;
	// the list as it will be: a new one, the id at at
	op_value *list = op_list();
	size_t n = was != NULL ? was->count : 0, k = at < 0 || (size_t)at > n ? n : (size_t)at;
	for (size_t i = 0; i <= n; i++) {
		if (i == k) op_push(list, op_str(id.string));
		if (i < n) op_push(list, op_ref(was->items[i]));
	}
	if (tb_get(table, tb_string(part), parent) == NULL) {
		op_value *map = op_map();
		op_set(map, name, list);
		nd_entry *node = nd_make_entry(map, &header);
		op_free(map);
		pl_own(l, node);
		tb_add(table, tb_string(part), parent, node);
		if (made != NULL) *made = node;
		return 0;
	}
	const char *path[] = {name};
	up_upsert_unread(l, table, tb_string(part), parent, path, 1, list, header, changed, NULL);
	op_free(list);
	return 0;
}

// what a removal's patch refers to: kept by the entry till its next update
typedef struct {
	op_patch patch;
	op_key key;
	char *name;
} block;

static void block_free(void *b) {
	block *k = b;
	free(k->name);
	free(k);
}

int fr_remove(pl *l, tb_table *table, const char *part, tb_key parent, const char *name, tb_key id,
	ch_header header, pl_changed *changed) {
	*changed = (pl_changed){0};
	const op_value *was = held(table, part, parent, name);
	long i = find(was, id);
	if (i < 0) return PL_NOTHING_THERE;
	if (was->count > 1) {
		op_value *list = op_list();
		for (size_t k = 0; k < was->count; k++)
			if ((long)k != i) op_push(list, op_ref(was->items[k]));
		const char *path[] = {name};
		up_upsert_unread(l, table, tb_string(part), parent, path, 1, list, header, changed, NULL);
		op_free(list);
		return 0;
	}
	// the last one: the name taken out, one patch with no value
	nd_entry *entry = tb_get(table, tb_string(part), parent);
	block *b = xalloc(sizeof *b);
	b->name = strdup(name);
	b->key = (op_key){.type = OP_STR_KEY, .s = b->name};
	b->patch = (op_patch){.place = {.path = &b->key, .length = 1}};
	size_t failed;
	int code = un_update(pl_unread(l), entry, &b->patch, 1, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "fronts: remove: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(l, entry, b, block_free);
	changed->entries[changed->n++] = entry;
	return 0;
}

size_t fr_members(pl *l, const char *part, tb_key parent, const char *name, tb_key *out, size_t cap) {
	const op_value *v = list_at(l, part, parent, name);
	size_t n = 0;
	for (size_t i = 0; v != NULL && i < v->count; i++) {
		if (v->items[i]->type != OP_STR) continue;
		if (n < cap) out[n] = tb_string(v->items[i]->str);
		n++;
	}
	// what children has there, after them, unless it is one of them
	pl_here here = {.id = parent};
	pl_answers all = pl_answers_at(l, &here, name);
	for (size_t i = 0; i < all.n; i++) {
		if (all.items[i].from == NULL || strcmp(all.items[i].from, pl_children.from)) continue;
		int seen = 0;
		for (size_t k = 0; v != NULL && k < v->count; k++)
			if (v->items[k]->type == OP_STR && !strcmp(v->items[k]->str, all.items[i].id.string)) seen = 1;
		if (seen) continue;
		if (n < cap) out[n] = all.items[i].id;
		n++;
	}
	pl_answers_free(&all);
	return n;
}
