// Scope nodes (scopes.h), in C.
#include "scopes.h"

#include <stdlib.h>
#include <string.h>

#include "../../../core/scheduler/c/ptrmap.h"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// a scope's node: the map's value, and the teardown's data
typedef struct {
	sn *owner;
	sc_scope *scope;
	char *id;
} given;

struct sn {
	sc_scheduler *scheduler;
	tb_table *table;
	pm ids;
};

sn *sn_new(sc_scheduler *scheduler, tb_table *table) {
	sn *s = xalloc(sizeof *s);
	s->scheduler = scheduler;
	s->table = table;
	return s;
}

void sn_free(sn *s) {
	for (size_t i = 0; i < s->ids.cap; i++) {
		if (!s->ids.keys[i]) continue;
		given *g = s->ids.vals[i];
		free(g->id);
		free(g);
	}
	pm_clear(&s->ids);
	free(s);
}

// the entries at the id go, one table event each. the parts are copied first: the table's scratch
// changes with each deletion, and a string key is its copy, gone with the entry
static char *teardown(void *data) {
	given *g = data;
	sn *s = g->owner;
	pm_delete(&s->ids, g->scope);
	size_t n;
	const tb_entry *at = tb_at(s->table, tb_string(g->id), &n);
	tb_key *parts = xalloc(n * sizeof *parts);
	for (size_t i = 0; i < n; i++) {
		parts[i] = at[i].part;
		if (parts[i].symbol == NULL) parts[i].string = xdup(parts[i].string);
	}
	for (size_t i = 0; i < n; i++) {
		tb_del(s->table, parts[i], tb_string(g->id));
		if (parts[i].symbol == NULL) free((char *)parts[i].string);
	}
	free(parts);
	free(g->id);
	free(g);
	return NULL;
}

static char *random_id(void) {
	static const char hex[] = "0123456789abcdef";
	char *id = xalloc(sizeof "scope:" + 32);
	memcpy(id, "scope:", 6);
	unsigned char bytes[16];
	arc4random_buf(bytes, sizeof bytes);
	for (size_t i = 0; i < sizeof bytes; i++) {
		id[6 + 2 * i] = hex[bytes[i] >> 4];
		id[7 + 2 * i] = hex[bytes[i] & 15];
	}
	return id;
}

const char *sn_give(sn *s, sc_scope *scope, const char *id) {
	given *had = pm_get(&s->ids, scope);
	if (had != NULL) return had->id;
	if (!sc_scope_alive(scope)) return NULL;
	given *g = xalloc(sizeof *g);
	g->owner = s;
	g->scope = scope;
	g->id = id != NULL ? xdup(id) : random_id();
	pm_set(&s->ids, scope, g);
	sc_register_teardown(s->scheduler, scope, teardown, g);
	return g->id;
}

const char *sn_node_of(const sn *s, const sc_scope *scope) {
	const given *g = pm_get(&s->ids, scope);
	return g != NULL ? g->id : NULL;
}

const char *sn_nearest(const sn *s, const sc_scope *scope) {
	for (const sc_scope *o = scope; o != NULL; o = sc_scope_parent(o)) {
		const char *id = sn_node_of(s, o);
		if (id != NULL) return id;
	}
	return NULL;
}
