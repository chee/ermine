// Each computer's latest run, in C (typescript/runs.ts), keyed by the computer's node id. Records are
// borrowed until that computer's next record is written or it is dropped. Out of memory aborts.
#ifndef PROCESSES_RUNS_H
#define PROCESSES_RUNS_H

#include "../../places/c/places.h"

typedef struct crn crn;

typedef struct {
	int named;
	const void *key;
	char *part, *id;
	int spot;
	op_key *path;
	size_t npath;
	int keys;
	op_value *change;
} crn_saw;

typedef struct {
	char *part, *id;
	op_value *change;
} crn_wrote;

typedef struct {
	size_t refs;
	crn_saw *items;
	size_t n;
} crn_reads;
typedef struct {
	size_t refs;
	crn_wrote *items;
	size_t n;
} crn_writes;

typedef struct {
	unsigned n;
	ch_frame *frame;
	int has_started;
	double started, ended;
	const char *end;
	char *error;
	int act;
	char *act_error;
	const crn_reads *reads;
	const crn_writes *writes;
} crn_run;

enum { CRN_ACT_NONE, CRN_ACT_DONE, CRN_ACT_FAILED };

typedef enum {
	CRN_N,
	CRN_FRAME,
	CRN_STARTED,
	CRN_ENDED,
	CRN_END,
	CRN_ERROR,
	CRN_ACT,
	CRN_READS,
	CRN_WRITES,
	CRN_ALL
} crn_field;

// take holds run, as given or as the hook changed it; if not called, the record is released. Good only during the call.
typedef void (*crn_take)(void *taking);
typedef void (*crn_hold)(void *ctx, tb_key id, crn_run *run, crn_take take, void *taking);

typedef struct {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	crn_hold hold;
	void *hold_ctx;
} crn_setup;

crn *crn_new(const crn_setup *setup);
void crn_give(crn *r, sc_computer *c, tb_key id);
// The policy asked before a read; 0 allows, anything else is returned by crn_read.
typedef int (*crn_ask)(void *ctx, tb_key id, const char **op, const char **reason);
#define CRN_STOP (-1)

// A computer's latest run in *out (NULL when none), or one field of it. CRN_STOP means the run must end.
int crn_read(crn *r, crn_ask ask, void *ctx, tb_key id, crn_field field, const crn_run **out,
	const char **op, const char **reason);
void crn_drop(crn *r, tb_key id);
void crn_stop(crn *r);
void crn_free(crn *r);

#endif
