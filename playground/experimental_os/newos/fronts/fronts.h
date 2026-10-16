// fronts.h: ephemeral members in front of a name (FRONTS.md), a places contributor, in newOS until ermine/
// has one. Places (filesystem/places) maps a name to one id; newOS's programs hold more at a name: an
// ephemeral node in front of the document there (kit's front: a window dragged, an edit not yet written),
// an ephemeral node alone at a name (a layer, a handler), so a reader there sees the ephemeral one first
// and the saved one again once it goes.
//
//   (front, P).value = { client: ["@drag"], layers: ["@win7", "@win9"] }
//
// a part on the parent's id (by the id, as children goes, so a walk from an id finds them too): each name a
// list of ids, the first answering first. Asked before children (the contributors' order), a front shadows
// what children has at the name while it is there; the rest of the list, and what children has, are the
// name's other members (fr_members). Its names are the names with fronts: a name held only by an ephemeral
// is listed.
//
//   fr_fronts fronts;
//   fr_init(&fronts, FR_PART);
//   const pl_contributor *const order[] = {&fronts.contributor, &pl_children};
//   pl_connect(p, &(pl_setup){.root = .., .contributors = order, .ncontributors = 2});
//   fr_add(p, table, FR_PART, parent, "client", tb_string("@drag"), 0, header, &changed, &made);
//   pl_commit(p, &changed);
//
// the fronts are never saved: whoever saves leaves the part out (they are what is running now, on this
// device, as processes' rows). Nothing here takes a front out when what made it ends: who does is open.
//
// writes: plain functions on the table, as processes' are, each giving the entries it changed for
// pl_commit: one patch at the name, so a front coming or going marks that name and nothing beside. The
// first front under a parent makes the part's entry (a table event tells readers): *changed nothing,
// *made the entry (the places' own), for the caller to hold the header's block on. Refused: a pl_code,
// nothing changed.
#ifndef NEWOS_FRONTS_H
#define NEWOS_FRONTS_H

#include "../../../../filesystem/places/c/places.h"

// the part the fronts are kept on
#define FR_PART "front"

typedef struct {
	pl_contributor contributor;
	// the part its lists are on: FR_PART, or another; a string that outlives the places
	const char *part;
} fr_fronts;

void fr_init(fr_fronts *f, const char *part);

// id put in front at name under parent, at in the list (0 first; < 0 or past the end, last). Refused: a name
// that is not one (PL_NOT_A_NAME); id in that list already (PL_ALREADY_THERE). The ids and the part must
// outlive the table's entry for them, as the table needs. made may be NULL. 0, or the code
int fr_add(pl *l, tb_table *table, const char *part, tb_key parent, const char *name, tb_key id, long at,
	ch_header header, pl_changed *changed, nd_entry **made);

// id taken out of the fronts at name under parent; the last one out takes the name with it. Not there:
// PL_NOTHING_THERE
int fr_remove(pl *l, tb_table *table, const char *part, tb_key parent, const char *name, tb_key id,
	ch_header header, pl_changed *changed);

// every member at name under parent, in order: the fronts, then what children has there (when it is none of
// them); up to cap of them into out, how many there are. Read through the places: told, so a run reading it
// reruns when a front comes or goes, or the name's id changes
size_t fr_members(pl *l, const char *part, tb_key parent, const char *name, tb_key *out, size_t cap);

#endif
