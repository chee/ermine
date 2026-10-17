// patch nodes (typescript/patch.ts) in C: same rules as patch.ts (read it first: stale, set aside,
// land, telling), held to by extensions/patch-nodes/conformance/patch/.
//
//   pn *o = pn_new();
//   tb_table *table = tb_make(pn_event, o);              // the table: writes go here, never to the view
//   pl *p = pl_new();
//   tb_table *view = tb_make(pn_view_event, o);          // what places reads: made by pn
//   pn_connect(o, table, view, p);
//   pl_connect(p, &(pl_setup){tb_string("R"), view, ...});
//   nd_update(entry, ...); pn_commit(o, &changed);       // a write: to the table, said here
//
// C places reads the one table it is connected to (tb_get), so patch.ts' overlay is a second table
// here, the view: every key's entry, or where patch nodes are over it, the entry made from it and
// them; kept made as the table's events and pn_commit come.
// telling: as patch.ts'; a table event goes to places as its own, through pn_view_event.
// memory: a made entry is the overlay's, let go when made again or at pn_free; never change it. a
// told entry (and the patches and values its change refers to) is good until that key's next
// change. a made entry's change refers to the table entry's actor and metadata: kept alive until
// it is written again, and every write is said (pn_commit) first. patch nodes are read, never
// changed. out of memory aborts.
#ifndef PATCH_H
#define PATCH_H

#include <stddef.h>

#include "../../../filesystem/places/c/places.h"

typedef struct pn pn;

// the table's own layer, as a layer's from
#define PN_TABLE "table"

// one layer of a read, front first: the value (NULL: none), and where it is from (a patch node's
// id, or PN_TABLE). stale: made against an older version than the target's latest change, still
// applied. error: why its patches don't apply (op_code_name): set aside, its value what is under it.
// Borrowed from the overlay: good until the next change
typedef struct {
	const op_value *value;
	const char *from;
	int stale;
	const char *error;
} pn_item;

pn *pn_new(void);
// lets go of what it made, and holds; not the tables nor the places it was connected to
void pn_free(pn *o);
// once: the table (made with pn_event), the view (made with pn_view_event, the pn the ctx, and given
// to places as its table), and the places
void pn_connect(pn *o, tb_table *table, tb_table *view, pl *places);
// the view's event (tb_event), ctx the pn: places' own pl_event, except while the overlay swaps the
// view's entry itself (then it says places what it means to)
void pn_view_event(void *ctx, tb_key part, tb_key id);

// the table's event (tb_event), ctx the pn: a patch node came, changed or went, or an entry did
void pn_event(void *ctx, tb_key part, tb_key id);
// after a write to the table's entries: places' commit, then a patch node changed has its target
// told, and an entry changed under patch nodes told at the patch nodes' spots
void pn_commit(pn *o, const pl_changed *changed);

typedef struct {
	size_t n;
	pn_item *items;
} pn_items;
// every layer at path in the entry under (part, id), front first: each patch node's, then the
// table's, the value of each at path (NULL: nothing there). The read told at path, as pl_read
// tells it. The caller's, pn_items_free; the values borrowed
pn_items pn_entries(pn *o, tb_key part, tb_key id, const op_key *path, size_t n);
void pn_items_free(pn_items *list);

// a target's patch nodes in the order they came: *n of them, an array the caller frees (the ids
// are borrowed). The targets that have any: pn_targets
const char **pn_index(const pn *o, const char *on, size_t *n);
size_t pn_targets(const pn *o);

enum { PN_NOTHING_THERE = -1 };
// a patch node's patches put on its target for real, and its entry taken out of the table: the
// override committed. changed gets the entries changed, for pn_commit; a target with no entry: one
// made and added (a table event tells), *made it for the caller to keep and to hold the header's
// block on (else NULL). 0; PN_NOTHING_THERE (not a patch node); or op's code, *failed the patch
// (may be NULL), and nothing changes. The patches stay held by the overlay until pn_free
int pn_land(pn *o, tb_key id, ch_header header, pl_changed *changed, nd_entry **made,
	size_t *failed);

#endif
