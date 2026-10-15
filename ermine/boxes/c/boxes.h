// Boxes (typescript/boxes.ts), in C: a "/" of a process's own, a plain folder. Same rules as boxes.ts,
// which the suite in ermine/boxes/conformance/boxes/ holds both to.
//
//   bx_host host = {world_places, table};          // the host's places and table
//   bx *b;
//   bx_create(&host, steps, n, NULL, header, block, &b);  // the folder found or made
//   bx_box(b, path, n, node, header, block, &changed);    // a regular placement in it
//   pl_get(bx_places(b), path, n, &id);                    // places' reads, unchanged
//   ...
//   bx_free(b);                                            // before the host's places go
//
// A box is its folder's id (root) and a view of the host's places rooted there (pl_view), asked
// [processes(root), children]: the folder's saved names, and the processes started at root
// (pr_add(.., root, ..)) seen at their path in it. Nothing more, so any places rooted at the graph's
// root and asked the same stands in for one. No path from its root reaches above it; pl_lookup stops
// there; an address's ".." at its "/" stays there (bx_inside). What is in it is what is in the folder,
// ordinary children; one set of spots with the host's places, so a write committed to either tells
// the readers of both, and the table's one hook (pl_event on the host's) tells both.
//
// Writes go by saved children only: the folders on the way found, each missing one made (a fresh
// uuid placed as a regular child; the first in a folder with no children entry: an entry made, owned
// by the places, and a table event), then said written by the host's commit. Refused, nothing
// changed: PL_NOT_A_NAME (a name that is not one), PL_ALREADY_THERE (a name holding something that is
// no id). Paths are steps (a name, ".", ".." or "/"), read through bx_inside.
//
// MEMORY. A write's header is given with its block (pl_header's): every entry written holds the block
// once more (pl_hold_also on a changed entry, pl_hold on an entry made); the caller keeps its own
// hold. A box keeps its root (copied) and its view; the host is copied and must outlive it. Out of
// memory aborts.
#ifndef BOXES_H
#define BOXES_H

#include "../../processes/c/processes.h"

// what a box is made over
typedef struct {
	pl *places;
	tb_table *table;
	// where its writes are said written, ctx its own; NULL: pl_commit on places
	void (*commit)(void *ctx, const pl_changed *changed);
	void *ctx;
} bx_host;

typedef struct bx bx;

// the names steps come to inside a root, from where you are (nfrom names from the root): "." here,
// ".." back one (at the root: stays there), "/" back to the root. out has room for nfrom + n; the
// names borrowed from steps and from. Returns how many
size_t bx_inside(const char *const *steps, size_t n, const char *const *from, size_t nfrom,
	const char **out);

// the folder at steps (n) from the parent's root (NULL: the host's places'), found or made: 0 and
// *out, or a code and *out NULL, nothing changed
int bx_create(const bx_host *host, const char *const *steps, size_t n, const bx *parent,
	ch_header header, pl_made *block, bx **out);
// the folder id (copied), as it is: 0 and *out. With a parent: PL_NOTHING_THERE (an id could be
// anywhere, and a box in another is only ever narrower)
int bx_create_id(const bx_host *host, const char *id, const bx *parent, bx **out);
// let go, and its view: before the host's places (pl_free), and after any cache made on its places
void bx_free(bx *b);

// its folder's id; the host's places viewed from it
const char *bx_root(const bx *b);
pl *bx_places(bx *b);

// node placed at steps (n) in the box: a regular placement, the folders on the way made. Refused,
// nothing changed: PL_NOT_A_NAME (no name), PL_ALREADY_THERE (something at the path already). 0, or
// the code; *changed the entries changed, already said written (none: a table event)
int bx_box(bx *b, const char *const *steps, size_t n, tb_key node, ch_header header,
	pl_made *block, pl_changed *changed);
// what is at steps (n) in the box unplaced: a regular unplace (the folders on the way stay).
// PL_NOTHING_THERE: none there, or no name. *changed as bx_box's
int bx_unbox(bx *b, const char *const *steps, size_t n, ch_header header, pl_made *block,
	pl_changed *changed);

#endif
