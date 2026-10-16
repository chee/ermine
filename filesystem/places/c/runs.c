// Runs (runs.h), in C.
#include "runs.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

// a computer given, and its run as it goes: its number, its start, its writes so far (a list),
// how many of them the record holds
typedef struct {
	sc_computer *c;
	char *id;
	int going;
	unsigned n;
	int has_started;
	double started;
	op_value *writes;
	size_t written;
} given;

struct crn {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	sc_listener *starts, *ends, *effects;
	pl_watch *all;
	// the computers given, by address, and in a list
	tb_table *by;
	given **gs;
	size_t ngs, capgs;
	nd_entry **nodes;
	size_t nnodes, capnodes;
};

static const char tag;

static given *find(crn *r, const sc_computer *c) {
	return tb_get(r->by, tb_symbol(&tag), tb_symbol(c));
}

const op_value *crn_latest(pl *p, tb_key id) {
	op_key key = {.type = OP_STR_KEY, .s = CRN_ATTRIBUTE};
	return pl_read(p, tb_string("attributes"), id, &key, 1);
}

// milliseconds since 1970, fractional
static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_REALTIME, &t);
	return (double)t.tv_sec * 1e3 + (double)t.tv_nsec / 1e6;
}

static op_value *error_value(const char *message) {
	op_value *m = op_map();
	op_set(m, "name", op_str("Error"));
	op_set(m, "message", op_str(message));
	return op_stand(m);
}

static op_value *text(tb_key k) { return k.string != NULL ? op_str(k.string) : op_null(); }

// a header's pieces as a map: time, actor, reader, external, metadata (not its op)
static op_value *change_value(const ch_header *h) {
	op_value *m = op_map();
	if (h->has_time) op_set(m, "time", op_num((double)h->time));
	if (h->actor != NULL) op_set(m, "actor", op_ref((op_value *)h->actor));
	if (h->reader != NULL) op_set(m, "reader", op_str(h->reader));
	if (h->external_length > 0) {
		op_value *sites = op_list();
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			op_value *site = op_map();
			op_set(site, "file", op_str(s->file ? s->file : ""));
			op_set(site, "line", op_num((double)s->line));
			if (s->has_column) op_set(site, "column", op_num((double)s->column));
			if (s->function != NULL) op_set(site, "function", op_str(s->function));
			op_push(sites, site);
		}
		op_set(m, "external", sites);
	}
	if (h->metadata_length > 0) {
		op_value *pairs = op_list();
		for (size_t i = 0; i < h->metadata_length; i++) {
			op_value *pair = op_list();
			op_push(pair, op_str(h->metadata[i].key));
			op_push(pair, h->metadata[i].value ? op_ref((op_value *)h->metadata[i].value) : op_null());
			op_push(pairs, pair);
		}
		op_set(m, "metadata", pairs);
	}
	return m;
}

// whether two values are alike: the same one, or the same in every piece
static int same(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return !a->bool_ == !b->bool_;
	case OP_NUM: return a->num == b->num;
	case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
	case OP_BYTES:
	case OP_TYPED:
		return a->kind == b->kind && a->bytes == b->bytes && memcmp(a->data, b->data, a->bytes) == 0;
	case OP_STAND: return same(a->items[0], b->items[0]);
	case OP_LIST:
	case OP_MAP:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++) {
			if (a->type == OP_MAP && strcmp(a->keys[i], b->keys[i]) != 0) return 0;
			if (!same(a->items[i], b->items[i])) return 0;
		}
		return 1;
	}
	return 0;
}

// a list's items, held again, in a new list
static op_value *snapshot(const op_value *list) {
	op_value *out = op_list();
	for (size_t i = 0; i < list->count; i++) op_push(out, op_ref(list->items[i]));
	return out;
}

// a fact landing with a run open of a computer given: that run's write
static void landed(const pl_fact *fact, void *ctx) {
	crn *r = ctx;
	sc_run *run = sc_get_run(r->scheduler);
	if (run == NULL) return;
	given *g = find(r, sc_run_computer(run));
	if (g == NULL || !g->going || g->n != sc_run_n(run)) return;
	op_value *w = op_map();
	op_set(w, "part", text(fact->part));
	op_set(w, "id", text(fact->id));
	if (fact->change != NULL) op_set(w, "change", change_value(fact->change));
	op_push(g->writes, w);
}

static void run_start(sc_computer *c, unsigned n, int rank, void *data) {
	(void)rank;
	crn *r = data;
	given *g = find(r, c);
	if (g == NULL) return;
	op_free(g->writes);
	*g = (given){c, g->id, 1, n, 1, now(), op_list(), 0};
}

// whether a read is of a record: the attribute, all of the attributes of a node holding one, or
// their change
static int of_a_record(crn *r, const pl_where *w) {
	if (w->part.string == NULL || strcmp(w->part.string, "attributes") != 0 || w->keys) return 0;
	if (!w->change && w->length > 0) {
		return w->path[0].type == OP_STR_KEY && strcmp(w->path[0].s, CRN_ATTRIBUTE) == 0;
	}
	const nd_entry *there = tb_get(r->table, tb_string("attributes"), w->id);
	return there != NULL && there->value != NULL && there->value->type == OP_MAP &&
		op_get(there->value, CRN_ATTRIBUTE) != NULL;
}

// a read named, as a map; a key places can't name: null. *record: it is of a record
static op_value *named(crn *r, const void *key, int *record) {
	pl_where w;
	if (!pl_spot(r->places, key, &w)) return op_null();
	if (of_a_record(r, &w)) {
		*record = 1;
		return NULL;
	}
	op_value *m = op_map();
	op_set(m, "part", text(w.part));
	op_set(m, "id", text(w.id));
	if (w.change) op_set(m, "path", op_null());
	else {
		op_value *path = op_list();
		for (size_t i = 0; i < w.length; i++) {
			const op_key *k = &w.path[i];
			op_push(path, k->type == OP_NUM_KEY ? op_num((double)k->n) : op_str(k->s));
		}
		op_set(m, "path", path);
	}
	if (w.keys) op_set(m, "keys", op_bool(1));
	const nd_entry *there = tb_get(r->table, w.part, w.id);
	if (there != NULL) op_set(m, "change", change_value(&there->change));
	return m;
}

// the run's reads, each once, in the order first read, named; one of a record: NULL
static op_value *reads_of(crn *r, const void *const *reads, size_t n) {
	op_value *out = op_list();
	pl_set seen = {0};
	for (size_t i = 0; i < n; i++) {
		if (n < 16) {
			size_t j = 0;
			while (j < i && reads[j] != reads[i]) j++;
			if (j < i) continue;
		} else if (!pl_set_add(&seen, reads[i])) continue;
		int record = 0;
		op_value *m = named(r, reads[i], &record);
		if (record) {
			op_free(out);
			pl_set_free(&seen);
			return NULL;
		}
		op_push(out, m);
	}
	pl_set_free(&seen);
	return out;
}

// what a write refers to: kept by the node till its next update
#define FIELDS 7
typedef struct {
	op_patch patches[FIELDS + 2];
	op_key keys[FIELDS + 2][2];
	op_value *values[FIELDS + 2];
	size_t n;
} block;

static void block_free(void *b) {
	block *k = b;
	for (size_t i = 0; i < FIELDS + 2; i++) op_free(k->values[i]);
	free(k);
}

static const char *const fields[FIELDS] = {"n", "started", "ended", "end", "error", "reads", "writes"};

// the record written, with the computer open: run (taken) holds the fields to write, a patch for
// each that differs from the one there (those not in only are left as they are)
typedef struct {
	crn *r;
	const char *id;
	op_value *run;
	// only these fields; NULL: all
	const char *only;
} writing;

static void put(block *b, size_t length, const char *field, op_value *value) {
	size_t i = b->n++;
	b->keys[i][0] = (op_key){.type = OP_STR_KEY, .s = CRN_ATTRIBUTE};
	if (field != NULL) b->keys[i][1] = (op_key){.type = OP_STR_KEY, .s = field};
	b->patches[i] = (op_patch){.place = {.path = b->keys[i], .length = length}};
	if (value != NULL) b->patches[i].has_value = 1, b->patches[i].value = value;
	b->values[i] = value;
}

static void write_in_scope(void *data) {
	writing *w = data;
	crn *r = w->r;
	tb_key id = tb_string(w->id);
	ch_header h;
	pl_made *made;
	char *bad = pl_header(r->places, NULL, 0, CH_HERE, &h, &made);
	if (bad != NULL) {
		free(bad);
		op_free(w->run);
		return;
	}
	nd_entry *there = tb_get(r->table, tb_string("attributes"), id);
	if (there == NULL) {
		op_value *m = op_map();
		op_set(m, CRN_ATTRIBUTE, w->run);
		nd_entry *node = nd_make_entry(m, &h, NULL);
		op_free(m);
		if (r->nnodes == r->capnodes) {
			r->capnodes = r->capnodes ? r->capnodes * 2 : 8;
			r->nodes = realloc(r->nodes, r->capnodes * sizeof *r->nodes);
			if (r->nodes == NULL) abort();
		}
		r->nodes[r->nnodes++] = node;
		pl_hold(r->places, node, made, pl_made_free);
		tb_add(r->table, tb_string("attributes"), id, node);
		return;
	}
	const op_value *v = there->value;
	int map = v != NULL && v->type == OP_MAP;
	const op_value *was = map ? op_get(v, CRN_ATTRIBUTE) : NULL;
	block *b = xalloc(sizeof *b);
	if (!map) {
		b->values[0] = op_map();
		b->patches[0] = (op_patch){.has_value = 1, .value = b->values[0]};
		b->n = 1;
	}
	if (was == NULL || was->type != OP_MAP) put(b, 1, NULL, op_ref(w->run));
	else {
		for (size_t i = 0; i < FIELDS; i++) {
			const char *f = fields[i];
			if (w->only != NULL && strcmp(w->only, f) != 0) continue;
			op_value *now_ = op_get(w->run, f);
			const op_value *then = op_get(was, f);
			if (now_ == NULL && then == NULL) continue;
			if (now_ != NULL && then != NULL && strcmp(f, "error") != 0 && same(now_, then)) continue;
			put(b, 2, f, now_ != NULL ? op_ref(now_) : NULL);
		}
	}
	op_free(w->run);
	if (b->n == 0) {
		block_free(b);
		pl_made_free(made);
		return;
	}
	size_t failed;
	if (nd_update(there, b->patches, b->n, h, &failed) != OP_OK) abort();
	pl_hold(r->places, there, b, block_free);
	pl_hold_also(r->places, there, made, pl_made_free);
	pl_changed changed = {1, {there}};
	pl_commit(r->places, &changed);
}

static const char *end_name(sc_ended ended) {
	switch (ended) {
	case SC_DONE: return "done";
	case SC_PENDED: return "pending";
	case SC_FAIL: return "failed";
	case SC_LOOPING: return "looping";
	default: return NULL;
	}
}

static void run_end(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data) {
	crn *r = data;
	given *g = find(r, c);
	const char *end = end_name(ended);
	if (g == NULL || end == NULL) return;
	// given while it ran: its start not seen
	if (!g->going || g->n != n) {
		op_free(g->writes);
		*g = (given){c, g->id, 1, n, 0, 0, op_list(), 0};
	}
	op_value *named_reads = reads_of(r, reads, nreads);
	if (named_reads == NULL) return;
	op_value *run = op_map();
	op_set(run, "n", op_num((double)n));
	if (g->has_started) op_set(run, "started", op_num(g->started));
	op_set(run, "ended", op_num(now()));
	op_set(run, "end", op_str(end));
	if (ended == SC_FAIL) op_set(run, "error", error_value(more->error != NULL ? more->error : "error"));
	if (ended == SC_LOOPING) op_set(run, "error", error_value("looping"));
	op_set(run, "reads", named_reads);
	op_set(run, "writes", snapshot(g->writes));
	g->written = g->writes->count;
	writing w = {r, g->id, run, NULL};
	if (sc_run_with_scope(c, write_in_scope, &w) != NULL) op_free(run);
}

// an effect's act wrote: the record's writes again
static void acted(sc_computer *c, unsigned n, const char *error, void *data) {
	(void)error;
	crn *r = data;
	given *g = find(r, c);
	if (g == NULL || !g->going || g->n != n || g->writes->count == g->written) return;
	const nd_entry *there = tb_get(r->table, tb_string("attributes"), tb_string(g->id));
	const op_value *was = there != NULL && there->value != NULL && there->value->type == OP_MAP
		? op_get(there->value, CRN_ATTRIBUTE)
		: NULL;
	const op_value *wn = was != NULL && was->type == OP_MAP ? op_get(was, "n") : NULL;
	if (wn == NULL || wn->type != OP_NUM || wn->num != (double)n) return;
	g->written = g->writes->count;
	op_value *run = op_map();
	op_set(run, "writes", snapshot(g->writes));
	writing w = {r, g->id, run, "writes"};
	// gone (an effect torn down by its own act): nothing
	if (sc_run_with_scope(c, write_in_scope, &w) != NULL) op_free(run);
}

crn *crn_new(const crn_setup *setup) {
	crn *r = xalloc(sizeof *r);
	r->places = setup->places;
	r->table = setup->table;
	r->scheduler = setup->scheduler;
	r->by = tb_new();
	r->all = pl_watch_all(r->places, landed, r);
	r->starts = sc_on_run_start(r->scheduler, run_start, r);
	r->ends = sc_on_run_end(r->scheduler, run_end, r);
	r->effects = sc_on_effect(r->scheduler, acted, r);
	return r;
}

void crn_give(crn *r, sc_computer *c, tb_key id) {
	given *g = find(r, c);
	if (g != NULL) {
		free(g->id);
		g->id = xdup(id.string);
		return;
	}
	g = xalloc(sizeof *g);
	*g = (given){c, xdup(id.string), 0, 0, 0, 0, op_list(), 0};
	if (r->ngs == r->capgs) {
		r->capgs = r->capgs ? r->capgs * 2 : 8;
		r->gs = realloc(r->gs, r->capgs * sizeof *r->gs);
		if (r->gs == NULL) abort();
	}
	r->gs[r->ngs++] = g;
	tb_add(r->by, tb_symbol(&tag), tb_symbol(c), g);
}

void crn_stop(crn *r) {
	if (r == NULL) return;
	if (r->starts != NULL) sc_remove_listener(r->starts);
	if (r->ends != NULL) sc_remove_listener(r->ends);
	if (r->effects != NULL) sc_remove_listener(r->effects);
	if (r->all != NULL) pl_stop(r->all);
	r->starts = r->ends = r->effects = NULL;
	r->all = NULL;
}

void crn_free(crn *r) {
	if (r == NULL) return;
	crn_stop(r);
	for (size_t i = 0; i < r->nnodes; i++) nd_free_entry(r->nodes[i]);
	for (size_t i = 0; i < r->ngs; i++) {
		op_free(r->gs[i]->writes);
		free(r->gs[i]->id);
		free(r->gs[i]);
	}
	tb_free(r->by);
	free(r->nodes);
	free(r->gs);
	free(r);
}
