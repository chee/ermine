// What runs next: the due computations (each at the tick it became due) and their ranks, made
// in full once (see rank.h) and then mended where an edge changed. Ranks only rise.
//
// A computation is after the writers of the keys its last run read (values) and the one it
// waits after (after). The scheduler reports changes to these through od_sees and od_waits.
#ifndef ORDER_H
#define ORDER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../changeable/c/ptrmap.h"

typedef struct od_item od_item;
struct od_item {
	void *owner;
	uint64_t n;
	// The writers its last run read, a set of od_item (NULL or empty when none).
	pm *values;
	od_item *after;
	// Set by the scheduler; false once the item starts to go.
	bool alive;
	bool due;
	uint64_t mark;
	int rank;
	uint64_t rank_epoch;
	// Set when in a component of more than one at the ranks of this epoch.
	uint64_t member_epoch;
	uint64_t stamp;
	// What is after it, with the number of edges as the value.
	pm rev;
	size_t slot;
	size_t index;
};

typedef struct order order;

order *od_new(void);
void od_free(order *o);

bool od_has(const order *o, const od_item *p);
uint64_t od_at(const od_item *p);
void od_set(order *o, od_item *p, uint64_t mark);
void od_delete(order *o, od_item *p);
size_t od_size(const order *o);
// p's rank, making the ranks first if they are stale.
int od_rank(order *o, const od_item *p);

// The due computation to run: one not waiting after a due one, with the lowest rank, then the
// earliest made due, then the order made. At least one must be due.
od_item *od_next(order *o, int *rank);

void od_started(order *o, od_item *p);
// p's run read the writers in next; p->values becomes next, which order then owns and frees.
void od_sees(order *o, od_item *p, pm *next);
// p waits after q (NULL for nothing).
void od_waits(order *o, od_item *p, od_item *q);
// p has gone: not due, not ranked, after nothing, and nothing is after it. order forgets p so its
// memory may be freed. od_sees and od_waits must not be given a gone item as an edge.
void od_gone(order *o, od_item *p);

#endif
