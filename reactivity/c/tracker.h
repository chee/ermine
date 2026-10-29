// The trackgraph (newcore/trackgraph/TRACKGRAPH.tex), in C. Same shape as trackgraph.ts.
#ifndef TRACKER_H
#define TRACKER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct tg_node tg_node;
typedef struct tg_link tg_link;

// one edge, in two lists: from's reads (next; shift's), and to's readers (before, after; the
// order made)
struct tg_link {
	tg_node *from;
	tg_node *to;
	tg_link *next;
	tg_link *before;
	tg_link *after;
	uint64_t gen;
};

// links may repeat: a reader can have two links to one spot (see tg_track).
// the node is 56 bytes (owner, reads, cursor, gen, first, last, open).
// owner: the caller's, never read here
// cursor: the last link this run confirmed; outside a run, the last link (after tg_leave: the
// last its run confirmed, the ones it did not reach after it, old, till tg_trim)
// gen: the tick its latest run began at; 0 before any. open: in a run
// first, last: the readers' list
struct tg_node {
	void *owner;
	tg_link *reads;
	tg_link *cursor;
	uint64_t gen;
	tg_link *first;
	tg_link *last;
	bool open;
};

// a node, kept by the caller; NULL when out of memory
tg_node *tg_node_new(void *owner);
// frees a node; untrack it first, and every reader of it, or links are left pointing at it
void tg_node_free(tg_node *n);

// outside a run; returns 0, or -2 in a run (nothing changed)
int tg_begin(tg_node *f);
// in a run; returns 0, or -1 when out of memory (nothing changed)
int tg_track(tg_node *f, tg_node *t);
// in a run: what it did not read again is dropped (tg_leave, then tg_trim)
void tg_end(tg_node *f);
// in a run: it ends, no link dropped, the ones it did not reach after the cursor, old
void tg_leave(tg_node *f);
// outside a run: the run left goes on (a paused step's next): open again, its tick and cursor as
// tg_leave left them, so its reads go on after the ones it made before. returns 0, or -2 in a run
int tg_resume(tg_node *f);
// a link from an earlier run that the latest run did not read: old (its run over). the next run
// reading it takes it back; tg_trim lets the old ones go when a run is done
bool tg_old(const tg_link *l);
// outside a run: the links after the cursor (all, with no cursor) are dropped
void tg_trim(tg_node *f);
// outside a run: the links after the cursor stay, but one to a spot linked before it, or after it
// already, is dropped (a run left with its reads in a new order piles up no repeats)
void tg_dedupe(tg_node *f);
// outside a run; returns 0, -1 when out of memory, or -2 in a run (nothing changed)
int tg_add(tg_node *f, tg_node *t);
// t NULL: all of f's; else every link of f's to t
void tg_untrack(tg_node *f, tg_node *t);

// what f reads: walk f->reads by ->next, each link's ->to
// who reads t, in the order made: walk t->first by ->after, each link's ->from

#endif
