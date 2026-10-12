// The trackgraph (newcore/trackgraph/TRACKGRAPH.tex), in C. Same shape as trackgraph.ts.
#ifndef TRACKGRAPH_H
#define TRACKGRAPH_H

#include <stddef.h>
#include <stdint.h>

typedef struct tg_node tg_node;
typedef struct tg_link tg_link;

// one edge: in from's reads, a doubly linked list (shift's), and in to's readers, an array
struct tg_link {
	tg_node *from;
	tg_node *to;
	tg_link *prev;
	tg_link *next;
	size_t at;
	uint32_t gen;
};

// owner: the caller's, never read here
// cursor: the last link this run confirmed; outside a run, the last link
struct tg_node {
	void *owner;
	tg_link *reads;
	tg_link *cursor;
	uint32_t gen;
	tg_link **readers; // NULL entries are holes
	size_t length;
	size_t capacity;
	size_t holes;
};

// a node, kept by the caller; NULL when out of memory
tg_node *tg_node_new(void *owner);
// frees a node; untrack it first, and every reader of it, or links are left pointing at it
void tg_node_free(tg_node *n);

void tg_begin(tg_node *f);
// in a run; returns 0, or -1 when out of memory (nothing changed)
int tg_track(tg_node *f, tg_node *t);
void tg_end(tg_node *f);
// outside a run; returns 0, or -1 when out of memory (nothing changed)
int tg_add(tg_node *f, tg_node *t);
// t NULL: all of f's
void tg_untrack(tg_node *f, tg_node *t);

// what f reads: walk f->reads by ->next, each link's ->to
// who reads t, in the order made: count in *length; live until the next change
tg_link *const *tg_readers(tg_node *t, size_t *length);

#endif
