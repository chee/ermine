#include "sites.h"

#include <stdint.h>
#include <stdlib.h>

typedef struct entry {
	const sc_frame *frame;
	// the scope whose own frame it is; NULL: a frame alone (its owner forgets it)
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

static size_t slot(const st_sites *t, const sc_frame *frame) {
	uintptr_t p = (uintptr_t)frame >> 4;
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
			size_t k = slot(t, e->frame);
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
	for (entry **p = &t->buckets[slot(t, e->frame)]; *p != NULL; p = &(*p)->next)
		if (*p == e) {
			*p = e->next;
			t->count--;
			free(e);
			break;
		}
	return NULL;
}

static entry *find(const st_sites *t, const sc_frame *frame) {
	for (entry *e = t->buckets[slot(t, frame)]; e != NULL; e = e->next)
		if (e->frame == frame) return e;
	return NULL;
}

// f's site from now, over any it had. scope: the one whose own frame it is, else NULL
static void put(st_sites *t, sc_frame *f, sc_scope *scope, const char *file, int line, const char *func) {
	entry *e = find(t, f);
	if (e != NULL) {
		e->site = (st_site){file, line, func};
		return;
	}
	if (t->count >= 2 * t->nbuckets) grow(t);
	e = must(malloc(sizeof *e));
	*e = (entry){.frame = f, .scope = scope, .site = {file, line, func}, .t = t};
	size_t k = slot(t, f);
	e->next = t->buckets[k];
	t->buckets[k] = e;
	t->count++;
	// a scope already gone runs it now
	if (scope != NULL) sc_register_teardown(t->s, scope, forget, e);
}

sc_scope *st_note(st_sites *t, sc_scope *scope, const char *file, int line, const char *func) {
	if (scope == NULL) return NULL;
	put(t, sc_scope_frame(scope), scope, file, line, func);
	return scope;
}

sc_frame *st_note_frame(st_sites *t, sc_frame *frame, const char *file, int line, const char *func) {
	if (frame == NULL) return NULL;
	put(t, frame, sc_frame_scope(frame), file, line, func);
	return frame;
}

void st_forget_frame(st_sites *t, const sc_frame *frame) {
	if (frame == NULL || sc_frame_scope(frame) != NULL) return;
	for (entry **p = &t->buckets[slot(t, frame)]; *p != NULL; p = &(*p)->next)
		if ((*p)->frame == frame) {
			entry *e = *p;
			*p = e->next;
			t->count--;
			free(e);
			return;
		}
}

const st_site *st_site_of_frame(const st_sites *t, const sc_frame *frame) {
	if (frame == NULL) return NULL;
	const entry *e = find(t, frame);
	return e != NULL ? &e->site : NULL;
}

size_t st_sites_of_frame(const st_sites *t, const sc_frame *frame, const st_site **out, size_t cap) {
	size_t n = 0;
	for (const sc_frame *f = frame; f != NULL; f = sc_frame_parent(f)) {
		const st_site *site = st_site_of_frame(t, f);
		if (site == NULL) continue;
		if (n < cap) out[n] = site;
		n++;
	}
	return n;
}

size_t st_count(const st_sites *t) { return t->count; }
