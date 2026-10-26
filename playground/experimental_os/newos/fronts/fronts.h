// fronts.h: ephemeral members in front of a name (FRONTS.md), a places contributor. a reader at a
// name sees the ephemeral node first, the saved one again once it goes.
//
//   (front, P).value = { client: ["@drag"], layers: ["@win7", "@win9"] }
//
// a part on the parent's id: each name a list of ids, the first answering first. asked before
// children, it shadows children's entry at the name; the rest are the name's other members
// (fr_members). a name held only by an ephemeral is listed.
//
//   fr_fronts fronts;
//   fr_init(&fronts, FR_PART);
//   const pl_contributor *const order[] = {&fronts.contributor, &pl_children};
//   pl_connect(p, &(pl_setup){.root = .., .contributors = order, .ncontributors = 2});
//   fr_add(p, table, FR_PART, parent, "client", tb_string("@drag"), 0, header, &changed, &made);
//   pl_commit(p, &changed);
//
// never saved: whoever saves leaves the part out. writes give the changed entries for pl_commit,
// one patch at the name. the first front under a parent makes the part's entry: *made, for the
// caller to hold the header's block on. refused: a pl_code, nothing changed.
// open: who takes a front out when what made it ends.
#ifndef NEWOS_FRONTS_H
#define NEWOS_FRONTS_H

#include "../../../../core/places/c/places.h"

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
