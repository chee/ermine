// the scheduler's on... listeners as one list, in order (typescript/trace.ts): what happened, for a
// recorder, an inspector or a test. due: a computer made due, by the run of the mark (by: its
// computer). a run's reads are kept while this listens. header only; the sc_trace is the caller's
// and stays where it is until sc_trace_stop
#ifndef SCHEDULER_TRACE_H
#define SCHEDULER_TRACE_H

#include "scheduler.h"

typedef enum { SC_T_DUE, SC_T_STARTS, SC_T_ENDS, SC_T_ACTS } sc_told_kind;

// one thing that happened, good for the call
typedef struct sc_told {
	sc_told_kind kind;
	sc_computer *c;
	// SC_T_DUE; by: the computer of the run that made the change, NULL when not told
	uint64_t tick;
	sc_computer *by;
	// SC_T_STARTS, SC_T_ENDS, SC_T_ACTS
	unsigned run;
	// SC_T_STARTS
	int rank;
	// SC_T_ENDS
	sc_ended ended;
	// -1: none, else 0 or 1
	int equal;
	// SC_T_ENDS, SC_T_ACTS: NULL for none
	const char *error;
	// SC_T_ACTS: an early effect's act
	bool early;
	// SC_T_ENDS stopped: the computer it waits after
	sc_computer *waits;
	// SC_T_ENDS looping: the computers on the loop, in the order made
	sc_computer *const *through;
	size_t nthrough;
	// SC_T_ENDS: every key the run tracked, in order
	const void *const *reads;
	size_t nreads;
} sc_told;

typedef struct sc_trace {
	void (*f)(const sc_told *told, void *data);
	void *data;
	sc_listener *on[4];
} sc_trace;

static inline void sc_trace_mark(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due,
	size_t ndue, uint64_t tick, void *data) {
	(void)keys, (void)nkeys;
	sc_trace *t = data;
	for (size_t i = 0; i < ndue; i++)
		t->f(&(sc_told){.kind = SC_T_DUE, .c = due[i], .tick = tick, .by = run ? sc_run_computer(run) : NULL, .equal = -1},
			t->data);
}
static inline void sc_trace_start_run(sc_computer *c, unsigned n, int rank, void *data) {
	sc_trace *t = data;
	t->f(&(sc_told){.kind = SC_T_STARTS, .c = c, .run = n, .rank = rank, .equal = -1}, t->data);
}
static inline void sc_trace_end_run(sc_computer *c, unsigned n, sc_ended ended, const void *const *reads,
	size_t nreads, const sc_more *more, void *data) {
	sc_trace *t = data;
	t->f(&(sc_told){.kind = SC_T_ENDS,
		.c = c,
		.run = n,
		.ended = ended,
		.equal = more->equal,
		.error = more->error,
		.waits = more->waits,
		.through = more->through,
		.nthrough = more->nthrough,
		.reads = reads,
		.nreads = nreads},
		t->data);
}
static inline void sc_trace_effect(sc_computer *c, unsigned n, const char *error, void *data) {
	sc_trace *t = data;
	t->f(&(sc_told){.kind = SC_T_ACTS, .c = c, .run = n, .error = error, .early = sc_scope_early(c), .equal = -1},
		t->data);
}

// f told each, in order
static inline void sc_trace_start(sc_scheduler *s, sc_trace *t, void (*f)(const sc_told *, void *),
	void *data) {
	t->f = f;
	t->data = data;
	t->on[0] = sc_on_mark(s, sc_trace_mark, t);
	t->on[1] = sc_on_run_start(s, sc_trace_start_run, t);
	t->on[2] = sc_on_run_end(s, sc_trace_end_run, t);
	t->on[3] = sc_on_effect(s, sc_trace_effect, t);
}

static inline void sc_trace_stop(sc_trace *t) {
	for (int i = 0; i < 4; i++) sc_remove_listener(t->on[i]);
}

#endif
