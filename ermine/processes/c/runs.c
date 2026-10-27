// Runs (runs.h), in C.
#include "runs.h"

#include <stdlib.h>
#include <string.h>

#include "platform.h"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return s != NULL ? strcpy(xalloc(strlen(s) + 1), s) : NULL; }

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

#define FIELDS 8

// a key as the run first tracked it: the change there then (a ref; NULL: none, or not named)
typedef struct {
	const void *key;
	op_value *change;
} saw;

// a computer given, and its run as it goes: its number, its start, its writes so far, how many
// the record holds, and the keys it first tracked so far (on while the run is open)
typedef struct {
	sc_computer *c;
	char *id;
	// where it is in gs
	size_t at;
	int going;
	unsigned n;
	int has_started;
	double started;
	crn_wrote *writes;
	size_t nwrites, capwrites, written;
	int saw_on;
	saw *saws;
	size_t nsaws, capsaws;
	pl_set sawn;
} given;

// a record, and its keys: one a field (their addresses), told when read
typedef struct {
	char *id;
	crn_run *run;
	char keys[FIELDS];
	unsigned tracked;
	size_t at;
} held;

struct crn {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	crn_hold hold;
	void *hold_ctx;
	sc_listener *starts, *ends, *effects, *tracks, *freed;
	pl_watch *all;
	// the computers given, by address, and in a list
	tb_table *by;
	given **gs;
	size_t ngs, capgs;
	// the runs' table: by the computer's node id
	tb_table *records;
	held **hs;
	size_t nhs, caphs;
};

static const char tag;

static given *find(crn *r, const sc_computer *c) {
	return tb_get(r->by, tb_symbol(&tag), tb_symbol(c));
}

static held *find_held(crn *r, const char *id) {
	return tb_get(r->records, tb_symbol(&tag), tb_string(id));
}
static held *held_of(crn *r, const char *id) {
	held *h = find_held(r, id);
	if (h != NULL) return h;
	h = xalloc(sizeof *h);
	h->id = xdup(id);
	h->at = r->nhs;
	PUSH(r->hs, r->nhs, r->caphs, h);
	tb_add(r->records, tb_symbol(&tag), tb_string(h->id), h);
	return h;
}

// milliseconds since 1970, fractional
static double now(void) { return PF_NOW_MS(); }

// values -------------------------------------------------------------------------------------------

// a header's pieces as a value, held (the caller's to op_free): places' own (pl_change_value, made
// once a header and shared); one places didn't make, built here
static op_value *change_value(crn *r, const ch_header *h) {
	const op_value *shared = pl_change_value(r->places, h);
	if (shared != NULL) return op_ref((op_value *)shared);
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
		op_value *meta = op_map();
		for (size_t i = 0; i < h->metadata_length; i++) {
			const op_value *v = h->metadata[i].value;
			op_set(meta, h->metadata[i].key, v ? op_ref((op_value *)v) : op_null());
		}
		op_set(m, "metadata", meta);
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
	case OP_NUM: return op_same_num(a, b);
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

static int same_text(const char *a, const char *b) {
	return a == b || (a != NULL && b != NULL && strcmp(a, b) == 0);
}

static char *text(tb_key k) { return xdup(k.string); }

// reads and writes --------------------------------------------------------------------------------

static void read_free(crn_saw *r) {
	free(r->part);
	free(r->id);
	for (size_t i = 0; i < r->npath; i++) {
		if (r->path[i].type != OP_NUM_KEY) free((char *)r->path[i].s);
	}
	free(r->path);
	if (r->change != NULL) op_free(r->change);
}

static void write_free(crn_wrote *w) {
	free(w->part);
	free(w->id);
	if (w->change != NULL) op_free(w->change);
}

static void reads_unref(const crn_reads *b) {
	crn_reads *k = (crn_reads *)b;
	if (k == NULL || --k->refs > 0) return;
	for (size_t i = 0; i < k->n; i++) read_free(&k->items[i]);
	free(k->items);
	free(k);
}
static void writes_unref(const crn_writes *b) {
	crn_writes *k = (crn_writes *)b;
	if (k == NULL || --k->refs > 0) return;
	for (size_t i = 0; i < k->n; i++) write_free(&k->items[i]);
	free(k->items);
	free(k);
}

// a read named: where, and the change there as the run first read it (seen; NULL: as it ended); a
// key places can't name: unnamed
static crn_saw name_read(crn *r, const void *key, const saw *seen) {
	crn_saw out = {0};
	pl_where w;
	if (!pl_spot(r->places, key, &w)) {
		out.key = key;
		return out;
	}
	out.named = 1;
	out.part = text(w.part);
	out.id = text(w.id);
	if (w.change) out.spot = 1;
	else if (w.length > 0) {
		out.path = xalloc(w.length * sizeof *out.path);
		out.npath = w.length;
		for (size_t i = 0; i < w.length; i++) {
			out.path[i] = w.path[i];
			if (w.path[i].type != OP_NUM_KEY) out.path[i].s = xdup(w.path[i].s);
		}
	}
	out.keys = w.keys;
	if (seen != NULL) {
		out.change = seen->change != NULL ? op_ref(seen->change) : NULL;
		return out;
	}
	const nd_entry *there = tb_get(r->table, w.part, w.id);
	if (there != NULL) out.change = change_value(r, &there->change);
	return out;
}

static int same_read(const crn_saw *a, const crn_saw *b) {
	if (!a->named || !b->named) return !a->named && !b->named && a->key == b->key;
	if (!same_text(a->part, b->part) || !same_text(a->id, b->id) || a->spot != b->spot ||
	    a->keys != b->keys || a->npath != b->npath || !same(a->change, b->change)) {
		return 0;
	}
	for (size_t i = 0; i < a->npath; i++) {
		if (a->path[i].type != b->path[i].type) return 0;
		if (a->path[i].type == OP_NUM_KEY ? a->path[i].n != b->path[i].n
		                                  : strcmp(a->path[i].s, b->path[i].s) != 0) {
			return 0;
		}
	}
	return 1;
}

// the run's reads, each once in the order first read, named: a block, unless they are the ones
// there already (then those, held again)
static const crn_reads *reads_of(crn *r, const void *const *keys, size_t n, const crn_reads *was,
	const given *g) {
	crn_saw *out = xalloc((n + 1) * sizeof *out);
	size_t count = 0;
	pl_set seen = {0};
	// the keys first tracked come in the order the reads do: a cursor through them
	size_t at = 0;
	for (size_t i = 0; i < n; i++) {
		if (n < 16) {
			size_t j = 0;
			while (j < i && keys[j] != keys[i]) j++;
			if (j < i) continue;
		} else if (!pl_set_add(&seen, keys[i])) continue;
		const saw *s = g != NULL && at < g->nsaws && g->saws[at].key == keys[i] ? &g->saws[at] : NULL;
		if (s != NULL) at++;
		out[count++] = name_read(r, keys[i], s);
	}
	pl_set_free(&seen);
	if (was != NULL && was->n == count) {
		size_t i = 0;
		while (i < count && same_read(&was->items[i], &out[i])) i++;
		if (i == count) {
			for (i = 0; i < count; i++) read_free(&out[i]);
			free(out);
			((crn_reads *)was)->refs++;
			return was;
		}
	}
	crn_reads *b = xalloc(sizeof *b);
	b->refs = 1;
	b->items = out;
	b->n = count;
	return b;
}

static int writes_same(const crn_writes *was, const given *g) {
	if (was == NULL || was->n != g->nwrites) return 0;
	for (size_t i = 0; i < g->nwrites; i++) {
		const crn_wrote *a = &was->items[i], *b = &g->writes[i];
		if (!same_text(a->part, b->part) || !same_text(a->id, b->id) || !same(a->change, b->change)) {
			return 0;
		}
	}
	return 1;
}

// the writes so far, a block of their own (the pieces held again)
static const crn_writes *writes_of(const given *g) {
	crn_writes *b = xalloc(sizeof *b);
	b->refs = 1;
	b->items = xalloc((g->nwrites + 1) * sizeof *b->items);
	b->n = g->nwrites;
	for (size_t i = 0; i < g->nwrites; i++) {
		b->items[i] = (crn_wrote){xdup(g->writes[i].part), xdup(g->writes[i].id),
			g->writes[i].change != NULL ? op_ref(g->writes[i].change) : NULL};
	}
	return b;
}

static void run_free(crn_run *run) {
	if (run == NULL) return;
	reads_unref(run->reads);
	writes_unref(run->writes);
	free(run->error);
	free(run->act_error);
	free(run);
}

// the keys first tracked, let go
static void clear_saws(given *g) {
	for (size_t i = 0; i < g->nsaws; i++) {
		if (g->saws[i].change != NULL) op_free(g->saws[i].change);
	}
	g->nsaws = 0;
	pl_set_free(&g->sawn);
	g->sawn = (pl_set){0};
}

static void clear_writes(given *g) {
	for (size_t i = 0; i < g->nwrites; i++) write_free(&g->writes[i]);
	g->nwrites = g->written = 0;
}

// writing a record ----------------------------------------------------------------------------------

// whether a field of the record written differs from the one there: numbers and times by value,
// reads and writes by block (shared when the same), an error always (a new one each time) unless
// the record is the same run's again
static int differs(const crn_run *was, const crn_run *run, int f, int same_error) {
	if (was == NULL) return 1;
	switch (f) {
	case CRN_N: return was->n != run->n;
	case CRN_STARTED:
		return was->has_started != run->has_started || (run->has_started && was->started != run->started);
	case CRN_ENDED: return was->ended != run->ended;
	case CRN_END: return was->end != run->end;
	case CRN_ERROR: return !same_error && (was->error != NULL || run->error != NULL);
	// done again is the same; a failed act is a new one each time
	case CRN_ACT: return was->act != run->act || run->act == CRN_ACT_FAILED;
	case CRN_READS: return was->reads != run->reads;
	case CRN_WRITES: return was->writes != run->writes;
	}
	return 0;
}

// the record held (taken): the fields that differ marked, the computer's latest run their writer
static void put_record(crn *r, held *h, sc_run *by, crn_run *run, int same_error) {
	crn_run *was = h->run;
	const void *marked[FIELDS];
	size_t n = 0;
	for (int f = 0; f < FIELDS; f++) {
		if (differs(was, run, f, same_error) && (h->tracked & (1u << f))) marked[n++] = &h->keys[f];
	}
	h->run = run;
	run_free(was);
	if (n > 0) sc_mark(r->scheduler, marked, n, by);
}

// a record on its way through the hold hook: what take puts
typedef struct {
	crn *r;
	held *h;
	sc_run *by;
	crn_run *run;
	int same_error;
	int taken;
} holding;

static void take_record(void *taking) {
	holding *k = taking;
	if (k->taken) return;
	k->taken = 1;
	put_record(k->r, k->h, k->by, k->run, k->same_error);
}

// the record written (taken), through the hold hook when given: not taken, let go
static void write_record(crn *r, held *h, sc_run *by, crn_run *run, int same_error) {
	if (r->hold == NULL) {
		put_record(r, h, by, run, same_error);
		return;
	}
	holding k = {r, h, by, run, same_error, 0};
	r->hold(r->hold_ctx, tb_string(h->id), run, take_record, &k);
	if (!k.taken) run_free(run);
}

// the record read ------------------------------------------------------------------------------------

int crn_read(crn *r, crn_ask ask, void *ctx, tb_key id, crn_field field, const crn_run **out,
	const char **op, const char **reason) {
	*out = NULL;
	if (ask != NULL) {
		const char *o = "", *why = "";
		int a = ask(ctx, id, &o, &why);
		if (a != 0) {
			if (op != NULL) *op = o;
			if (reason != NULL) *reason = why;
			return a;
		}
	}
	held *h = held_of(r, id.string);
	for (int f = 0; f < FIELDS; f++) {
		if (field != CRN_ALL && (int)field != f) continue;
		h->tracked |= 1u << f;
		if (sc_track(r->scheduler, &h->keys[f]) == SC_STOP) return CRN_STOP;
	}
	*out = h->run;
	return 0;
}

void crn_drop(crn *r, tb_key id) {
	held *h = find_held(r, id.string);
	if (h == NULL) return;
	int had = h->run != NULL;
	run_free(h->run);
	h->run = NULL;
	if (!h->tracked) {
		tb_del(r->records, tb_symbol(&tag), tb_string(h->id));
		r->hs[h->at] = r->hs[--r->nhs];
		r->hs[h->at]->at = h->at;
		free(h->id);
		free(h);
		return;
	}
	if (!had) return;
	const void *marked[FIELDS];
	size_t n = 0;
	for (int f = 0; f < FIELDS; f++) {
		if (h->tracked & (1u << f)) marked[n++] = &h->keys[f];
	}
	sc_mark(r->scheduler, marked, n, NULL);
}

// the scheduler's ----------------------------------------------------------------------------------

// a fact landing with a run open of a computer given: that run's write
static void landed(const pl_fact *fact, void *ctx) {
	crn *r = ctx;
	sc_run *run = sc_get_run(r->scheduler);
	if (run == NULL) return;
	given *g = find(r, sc_run_computer(run));
	if (g == NULL || !g->going || g->n != sc_run_n(run)) return;
	crn_wrote w = {text(fact->part), text(fact->id), NULL};
	if (fact->change != NULL) w.change = change_value(r, fact->change);
	PUSH(g->writes, g->nwrites, g->capwrites, w);
}

// a key tracked in a run of a computer given: the change there, if it is the run's first track of it
static void tracked(const void *key, sc_run *run, void *ctx) {
	crn *r = ctx;
	given *g = find(r, sc_run_computer(run));
	if (g == NULL || !g->saw_on || g->n != sc_run_n(run)) return;
	if (!pl_set_add(&g->sawn, key)) return;
	saw s = {key, NULL};
	pl_where w;
	if (pl_spot(r->places, key, &w)) {
		const nd_entry *there = tb_get(r->table, w.part, w.id);
		if (there != NULL) s.change = change_value(r, &there->change);
	}
	PUSH(g->saws, g->nsaws, g->capsaws, s);
}

static void run_start(sc_computer *c, unsigned n, int rank, void *data) {
	(void)rank;
	crn *r = data;
	given *g = find(r, c);
	if (g == NULL) return;
	clear_writes(g);
	clear_saws(g);
	g->saw_on = 1;
	g->going = 1;
	g->n = n;
	g->has_started = 1;
	g->started = now();
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
	// gone: nothing
	sc_run *by = sc_latest(c);
	if (by == NULL) return;
	// given while it ran: its start not seen
	if (!g->going || g->n != n) {
		clear_writes(g);
		clear_saws(g);
		g->saw_on = 0;
		g->going = 1;
		g->n = n;
		g->has_started = 0;
	}
	held *h = held_of(r, g->id);
	const crn_run *was = h->run;
	crn_run *run = xalloc(sizeof *run);
	run->n = n;
	run->has_started = g->has_started;
	run->started = g->started;
	run->ended = now();
	run->end = end;
	if (ended == SC_FAIL) run->error = xdup(more->error != NULL ? more->error : "error");
	if (ended == SC_LOOPING) run->error = xdup("looping");
	run->reads = reads_of(r, reads, nreads, was != NULL ? was->reads : NULL, g);
	// pending: it may land done, naming the changes as first read
	if (ended != SC_PENDED) {
		g->saw_on = 0;
		clear_saws(g);
	}
	if (was != NULL && writes_same(was->writes, g)) {
		((crn_writes *)was->writes)->refs++;
		run->writes = was->writes;
	} else run->writes = writes_of(g);
	g->written = g->nwrites;
	write_record(r, h, by, run, 0);
}

// an effect's act ran (error: what it threw): the record's act, and its writes again
static void acted(sc_computer *c, unsigned n, const char *error, void *data) {
	crn *r = data;
	given *g = find(r, c);
	if (g == NULL) return;
	held *h = find_held(r, g->id);
	const crn_run *was = h != NULL ? h->run : NULL;
	sc_run *by = sc_latest(c);
	if (was == NULL || was->n != n || by == NULL) return;
	int wrote = g->going && g->n == n && g->nwrites != g->written;
	if (!wrote && error == NULL && was->act == CRN_ACT_DONE) return;
	crn_run *run = xalloc(sizeof *run);
	*run = *was;
	run->error = xdup(was->error);
	run->act = error != NULL ? CRN_ACT_FAILED : CRN_ACT_DONE;
	run->act_error = error != NULL ? xdup(error) : NULL;
	((crn_reads *)was->reads)->refs++;
	if (wrote) {
		g->written = g->nwrites;
		run->writes = writes_of(g);
	} else ((crn_writes *)was->writes)->refs++;
	write_record(r, h, by, run, 1);
}

static void given_free(given *g) {
	clear_writes(g);
	clear_saws(g);
	free(g->saws);
	free(g->writes);
	free(g->id);
	free(g);
}

// a computer freed: what was kept of it goes (the reference's WeakMaps by computer)
static void computer_freed(sc_scope *o, void *data) {
	crn *r = data;
	given *g = find(r, o);
	if (g == NULL) return;
	tb_del(r->by, tb_symbol(&tag), tb_symbol(o));
	given *last = r->gs[--r->ngs];
	r->gs[g->at] = last;
	last->at = g->at;
	given_free(g);
}

crn *crn_new(const crn_setup *setup) {
	crn *r = xalloc(sizeof *r);
	r->places = setup->places;
	r->table = setup->table;
	r->scheduler = setup->scheduler;
	r->hold = setup->hold;
	r->hold_ctx = setup->hold_ctx;
	r->by = tb_new();
	r->records = tb_new();
	r->all = pl_watch_all(r->places, landed, r);
	r->starts = sc_on_run_start(r->scheduler, run_start, r);
	r->ends = sc_on_run_end(r->scheduler, run_end, r);
	r->effects = sc_on_effect(r->scheduler, acted, r);
	r->tracks = sc_on_track(r->scheduler, tracked, r);
	r->freed = sc_on_free(r->scheduler, computer_freed, r);
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
	g->c = c;
	g->id = xdup(id.string);
	g->at = r->ngs;
	PUSH(r->gs, r->ngs, r->capgs, g);
	tb_add(r->by, tb_symbol(&tag), tb_symbol(c), g);
}

void crn_stop(crn *r) {
	if (r == NULL) return;
	if (r->starts != NULL) sc_remove_listener(r->starts);
	if (r->ends != NULL) sc_remove_listener(r->ends);
	if (r->effects != NULL) sc_remove_listener(r->effects);
	if (r->tracks != NULL) sc_remove_listener(r->tracks);
	if (r->freed != NULL) sc_remove_listener(r->freed);
	if (r->all != NULL) pl_stop(r->all);
	r->starts = r->ends = r->effects = r->tracks = r->freed = NULL;
	r->all = NULL;
}

void crn_free(crn *r) {
	if (r == NULL) return;
	crn_stop(r);
	for (size_t i = 0; i < r->nhs; i++) {
		run_free(r->hs[i]->run);
		free(r->hs[i]->id);
		free(r->hs[i]);
	}
	for (size_t i = 0; i < r->ngs; i++) given_free(r->gs[i]);
	tb_free(r->by);
	tb_free(r->records);
	free(r->hs);
	free(r->gs);
	free(r);
}
