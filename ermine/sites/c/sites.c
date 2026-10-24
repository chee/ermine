#include "sites.h"

#include <stdint.h>
#include <stdlib.h>

typedef struct entry {
	const sc_scope *scope;
	st_site site;
	st_sites *t;
	struct entry *next;
} entry;

struct st_sites {
	sc_scheduler *s;
	entry **buckets;
	size_t nbuckets, count;
};

static size_t slot(const st_sites *t, const sc_scope *scope) {
	uintptr_t p = (uintptr_t)scope >> 4;
	p ^= p >> 17;
	return (size_t)(p * 0x9E3779B97F4A7C15u >> 7) % t->nbuckets;
}

static void *must(void *p) {
	if (p == NULL) abort();
	return p;
}

st_sites *st_new(sc_scheduler *s) {
	st_sites *t = must(calloc(1, sizeof *t));
	t->s = s;
	t->nbuckets = 64;
	t->buckets = must(calloc(t->nbuckets, sizeof *t->buckets));
	return t;
}

void st_free(st_sites *t) {
	if (t == NULL) return;
	for (size_t i = 0; i < t->nbuckets; i++)
		for (entry *e = t->buckets[i], *next; e != NULL; e = next) next = e->next, free(e);
	free(t->buckets);
	free(t);
}

sc_scheduler *st_scheduler(const st_sites *t) { return t->s; }

static void grow(st_sites *t) {
	size_t n = t->nbuckets * 2;
	entry **buckets = must(calloc(n, sizeof *buckets));
	size_t was = t->nbuckets;
	entry **old = t->buckets;
	t->buckets = buckets;
	t->nbuckets = n;
	for (size_t i = 0; i < was; i++)
		for (entry *e = old[i], *next; e != NULL; e = next) {
			next = e->next;
			size_t k = slot(t, e->scope);
			e->next = buckets[k];
			buckets[k] = e;
		}
	free(old);
}

// the scope is torn down: its entry goes. a computer's teardowns are its runs' cleanups too: one
// run as it runs again finds it alive, and is registered again for the next
static char *forget(void *data) {
	entry *e = data;
	st_sites *t = e->t;
	if (sc_scope_alive(e->scope)) {
		sc_register_teardown(t->s, (sc_scope *)e->scope, forget, e);
		return NULL;
	}
	for (entry **p = &t->buckets[slot(t, e->scope)]; *p != NULL; p = &(*p)->next)
		if (*p == e) {
			*p = e->next;
			t->count--;
			free(e);
			break;
		}
	return NULL;
}

sc_scope *st_note(st_sites *t, sc_scope *scope, const char *file, int line, const char *func) {
	if (scope == NULL) return NULL;
	if (t->count >= 2 * t->nbuckets) grow(t);
	entry *e = must(malloc(sizeof *e));
	*e = (entry){.scope = scope, .site = {file, line, func}, .t = t};
	size_t k = slot(t, scope);
	e->next = t->buckets[k];
	t->buckets[k] = e;
	t->count++;
	// a scope already gone runs it now
	sc_register_teardown(t->s, scope, forget, e);
	return scope;
}

const st_site *st_site_of(const st_sites *t, const sc_scope *scope) {
	if (scope == NULL) return NULL;
	for (const entry *e = t->buckets[slot(t, scope)]; e != NULL; e = e->next)
		if (e->scope == scope) return &e->site;
	return NULL;
}

size_t st_sites_of(const st_sites *t, const sc_scope *scope, const st_site **out, size_t cap) {
	size_t n = 0;
	for (const sc_scope *o = scope; o != NULL; o = sc_scope_parent(o)) {
		const st_site *site = st_site_of(t, o);
		if (site == NULL) continue;
		if (n < cap) out[n] = site;
		n++;
	}
	return n;
}

size_t st_count(const st_sites *t) { return t->count; }
