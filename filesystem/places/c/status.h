// Status (typescript/status.ts), in C: a computer's status on its own node, in a table of its own
// ("status", not the node's attributes), under the key ermine.computer.status. Same rules as
// status.ts, which the suite in
// filesystem/places/conformance/places/ (28-status.json) holds both to.
//
// The attribute holds the pending stand-in while a run is pending, an error when one failed (a loop gives the
// error "looping"), and is gone when a run is done. A stopped run leaves it as it was. It is
// written from the scheduler's run end (sc_on_run_end), with the computer's scope open
// (sc_run_with_scope). An effect's act that fails (sc_on_effect) writes its error the same way; a
// run done leaves that, until an act succeeds and takes it away. What was thrown is a string in C
// (the scheduler's), where status.ts keeps the thrown value itself. Nothing is written when the status is already so: pending again is not
// written; an error always is, as in the reference an error is a new one each time.
//
// VALUES. C has no Error or Symbol, so the two are stand-ins (value.h): pending is the stand-in of
// the string "ermine.pending", an error the stand-in of {"name": "Error", "message": text}.
// cst_is_pending and cst_error say which a value is.
//
// MEMORY. A status keeps the places, table and scheduler as given, a copy of each id given, and
// the nodes it made (let go of at cst_free; free it after the table, as nodes are). The computers
// given are kept by address: a computer gone and its address reused would be given the same node.
// Out of memory aborts.
#ifndef PLACES_STATUS_H
#define PLACES_STATUS_H

#include "places.h"

typedef struct cst cst;

typedef struct {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
} cst_setup;

// the table, and the key in its entry
#define CST_TABLE "status"
#define CST_ATTRIBUTE "ermine.computer.status"

// listens to the scheduler's run end and effects from here on
cst *cst_new(const cst_setup *setup);
// the node a computer's status is written on; id copied
void cst_give(cst *s, sc_computer *c, tb_key id);
// stop listening
void cst_stop(cst *s);
// stops, and lets go of everything it made
void cst_free(cst *s);

// a computer's status, by its node's id, the read told: pending, an error (cst_error), or NULL.
// Borrowed from the table
const op_value *cst_status(pl *p, tb_key id);
// whether a computer's run is pending, by its node's id, the read told
int cst_pending(pl *p, tb_key id);
// whether a status value is pending; an error's message, or NULL if it is no error
int cst_is_pending(const op_value *status);
const char *cst_error(const op_value *status);

#endif
