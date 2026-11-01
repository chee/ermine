// The tracker (typescript/tracker.ts) in C, with the same shape.
#ifndef TRACKER_H
#define TRACKER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct tg_node tg_node;
typedef struct tg_link tg_link;

// One edge in two lists: from's reads (next) and to's readers (before, after), in order made.
struct tg_link {
	tg_node *from;
	tg_node *to;
	tg_link *next;
	tg_link *before;
	tg_link *after;
	uint64_t gen;
};

// Links may repeat: a reader can have two links to one spot (see tg_track).
// owner belongs to the caller and is never read here. cursor is the last link this run confirmed;
// outside a run it is the last link its run confirmed, with unreached ones after it (old until
// tg_trim). gen is the tick its latest run began at (0 before any). first and last are the
// readers' list.
struct tg_node {
	void *owner;
	tg_link *reads;
	tg_link *cursor;
	uint64_t gen;
	tg_link *first;
	tg_link *last;
	bool open;
};

tg_node *tg_node_new(void *owner);
// Frees a node. Untrack it and every reader of it first, or links are left pointing at it.
void tg_node_free(tg_node *n);

int tg_begin(tg_node *f);
int tg_track(tg_node *f, tg_node *t);
// In a run: ends it, dropping what it did not read again (tg_leave, then tg_trim).
void tg_end(tg_node *f);
// In a run: ends it without dropping links; unreached ones after the cursor become old.
void tg_leave(tg_node *f);
// Outside a run: reopens the run that was left, with its tick and cursor as tg_leave left them,
// so new reads go after the earlier ones. Returns 0, or -2 in a run.
int tg_resume(tg_node *f);
// A link from an earlier run that the latest run did not read is old. A later run that reads it
// takes it back; tg_trim drops the old ones once a run is done.
bool tg_old(const tg_link *l);
void tg_trim(tg_node *f);
// Outside a run: drops links after the cursor to a spot already linked before or after it.
void tg_dedupe(tg_node *f);
int tg_add(tg_node *f, tg_node *t);
void tg_untrack(tg_node *f, tg_node *t);

// To list what f reads, walk f->reads by ->next (each link's ->to). To list who reads t, in the
// order made, walk t->first by ->after (each link's ->from).

#endif
