// Types (types.h), in C.
#include "types.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../encoding/c/cbor.h"
#include "../../processes/c/platform.h"

// calloc and strdup that abort, a growing array, a random id: out of memory aborts
static void *ty_alloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("types: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *ty_dup(const char *s) { return strcpy(ty_alloc(strlen(s) + 1), s); }

#define TY_PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// 8-4-4-4-12 hex, from the system's random bytes
static char *ty_uuid(void) {
	static const char hex[] = "0123456789abcdef";
	unsigned char b[16];
	PF_RANDOM(b, sizeof b);
	char *id = ty_alloc(37);
	size_t at = 0;
	for (size_t i = 0; i < 16; i++) {
		if (i == 4 || i == 6 || i == 8 || i == 10) id[at++] = '-';
		id[at++] = hex[b[i] >> 4];
		id[at++] = hex[b[i] & 15];
	}
	return id;
}

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

// a type's node's value, { conformsTo, filenameExtension, mimeType, referenceURL?, version? }: new
static op_value *ty_value(const ty_known *t) {
	op_value *m = op_map();
	op_set(m, "conformsTo", strings_value(t->conforms));
	op_set(m, "filenameExtension", strings_value(t->extensions));
	op_set(m, "mimeType", strings_value(t->mimes));
	if (t->reference_url != NULL) op_set(m, "referenceURL", op_str(t->reference_url));
	if (t->version != NULL) op_set(m, "version", op_int(*t->version));
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
		char *u = ty_uuid();
		id = ty_alloc(strlen(u) + 6);
		strcpy(id, "type:");
		strcat(id, u);
		free(u);
	}
	TY_PUSH(s->ids->items, s->ids->n, s->ids->cap, id);
	return id;
}

// a string kept alive as long as the ids are
static const char *kept(const ty_install_setup *s, const char *text) {
	char *copy = ty_dup(text);
	TY_PUSH(s->ids->items, s->ids->n, s->ids->cap, copy);
	return copy;
}

// what an update's patches refer to: kept by the entry till its next update
typedef struct {
	op_patch *patches;
	op_key *keys;
	char **names;
	op_value **values;
	size_t n;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < k->n; i++) {
		free(k->names[i]);
		op_free(k->values[i]);
	}
	free(k->patches), free(k->keys), free(k->names), free(k->values);
	free(k);
}

static block *block_new(size_t n) {
	block *b = ty_alloc(sizeof *b);
	b->n = n;
	b->patches = ty_alloc(n * sizeof *b->patches);
	b->keys = ty_alloc(n * sizeof *b->keys);
	b->names = ty_alloc(n * sizeof *b->names);
	b->values = ty_alloc(n * sizeof *b->values);
	return b;
}

// the entry under (part, id) made holding whole (the caller keeps its own hold) and added to the
// table: its event tells readers, so there is nothing to commit
static void make(writing *w, const char *part, const char *id, op_value *whole) {
	const ty_install_setup *s = w->s;
	nd_entry *node = nd_make_entry(whole, &w->header);
	pl_own(s->places, node);
	pl_hold(s->places, node, pl_made_ref(w->made), pl_made_free);
	tb_add(s->table, tb_string(part), tb_string(id), node);
}

// the block's patches applied to the entry, which holds the block, and told committed
static void update_entry(writing *w, nd_entry *there, block *b) {
	const ty_install_setup *s = w->s;
	size_t failed;
	int code = nd_update(there, b->patches, b->n, w->header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "types: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(s->places, there, b, block_free);
	pl_hold_also(s->places, there, pl_made_ref(w->made), pl_made_free);
	pl_changed changed = {1, {there}};
	s->commit(s->commit_ctx, &changed);
}

// whether the entry's value is ours: a map, list or string (all a type's value holds) the same all
// through, a map's keys in any order
static int same(const op_value *there, const op_value *ours) {
	if (there == NULL || there->type != ours->type) return 0;
	switch (ours->type) {
	case OP_STR: return there->bytes == ours->bytes && memcmp(there->str, ours->str, ours->bytes) == 0;
	case OP_LIST:
		if (there->count != ours->count) return 0;
		for (size_t i = 0; i < ours->count; i++) {
			if (!same(there->items[i], ours->items[i])) return 0;
		}
		return 1;
	case OP_MAP:
		if (there->count != ours->count) return 0;
		for (size_t i = 0; i < ours->count; i++) {
			if (!same(op_get(there, ours->keys[i]), ours->items[i])) return 0;
		}
		return 1;
	default: return 0;
	}
}

// the type's value at the node under id: the entry made if none is there, else one patch putting it
// whole over what is there, if that is another
static void put_value(writing *w, const char *id, op_value *value) {
	nd_entry *there = tb_get(w->s->table, tb_string("value"), tb_string(id));
	if (there == NULL) {
		make(w, "value", id, value);
		return;
	}
	if (same(there->value, value)) return;
	block *b = block_new(1);
	b->values[0] = op_ref(value);
	b->patches[0] = (op_patch){.has_value = 1, .value = b->values[0]};
	update_entry(w, there, b);
}

// the names in the folder's children, each the id after it: the entry made holding them if none is
// there; else one patch for each if it holds a map, one putting them as a map over it if not
static void put_names(writing *w, const char *folder, const char *const *names,
	const char *const *ids, size_t n) {
	nd_entry *there = tb_get(w->s->table, tb_string("children"), tb_string(folder));
	int map = there != NULL && there->value != NULL && there->value->type == OP_MAP;
	op_value *all = NULL;
	if (!map) {
		all = op_map();
		for (size_t i = 0; i < n; i++) op_set(all, names[i], op_str(ids[i]));
		if (there == NULL) {
			make(w, "children", folder, all);
			op_free(all);
			return;
		}
	}
	block *b = block_new(map ? n : 1);
	if (!map) {
		b->values[0] = all;
		b->patches[0] = (op_patch){.has_value = 1, .value = all};
	}
	for (size_t i = 0; map && i < n; i++) {
		b->names[i] = ty_dup(names[i]);
		b->keys[i] = (op_key){.type = OP_STR_KEY, .s = b->names[i]};
		b->values[i] = op_str(ids[i]);
		b->patches[i] = (op_patch){.place = {.path = &b->keys[i], .length = 1}, .has_value = 1,
			.value = b->values[i]};
	}
	update_entry(w, there, b);
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
		put_names(&w, folder, &ty_path[i], &id, 1);
		folder = id;
	}
	// the list, the last of a name winning, in the order each name first came
	size_t n = s->list != NULL ? s->n : ty_well_known_count + ty_extra_count;
	const ty_known **last = ty_alloc(n * sizeof *last), **order = ty_alloc(n * sizeof *order);
	size_t norder = 0;
	for (size_t i = 0; i < n; i++) {
		const ty_known *t = s->list != NULL ? &s->list[i]
		                    : i < ty_well_known_count ? &ty_well_known[i]
		                                              : &ty_extra[i - ty_well_known_count];
		size_t at = norder;
		for (size_t j = 0; j < norder; j++) {
			if (strcmp(order[j]->identifier, t->identifier) == 0) at = j;
		}
		if (at == norder) order[norder++] = t;
		last[at] = t;
	}
	const char **named = ty_alloc((norder + 1) * sizeof *named);
	const char **nameids = ty_alloc((norder + 1) * sizeof *nameids);
	size_t nnamed = 0;
	for (size_t i = 0; i < norder; i++) {
		const ty_known *t = last[i];
		const char *id = child_of(s->table, folder, t->identifier);
		int existing = id != NULL;
		if (existing) id = kept(s, id);
		else {
			const char *path[TY_DEPTH + 1] = {ty_path[0], ty_path[1], t->identifier};
			id = made_id(s, path, TY_DEPTH + 1);
		}
		op_value *v = ty_value(t);
		put_value(&w, id, v);
		op_free(v);
		if (!existing) named[nnamed] = t->identifier, nameids[nnamed++] = id;
	}
	if (nnamed > 0) put_names(&w, folder, named, nameids, nnamed);
	free(last), free(order), free(named), free(nameids);
	pl_made_free(w.made);
	return 0;
}

// reads -----------------------------------------------------------------------------------------

int ty_at(pl *p, const char *const *from, size_t nfrom, ty_folder *out) {
	size_t *depths = ty_alloc((nfrom + 1) * sizeof *depths);
	int found = pl_lookup(p, ty_path, TY_DEPTH, from, nfrom, 0, depths) > 0;
	if (found) {
		size_t n = depths[0] + TY_DEPTH;
		const char **path = ty_alloc((n + 1) * sizeof *path);
		for (size_t i = 0; i < depths[0]; i++) path[i] = from[i];
		for (size_t i = 0; i < TY_DEPTH; i++) path[depths[0] + i] = ty_path[i];
		tb_key id;
		found = pl_get(p, path, n, &id) && id.symbol == NULL;
		if (found) {
			out->id = ty_dup(id.string);
			out->path = ty_alloc((n + 1) * sizeof *out->path);
			for (size_t i = 0; i < n; i++) out->path[i] = ty_dup(path[i]);
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
	char *first = ty_dup(uti);
	TY_PUSH(c.all, c.n, cap, first);
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
				char *copy = ty_dup(s->str);
				TY_PUSH(c.all, c.n, cap, copy);
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

// the type of a node ----------------------------------------------------------------------------

// a name with its ASCII capitals lowered: new
static char *lowered(const char *s) {
	char *out = ty_dup(s);
	for (char *c = out; *c; c++) {
		if (*c >= 'A' && *c <= 'Z') *c = (char)(*c + ('a' - 'A'));
	}
	return out;
}

// the order of a folder's names: canonical CBOR's key order (cborKeyCompare: shorter in UTF-8 bytes
// first, then bytewise, a U+0000 held as C0 80 being the one byte 00)
typedef struct {
	const char *name;
	tb_key id;
} named_id;
static int key_order(const void *a, const void *b) {
	const char *x = ((const named_id *)a)->name, *y = ((const named_id *)b)->name;
	return cborKeyCompare(x, strlen(x), y, strlen(y));
}

static const char *claimed(const ty_extensions *e, const char *ext) {
	for (size_t i = 0; i < e->n; i++) {
		if (strcmp(e->items[i].ext, ext) == 0) return e->items[i].uti;
	}
	return NULL;
}

// a folder's members that are nodes, in its order (key_order), their names borrowed from here (the
// caller's, pl_members_free). new: free
static named_id *in_order(pl *p, const ty_folder *folder, pl_members *here, size_t *count) {
	*here = pl_members_at(p, (const char *const *)folder->path, folder->n);
	named_id *sorted = ty_alloc((here->n + 1) * sizeof *sorted);
	*count = 0;
	for (size_t i = 0; i < here->n; i++) {
		if (here->items[i].id.symbol != NULL) continue;
		sorted[(*count)++] = (named_id){here->items[i].name, here->items[i].id};
	}
	qsort(sorted, *count, sizeof *sorted, key_order);
	return sorted;
}

ty_extensions ty_extensions_of(pl *p, const ty_folder *folder) {
	ty_extensions e = {0};
	if (folder == NULL) return e;
	pl_members here;
	size_t count;
	named_id *sorted = in_order(p, folder, &here, &count);
	for (size_t i = 0; i < count; i++) {
		op_key key = {.type = OP_STR_KEY, .s = "filenameExtension"};
		const op_value *v = pl_read(p, tb_string("value"), sorted[i].id, &key, 1);
		if (v == NULL) continue;
		size_t many = v->type == OP_LIST ? v->count : v->type == OP_STR ? 1 : 0;
		for (size_t j = 0; j < many; j++) {
			const op_value *x = v->type == OP_LIST ? v->items[j] : v;
			if (x->type != OP_STR) continue;
			char *ext = lowered(x->str);
			if (claimed(&e, ext) != NULL) {
				free(ext);
				continue;
			}
			ty_claim c = {ext, ty_dup(sorted[i].name)};
			TY_PUSH(e.items, e.n, e.cap, c);
		}
	}
	free(sorted);
	pl_members_free(&here);
	return e;
}

void ty_extensions_free(ty_extensions *e) {
	for (size_t i = 0; i < e->n; i++) free(e->items[i].ext), free(e->items[i].uti);
	free(e->items);
	*e = (ty_extensions){0};
}

const char *ty_by_name(const ty_extensions *e, const char *name) {
	char *lower = lowered(name);
	const char *found = NULL;
	for (const char *dot = strchr(lower + (*lower ? 1 : 0), '.'); dot != NULL && found == NULL;
		dot = strchr(dot + 1, '.')) {
		found = claimed(e, dot + 1);
	}
	free(lower);
	return found;
}

char *ty_type_of(pl *p, const char *id, const char *const *at, size_t n, const ty_extensions *e) {
	op_key key = {.type = OP_STR_KEY, .s = TY_ATTRIBUTE};
	const op_value *t = pl_read(p, tb_string("attributes"), tb_string(id), &key, 1);
	if (t != NULL && t->type == OP_STR) return ty_dup(t->str);
	if (n == 0) return NULL;
	ty_extensions own = {0};
	if (e == NULL) {
		ty_folder f;
		if (ty_at(p, at, n - 1, &f)) {
			own = ty_extensions_of(p, &f);
			ty_folder_free(&f);
		}
		e = &own;
	}
	const char *uti = ty_by_name(e, at[n - 1]);
	char *out = uti != NULL ? ty_dup(uti) : NULL;
	ty_extensions_free(&own);
	return out;
}

// swift's UTType -------------------------------------------------------------------------------

// one field of a type's value, borrowed; undeclared or none: NULL
static const op_value *field(pl *p, const ty_folder *folder, const char *type, const char *name) {
	tb_key id;
	if (folder == NULL || !node_of(p, folder, type, &id)) return NULL;
	op_key key = {.type = OP_STR_KEY, .s = name};
	return pl_read(p, tb_string("value"), id, &key, 1);
}

// a string or a list's i-th string (a string is one, a list its strings); NULL: none
static const char *string_at(const op_value *v, size_t i) {
	if (v == NULL) return NULL;
	if (v->type == OP_STR) return i == 0 ? v->str : NULL;
	if (v->type != OP_LIST) return NULL;
	for (size_t j = 0, k = 0; j < v->count; j++) {
		if (v->items[j]->type != OP_STR) continue;
		if (k++ == i) return v->items[j]->str;
	}
	return NULL;
}

static char *dup_or_null(const char *s) { return s != NULL ? ty_dup(s) : NULL; }

bool ty_is_declared(pl *p, const ty_folder *folder, const char *type) {
	tb_key id;
	return folder != NULL && node_of(p, folder, type, &id);
}

bool ty_is_dynamic(const char *type) { return strncmp(type, "dyn.", 4) == 0; }

bool ty_is_public(const char *type) { return strncmp(type, "public.", 7) == 0; }

char *ty_preferred_filename_extension(pl *p, const ty_folder *folder, const char *type) {
	return dup_or_null(string_at(field(p, folder, type, "filenameExtension"), 0));
}

char *ty_preferred_mime_type(pl *p, const ty_folder *folder, const char *type) {
	return dup_or_null(string_at(field(p, folder, type, "mimeType"), 0));
}

char *ty_reference_url(pl *p, const ty_folder *folder, const char *type) {
	const op_value *v = field(p, folder, type, "referenceURL");
	return v != NULL && v->type == OP_STR ? ty_dup(v->str) : NULL;
}

int ty_version(pl *p, const ty_folder *folder, const char *type, long long *out) {
	const op_value *v = field(p, folder, type, "version");
	if (v == NULL || v->type != OP_NUM) return 0;
	*out = (long long)v->num;
	return 1;
}

ty_conformance ty_supertypes(pl *p, const ty_folder *folder, const char *type) {
	ty_conformance c = ty_conform(p, folder, type);
	free(c.all[0]);
	memmove(c.all, c.all + 1, (c.n - 1) * sizeof *c.all);
	c.n--;
	return c;
}

bool ty_conforms_to(pl *p, const ty_folder *folder, const char *type, const char *to) {
	if (strcmp(type, to) == 0) return true;
	ty_conformance c = ty_conform(p, folder, type);
	bool found = false;
	for (size_t i = 1; i < c.n && !found; i++) found = strcmp(c.all[i], to) == 0;
	ty_conformance_free(&c);
	return found;
}

bool ty_is_subtype_of(pl *p, const ty_folder *folder, const char *type, const char *of) {
	return strcmp(type, of) != 0 && ty_conforms_to(p, folder, type, of);
}

bool ty_is_supertype_of(pl *p, const ty_folder *folder, const char *type, const char *of) {
	return ty_is_subtype_of(p, folder, of, type);
}

// the first type in the folder's order whose field holds tag (any case) and conforms
static char *by_tag(pl *p, const ty_folder *folder, const char *name, const char *tag, const char *to) {
	if (folder == NULL) return NULL;
	char *want = lowered(tag);
	pl_members here;
	size_t count;
	named_id *sorted = in_order(p, folder, &here, &count);
	char *found = NULL;
	for (size_t i = 0; i < count && found == NULL; i++) {
		op_key key = {.type = OP_STR_KEY, .s = name};
		const op_value *v = pl_read(p, tb_string("value"), sorted[i].id, &key, 1);
		bool holds = false;
		for (size_t j = 0; !holds && string_at(v, j) != NULL; j++) {
			char *x = lowered(string_at(v, j));
			holds = strcmp(x, want) == 0;
			free(x);
		}
		if (holds && ty_conforms_to(p, folder, sorted[i].name, to != NULL ? to : TY_DATA)) {
			found = ty_dup(sorted[i].name);
		}
	}
	free(sorted);
	pl_members_free(&here);
	free(want);
	return found;
}

char *ty_from_filename_extension(pl *p, const ty_folder *folder, const char *extension,
	const char *conforming_to) {
	return by_tag(p, folder, "filenameExtension", extension, conforming_to);
}

char *ty_from_mime_type(pl *p, const ty_folder *folder, const char *mime_type, const char *conforming_to) {
	return by_tag(p, folder, "mimeType", mime_type, conforming_to);
}
