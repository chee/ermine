// The table (table.h) in C: four hash maps over linked records, kept in step.
//   entries: (part, id) → a record of the key, its node, and its place in two lists
//   ids:     id → its entries in the order made
//   nodes:   node → its groups, one per part, in the order each was first taken
//   groups:  (node, part) → its entries in the order made
// A group, a node record and an id record are freed with their last entry. A part string is
// stored once however many groups use it, as a counted copy; an id string lives in its record.
#include "table.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xrealloc(void *p, size_t n) {
	void *q = realloc(p, n);
	if (q == NULL && n != 0) {
		fputs("table: out of memory\n", stderr);
		abort();
	}
	return q;
}
static char *xdup(const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(xrealloc(NULL, n), s, n);
}
#define GROW(p, count, capacity) \
	do { \
		if ((count) == (capacity)) { \
			(capacity) = (capacity) ? (capacity) * 2 : 8; \
			(p) = xrealloc((p), (capacity) * sizeof *(p)); \
		} \
	} while (0)

const char *tb_code_name(int code) {
	switch (code) {
	case TB_NOTHING_THERE: return "nothing-there";
	case TB_ALREADY_THERE: return "already-there";
	}
	return "";
}


// MurmurHash3's finalizer: the 64-bit one where size_t is 64 bits, otherwise the 32-bit one.
static size_t mix(size_t h) {
#if SIZE_MAX > 0xffffffffu
	h ^= h >> 33;
	h *= 0xff51afd7ed558ccdULL;
	h ^= h >> 33;
#else
	h ^= h >> 16;
	h *= 0x85ebca6bu;
	h ^= h >> 13;
	h *= 0xc2b2ae35u;
	h ^= h >> 16;
#endif
	return h;
}
static size_t hash_key(tb_key k) {
	if (k.symbol != NULL) return mix((uintptr_t)k.symbol);
	size_t h = 5381;
	for (const char *s = k.string; *s; s++) h = h * 33 + (unsigned char)*s;
	return mix(h ^ 0x9e3779b9);
}
static size_t hash_pair(size_t a, size_t b) { return mix(a * 31 + b); }
static size_t hash_node(const void *p) { return mix((uintptr_t)p ^ 0x51ed27); }
static int same(tb_key a, tb_key b) {
	if (a.symbol != NULL || b.symbol != NULL) return a.symbol == b.symbol;
	return strcmp(a.string, b.string) == 0;
}
static tb_key keep(tb_key k) { return k.symbol != NULL ? k : tb_string(xdup(k.string)); }
static void drop(tb_key k) {
	if (k.symbol == NULL) free((char *)k.string);
}

typedef struct link link;
struct link {
	link *next;
	size_t hash;
};
typedef struct {
	link **buckets;
	size_t slots; // a power of two
	size_t count;
} map;

static link **bucket(const map *m, size_t h) { return &m->buckets[h & (m->slots - 1)]; }
static void put(map *m, link *x) {
	if (m->count == m->slots) {
		size_t slots = m->slots ? m->slots * 2 : 16;
		link **b = xrealloc(NULL, slots * sizeof *b);
		memset(b, 0, slots * sizeof *b);
		link **old = m->buckets;
		size_t n = m->slots;
		m->buckets = b;
		m->slots = slots;
		for (size_t i = 0; i < n; i++) {
			for (link *y = old[i], *next; y; y = next) {
				next = y->next;
				link **at = bucket(m, y->hash);
				y->next = *at;
				*at = y;
			}
		}
		free(old);
	}
	link **at = bucket(m, x->hash);
	x->next = *at;
	*at = x;
	m->count++;
}
static void unlink_(map *m, link *x) {
	link **at = bucket(m, x->hash);
	while (*at != x) at = &(*at)->next;
	*at = x->next;
	m->count--;
}

typedef struct entry entry;
typedef struct group group;
typedef struct idrec idrec;
typedef struct noderec noderec;

struct entry {
	link link; // in entries
	tb_key part; // the group's, for a lookup without leaving the entry
	const void *node; // the group's node
	group *group;
	idrec *id;
	entry *id_next, *id_prev; // in its id's
	entry *group_next, *group_prev; // in its group's
};
struct group {
	link link; // in groups
	noderec *node;
	tb_key part;
	entry *first, *last;
	size_t count;
	group *next, *prev; // in its node's
};
struct idrec {
	link link; // in ids
	tb_key id; // a string is the one after the record
	entry *first, *last;
	char text[];
};
typedef struct {
	link link; // in parts
	size_t refs; // the groups using it
	char text[];
} partrec;
struct noderec {
	link link; // in nodes
	const void *node;
	group *first, *last;
};

struct tb_table {
	map entries, ids, nodes, groups, parts;
	tb_event event;
	void *ctx;
	tb_key *ids_out;
	size_t ids_count, ids_cap;
	tb_entry *at_out;
	size_t at_count, at_cap;
	tb_where *who_out;
	size_t who_count, who_cap;
};

tb_table *tb_make(tb_event event, void *ctx) {
	tb_table *t = xrealloc(NULL, sizeof *t);
	*t = (tb_table){.event = event, .ctx = ctx};
	return t;
}
tb_table *tb_new(void) { return tb_make(NULL, NULL); }

static void free_map(map *m) { free(m->buckets); }
void tb_free(tb_table *t) {
	if (t == NULL) return;
	for (size_t i = 0; i < t->entries.slots; i++) {
		for (link *x = t->entries.buckets[i], *next; x; x = next) next = x->next, free(x);
	}
	for (size_t i = 0; i < t->groups.slots; i++) {
		for (link *x = t->groups.buckets[i], *next; x; x = next) {
			next = x->next;
			free(x);
		}
	}
	for (size_t i = 0; i < t->ids.slots; i++) {
		for (link *x = t->ids.buckets[i], *next; x; x = next) next = x->next, free(x);
	}
	for (size_t i = 0; i < t->parts.slots; i++) {
		for (link *x = t->parts.buckets[i], *next; x; x = next) next = x->next, free(x);
	}
	for (size_t i = 0; i < t->nodes.slots; i++) {
		for (link *x = t->nodes.buckets[i], *next; x; x = next) next = x->next, free(x);
	}
	free_map(&t->entries);
	free_map(&t->ids);
	free_map(&t->nodes);
	free_map(&t->groups);
	free_map(&t->parts);
	free(t->ids_out);
	free(t->at_out);
	free(t->who_out);
	free(t);
}


static entry *find_entry(const tb_table *t, tb_key part, tb_key id) {
	if (t->entries.slots == 0) return NULL;
	size_t h = hash_pair(hash_key(part), hash_key(id));
	for (link *x = *bucket(&t->entries, h); x; x = x->next) {
		entry *e = (entry *)x;
		if (x->hash == h && same(e->part, part) && same(e->id->id, id)) return e;
	}
	return NULL;
}
static idrec *find_id(const tb_table *t, tb_key id) {
	if (t->ids.slots == 0) return NULL;
	size_t h = hash_key(id);
	for (link *x = *bucket(&t->ids, h); x; x = x->next) {
		if (x->hash == h && same(((idrec *)x)->id, id)) return (idrec *)x;
	}
	return NULL;
}
static noderec *find_node(const tb_table *t, const void *node) {
	if (t->nodes.slots == 0) return NULL;
	size_t h = hash_node(node);
	for (link *x = *bucket(&t->nodes, h); x; x = x->next) {
		if (((noderec *)x)->node == node) return (noderec *)x;
	}
	return NULL;
}
static group *find_group(const tb_table *t, const void *node, tb_key part) {
	if (t->groups.slots == 0) return NULL;
	size_t h = hash_pair(hash_node(node), hash_key(part));
	for (link *x = *bucket(&t->groups, h); x; x = x->next) {
		group *g = (group *)x;
		if (x->hash == h && g->node->node == node && same(g->part, part)) return g;
	}
	return NULL;
}


static tb_key part_take(tb_table *t, tb_key part) {
	if (part.symbol != NULL) return part;
	size_t h = hash_key(part);
	if (t->parts.slots != 0) {
		for (link *x = *bucket(&t->parts, h); x; x = x->next) {
			partrec *p = (partrec *)x;
			if (x->hash == h && strcmp(p->text, part.string) == 0) return p->refs++, tb_string(p->text);
		}
	}
	size_t n = strlen(part.string) + 1;
	partrec *p = xrealloc(NULL, sizeof *p + n);
	p->link.hash = h;
	p->refs = 1;
	memcpy(p->text, part.string, n);
	put(&t->parts, &p->link);
	return tb_string(p->text);
}
static void part_drop(tb_table *t, tb_key part) {
	if (part.symbol != NULL) return;
	partrec *p = (partrec *)((char *)part.string - offsetof(partrec, text));
	if (--p->refs == 0) {
		unlink_(&t->parts, &p->link);
		free(p);
	}
}

static idrec *id_make(tb_table *t, tb_key id) {
	size_t n = id.symbol != NULL ? 0 : strlen(id.string) + 1;
	idrec *i = xrealloc(NULL, sizeof *i + n);
	*i = (idrec){.link.hash = hash_key(id)};
	if (id.symbol != NULL) i->id = id;
	else i->id = tb_string(memcpy(i->text, id.string, n));
	put(&t->ids, &i->link);
	return i;
}
static group *group_for(tb_table *t, tb_key part, void *node) {
	noderec *n = find_node(t, node);
	if (n == NULL) {
		n = xrealloc(NULL, sizeof *n);
		*n = (noderec){.link.hash = hash_node(node), .node = node};
		put(&t->nodes, &n->link);
	}
	group *g = find_group(t, node, part);
	if (g == NULL) {
		g = xrealloc(NULL, sizeof *g);
		*g = (group){.link.hash = hash_pair(hash_node(node), hash_key(part)), .node = n, .part = part_take(t, part)};
		g->prev = n->last;
		if (n->last) n->last->next = g;
		else n->first = g;
		n->last = g;
		put(&t->groups, &g->link);
	}
	return g;
}
static void link_entry(entry *e, idrec *i, group *g) {
	e->group = g;
	e->id = i;
	e->part = g->part;
	e->node = g->node->node;
	e->id_next = NULL;
	e->id_prev = i->last;
	if (i->last) i->last->id_next = e;
	else i->first = e;
	i->last = e;
	e->group_next = NULL;
	e->group_prev = g->last;
	if (g->last) g->last->group_next = e;
	else g->first = e;
	g->last = e;
	g->count++;
}
static void unlink_entry(entry *e) {
	idrec *i = e->id;
	group *g = e->group;
	if (e->id_prev) e->id_prev->id_next = e->id_next;
	else i->first = e->id_next;
	if (e->id_next) e->id_next->id_prev = e->id_prev;
	else i->last = e->id_prev;
	if (e->group_prev) e->group_prev->group_next = e->group_next;
	else g->first = e->group_next;
	if (e->group_next) e->group_next->group_prev = e->group_prev;
	else g->last = e->group_prev;
	g->count--;
}
static void group_free(tb_table *t, group *g) {
	noderec *n = g->node;
	unlink_(&t->groups, &g->link);
	if (g->prev) g->prev->next = g->next;
	else n->first = g->next;
	if (g->next) g->next->prev = g->prev;
	else n->last = g->prev;
	part_drop(t, g->part);
	free(g);
	if (n->first == NULL) {
		unlink_(&t->nodes, &n->link);
		free(n);
	}
}

static void place(tb_table *t, tb_key part, tb_key id, void *node) {
	idrec *i = find_id(t, id);
	if (i == NULL) i = id_make(t, id);
	group *g = group_for(t, part, node);
	entry *e = xrealloc(NULL, sizeof *e);
	e->link = (link){.hash = hash_pair(hash_key(part), hash_key(id))};
	link_entry(e, i, g);
	put(&t->entries, &e->link);
}

static void take(tb_table *t, entry *e) {
	group *g = e->group;
	idrec *i = e->id;
	unlink_(&t->entries, &e->link);
	unlink_entry(e);
	free(e);
	if (i->first == NULL) {
		unlink_(&t->ids, &i->link);
		free(i);
	}
	if (g->first == NULL) group_free(t, g);
}


int tb_add(tb_table *t, tb_key part, tb_key id, void *node) {
	entry *e = find_entry(t, part, id);
	if (e != NULL) return e->node == node ? 0 : TB_ALREADY_THERE;
	place(t, part, id, node);
	if (t->event) t->event(t->ctx, part, id);
	return 0;
}

void tb_sub(tb_table *t, tb_key part, tb_key id, void *node) {
	entry *e = find_entry(t, part, id);
	if (e != NULL) {
		if (e->node == node) return;
		// The entry stays in the table and moves to the new node's group, at the end of its id's.
		// The new group is made first, because the keys may be the table's own copies.
		group *old = e->group;
		group *g = group_for(t, part, node);
		unlink_entry(e);
		link_entry(e, e->id, g);
		if (old->first == NULL) group_free(t, old);
		if (t->event) t->event(t->ctx, part, id);
		return;
	}
	place(t, part, id, node);
	if (t->event) t->event(t->ctx, part, id);
}

void *tb_get(const tb_table *t, tb_key part, tb_key id) {
	entry *e = find_entry(t, part, id);
	return e ? (void *)e->node : NULL;
}

const tb_key *tb_ids(tb_table *t, tb_key part, const void *node, size_t *length) {
	t->ids_count = 0;
	group *g = find_group(t, node, part);
	for (entry *e = g ? g->first : NULL; e; e = e->group_next) {
		GROW(t->ids_out, t->ids_count, t->ids_cap);
		t->ids_out[t->ids_count++] = e->id->id;
	}
	*length = t->ids_count;
	return t->ids_out;
}

const tb_entry *tb_at(tb_table *t, tb_key id, size_t *length) {
	t->at_count = 0;
	idrec *i = find_id(t, id);
	for (entry *e = i ? i->first : NULL; e; e = e->id_next) {
		GROW(t->at_out, t->at_count, t->at_cap);
		t->at_out[t->at_count++] = (tb_entry){e->part, (void *)e->node};
	}
	*length = t->at_count;
	return t->at_out;
}

const tb_where *tb_who(tb_table *t, const void *node, size_t *length) {
	t->who_count = 0;
	noderec *n = find_node(t, node);
	for (group *g = n ? n->first : NULL; g; g = g->next) {
		for (entry *e = g->first; e; e = e->group_next) {
			GROW(t->who_out, t->who_count, t->who_cap);
			t->who_out[t->who_count++] = (tb_where){g->part, e->id->id};
		}
	}
	*length = t->who_count;
	return t->who_out;
}

typedef struct {
	tb_key part, id;
} told;
static void told_free(told *v, size_t n) {
	for (size_t i = 0; i < n; i++) drop(v[i].part), drop(v[i].id);
	free(v);
}
static void told_all(tb_table *t, told *v, size_t n) {
	for (size_t i = 0; i < n; i++) t->event(t->ctx, v[i].part, v[i].id);
	told_free(v, n);
}

int tb_del(tb_table *t, tb_key part, tb_key id) {
	entry *e = find_entry(t, part, id);
	if (e == NULL) return TB_NOTHING_THERE;
	if (t->event == NULL) {
		take(t, e);
		return 0;
	}
	tb_key p = keep(part), i = keep(id);
	take(t, e);
	t->event(t->ctx, p, i);
	drop(p);
	drop(i);
	return 0;
}

int tb_del_part(tb_table *t, tb_key part, const void *node) {
	group *g = find_group(t, node, part);
	if (g == NULL) return TB_NOTHING_THERE;
	told *v = NULL;
	size_t n = 0;
	if (t->event) {
		v = xrealloc(NULL, g->count * sizeof *v);
		for (entry *e = g->first; e; e = e->group_next) v[n++] = (told){keep(g->part), keep(e->id->id)};
	}
	while (g->first->group_next != NULL) take(t, g->first);
	take(t, g->first);
	if (t->event) told_all(t, v, n);
	return 0;
}

int tb_del_node(tb_table *t, const void *node) {
	noderec *n = find_node(t, node);
	if (n == NULL) return TB_NOTHING_THERE;
	told *v = NULL;
	size_t count = 0, cap = 0;
	if (t->event) {
		for (group *g = n->first; g; g = g->next) {
			for (entry *e = g->first; e; e = e->group_next) {
				GROW(v, count, cap);
				v[count++] = (told){keep(g->part), keep(e->id->id)};
			}
		}
	}
	for (;;) {
		group *g = n->first;
		if (g->first->group_next == NULL && g->next == NULL) break;
		take(t, g->first);
	}
	take(t, n->first->first);
	if (t->event) told_all(t, v, count);
	return 0;
}
