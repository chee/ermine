// The keyed index of typescript/selector.ts, in C; prefix sx_.
//
// the index: one mark listener and one tracking-end listener per scheduler, however many holders
// there are, each told only the marks (and ends) of the keys it holds. A holder that listened to the
// scheduler itself would hear every mark; here a mark costs the keys it names.
//
//   sx_index *x = sx_index_get(scheduler);   // made the first time, shared after; counted
//   sx_hold(x, key, &holder);                // holder.marked hears the marks of key from now
//   sx_drop(x, key, &holder);                // no more
//   sx_index_put(x);                         // before sc_free: the last put takes its listeners away
//
// a holder drops every key it holds before it goes (the index keeps its pointer).
#ifndef SELECTOR_H
#define SELECTOR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "scheduler.h"

typedef struct sx_index sx_index;

typedef struct sx_holder {
	// the keys of a mark that this holder holds, in the mark's order, good for the call; the run and the tick
	void (*marked)(void *data, const void *const *keys, size_t nkeys, sc_run *run, uint64_t tick);
	// a held key nobody tracks any more (dropping it is the holder's own). NULL: not told
	void (*ended)(void *data, const void *key);
	void *data;
} sx_holder;

sx_index *sx_index_get(sc_scheduler *s);
void sx_index_put(sx_index *x);
// h hears the marks and ends of key (holding the same pair twice: nothing). h is the caller's, kept
void sx_hold(sx_index *x, const void *key, const sx_holder *h);
void sx_drop(sx_index *x, const void *key, const sx_holder *h);

#endif
