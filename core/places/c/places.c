// Places (places.h), in C.
#include "places.h"
#include "../../../lib/changeable/c/ptrmap.h"
#include "../../../lib/crow/c/crow.h"
#include "crowify.h"

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

typedef struct {
	tb_key part;
} pl_pair;
typedef struct pair pair;
struct pair {
	pl_pair pair;
	pair *next;
};

typedef struct hold hold;
struct hold {
	void *block;
	void (*release)(void *block);
	hold *prev, *next;
	hold *chain;
};

struct pl_watch {
	pl *l;
	pl_watch_fn fn;
	void *ctx;
	int stopped;
	pl_watch *prev, *next;
};

// An entry the places owns, freed when it leaves its table (NULL table: only at pl_free).
typedef struct {
	nd_entry *node;
	tb_table *in;
} owned_t;

// A places' state.
typedef struct {
	tb_table *table;
	pt_paths *paths;
	sc_scheduler *scheduler;
	tb_table *pairs;
	pair *all;
	pm mine;
	int loosening;
	pm loose;
	int64_t (*now)(void *ctx);
	void *now_ctx;
	op_value scratch;
	sc_track_status status;
	// keeps of writes; ones let go during a telling wait until it ends, as a fact may point into them
	pm holds;
	hold *held, *dropped;
	// pl_watch_all's functions; ones stopped during a telling wait until it ends
	pl_watch *alls, *alls_end, *dead;
	int telling;
	cr_crow *crow;
	owned_t *owned;
	size_t nowned, capowned, swept;
	pl_set *into;
	pl_set *made;
	int peeping;
	tb_table *kept;
	size_t refs;
	pm made_by;
	struct pl_made *mades;
} shared;


static const char spots;

struct pl_made {
	size_t refs;
	ch_frame *frame;
	op_value *change;
	shared *s;
	struct pl_made *before, *next;
};

struct pl {
	tb_key root;
	const pl_contributor *const *asked;
	size_t nasked;
	// where the table's own values sit among the contributors that read
	size_t stored_at;
	const char *stored_by;
	shared *s;
};

static pt_key paths_key(tb_key k) { return (pt_key){.string = k.string, .symbol = k.symbol}; }

static const char pairing;

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


pl *pl_new(void) {
	pl *l = xalloc(sizeof *l);
	l->s = xalloc(sizeof *l->s);
	l->s->refs = 1;
	l->s->pairs = tb_new();
	l->s->kept = tb_new();
	l->s->crow = cr_new();
	if (l->s->crow == NULL) abort();
	return l;
}

void pl_connect(pl *l, const pl_setup *setup) {
	l->root = setup->root;
	l->s->table = setup->table;
	l->s->paths = setup->paths;
	l->s->scheduler = setup->scheduler;
	l->s->loosening = setup->tracking;
	l->s->now = setup->now;
	l->s->now_ctx = setup->now_ctx;
	l->asked = setup->contributors;
	l->nasked = setup->ncontributors;
	l->stored_at = l->nasked;
	l->stored_by = "table";
	for (size_t i = 0; i < l->nasked; i++) {
		if (!l->asked[i]->stored) continue;
		l->stored_at = i;
		l->stored_by = l->asked[i]->from;
		break;
	}
}

tb_key pl_root(const pl *l) { return l->root; }

cr_crow *pl_crow(pl *l) { return l->s->crow; }

const pl_contributor *const *pl_contributors(const pl *l, size_t *n) {
	*n = l->nasked;
	return l->asked;
}

static void unhold(pl *l, hold *h) {
	if (h->prev != NULL) h->prev->next = h->next;
	else l->s->held = h->next;
	if (h->next != NULL) h->next->prev = h->prev;
	if (l->s->telling > 0) {
		h->next = l->s->dropped;
		l->s->dropped = h;
		return;
	}
	h->release(h->block);
	free(h);
}

static void free_dead(pl *l);

void pl_free(pl *l) {
	if (l == NULL) return;
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
	while (s->alls != NULL) pl_stop(s->alls);
	free_dead(l);
	for (size_t i = 0; i < s->nowned; i++) nd_free_entry(s->owned[i].node);
	free(s->owned);
	cr_free(s->crow);
	pm_clear(&s->holds);
	pm_clear(&s->loose);
	// blocks still held elsewhere outlive the places: they forget it
	for (struct pl_made *m = s->mades; m != NULL; m = m->next) m->s = NULL;
	pm_clear(&s->made_by);
	tb_free(s->kept);
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


sc_track_status pl_status(pl *l) {
	sc_track_status status = l->s->status;
	l->s->status = SC_OK;
	return status;
}

static void tell(pl *l, pt_spot *s) {
	int known = pm_get(&l->s->mine, s) != NULL;
	if (!known) pm_set(&l->s->mine, s, s);
	if (!known && l->s->loosening && l->s->into == NULL) pm_set(&l->s->loose, s, s);
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
	pm_delete(&l->s->loose, key);
	pt_release(l->s->paths, s);
}

void pl_tracking(const void *key, sc_run *run, void *ctx) {
	(void)run;
	pl *l = ctx;
	pm_delete(&l->s->loose, key);
}


#define SET_SMALL 8
#define EMPTY ((size_t)0)
#define TOMB ((size_t)-1)

static size_t hash_of(const void *p) {
	uint64_t x = (uint64_t)(uintptr_t)p;
	x ^= x >> 33, x *= 0xff51afd7ed558ccdULL, x ^= x >> 33;
	return (size_t)x;
}

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
	int was_peeping = l->s->peeping;
	l->s->into = reads;
	l->s->made = fresh;
	l->s->peeping = 0;
	f(ctx);
	l->s->into = was;
	l->s->made = was_made;
	l->s->peeping = was_peeping;
}

void pl_peep(pl *l, void (*f)(void *ctx), void *ctx) {
	l->s->peeping++;
	f(ctx);
	l->s->peeping--;
}

void pl_track(pl *l, const void *key) {
	if (l->s->peeping) return;
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

static double element(const op_value *t, size_t i) {
	if (t->type == OP_BYTES) return t->data[i];
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
		} else if ((v->type == OP_TYPED || v->type == OP_BYTES) && scratch != NULL && path[i].n >= 0 &&
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
	if (!l->s->peeping) tell(l, pt_spot_of(l->s->paths, pair_key(l, part), paths_key(id), path, n, 0));
	const nd_entry *node = tb_get(l->s->table, part, id);
	return node != NULL ? pl_at(node->value, path, n, &l->s->scratch) : NULL;
}

int pl_read_range(pl *l, tb_key part, tb_key id, const op_key *path, size_t n, int64_t a, int64_t b,
	op_value **out) {
	*out = NULL;
	if (!l->s->peeping) tell(l, pt_spot_of(l->s->paths, pair_key(l, part), paths_key(id), path, n, 0));
	if (a < 0 || b < 0) return OP_NOT_A_PATCH;
	// The path walks as pl_at does: nothing there is nothing, no error.
	const nd_entry *node = tb_get(l->s->table, part, id);
	const op_value *v = node != NULL ? pl_at(node->value, path, n, &l->s->scratch) : NULL;
	if (v == NULL) return OP_OK;
	if (a > b) return OP_RANGE;
	if (v->type == OP_STR) {
		size_t x, y;
		if (!op_string_span(v, a, b, &x, &y)) return OP_RANGE;
		char *s = malloc(y - x + 1);
		if (s == NULL) abort();
		memcpy(s, v->str + x, y - x);
		s[y - x] = 0;
		*out = op_str_counted(s, y - x, (size_t)(b - a));
	} else if (v->type == OP_LIST) {
		if ((uint64_t)b > v->count) return OP_RANGE;
		op_value *r = op_list();
		for (int64_t i = a; i < b; i++) op_push(r, op_ref(v->items[i]));
		*out = r;
	} else if (v->type == OP_BYTES || v->type == OP_TYPED) {
		if ((uint64_t)b > op_length(v)) return OP_RANGE;
		size_t z = v->type == OP_BYTES ? 1 : op_size(v->kind);
		*out = v->type == OP_BYTES ? op_bytes(v->data + (size_t)a, (size_t)(b - a))
					   : op_typed(v->kind, v->data + (size_t)a * z, (size_t)(b - a));
	} else return OP_WRONG_KIND;
	return OP_OK;
}

void pl_versions_add(pl_versions *out, pl_version item) {
	if (out->n == out->cap) {
		out->cap = out->cap ? out->cap * 2 : 4;
		out->items = realloc(out->items, out->cap * sizeof *out->items);
		if (out->items == NULL) abort();
	}
	out->items[out->n++] = item;
}

void pl_showns_free(pl_showns *list) {
	for (size_t i = 0; i < list->n; i++) {
		op_free((op_value *)list->items[i].value);
		op_free((op_value *)list->items[i].from);
	}
	free(list->items);
	*list = (pl_showns){0};
}

static void shown_add(pl_showns *out, pl_shown item) {
	if (out->n == out->cap) {
		out->cap = out->cap ? out->cap * 2 : 4;
		out->items = realloc(out->items, out->cap * sizeof *out->items);
		if (out->items == NULL) abort();
	}
	out->items[out->n++] = item;
}

static int ask(const pl_contributor *c, tb_key part, tb_key id, const op_key *path, size_t n,
	pl_showns *out) {
	if (c->read == NULL) return 0;
	pl_versions held = {0};
	int code = c->read(c->ctx, part, id, path, n, &held);
	for (size_t i = 0; i < held.n && !code; i++) {
		pl_version *v = &held.items[i];
		shown_add(out, (pl_shown){op_ref((op_value *)v->value), v->gone, op_ref((op_value *)v->from),
			NULL, c->from});
	}
	free(held.items);
	return code;
}

int pl_read_all(pl *l, tb_key part, tb_key id, const op_key *path, size_t n, pl_showns *out) {
	if (!l->s->peeping) tell(l, pt_spot_of(l->s->paths, pair_key(l, part), paths_key(id), path, n, 0));
	*out = (pl_showns){0};
	int code = 0;
	for (size_t i = 0; i < l->stored_at && !code; i++) code = ask(l->asked[i], part, id, path, n, out);
	if (code) return code;
	const nd_entry *node = tb_get(l->s->table, part, id);
	const op_value *v = node != NULL ? pl_at(node->value, path, n, &l->s->scratch) : NULL;
	// a typed array element sits in scratch, which a later pl_read writes over: copy it
	op_value *mine = v == &l->s->scratch ? op_num(v->num) : op_ref((op_value *)v);
	if (mine != NULL) shown_add(out, (pl_shown){mine, 0, NULL, &node->change, l->stored_by});
	// the one marked stored answers right after the table's
	for (size_t i = l->stored_at; i < l->nasked && !code; i++) code = ask(l->asked[i], part, id, path, n, out);
	return code;
}

static const op_value a_map = {.type = OP_MAP};
const op_value *pl_a_map(void) { return &a_map; }

const op_value *pl_read_here(pl *l, tb_key part, tb_key id, const op_key *path, size_t n) {
	if (!l->s->peeping) tell(l, pt_spot_of(l->s->paths, pair_key(l, part), paths_key(id), path, n, PT_HERE));
	const nd_entry *node = tb_get(l->s->table, part, id);
	const op_value *v = node != NULL ? pl_at(node->value, path, n, &l->s->scratch) : NULL;
	return v != NULL && v->type == OP_MAP ? &a_map : v;
}

const ch_header *pl_change(pl *l, tb_key part, tb_key id) {
	if (!l->s->peeping) tell(l, pt_change_of(l->s->paths, pair_key(l, part), paths_key(id)));
	const nd_entry *node = tb_get(l->s->table, part, id);
	return node != NULL ? &node->change : NULL;
}


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

// Says the spots changed in one call. Loose spots (read outside any run, tracked by none) are
// let go afterwards, as in paths.ts, since no reader holds them.
static void say(pl *l, const spots_vec *marked) {
	if (marked->n > 0) sc_mark(l->s->scheduler, marked->v, marked->n, sc_get_run(l->s->scheduler));
	if (l->s->loose.count == 0) return;
	for (size_t i = 0; i < marked->n; i++) {
		const void *key = marked->v[i];
		if (!pm_has(&l->s->loose, key)) continue;
		pm_delete(&l->s->loose, key);
		if (tb_get(l->s->kept, tb_symbol(&spots), tb_symbol(key)) != NULL) continue;
		pt_spot *s = pm_get(&l->s->mine, key);
		if (s == NULL) continue;
		pm_delete(&l->s->mine, key);
		pt_release(l->s->paths, s);
	}
}

static int same_key(tb_key a, tb_key b) {
	if (a.symbol != NULL || b.symbol != NULL) return a.symbol == b.symbol;
	return a.string != NULL && b.string != NULL && strcmp(a.string, b.string) == 0;
}

static void tell_alls(pl *l, const pl_fact *facts, size_t n);
static void landed(pl *l, tb_key part, tb_key id);

int pl_add(pl *l, tb_key part, tb_key id, nd_entry *entry) {
	if (tb_get(l->s->table, part, id) == entry) return 0;
	int code = tb_add(l->s->table, part, id, entry);
	if (code == 0) landed(l, part, id);
	return code;
}

void pl_sub(pl *l, tb_key part, tb_key id, nd_entry *entry) {
	if (tb_get(l->s->table, part, id) == entry) return;
	tb_sub(l->s->table, part, id, entry);
	landed(l, part, id);
}

int pl_del(pl *l, tb_key part, tb_key id) {
	int code = tb_del(l->s->table, part, id);
	if (code == 0) landed(l, part, id);
	return code;
}

void pl_moved(pl *l, tb_key part, tb_key id, const op_patch *patches, size_t length) {
	size_t n;
	pt_spot *const *spots = patches == NULL
		? pt_event(l->s->paths, pair_key(l, part), paths_key(id), &n)
		: pt_mark(l->s->paths, pair_key(l, part), paths_key(id), patches, length, &n);
	spots_vec out = {0};
	add_spots(&out, spots, n);
	say(l, &out);
	free(out.v);
}

static void landed(pl *l, tb_key part, tb_key id) {
	size_t n;
	pt_spot *const *spots = pt_event(l->s->paths, pair_key(l, part), paths_key(id), &n);
	spots_vec out = {0};
	add_spots(&out, spots, n);
	say(l, &out);
	free(out.v);
	if (l->s->alls != NULL) {
		const nd_entry *entry = tb_get(l->s->table, part, id);
		op_patch patch = {0};
		if (entry != NULL && entry->value != NULL) {
			patch.has_value = 1;
			patch.value = op_ref(entry->value);
		}
		// Take the value and change as they are now, since a function that writes the entry changes
		// them. For a take-out, make a change from the open scope (if any) with the site here.
		ch_header change = entry != NULL ? entry->change : (ch_header){0};
		pl_made *made = NULL;
		int changed = entry != NULL;
		if (entry == NULL) {
			char *error = pl_header(l, NULL, 0, CH_HERE, &change, &made);
			if (error == NULL) changed = 1;
			free(error);
		}
		pl_fact fact = {part, id, &patch, 1, changed ? &change : NULL, entry};
		tell_alls(l, &fact, 1);
		if (made != NULL) pl_made_free(made);
		op_free((op_value *)patch.value);
	}
}

typedef struct {
	size_t n;
	pl_fact *items;
	ch_header *changes;
} pl_facts;

static void pl_facts_free(pl_facts *facts) {
	free(facts->items);
	free(facts->changes);
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
				out.changes = realloc(out.changes, capacity * sizeof *out.changes);
				if (out.items == NULL || out.changes == NULL) abort();
			}
			out.changes[out.n] = node->change;
			out.items[out.n++] = (pl_fact){where[k].part, where[k].id, node->change.patches,
				node->change.patches_length, NULL, node};
		}
	}
	for (size_t i = 0; i < out.n; i++) out.items[i].change = &out.changes[i];
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
	pl_facts_free(&facts);
}


static void free_dead(pl *l) {
	while (l->s->dead != NULL) {
		pl_watch *w = l->s->dead;
		l->s->dead = w->next;
		free(w);
	}
	while (l->s->dropped != NULL) {
		hold *h = l->s->dropped;
		l->s->dropped = h->next;
		h->release(h->block);
		free(h);
	}
}

pl_watch *pl_watch_all(pl *l, pl_watch_fn fn, void *ctx) {
	pl_watch *w = xalloc(sizeof *w);
	w->l = l;
	w->fn = fn;
	w->ctx = ctx;
	w->prev = l->s->alls_end;
	if (w->prev != NULL) w->prev->next = w;
	else l->s->alls = w;
	l->s->alls_end = w;
	return w;
}

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
	if (w->prev != NULL) w->prev->next = w->next;
	else l->s->alls = w->next;
	if (w->next != NULL) w->next->prev = w->prev;
	else l->s->alls_end = w->prev;
	w->prev = NULL;
	w->next = l->s->dead;
	l->s->dead = w;
	if (l->s->telling == 0) free_dead(l);
}


static int is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

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
	if (!l->s->peeping) tell(l, pt_spot_of(l->s->paths, pair_key(l, part), paths_key(id), path, n, 1));
	const nd_entry *node = tb_get(l->s->table, part, id);
	const op_value *v = node != NULL ? pl_at(node->value, path, n, &l->s->scratch) : NULL;
	if (!is_map(v)) return;
	for (size_t i = 0; i < v->count; i++) {
		if (!ids || v->items[i]->type == OP_STR) pl_namelist_add(out, v->keys[i]);
	}
}

static const char level_tag;
tb_key pl_level(void) { return tb_symbol(&level_tag); }

static uint32_t bit(size_t i) { return i < 32 ? (uint32_t)1 << i : 0; }

static int go(pl *l, const pl_here *here, const char *name, tb_key *out, const char **by,
	uint32_t *under) {
	uint32_t gone = here->gone, said = gone;
	for (size_t i = 0; i < l->nasked; i++) {
		if (gone & bit(i)) continue;
		const pl_contributor *c = l->asked[i];
		int got = c->step != NULL ? c->step(c->ctx, here, name, l, out) : 0;
		if (got == PL_NONE) said |= bit(i);
		else if (got) {
			*by = c->from;
			*under = said;
			return 1;
		}
	}
	*under = said;
	// might be fishy. TODO is this fishy?
	// No id anywhere, but a contributor has a level there (processes at /dev/clock with no /dev
	// saved): the walk goes on through it as through a folder.
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

static size_t walk_from(pl *l, const pl_here *from, const char *const *path, size_t n,
	pl_member *out, uint32_t *gones) {
	size_t i = 0;
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

static int reach(pl *l, const char *const *path, size_t n, tb_key *out, uint32_t *gone) {
	tb_key at = l->root;
	*gone = 0;
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
		int got = c->step != NULL ? c->step(c->ctx, here, name, l, &id) : 0;
		if (got == PL_NONE) out.gone |= bit(i);
		else if (got) out.items[out.n++] = (pl_answer){id, c->from};
	}
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
	tb_key id;
	uint32_t gone;
	if (!reach(l, path, n - 1, &id, &gone)) return (pl_answers){0};
	pl_here here = {.id = id, .has_path = 1, .path = path, .length = n - 1, .gone = gone};
	pl_answers all = pl_answers_at(l, &here, path[n - 1]);
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

static size_t utf8_length(const char *s) {
	size_t n = 0;
	for (; *s != '\0'; s++, n++) {
		if ((unsigned char)s[0] == 0xC0 && (unsigned char)s[1] == 0x80) s++;
	}
	return n;
}

static int key_order(const void *a, const void *b) {
	const unsigned char *x = (const unsigned char *)((const pl_named *)a)->name;
	const unsigned char *y = (const unsigned char *)((const pl_named *)b)->name;
	size_t nx = utf8_length((const char *)x), ny = utf8_length((const char *)y);
	if (nx != ny) return nx < ny ? -1 : 1;
	// the same length: bytewise, a C0 80 as the 00 it stands for
	while (*x != '\0' || *y != '\0') {
		int cx = *x, cy = *y;
		if (cx == 0xC0 && x[1] == 0x80) cx = 0, x++;
		if (cy == 0xC0 && y[1] == 0x80) cy = 0, y++;
		if (cx != cy) return cx < cy ? -1 : 1;
		x++, y++;
	}
	return 0;
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
		if (c->names != NULL) c->names(c->ctx, here, l, &names);
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
	// several contributors: in keyorder (changeable keyorder.ts)
	if (l->nasked > 1 && out.n > 1) qsort(out.items, out.n, sizeof *out.items, key_order);
	return out;
}

void pl_members_free(pl_members *list) {
	free(list->items);
	*list = (pl_members){0};
}

pl_members pl_members_at(pl *l, const char *const *path, size_t n) {
	tb_key id;
	uint32_t gone;
	if (!reach(l, path, n, &id, &gone)) return (pl_members){0};
	pl_here here = {.id = id, .has_path = 1, .path = path, .length = n, .gone = gone};
	pl_nameds names = pl_names(l, &here);
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

pl_members pl_list(pl *l, const char *const *path, size_t n) {
	tb_key id;
	uint32_t gone;
	if (!reach(l, path, n, &id, &gone)) return (pl_members){0};
	pl_here here = {.id = id, .has_path = 1, .path = path, .length = n, .gone = gone};
	pl_nameds names = pl_names(l, &here);
	pl_members out = {0};
	out.items = xalloc((names.n + 1) * sizeof *out.items);
	for (size_t i = 0; i < names.n; i++) {
		out.items[out.n++] = (pl_member){names.items[i].name, {0}, names.items[i].from};
	}
	pl_nameds_free(&names);
	return out;
}


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

void pl_own_in(pl *l, nd_entry *node, tb_table *in) {
	if (l->s->nowned == l->s->capowned) {
		l->s->capowned = l->s->capowned ? l->s->capowned * 2 : 8;
		l->s->owned = realloc(l->s->owned, l->s->capowned * sizeof *l->s->owned);
		if (l->s->owned == NULL) abort();
	}
	l->s->owned[l->s->nowned++] = (owned_t){node, in};
}

void pl_own(pl *l, nd_entry *node) { pl_own_in(l, node, NULL); }

void pl_sweep(pl *l) {
	shared *s = l->s;
	if (s->telling > 0 || s->nowned < 2 * s->swept + 64) return;
	size_t k = 0;
	for (size_t i = 0; i < s->nowned; i++) {
		owned_t o = s->owned[i];
		size_t n = 1;
		if (o.in != NULL) tb_who(o.in, o.node, &n);
		if (n > 0) {
			s->owned[k++] = o;
			continue;
		}
		// out of its table: its holds, what crow copied of it, and it, let go
		hold *h = pm_get(&s->holds, o.node);
		if (h != NULL) {
			pm_delete(&s->holds, o.node);
			unhold_chain(l, h);
		}
		cr_let_go(s->crow, o.node);
		nd_free_entry(o.node);
	}
	s->nowned = s->swept = k;
}


static void who_of(const ch_frame *f, const op_value **actor, const op_value **reader) {
	*actor = *reader = NULL;
	for (; f != NULL; f = f->parent) {
		for (size_t i = 0; i < f->n; i++) {
			const ch_pair *p = &f->pairs[i];
			const op_value *v = p->value;
			if (*actor == NULL && strcmp(p->key, "actor") == 0) *actor = v;
			if (*reader == NULL && strcmp(p->key, "reader") == 0 && v->type == OP_STR) *reader = v;
		}
	}
}

static ch_frame *base_of(pl *l, const sc_pair *extra, size_t n) {
	ch_frame *open = sc_get_current_frame(l->s->scheduler);
	if (open == NULL) return NULL;
	if (extra == NULL) return ch_frame_ref(open);
	return ch_frame_make(extra, n, open);
}

op_value *pl_change_base(pl *l, const sc_pair *extra, size_t n) {
	ch_frame *frame = base_of(l, extra, n);
	if (frame == NULL) return NULL;
	const op_value *actor, *reader;
	who_of(frame, &actor, &reader);
	op_value *who = op_map();
	if (actor != NULL) op_set(who, "actor", op_ref((op_value *)actor));
	if (reader != NULL) op_set(who, "reader", op_ref((op_value *)reader));
	op_set(who, "frame", ch_frame_value(frame));
	ch_frame_free(frame);
	return who;
}

char *pl_header(pl *l, const sc_pair *extra, size_t n, const ch_location *site, ch_header *out,
	pl_made **made) {
	ch_frame *frame = base_of(l, extra, n);
	if (frame == NULL) return xdup(SC_UNSCOPED);
	// from outside the graph (no run open, no frame holding locations), add the call's location as
	// a frame on top
	if (site != NULL && sc_get_run(l->s->scheduler) == NULL && !ch_frame_located(frame)) {
		ch_frame *top = ch_frame_at(site, frame);
		ch_frame_free(frame);
		frame = top;
	}
	pl_made *m = pm_get(&l->s->made_by, frame);
	if (m != NULL) {
		m->refs++;
		ch_frame_free(frame);
	} else {
		m = xalloc(sizeof *m);
		m->refs = 1;
		m->frame = frame;
		m->s = l->s;
		m->next = l->s->mades;
		if (m->next != NULL) m->next->before = m;
		l->s->mades = m;
		pm_set(&l->s->made_by, frame, m);
	}
	const op_value *actor, *reader;
	who_of(m->frame, &actor, &reader);
	ch_header h = {.has_time = 1, .time = l->s->now != NULL ? l->s->now(l->s->now_ctx) / 1000 : (int64_t)time(NULL)};
	h.actor = actor;
	if (reader != NULL) h.reader = reader->str;
	h.frame = m->frame;
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
		pm_delete(&m->s->made_by, m->frame);
		if (m->before != NULL) m->before->next = m->next;
		else m->s->mades = m->next;
		if (m->next != NULL) m->next->before = m->before;
	}
	op_free(m->change);
	ch_frame_free(m->frame);
	free(m);
}

static op_value *change_of(const ch_header *h) {
	op_value *c = op_map();
	if (h->has_time) op_set(c, "time", op_num((double)h->time));
	if (h->actor != NULL) op_set(c, "actor", op_ref((op_value *)h->actor));
	if (h->reader != NULL) op_set(c, "reader", op_str(h->reader));
	if (h->frame != NULL) op_set(c, "frame", ch_frame_value(h->frame));
	return c;
}

const op_value *pl_change_value(pl *l, const ch_header *h) {
	if (h == NULL || h->frame == NULL) return NULL;
	pl_made *m = pm_get(&l->s->made_by, h->frame);
	if (m == NULL) return NULL;
	if (m->change == NULL) m->change = change_of(h);
	const op_value *t = op_get(m->change, "time");
	if (h->has_time != (t != NULL) || (t != NULL && t->num != (double)h->time)) return NULL;
	if (op_get(m->change, "actor") != h->actor) return NULL;
	return m->change;
}
