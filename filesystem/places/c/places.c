// Places (places.h), in C.
#include "places.h"
#include "../../../core/scheduler/c/ptrmap.h"

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

struct pl_watch {
	pl *l;
	char **path;
	size_t n;
	int has_part;
	tb_key part;
	int has_at;
	op_key *at;
	size_t at_length;
	pl_watch_fn fn;
	void *ctx;
	int stopped;
	// told every fact (pl_watch_all): in the alls, not the watches
	int all;
	pl_watch *prev, *next;
	// the order made; the node its path finds now (has_id), and the ids of the folders on its
	// route, their strings the watch's own; the telling that last marked it
	size_t seq;
	int has_id;
	tb_key id;
	tb_key *route;
	size_t nroute;
	size_t epoch;
};

// what every view of a places shares: the table, paths and scheduler, the spots, the holds and keeps,
// the record, the watches and what it owns. let go with the last of the places and views over it
typedef struct {
	tb_table *table;
	pt_paths *paths;
	sc_scheduler *scheduler;
	// the pairs by (the one part, the part), and in a list
	tb_table *pairs;
	pair *all;
	// the spots this places made, by the spot. forget finds its own in it
	pm mine;
	// a typed array's element read by pl_read: the one number, remade by each
	op_value scratch;
	// the first answer that was not SC_OK to the reads told
	sc_track_status status;
	// what writes asked to be kept, by node, and in a list
	pm holds;
	hold *held;
	// the watches, in the order made; the ones stopped while being told, till the telling ends
	pl_watch *watches, *watches_end, *dead;
	// pl_watch_all's, in the order made
	pl_watch *alls, *alls_end;
	int telling;
	// the watches by the id they are at, and by each id on their route: buckets, by (a tag, the id)
	tb_table *by_id, *on_route;
	size_t seqs, epochs;
	// the entries pl_upsert made: the places', let go of at pl_free
	nd_entry **owned;
	size_t nowned, capowned;
	// where reads go while pl_record runs; none: the scheduler
	pl_set *into;
	// the spots it made (none of this places' before); none: not asked
	pl_set *made;
	// the keeps on spots, by (the one part, the spot): a count
	tb_table *kept;
	// the places and views over it not let go
	size_t refs;
	// the header blocks alive, by their metadata, and in a list: pl_change_value finds a
	// header's block by its metadata, which is the block's own while it lives
	pm made_by;
	struct pl_made *mades;
} shared;


// the one part the keeps are under
static const char spots;

struct pl_made {
	size_t refs;
	ch_site site;
	// the metadata, a map, and the actor and reader (holds; NULL: none): the header refers into them
	op_value *pairs, *actor, *reader;
	ch_entry *entries;
	// the header as a value, made the first time pl_change_value asks (NULL: not yet)
	op_value *change;
	// the places it is found in (NULL: gone first), and its neighbours in their list
	shared *s;
	struct pl_made *before, *next;
};

struct pl {
	tb_key root;
	// what answers each step: the setup's, or children alone. given: whether any were given
	const pl_contributor *const *asked;
	size_t nasked;
	int given;
	shared *s;
};

// the part of the key every spot of this places is under in `mine`
static const char *children_part = "children";

static pt_key paths_key(tb_key k) { return (pt_key){.string = k.string, .symbol = k.symbol}; }

// the part of the key every pair is under in `pairs`
static const char pairing;

// the one pair of the part: its address is the key paths gets as a spot's source
static const pl_pair *pair_of(pl *l, tb_key part) {
	pair *p = tb_get(l->s->pairs, tb_symbol(&pairing), part);
	if (p != NULL) return &p->pair;
	p = xalloc(sizeof *p);
	p->pair.part = part.symbol ? part : tb_string(xdup(part.string));
	p->next = l->s->all;
	l->s->all = p;
	tb_add(l->s->pairs, tb_symbol(&pairing), part, p);
	return &p->pair;
}
static pt_key pair_key(pl *l, tb_key part) { return pt_symbol(pair_of(l, part)); }

// new, connected, and free ----------------------------------------------------------------------

pl *pl_new(void) {
	pl *l = xalloc(sizeof *l);
	l->s = xalloc(sizeof *l->s);
	l->s->refs = 1;
	l->s->pairs = tb_new();
	l->s->by_id = tb_new();
	l->s->on_route = tb_new();
	l->s->kept = tb_new();
	return l;
}

static const pl_contributor *const alone[] = {&pl_children};

// the contributors a places asks: the ones given, or children alone
static void ask(pl *l, const pl_contributor *const *contributors, size_t n) {
	l->given = n > 0;
	l->asked = l->given ? contributors : alone;
	l->nasked = l->given ? n : 1;
}

void pl_connect(pl *l, const pl_setup *setup) {
	l->root = setup->root;
	l->s->table = setup->table;
	l->s->paths = setup->paths;
	l->s->scheduler = setup->scheduler;
	ask(l, setup->contributors, setup->ncontributors);
}

pl *pl_view(pl *l, tb_key root, const pl_contributor *const *contributors, size_t n) {
	pl *v = xalloc(sizeof *v);
	v->root = root;
	v->s = l->s;
	v->s->refs++;
	ask(v, contributors, n);
	return v;
}

tb_key pl_root(const pl *l) { return l->root; }

const pl_contributor *const *pl_contributors(const pl *l, size_t *n) {
	*n = l->given ? l->nasked : 0;
	return l->given ? l->asked : NULL;
}

static void unhold(pl *l, hold *h) {
	if (h->prev != NULL) h->prev->next = h->next;
	else l->s->held = h->next;
	if (h->next != NULL) h->next->prev = h->prev;
	h->release(h->block);
	free(h);
}

static void free_dead(pl *l);

void pl_free(pl *l) {
	if (l == NULL) return;
	// its own watches stopped: they find their path from its root
	for (pl_watch *w = l->s->watches, *next; w != NULL; w = next) {
		next = w->next;
		if (w->l == l) pl_stop(w);
	}
	for (pl_watch *w = l->s->alls, *next; w != NULL; w = next) {
		next = w->next;
		if (w->l == l) pl_stop(w);
	}
	shared *s = l->s;
	if (--s->refs > 0) {
		free(l);
		return;
	}
	while (s->held != NULL) unhold(l, s->held);
	while (s->watches != NULL) pl_stop(s->watches);
	while (s->alls != NULL) pl_stop(s->alls);
	free_dead(l);
	for (size_t i = 0; i < s->nowned; i++) nd_free_entry(s->owned[i]);
	free(s->owned);
	pm_clear(&s->holds);
	// blocks still held elsewhere outlive the places: they forget it
	for (struct pl_made *m = s->mades; m != NULL; m = m->next) m->s = NULL;
	pm_clear(&s->made_by);
	tb_free(s->kept);
	tb_free(s->by_id);
	tb_free(s->on_route);
	pm_clear(&s->mine);
	tb_free(s->pairs);
	while (s->all != NULL) {
		pair *p = s->all;
		s->all = p->next;
		if (p->pair.part.symbol == NULL) free((char *)p->pair.part.string);
		free(p);
	}
	free(s);
	free(l);
}


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
	hold *old = pm_get(&l->s->holds, node);
	hold *h = xalloc(sizeof *h);
	h->block = block;
	h->release = release;
	h->next = l->s->held;
	if (h->next != NULL) h->next->prev = h;
	l->s->held = h;
	if (also) h->chain = old;
	else unhold_chain(l, old);
	pm_set(&l->s->holds, node, h);
}

void pl_hold(pl *l, const nd_entry *node, void *block, void (*release)(void *block)) {
	hold_node(l, node, block, release, 0);
}
void pl_hold_also(pl *l, const nd_entry *node, void *block, void (*release)(void *block)) {
	hold_node(l, node, block, release, 1);
}

// reads -----------------------------------------------------------------------------------------

sc_track_status pl_status(pl *l) {
	sc_track_status status = l->s->status;
	l->s->status = SC_OK;
	return status;
}

// a spot of this places's, told to the scheduler (a read outside a run counts for nothing)
static void tell(pl *l, pt_spot *s) {
	int known = pm_get(&l->s->mine, s) != NULL;
	if (!known) pm_set(&l->s->mine, s, s);
	if (l->s->into != NULL) {
		pl_set_add(l->s->into, s);
		if (!known && l->s->made != NULL) pl_set_add(l->s->made, s);
		return;
	}
	sc_track_status status = sc_track(l->s->scheduler, s);
	if (status != SC_OK && l->s->status == SC_OK) l->s->status = status;
}

int pl_spot(const pl *l, const void *key, pl_where *out) {
	const pt_spot *s = key != NULL ? pm_get(&l->s->mine, key) : NULL;
	if (s == NULL) return 0;
	const pl_pair *p = s->source.symbol;
	tb_key id = {.string = s->id.string, .symbol = s->id.symbol};
	*out = (pl_where){p->part, id, s->path, s->length, s->change, s->keys};
	return 1;
}

void pl_forget(const void *key, void *ctx) {
	pl *l = ctx;
	pt_spot *s = pm_get(&l->s->mine, key);
	if (s == NULL || tb_get(l->s->kept, tb_symbol(&spots), tb_symbol(key)) != NULL) return;
	pm_delete(&l->s->mine, key);
	pt_release(l->s->paths, s);
}

// sets, records and keeps ----------------------------------------------------------------------

#define SET_SMALL 8
#define EMPTY ((size_t)0)
#define TOMB ((size_t)-1)

static size_t hash_of(const void *p) {
	uint64_t x = (uint64_t)(uintptr_t)p;
	x ^= x >> 33, x *= 0xff51afd7ed558ccdULL, x ^= x >> 33;
	return (size_t)x;
}

// the slot holding item (its position + 1), or the slot to put it in (EMPTY there)
static size_t slot_of(const pl_set *s, const void *item, int *found) {
	size_t mask = s->nindex - 1, i = hash_of(item) & mask, first = TOMB;
	for (;; i = (i + 1) & mask) {
		size_t at = s->index[i];
		if (at == EMPTY) {
			*found = 0;
			return first != TOMB ? first : i;
		}
		if (at == TOMB) {
			if (first == TOMB) first = i;
		} else if (s->items[at - 1] == item) {
			*found = 1;
			return i;
		}
	}
}

static void reindex(pl_set *s) {
	size_t want = 32;
	while (want < s->n * 4) want *= 2;
	free(s->index);
	s->index = xalloc(want * sizeof *s->index);
	s->nindex = want;
	s->used = 0;
	for (size_t k = 0; k < s->n; k++) {
		int found;
		s->index[slot_of(s, s->items[k], &found)] = k + 1;
		s->used++;
	}
}

int pl_set_has(const pl_set *s, const void *item) {
	if (s->index == NULL) {
		for (size_t i = 0; i < s->n; i++) if (s->items[i] == item) return 1;
		return 0;
	}
	int found;
	slot_of(s, item, &found);
	return found;
}

int pl_set_add(pl_set *s, const void *item) {
	if (pl_set_has(s, item)) return 0;
	if (s->n == s->cap) {
		s->cap = s->cap ? s->cap * 2 : 4;
		s->items = realloc(s->items, s->cap * sizeof *s->items);
		if (s->items == NULL) abort();
	}
	s->items[s->n++] = item;
	if (s->index == NULL) {
		if (s->n > SET_SMALL) reindex(s);
		return 1;
	}
	if (s->used * 2 >= s->nindex) {
		reindex(s);
		return 1;
	}
	int found;
	size_t at = slot_of(s, item, &found);
	if (s->index[at] == EMPTY) s->used++;
	s->index[at] = s->n;
	return 1;
}

int pl_set_del(pl_set *s, const void *item) {
	size_t pos = s->n;
	if (s->index == NULL) {
		for (size_t i = 0; i < s->n; i++) {
			if (s->items[i] == item) {
				pos = i;
				break;
			}
		}
		if (pos == s->n) return 0;
		s->items[pos] = s->items[--s->n];
		return 1;
	}
	int found;
	size_t at = slot_of(s, item, &found);
	if (!found) return 0;
	pos = s->index[at] - 1;
	s->index[at] = TOMB;
	size_t last = --s->n;
	if (pos != last) {
		const void *moved = s->items[last];
		size_t m = slot_of(s, moved, &found);
		s->index[m] = pos + 1;
		s->items[pos] = moved;
	}
	return 1;
}

void pl_set_free(pl_set *s) {
	free(s->items);
	free(s->index);
	*s = (pl_set){0};
}

void pl_record(pl *l, void (*f)(void *ctx), void *ctx, pl_set *reads, pl_set *fresh) {
	pl_set *was = l->s->into, *was_made = l->s->made;
	l->s->into = reads;
	l->s->made = fresh;
	f(ctx);
	l->s->into = was;
	l->s->made = was_made;
}

void pl_track(pl *l, const void *key) {
	if (l->s->into != NULL) {
		pl_set_add(l->s->into, key);
		return;
	}
	sc_track_status status = sc_track(l->s->scheduler, key);
	if (status != SC_OK && l->s->status == SC_OK) l->s->status = status;
}

size_t pl_keep(pl *l, const void *key, int n) {
	if (pm_get(&l->s->mine, key) == NULL) return 0;
	tb_key part = tb_symbol(&spots), where = tb_symbol(key);
	intptr_t now = (intptr_t)tb_get(l->s->kept, part, where) + n;
	if (now > 0) tb_sub(l->s->kept, part, where, (void *)now);
	else {
		tb_del(l->s->kept, part, where);
		now = 0;
	}
	return (size_t)now;
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
	tell(l, pt_spot_of(l->s->paths, pair_key(l, part), paths_key(id), path, n, 0));
	const nd_entry *node = tb_get(l->s->table, part, id);
	return node != NULL ? pl_at(node->value, path, n, &l->s->scratch) : NULL;
}

const ch_header *pl_change(pl *l, tb_key part, tb_key id) {
	tell(l, pt_change_of(l->s->paths, pair_key(l, part), paths_key(id)));
	const nd_entry *node = tb_get(l->s->table, part, id);
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

// spots said changed, in one call, by the run open; none: nothing said
static void say(pl *l, const spots_vec *spots) {
	if (spots->n > 0) sc_mark(l->s->scheduler, spots->v, spots->n, sc_get_run(l->s->scheduler));
}

static int same_key(tb_key a, tb_key b) {
	if (a.symbol != NULL || b.symbol != NULL) return a.symbol == b.symbol;
	return a.string != NULL && b.string != NULL && strcmp(a.string, b.string) == 0;
}

static int child_of(const nd_entry *children, const char *name, tb_key *out);

static void tell_watches(pl *l, const pl_fact *facts, size_t n);
static void tell_alls(pl *l, const pl_fact *facts, size_t n);

void pl_event(void *ctx, tb_key part, tb_key id) {
	pl *l = ctx;
	size_t n;
	pt_spot *const *spots = pt_event(l->s->paths, pair_key(l, part), paths_key(id), &n);
	spots_vec out = {0};
	add_spots(&out, spots, n);
	say(l, &out);
	free(out.v);
	if (l->s->watches == NULL && l->s->alls == NULL) return;
	const nd_entry *entry = tb_get(l->s->table, part, id);
	op_patch patch = {0};
	if (entry != NULL && entry->value != NULL) {
		patch.has_value = 1;
		patch.value = entry->value;
	}
	pl_fact fact = {part, id, &patch, 1, entry != NULL ? &entry->change : NULL, entry};
	tell_alls(l, &fact, 1);
	tell_watches(l, &fact, 1);
}

// what a write landed: a fact for each entry with a latest op, at every key it is under (tb_who).
// The caller's, pl_facts_free; the patches and change are the entries'
typedef struct {
	size_t n;
	pl_fact *items;
} pl_facts;

static void pl_facts_free(pl_facts *facts) {
	free(facts->items);
	*facts = (pl_facts){0};
}

static pl_facts pl_each_entry_change(pl *l, const pl_changed *changed) {
	pl_facts out = {0};
	size_t capacity = 0;
	for (size_t i = 0; i < changed->n; i++) {
		const nd_entry *node = changed->entries[i];
		if (!node->change.has_op) continue;
		size_t keys;
		const tb_where *where = tb_who(l->s->table, node, &keys);
		for (size_t k = 0; k < keys; k++) {
			if (out.n == capacity) {
				capacity = capacity ? capacity * 2 : 4;
				out.items = realloc(out.items, capacity * sizeof *out.items);
				if (out.items == NULL) abort();
			}
			out.items[out.n++] = (pl_fact){where[k].part, where[k].id, node->change.patches,
				node->change.patches_length, &node->change, node};
		}
	}
	return out;
}

void pl_commit(pl *l, const pl_changed *changed) {
	pl_facts facts = pl_each_entry_change(l, changed);
	spots_vec out = {0};
	for (size_t i = 0; i < facts.n; i++) {
		size_t n;
		pt_spot *const *spots = pt_mark(l->s->paths, pair_key(l, facts.items[i].part),
			paths_key(facts.items[i].id), facts.items[i].patches, facts.items[i].patches_length, &n);
		add_spots(&out, spots, n);
	}
	say(l, &out);
	free(out.v);
	tell_alls(l, facts.items, facts.n);
	tell_watches(l, facts.items, facts.n);
	pl_facts_free(&facts);
}

// watches ---------------------------------------------------------------------------------------

static int key_same(const op_key *a, const op_key *b) {
	if (a->type != b->type) return 0;
	switch (a->type) {
	case OP_NUM_KEY: return a->n == b->n;
	case OP_STR_KEY: return strcmp(a->s, b->s) == 0;
	default: return a->a == b->a && a->b == b->b;
	}
}

// whether two paths in a value touch: one is the other or above it
static int touch(const op_key *a, size_t an, const op_key *b, size_t bn) {
	for (size_t i = 0; i < an && i < bn; i++) {
		if (!key_same(&a[i], &b[i])) return 0;
	}
	return 1;
}

static int touches(const op_patch *p, const op_key *at, size_t n) {
	return touch(p->place.path, p->place.length, at, n) ||
		(p->has_move && touch(p->move.path, p->move.length, at, n));
}

// the watches at a key, in a table of buckets
typedef struct {
	pl_watch **v;
	size_t n, cap;
} bucket;
static const char bucket_tag;

static void bucket_add(tb_table *t, tb_key id, pl_watch *w) {
	bucket *b = tb_get(t, tb_symbol(&bucket_tag), id);
	if (b == NULL) {
		b = xalloc(sizeof *b);
		tb_add(t, tb_symbol(&bucket_tag), id, b);
	}
	if (b->n == b->cap) {
		b->cap = b->cap ? b->cap * 2 : 2;
		b->v = realloc(b->v, b->cap * sizeof *b->v);
		if (b->v == NULL) abort();
	}
	b->v[b->n++] = w;
}

static void bucket_del(tb_table *t, tb_key id, pl_watch *w) {
	bucket *b = tb_get(t, tb_symbol(&bucket_tag), id);
	if (b == NULL) return;
	for (size_t i = 0; i < b->n; i++) {
		if (b->v[i] != w) continue;
		b->v[i] = b->v[--b->n];
		break;
	}
	if (b->n == 0) {
		tb_del(t, tb_symbol(&bucket_tag), id);
		free(b->v);
		free(b);
	}
}

static tb_key key_own(tb_key k) { return k.symbol ? k : tb_string(xdup(k.string)); }
static void key_disown(tb_key k) {
	if (k.symbol == NULL) free((char *)k.string);
}

// the watch out of the indexes, its id and route let go
static void unindex(pl *l, pl_watch *w) {
	if (w->has_id) bucket_del(l->s->by_id, w->id, w);
	for (size_t i = 0; i < w->nroute; i++) bucket_del(l->s->on_route, w->route[i], w);
	if (w->has_id) key_disown(w->id);
	for (size_t i = 0; i < w->nroute; i++) key_disown(w->route[i]);
	free(w->route);
	w->route = NULL;
	w->nroute = 0;
	w->has_id = 0;
}

// the watch finds its path again, from the table, untold; moves in the indexes
static int go(pl *l, const pl_here *here, const char *name, tb_key *out, const char **by,
	uint32_t *under);

static void refind(pl *l, pl_watch *w) {
	unindex(l, w);
	w->route = xalloc((w->n + 1) * sizeof *w->route);
	tb_key at = l->root;
	int found = 1;
	if (!l->given) {
		for (size_t i = 0; i < w->n; i++) {
			w->route[w->nroute++] = key_own(at);
			if (!child_of(tb_get(l->s->table, tb_string(children_part), at), w->path[i], &at)) {
				found = 0;
				break;
			}
		}
	} else {
		// as pl_get finds it, through the contributors, the reads told to no one
		pl_set told = {0}, *was = l->s->into;
		l->s->into = &told;
		pl_here here = {.id = l->root, .has_path = 1, .path = (const char *const *)w->path, .length = 0};
		for (size_t i = 0; i < w->n; i++) {
			if (!same_key(here.id, pl_level())) w->route[w->nroute++] = key_own(here.id);
			const char *by;
			uint32_t under;
			if (!go(l, &here, w->path[i], &at, &by, &under)) {
				found = 0;
				break;
			}
			here.id = at;
			here.length = i + 1;
			here.gone = under;
		}
		l->s->into = was;
		pl_set_free(&told);
		if (found && same_key(at, pl_level())) found = 0;
	}
	if (found) {
		w->id = key_own(at);
		w->has_id = 1;
		bucket_add(l->s->by_id, w->id, w);
	}
	for (size_t i = 0; i < w->nroute; i++) bucket_add(l->s->on_route, w->route[i], w);
}

pl_watch *pl_watch_path(pl *l, const char *const *path, size_t n, pl_watch_fn fn, void *ctx,
	const pl_watching *options) {
	pl_watch *w = xalloc(sizeof *w);
	w->l = l;
	w->path = xalloc(n * sizeof *w->path);
	for (size_t i = 0; i < n; i++) w->path[i] = xdup(path[i]);
	w->n = n;
	w->fn = fn;
	w->ctx = ctx;
	if (options != NULL) {
		if (options->has_part) {
			w->has_part = 1;
			// a part is a name: copied
			w->part = options->part.symbol ? options->part : tb_string(xdup(options->part.string));
		}
		if (options->has_at) {
			w->has_at = 1;
			w->at_length = options->at_length;
			w->at = xalloc(options->at_length * sizeof *w->at);
			for (size_t i = 0; i < options->at_length; i++) {
				w->at[i] = options->at[i];
				if (w->at[i].type == OP_STR_KEY) w->at[i].s = xdup(options->at[i].s);
			}
		}
	}
	w->prev = l->s->watches_end;
	if (w->prev != NULL) w->prev->next = w;
	else l->s->watches = w;
	l->s->watches_end = w;
	w->seq = l->s->seqs++;
	refind(l, w);
	return w;
}

static void free_watch(pl_watch *w) {
	for (size_t i = 0; i < w->n; i++) free(w->path[i]);
	free(w->path);
	if (w->has_part && w->part.symbol == NULL) free((char *)w->part.string);
	for (size_t i = 0; i < w->at_length; i++) {
		if (w->at[i].type == OP_STR_KEY) free((char *)w->at[i].s);
	}
	free(w->at);
	free(w);
}

static void free_dead(pl *l) {
	while (l->s->dead != NULL) {
		pl_watch *w = l->s->dead;
		l->s->dead = w->next;
		free_watch(w);
	}
}

pl_watch *pl_watch_all(pl *l, pl_watch_fn fn, void *ctx) {
	pl_watch *w = xalloc(sizeof *w);
	w->l = l;
	w->fn = fn;
	w->ctx = ctx;
	w->all = 1;
	w->prev = l->s->alls_end;
	if (w->prev != NULL) w->prev->next = w;
	else l->s->alls = w;
	l->s->alls_end = w;
	return w;
}

// each of pl_watch_all's (the ones there as the telling starts) told every fact, in the order
// made; one stopped on the way is not told
static void tell_alls(pl *l, const pl_fact *facts, size_t n) {
	if (l->s->alls == NULL || n == 0) return;
	size_t m = 0;
	for (pl_watch *w = l->s->alls; w != NULL; w = w->next) m++;
	pl_watch **told = xalloc(m * sizeof *told);
	m = 0;
	for (pl_watch *w = l->s->alls; w != NULL; w = w->next) told[m++] = w;
	l->s->telling++;
	for (size_t f = 0; f < n; f++) {
		for (size_t i = 0; i < m; i++) {
			if (!told[i]->stopped) told[i]->fn(&facts[f], told[i]->ctx);
		}
	}
	free(told);
	l->s->telling--;
	if (l->s->telling == 0) free_dead(l);
}

void pl_stop(pl_watch *w) {
	if (w == NULL || w->stopped) return;
	pl *l = w->l;
	w->stopped = 1;
	if (w->all) {
		if (w->prev != NULL) w->prev->next = w->next;
		else l->s->alls = w->next;
		if (w->next != NULL) w->next->prev = w->prev;
		else l->s->alls_end = w->prev;
		w->prev = NULL;
		w->next = l->s->dead;
		l->s->dead = w;
		if (l->s->telling == 0) free_dead(l);
		return;
	}
	unindex(l, w);
	if (w->prev != NULL) w->prev->next = w->next;
	else l->s->watches = w->next;
	if (w->next != NULL) w->next->prev = w->prev;
	else l->s->watches_end = w->prev;
	// a telling in progress may hold it: freed when the telling ends
	w->prev = NULL;
	w->next = l->s->dead;
	l->s->dead = w;
	if (l->s->telling == 0) free_dead(l);
}

// a watch and the index of the fact it is to be told
typedef struct {
	pl_watch *w;
	size_t fact;
} hit;

static int by_seq(const void *a, const void *b) {
	const hit *x = a, *y = b;
	if (x->w->seq != y->w->seq) return x->w->seq < y->w->seq ? -1 : 1;
	return x->fact < y->fact ? -1 : x->fact > y->fact;
}

// each watch told the facts at its node, in the order the watches were made; a fact costs one get
// in by_id. a watch stopped on the way is not told. then each watch with a changed children entry
// on its route finds its path again
static void tell_watches(pl *l, const pl_fact *facts, size_t n) {
	if (l->s->watches == NULL || n == 0) return;
	hit *hits = NULL;
	size_t nh = 0, caph = 0;
	for (size_t f = 0; f < n; f++) {
		bucket *b = tb_get(l->s->by_id, tb_symbol(&bucket_tag), facts[f].id);
		if (b == NULL) continue;
		for (size_t i = 0; i < b->n; i++) {
			pl_watch *w = b->v[i];
			if (w->has_part && !same_key(facts[f].part, w->part)) continue;
			if (nh == caph) {
				caph = caph ? caph * 2 : 8;
				hits = realloc(hits, caph * sizeof *hits);
				if (hits == NULL) abort();
			}
			hits[nh++] = (hit){w, f};
		}
	}
	qsort(hits, nh, sizeof *hits, by_seq);
	l->s->telling++;
	for (size_t i = 0; i < nh; i++) {
		pl_watch *w = hits[i].w;
		if (w->stopped) continue;
		const pl_fact *fact = &facts[hits[i].fact];
		if (!w->has_at) {
			w->fn(fact, w->ctx);
			continue;
		}
		op_patch *kept = xalloc((fact->patches_length + 1) * sizeof *kept);
		size_t m = 0;
		for (size_t j = 0; j < fact->patches_length; j++) {
			if (touches(&fact->patches[j], w->at, w->at_length)) kept[m++] = fact->patches[j];
		}
		if (m > 0) {
			pl_fact told = *fact;
			told.patches = kept;
			told.patches_length = m;
			w->fn(&told, w->ctx);
		}
		free(kept);
	}
	free(hits);
	// the watches with a changed children entry on their route, each once (the view they were made
	// on given contributors: any part but value, theirs)
	size_t epoch = ++l->s->epochs, nm = 0, capm = 0;
	pl_watch **moved = NULL;
	for (size_t f = 0; f < n; f++) {
		int kids = same_key(facts[f].part, tb_string(children_part));
		int value = same_key(facts[f].part, tb_string("value"));
		bucket *b = tb_get(l->s->on_route, tb_symbol(&bucket_tag), facts[f].id);
		if (b == NULL) continue;
		for (size_t i = 0; i < b->n; i++) {
			pl_watch *w = b->v[i];
			if (!kids && (!w->l->given || value)) continue;
			if (w->epoch == epoch) continue;
			w->epoch = epoch;
			if (nm == capm) {
				capm = capm ? capm * 2 : 8;
				moved = realloc(moved, capm * sizeof *moved);
				if (moved == NULL) abort();
			}
			moved[nm++] = w;
		}
	}
	for (size_t i = 0; i < nm; i++) {
		if (!moved[i]->stopped) refind(moved[i]->l, moved[i]);
	}
	free(moved);
	l->s->telling--;
	if (l->s->telling == 0) free_dead(l);
}

// the filesystem, every read told ---------------------------------------------------------------

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
	tell(l, pt_spot_of(l->s->paths, pair_key(l, tb_string(children_part)), paths_key(id), &key, 1, 0));
	return child_of(tb_get(l->s->table, tb_string(children_part), id), name, out);
}

static void pl_namelist_add(pl_namelist *list, const char *name) {
	if (list->n == list->cap) {
		list->cap = list->cap ? list->cap * 2 : 8;
		list->items = realloc(list->items, list->cap * sizeof *list->items);
		if (list->items == NULL) abort();
	}
	list->items[list->n++] = name;
}

void pl_namelist_free(pl_namelist *list) {
	free(list->items);
	*list = (pl_namelist){0};
}

void pl_keys(pl *l, tb_key part, tb_key id, const op_key *path, size_t n, int ids,
	pl_namelist *out) {
	tell(l, pt_spot_of(l->s->paths, pair_key(l, part), paths_key(id), path, n, 1));
	const nd_entry *node = tb_get(l->s->table, part, id);
	const op_value *v = node != NULL ? pl_at(node->value, path, n, &l->s->scratch) : NULL;
	if (!is_map(v)) return;
	for (size_t i = 0; i < v->count; i++) {
		if (!ids || v->items[i]->type == OP_STR) pl_namelist_add(out, v->keys[i]);
	}
}

// a level has no id: nothing, nothing read
static int children_step(void *ctx, const pl_here *here, const char *name, pl *l, tb_key *out) {
	(void)ctx;
	if (same_key(here->id, pl_level())) return 0;
	op_key key = {.type = OP_STR_KEY, .s = name};
	const op_value *v = pl_read(l, tb_string(children_part), here->id, &key, 1);
	if (v == NULL || v->type != OP_STR) return 0;
	*out = tb_string(v->str);
	return 1;
}

static void children_names(void *ctx, const pl_here *here, pl *l, pl_namelist *out) {
	(void)ctx;
	if (same_key(here->id, pl_level())) return;
	pl_keys(l, tb_string(children_part), here->id, NULL, 0, 0, out);
}

const pl_contributor pl_children = {"children", children_step, children_names, NULL, NULL};

static const char level_tag;
tb_key pl_level(void) { return tb_symbol(&level_tag); }

// a contributor's bit in gone; past the 32nd: none
static uint32_t bit(size_t i) { return i < 32 ? (uint32_t)1 << i : 0; }

// the first answer at here + name, each contributor asked in order (but here's gone); 1 and *out,
// *by. *under: here's gone, and the contributors that said none
static int go(pl *l, const pl_here *here, const char *name, tb_key *out, const char **by,
	uint32_t *under) {
	uint32_t gone = here->gone, said = gone;
	for (size_t i = 0; i < l->nasked; i++) {
		if (gone & bit(i)) continue;
		const pl_contributor *c = l->asked[i];
		int got = c->step(c->ctx, here, name, l, out);
		if (got == PL_NONE) said |= bit(i);
		else if (got) {
			*by = c->from;
			*under = said;
			return 1;
		}
	}
	*under = said;
	// might be fishy. TODO is this fishy?
	// no id anywhere, but a contributor has a level there (processes at /dev/clock, with no /dev
	// saved): the walk goes on through it as if it were a folder
	for (size_t i = 0; i < l->nasked; i++) {
		if (said & bit(i)) continue;
		const pl_contributor *c = l->asked[i];
		if (c->level != NULL && c->level(c->ctx, here, name, l)) {
			*out = pl_level();
			*by = c->from;
			return 1;
		}
	}
	return 0;
}

// the walk from a here: out has room for n, gones (NULL: not asked) too, the gone under each step
// taken; the steps taken
static size_t walk_from(pl *l, const pl_here *from, const char *const *path, size_t n,
	pl_member *out, uint32_t *gones) {
	size_t i = 0;
	if (!l->given) {
		tb_key at = from->id;
		for (; i < n; i++) {
			tb_key id;
			if (!step(l, at, path[i], &id)) break;
			out[i] = (pl_member){path[i], id, NULL};
			if (gones != NULL) gones[i] = 0;
			at = id;
		}
		return i;
	}
	pl_here here = *from;
	const char **trail = NULL;
	if (from->has_path) {
		trail = xalloc((from->length + n + 1) * sizeof *trail);
		if (from->length > 0) memcpy(trail, from->path, from->length * sizeof *trail);
		here.path = trail;
	}
	for (; i < n; i++) {
		tb_key id;
		const char *by;
		uint32_t under;
		if (!go(l, &here, path[i], &id, &by, &under)) break;
		out[i] = (pl_member){path[i], id, by};
		if (gones != NULL) gones[i] = under;
		if (here.has_path) trail[here.length++] = path[i];
		here.id = id;
		here.gone = under;
	}
	free(trail);
	return i;
}

size_t pl_walk_at(pl *l, const pl_here *from, const char *const *path, size_t n, pl_member *out) {
	return walk_from(l, from, path, n, out, NULL);
}

size_t pl_walk(pl *l, tb_key from, const char *const *path, size_t n, pl_member *out) {
	pl_here here = {.id = from, .has_path = same_key(from, l->root)};
	return pl_walk_at(l, &here, path, n, out);
}

// where a path's walk from the root ends: an id, or pl_level(), and the gone under it; 1, *out and
// *gone, or 0: the walk stopped short
static int reach(pl *l, const char *const *path, size_t n, tb_key *out, uint32_t *gone) {
	tb_key at = l->root;
	*gone = 0;
	if (!l->given) {
		for (size_t i = 0; i < n; i++) {
			if (!step(l, at, path[i], &at)) return 0;
		}
		*out = at;
		return 1;
	}
	pl_member *steps = xalloc((n + 1) * sizeof *steps);
	uint32_t *gones = xalloc((n + 1) * sizeof *gones);
	pl_here root = {.id = l->root, .has_path = 1};
	size_t got = walk_from(l, &root, path, n, steps, gones);
	if (got == n && n > 0) at = steps[n - 1].id, *gone = gones[n - 1];
	free(steps), free(gones);
	if (got < n) return 0;
	*out = at;
	return 1;
}

int pl_get(pl *l, const char *const *path, size_t n, tb_key *out) {
	tb_key at;
	uint32_t gone;
	if (!reach(l, path, n, &at, &gone) || same_key(at, pl_level())) return 0;
	*out = at;
	return 1;
}

// the walk to where you are, made once; each place's own walk goes on from it with the gone there
size_t pl_lookup(pl *l, const char *const *names, size_t nnames, const char *const *from,
	size_t nfrom, int all, size_t *depths) {
	tb_key *ids = xalloc((nfrom + 1) * sizeof *ids);
	uint32_t *gones = xalloc((nfrom + 1) * sizeof *gones);
	pl_member *steps = xalloc((nfrom + 1) * sizeof *steps);
	pl_member *taken = xalloc((nnames + 1) * sizeof *taken);
	ids[0] = l->root;
	pl_here root = {.id = l->root, .has_path = 1};
	size_t walked = walk_from(l, &root, from, nfrom, steps, gones + 1);
	for (size_t i = 0; i < walked; i++) ids[i + 1] = steps[i].id;
	size_t found = 0;
	for (size_t k = walked + 1; k-- > 0;) {
		pl_here here = {.id = ids[k], .has_path = 1, .path = from, .length = k, .gone = gones[k]};
		if (pl_walk_at(l, &here, names, nnames, taken) < nnames) continue;
		depths[found++] = k;
		if (!all) break;
	}
	free(ids), free(gones), free(steps), free(taken);
	return found;
}

void pl_answers_free(pl_answers *list) {
	free(list->items);
	*list = (pl_answers){0};
}

pl_answers pl_answers_at(pl *l, const pl_here *here, const char *name) {
	pl_answers out = {0};
	out.items = xalloc(l->nasked * sizeof *out.items);
	uint32_t gone = here->gone;
	out.gone = gone;
	for (size_t i = 0; i < l->nasked; i++) {
		if (gone & bit(i)) continue;
		const pl_contributor *c = l->asked[i];
		tb_key id;
		int got = c->step(c->ctx, here, name, l, &id);
		if (got == PL_NONE) out.gone |= bit(i);
		else if (got) out.items[out.n++] = (pl_answer){id, c->from};
	}
	// none: a level there, if a contributor has one (as the walk takes it)
	if (out.n == 0) {
		for (size_t i = 0; i < l->nasked; i++) {
			if (out.gone & bit(i)) continue;
			const pl_contributor *c = l->asked[i];
			if (c->level != NULL && c->level(c->ctx, here, name, l)) {
				out.items[out.n++] = (pl_answer){pl_level(), c->from};
				break;
			}
		}
	}
	return out;
}

pl_answers pl_gets(pl *l, const char *const *path, size_t n) {
	if (n == 0) {
		pl_answers out = {0};
		out.items = xalloc(sizeof *out.items);
		out.items[out.n++] = (pl_answer){l->root, "root"};
		return out;
	}
	// the folder it is in: an id, or a level
	tb_key id;
	uint32_t gone;
	if (!reach(l, path, n - 1, &id, &gone)) return (pl_answers){0};
	pl_here here = {.id = id, .has_path = 1, .path = path, .length = n - 1, .gone = gone};
	pl_answers all = pl_answers_at(l, &here, path[n - 1]);
	// a level is no answer
	size_t kept = 0;
	for (size_t i = 0; i < all.n; i++) {
		if (!same_key(all.items[i].id, pl_level())) all.items[kept++] = all.items[i];
	}
	all.n = kept;
	return all;
}

void pl_nameds_free(pl_nameds *list) {
	free(list->items);
	*list = (pl_nameds){0};
}

static const char seen_tag;

static int key_order(const void *a, const void *b) {
	const char *x = ((const pl_named *)a)->name, *y = ((const pl_named *)b)->name;
	size_t nx = strlen(x), ny = strlen(y);
	if (nx != ny) return nx < ny ? -1 : 1;
	return memcmp(x, y, nx);
}

pl_nameds pl_names(pl *l, const pl_here *here) {
	pl_nameds out = {0};
	size_t cap = 0;
	tb_table *seen = tb_new();
	uint32_t gone = here->gone;
	out.gone = gone;
	for (size_t i = 0; i < l->nasked; i++) {
		if (gone & bit(i)) continue;
		const pl_contributor *c = l->asked[i];
		pl_namelist names = {0};
		c->names(c->ctx, here, l, &names);
		if (names.none) out.gone |= bit(i);
		for (size_t j = 0; j < names.n; j++) {
			if (tb_get(seen, tb_symbol(&seen_tag), tb_string(names.items[j])) != NULL) continue;
			tb_add(seen, tb_symbol(&seen_tag), tb_string(names.items[j]), (void *)&seen_tag);
			if (out.n == cap) {
				cap = cap ? cap * 2 : 8;
				out.items = realloc(out.items, cap * sizeof *out.items);
				if (out.items == NULL) abort();
			}
			out.items[out.n++] = (pl_named){names.items[j], c->from};
		}
		pl_namelist_free(&names);
	}
	tb_free(seen);
	// several contributors: in keyorder (core/util keyorder.ts): shorter in UTF-8 bytes first, then
	// bytewise, the order canonical CBOR gives a map's keys
	if (l->nasked > 1) qsort(out.items, out.n, sizeof *out.items, key_order);
	return out;
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
			out.items[out.n++] = (pl_member){v->keys[i], tb_string(v->items[i]->str), NULL};
		}
	}
	return out;
}

// the members at a path: one read of the children map whole (any change to it reruns the reader),
// each name holding an id with its id. contributors given: every contributor's names, each name's
// step as pl_get takes it (a level: the id pl_level(), no id of its own); at a level too
pl_members pl_members_at(pl *l, const char *const *path, size_t n) {
	tb_key id;
	uint32_t gone;
	if (!reach(l, path, n, &id, &gone)) return (pl_members){0};
	if (l->given) {
		pl_here here = {.id = id, .has_path = 1, .path = path, .length = n, .gone = gone};
		pl_nameds names = pl_names(l, &here);
		// those whose names said none: gone for each name's walk too
		here.gone = names.gone;
		pl_members out = {0};
		out.items = xalloc((names.n + 1) * sizeof *out.items);
		for (size_t i = 0; i < names.n; i++) {
			pl_member m;
			if (pl_walk_at(l, &here, &names.items[i].name, 1, &m) == 1) out.items[out.n++] = m;
		}
		pl_nameds_free(&names);
		return out;
	}
	tell(l, pt_spot_of(l->s->paths, pair_key(l, tb_string(children_part)), paths_key(id), NULL, 0, 0));
	return members_of(tb_get(l->s->table, tb_string(children_part), id));
}

// the names at a path, every one the map holds, in their order there: one read of which names
// there are (a name added or taken out reruns the reader); ids not told (left empty). contributors
// given: every contributor's, each name once; at a level too
pl_members pl_list(pl *l, const char *const *path, size_t n) {
	tb_key id;
	uint32_t gone;
	if (!reach(l, path, n, &id, &gone)) return (pl_members){0};
	pl_members out = {0};
	if (l->given) {
		pl_here here = {.id = id, .has_path = 1, .path = path, .length = n, .gone = gone};
		pl_nameds names = pl_names(l, &here);
		out.items = xalloc((names.n + 1) * sizeof *out.items);
		for (size_t i = 0; i < names.n; i++) {
			out.items[out.n++] = (pl_member){names.items[i].name, {0}, names.items[i].from};
		}
		pl_nameds_free(&names);
		return out;
	}
	tell(l, pt_spot_of(l->s->paths, pair_key(l, tb_string(children_part)), paths_key(id), NULL, 0, 1));
	const nd_entry *children = tb_get(l->s->table, tb_string(children_part), id);
	const op_value *v = children != NULL ? children->value : NULL;
	if (!is_map(v)) return out;
	out.items = xalloc(v->count * sizeof *out.items);
	for (size_t i = 0; i < v->count; i++) out.items[out.n++] = (pl_member){v->keys[i], {0}, NULL};
	return out;
}

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

// upsert ----------------------------------------------------------------------------------------

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
	case OP_BYTES: return a->bytes == b->bytes && memcmp(a->data, b->data, a->bytes) == 0;
	case OP_TYPED:
		return a->kind == b->kind && a->bytes == b->bytes && memcmp(a->data, b->data, a->bytes) == 0;
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
} ublock;

static void ublock_free(void *b) {
	ublock *k = b;
	for (size_t i = 0; i < k->n; i++) free(k->names[i]);
	free(k->names);
	free(k->keys);
	op_free(k->value);
	free(k);
}

// the value at names in a map; NULL: nothing there
static const op_value *value_at(const op_value *v, const char *const *names, size_t n) {
	for (size_t i = 0; i < n; i++) {
		if (!is_map(v)) return NULL;
		v = op_get(v, names[i]);
		if (v == NULL) return NULL;
	}
	return v;
}

// the one patch of an upsert applied to the entry and held by it
static void write_one(pl *l, nd_entry *entry, ublock *b, ch_header header, pl_changed *changed) {
	size_t failed;
	int code = nd_update(entry, &b->patch, 1, header, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "places: upsert: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(l, entry, b, ublock_free);
	changed->entries[changed->n++] = entry;
}

void pl_own(pl *l, nd_entry *node) {
	if (l->s->nowned == l->s->capowned) {
		l->s->capowned = l->s->capowned ? l->s->capowned * 2 : 8;
		l->s->owned = realloc(l->s->owned, l->s->capowned * sizeof *l->s->owned);
		if (l->s->owned == NULL) abort();
	}
	l->s->owned[l->s->nowned++] = node;
}

int pl_upsert(pl *l, tb_key part, tb_key id, const char *const *path, size_t n,
	const op_value *value, ch_header header, pl_changed *changed, nd_entry **made) {
	*changed = (pl_changed){0};
	if (made != NULL) *made = NULL;
	nd_entry *there = tb_get(l->s->table, part, id);
	if (there == NULL) {
		op_value *nested = nest(path, n, value);
		nd_entry *node = nd_make_entry(nested, &header, NULL);
		op_free(nested);
		pl_own(l, node);
		if (made != NULL) *made = node;
		tb_add(l->s->table, part, id, node);
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
	ublock *b = xalloc(sizeof *b);
	b->n = at;
	b->names = xalloc(at * sizeof *b->names);
	b->keys = xalloc(at * sizeof *b->keys);
	for (size_t i = 0; i < at; i++) {
		b->names[i] = xdup(path[i]);
		b->keys[i] = (op_key){.type = OP_STR_KEY, .s = b->names[i]};
	}
	b->value = nest(path + at, n - at, value);
	b->patch = (op_patch){.place = {.path = b->keys, .length = at}, .has_value = 1, .value = b->value};
	write_one(l, there, b, header, changed);
	return 0;
}

const op_value *pl_get_or_set(pl *l, tb_key part, tb_key id, const char *const *path, size_t n,
	op_value *(*make)(void *ctx), void *ctx, ch_header header, pl_changed *changed,
	nd_entry **made) {
	*changed = (pl_changed){0};
	if (made != NULL) *made = NULL;
	const nd_entry *there = tb_get(l->s->table, part, id);
	const op_value *v = there != NULL ? value_at(there->value, path, n) : NULL;
	if (v != NULL) return v;
	op_value *fresh = make(ctx);
	pl_upsert(l, part, id, path, n, fresh, header, changed, made);
	op_free(fresh);
	return value_at(((nd_entry *)tb_get(l->s->table, part, id))->value, path, n);
}

// who ------------------------------------------------------------------------------------------

// the scheduler's own pairs, run and mark: numbers it keeps as uint64_t
static int scheduler_own(const sc_pair *p) {
	return strcmp(p->key, "run") == 0 || strcmp(p->key, "mark") == 0;
}

// who a write is, as levels are seen: the metadata so far (a map), the actor and reader found
// (holds; NULL: none yet), and whether the metadata still takes keys (not past the first scope
// holding PL_NODE)
typedef struct {
	op_value *metadata, *actor, *reader;
	bool shown;
} seeing;

// one level's pairs. a scope's (scoped): its run and mark as numbers. a key already in the
// metadata is an inner level's: it stays. whether they hold PL_NODE
static bool see(seeing *w, const sc_pair *pairs, size_t n, bool scoped) {
	bool node = false;
	for (size_t i = 0; i < n; i++) {
		const sc_pair *p = &pairs[i];
		op_value *v = scoped && scheduler_own(p) ? op_num((double)*(const uint64_t *)p->value)
		                                         : op_ref((op_value *)p->value);
		if (w->actor == NULL && strcmp(p->key, "actor") == 0) w->actor = op_ref(v);
		if (w->reader == NULL && strcmp(p->key, "reader") == 0 && v->type == OP_STR)
			w->reader = op_ref(v);
		if (strcmp(p->key, PL_NODE) == 0) node = true;
		if (w->shown && op_get(w->metadata, p->key) == NULL) op_set(w->metadata, p->key, v);
		else op_free(v);
	}
	return node;
}

// levels, innermost first: extra, the scope open, its parents to the root. metadata: one map, inner
// keys over outer, up to and with the first scope whose own pairs hold PL_NODE. 0: no scope open,
// nothing made
static bool who_of(pl *l, const sc_pair *extra, size_t n, seeing *w) {
	sc_scope *o = sc_get_current_scope(l->s->scheduler);
	if (o == NULL) return false;
	*w = (seeing){.metadata = op_map(), .shown = true};
	see(w, extra, n, false);
	for (; o != NULL; o = sc_scope_parent(o)) {
		const sc_info *info = sc_scope_info(o);
		if (info != NULL && see(w, info->pairs, info->n, true)) w->shown = false;
	}
	return true;
}

op_value *pl_who(pl *l, const sc_pair *extra, size_t n) {
	seeing w;
	if (!who_of(l, extra, n, &w)) return NULL;
	op_value *who = op_map();
	if (w.actor != NULL) op_set(who, "actor", w.actor);
	if (w.reader != NULL) op_set(who, "reader", w.reader);
	op_set(who, "metadata", w.metadata);
	return who;
}


char *pl_header(pl *l, const sc_pair *extra, size_t n, const ch_site *site, ch_header *out,
	pl_made **made) {
	seeing w;
	if (!who_of(l, extra, n, &w)) return xdup(SC_UNSCOPED);
	op_value *pairs = w.metadata;
	pl_made *m = xalloc(sizeof *m);
	m->refs = 1;
	m->pairs = pairs, m->actor = w.actor, m->reader = w.reader;
	m->entries = xalloc((pairs->count ? pairs->count : 1) * sizeof *m->entries);
	ch_header h = {.has_time = 1, .time = (int64_t)time(NULL)};
	for (size_t i = 0; i < pairs->count; i++) m->entries[i] = (ch_entry){pairs->keys[i], pairs->items[i]};
	h.actor = w.actor;
	if (w.reader != NULL) h.reader = w.reader->str;
	h.metadata = m->entries, h.metadata_length = pairs->count;
	if (site != NULL) {
		m->site = *site;
		h.external = &m->site, h.external_length = 1;
	}
	m->s = l->s;
	m->next = l->s->mades;
	if (m->next != NULL) m->next->before = m;
	l->s->mades = m;
	pm_set(&l->s->made_by, m->entries, m);
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
	if (m->s != NULL) {
		pm_delete(&m->s->made_by, m->entries);
		if (m->before != NULL) m->before->next = m->next;
		else m->s->mades = m->next;
		if (m->next != NULL) m->next->before = m->before;
	}
	op_free(m->change);
	op_free(m->pairs), op_free(m->actor), op_free(m->reader);
	free(m->entries), free(m);
}

// a header's pieces as a map: time, actor, reader, external, metadata (the block's own map)
static op_value *change_of(const ch_header *h, pl_made *m) {
	op_value *c = op_map();
	if (h->has_time) op_set(c, "time", op_num((double)h->time));
	if (h->actor != NULL) op_set(c, "actor", op_ref((op_value *)h->actor));
	if (h->reader != NULL) op_set(c, "reader", op_str(h->reader));
	if (h->external_length > 0) {
		op_value *sites = op_list();
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			op_value *site = op_map();
			op_set(site, "file", op_str(s->file ? s->file : ""));
			op_set(site, "line", op_num((double)s->line));
			if (s->has_column) op_set(site, "column", op_num((double)s->column));
			if (s->function != NULL) op_set(site, "function", op_str(s->function));
			op_push(sites, site);
		}
		op_set(c, "external", sites);
	}
	if (h->metadata_length > 0) op_set(c, "metadata", op_ref(m->pairs));
	return c;
}

const op_value *pl_change_value(pl *l, const ch_header *h) {
	if (h == NULL || h->metadata == NULL) return NULL;
	pl_made *m = pm_get(&l->s->made_by, h->metadata);
	// another block's metadata, or a header whose pieces were changed after: not this one
	if (m == NULL || h->metadata_length != m->pairs->count || h->actor != m->actor) return NULL;
	if (m->change == NULL) m->change = change_of(h, m);
	const op_value *t = op_get(m->change, "time");
	if (h->has_time != (t != NULL) || (t != NULL && t->num != (double)h->time)) return NULL;
	if (h->external_length != (op_get(m->change, "external") ? op_get(m->change, "external")->count : 0))
		return NULL;
	return m->change;
}
