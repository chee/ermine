// Scope nodes (typescript/scopes.ts), in C: each scope's node, an id of its own beside the scheduler's
// scope, never saved (nothing saved reaches it). a process's value, its status and its pin are written
// there. a computer is a scope, so it can have one too, but its status node is status.h's own. at the
// scope's teardown its node's entries go, as table events, so whoever read them is told. Same rules as
// scopes.ts, which the suite in ermine/processes/conformance/processes/ holds both to.
//
// the scheduler knows no table, so the map is kept here, beside it.
// core candidate: a scope could carry its node's id itself (as a computer could), and the
// scheduler's teardown take its entries, instead of a map and a teardown registered from outside
#ifndef SCOPES_H
#define SCOPES_H

#include "../../../core/scheduler/c/scheduler.h"
#include "../../../core/table/c/table.h"

typedef struct sn sn;

// the scope nodes of a scheduler and a table, both outliving it
sn *sn_new(sc_scheduler *scheduler, tb_table *table);
// frees the map; not the table's entries, and teardowns still waiting must not run after it
void sn_free(sn *s);

// the scope's node id, made the first time (id, or "scope:<random hex>" when NULL); the same after,
// whatever id is. A scope already gone: NULL. Registers the teardown that takes the node's entries. Good until the scope's teardown
const char *sn_give(sn *s, sc_scope *scope, const char *id);
// the scope's own node; none: NULL
const char *sn_node_of(const sn *s, const sc_scope *scope);
// the node of the scope, or of the nearest scope above it that has one: whose a computer's run is,
// inside a process. none, or scope NULL: NULL
const char *sn_nearest(const sn *s, const sc_scope *scope);

#endif
