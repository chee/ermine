// Places (places.h), in C.
#include "places.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("places: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// a pair: a part, a string copied; and the next of the pairs made (to free them)
typedef struct {
	tb_key part;
} pl_pair;
typedef struct pair pair;
struct pair {
	pl_pair pair;
	pair *next;
};

// a block kept for a node's change
typedef struct hold hold;
struct hold {
	void *block;
	void (*release)(void *block);
	hold *prev, *next;
	// the next hold of the same node
	hold *chain;
};

struct pl {
	tb_key root;
	tb_table *table;
	pt_paths *paths;
	sc_scheduler *scheduler;
	// the pairs by (the one part, the part), and in a list
	tb_table *pairs;
	pair *all;
	// the spots this places made, by (the one part, the spot). forget finds its own in it
	tb_table *mine;
	// a typed array's element read by pl_read: the one number, remade by each
	op_value scratch;
	// the first answer that was not SC_OK to the reads told
	sc_read_status status;
	// what writes asked to be kept, by node, and in a list
	tb_table *holds;
	hold *held;
};

// the part of the key every spot of this places is under in `mine`
static const char spots;
static tb_key spot_part(void) { return tb_symbol(&spots); }

static pt_key paths_key(tb_key k) { return (pt_key){.string = k.string, .symbol = k.symbol}; }

// the part of the key every pair is under in `pairs`
static const char pairing;

// the one pair of the part: its address is the key paths gets as a spot's source
static const pl_pair *pair_of(pl *l, tb_key part) {
	pair *p = tb_get(l->pairs, tb_symbol(&pairing), part);
	if (p != NULL) return &p->pair;
	p = xalloc(sizeof *p);
	p->pair.part = part.symbol ? part : tb_string(xdup(part.string));
	p->next = l->all;
	l->all = p;
	tb_add(l->pairs, tb_symbol(&pairing), part, p);
	return &p->pair;
}
static pt_key pair_key(pl *l, tb_key part) { return pt_symbol(pair_of(l, part)); }

// new, connected, and free ----------------------------------------------------------------------

pl *pl_new(void) {
	pl *l = xalloc(sizeof *l);
	l->pairs = tb_new();
	l->mine = tb_new();
	l->holds = tb_new();
	return l;
}

void pl_connect(pl *l, const pl_setup *setup) {
	l->root = setup->root;
	l->table = setup->table;
	l->paths = setup->paths;
	l->scheduler = setup->scheduler;
}

static void unhold(pl *l, hold *h) {
	if (h->prev != NULL) h->prev->next = h->next;
	else l->held = h->next;
	if (h->next != NULL) h->next->prev = h->prev;
	h->release(h->block);
	free(h);
}

void pl_free(pl *l) {
	if (l == NULL) return;
	while (l->held != NULL) unhold(l, l->held);
	tb_free(l->holds);
	tb_free(l->mine);
	tb_free(l->pairs);
	while (l->all != NULL) {
		pair *p = l->all;
		l->all = p->next;
		if (p->pair.part.symbol == NULL) free((char *)p->pair.part.string);
		free(p);
	}
	free(l);
}

static const char holding;

// lets go of the holds of a node, from the first
static void unhold_chain(pl *l, hold *h) {
	while (h != NULL) {
		hold *next = h->chain;
		unhold(l, h);
		h = next;
	}
}

static void hold_node(pl *l, const nd_entry *node, void *block, void (*release)(void *block),
	int also) {
	tb_key part = tb_symbol(&holding), where = tb_symbol(node);
	hold *old = tb_get(l->holds, part, where);
	hold *h = xalloc(sizeof *h);
	h->block = block;
	h->release = release;
	h->next = l->held;
	if (h->next != NULL) h->next->prev = h;
	l->held = h;
	if (also) h->chain = old;
	else unhold_chain(l, old);
	tb_sub(l->holds, part, where, h);
}

void pl_hold(pl *l, const nd_entry *node, void *block, void (*release)(void *block)) {
	hold_node(l, node, block, release, 0);
}
void pl_hold_also(pl *l, const nd_entry *node, void *block, void (*release)(void *block)) {
	hold_node(l, node, block, release, 1);
}

// reads -----------------------------------------------------------------------------------------

sc_read_status pl_status(pl *l) {
	sc_read_status status = l->status;
	l->status = SC_OK;
	return status;
}

// a spot of this places's, told to the scheduler (a read outside a run counts for nothing)
static void tell(pl *l, pt_spot *s) {
	if (tb_get(l->mine, spot_part(), tb_symbol(s)) == NULL) tb_add(l->mine, spot_part(), tb_symbol(s), s);
	sc_read_status status = sc_read(l->scheduler, s);
	if (status != SC_OK && l->status == SC_OK) l->status = status;
}

int pl_spot(const pl *l, const void *key, pl_where *out) {
	const pt_spot *s = key != NULL ? tb_get(l->mine, spot_part(), tb_symbol(key)) : NULL;
	if (s == NULL) return 0;
	const pl_pair *p = s->source.symbol;
	tb_key id = {.string = s->id.string, .symbol = s->id.symbol};
	*out = (pl_where){p->part, id, s->path, s->length, s->change};
	return 1;
}

void pl_forget(const void *key, void *ctx) {
	pl *l = ctx;
	pt_spot *s = tb_get(l->mine, spot_part(), tb_symbol(key));
	if (s == NULL) return;
	tb_del(l->mine, spot_part(), tb_symbol(key));
	pt_release(l->paths, s);
}

// element i of a typed array, as a number
static double element(const op_value *t, size_t i) {
	size_t z = op_size(t->kind);
	uint64_t u = 0;
	for (size_t j = 0; j < z; j++) u |= (uint64_t)t->data[i * z + j] << (8 * j);
	switch (t->kind) {
	case OP_INT8: return (int8_t)u;
	case OP_INT16: return (int16_t)u;
	case OP_INT32: return (int32_t)u;
	case OP_INT64: return (double)(int64_t)u;
	case OP_UINT64: return (double)u;
	case OP_FLOAT32: {
		uint32_t b = (uint32_t)u;
		float f;
		memcpy(&f, &b, sizeof f);
		return f;
	}
	case OP_FLOAT64: {
		double d;
		memcpy(&d, &u, sizeof d);
		return d;
	}
	default: return (double)u;
	}
}

const op_value *pl_at(const op_value *v, const op_key *path, size_t n, op_value *scratch) {
	for (size_t i = 0; i < n && v != NULL; i++) {
		if (path[i].type != OP_NUM_KEY) {
			v = v->type == OP_MAP ? op_get(v, path[i].s) : NULL;
		} else if (v->type == OP_LIST) {
			v = path[i].n >= 0 && (size_t)path[i].n < v->count ? v->items[path[i].n] : NULL;
		} else if (v->type == OP_TYPED && scratch != NULL && path[i].n >= 0 &&
			(size_t)path[i].n < op_length(v)) {
			scratch->type = OP_NUM;
			scratch->num = element(v, (size_t)path[i].n);
			v = scratch;
		} else {
			v = NULL;
		}
	}
	return v;
}

const op_value *pl_read(pl *l, tb_key part, tb_key id, const op_key *path, size_t n) {
	tell(l, pt_spot_of(l->paths, pair_key(l, part), paths_key(id), path, n, 0));
	const nd_entry *node = tb_get(l->table, part, id);
	return node != NULL ? pl_at(node->value, path, n, &l->scratch) : NULL;
}

const ch_header *pl_change(pl *l, tb_key part, tb_key id) {
	tell(l, pt_change_of(l->paths, pair_key(l, part), paths_key(id)));
	const nd_entry *node = tb_get(l->table, part, id);
	return node != NULL ? &node->change : NULL;
}

// writes ----------------------------------------------------------------------------------------

// spots, to be said changed
typedef struct {
	const void **v;
	size_t n, capacity;
} spots_vec;

static void add_spots(spots_vec *out, pt_spot *const *spots, size_t n) {
	if (out->n + n > out->capacity) {
		out->capacity = (out->n + n) * 2;
		out->v = realloc(out->v, out->capacity * sizeof *out->v);
		if (out->v == NULL) abort();
	}
	for (size_t i = 0; i < n; i++) out->v[out->n++] = spots[i];
}

// spots said changed, in one call, by the writer open; none: nothing said
static void say(pl *l, const spots_vec *spots) {
	if (spots->n > 0) sc_changed(l->scheduler, spots->v, spots->n, sc_current_writer(l->scheduler));
}

void pl_event(void *ctx, tb_key part, tb_key id) {
	pl *l = ctx;
	size_t n;
	pt_spot *const *spots = pt_event(l->paths, pair_key(l, part), paths_key(id), &n);
	spots_vec out = {0};
	add_spots(&out, spots, n);
	say(l, &out);
	free(out.v);
}

// the spots a node's latest patches mark, at every key it is under in the table
static void marked(pl *l, const nd_entry *node, spots_vec *out) {
	if (!node->change.has_op) return;
	size_t keys;
	const tb_where *where = tb_who(l->table, node, &keys);
	for (size_t i = 0; i < keys; i++) {
		size_t n;
		pt_spot *const *spots = pt_mark(l->paths, pair_key(l, where[i].part),
			paths_key(where[i].id), node->change.patches, node->change.patches_length, &n);
		add_spots(out, spots, n);
	}
}

void pl_wrote(pl *l, const pl_changed *changed) {
	spots_vec out = {0};
	for (size_t i = 0; i < changed->n; i++) marked(l, changed->entries[i], &out);
	say(l, &out);
	free(out.v);
}

// the filesystem, every read told ---------------------------------------------------------------

static const char *children_part = "children";

static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

// the id under name in a children entry; 1 and *out, or 0: none, or not an id
static int child_of(const nd_entry *children, const char *name, tb_key *out) {
	const op_value *v = children != NULL ? children->value : NULL;
	if (!is_map(v)) return 0;
	const op_value *id = op_get(v, name);
	if (id == NULL || id->type != OP_STR) return 0;
	*out = tb_string(id->str);
	return 1;
}

// the id under name in the children of id, the read told
static int step(pl *l, tb_key id, const char *name, tb_key *out) {
	op_key key = {.type = OP_STR_KEY, .s = name};
	tell(l, pt_spot_of(l->paths, pair_key(l, tb_string(children_part)), paths_key(id), &key, 1, 0));
	return child_of(tb_get(l->table, tb_string(children_part), id), name, out);
}

size_t pl_walk(pl *l, tb_key from, const char *const *path, size_t n, pl_member *out) {
	tb_key at = from;
	size_t i = 0;
	for (; i < n; i++) {
		tb_key id;
		if (!step(l, at, path[i], &id)) break;
		out[i] = (pl_member){path[i], id};
		at = id;
	}
	return i;
}

int pl_get(pl *l, const char *const *path, size_t n, tb_key *out) {
	tb_key at = l->root;
	for (size_t i = 0; i < n; i++) {
		if (!step(l, at, path[i], &at)) return 0;
	}
	*out = at;
	return 1;
}

size_t pl_lookup(pl *l, const char *const *names, size_t nnames, const char *const *from,
	size_t nfrom, int all, size_t *depths) {
	tb_key *ids = xalloc((nfrom + 1) * sizeof *ids);
	pl_member *steps = xalloc((nfrom + 1) * sizeof *steps);
	ids[0] = l->root;
	size_t walked = pl_walk(l, l->root, from, nfrom, steps);
	for (size_t i = 0; i < walked; i++) ids[i + 1] = steps[i].id;
	size_t found = 0;
	for (size_t k = walked + 1; k-- > 0;) {
		tb_key at = ids[k];
		int ok = 1;
		for (size_t j = 0; j < nnames && ok; j++) ok = step(l, at, names[j], &at);
		if (!ok) continue;
		depths[found++] = k;
		if (!all) break;
	}
	free(ids), free(steps);
	return found;
}

void pl_members_free(pl_members *list) {
	free(list->items);
	*list = (pl_members){0};
}

// the names in a children entry that hold an id, and their ids, in their order there
static pl_members members_of(const nd_entry *children) {
	pl_members out = {0};
	const op_value *v = children != NULL ? children->value : NULL;
	if (!is_map(v)) return out;
	out.items = xalloc(v->count * sizeof *out.items);
	for (size_t i = 0; i < v->count; i++) {
		if (v->items[i]->type == OP_STR) {
			out.items[out.n++] = (pl_member){v->keys[i], tb_string(v->items[i]->str)};
		}
	}
	return out;
}

// the members at a path, as list and members read them: which names there are, then each name,
// whatever it holds (a step of a walk is read before what is there is looked at)
pl_members pl_members_at(pl *l, const char *const *path, size_t n) {
	tb_key id;
	if (!pl_get(l, path, n, &id)) return (pl_members){0};
	tell(l, pt_spot_of(l->paths, pair_key(l, tb_string(children_part)), paths_key(id), NULL, 0, 1));
	const nd_entry *children = tb_get(l->table, tb_string(children_part), id);
	if (children != NULL && is_map(children->value)) {
		const op_value *v = children->value;
		for (size_t i = 0; i < v->count; i++) {
			op_key key = {.type = OP_STR_KEY, .s = v->keys[i]};
			tell(l, pt_spot_of(l->paths, pair_key(l, tb_string(children_part)), paths_key(id), &key, 1, 0));
		}
	}
	return members_of(children);
}

pl_members pl_list(pl *l, const char *const *path, size_t n) { return pl_members_at(l, path, n); }

// writing ---------------------------------------------------------------------------------------

const char *pl_code_name(int code) {
	switch (code) {
	case PL_NOT_A_NAME: return "not-a-name";
	case PL_NOTHING_THERE: return "nothing-there";
	case PL_ALREADY_THERE: return "already-there";
	default: return "";
	}
}

int pl_is_name(const char *name) {
	return name != NULL && strcmp(name, "") != 0 && strcmp(name, ".") != 0 &&
		strcmp(name, "..") != 0 && strcmp(name, "/") != 0;
}

// a name holding anything, an id or not
static int taken(const nd_entry *children, const char *name) {
	return is_map(children->value) && op_get(children->value, name) != NULL;
}

// what a write's patches refer to: kept by the node till its next update
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

// the patches of a block, applied to the entry and held by it
static void write(pl *l, nd_entry *entry, block *b, ch_header header, pl_changed *changed) {
	size_t failed;
	int code = nd_update(entry, b->patches, b->n, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "places: write: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(l, entry, b, block_free);
	changed->entries[changed->n++] = entry;
}

// the patches that make sure the value is a map, first
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

// the id under name moved to the name to, in the one entry
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

// who ------------------------------------------------------------------------------------------

// the pairs of a write made now: the scopes' from the root down, then extra. malloc'd, *total of
// them; NULL: no scope open
static sc_pair *pairs_of(pl *l, const sc_pair *extra, size_t n, size_t *total) {
	if (sc_current(l->scheduler) == NULL) return NULL;
	size_t scoped = sc_pairs(l->scheduler, NULL, 0);
	sc_pair *all = xalloc((scoped + n) * sizeof *all);
	sc_pairs(l->scheduler, all, scoped);
	for (size_t i = 0; i < n; i++) all[scoped + i] = extra[i];
	*total = scoped + n;
	return all;
}

// what a pair is of a header: the first actor, the first reader (a string), the rest metadata
typedef enum { ACTOR, READER, METADATA } role;
typedef struct {
	int actor, reader;
} seen;

static role role_of(seen *s, const sc_pair *p) {
	if (!s->actor && strcmp(p->key, "actor") == 0) return s->actor = 1, ACTOR;
	const op_value *v = p->value;
	if (!s->reader && strcmp(p->key, "reader") == 0 && v->type == OP_STR) return s->reader = 1, READER;
	return METADATA;
}

// the scheduler's own pairs, run and mark: numbers it keeps as uint64_t
static int scheduler_own(const sc_pair *p) {
	return strcmp(p->key, "run") == 0 || strcmp(p->key, "mark") == 0;
}
// the value of a pair, as an op_value: a new hold of it
static op_value *shown(const sc_pair *p) {
	if (scheduler_own(p)) return op_num((double)*(const uint64_t *)p->value);
	return op_ref((op_value *)p->value);
}

op_value *pl_who(pl *l, const sc_pair *extra, size_t n) {
	size_t total;
	sc_pair *all = pairs_of(l, extra, n, &total);
	if (all == NULL) return NULL;
	op_value *who = op_map(), *metadata = op_list();
	seen s = {0};
	for (size_t i = 0; i < total; i++) {
		op_value *v = shown(&all[i]);
		role r = role_of(&s, &all[i]);
		if (r == ACTOR) op_set(who, "actor", v);
		else if (r == READER) op_set(who, "reader", v);
		else {
			op_value *entry = op_list();
			op_push(entry, op_str(all[i].key));
			op_push(entry, v);
			op_push(metadata, entry);
		}
	}
	free(all);
	if (metadata->count > 0) op_set(who, "metadata", metadata);
	else op_free(metadata);
	return who;
}

struct pl_made {
	size_t refs;
	ch_site site;
	// a hold on each value the header refers to, and the metadata keys, copied
	op_value **values;
	size_t nvalues;
	char **keys;
	ch_entry *entries;
};

char *pl_header(pl *l, const sc_pair *extra, size_t n, const ch_site *site, ch_header *out,
	pl_made **made) {
	size_t total;
	sc_pair *all = pairs_of(l, extra, n, &total);
	if (all == NULL) return xdup(SC_UNSCOPED);
	pl_made *m = xalloc(sizeof *m);
	m->refs = 1;
	m->values = xalloc(total * sizeof *m->values);
	m->keys = xalloc(total * sizeof *m->keys);
	m->entries = xalloc(total * sizeof *m->entries);
	ch_header h = {.has_time = 1, .time = (int64_t)time(NULL)};
	seen s = {0};
	size_t nentries = 0;
	for (size_t i = 0; i < total; i++) {
		op_value *v = m->values[m->nvalues++] = shown(&all[i]);
		role r = role_of(&s, &all[i]);
		if (r == ACTOR) h.actor = v;
		else if (r == READER) h.reader = v->str;
		else {
			m->entries[nentries] = (ch_entry){m->keys[nentries] = xdup(all[i].key), v};
			nentries++;
		}
	}
	free(all);
	if (nentries > 0) h.metadata = m->entries, h.metadata_length = nentries;
	if (site != NULL) {
		m->site = *site;
		h.external = &m->site, h.external_length = 1;
	}
	*out = h;
	*made = m;
	return NULL;
}

pl_made *pl_made_ref(pl_made *m) {
	m->refs++;
	return m;
}

void pl_made_free(void *block) {
	pl_made *m = block;
	if (m == NULL || --m->refs > 0) return;
	for (size_t i = 0; i < m->nvalues; i++) op_free(m->values[i]);
	for (size_t i = 0; i < m->nvalues; i++) free(m->keys[i]);
	free(m->values), free(m->keys), free(m->entries), free(m);
}
