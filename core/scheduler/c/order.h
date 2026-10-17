// order: what runs next (typescript/order.ts). the due, each at the tick it became due; a due one
// runs once every due one above it ran (what it is after, and what that is after.., a cycle it
// is in aside); of those, the earliest due, then the oldest (made first). the ranks are how order
// finds what is above: made whole once (rank.h), then mended where an edge changed, only ever
// rising.
//
// a computation is after: the writers of the keys its last run read (values), and the one it
// waits after (after). the scheduler says when those change (sees, waits), and when one is made
// and goes; order changes nothing else of a computation.
//
// mending: a computation whose edges changed rises to one past the most of what it is after, if
// that is more than its rank now, and what is after it does the same, as far as a rank rises.
// a rank never falls (an edge gone, a computation gone: nothing lowered), so it is at least
// rank.h's, never less: still after everything it is after. a cycle (a component of more than
// one) is rank.h's alone, ranked over the part of the graph from the change on (local): when a
// mend reaches one of its members, a member goes, or a mend comes back round to where it began
// (a cycle made now). so one above another is ranked lower, unless they are one cycle, which
// shares a rank.
//
// above: a due one with a lower rank, reached walking up from it; nothing ranked under the lowest
// due rank has anything due above it, so the walk stops there. one found above is held: set
// aside on what was found, with the way down from it; when that one is no longer due, the first
// due one along the way holds it again, else it is looked at anew. an edge gone, or a cycle
// joined, lets every held one be looked at anew
#ifndef ORDER_H
#define ORDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ptrmap.h"

typedef struct od_item od_item;

// one held: by its hold's number, stale once it is held again or let go
typedef struct od_hold {
	od_item *p;
	uint64_t n;
} od_hold;

struct od_item {
	void *owner;
	// the order made
	uint64_t n;
	// the writers its last run read: a set of od_item, NULL when empty
	pm *values;
	od_item *after;
	// set by the scheduler: not alive after it starts to go
	bool alive;
	// order's own
	bool due;
	uint64_t mark;
	int rank;
	uint64_t rank_epoch;
	// in a component of more than one at the ranks of this epoch
	uint64_t member_epoch;
	// order's marks for a mend's start and a local ranking's region
	uint64_t stamp;
	// what is after it, by how many edges (a count in the value): the edges turned round
	pm rev;
	size_t slot;
	size_t index;
	// the rank it is counted at while due
	int counted;
	// a walk up's own: the walk it was reached in, and from what below
	uint64_t walked;
	od_item *via;
	// held (hold != 0, its number): due at hold_mark, while nothing let the held go since
	// (hold_loose), on the way down from way[way_at]
	uint64_t hold, hold_mark, hold_loose;
	od_item **way;
	size_t nway, capway, way_at;
	// those it holds
	od_hold *holding;
	size_t nholding, capholding;
};

typedef struct order order;

order *od_new(void);
void od_free(order *o);

bool od_has(const order *o, const od_item *p);
// the tick p became due at
uint64_t od_at(const od_item *p);
void od_set(order *o, od_item *p, uint64_t mark);
void od_delete(order *o, od_item *p);
size_t od_size(const order *o);
// p's rank (the ranks made, when they are not)
int od_rank(order *o, const od_item *p);

// the due computation to run: not waiting after a due one, nothing due above it; of those the
// earliest made due, then the oldest. at least one is due
od_item *od_next(order *o, int *rank);

void od_started(order *o, od_item *p);
// the writers p's run read: p->values becomes next, which order then holds (and frees)
void od_sees(order *o, od_item *p, pm *next);
// p waits after q (NULL: nothing)
void od_waits(order *o, od_item *p, od_item *q);
// p goes: not due, out of the ranks, after nothing
void od_gone(order *o, od_item *p);
// what order keeps on p let go, at the end (p itself is the caller's)
void od_item_free(od_item *p);

#endif
