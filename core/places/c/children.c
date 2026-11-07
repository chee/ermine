#include "children.h"
#include "crowify.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("places: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

static int same_key(tb_key a, tb_key b) {
	if (a.symbol != NULL || b.symbol != NULL) return a.symbol == b.symbol;
	return a.string != NULL && b.string != NULL && strcmp(a.string, b.string) == 0;
}

static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

static int child_in(const op_value *v, const char *name, tb_key *out) {
	if (!is_map(v)) return 0;
	const op_value *id = op_get(v, name);
	if (id == NULL || id->type != OP_STR) return 0;
	*out = tb_string(id->str);
	return 1;
}
static int child_of(const nd_entry *children, const char *name, tb_key *out) {
	return child_in(children != NULL ? children->value : NULL, name, out);
}

static int step(void *ctx, const pl_here *here, const char *name, pl *l, tb_key *out) {
	(void)ctx;
	if (same_key(here->id, pl_level())) return 0;
	op_key key = {.type = OP_STR_KEY, .s = name};
	const op_value *v = pl_read(l, tb_string("children"), here->id, &key, 1);
	if (v == NULL || v->type != OP_STR) return 0;
	*out = tb_string(v->str);
	return 1;
}

static void names(void *ctx, const pl_here *here, pl *l, pl_namelist *out) {
	(void)ctx;
	if (same_key(here->id, pl_level())) return;
	pl_keys(l, tb_string("children"), here->id, NULL, 0, 0, out);
}

const pl_contributor pl_children = {"children", step, names, NULL, NULL};

static tb_key key_own(tb_key k) { return k.symbol ? k : tb_string(xdup(k.string)); }
static void key_disown(tb_key k) {
	if (k.symbol == NULL) free((char *)k.string);
}

typedef struct rec rec;
struct rec {
	char *name, *id;
	rec *prev, *next;
};
typedef struct fold fold;
struct fold {
	tb_key folder;
	rec *recs;
	fold *prev, *next;
};
typedef struct {
	pl_slot *items;
	size_t n, cap;
} slots;

static const char folding, naming;

struct pl_index {
	pl_watch *watch;
	tb_table *indexed, *folders, *named;
	fold *folds;
};

static void slot_free(pl_slot *slot) {
	key_disown(slot->folder);
	free((char *)slot->name);
}

static void name_out(pl_index *s, tb_key folder, const char *name) {
	rec *r = tb_get(s->indexed, folder, tb_string(name));
	if (r == NULL) return;
	tb_del(s->indexed, folder, tb_string(name));
	fold *f = tb_get(s->folders, tb_symbol(&folding), folder);
	if (r->prev != NULL) r->prev->next = r->next;
	else f->recs = r->next;
	if (r->next != NULL) r->next->prev = r->prev;
	if (f->recs == NULL) {
		if (f->prev != NULL) f->prev->next = f->next;
		else s->folds = f->next;
		if (f->next != NULL) f->next->prev = f->prev;
		tb_del(s->folders, tb_symbol(&folding), folder);
		key_disown(f->folder);
		free(f);
	}
	slots *list = tb_get(s->named, tb_symbol(&naming), tb_string(r->id));
	size_t i = 0;
	while (!(same_key(list->items[i].folder, folder) && strcmp(list->items[i].name, name) == 0)) i++;
	slot_free(&list->items[i]);
	memmove(&list->items[i], &list->items[i + 1], (list->n - i - 1) * sizeof *list->items);
	if (--list->n == 0) {
		tb_del(s->named, tb_symbol(&naming), tb_string(r->id));
		free(list->items);
		free(list);
	}
	free(r->name);
	free(r->id);
	free(r);
}

// Indexes a name as the entry has it now. A name put over counts as taken out and put in again,
// so it becomes the latest placed.
static void name_in(pl_index *s, tb_key folder, const char *name, const op_value *children) {
	tb_key now;
	int has = child_in(children, name, &now);
	rec *r = tb_get(s->indexed, folder, tb_string(name));
	if (r != NULL && has && strcmp(r->id, now.string) == 0) return;
	name_out(s, folder, name);
	if (!has) return;
	fold *f = tb_get(s->folders, tb_symbol(&folding), folder);
	if (f == NULL) {
		f = xalloc(sizeof *f);
		f->folder = key_own(folder);
		f->next = s->folds;
		if (f->next != NULL) f->next->prev = f;
		s->folds = f;
		tb_add(s->folders, tb_symbol(&folding), folder, f);
	}
	r = xalloc(sizeof *r);
	r->name = xdup(name);
	r->id = xdup(now.string);
	r->next = f->recs;
	if (r->next != NULL) r->next->prev = r;
	f->recs = r;
	tb_add(s->indexed, folder, tb_string(name), r);
	slots *list = tb_get(s->named, tb_symbol(&naming), tb_string(r->id));
	if (list == NULL) {
		list = xalloc(sizeof *list);
		tb_add(s->named, tb_symbol(&naming), tb_string(r->id), list);
	}
	if (list->n == list->cap) {
		list->cap = list->cap ? list->cap * 2 : 2;
		list->items = realloc(list->items, list->cap * sizeof *list->items);
		if (list->items == NULL) abort();
	}
	list->items[list->n++] = (pl_slot){key_own(folder), xdup(name)};
}

static void names_again(pl_index *s, tb_key folder, const nd_entry *entry) {
	fold *f = tb_get(s->folders, tb_symbol(&folding), folder);
	size_t n = 0;
	for (rec *r = f != NULL ? f->recs : NULL; r != NULL; r = r->next) n++;
	// the list changes as names are indexed, so copy its names first
	char **had = xalloc(n * sizeof *had);
	size_t i = n;
	for (rec *r = f != NULL ? f->recs : NULL; r != NULL; r = r->next) had[--i] = xdup(r->name);
	for (i = 0; i < n; i++) {
		name_in(s, folder, had[i], entry != NULL ? entry->value : NULL);
		free(had[i]);
	}
	free(had);
	const op_value *v = entry != NULL ? entry->value : NULL;
	if (v == NULL || v->type != OP_MAP) return;
	for (i = 0; i < v->count; i++) name_in(s, folder, v->keys[i], v);
}

static void names_touched(pl_index *s, tb_key folder, const op_patch *patches, size_t n,
	const nd_entry *entry) {
	for (size_t i = 0; i < n; i++) {
		if (patches[i].place.length == 0 ||
			(patches[i].has_move && patches[i].move.length == 0)) {
			names_again(s, folder, entry);
			return;
		}
	}
	for (size_t i = 0; i < n; i++) {
		if (patches[i].place.path[0].type == OP_STR_KEY) {
			name_in(s, folder, patches[i].place.path[0].s, entry != NULL ? entry->value : NULL);
		}
		if (patches[i].has_move && patches[i].move.path[0].type == OP_STR_KEY) {
			name_in(s, folder, patches[i].move.path[0].s, entry != NULL ? entry->value : NULL);
		}
	}
}

static void told(const pl_fact *f, void *ctx) {
	if (!same_key(f->part, tb_string("children"))) return;
	names_touched(ctx, f->id, f->patches, f->patches_length, f->entry);
}

typedef struct {
	pl_index *s;
	pl *l;
} walking;

static const char walked;

// What the table already names, walked from the root, as TS. Nothing is written while it walks, so
// the folders' keys stay where the children values have them.
static void walk(void *data) {
	walking *w = data;
	tb_table *seen = tb_new();
	size_t n = 0, cap = 1;
	tb_key *folders = xalloc(cap * sizeof *folders);
	folders[n++] = pl_root(w->l);
	while (n > 0) {
		tb_key folder = folders[--n];
		if (tb_get(seen, tb_symbol(&walked), folder) != NULL) continue;
		tb_add(seen, tb_symbol(&walked), folder, (void *)&walked);
		const op_value *v = pl_read(w->l, tb_string("children"), folder, NULL, 0);
		if (!is_map(v)) continue;
		for (size_t i = 0; i < v->count; i++) {
			name_in(w->s, folder, v->keys[i], v);
			const op_value *id = v->items[i];
			if (id == NULL || id->type != OP_STR) continue;
			if (n == cap) {
				cap *= 2;
				folders = realloc(folders, cap * sizeof *folders);
				if (folders == NULL) abort();
			}
			folders[n++] = tb_string(id->str);
		}
	}
	free(folders);
	tb_free(seen);
}

pl_index *pl_index_new(pl *l) {
	pl_index *s = xalloc(sizeof *s);
	s->indexed = tb_new();
	s->folders = tb_new();
	s->named = tb_new();
	s->watch = pl_watch_all(l, told, s);
	pl_peep(l, walk, &(walking){s, l});
	return s;
}

const pl_slot *pl_index_of(const pl_index *s, tb_key id, size_t *n) {
	const slots *list = tb_get(s->named, tb_symbol(&naming), id);
	*n = list != NULL ? list->n : 0;
	return list != NULL ? list->items : NULL;
}

void pl_index_free(pl_index *s) {
	if (s == NULL) return;
	pl_stop(s->watch);
	while (s->folds != NULL) {
		fold *f = s->folds;
		s->folds = f->next;
		while (f->recs != NULL) {
			rec *r = f->recs;
			f->recs = r->next;
			slots *list = tb_get(s->named, tb_symbol(&naming), tb_string(r->id));
			if (list != NULL) {
				for (size_t i = 0; i < list->n; i++) slot_free(&list->items[i]);
				tb_del(s->named, tb_symbol(&naming), tb_string(r->id));
				free(list->items);
				free(list);
			}
			free(r->name);
			free(r->id);
			free(r);
		}
		key_disown(f->folder);
		free(f);
	}
	tb_free(s->indexed);
	tb_free(s->folders);
	tb_free(s->named);
	free(s);
}

static int taken(const nd_entry *children, const char *name) {
	return is_map(children->value) && op_get(children->value, name) != NULL;
}

typedef struct {
	op_patch patches[2];
	op_key keys[3];
	char *names[2];
	op_value *values[2];
	size_t n;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < 2; i++) {
		free(k->names[i]);
		op_free(k->values[i]);
	}
	free(k);
}

static void write(pl *l, nd_entry *entry, block *b, ch_header header, pl_changed *changed) {
	size_t failed;
	int code = pl_update_entry(pl_crow(l), entry, b->patches, b->n, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "places: write: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(l, entry, b, block_free);
	changed->entries[changed->n++] = entry;
}

static block *start(const nd_entry *children) {
	block *b = xalloc(sizeof *b);
	if (!is_map(children->value)) {
		b->values[0] = op_map();
		b->patches[b->n++] = (op_patch){.place = {.path = b->keys}, .has_value = 1, .value = b->values[0]};
	}
	return b;
}

static int do_place(pl *l, nd_entry *children, const char *name, tb_key id, ch_header header,
	pl_changed *changed) {
	if (!pl_is_name(name)) return PL_NOT_A_NAME;
	if (taken(children, name)) return PL_ALREADY_THERE;
	block *b = start(children);
	b->names[0] = xdup(name);
	b->values[1] = op_str(id.string);
	b->keys[1] = (op_key){.type = OP_STR_KEY, .s = b->names[0]};
	b->patches[b->n++] = (op_patch){.place = {.path = &b->keys[1], .length = 1}, .has_value = 1, .value = b->values[1]};
	write(l, children, b, header, changed);
	return 0;
}

static int do_unplace(pl *l, nd_entry *children, const char *name, ch_header header,
	pl_changed *changed) {
	tb_key id;
	if (!child_of(children, name, &id)) return PL_NOTHING_THERE;
	block *b = xalloc(sizeof *b);
	b->names[0] = xdup(name);
	b->keys[0] = (op_key){.type = OP_STR_KEY, .s = b->names[0]};
	b->patches[b->n++] = (op_patch){.place = {.path = &b->keys[0], .length = 1}};
	write(l, children, b, header, changed);
	return 0;
}

static void do_move(pl *l, nd_entry *children, const char *name, const char *to, ch_header header,
	pl_changed *changed) {
	block *b = xalloc(sizeof *b);
	b->names[0] = xdup(name);
	b->names[1] = xdup(to);
	b->keys[0] = (op_key){.type = OP_STR_KEY, .s = b->names[0]};
	b->keys[1] = (op_key){.type = OP_STR_KEY, .s = b->names[1]};
	b->patches[b->n++] = (op_patch){.place = {.path = &b->keys[1], .length = 1}, .has_move = 1, .move = {.path = &b->keys[0], .length = 1}};
	write(l, children, b, header, changed);
}

int pl_place(pl *l, nd_entry *children, const char *name, tb_key id, ch_header header,
	pl_changed *changed) {
	*changed = (pl_changed){0};
	return do_place(l, children, name, id, header, changed);
}

int pl_unplace(pl *l, nd_entry *children, const char *name, ch_header header, pl_changed *changed) {
	*changed = (pl_changed){0};
	return do_unplace(l, children, name, header, changed);
}

int pl_rename(pl *l, nd_entry *children, const char *name, const char *to, ch_header header,
	pl_changed *changed) {
	*changed = (pl_changed){0};
	if (!pl_is_name(to)) return PL_NOT_A_NAME;
	tb_key id;
	if (!child_of(children, name, &id)) return PL_NOTHING_THERE;
	if (strcmp(to, name) == 0) return 0;
	if (taken(children, to)) return PL_ALREADY_THERE;
	do_move(l, children, name, to, header, changed);
	return 0;
}

int pl_move(pl *l, nd_entry *from, const char *name, nd_entry *into, const char *to,
	ch_header header, pl_changed *changed) {
	*changed = (pl_changed){0};
	if (!pl_is_name(to)) return PL_NOT_A_NAME;
	tb_key id;
	if (!child_of(from, name, &id)) return PL_NOTHING_THERE;
	if (from == into) {
		if (strcmp(name, to) == 0) return 0;
		if (taken(from, to)) return PL_ALREADY_THERE;
		do_move(l, from, name, to, header, changed);
		return 0;
	}
	int code = do_place(l, into, to, id, header, changed);
	if (code) return code;
	return do_unplace(l, from, name, header, changed);
}
