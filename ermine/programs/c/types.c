// Types (types.h), in C.
#include "types.h"

#include <string.h>

#include "mem.h"

void ty_ids_free(ty_ids *ids) {
	for (size_t i = 0; i < ids->n; i++) free(ids->items[i]);
	free(ids->items);
	*ids = (ty_ids){0};
}

const char *const ty_path[TY_DEPTH] = {"ermine", "types"};

static op_value *strings_value(const char *const *list) {
	op_value *a = op_list();
	for (size_t i = 0; list != NULL && list[i] != NULL; i++) op_push(a, op_str(list[i]));
	return a;
}

op_value *ty_value(const ty_known *t) {
	op_value *m = op_map();
	op_set(m, "conformsTo", strings_value(t->conforms));
	op_set(m, "fileNameExtension", strings_value(t->extensions));
	op_set(m, "mimeType", strings_value(t->mimes));
	return m;
}

// writes ----------------------------------------------------------------------------------------

typedef struct {
	const ty_install_setup *s;
	ch_header header;
	pl_made *made;
} writing;

// the id at name in a folder's children, read untracked; NULL: none. Borrowed from the table
static const char *child_of(tb_table *table, const char *folder, const char *name) {
	const nd_entry *e = tb_get(table, tb_string("children"), tb_string(folder));
	const op_value *v = e != NULL ? e->value : NULL;
	if (v == NULL || v->type != OP_MAP) return NULL;
	const op_value *id = op_get(v, name);
	return id != NULL && id->type == OP_STR ? id->str : NULL;
}

// a node's id, kept (the table's key wants it alive)
static const char *made_id(const ty_install_setup *s, const char *const *path, size_t n) {
	char *id;
	if (s->id != NULL) id = s->id(s->ctx, path, n);
	else {
		char *u = pg_uuid();
		id = pg_alloc(strlen(u) + 6);
		strcpy(id, "type:");
		strcat(id, u);
		free(u);
	}
	PG_PUSH(s->ids->items, s->ids->n, s->ids->cap, id);
	return id;
}

// a string kept alive as long as the ids are
static const char *kept(const ty_install_setup *s, const char *text) {
	char *copy = pg_dup(text);
	PG_PUSH(s->ids->items, s->ids->n, s->ids->cap, copy);
	return copy;
}

// value upserted at (part, id) path, committed, the header's block held as the places' writes' are
static void put(writing *w, const char *part, const char *id, const char *const *path, size_t n,
	const op_value *value) {
	const ty_install_setup *s = w->s;
	pl_changed changed;
	nd_entry *node;
	pl_upsert(s->places, tb_string(part), tb_string(id), path, n, value, w->header, &changed, &node);
	s->commit(s->commit_ctx, &changed);
	for (size_t i = 0; i < changed.n; i++) {
		pl_hold_also(s->places, changed.entries[i], pl_made_ref(w->made), pl_made_free);
	}
	if (node != NULL) pl_hold(s->places, node, pl_made_ref(w->made), pl_made_free);
}

int ty_install(const ty_install_setup *s) {
	writing w = {.s = s};
	char *bad = pl_header(s->places, NULL, 0, CH_HERE, &w.header, &w.made);
	if (bad != NULL) {
		free(bad);
		return -1;
	}
	const char *folder = s->root.string;
	for (size_t i = 0; i < TY_DEPTH; i++) {
		const char *there = child_of(s->table, folder, ty_path[i]);
		if (there != NULL) {
			folder = kept(s, there);
			continue;
		}
		const char *id = made_id(s, ty_path, i + 1);
		op_value *v = op_str(id);
		const char *at[] = {ty_path[i]};
		put(&w, "children", folder, at, 1, v);
		op_free(v);
		folder = id;
	}
	// the list, the last of a name winning, in the order each name first came
	size_t n = s->list != NULL ? s->n : ty_well_known_count + ty_extra_count;
	const ty_known **last = pg_alloc(n * sizeof *last), **order = pg_alloc(n * sizeof *order);
	size_t norder = 0;
	for (size_t i = 0; i < n; i++) {
		const ty_known *t = s->list != NULL ? &s->list[i]
		                    : i < ty_well_known_count ? &ty_well_known[i]
		                                              : &ty_extra[i - ty_well_known_count];
		size_t at = norder;
		for (size_t j = 0; j < norder; j++) {
			if (strcmp(order[j]->name, t->name) == 0) at = j;
		}
		if (at == norder) order[norder++] = t;
		last[at] = t;
	}
	const char **named = pg_alloc((norder + 1) * sizeof *named);
	const char **nameids = pg_alloc((norder + 1) * sizeof *nameids);
	size_t nnamed = 0;
	for (size_t i = 0; i < norder; i++) {
		const ty_known *t = last[i];
		const char *id = child_of(s->table, folder, t->name);
		int existing = id != NULL;
		if (existing) id = kept(s, id);
		else {
			const char *path[TY_DEPTH + 1] = {ty_path[0], ty_path[1], t->name};
			id = made_id(s, path, TY_DEPTH + 1);
		}
		op_value *v = ty_value(t);
		put(&w, "value", id, NULL, 0, v);
		op_free(v);
		if (!existing) named[nnamed] = t->name, nameids[nnamed++] = id;
	}
	for (size_t i = 0; i < nnamed; i++) {
		op_value *v = op_str(nameids[i]);
		const char *at[] = {named[i]};
		put(&w, "children", folder, at, 1, v);
		op_free(v);
	}
	free(last), free(order), free(named), free(nameids);
	pl_made_free(w.made);
	return 0;
}

// reads -----------------------------------------------------------------------------------------

int ty_at(pl *p, const char *const *from, size_t nfrom, ty_folder *out) {
	size_t *depths = pg_alloc((nfrom + 1) * sizeof *depths);
	int found = pl_lookup(p, ty_path, TY_DEPTH, from, nfrom, 0, depths) > 0;
	if (found) {
		size_t n = depths[0] + TY_DEPTH;
		const char **path = pg_alloc((n + 1) * sizeof *path);
		for (size_t i = 0; i < depths[0]; i++) path[i] = from[i];
		for (size_t i = 0; i < TY_DEPTH; i++) path[depths[0] + i] = ty_path[i];
		tb_key id;
		found = pl_get(p, path, n, &id) && id.symbol == NULL;
		if (found) {
			out->id = pg_dup(id.string);
			out->path = pg_alloc((n + 1) * sizeof *out->path);
			for (size_t i = 0; i < n; i++) out->path[i] = pg_dup(path[i]);
			out->n = n;
		}
		free(path);
	}
	free(depths);
	return found;
}

void ty_folder_free(ty_folder *f) {
	free(f->id);
	for (size_t i = 0; i < f->n; i++) free(f->path[i]);
	free(f->path);
	*f = (ty_folder){0};
}

// a type's node in the folder; 1 and *out, or 0: none, or a level
static int node_of(pl *p, const ty_folder *folder, const char *uti, tb_key *out) {
	pl_here here = {.id = tb_string(folder->id), .has_path = 1, .path = (const char *const *)folder->path,
		.length = folder->n};
	pl_member m;
	if (pl_walk_at(p, &here, &uti, 1, &m) != 1 || m.id.symbol != NULL) return 0;
	*out = m.id;
	return 1;
}

ty_conformance ty_conform(pl *p, const ty_folder *folder, const char *uti) {
	ty_conformance c = {0};
	size_t cap = 0;
	char *first = pg_dup(uti);
	PG_PUSH(c.all, c.n, cap, first);
	for (size_t i = 0; i < c.n; i++) {
		tb_key id;
		if (folder == NULL || !node_of(p, folder, c.all[i], &id)) continue;
		if (i == 0) c.known = true;
		op_key key = {.type = OP_STR_KEY, .s = "conformsTo"};
		const op_value *up = pl_read(p, tb_string("value"), id, &key, 1);
		if (up == NULL) continue;
		// a string or a list, as the reference reads (strings: a string is one, a list its strings)
		size_t count = up->type == OP_LIST ? up->count : up->type == OP_STR ? 1 : 0;
		for (size_t j = 0; j < count; j++) {
			const op_value *s = up->type == OP_LIST ? up->items[j] : up;
			if (s->type != OP_STR) continue;
			int has = 0;
			for (size_t k = 0; k < c.n; k++) has |= strcmp(c.all[k], s->str) == 0;
			if (!has) {
				char *copy = pg_dup(s->str);
				PG_PUSH(c.all, c.n, cap, copy);
			}
		}
	}
	return c;
}

void ty_conformance_free(ty_conformance *c) {
	for (size_t i = 0; i < c->n; i++) free(c->all[i]);
	free(c->all);
	*c = (ty_conformance){0};
}
