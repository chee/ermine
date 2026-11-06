// Scope nodes (typescript/scopes.ts) in C. The scheduler includes no table, so the map is kept here.
#ifndef SCOPES_H
#define SCOPES_H

#include "../../../core/reactivity/c/scheduler.h"
#include "../../../core/graph/c/table.h"
#include "../../../core/places/c/places.h"

typedef struct sn sn;

sn *sn_new(sc_scheduler *scheduler, tb_table *table, pl *places);
void sn_free(sn *s);

// The scope's node id, made the first time ("scope:<random hex>" when id is NULL). NULL if the scope is gone.
const char *sn_give(sn *s, sc_scope *scope, const char *id);

#endif
