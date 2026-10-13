// order: what runs next. the due, each at the tick it became due; and the ranks (rank.h), kept,
// made again only where what some computation is after changed.
//
// a computation is after: the writers of the keys its last run read (values), and the one it
// waits after (after). the scheduler says when those change (sees, waits), and when one is made
// and goes; order changes nothing else of a computation.
#ifndef ORDER_H
#define ORDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ptrmap.h"

typedef struct od_item od_item;
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
	size_t named;
	size_t slot;
	size_t index;
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

// the due computation to run: not waiting after a due one; lowest rank, then earliest made due,
// then the order made. at least one is due
od_item *od_next(order *o, int *rank);

void od_started(order *o, od_item *p);
// the writers p's run read: p->values becomes next, which order then holds (and frees)
void od_sees(order *o, od_item *p, pm *next);
// p waits after q (NULL: nothing)
void od_waits(order *o, od_item *p, od_item *q);
// p goes: not due, out of the ranks, after nothing
void od_gone(order *o, od_item *p);

#endif
