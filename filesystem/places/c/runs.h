// Runs (typescript/runs.ts), in C: a computer's latest run on its own node, in the attribute
// ermine.computer.run, beside status.h's. Same rules as runs.ts, which the suite in
// filesystem/places/conformance/places/ (34-runs.json) holds both to.
//
// The record, a map: n, started (none when it was given while it ran), ended (milliseconds since
// 1970, fractional, CLOCK_REALTIME), end ("done", "pending", "failed", "looping"), error (failed
// and looping), reads, writes. A read named by pl_spot: {part, id, path (null: the change spot),
// keys (true: a keys read), change}, change the change of the node there as the run ended (none
// there: no change); a key places can't name: null (C has no value for a pointer). A write:
// {part, id, change} (a table event taking it out: no change). Written from the scheduler's run
// end, and after an effect's act that wrote (sc_on_effect), with the computer's scope open
// (sc_run_with_scope): a patch for each field that differs; error, whenever there is one (a new
// error each time, as runs.ts). A stopped run writes nothing; a run that read a record writes none.
// A write is the run's when it lands (pl_watch_all) with the run open (sc_get_run).
//
// VALUES. A change is a map of the header's pieces: time, actor, reader, external (each {file,
// line, column?, function?}), metadata ([key, value].., the values held, as places.h makes them
// op_values); not its op. Where runs.ts compares changes by identity, this compares them as values:
// two changes alike in every piece are the same (two writes in one second by one scope, unlikely).
// An error is status.h's stand-in, {"name": "Error", "message": text}.
//
// MEMORY. Keeps the places, table and scheduler as given, a copy of each id given, the nodes it
// made (let go of at crn_free; free it after the table, as nodes are) and each computer's writes
// so far. Computers are kept by address, as status.h. Out of memory aborts.
#ifndef PLACES_RUNS_H
#define PLACES_RUNS_H

#include "places.h"

typedef struct crn crn;

typedef struct {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
} crn_setup;

// the attribute
#define CRN_ATTRIBUTE "ermine.computer.run"

// listens to the scheduler's run start and end and effects, and to every write, from here on
crn *crn_new(const crn_setup *setup);
// the node a computer's run is written on; id copied
void crn_give(crn *r, sc_computer *c, tb_key id);
// stop listening
void crn_stop(crn *r);
// stops, and lets go of everything it made
void crn_free(crn *r);

// a computer's latest run, by its node's id, the read told; none: NULL. Borrowed from the table
const op_value *crn_latest(pl *p, tb_key id);

#endif
