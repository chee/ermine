// crowify (crowify.h), in C.
#include "crowify.h"

#include <stdlib.h>

// a run going on: what its reads gave it (subtree_of), each held (op_ref)
typedef struct {
	sc_computer *c;
	op_value **given;
	size_t n, capacity;
} going;

struct pl_crowified {
	cr_crow *crow;
	const op_value *(*subtree_of)(const void *key, void *ctx);
	void *ctx;
	going *runs;
	size_t nruns, capacity;
	sc_listener *start, *ret, *track, *end;
};

static int container(const op_value *v) {
	return v != NULL && (v->type == OP_LIST || v->type == OP_MAP || v->type == OP_TYPED);
}

// what a run's reads gave it let go of (each hold released)
static void forget_run(going *g) {
	for (size_t i = 0; i < g->n; i++) op_free(g->given[i]);
	free(g->given);
}

static going *find(pl_crowified *w, sc_computer *c) {
	for (size_t i = w->nruns; i-- > 0;)
		if (w->runs[i].c == c) return &w->runs[i];
	return NULL;
}

// a run starts: going on, with nothing read
static void run_start(sc_computer *c, unsigned n, int rank, ch_frame *frame, void *data) {
	(void)n, (void)rank, (void)frame;
	pl_crowified *w = data;
	if (w->nruns == w->capacity) {
		w->capacity = w->capacity ? 2 * w->capacity : 4;
		w->runs = realloc(w->runs, w->capacity * sizeof *w->runs);
		if (w->runs == NULL) abort();
	}
	w->runs[w->nruns++] = (going){c, NULL, 0, 0};
}

// a key a run tracked: what it gave the run, held
static void run_track(const void *key, sc_run *run, void *data) {
	pl_crowified *w = data;
	going *g = find(w, sc_run_computer(run));
	if (g == NULL) return;
	const op_value *x = w->subtree_of(key, w->ctx);
	if (!container(x)) return;
	if (g->n == g->capacity) {
		g->capacity = g->capacity ? 2 * g->capacity : 4;
		g->given = realloc(g->given, g->capacity * sizeof *g->given);
		if (g->given == NULL) abort();
	}
	g->given[g->n++] = op_ref((op_value *)x);
}

// a run's body returned: its result let go of, stopping at what the run was given
static void run_return(sc_computer *c, unsigned n, const void *value, void *data) {
	(void)n;
	pl_crowified *w = data;
	if (!container(value)) return;
	going *g = find(w, c);
	cr_let_go_in(w->crow, value, g != NULL && g->n ? (const op_value *const *)g->given : NULL,
		g != NULL ? g->n : 0);
}

// the run goes on no more. one that stopped to wait keeps what it read so far across the wait: let go
// of, each as a subtree of itself
static void run_end(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads, size_t nreads,
	const sc_more *more, void *data) {
	(void)n, (void)reads, (void)nreads, (void)more;
	pl_crowified *w = data;
	going *g = find(w, c);
	if (g == NULL) return;
	if (ended == SC_PENDED && g->n) {
		for (size_t i = 0; i < g->n; i++)
			cr_let_go_in(w->crow, g->given[i], (const op_value *const *)g->given, g->n);
	}
	forget_run(g);
	*g = w->runs[--w->nruns];
}

pl_crowified *pl_crowify(sc_scheduler *s, cr_crow *c, const op_value *(*subtree_of)(const void *key, void *ctx),
	void *ctx) {
	pl_crowified *w = calloc(1, sizeof *w);
	if (w == NULL) abort();
	w->crow = c, w->subtree_of = subtree_of, w->ctx = ctx;
	w->start = sc_on_run_start(s, run_start, w);
	w->ret = sc_on_run_return(s, run_return, w);
	if (subtree_of != NULL) w->track = sc_on_track(s, run_track, w);
	w->end = sc_on_run_end(s, run_end, w);
	return w;
}

void pl_crowify_stop(pl_crowified *w) {
	if (w == NULL) return;
	sc_remove_listener(w->start);
	sc_remove_listener(w->ret);
	if (w->track != NULL) sc_remove_listener(w->track);
	sc_remove_listener(w->end);
	for (size_t i = 0; i < w->nruns; i++) forget_run(&w->runs[i]);
	free(w->runs);
	free(w);
}

int pl_update_entry(cr_crow *c, nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed) {
	op_value *after;
	op_undo undo = {0};
	int code = cr_update(c, entry, entry->value, patches, n, &after, &undo, failed);
	if (code != OP_OK) return code;
	op_free(entry->value);
	entry->value = after;
	op_undo_free(&entry->undo);
	entry->undo = undo;
	ch_frame_ref(header.frame);
	ch_frame_free(entry->change.frame);
	entry->change = header;
	entry->change.has_op = 1;
	entry->change.patches = patches;
	entry->change.patches_length = n;
	entry->change.undo = undo.patches;
	entry->change.undo_length = undo.n;
	return OP_OK;
}
