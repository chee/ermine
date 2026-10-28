// upsert (typescript/upsert.ts) in C, on places' public API: a value made or patched at a path of
// names inside the entry under (part, id) of a table.
//
//   pl_changed changed; nd_entry *made;
//   up_upsert(places, table, tb_string("value"), tb_string("a"), path, n, value, header, &changed, &made);
//   pl_commit(places, &changed);                       // said written
//   if (made != NULL) pl_hold(places, made, block, release);   // the header's block, for the new entry
//
// No entry there: one made holding the value nested (the places' own, let go of at pl_free), added
// to the table (its event tells readers); *made it, for the caller to pl_hold the header's block on;
// *changed nothing. An entry: one patch at the path, the nested remainder put at the first level that
// is no map or has no such key (a level that is no map is put over); *changed that entry. The same
// value (compared deeply, a map's keys in any order) already there: nothing is written. The value is
// borrowed and held (op_ref) by the entry; the strings are copied; made may be NULL. id and part
// must outlive the table's entry for them, as the table needs. 0
#ifndef UPSERT_H
#define UPSERT_H

#include <stddef.h>

#include "../../../../core/places/c/places.h"

int up_upsert(pl *p, tb_table *table, tb_key part, tb_key id, const char *const *path, size_t n,
	const op_value *value, ch_header header, pl_changed *changed, nd_entry **made);
// up_upsert, the write (on an entry there) through pl_unread's un_update: for an entry the caller
// means changed in place until read
int up_upsert_unread(pl *p, tb_table *table, tb_key part, tb_key id, const char *const *path,
	size_t n, const op_value *value, ch_header header, pl_changed *changed, nd_entry **made);

#endif
