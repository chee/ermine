// Status (status.h), in C.
#include "status.h"

#include <stdlib.h>
#include <string.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

typedef struct {
	sc_computer *c;
	char *id;
	// its last act failed: the status is the act's
	int act_failed;
} given;

struct cst {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	sc_listener *listener, *acts;
	given *ids;
	size_t nids, capids;
	nd_entry **nodes;
	size_t nnodes, capnodes;
};

#define PENDING_NAME "ermine.pending"

static op_value *pending_value(void) { return op_stand(op_str(PENDING_NAME)); }
static op_value *error_value(const char *message) {
	op_value *m = op_map();
	op_set(m, "name", op_str("Error"));
	op_set(m, "message", op_str(message));
	return op_stand(m);
}

int cst_is_pending(const op_value *v) {
	return v != NULL && v->type == OP_STAND && v->count == 1 && v->items[0]->type == OP_STR &&
		strcmp(v->items[0]->str, PENDING_NAME) == 0;
}
const char *cst_error(const op_value *v) {
	if (v == NULL || v->type != OP_STAND || v->count != 1 || v->items[0]->type != OP_MAP) return NULL;
	const op_value *m = op_get(v->items[0], "message");
	return m != NULL && m->type == OP_STR ? m->str : NULL;
}

const op_value *cst_status(pl *p, tb_key id) {
	op_key key = {.type = OP_STR_KEY, .s = CST_ATTRIBUTE};
	return pl_read(p, tb_string(CST_TABLE), id, &key, 1);
}
int cst_pending(pl *p, tb_key id) { return cst_is_pending(cst_status(p, id)); }

// what a write of a status refers to: kept by the node till its next update
typedef struct {
	op_patch patches[2];
	op_key keys[1];
	op_value *values[2];
	size_t n;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < 2; i++) op_free(k->values[i]);
	free(k);
}

// the status written, with the computer open: status NULL: none; nothing when it is already so
typedef struct {
	cst *s;
	const char *id;
	// taken by the write
	op_value *status;
} writing;

static void write_in_scope(void *data) {
	writing *w = data;
	cst *s = w->s;
	tb_key id = tb_string(w->id);
	nd_entry *there = tb_get(s->table, tb_string(CST_TABLE), id);
	const op_value *v = there != NULL ? there->value : NULL;
	int map = v != NULL && v->type == OP_MAP;
	const op_value *had = map ? op_get(v, CST_ATTRIBUTE) : NULL;
	if (w->status == NULL ? had == NULL : (had != NULL && cst_is_pending(had) && cst_is_pending(w->status))) {
		op_free(w->status);
		return;
	}
	ch_header h;
	pl_made *made;
	char *bad = pl_header(s->places, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) {
		free(bad);
		op_free(w->status);
		return;
	}
	if (there == NULL) {
		op_value *m = op_map();
		op_set(m, CST_ATTRIBUTE, w->status);
		nd_entry *node = nd_make_entry(m, &h);
		op_free(m);
		if (s->nnodes == s->capnodes) {
			s->capnodes = s->capnodes ? s->capnodes * 2 : 8;
			s->nodes = realloc(s->nodes, s->capnodes * sizeof *s->nodes);
			if (s->nodes == NULL) abort();
		}
		s->nodes[s->nnodes++] = node;
		pl_hold(s->places, node, made, pl_made_free);
		tb_add(s->table, tb_string(CST_TABLE), id, node);
		return;
	}
	block *b = xalloc(sizeof *b);
	b->keys[0] = (op_key){.type = OP_STR_KEY, .s = CST_ATTRIBUTE};
	if (!map) {
		b->values[0] = op_map();
		b->patches[b->n++] = (op_patch){.has_value = 1, .value = b->values[0]};
	}
	b->patches[b->n] = (op_patch){.place = {.path = b->keys, .length = 1}};
	if (w->status != NULL) b->patches[b->n].has_value = 1, b->patches[b->n].value = w->status;
	b->values[1] = w->status;
	b->n++;
	size_t failed;
	if (nd_update(there, b->patches, b->n, h, &failed) != OP_OK) abort();
	pl_hold(s->places, there, b, block_free);
	pl_hold_also(s->places, there, made, pl_made_free);
	pl_changed changed = {1, {there}};
	pl_commit(s->places, &changed);
}

static given *find(cst *s, const sc_computer *c) {
	for (size_t i = 0; i < s->nids; i++) {
		if (s->ids[i].c == c) return &s->ids[i];
	}
	return NULL;
}

static void run_end(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data) {
	(void)n, (void)reads, (void)nreads;
	cst *s = data;
	given *g = find(s, c);
	if (g == NULL) return;
	const char *id = g->id;
	op_value *status;
	switch (ended) {
	case SC_PENDED: status = pending_value(); break;
	case SC_FAIL: status = error_value(more->error != NULL ? more->error : "error"); break;
	case SC_LOOPING: status = error_value("looping"); break;
	case SC_DONE: status = NULL; break;
	default: return;
	}
	// done leaves a failed act's; any other end is the status
	if (status == NULL && g->act_failed) return;
	g->act_failed = 0;
	writing w = {s, id, status};
	sc_run_with_scope(c, write_in_scope, &w);
}

// an effect's act ran (error: what it threw): a failure is the status; the next success takes it away
static void acted(sc_computer *c, unsigned n, const char *error, void *data) {
	(void)n;
	cst *s = data;
	given *g = find(s, c);
	if (g == NULL) return;
	if (error == NULL && !g->act_failed) return;
	g->act_failed = error != NULL;
	writing w = {s, g->id, error != NULL ? error_value(error) : NULL};
	sc_run_with_scope(c, write_in_scope, &w);
}

cst *cst_new(const cst_setup *setup) {
	cst *s = xalloc(sizeof *s);
	s->places = setup->places;
	s->table = setup->table;
	s->scheduler = setup->scheduler;
	s->listener = sc_on_run_end(s->scheduler, run_end, s);
	s->acts = sc_on_effect(s->scheduler, acted, s);
	return s;
}

void cst_give(cst *s, sc_computer *c, tb_key id) {
	for (size_t i = 0; i < s->nids; i++) {
		if (s->ids[i].c == c) {
			free(s->ids[i].id);
			s->ids[i].id = xdup(id.string);
			return;
		}
	}
	if (s->nids == s->capids) {
		s->capids = s->capids ? s->capids * 2 : 8;
		s->ids = realloc(s->ids, s->capids * sizeof *s->ids);
		if (s->ids == NULL) abort();
	}
	s->ids[s->nids++] = (given){.c = c, .id = xdup(id.string)};
}

void cst_stop(cst *s) {
	if (s == NULL) return;
	if (s->listener != NULL) sc_remove_listener(s->listener);
	if (s->acts != NULL) sc_remove_listener(s->acts);
	s->listener = s->acts = NULL;
}

void cst_free(cst *s) {
	if (s == NULL) return;
	cst_stop(s);
	for (size_t i = 0; i < s->nnodes; i++) nd_free_entry(s->nodes[i]);
	for (size_t i = 0; i < s->nids; i++) free(s->ids[i].id);
	free(s->nodes);
	free(s->ids);
	free(s);
}
