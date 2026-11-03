// History in C (see typescript/history.ts): a log tied to the C graph. The recorder turns writes
// here into steps; the lander writes steps from elsewhere into the graph.
// History's own memory goes through tp_mem; what it writes into the graph is malloc'd.
#ifndef TIPPET_HISTORY_H
#define TIPPET_HISTORY_H

#include "../../../core/places/c/places.h"
#include "../../../lib/changeable/c/apply.h"
#include "tippet.h"

typedef struct tp_history tp_history;

typedef struct {
	tp_mem mem;
	tp_log *log;
	tb_table *table;
	pl *places;
	int (*kept)(void *ctx, const char *node, const char *part);
	void (*run)(void *ctx, void (*f)(void *data), void *data);
	void *ctx;
	int forgets; // per entry its elements only, the value the graph's (WIRE.md, ids: a reader that forgets)
	long rebase; // newest steps per entry that hold their undo: 0 the default (256), negative none; forgets: none
} tp_history_options;

tp_history *tp_history_new(const tp_history_options *o);
void tp_history_free(tp_history *h);
void tp_history_told(void *ctx, const uint8_t device[32], uint64_t from, size_t count);
int tp_history_load(tp_history *h);
int tp_history_snapshot(tp_history *h);

typedef struct {
	const uint8_t *device;
	uint64_t n;
	const char *node, *part, *why;
} tp_failed;
size_t tp_history_failed(const tp_history *h, size_t i, tp_failed *out);
size_t tp_history_unkept(const tp_history *h, size_t i, tp_failed *out);

int tp_history_forget(tp_history *h, const tp_sync *s);

// Lets go of the trash: every container removed or replaced, held hidden with what is under it,
// until the host asks. After it a step's patch into one is skipped on this device. Returns how many
// containers went, or a tp code below 0. A device that holds the log and works an entry out again
// makes its trash again.
long tp_history_empty(tp_history *h);
// The trash held now: how many containers, and the bytes they hold in memory (cells and values;
// a value shared with the graph is counted whole). Values count where the library's heap
// counter does not see them.
void tp_history_trash(const tp_history *h, size_t *count, size_t *bytes);

// One of the cells at a path: its value (the caller frees it with op_free) and the step that made it.
typedef struct {
	op_value *value;
	const uint8_t *device;
	uint64_t n;
} tp_version;
// The cells visible at a path (a key or index of the graph's value): the shown first, then the rest
// newest first, each from the step that made it (device, n). *out is malloc'd (free it with free,
// each value with op_free); *count 0 when the path has none.
int tp_history_cells(tp_history *h, const char *node, const char *part, const op_key *path, size_t length,
	tp_version **out, size_t *count);

#endif
