// Link (link.h), in C.
#include "link.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("link: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// a pair: a source and a part's name, both copied; and the next of the pairs made (to free them)
typedef struct {
	tb_key source;
	const char *part;
} lk_pair;
typedef struct pair pair;
struct pair {
	lk_pair pair;
	pair *next;
};

// a block kept for a node's change
typedef struct hold hold;
struct hold {
	void *block;
	void (*release)(void *block);
	hold *prev, *next;
};

struct lk {
	st_store *store;
	pt_paths *paths;
	sc_scheduler *scheduler;
	// the pairs by (part's name, source), and in a list
	tb_table *pairs;
	pair *all;
	// the spots this link made, by (the one part, the spot). forget finds its own in it
	tb_table *mine;
	// a typed array's element read by lk_get: the one number, remade by each
	op_value scratch;
	// the first answer that was not SC_OK to the reads told
	sc_read_status status;
	// what writes asked to be kept, by node, and in a list
	tb_table *holds;
	hold *held;
};

// the part of the key every spot of this link is under in `mine`
static const char spots;
static tb_key spot_part(void) { return tb_symbol(&spots); }

static pt_key paths_key(tb_key k) { return (pt_key){.string = k.string, .symbol = k.symbol}; }

// the one pair of (source, part): its address is the key paths gets as a spot's source
static const lk_pair *pair_of(lk *l, tb_key source, const char *part) {
	pair *p = tb_get(l->pairs, tb_string(part), source);
	if (p != NULL) return &p->pair;
	p = xalloc(sizeof *p);
	p->pair.source = source.symbol ? source : tb_string(xdup(source.string));
	p->pair.part = xdup(part);
	p->next = l->all;
	l->all = p;
	tb_add(l->pairs, tb_string(part), source, p);
	return &p->pair;
}
static pt_key pair_key(lk *l, tb_key source, const char *part) {
	return pt_symbol(pair_of(l, source, part));
}

// new, connected, and free ----------------------------------------------------------------------

lk *lk_new(void) {
	lk *l = xalloc(sizeof *l);
	l->pairs = tb_new();
	l->mine = tb_new();
	l->holds = tb_new();
	return l;
}

void lk_connect(lk *l, const lk_setup *setup) {
	l->store = setup->store;
	l->paths = setup->paths;
	l->scheduler = setup->scheduler;
}

static void unhold(lk *l, hold *h) {
	if (h->prev != NULL) h->prev->next = h->next;
	else l->held = h->next;
	if (h->next != NULL) h->next->prev = h->prev;
	h->release(h->block);
	free(h);
}

void lk_free(lk *l) {
	if (l == NULL) return;
	while (l->held != NULL) unhold(l, l->held);
	tb_free(l->holds);
	tb_free(l->mine);
	tb_free(l->pairs);
	while (l->all != NULL) {
		pair *p = l->all;
		l->all = p->next;
		if (p->pair.source.symbol == NULL) free((char *)p->pair.source.string);
		free((char *)p->pair.part);
		free(p);
	}
	free(l);
}

static const char holding;

void lk_hold(lk *l, const nd_entry *node, void *block, void (*release)(void *block)) {
	tb_key part = tb_symbol(&holding), where = tb_symbol(node);
	hold *old = tb_get(l->holds, part, where);
	if (old != NULL) unhold(l, old);
	hold *h = xalloc(sizeof *h);
	h->block = block;
	h->release = release;
	h->next = l->held;
	if (h->next != NULL) h->next->prev = h;
	l->held = h;
	tb_sub(l->holds, part, where, h);
}

// reads -----------------------------------------------------------------------------------------

sc_read_status lk_status(lk *l) {
	sc_read_status status = l->status;
	l->status = SC_OK;
	return status;
}

// a spot of this link's, told to the scheduler (a read outside a run counts for nothing)
static void tell(lk *l, pt_spot *s) {
	if (tb_get(l->mine, spot_part(), tb_symbol(s)) == NULL) tb_add(l->mine, spot_part(), tb_symbol(s), s);
	sc_read_status status = sc_read(l->scheduler, s);
	if (status != SC_OK && l->status == SC_OK) l->status = status;
}

void lk_read(void *ctx, tb_key source, tb_key id, const char *name, int keys) {
	lk *l = ctx;
	op_key step = {.type = OP_STR_KEY, .s = name};
	tell(l, pt_spot_of(l->paths, pair_key(l, source, "children"), paths_key(id), &step,
		name != NULL ? 1 : 0, keys));
}

int lk_spot(const lk *l, const void *key, lk_where *out) {
	const pt_spot *s = key != NULL ? tb_get(l->mine, spot_part(), tb_symbol(key)) : NULL;
	if (s == NULL) return 0;
	const lk_pair *p = s->source.symbol;
	tb_key id = {.string = s->id.string, .symbol = s->id.symbol};
	*out = (lk_where){p->source, p->part, id, s->path, s->length, s->change};
	return 1;
}

void lk_forget(const void *key, void *ctx) {
	lk *l = ctx;
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

const op_value *lk_at(const op_value *v, const op_key *path, size_t n, op_value *scratch) {
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

const op_value *lk_get(lk *l, tb_key source, const char *part, tb_key id, const op_key *path,
	size_t n) {
	tell(l, pt_spot_of(l->paths, pair_key(l, source, part), paths_key(id), path, n, 0));
	const nd_entry *node = st_get(l->store, source, part, id);
	return node != NULL ? lk_at(node->value, path, n, &l->scratch) : NULL;
}

const ch_header *lk_change(lk *l, tb_key source, const char *part, tb_key id) {
	tell(l, pt_change_of(l->paths, pair_key(l, source, part), paths_key(id)));
	const nd_entry *node = st_get(l->store, source, part, id);
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
static void say(lk *l, const spots_vec *spots) {
	if (spots->n > 0) sc_changed(l->scheduler, spots->v, spots->n, sc_current_by(l->scheduler));
}

void lk_event(void *ctx, tb_key source, const char *part, tb_key id) {
	lk *l = ctx;
	size_t n;
	pt_spot *const *spots = pt_event(l->paths, pair_key(l, source, part), paths_key(id), &n);
	spots_vec out = {0};
	add_spots(&out, spots, n);
	say(l, &out);
	free(out.v);
}

// the spots a node's latest patches mark, at every key it is under in its source's table
static void marked(lk *l, tb_key source, const nd_entry *node, spots_vec *out) {
	if (!node->change.has_op) return;
	size_t keys;
	const st_key *where = st_who(l->store, source, node, &keys);
	for (size_t i = 0; i < keys; i++) {
		size_t n;
		pt_spot *const *spots = pt_mark(l->paths, pair_key(l, source, where[i].part),
			paths_key(where[i].id), node->change.patches, node->change.patches_length, &n);
		add_spots(out, spots, n);
	}
}

void lk_wrote(lk *l, const pl_changed *changed) {
	spots_vec out = {0};
	for (size_t i = 0; i < changed->n; i++) {
		marked(l, changed->nodes[i].source, changed->nodes[i].node, &out);
	}
	say(l, &out);
	free(out.v);
}

// who ------------------------------------------------------------------------------------------

// the pairs of a write made now: the scopes' from the root down, then extra. malloc'd, *total of
// them; NULL: no scope open
static sc_pair *pairs_of(lk *l, const sc_pair *extra, size_t n, size_t *total) {
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

op_value *lk_who(lk *l, const sc_pair *extra, size_t n) {
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

struct lk_made {
	size_t refs;
	ch_site site;
	// a hold on each value the header refers to, and the metadata keys, copied
	op_value **values;
	size_t nvalues;
	char **keys;
	ch_entry *entries;
};

char *lk_header(lk *l, const sc_pair *extra, size_t n, const ch_site *site, ch_header *out,
	lk_made **made) {
	size_t total;
	sc_pair *all = pairs_of(l, extra, n, &total);
	if (all == NULL) return xdup(SC_UNSCOPED);
	lk_made *m = xalloc(sizeof *m);
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

lk_made *lk_made_ref(lk_made *m) {
	m->refs++;
	return m;
}

void lk_made_free(void *block) {
	lk_made *m = block;
	if (m == NULL || --m->refs > 0) return;
	for (size_t i = 0; i < m->nvalues; i++) op_free(m->values[i]);
	for (size_t i = 0; i < m->nvalues; i++) free(m->keys[i]);
	free(m->values), free(m->keys), free(m->entries), free(m);
}
