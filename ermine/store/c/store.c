// The store (store.h), in C. A source is its table, and the ids it holds something at, in the
// order first held: the table lists no keys, and drop must tell each key. The ids are a list, and
// a second table finds an id in it, so that a delete is not a search.
#include "store.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("store: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }
static tb_key kdup(tb_key k) { return k.symbol ? k : tb_string(xdup(k.string)); }
static void kfree(tb_key k) {
	if (k.symbol == NULL) free((char *)k.string);
}
static int ksame(tb_key a, tb_key b) {
	if (a.symbol != NULL || b.symbol != NULL) return a.symbol == b.symbol;
	return strcmp(a.string, b.string) == 0;
}


// an id a source holds something at: its place in the list
typedef struct held held;
struct held {
	tb_key id;
	held *prev, *next;
};

typedef struct source source;
struct source {
	tb_key key;
	tb_table *table;
	// the ids held, first to last, and where each is: (the one part "id", id) -> its held
	tb_table *finder;
	held *first, *last;
	source *next;
};

struct st_store {
	st_event event;
	void *ctx;
	source *sources;
	// st_who's array
	st_key *keys;
	size_t capacity;
};

st_store *st_new(st_event event, void *ctx) {
	st_store *s = xalloc(sizeof *s);
	s->event = event;
	s->ctx = ctx;
	return s;
}

static source *find(const st_store *s, tb_key key) {
	for (source *x = s->sources; x != NULL; x = x->next) {
		if (ksame(x->key, key)) return x;
	}
	return NULL;
}

// a source's table, made when first written to
static source *made(st_store *s, tb_key key) {
	source *x = find(s, key);
	if (x != NULL) return x;
	x = xalloc(sizeof *x);
	x->key = kdup(key);
	x->table = tb_new();
	x->finder = tb_new();
	x->next = s->sources;
	s->sources = x;
	return x;
}

static tb_key ids_part(void) { return tb_string("id"); }

static void remember(source *x, tb_key id) {
	if (tb_get(x->finder, ids_part(), id) != NULL) return;
	held *h = xalloc(sizeof *h);
	h->id = kdup(id);
	h->prev = x->last;
	if (x->last != NULL) x->last->next = h;
	else x->first = h;
	x->last = h;
	tb_add(x->finder, ids_part(), id, h);
}
static void forget(source *x, tb_key id) {
	held *h = tb_get(x->finder, ids_part(), id);
	if (h == NULL) return;
	tb_del(x->finder, ids_part(), id);
	if (h->prev != NULL) h->prev->next = h->next;
	else x->first = h->next;
	if (h->next != NULL) h->next->prev = h->prev;
	else x->last = h->prev;
	kfree(h->id);
	free(h);
}

static void free_source(source *x) {
	while (x->first != NULL) forget(x, x->first->id);
	tb_free(x->table);
	tb_free(x->finder);
	kfree(x->key);
	free(x);
}

void st_free(st_store *s) {
	while (s->sources != NULL) {
		source *x = s->sources;
		s->sources = x->next;
		free_source(x);
	}
	free(s->keys);
	free(s);
}

static void told(st_store *s, tb_key source, const char *part, tb_key id) {
	if (s->event != NULL) s->event(s->ctx, source, part, id);
}

nd_entry *st_get(const st_store *s, tb_key source, const char *part, tb_key id) {
	const struct source *x = find(s, source);
	return x == NULL ? NULL : tb_get(x->table, tb_string(part), id);
}

int st_add(st_store *s, tb_key source, const char *part, tb_key id, nd_entry *node) {
	struct source *x = made(s, source);
	if (tb_get(x->table, tb_string(part), id) == node) return 0;
	int code = tb_add(x->table, tb_string(part), id, node);
	if (code != 0) return code;
	remember(x, id);
	told(s, source, part, id);
	return 0;
}

void st_sub(st_store *s, tb_key source, const char *part, tb_key id, nd_entry *node) {
	struct source *x = made(s, source);
	if (tb_get(x->table, tb_string(part), id) == node) return;
	tb_sub(x->table, tb_string(part), id, node);
	remember(x, id);
	told(s, source, part, id);
}

int st_del(st_store *s, tb_key source, const char *part, tb_key id) {
	struct source *x = find(s, source);
	if (x == NULL) return TB_NOTHING_THERE;
	int code = tb_del(x->table, tb_string(part), id);
	if (code != 0) return code;
	size_t n;
	tb_at(x->table, id, &n);
	if (n == 0) forget(x, id);
	told(s, source, part, id);
	return 0;
}

const st_key *st_who(st_store *s, tb_key source, const nd_entry *node, size_t *length) {
	struct source *x = find(s, source);
	*length = 0;
	if (x == NULL) return NULL;
	size_t n;
	const tb_where *where = tb_who(x->table, node, &n);
	if (n > s->capacity) {
		s->capacity = n;
		free(s->keys);
		s->keys = xalloc(n * sizeof *s->keys);
	}
	for (size_t i = 0; i < n; i++) s->keys[i] = (st_key){where[i].part.string, where[i].id};
	*length = n;
	return s->keys;
}

nd_entry *st_children(const st_store *s, tb_key source, tb_key id) {
	return st_get(s, source, "children", id);
}

void st_drop(st_store *s, tb_key source) {
	struct source **at = &s->sources;
	while (*at != NULL && !ksame((*at)->key, source)) at = &(*at)->next;
	struct source *x = *at;
	if (x == NULL) return;
	*at = x->next;
	// the keys it held, parts and ids copied: the events come after the table is gone
	size_t n = 0, capacity = 0;
	st_key *keys = NULL;
	for (held *h = x->first; h != NULL; h = h->next) {
		size_t parts;
		const tb_entry *entries = tb_at(x->table, h->id, &parts);
		for (size_t i = 0; i < parts; i++) {
			if (n == capacity) {
				capacity = capacity ? capacity * 2 : 8;
				keys = realloc(keys, capacity * sizeof *keys);
				if (keys == NULL) abort();
			}
			keys[n++] = (st_key){xdup(entries[i].part.string), kdup(h->id)};
		}
	}
	tb_key key = kdup(x->key);
	free_source(x);
	if (s->event != NULL) {
		for (size_t i = 0; i < n; i++) s->event(s->ctx, key, keys[i].part, keys[i].id);
	}
	for (size_t i = 0; i < n; i++) {
		free((char *)keys[i].part);
		kfree(keys[i].id);
	}
	kfree(key);
	free(keys);
}
