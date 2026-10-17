// boxes (typescript/boxes.ts) in C: a "/" of a process's own, a plain folder. same rules as
// boxes.ts; ermine/boxes/conformance/boxes/ holds both to them.
//
//   bx_host host = {world_places, table};          // the host's places and table
//   bx *b;
//   bx_create(&host, steps, n, NULL, header, block, &b);  // the folder found or made
//   bx_box(b, path, n, node, header, block, &changed);    // a regular placement in it
//   pl_get(bx_places(b), path, n, &id);                    // places' reads, unchanged
//   bx_free(b);                                            // before or after the host's places
//
// a box: its folder's id (root) and a pl_view of the host's places rooted there. nothing above its
// root is reachable; ".." at its "/" stays there (bx_inside). writes through either places tell
// readers of both.
// writes: missing folders on the way made, committed by the host. refused, nothing changed:
// PL_NOT_A_NAME, PL_ALREADY_THERE (a name holding no id). paths: steps (name, ".", "..", "/").
// memory: every entry written holds the header's block once more (pl_hold_also / pl_hold); the
// caller keeps its own hold. a box copies its root and host; the host's places must outlive it.
// out of memory aborts.
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
// let go, and its view (before or after the host's places: places.h), after any cache on its places
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
