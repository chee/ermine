// history in C (typescript/history.ts): a log and ermine's C graph (core/table/c,
// filesystem/places/c), tied. the recorder: every kept write here (pl_watch_all) a step of this
// device's. the lander: every step from elsewhere (the log's told) written into the graph
//
// the merge: an entry's value is its steps' patches applied in order of lamport, then device, from
// nothing. a step that sorts last is applied as it is; one that sorts before steps already there,
// and the entry is worked out again from its steps, read back from the log's store. a step whose
// patches don't apply there is passed over, and listed in failed until they do. the graph is the
// last snapshot and the steps after it
//
// C11 (op's value.h is). history's own memory goes through tp_mem; what it writes into the graph
// (values, patches, headers) is the graph's, malloc'd, as everything there is
//
//   tp_history *h = tp_history_new(&o);       // records from now
//   log's told: tp_history_told(h, ...), then the sync's
//   tp_history_load(h);                       // after a restart: the snapshot, and the steps after it
//   tp_history_snapshot(h);
#ifndef TIPPET_HISTORY_H
#define TIPPET_HISTORY_H

#include "../../../filesystem/places/c/places.h"
#include "tippet.h"

typedef struct tp_history tp_history;

typedef struct {
	tp_mem mem;
	tp_log *log;
	tb_table *table;
	pl *places;
	// which writes are kept (and so travel); NULL: string ids in value, attributes, children
	int (*kept)(void *ctx, const char *node, const char *part);
	// the graph's writes made inside it: f(data), called once (the host's scope: sc_run_with_scope);
	// NULL: as they are
	void (*run)(void *ctx, void (*f)(void *data), void *data);
	void *ctx;
} tp_history_options;

// NULL: no memory
tp_history *tp_history_new(const tp_history_options *o);
// it stops recording, and is let go; what it wrote into the graph stays
void tp_history_free(tp_history *h);
// the lander: the log's told (a tp_told, ctx the history). this device's own steps are passed over
void tp_history_told(void *ctx, const uint8_t device[32], uint64_t from, size_t count);
// after a restart, into an empty graph: the snapshot written into it, and every step held after it
// landed, this device's too. 0, or a code (TP_NOTSTEP: a snapshot not as written, and no step
// landed after it)
int tp_history_load(tp_history *h);
// each kept entry's value and its list of steps, and how many of each device's steps are in them,
// into the store, in place of the snapshot before. 0, or a code. its bytes are held while written
int tp_history_snapshot(tp_history *h);

// a step that didn't land (device its writer's), or a write here not kept (device NULL, n 0)
typedef struct {
	const uint8_t *device;
	uint64_t n;
	const char *node, *part, *why;
} tp_failed;
// how many of each; the i-th in *out, good while the history is
size_t tp_history_failed(const tp_history *h, size_t i, tp_failed *out);
size_t tp_history_unkept(const tp_history *h, size_t i, tp_failed *out);

#endif
