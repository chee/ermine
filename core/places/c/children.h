// children.h: the children format, a contributor and the writes that edit a children entry.
//   pl_place(p, children, name, id, header, &changed);
//   pl_commit(p, &changed);
#ifndef PL_CHILDREN_H
#define PL_CHILDREN_H

#include "places.h"

extern const pl_contributor pl_children;

// Every folder and name that names an id, learned from what places tells: an entry already in the
// table when it is made is missing. Free it before the places.
typedef struct pl_index pl_index;
typedef struct {
	tb_key folder;
	const char *name;
} pl_slot;
pl_index *pl_index_new(pl *p);
void pl_index_free(pl_index *x);
// Latest placed last. Borrowed until the next write or table event.
const pl_slot *pl_index_of(const pl_index *x, tb_key id, size_t *n);

// Writes return 0 or a code, and on a code nothing changed. Strings are copied; header pieces
// are borrowed. A name that holds something is never written over.
int pl_place(pl *p, nd_entry *children, const char *name, tb_key id, ch_header header,
	pl_changed *changed);
int pl_unplace(pl *p, nd_entry *children, const char *name, ch_header header, pl_changed *changed);
int pl_rename(pl *p, nd_entry *children, const char *name, const char *to, ch_header header,
	pl_changed *changed);
// Two entries get one change each, the one it goes into first.
int pl_move(pl *p, nd_entry *from, const char *name, nd_entry *into, const char *to,
	ch_header header, pl_changed *changed);

#endif
