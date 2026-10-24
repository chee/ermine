// Runs (typescript/runs.ts), in C: each computer's latest run, on a table of the runs' own (not
// the graph's table, not places'), by the computer's node id. Replaced each run, never saved. Same
// rules as runs.ts, which the suite in ermine/processes/conformance/runs/ holds both to.
//
// The record, a crn_run: n, started (none when it was given while it ran), ended (milliseconds
// since 1970, fractional, CLOCK_REALTIME), end ("done", "pending", "failed", "looping"), error
// (failed and looping: its message; a string, as C's scheduler tells what was thrown, where the
// TypeScript reference keeps the thrown value itself), act (an effect's, once its act ran after
// this run: CRN_ACT_DONE, or CRN_ACT_FAILED with act_error, its message; none until then), reads,
// writes. A read named by pl_spot: {part, id, path (spot: the change spot, no path), keys (a keys
// read), change}, change the change of the entry there as the run first read the key (a run that
// reads a node and then writes it names the change before its write; none there: NULL; a key
// tracked before the run was given: as the run ended); a key places can't name: unnamed. A write: {part,
// id, change} (a table event taking it out: no change). Written from the scheduler's run end, and
// after an effect's act that wrote (sc_on_effect). A stopped run writes nothing. A write is the
// run's when it lands (pl_watch_all) with the run open (sc_get_run).
//
// A run's end is a write to the runs' table (runs are writes): the fields that differ are marked,
// with the computer as the writer (its latest run, sc_latest): what reads a record is due after
// the computer, and a loop through records is the scheduler's to see, as any other. No table
// event, no header, no places commit. A rerun that read the same things (the same spots, the
// same changes) keeps the earlier record's reads, shared, as writes; so a reader of reads does
// not rerun.
//
// VALUES. A change is places' one value of a header (pl_change_value: {time, actor, reader,
// external, metadata}, not its op), held here with op_ref, never copied per read or per run; only
// a header places didn't make is built here, and compared as a value. Reads and writes are
// shared blocks, held by the records that name them.
//
// READS. crn_read asks the policy first (crn_ask) as reading the computer's node, then tracks
// one scheduler key a field, marked when that field changes. Records are borrowed: good until
// that computer's next record is written, or it is dropped.
//
// MEMORY. Keeps the places, table and scheduler as given, a copy of each id given, the records and
// their keys, and each computer's writes so far. Computers are kept by address. Out of memory
// aborts.
#ifndef PROCESSES_RUNS_H
#define PROCESSES_RUNS_H

#include "../../../filesystem/places/c/places.h"

typedef struct crn crn;

typedef struct {
	pl *places;
	// where a read's change is looked up
	tb_table *table;
	sc_scheduler *scheduler;
} crn_setup;

// a read, named
typedef struct {
	// 0: a key places can't name: only key is set (an identity, never read)
	int named;
	const void *key;
	// NULL: not strings
	char *part, *id;
	// 1: the change spot (no path)
	int spot;
	op_key *path;
	size_t npath;
	// a keys read
	int keys;
	// the entry's change as the run ended; NULL: no entry there
	op_value *change;
} crn_saw;

typedef struct {
	char *part, *id;
	// NULL: taken out
	op_value *change;
} crn_wrote;

// the blocks records share: held by refs
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
	// 0: given while it ran, its start not seen
	int has_started;
	double started, ended;
	// "done", "pending", "failed" or "looping"
	const char *end;
	// NULL: none
	char *error;
	// CRN_ACT_NONE, CRN_ACT_DONE or CRN_ACT_FAILED (then act_error, never NULL)
	int act;
	char *act_error;
	const crn_reads *reads;
	const crn_writes *writes;
} crn_run;

enum { CRN_ACT_NONE, CRN_ACT_DONE, CRN_ACT_FAILED };

typedef enum {
	CRN_N,
	CRN_STARTED,
	CRN_ENDED,
	CRN_END,
	CRN_ERROR,
	CRN_ACT,
	CRN_READS,
	CRN_WRITES,
	CRN_ALL
} crn_field;

// listens to the scheduler's run start and end and effects, and to every write, from here on
crn *crn_new(const crn_setup *setup);
// the computer's runs written by its node's id; id copied
void crn_give(crn *r, sc_computer *c, tb_key id);
// the policy asked before a read, as reading the node {id}: 0 allows, anything else is the answer
// given back by crn_read (for guard.h's gd_read: its gd_answer, *op and *reason what refused,
// borrowed from the policy). Not guard.h itself, so runs.c links no protect (protect's names no
// longer clash with start.h's: its free is pr_policy_free)
typedef int (*crn_ask)(void *ctx, tb_key id, const char **op, const char **reason);
// crn_read's answer when the run must end: a track said stop
#define CRN_STOP (-1)

// a computer's latest run in *out, or one field of it (it alone tracked; the rest of the record
// is there too, read what you asked for); none: *out NULL. ask (may be NULL) is asked first: what
// it answers but 0 is returned, nothing is tracked and *out is NULL (*op and *reason as it left
// them; either may be NULL). CRN_STOP: the run must end. 0: read
int crn_read(crn *r, crn_ask ask, void *ctx, tb_key id, crn_field field, const crn_run **out,
	const char **op, const char **reason);
// the node's record out (its computer gone), its readers told
void crn_drop(crn *r, tb_key id);
// stop listening
void crn_stop(crn *r);
// stops, and lets go of everything it made
void crn_free(crn *r);

#endif
