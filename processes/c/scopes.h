// Scope nodes (typescript/scopes.ts), in C: each scope's node, an id of its own beside the
// scheduler's scope. nothing saves it today (nothing saved reaches it). a process's value, its
// status and its pin are written there. at the scope's teardown its node's entries go, as table
// events, so whoever read them is told. which node a scope has, for a lookup up a write's frames: its own
// PL_NODE pair (places.h), given as it is made; this is only the teardown. a memo's or effect's
// node is the api's: a computer's teardowns run after each of its runs, so its node's entries are
// the api's to take out. Same rules as scopes.ts, which the suite in
// processes/conformance/processes/ holds both to.
//
// the scheduler includes no table, so the map is kept here, beside it.
// core candidate: the scheduler's teardown could take a PL_NODE pair's entries, instead of a map and
// a teardown registered from outside
#ifndef SCOPES_H
#define SCOPES_H

#include "../../reactivity/c/scheduler.h"
#include "../../graph/c/table.h"

typedef struct sn sn;

// the scope nodes of a scheduler and a table, both outliving it
sn *sn_new(sc_scheduler *scheduler, tb_table *table);
// frees the map; not the table's entries, and teardowns still waiting must not run after it
void sn_free(sn *s);

// the scope's node id, made the first time (id, or "scope:<random hex>" when NULL); the same after,
// whatever id is. A scope already gone: NULL. Registers the teardown that takes the node's entries. Good until the scope's teardown
const char *sn_give(sn *s, sc_scope *scope, const char *id);

#endif
