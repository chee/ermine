// sync's side of the graph (WIRING.tex), in C. Same shape as wiring.ts: each record a change made goes out
// (COMMIT.tex), taken in to its histories at once, and sealed, stored and sent after; each blop taken in from
// elsewhere comes in (APPLY.tex) as its object's versions. There is no graph `changed` or `versions` to wire
// to now: a record is what the host makes of a fact places told a watch (wiring.ts's fromFact), and versions is
// the host's callback.
//
// Sans-IO as the transport is: there is no promise to await, so what comes after the taking in (sealing,
// storing, sending) waits until wiring_idle runs it, in the order made: a blop's parents are stored before it.
// Memory: what a record makes (its change and blop) is let go of once taken in; the transport keeps the
// blop decoded, the histories what they need. What versions is handed (actors, causes, sites, the versions'
// contents) is borrowed for the call: the host copies or holds what it keeps.
#ifndef WIRING_H
#define WIRING_H

#include "apply.h"
#include "commit.h"
#include "seal.h"
#include "transport.h"

#include <stdbool.h>
#include <stddef.h>

typedef struct wiring wiring;

// which object of a node: its value, or an info or children entry by name
typedef enum { WIRING_VALUE, WIRING_INFO, WIRING_CHILDREN } wiring_where;
// which version it is made at: a version (from), a span [from, to), or versions popped (COMMIT.tex)
typedef enum { WIRING_AT_VERSION, WIRING_AT_SPAN, WIRING_AT_POP } wiring_at;

// a change made. The header is node.h's: the actor and cause are `const Json *`, the first external its
// site, and the metadata entries named "cause" (a `const Json *`), "wallclock" (a `const int64_t *`) and
// "message" (a `const char *`) are what the blop carries of those (apply.h says the same of a version's)
typedef struct {
	const char *node;
	wiring_where where;
	const char *name; // an info or children name; NULL for the value
	const op_patch *patches;
	size_t patch_count;
	ch_header header;
	wiring_at at;
	long from, to; // a version's: from, to from + 1
	int ephemeral;
} wiring_record;

// the header and signer of a blop just taken in
typedef struct {
	const Json *actor, *site, *cause;
	const char *reader;
	int has_wallclock;
	int64_t wallclock;
	const char *message;
	const char *signer, *name; // 64 lowercase hex digits
} wiring_from;

typedef struct {
	// the host's: given an object's versions after a blop just taken in (WIRING.tex, In); context is its own
	void (*versions)(void *context, const char *node, wiring_where where, const char *name,
		const apply_version *list, size_t count, const wiring_from *from);
	void *context;
	// the host's: sealing, and the nonce of each blop (called once per blop made)
	seal_signer signer;
	commit_random random;
	void *random_context;
	// the source roots a site is made shareable against (COMMIT.tex); none: NULL, 0
	const char *const *roots;
	size_t root_count;
} wiring_options;

// wired to the device: it is told each blop arriving (transport_arrived)
wiring *wiring_create(transport *t, const wiring_options *options);
void wiring_free(wiring *w);
// a change made: commits the record, takes its blop in at once, makes its object's versions; sealing,
// storing and sending come after
void wiring_changed(wiring *w, const wiring_record *record);
// does what is left of sealing, storing and sending, in the order made: true if it did any
bool wiring_idle(wiring *w);
// a thing that went wrong in changed, in an arrival or in idle, once each, the first first; or NULL
const char *wiring_trouble(wiring *w);

#endif
