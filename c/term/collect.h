// collect.h: freeing what the graph no longer needs (NOTES.md, Memory).
//
// c/ frees nothing it has handed on (c/NOTES.md, Memory), so a host that
// writes a screen 60 times a second grows. The graph keeps, of a node, only
// its value and the change that last set it; once a later write replaces
// them, what the earlier write was made of is garbage, unless something
// else holds it. The collector frees it for writes to ephemeral nodes made
// from trees it is handed (the pty loader's frames, a speaker's request
// lines): after each such write, what the node's earlier writes and earlier
// value hold that the new value and the new write do not reach is freed, and
// so are the earlier writes' change records. A value the node held before
// the collector first saw it (the one its placement gave it, which the
// placement's change still names), or one an untracked write put there, is
// never freed.
//
// While a speaker that polls holds events of the node not yet taken (they
// share its changes' patches and its values), nothing of the node's is
// freed; it waits for the next write after.

#ifndef TERM_COLLECT_H
#define TERM_COLLECT_H

#include "../ermine.h"

/** frees each value reachable from `old` that is not reachable from `keep`, each once; how many it freed */
size_t jsonSweep(Json *const *old, int oldCount, Json *const *keep, int keepCount);

/**
 * frees an answer the caller made and has printed: every container and
 * scalar in it, except what is under a key "value", "agent", "cause",
 * "patches" or "seq", which an answer shares with the graph or the request
 */
void jsonFreeAnswer(Json *answer);

/** frees the lists an operation's result holds (not the values or ids they name) */
void ermResultFree(ErmResult *out);

typedef struct Collector Collector;

/** `holding`: whether anything holds events that share the node's changes or values (a speaker that polls, with events not yet taken) */
Collector *collectorNew(ErmInterface graph, bool (*holding)(void *data, const char *node), void *data);

/** what the node an address reaches held before a write */
typedef struct Before {
	Json *value;
	const ErmChange *change;
	bool known; // the address reached one node, ephemeral
} Before;

Before collectBefore(Collector *collector, const ErmCtx *ctx, const ErmAddress *address);

/**
 * After a write to the node `before` was read from: when the write was
 * made (the node's change is another), the collector takes `tree`, what the
 * write was made of, and true is returned; it then frees what the node's
 * earlier writes left that nothing reaches now. False: the caller keeps it.
 */
bool collectAfter(Collector *collector, const ErmCtx *ctx, const ErmAddress *address, Before before, Json *tree);

/** the node has gone (let go when its process was killed): what its writes left is freed */
void collectForget(Collector *collector, const char *node);

/** how many values it has freed, for tests */
size_t collectFreed(const Collector *collector);

#endif
