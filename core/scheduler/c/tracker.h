// The trackgraph (newcore/trackgraph/TRACKGRAPH.tex), in C. Same shape as trackgraph.ts.
#ifndef TRACKER_H
#define TRACKER_H

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

// owner: the caller's, never read here
// cursor: the last link this run confirmed; outside a run, the last link
// gen: the tick this node's run began at; 0 outside a run
// kept: gen, once the run has confirmed a link in order
// touched: the tick of the last link made to this node
// first, last: the readers' list
struct tg_node {
	void *owner;
	tg_link *reads;
	tg_link *cursor;
	uint64_t gen;
	uint64_t kept;
	uint64_t touched;
	tg_link *first;
	tg_link *last;
};

// a node, kept by the caller; NULL when out of memory
tg_node *tg_node_new(void *owner);
// frees a node; untrack it first, and every reader of it, or links are left pointing at it
void tg_node_free(tg_node *n);

void tg_begin(tg_node *f);
// in a run; returns 0, or -1 when out of memory (nothing changed)
int tg_track(tg_node *f, tg_node *t);
void tg_end(tg_node *f);
// outside a run; returns 0, -1 when out of memory, or -2 in a run (nothing changed)
int tg_add(tg_node *f, tg_node *t);
// t NULL: all of f's
void tg_untrack(tg_node *f, tg_node *t);

// what f reads: walk f->reads by ->next, each link's ->to
// who reads t, in the order made: walk t->first by ->after, each link's ->from

#endif
