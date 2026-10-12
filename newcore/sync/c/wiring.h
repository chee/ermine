// sync's side of the graph (newcore/sync/WIRING.tex), in C. Same shape as wiring.ts: each record a
// change made goes out (COMMIT.tex), taken in to its chains at once, and sealed, stored and sent after;
// each blop taken in from elsewhere comes in (APPLY.tex) as its object's versions. The graph's `changed`
// is wiring_changed; the scheduler's versions (sc_versions) is given to it.
//
// Sans-IO as the transport is: there is no promise to await, so what comes after the taking in (sealing,
// storing, sending) waits until wiring_idle runs it, in the order made: a blop's parents are stored before it.
// Json values are never freed (json.h): what a record makes is kept as long as the process.
#ifndef WIRING_H
#define WIRING_H

#include "commit.h"
#include "seal.h"
#include "transport.h"

#include "../../graph/c/graph.h"

#include <stdbool.h>
#include <stddef.h>

typedef struct wiring wiring;

typedef struct {
	// the scheduler's internal versions (WIRING.tex, In), given its blop just taken in; context is its own
	void (*versions)(void *context, const char *node, gr_where where, const char *name,
		const gr_incoming *list, size_t count, const gr_from *from);
	void *context;
	// the host's: sealing, and the nonce of each blop (called once per blop made)
	seal_signer signer;
	commit_random random;
	void *random_context;
	// what versions is handed (actors, causes, sites) is made in it: it must outlive the graph (the scheduler's
	// sc_pr_arena)
	pr_arena *arena;
	// the source roots a site is made shareable against (COMMIT.tex); none: NULL, 0
	const char *const *roots;
	size_t root_count;
} wiring_options;

// wired to the device: it is told each blop arriving (transport_arrived)
wiring *wiring_create(transport *t, const wiring_options *options);
void wiring_free(wiring *w);
// the graph's changed (the scheduler's changed option): commits the record, takes its blop in at once, makes
// its object's versions; sealing, storing and sending come after
void wiring_changed(wiring *w, const gr_record *record);
// does what is left of sealing, storing and sending, in the order made: true if it did any
bool wiring_idle(wiring *w);
// a thing that went wrong in changed, in an arrival or in idle, once each, the first first; or NULL
const char *wiring_trouble(wiring *w);

#endif
