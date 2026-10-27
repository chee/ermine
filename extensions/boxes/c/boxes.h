// boxes (typescript/boxes.ts) in C: another namespace over the same store [chee 10-27: "a child
// that doesn't know about its parent"]. prefix bx_. the TypeScript is the reference; the suite,
// extensions/boxes/conformance/boxes/, holds both to it, on the ermine harness (ermine/system/c/
// ermine_harness.c with boxes_harness.c's ops beside).
//
//   bx_box *b;  bx_create_at(e, path, n, &b);        // a box over the folder at path (or _id, or bx_create: new)
//   bx_put(b, names, n, "n12");                      // only this box sees it
//   es_started *s;  bx_start(b, setup, ctx, es_text("/clock"), NULL, &s, &no);
//   bx_take(b, names, n);
//   bx_close(b);                                     // its bindings gone, its processes stopped
//   ...  es_free(e);  bx_free(b);                    // after the ermine
//
// a box: the folder its "/" is, and the ermine's places viewed from it (pl_view) asked
// [bindings, processes(root), children]. the bindings are a trie of ids on a part of the table of
// their own ("binding"), on a key of the box's own: never saved, never synced, asked only by this
// box's view. a path of several names is a level, walked through as a folder. a binding shadows
// what is saved at its path; boxes over one folder have their own bindings and share its process
// rows (rows are on the root). picks as the TypeScript's header says (a root that is a folder or a
// new node; a boxed process seen from outside by asking the box; the host makes boxes).
//
// put refused, nothing changed: something there already (ES_ALREADY_THERE: a binding, a saved
// child or a process at the path, a binding above it or under it), no name (ES_NOT_A_NAME). take of
// a path with no binding: ES_NOTHING_THERE. errors are codes and es_thrown(), as the ermine's.
//
// memory: the box's strings are the table's keys, so a box is let go (bx_free) after the ermine is
// (es_free). its places are pl_free'd with it. out of memory aborts
#ifndef BOXES_H
#define BOXES_H

#include "../../../ermine/system/c/ermine.h"

typedef struct bx_box bx_box;

// a box over a new empty node
int bx_create(es_ermine *e, bx_box **out);
// over the folder at a path from the ermine's root, names (".", ".." and "/" as a path has them);
// nothing there: ES_NOTHING_THERE
int bx_create_at(es_ermine *e, const char *const *path, size_t n, bx_box **out);
// over the folder with this id, as it is
int bx_create_id(es_ermine *e, const char *id, bx_box **out);

// the folder its "/" is, and the ermine's places from it (the box's, borrowed; good till bx_free)
const char *bx_root(const bx_box *b);
pl *bx_places(const bx_box *b);

// node (an id) at the path, seen only by this box; what put put at the path, gone
int bx_put(bx_box *b, const char *const *path, size_t n, const char *node);
int bx_take(bx_box *b, const char *const *path, size_t n);

// es_start in the box: its "/" is the box's, its row is on the box's root, what it starts is in it too
int bx_start(bx_box *b, es_program fn, void *ctx, es_at at, const es_start_options *o,
	es_started **out, es_refused *refused);

// close: every binding the box put gone (as bx_take does, a running reader is told), every process
// started through bx_start stopped ("box closed"; call it before any es_started_free of those). after
// it bx_put, bx_take and bx_start are ES_GONE; again: nothing. bx_places stays a view; the fresh root
// of bx_create is left. memory is bx_free's
int bx_close(bx_box *b);

void bx_free(bx_box *b);

#endif
