// Places (typescript/places.ts), in C: the filesystem, and the connections between the table, the
// tracked paths and the scheduler, set up once by whoever makes them. It makes none of them and
// wraps none of their calls. Same rules as places.ts, which the suite in
// filesystem/places/conformance/places/ holds both to.
//
//   pl *p = pl_new();                                  // only itself: it is the ctx of the hooks
//   tb_table *table = tb_make(pl_event, p);
//   sc_scheduler *s = sc_new((sc_options){.., .forget = pl_forget, .data = p});
//   pl_connect(p, &(pl_setup){tb_string("R"), table, paths, s});
//   ...
//   pl_place(p, children, name, id, header, &changed); // a write
//   pl_wrote(p, &changed);                             // said written
//
// The filesystem: a children entry's value maps each name to one id; a name is any string but "",
// ".", ".." and "/". A path is names from the root, each looked up as it is. A read is told to the
// scheduler as a spot (paths.h), so a run reading tracks it; a read outside a run counts for
// nothing. A walk reads each name in the children of the id before it. A write says changed the
// spots its patches mark, at every key the entry is under; a table event, the spots of its key.
// Both by the writer open (sc_current_writer), none: from outside. The status of the reads told
// (SC_STOP: the run must end now; SC_CLOSED: it has returned) is given by pl_status.
//
// Paths keys a spot by two parts, (source, id); the table by two, (part, id), and places knows no
// source. A table's part goes into one pair per part, made once and kept: the same address always,
// so the same key by identity, and it is the source paths is given. A part is a name, any string;
// "children" is the part the filesystem reads. A spot nobody reads any more is let go: the
// scheduler's forget calls pl_forget with each key it stops tracking. A spot read outside a run is
// tracked by none, so never let go.
//
// pl_spot names a key told to the scheduler: one of this places' spots, held, is where it reads, so
// a run's reads (the scheduler's ends moment) can be named as places in the graph. Anything else,
// or a spot let go, is none.
//
// WHO. The pairs of a write are the info of the scopes open, from the root down (sc_pairs), then
// the call's own. Their values are op_values (value.h), the host's own, except the scheduler's:
// "run" and "mark" are numbers it keeps as uint64_t, and are given on as op_value numbers. The
// first "actor" pair is the actor, the first "reader" (a string) the reader, every other pair
// metadata, in order. A write with no scope open has no who: unscoped.
//
// MEMORY. A header made (pl_header) refers to a block, a pl_made: the metadata, the site, a hold
// on each value. The node it is written to refers to the block until its next update: pl_hold keeps
// it till then. The writes below hold their patches the same way, so a write's node holds its
// patches until its next update, and pl_hold_also adds the header's block to them. A value a read
// gives is borrowed from the table; a name in a list too. Out of memory aborts.
#ifndef PLACES_H
#define PLACES_H

#include <stddef.h>

#include "../../../core/scheduler/c/paths.h"
#include "../../../core/scheduler/c/scheduler.h"
#include "../../../core/graph/c/table.h"
#include "../../../core/node/c/node.h"
#include "../../../core/node/c/update.h"

typedef struct pl pl;
// only the places, so that it can be the ctx of the hooks below
pl *pl_new(void);
// forgets the holds, the pairs and what is open; none of what it was connected to
void pl_free(pl *p);

// what the hooks were given to, made already; places keeps none of them
typedef struct {
	// where names start
	tb_key root;
	tb_table *table;
	pt_paths *paths;
	sc_scheduler *scheduler;
} pl_setup;
// once: before anything is read or written
void pl_connect(pl *p, const pl_setup *setup);

// hooks, ctx the pl
// the table's (tb_event): a table event says changed every spot of its key
void pl_event(void *ctx, tb_key part, tb_key id);
// the scheduler's: a key that is one of this places' spots is released; any other is left alone
void pl_forget(const void *key, void *ctx);

// the first answer that was not SC_OK to the reads told since this was last asked; then SC_OK
sc_read_status pl_status(pl *p);

// writes ----------------------------------------------------------------------------------------

// the entries a write changed, in order
typedef struct {
	size_t n;
	nd_entry *entries[2];
} pl_changed;

typedef enum { PL_NOT_A_NAME = 1, PL_NOTHING_THERE, PL_ALREADY_THERE } pl_code;
// the TypeScript code of a return, "not-a-name", "nothing-there" or "already-there"; "" for 0
const char *pl_code_name(int code);

// whether a name is any string but "", ".", ".." and "/"
int pl_is_name(const char *name);

// plain functions on a children entry (the entry a table gives, given as it is), each with the
// header of the write. 0, or a code, and then nothing changed; *changed the entries changed. The
// strings are copied; the header's pieces are borrowed (see MEMORY), as is the entry's change
// to the patches, which p holds. A name holding anything is never written over
// id placed under name, a name holding nothing: one change
int pl_place(pl *p, nd_entry *children, const char *name, tb_key id, ch_header header,
	pl_changed *changed);
// the id under name taken out, and the name with it: one change
int pl_unplace(pl *p, nd_entry *children, const char *name, ch_header header, pl_changed *changed);
// the id under name moved to the name to: one change; to the same name: none
int pl_rename(pl *p, nd_entry *children, const char *name, const char *to, ch_header header,
	pl_changed *changed);
// the id under a name in one children entry put under a name in another: the same entry, one
// change (to the same name: none); two entries, a change on each, the one it goes into first
int pl_move(pl *p, nd_entry *from, const char *name, nd_entry *into, const char *to,
	ch_header header, pl_changed *changed);

// after a write: the spots its patches mark, said changed
void pl_wrote(pl *p, const pl_changed *changed);

// what is at path in a value: a number into a list or a typed array, a name into a map; nothing
// there: NULL. Bytes are one whole value: a number into them is nothing. A typed array's element
// is no op_value of the value, so it is made in scratch (a number, set each time) and scratch is
// returned: good until the next call with it. 64-bit elements come as doubles, rounded past 2^53.
// scratch NULL: a typed array's element is nothing
const op_value *pl_at(const op_value *v, const op_key *path, size_t n, op_value *scratch);
// what is at path in the value of the node under (part, id), the read told. The path is copied by
// paths. NULL: nothing there. Borrowed: good until the node changes, or, for a typed array's
// element (places' one scratch number), until the next pl_read on this places
const op_value *pl_read(pl *l, tb_key part, tb_key id, const op_key *path, size_t n);
// the change of the node under (part, id), the read told at its change spot: any write to the node
// reruns it. NULL: none there. Borrowed
const ch_header *pl_change(pl *l, tb_key part, tb_key id);

// where a spot reads: the node under (part, id), and the path in its value, length keys; change:
// the change spot, reads of the change itself, no path. The places' and paths' own, good while the
// spot is held
// attached: 0 for those, else the spot is of what is attached at the path names (1), or of the
// names attached under it (2); part, id and path are then unset
typedef struct {
	tb_key part;
	tb_key id;
	const op_key *path;
	size_t length;
	int change;
	int attached;
	const char *const *names;
	size_t nnames;
} pl_where;
// a key told to the scheduler (as a run's ends moment has it): when it is one of this places'
// spots, held, 1 and *out where it reads; anything else, or a spot let go: 0
int pl_spot(const pl *l, const void *key, pl_where *out);

// the filesystem, every read told ---------------------------------------------------------------

// a name in a children entry, and the id under it. The name is borrowed from the table
typedef struct {
	const char *name;
	tb_key id;
} pl_member;
typedef struct {
	size_t n;
	pl_member *items;
} pl_members;
void pl_members_free(pl_members *list);

// the steps of a path from an id, each a name and the id under it, one at a time as they are
// taken; nothing under a name: the walk stops there. out has room for n; the steps taken
size_t pl_walk(pl *p, tb_key from, const char *const *path, size_t n, pl_member *out);
// the same, with above: from's path from the root (nabove names; known: it is given, else nothing
// attached is asked). Each step asks first what is attached at above + path[..i+1], the read told;
// an id attached there is taken, and the children are not read. pl_walk: known when from is the root
size_t pl_walk_above(pl *p, tb_key from, const char *const *path, size_t n, pl_member *out,
	const char *const *above, size_t nabove, int known);
// the id at a path from the root; 1 and *out, or 0: nothing there
int pl_get(pl *p, const char *const *path, size_t n, tb_key *out);
// the names from where you are (a path from the root), then from each place above it, nearest
// first: for each found, how many of from its path starts with (the path is that many of from,
// then names). depths has room for nfrom + 1; all: each found, nearest first, else the nearest
// only. Returns how many. The walk to where you are is made once
size_t pl_lookup(pl *p, const char *const *names, size_t nnames, const char *const *from,
	size_t nfrom, int all, size_t *depths);
// the names at a path holding an id, and their ids, in their order there: a read of which names
// there are, then of each (members); or only of which names there are (list, its ids not told).
// nothing there: none. The caller's, pl_members_free
pl_members pl_members_at(pl *p, const char *const *path, size_t n);
pl_members pl_list(pl *p, const char *const *path, size_t n);

// items attached at a path -----------------------------------------------------------------------

// id attached at the path, in place of what was attached there; local, never saved. The names and
// id are copied. 0, or PL_NOT_A_NAME (an empty path, or a bad last name). With a scope open, it is
// detached when that scope is cleaned up, if the same id is still attached there
int pl_attach(pl *p, const char *const *path, size_t n, tb_key id);
// what is attached at the path taken away; nothing: nothing
void pl_detach(pl *p, const char *const *path, size_t n);
// the names attached directly under a path, and their ids, in the order attached: a read, told.
// The caller's, pl_members_free; names and ids are good as long as the places
pl_members pl_attached_at(pl *p, const char *const *path, size_t n);

// who ------------------------------------------------------------------------------------------

// who the scope open says a write is, extra (n pairs) after its pairs: a map of actor, reader and
// metadata (a list of [key, value]) where there are some. New, the caller's to op_free. NULL: no
// scope open
op_value *pl_who(pl *l, const sc_pair *extra, size_t n);

// a header made now, with the scope open
typedef struct pl_made pl_made;
// the header of a write made now: who (above), the time now in whole seconds, and the site (copied;
// NULL: none; CH_HERE is the caller's own). *made is its block: the caller's, to pl_made_free, or
// to pl_hold. A failure is an error string (fresh; the caller frees it), SC_UNSCOPED when no scope
// is open; *out and *made are not set
char *pl_header(pl *l, const sc_pair *extra, size_t n, const ch_site *site, ch_header *out,
	pl_made **made);
// one more hold of the block, for one more node to refer to it
pl_made *pl_made_ref(pl_made *made);
// lets one hold go; the last frees the block. For pl_hold's release
void pl_made_free(void *made);

// keeps something alive for the node's change to refer to (a header's block, a write's patches):
// release(block) is called when the next pl_hold for the same node comes, or at pl_free. _also
// adds a block to those the node holds already, all let go together
void pl_hold_also(pl *l, const nd_entry *node, void *block, void (*release)(void *block));
void pl_hold(pl *l, const nd_entry *node, void *block, void (*release)(void *block));

#endif
