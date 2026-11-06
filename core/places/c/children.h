// children.h: the children format, a contributor and the writes that edit a children entry.
//   pl_place(p, children, name, id, header, &changed);
//   pl_commit(p, &changed);
#ifndef PL_CHILDREN_H
#define PL_CHILDREN_H

#include "places.h"

extern const pl_contributor pl_children;

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
