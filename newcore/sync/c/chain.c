// The blops of one node, in chains (newcore/sync/CHAIN.tex), in C. Same steps as chain.ts.
#include "chain.h"

#include <stdlib.h>
#include <string.h>

enum { NONE, TAKEN, WAITING, REFUSED, STUCK };

// one name seen: given as a blop, or only named as a parent
typedef struct {
	uint8_t name[32];
	int state;
	const Json *blop;
	double lamport;
	size_t *parents;
	size_t count; // parents
	size_t *on; // waiting: the parents not taken in
	size_t waiting;
	size_t *waiters; // the names waiting on this one
	size_t waited, room;
	chain_refusal refusal;
	bool head;
	unsigned stamp; // bumped each time it starts waiting
	void *slot;
} entry;

struct chains {
	char *node;
	chain_check check;
	void *context;
	void (*release)(void *slot);
	entry *entries;
	size_t length, capacity;
	// open addressing over entries, by the name's first bytes: index + 1, 0 empty
	size_t *table, slots;
};

const char *chain_refusal_name(chain_refusal refusal) {
	static const char *names[] = {"", "node", "chain", "lamport", "patches"};
	return names[refusal];
}

static void *grab(size_t n) {
	void *p = malloc(n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static void *regrow(void *p, size_t n) {
	p = realloc(p, n ? n : 1);
	if (p == NULL) abort();
	return p;
}

chains *chain_create(const char *node, chain_check check, void *context) {
	chains *c = calloc(1, sizeof *c);
	if (c == NULL) abort();
	c->node = strcpy(grab(strlen(node) + 1), node);
	c->check = check;
	c->context = context;
	return c;
}

void chain_release(chains *c, void (*release)(void *slot)) {
	c->release = release;
}

void chain_free(chains *c) {
	if (c == NULL) return;
	for (size_t i = 0; i < c->length; i++) {
		if (c->release && c->entries[i].slot) c->release(c->entries[i].slot);
		free(c->entries[i].parents);
		free(c->entries[i].on);
		free(c->entries[i].waiters);
	}
	free(c->entries);
	free(c->table);
	free(c->node);
	free(c);
}

static size_t hash(const uint8_t name[32]) {
	size_t h;
	memcpy(&h, name, sizeof h);
	return h;
}

static void rehash(chains *c, size_t slots) {
	free(c->table);
	c->table = calloc(slots, sizeof *c->table);
	if (c->table == NULL) abort();
	c->slots = slots;
	for (size_t i = 0; i < c->length; i++) {
		size_t at = hash(c->entries[i].name) & (slots - 1);
		while (c->table[at]) at = (at + 1) & (slots - 1);
		c->table[at] = i + 1;
	}
}

// the entry of a name; made when asked to and not there. SIZE_MAX: not there
static size_t find(chains *c, const uint8_t name[32], bool make) {
	if (c->slots) {
		size_t at = hash(name) & (c->slots - 1);
		while (c->table[at]) {
			if (memcmp(c->entries[c->table[at] - 1].name, name, 32) == 0) return c->table[at] - 1;
			at = (at + 1) & (c->slots - 1);
		}
	}
	if (!make) return SIZE_MAX;
	if (c->length == c->capacity) {
		c->capacity = c->capacity ? c->capacity * 2 : 16;
		c->entries = regrow(c->entries, c->capacity * sizeof *c->entries);
	}
	entry *e = &c->entries[c->length];
	memset(e, 0, sizeof *e);
	memcpy(e->name, name, 32);
	c->length++;
	if (c->length * 2 > c->slots) rehash(c, c->slots ? c->slots * 2 : 32);
	else {
		size_t at = hash(name) & (c->slots - 1);
		while (c->table[at]) at = (at + 1) & (c->slots - 1);
		c->table[at] = c->length;
	}
	return c->length - 1;
}

static const Json *field(const Json *blop, const char *key) {
	return jsonGet(blop, key);
}

// the agreed order: higher lamport first; equal, the greater name
static int agreed(double la, const uint8_t *a, double lb, const uint8_t *b) {
	if (la != lb) return la > lb ? -1 : 1;
	return -memcmp(a, b, 32);
}

typedef struct {
	double lamport;
	uint8_t name[32];
	size_t index;
	unsigned stamp;
} woken;
static int by_agreed(const void *x, const void *y) {
	const woken *a = x, *b = y;
	return agreed(a->lamport, a->name, b->lamport, b->name);
}

static bool bad(const entry *e) {
	return e->state == REFUSED || e->state == STUCK;
}

static void forget(chains *c, size_t i) {
	entry *e = &c->entries[i];
	for (size_t j = 0; j < e->waiting; j++) {
		entry *p = &c->entries[e->on[j]];
		for (size_t k = 0; k < p->waited; k++) {
			if (p->waiters[k] == i) {
				p->waiters[k] = p->waiters[--p->waited];
				break;
			}
		}
	}
	e->waiting = 0;
	e->state = NONE;
	e->head = false;
}

static chain_row refuse(chains *c, size_t i, chain_refusal code) {
	c->entries[i].state = REFUSED;
	c->entries[i].refusal = code;
	return (chain_row){.kind = CHAIN_REFUSED, .refusal = code};
}

// a list of the entries' names
static chain_row listing(chains *c, chain_kind kind, const size_t *at, size_t count) {
	chain_row row = {.kind = kind, .count = count};
	row.names = grab(count * sizeof *row.names);
	for (size_t j = 0; j < count; j++) memcpy(row.names[j], c->entries[at[j]].name, 32);
	return row;
}

// the steps, in order, for the blop at entry i
static chain_row enter(chains *c, size_t i, const Json *blop) {
	const Json *parents = field(blop, "parents");
	size_t n = parents && parents->type == JSON_ARRAY ? (size_t)parents->array.count : 0;
	size_t *ps = grab(n * sizeof *ps);
	for (size_t j = 0; j < n; j++) {
		const Json *p = parents->array.items[j];
		uint8_t name[32] = {0};
		if (p->type == JSON_BYTES && p->bytes.length == 32) memcpy(name, p->bytes.data, 32);
		ps[j] = find(c, name, true);
	}
	entry *e = &c->entries[i];
	free(e->parents);
	e->parents = ps;
	e->count = n;
	e->blop = blop;
	const Json *lamport = field(blop, "lamport");
	e->lamport = lamport && lamport->type == JSON_NUMBER ? lamport->number : 0;

	const char *node = jsonText(field(blop, "node"));
	if (node == NULL || strcmp(node, c->node) != 0) return refuse(c, i, CHAIN_NODE);
	size_t *list = grab(n * sizeof *list);
	size_t k = 0;
	for (size_t j = 0; j < n; j++) if (bad(&c->entries[ps[j]])) list[k++] = ps[j];
	if (k) {
		chain_row row = listing(c, CHAIN_STUCK, list, k);
		free(list);
		c->entries[i].state = STUCK;
		return row;
	}
	for (size_t j = 0; j < n; j++) if (c->entries[ps[j]].state != TAKEN) list[k++] = ps[j];
	if (k) {
		chain_row row = listing(c, CHAIN_WAITING, list, k);
		e = &c->entries[i];
		e->state = WAITING;
		e->stamp++;
		free(e->on);
		e->on = list;
		e->waiting = k;
		for (size_t j = 0; j < k; j++) {
			entry *p = &c->entries[list[j]];
			if (p->waited == p->room) {
				p->room = p->room ? p->room * 2 : 4;
				p->waiters = regrow(p->waiters, p->room * sizeof *p->waiters);
			}
			p->waiters[p->waited++] = i;
		}
		return row;
	}
	free(list);
	const Json *object = field(blop, "object");
	double top = 0;
	for (size_t j = 0; j < n; j++) {
		entry *p = &c->entries[ps[j]];
		if (!jsonEqual(field(p->blop, "object"), object)) return refuse(c, i, CHAIN_CHAIN);
		if (p->lamport > top) top = p->lamport;
	}
	if (c->entries[i].lamport != top + 1) return refuse(c, i, CHAIN_LAMPORT);
	if (!c->check(c->context, c, blop)) return refuse(c, i, CHAIN_PATCHES);
	for (size_t j = 0; j < n; j++) c->entries[ps[j]].head = false;
	c->entries[i].state = TAKEN;
	c->entries[i].head = true;
	return (chain_row){.kind = CHAIN_TAKEN};
}

// what waits on entry i, in the agreed order; they leave its list
static size_t wake(chains *c, size_t i, woken **out) {
	entry *e = &c->entries[i];
	woken *w = grab(e->waited * sizeof *w);
	for (size_t j = 0; j < e->waited; j++) {
		entry *x = &c->entries[e->waiters[j]];
		w[j] = (woken){x->lamport, {0}, e->waiters[j], x->stamp};
		memcpy(w[j].name, x->name, 32);
	}
	size_t n = e->waited;
	e->waited = 0;
	qsort(w, n, sizeof *w, by_agreed);
	*out = w;
	return n;
}

typedef struct {
	woken *items;
	size_t count, at;
} frame;

typedef struct {
	frame *frames;
	size_t depth, room;
} stack;

static void push(chains *c, stack *s, size_t i) {
	if (s->depth == s->room) {
		s->room = s->room ? s->room * 2 : 8;
		s->frames = regrow(s->frames, s->room * sizeof *s->frames);
	}
	frame *f = &s->frames[s->depth++];
	f->count = wake(c, i, &f->items);
	f->at = 0;
}

// i added: through the steps; what waited on it added again in the agreed order, and so on (a
// stack of its own, however long the cascade)
static chain_row run(chains *c, size_t i, const Json *blop) {
	forget(c, i);
	chain_row result = enter(c, i, blop);
	if (result.kind == CHAIN_WAITING) return result;
	stack s = {0};
	push(c, &s, i);
	while (s.depth) {
		frame *top = &s.frames[s.depth - 1];
		if (top->at == top->count) {
			free(top->items);
			s.depth--;
			continue;
		}
		woken w = top->items[top->at++];
		entry *e = &c->entries[w.index];
		// added again by an earlier one's waking: not the same waiting any more
		if (e->state != WAITING || e->stamp != w.stamp) continue;
		forget(c, w.index);
		chain_row again = enter(c, w.index, e->blop);
		chain_row_free(&again);
		if (c->entries[w.index].state != WAITING) push(c, &s, w.index);
	}
	free(s.frames);
	return result;
}

chain_row chain_add(chains *c, const Json *blop, const uint8_t name[32]) {
	size_t i = find(c, name, true);
	if (c->entries[i].state == TAKEN) return (chain_row){.kind = CHAIN_PASSED};
	return run(c, i, blop);
}

const Json *chain_get(chains *c, const uint8_t name[32]) {
	size_t i = find(c, name, false);
	return i != SIZE_MAX && c->entries[i].state == TAKEN ? c->entries[i].blop : NULL;
}

void **chain_slot(chains *c, const uint8_t name[32]) {
	size_t i = find(c, name, false);
	return i != SIZE_MAX && c->entries[i].state == TAKEN ? &c->entries[i].slot : NULL;
}

static int by_head(const void *x, const void *y) {
	const chain_head *a = x, *b = y;
	const Json *la = jsonGet(a->blop, "lamport"), *lb = jsonGet(b->blop, "lamport");
	return agreed(la->number, a->name, lb->number, b->name);
}

size_t chain_heads(chains *c, const Json *object, chain_head **out) {
	chain_head *hs = grab(c->length * sizeof *hs);
	size_t n = 0;
	for (size_t i = 0; i < c->length; i++) {
		entry *e = &c->entries[i];
		if (e->state != TAKEN || !e->head || !jsonEqual(field(e->blop, "object"), object)) continue;
		memcpy(hs[n].name, e->name, 32);
		hs[n++].blop = e->blop;
	}
	qsort(hs, n, sizeof *hs, by_head);
	if (n == 0) free(hs), hs = NULL;
	*out = hs;
	return n;
}

static int by_name(const void *x, const void *y) {
	return memcmp(((const chain_row *)x)->name, ((const chain_row *)y)->name, 32);
}

size_t chain_waiting(chains *c, chain_row **out) {
	chain_row *rows = grab(c->length * sizeof *rows);
	size_t n = 0;
	for (size_t i = 0; i < c->length; i++) {
		entry *e = &c->entries[i];
		if (e->state != WAITING) continue;
		rows[n] = listing(c, CHAIN_WAITING, e->on, e->waiting);
		memcpy(rows[n++].name, e->name, 32);
	}
	qsort(rows, n, sizeof *rows, by_name);
	*out = rows;
	return n;
}

// a stuck blop names every parent of it refused or stuck, worked out now
size_t chain_refused(chains *c, chain_row **out) {
	chain_row *rows = grab(c->length * sizeof *rows);
	size_t n = 0;
	for (size_t i = 0; i < c->length; i++) {
		entry *e = &c->entries[i];
		if (e->state == REFUSED) rows[n] = (chain_row){.kind = CHAIN_REFUSED, .refusal = e->refusal};
		else if (e->state == STUCK) {
			size_t *list = grab(e->count * sizeof *list), k = 0;
			for (size_t j = 0; j < e->count; j++) if (bad(&c->entries[e->parents[j]])) list[k++] = e->parents[j];
			rows[n] = listing(c, CHAIN_STUCK, list, k);
			free(list);
		} else continue;
		memcpy(rows[n++].name, e->name, 32);
	}
	qsort(rows, n, sizeof *rows, by_name);
	*out = rows;
	return n;
}

void chain_row_free(chain_row *row) {
	free(row->names);
	row->names = NULL;
}

void chain_rows_free(chain_row *rows, size_t count) {
	for (size_t i = 0; i < count; i++) chain_row_free(&rows[i]);
	free(rows);
}
