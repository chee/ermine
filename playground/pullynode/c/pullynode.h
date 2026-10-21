// Pullynode (typescript/pullynode.ts), in C: nodes whose value is made only while something reads
// it. A provider is given a node's id; the first run to read the node wakes it (start), the last to
// stop reading puts it to sleep (start's stop). Built on the scheduler's tracking start and end and
// places' pl_spot alone. Same rules as pullynode.ts, which the suite in
// playground/pullynode/conformance/pullynode/ holds both to; read the rules there (what wakes it,
// what a reader gets, when).
//
//   pul *pn = pul_new(&(pul_setup){places, table, scheduler});
//   pul_node *node = pul_provide(pn, "N", &provider, NULL, 0);   // NULL: "N" has one already
//   sc_pulse(scheduler); pul_flush(pn);                          // after each pulse
//   pul_check(pn, "N", done, ctx);                               // from outside a run
//   pul_stop(pn);                                                // every provider stopped (a reload)
//
// The one difference from the TypeScript: C's scheduler has no onAfterPulse. pul_flush is what the
// TS runs at a pulse's end: the host calls it after each sc_pulse (and nowhere else; it settles what
// runs read or stopped reading, and does nothing while a run is open). A host that forgets it wakes
// and stops nothing that a run's reads decided.
//
// The status attribute (PUL_STATUS) of the node: "asleep", "waking", "awake".
//
// VALUES. A write is op patches, as nd_update takes them: pul_write copies the patch array, its
// keys and strings, and holds the values (op_ref); the node's change refers to the copy until its
// next update. A provider's once gives a value borrowed (kept alive by the provider while the
// check runs); it is held the same way. A value given to done is borrowed: good for the call.
//
// WRITES. Made under a root scope of the info given to pul_provide (default: actor, the id as an
// op string, owned here). The pairs are copied, their keys and values borrowed and kept alive by
// the caller as long as the scheduler (a scope's info lasts to sc_free). A write that op refuses
// (a patch that does not apply) changes nothing and is the code (op_code_name): pul_write gives it
// to the provider, where the TS write throws.
//
// CHECK. C has no promises. With once, done is called at once, with its value or its error; awake,
// or running for a reader, at once with the value there; otherwise the provider is started and done
// is called at its first write (after that write's own work), then it is stopped again unless a
// reader came meanwhile. A check whose provider is let go before its first write never calls done.
//
// MEMORY. Keeps the places, table and scheduler as given, a copy of each id and of the pairs. A
// pul_node (and so its writer) lives until pul_free, stopped or not: a handle may be used again
// after pul_unprovide or pul_stop (a no-op). pul_stop first, while the scheduler is alive: it takes
// the listeners off and lets go of the runs it holds (sc_run_ref); pul_free after, once the
// scheduler may be gone. Out of memory aborts.
#ifndef PULLYNODE_H
#define PULLYNODE_H

#include <stdbool.h>
#include <stddef.h>

#include "../../../filesystem/places/c/places.h"

#define PUL_STATUS "ermine.provider.status"

typedef struct pul pul;
// a provided node: what pul_provide gives, and what start is handed to write through
typedef struct pul_node pul_node;
typedef pul_node pul_writer;

typedef struct {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
} pul_setup;

// what stops a started provider: f(ctx), if f is not NULL
typedef struct {
	void (*f)(void *ctx);
	void *ctx;
} pul_off;

typedef struct {
	// the first reader came: make the value, writing it through pul_write on writer, till the
	// stop given back is called. woke: the run whose read woke it (its computer: who wanted it),
	// borrowed for the call; NULL for a check
	pul_off (*start)(pul_writer *write, sc_run *woke, void *data);
	// a check, with no reader: the value now, nothing kept running. 0 and *value (NULL: null); or an
	// error, a fresh string the caller frees. NULL: none, a check starts it, takes its first write and
	// stops it
	char *(*once)(void *data, const op_value **value);
	void *data;
} pul_provider;

pul *pul_new(const pul_setup *setup);
// id's value made by provider from here on (the struct is copied); info: n pairs, the scope its
// writes are made under (NULL, n 0: actor, the id). NULL: id has a provider already
pul_node *pul_provide(pul *pn, const char *id, const pul_provider *provider, const sc_pair *info, size_t n);
// stopped if running (then asleep), and let go; a second call, or one after pul_stop, does nothing
void pul_unprovide(pul_node *node);
// patches to the node's value, from a provider's start or after: 0, or op's code (nothing
// written). Does nothing once the node is let go
int pul_write(pul_writer *write, const op_patch *patches, size_t n);

// the value of id now, asked from outside a run. error: NULL, or the message (borrowed, for the call)
typedef void (*pul_done)(void *ctx, const op_value *value, const char *error);
void pul_check(pul *pn, const char *id, pul_done done, void *ctx);
// whether a run reads it now
bool pul_reading(pul *pn, const char *id);
// the host's, after each sc_pulse: what runs read or stopped reading is settled
void pul_flush(pul *pn);
// every provider stopped, the listeners off
void pul_stop(pul *pn);
void pul_free(pul *pn);

#endif
