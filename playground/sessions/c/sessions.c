// Sessions (sessions.h), after typescript/sessions.ts.
#include "sessions.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

sess_session sess_start(const uint8_t random[16], const char *install) {
	sess_session s = {.install = install};
	uint8_t id[ID_SHORT];
	id_fresh(random, id);
	id_text(id, ID_SHORT, s.id);
	return s;
}

// a write made as the world's scope
static void as(sess_world *w, void (*f)(void *data), void *data) {
	sc_run_with_scope(w->scope, f, data);
}

// the header of a write made now, with the scope open, and its block
static void header_now(sess_world *w, ch_header *h, pl_made **made) {
	char *bad = pl_header(w->places, NULL, 0, CH_HERE, h, made);
	if (bad != NULL) {
		fprintf(stderr, "sessions: %s\n", bad);
		abort();
	}
}

// the nodes a write changed hold the header's block too
static void hold_header(sess_world *w, const pl_changed *changed, pl_made *made) {
	for (size_t i = 0; i < changed->n; i++) {
		pl_hold_also(w->places, changed->entries[i], pl_made_ref(made), pl_made_free);
	}
}

static bool is_map(const op_value *v) { return v != NULL && v->type == OP_MAP; }

// whether the value is a beat: { install: string, until: number }
static bool is_beat(const op_value *v) {
	if (!is_map(v)) return false;
	const op_value *install = op_get(v, "install"), *until = op_get(v, "until");
	return install != NULL && install->type == OP_STR && until != NULL && until->type == OP_NUM;
}

static double until_of(const op_value *beat) { return op_get(beat, "until")->num; }

// beat --------------------------------------------------------------------------------------------

typedef struct {
	sess_world *w;
	const char *node;
	const char *session;
	const op_value *beat;
} beating;

static void beat_in(void *data) {
	beating *b = data;
	sess_world *w = b->w;
	ch_header h;
	pl_made *made;
	header_now(w, &h, &made);
	const char *path[1] = {b->session};
	pl_changed changed;
	nd_entry *node;
	pl_upsert(w->places, tb_string(SESS_PART), tb_string(b->node), path, 1, b->beat, h, &changed, &node);
	hold_header(w, &changed, made);
	if (node != NULL) pl_hold(w->places, node, made, pl_made_free);
	else pl_made_free(made);
	pl_commit(w->places, &changed);
}

void sess_beat(sess_world *w, const sess_session *session, const char *node, int64_t until) {
	op_value *beat = op_map();
	op_set(beat, "install", op_str(session->install));
	op_set(beat, "until", op_num((double)until));
	beating b = {w, node, session->id, beat};
	as(w, beat_in, &b);
	op_free(beat);
}

// remove ------------------------------------------------------------------------------------------

// what the removal patches refer to: kept by the node till its next update
typedef struct {
	op_patch *patches;
	op_key *keys;
	char **names;
	size_t n;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < k->n; i++) free(k->names[i]);
	free(k->names);
	free(k->keys);
	free(k->patches);
	free(k);
}

typedef struct {
	sess_world *w;
	nd_entry *there;
	char *const *gone;
	size_t n;
} taking;

static void take_in(void *data) {
	taking *t = data;
	sess_world *w = t->w;
	block *b = xalloc(sizeof *b);
	b->n = t->n;
	b->names = xalloc(t->n * sizeof *b->names);
	b->keys = xalloc(t->n * sizeof *b->keys);
	b->patches = xalloc(t->n * sizeof *b->patches);
	for (size_t i = 0; i < t->n; i++) {
		b->names[i] = xdup(t->gone[i]);
		b->keys[i] = (op_key){.type = OP_STR_KEY, .s = b->names[i]};
		// no value: the place is removed
		b->patches[i] = (op_patch){.place = {.path = &b->keys[i], .length = 1}};
	}
	ch_header h;
	pl_made *made;
	header_now(w, &h, &made);
	size_t failed;
	int code = nd_update(t->there, b->patches, t->n, h, &failed);
	if (code != OP_OK) {
		fprintf(stderr, "sessions: remove: %s\n", op_code_name(code));
		abort();
	}
	pl_hold(w->places, t->there, b, block_free);
	pl_changed changed = {1, {t->there}};
	hold_header(w, &changed, made);
	pl_made_free(made);
	pl_commit(w->places, &changed);
}

// the entries of sessions (n names) that are there at node, out as one write; none there: no write
static void remove_from(sess_world *w, const char *node, char *const *sessions, size_t n) {
	nd_entry *there = tb_get(w->table, tb_string(SESS_PART), tb_string(node));
	if (there == NULL || !is_map(there->value)) return;
	char **gone = xalloc((n + 1) * sizeof *gone);
	size_t count = 0;
	for (size_t i = 0; i < n; i++) {
		if (op_get(there->value, sessions[i]) != NULL) gone[count++] = sessions[i];
	}
	if (count > 0) {
		taking t = {w, there, gone, count};
		as(w, take_in, &t);
	}
	free(gone);
}

void sess_leave(sess_world *w, const sess_session *session, const char *node) {
	char *name = (char *)session->id;
	remove_from(w, node, &name, 1);
}

void sess_sweep(sess_world *w, const char *node, int64_t now) {
	const nd_entry *there = tb_get(w->table, tb_string(SESS_PART), tb_string(node));
	if (there == NULL || !is_map(there->value)) return;
	// the names are copied: the removal changes the map they are in
	size_t count = there->value->count, old = 0;
	char **names = xalloc(count * sizeof *names);
	for (size_t i = 0; i < count; i++) {
		const op_value *b = there->value->items[i];
		if (!is_beat(b) || until_of(b) <= (double)now) names[old++] = xdup(there->value->keys[i]);
	}
	remove_from(w, node, names, old);
	for (size_t i = 0; i < old; i++) free(names[i]);
	free(names);
}

// online ------------------------------------------------------------------------------------------

sess_heres sess_online(sess_world *w, const char *node, int64_t now) {
	sess_heres out = {0};
	const op_value *all = pl_read(w->places, tb_string(SESS_PART), tb_string(node), NULL, 0);
	if (!is_map(all)) return out;
	out.items = xalloc(all->count * sizeof *out.items);
	for (size_t i = 0; i < all->count; i++) {
		const op_value *b = all->items[i];
		if (!is_beat(b) || until_of(b) <= (double)now) continue;
		out.items[out.n++] = (sess_here){xdup(all->keys[i]), xdup(op_get(b, "install")->str),
			(int64_t)until_of(b)};
	}
	return out;
}

void sess_heres_free(sess_heres *here) {
	for (size_t i = 0; i < here->n; i++) {
		free(here->items[i].session);
		free(here->items[i].install);
	}
	free(here->items);
	*here = (sess_heres){0};
}
