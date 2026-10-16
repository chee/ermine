// The path cache (cache.h), in C.
#include "cache.h"

#include "../../../core/scheduler/c/selector.h"
#include "../../../ermine/clingy/c/clingy.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("cache: out of memory\n", stderr);
		abort();
	}
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

typedef enum { AT, LIST, MEMBERS } kind;

// an answer: the array of its kind, n long. gone (at): the contributors gone under the path
// (places' pl_answers), what an entry under it walks on with
typedef struct {
	size_t n;
	pc_answer *a;
	char **names;
	pc_member *m;
	uint32_t gone;
} answer;

typedef struct entry entry;

// a key readers track: one part of an entry's answer, compared on its own. whole: all of it; gone:
// the gone under the path (at); else the first answer's (at)
typedef struct {
	entry *e;
	int whole;
	int gone;
} mark;

struct entry {
	char *name;
	kind kind;
	char **path;
	size_t npath;
	answer answer;
	mark *keys[3];
	size_t nkeys;
	// every key read working it out: places' spots, contributors' keys, other entries' keys
	pl_set reads;
	// the tick it was last worked out as of
	uint64_t worked;
	int live;
	entry *prev, *next;
};

// the entries reading one key
typedef struct rd rd;
struct rd {
	pl_set set;
	const void *key;
	rd *prev, *next;
};

struct pc_cache {
	pl *places;
	sc_scheduler *s;
	sc_listener *on_track, *on_untrack;
	// the scheduler's index of keys held (selector.h): this cache is told the marks of the keys it holds
	sx_index *index;
	sx_holder holder;
	// the entries by name; each key read to the entries reading it; the keys (but this cache's own)
	// some run tracks now
	tb_table *entries, *readers, *tracked;
	// this cache's marks, by address: whether a run tracks one now (clingy.h); the last tracker
	// gone, its entry may go
	cl_clingy *marks;
	// the spots this cache took itself: only these it lets go
	tb_table *took;
	size_t nentries, nreaders;
	// every entry live, and the ones gone but not yet freed (an operation in progress may refer to them)
	entry *all, *dead;
	rd *readings;
	int busy;
	// the latest tick heard
	uint64_t now;
};

static const char entry_tag, readers_tag, tracked_tag, took_tag;

// freeing -------------------------------------------------------------------------------------

static void answer_free(answer *a) {
	for (size_t i = 0; i < a->n; i++) {
		if (a->a) free(a->a[i].id);
		if (a->names) free(a->names[i]);
		if (a->m) free(a->m[i].name), free(a->m[i].id);
	}
	free(a->a), free(a->names), free(a->m);
	*a = (answer){0};
}

static void entry_free(entry *e) {
	answer_free(&e->answer);
	pl_set_free(&e->reads);
	for (size_t i = 0; i < e->nkeys; i++) free(e->keys[i]);
	for (size_t i = 0; i < e->npath; i++) free(e->path[i]);
	free(e->path);
	free(e->name);
	free(e);
}

static void free_dead(pc_cache *c) {
	while (c->dead != NULL) {
		entry *e = c->dead;
		c->dead = e->next;
		for (size_t i = 0; i < e->nkeys; i++) {
			cl_drop(c->marks, e->keys[i]);
		}
		entry_free(e);
	}
}

static void enter(pc_cache *c) { c->busy++; }
static void leave(pc_cache *c) {
	if (--c->busy == 0) free_dead(c);
}

// comparing answers ---------------------------------------------------------------------------

static int text_same(const char *a, const char *b) {
	if (a == b) return 1;
	return a != NULL && b != NULL && strcmp(a, b) == 0;
}

static int one_same(kind k, const answer *a, size_t i, const answer *b, size_t j) {
	switch (k) {
	case AT:
		return text_same(a->a[i].id, b->a[j].id) && text_same(a->a[i].from, b->a[j].from);
	case LIST: return strcmp(a->names[i], b->names[j]) == 0;
	default:
		return strcmp(a->m[i].name, b->m[j].name) == 0 && text_same(a->m[i].id, b->m[j].id) &&
			text_same(a->m[i].from, b->m[j].from);
	}
}

// the same part of two answers: all of them (whole), else the first (at: none against none)
static int same(kind k, int whole, const answer *a, const answer *b) {
	if (!whole) {
		if (a->n == 0 || b->n == 0) return a->n == b->n;
		return one_same(k, a, 0, b, 0);
	}
	if (a->n != b->n) return 0;
	for (size_t i = 0; i < a->n; i++) {
		if (!one_same(k, a, i, b, i)) return 0;
	}
	return 1;
}

// readers of keys -----------------------------------------------------------------------------

static rd *readers_of(pc_cache *c, const void *key) {
	return tb_get(c->readers, tb_symbol(&readers_tag), tb_symbol(key));
}

static mark *ours(pc_cache *c, const void *key) {
	return cl_has(c->marks, key) ? (mark *)key : NULL;
}

static void settle(pc_cache *c, entry *e);

static int took(pc_cache *c, const void *k) {
	return tb_get(c->took, tb_symbol(&took_tag), tb_symbol(k)) != NULL;
}

// a spot no entry reads and no run tracks, if the cache took it: let go
static void letgo(pc_cache *c, const void *k) {
	if (!took(c, k) || tb_get(c->tracked, tb_symbol(&tracked_tag), tb_symbol(k)) != NULL ||
		pl_keep(c->places, k, 0) != 0) {
		return;
	}
	tb_del(c->took, tb_symbol(&took_tag), tb_symbol(k));
	pl_forget(k, c->places);
}

// e reads k
static void reads_add(pc_cache *c, const void *k, entry *e) {
	rd *r = readers_of(c, k);
	if (r == NULL) {
		r = xalloc(sizeof *r);
		r->key = k;
		r->next = c->readings;
		if (r->next != NULL) r->next->prev = r;
		c->readings = r;
		tb_add(c->readers, tb_symbol(&readers_tag), tb_symbol(k), r);
		c->nreaders++;
		sx_hold(c->index, k, &c->holder);
		if (!ours(c, k)) pl_keep(c->places, k, 1);
	}
	pl_set_add(&r->set, e);
}

// e reads k no more. the last entry reading it: an entry's key, that entry may go; a spot, let go
// unless a run tracks it
static void reads_del(pc_cache *c, const void *k, entry *e) {
	rd *r = readers_of(c, k);
	if (r == NULL || !pl_set_del(&r->set, e) || r->set.n > 0) return;
	tb_del(c->readers, tb_symbol(&readers_tag), tb_symbol(k));
	c->nreaders--;
	if (r->prev != NULL) r->prev->next = r->next;
	else c->readings = r->next;
	if (r->next != NULL) r->next->prev = r->prev;
	pl_set_free(&r->set);
	free(r);
	sx_drop(c->index, k, &c->holder);
	mark *m = ours(c, k);
	if (m != NULL) settle(c, m->e);
	else if (pl_keep(c->places, k, -1) == 0) letgo(c, k);
}

// an entry goes when no run tracks its keys and no entry reads them
static void settle(pc_cache *c, entry *e) {
	if (!e->live) return;
	for (size_t i = 0; i < e->nkeys; i++) {
		if (cl_tracked(c->marks, e->keys[i]) || readers_of(c, e->keys[i]) != NULL) return;
	}
	e->live = 0;
	tb_del(c->entries, tb_symbol(&entry_tag), tb_string(e->name));
	c->nentries--;
	if (e->prev != NULL) e->prev->next = e->next;
	else c->all = e->next;
	if (e->next != NULL) e->next->prev = e->prev;
	e->prev = NULL;
	e->next = c->dead;
	c->dead = e;
	for (size_t i = 0; i < e->reads.n; i++) reads_del(c, e->reads.items[i], e);
}

// working out ---------------------------------------------------------------------------------

static entry *entry_of(pc_cache *c, kind k, const char *const *path, size_t n);

// where a path is: its id, read through its entry's first key, and the gone under it, through its
// gone key (the root: itself, none gone; children alone: never any gone, so not read). 1, *id and
// *gone; 0: nothing
static int here_at(pc_cache *c, const char *const *path, size_t n, pl_set *reads, tb_key *id,
	uint32_t *gone) {
	*gone = 0;
	if (n == 0) {
		*id = pl_root(c->places);
		return 1;
	}
	entry *up = entry_of(c, AT, path, n);
	pl_set_add(reads, up->keys[0]);
	if (up->answer.n == 0) return 0;
	// no id: a level (places' pl_level)
	*id = up->answer.a[0].id != NULL ? tb_string(up->answer.a[0].id) : pl_level();
	size_t given;
	if (pl_contributors(c->places, &given) == NULL) return 1;
	pl_set_add(reads, up->keys[2]);
	*gone = up->answer.gone;
	return 1;
}

typedef struct {
	pc_cache *c;
	entry *e;
	pl_set *reads;
	answer out;
} job;

static void compute(void *ctx) {
	job *j = ctx;
	pc_cache *c = j->c;
	entry *e = j->e;
	const char *const *path = (const char *const *)e->path;
	size_t folder = e->kind == AT ? e->npath - 1 : e->npath;
	tb_key id;
	uint32_t gone;
	// a level (no id) is a folder to list, as pl_list and pl_members_at have it
	if (!here_at(c, path, folder, j->reads, &id, &gone)) return;
	pl_here here = {.id = id, .has_path = 1, .path = path, .length = folder, .gone = gone};
	if (e->kind == AT) {
		pl_answers got = pl_answers_at(c->places, &here, path[e->npath - 1]);
		j->out.gone = got.gone;
		j->out.a = xalloc((got.n + 1) * sizeof *j->out.a);
		for (size_t i = 0; i < got.n; i++) {
			int level = got.items[i].id.symbol == pl_level().symbol;
			j->out.a[i] = (pc_answer){level ? NULL : xdup(got.items[i].id.string), got.items[i].from};
		}
		j->out.n = got.n;
		pl_answers_free(&got);
		return;
	}
	pl_nameds names = pl_names(c->places, &here);
	if (e->kind == LIST) {
		j->out.names = xalloc((names.n + 1) * sizeof *j->out.names);
		for (size_t i = 0; i < names.n; i++) j->out.names[i] = xdup(names.items[i].name);
		j->out.n = names.n;
	} else {
		// those whose names said none: gone for each name's walk too
		here.gone = names.gone;
		j->out.m = xalloc((names.n + 1) * sizeof *j->out.m);
		for (size_t i = 0; i < names.n; i++) {
			pl_member m;
			if (pl_walk_at(c->places, &here, &names.items[i].name, 1, &m) != 1) continue;
			// a level: no id
			char *id = m.id.symbol == pl_level().symbol ? NULL : xdup(m.id.string);
			j->out.m[j->out.n++] = (pc_member){xdup(m.name), id, m.from};
		}
	}
	pl_nameds_free(&names);
}

// e worked out, its reads recorded into *reads (empty), the answer into *out
static void work(pc_cache *c, entry *e, answer *out, pl_set *reads) {
	job j = {c, e, reads, {0}};
	pl_set fresh = {0};
	pl_record(c->places, compute, &j, reads, &fresh);
	for (size_t i = 0; i < fresh.n; i++) {
		tb_add(c->took, tb_symbol(&took_tag), tb_symbol(fresh.items[i]), (void *)&took_tag);
	}
	pl_set_free(&fresh);
	*out = j.out;
}

// what names an entry: its kind and the names of its path, each with its length
static char *name_of(kind k, const char *const *path, size_t n) {
	size_t size = 2;
	for (size_t i = 0; i < n; i++) size += strlen(path[i]) + 24;
	char *name = xalloc(size), *at = name;
	*at++ = "alm"[k];
	for (size_t i = 0; i < n; i++) at += snprintf(at, strlen(path[i]) + 24, "%zu:%s", strlen(path[i]), path[i]);
	return name;
}

static entry *make(pc_cache *c, kind k, const char *const *path, size_t n, char *name) {
	entry *e = xalloc(sizeof *e);
	e->name = name;
	e->kind = k;
	e->npath = n;
	e->path = xalloc((n + 1) * sizeof *e->path);
	for (size_t i = 0; i < n; i++) e->path[i] = xdup(path[i]);
	e->worked = c->now;
	e->live = 1;
	e->nkeys = k == AT ? 3 : 1;
	for (size_t i = 0; i < e->nkeys; i++) {
		mark *m = e->keys[i] = xalloc(sizeof *m);
		m->e = e;
		m->whole = k == AT ? i == 1 : 1;
		m->gone = k == AT && i == 2;
		cl_add(c->marks, m);
	}
	work(c, e, &e->answer, &e->reads);
	tb_add(c->entries, tb_symbol(&entry_tag), tb_string(e->name), e);
	c->nentries++;
	e->next = c->all;
	if (e->next != NULL) e->next->prev = e;
	c->all = e;
	for (size_t i = 0; i < e->reads.n; i++) reads_add(c, e->reads.items[i], e);
	return e;
}

static entry *entry_of(pc_cache *c, kind k, const char *const *path, size_t n) {
	char *name = name_of(k, path, n);
	entry *e = tb_get(c->entries, tb_symbol(&entry_tag), tb_string(name));
	if (e != NULL) {
		free(name);
		return e;
	}
	return make(c, k, path, n, name);
}

// worked out again as of tick: its keys whose part of the answer changed marked, by run
static void rework(pc_cache *c, entry *e, uint64_t tick, sc_run *run) {
	answer was = e->answer, fresh;
	pl_set old = e->reads, reads = {0};
	work(c, e, &fresh, &reads);
	e->answer = fresh;
	e->reads = reads;
	e->worked = tick;
	for (size_t i = 0; i < reads.n; i++) {
		if (!pl_set_has(&old, reads.items[i])) reads_add(c, reads.items[i], e);
	}
	for (size_t i = 0; i < old.n; i++) {
		if (!pl_set_has(&reads, old.items[i])) reads_del(c, old.items[i], e);
	}
	const void *changed[3];
	size_t n = 0;
	for (size_t i = 0; i < e->nkeys; i++) {
		const mark *m = e->keys[i];
		if (m->gone ? was.gone != fresh.gone : !same(e->kind, m->whole, &was, &fresh)) changed[n++] = m;
	}
	answer_free(&was);
	pl_set_free(&old);
	if (n > 0) sc_mark(c->s, changed, n, run);
}

// at before list and members, a folder before what is in it: the order an entry is worked out
// again in, so what it reads is worked out first
static size_t depth(const entry *e) { return 2 * e->npath + (e->kind == AT ? 0 : 1); }

typedef struct {
	entry *e;
	size_t at;
} hit;

static int by_depth(const void *a, const void *b) {
	const hit *x = a, *y = b;
	size_t dx = depth(x->e), dy = depth(y->e);
	if (dx != dy) return dx < dy ? -1 : 1;
	return x->at < y->at ? -1 : x->at > y->at;
}

static void heard_mark(void *data, const void *const *keys, size_t nkeys, sc_run *run, uint64_t tick) {
	pc_cache *c = data;
	enter(c);
	if (tick > c->now) c->now = tick;
	hit *hits = NULL;
	size_t n = 0, cap = 0;
	for (size_t i = 0; i < nkeys; i++) {
		rd *r = readers_of(c, keys[i]);
		if (r == NULL) continue;
		for (size_t j = 0; j < r->set.n; j++) {
			if (n == cap) {
				cap = cap ? cap * 2 : 8;
				hits = realloc(hits, cap * sizeof *hits);
				if (hits == NULL) abort();
			}
			hits[n] = (hit){(entry *)r->set.items[j], n};
			n++;
		}
	}
	if (n > 1) qsort(hits, n, sizeof *hits, by_depth);
	// worked as of this tick or later (by a mark made inside this one): already fresh
	for (size_t i = 0; i < n; i++) {
		if (hits[i].e->live && hits[i].e->worked < tick) rework(c, hits[i].e, tick, run);
	}
	free(hits);
	leave(c);
}

// the other keys (spots): tracked by a run or not
static void heard_track(const void *key, sc_run *run, void *data) {
	(void)run;
	pc_cache *c = data;
	if (ours(c, key) == NULL) tb_add(c->tracked, tb_symbol(&tracked_tag), tb_symbol(key), (void *)&tracked_tag);
}

static void heard_untrack(const void *key, void *data) {
	pc_cache *c = data;
	if (ours(c, key) != NULL) return;
	// no run tracks it now: if an entry reads it, its release was held back by us, so the spot is
	// ours to let go
	tb_del(c->tracked, tb_symbol(&tracked_tag), tb_symbol(key));
	if (readers_of(c, key) != NULL) tb_add(c->took, tb_symbol(&took_tag), tb_symbol(key), (void *)&took_tag);
}

// a mark's last tracker gone (clingy.h): its entry may go
static void untracked(const void *key, void *data) {
	pc_cache *c = data;
	enter(c);
	settle(c, ((const mark *)key)->e);
	leave(c);
}

// the answer at a path, its key told to the run open (outside one: the entry goes at once). the
// cache is busy till the caller has copied the answer: done settles the entry
static entry *ask(pc_cache *c, kind k, const char *const *path, size_t n, int which) {
	enter(c);
	entry *e = entry_of(c, k, path, n);
	pl_track(c->places, e->keys[which]);
	return e;
}

static void done(pc_cache *c, entry *e) {
	settle(c, e);
	leave(c);
}

// the public side -----------------------------------------------------------------------------

pc_cache *pc_new(pl *places, sc_scheduler *scheduler) {
	pc_cache *c = xalloc(sizeof *c);
	c->places = places;
	c->s = scheduler;
	c->entries = tb_new();
	c->readers = tb_new();
	c->tracked = tb_new();
	c->took = tb_new();
	c->index = sx_index_get(scheduler);
	c->holder = (sx_holder){.marked = heard_mark, .data = c};
	c->marks = cl_new(scheduler, untracked, c);
	c->on_track = sc_on_tracking_start(scheduler, heard_track, c);
	c->on_untrack = sc_on_tracking_end(scheduler, heard_untrack, c);
	return c;
}

void pc_free(pc_cache *c) {
	if (c == NULL) return;
	sc_remove_listener(c->on_track);
	sc_remove_listener(c->on_untrack);
	free_dead(c);
	while (c->all != NULL) {
		entry *e = c->all;
		c->all = e->next;
		entry_free(e);
	}
	while (c->readings != NULL) {
		rd *r = c->readings;
		c->readings = r->next;
		sx_drop(c->index, r->key, &c->holder);
		pl_set_free(&r->set);
		free(r);
	}
	tb_free(c->entries);
	tb_free(c->readers);
	tb_free(c->tracked);
	cl_free(c->marks);
	tb_free(c->took);
	sx_index_put(c->index);
	free(c);
}

char *pc_get(pc_cache *c, const char *const *path, size_t n) {
	if (n == 0) return xdup(pl_root(c->places).string);
	entry *e = ask(c, AT, path, n, 0);
	char *id = e->answer.n && e->answer.a[0].id != NULL ? xdup(e->answer.a[0].id) : NULL;
	done(c, e);
	return id;
}

pc_answers pc_gets(pc_cache *c, const char *const *path, size_t n) {
	pc_answers out = {0};
	if (n == 0) {
		out.items = xalloc(sizeof *out.items);
		out.items[out.n++] = (pc_answer){xdup(pl_root(c->places).string), "root"};
		return out;
	}
	entry *e = ask(c, AT, path, n, 1);
	out.items = xalloc((e->answer.n + 1) * sizeof *out.items);
	for (size_t i = 0; i < e->answer.n; i++) {
		if (e->answer.a[i].id == NULL) continue;
		out.items[out.n++] = (pc_answer){xdup(e->answer.a[i].id), e->answer.a[i].from};
	}
	done(c, e);
	return out;
}

void pc_answers_free(pc_answers *list) {
	for (size_t i = 0; i < list->n; i++) free(list->items[i].id);
	free(list->items);
	*list = (pc_answers){0};
}

pc_names pc_list(pc_cache *c, const char *const *path, size_t n) {
	pc_names out = {0};
	entry *e = ask(c, LIST, path, n, 0);
	out.items = xalloc((e->answer.n + 1) * sizeof *out.items);
	for (size_t i = 0; i < e->answer.n; i++) out.items[out.n++] = xdup(e->answer.names[i]);
	done(c, e);
	return out;
}

void pc_names_free(pc_names *list) {
	for (size_t i = 0; i < list->n; i++) free(list->items[i]);
	free(list->items);
	*list = (pc_names){0};
}

pc_members pc_members_at(pc_cache *c, const char *const *path, size_t n) {
	pc_members out = {0};
	entry *e = ask(c, MEMBERS, path, n, 0);
	out.items = xalloc((e->answer.n + 1) * sizeof *out.items);
	for (size_t i = 0; i < e->answer.n; i++) {
		const pc_member *m = &e->answer.m[i];
		out.items[out.n++] = (pc_member){xdup(m->name), m->id != NULL ? xdup(m->id) : NULL, m->from};
	}
	done(c, e);
	return out;
}

void pc_members_free(pc_members *list) {
	for (size_t i = 0; i < list->n; i++) free(list->items[i].name), free(list->items[i].id);
	free(list->items);
	*list = (pc_members){0};
}

pc_kept pc_kept_of(const pc_cache *c) { return (pc_kept){c->nentries, c->nreaders}; }
