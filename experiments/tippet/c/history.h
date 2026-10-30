// History in C (see typescript/history.ts): a log tied to the C graph. The recorder turns writes
// kept
// here into steps; the lander writes steps from elsewhere into the graph.
// History's own memory goes through tp_mem; what it writes into the graph is malloc'd.
#ifndef TIPPET_HISTORY_H
#define TIPPET_HISTORY_H

#include "../../../places/c/places.h"
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
	int forgets;
	long rebase; // how many of each entry's newest steps hold what undoes them: 0 the default (256), negative none. forgets: none
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

// One of an entry's values (the merge of every head if device is NULL). The caller frees it with
// op_free.
typedef struct {
	op_value *value;
	const uint8_t *device;
	uint64_t n;
} tp_version;
#define TP_VERSIONS 17
size_t tp_history_versions(tp_history *h, const char *node, const char *part, tp_version out[TP_VERSIONS]);
size_t tp_history_heads(const tp_history *h, const char *node, const char *part, size_t i,
	const uint8_t **device, uint64_t *n);

#endif
