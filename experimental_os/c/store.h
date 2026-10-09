// store.h: the SD card. What the graph keeps (GRAPH.tex Nodes: its ordinary
// nodes, their slots without ephemeral ids, and the highest time) is one
// CBOR file in the card's folder, graph.cbor, written whole to graph.cbor.new
// and renamed over it, so the card always holds the last whole save.

#ifndef ERMOS_STORE_H
#define ERMOS_STORE_H

#include "../../core/graph/c/ermine.h"

/** what the card holds, for ermGraph(root, restored); NULL when it holds nothing, with why when it could not be read */
ErmSaved *storeLoad(const char *folder, const char **why);
/** writes what the graph keeps; false, with why, when it could not */
bool storeSave(const char *folder, ErmInterface graph, const char **why);

#endif
