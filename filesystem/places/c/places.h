// Places (typescript/places.ts), in C: the filesystem, and the connections between the table, the
// tracked paths and the scheduler, set up once by whoever makes them. It makes none of them and
// wraps none of their calls. Same rules as places.ts, which the suite in
// filesystem/places/conformance/places/ holds both to.
//
//   pl *p = pl_new();                                  // only itself: it is the ctx of the hooks
//   tb_table *table = tb_make(pl_event, p);
//   sc_scheduler *s = sc_new((sc_options){..});
//   sc_on_untrack(s, pl_forget, p);
//   pl_connect(p, &(pl_setup){tb_string("R"), table, paths, s});
//   ...
//   pl_place(p, children, name, id, header, &changed); // a write
//   pl_commit(p, &changed);                            // said written
//
// The filesystem: a children entry's value maps each name to one id; a name is any string but "",
// ".", ".." and "/". A path is names from the root, each looked up as it is. A read is told to the
// scheduler as a spot (paths.h), so a run reading tracks it; a read outside a run counts for
// nothing. A walk reads each name in the children of the id before it. A write says changed the
// spots its patches mark, at every key the entry is under; a table event, the spots of its key.
// Both by the run open (sc_get_run), none: from outside. The status of the reads told
// (SC_STOP: the run must end now) is given by pl_status.
//
// Paths keys a spot by two parts, (source, id); the table by two, (part, id), and places knows no
// source. A table's part goes into one pair per part, made once and kept: the same address always,
// so the same key by identity, and it is the source paths is given. A part is a name, any string;
// "children" is the part the filesystem reads. A spot nobody reads any more is let go: the
// scheduler's untrack listener calls pl_forget with each key it stops tracking. A spot read outside a run is
// tracked by none, so never let go.
//
// CONTRIBUTORS (contributors.org). What answers one step of a walk: children is one (pl_children); a places
// can be given others, asked in order at each step: the first answer is where the walk goes (pl_get),
// all of them are what is there (pl_entries), and a folder's names are every contributor's, each name
// once (pl_list, pl_members). None given: children alone, and the walk, list and members read just as
// they always have. A contributor reads only through the reads of the places it is handed (pl_read,
// pl_keys, pl_track). A cache (cache.h) works answers out outside any run: pl_record puts the reads a
// call makes into a set in place of the scheduler, and pl_keep keeps a spot past pl_forget while the
// cache reads it.
//
// pl_spot names a key told to the scheduler: one of this places' spots, held, is where it reads, so
// a run's reads (the scheduler's run end) can be named as places in the graph. Anything else,
// or a spot let go, is none.
//
// WHO. The pairs of a write are the info of the scopes open, from the root down (sc_get_info), then
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
#include "../../../core/table/c/table.h"
#include "../../../core/node/c/node.h"
#include "../../../core/node/c/update.h"

typedef struct pl pl;
// only the places, so that it can be the ctx of the hooks below
pl *pl_new(void);
// forgets the holds, the pairs and what is open; none of what it was connected to
void pl_free(pl *p);

// where a walk has got to: the id it is at, and its path (the names from the root to it). no path
// (has_path 0): a walk from an id alone, where it is from the root not known
typedef struct {
	tb_key id;
	int has_path;
	const char *const *path;
	size_t length;
} pl_here;

// names, borrowed (from the table, or the contributor's own); the caller's, pl_namelist_free
typedef struct {
	const char **items;
	size_t n, cap;
} pl_namelist;
void pl_namelist_add(pl_namelist *list, const char *name);
void pl_namelist_free(pl_namelist *list);

// what answers one step. from: what it is called, the from of each answer it gives (a string that
// outlives the places). A contributor reads through the places it is handed (pl_read, pl_keys,
// pl_track): told as places tells its own, so in a run the run tracks them, and marks a key of its own
// itself when it changes
typedef struct {
	const char *from;
	// the id it has at here + name: 1 and *out; none: 0
	int (*step)(void *ctx, const pl_here *here, const char *name, pl *reads, tb_key *out);
	// the names it has directly under here, in its order: each one step answers, added to out
	void (*names)(void *ctx, const pl_here *here, pl *reads, pl_namelist *out);
	void *ctx;
} pl_contributor;
// the children table: goes by the id, never the path. the default contributor
extern const pl_contributor pl_children;

// what the hooks were given to, made already; places keeps none of them
typedef struct {
	// where names start
	tb_key root;
	tb_table *table;
	pt_paths *paths;
	sc_scheduler *scheduler;
	// what answers each step, in order (the array is kept, the caller's own, as are the contributors);
	// none: children alone
	const pl_contributor *const *contributors;
	size_t ncontributors;
} pl_setup;
// once: before anything is read or written
void pl_connect(pl *p, const pl_setup *setup);
// where names start
tb_key pl_root(const pl *p);

// hooks, ctx the pl
// the table's (tb_event): a table event says changed every spot of its key
void pl_event(void *ctx, tb_key part, tb_key id);
// the scheduler's untrack listener (sc_on_untrack): a key that is one of this places' spots is released; any other is left alone.
// A spot kept (pl_keep) is not released: whoever keeps it calls this once its last keep is given back
void pl_forget(const void *key, void *ctx);

// the first answer that was not SC_OK to the reads told since this was last asked; then SC_OK
sc_track_status pl_status(pl *p);

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

// upsert: a value made or patched at a path of names inside the entry under (part, id), the way
// upsert.ts does. No entry there: one made holding the value nested (the places' own, let go of at
// pl_free), added to the table (its event tells readers); *made it, for the caller to pl_hold the
// header's block on; *changed nothing. An entry: one patch at the path, the nested remainder put at
// the first level that is no map or has no such key (a level that is no map is put over); *changed
// that entry. The same value (compared deeply, a map's keys in any order) already there: nothing is
// written. The value is borrowed and held (op_ref) by the entry; the strings are copied; made may
// be NULL. id and part must outlive the table's entry for them, as the table needs. 0
int pl_upsert(pl *p, tb_key part, tb_key id, const char *const *path, size_t n,
	const op_value *value, ch_header header, pl_changed *changed, nd_entry **made);
// the value at the path, else make() (a new value: the caller's, which this lets go of) put there as
// pl_upsert does, with changed and made as there. Gives the value now at the path, borrowed from
// the table: good until the node changes. Reads nothing of the scheduler's
const op_value *pl_get_or_set(pl *p, tb_key part, tb_key id, const char *const *path, size_t n,
	op_value *(*make)(void *ctx), void *ctx, ch_header header, pl_changed *changed,
	nd_entry **made);

// an entry the caller made and added to the table, which the places lets go of at pl_free (as the ones
// pl_upsert makes)
void pl_own(pl *p, nd_entry *node);

// what landed at one key: the patches a write put there (a table event: one at the root, the value
// whole; taken out, one at the root with no value), the change, and the entry now. change and entry
// NULL: taken out. Borrowed: good for the call it is given to
typedef struct {
	tb_key part;
	tb_key id;
	const op_patch *patches;
	size_t patches_length;
	const ch_header *change;
	const nd_entry *entry;
} pl_fact;
typedef struct {
	size_t n;
	pl_fact *items;
} pl_facts;
// what a write landed: a fact for each entry with a latest op, at every key it is under (tb_who).
// The caller's, pl_facts_free; the patches and change are the entries'
pl_facts pl_each_entry_change(pl *p, const pl_changed *changed);
void pl_facts_free(pl_facts *facts);

// after a write: the spots its patches mark, said changed in one call, by the run open; then each
// watch told what landed at its node. A watch that writes commits in turn, in the same run
void pl_commit(pl *p, const pl_changed *changed);

// watches: fn is told each fact landing at the node at a path, from now, as it lands, after the
// mark, in the order the watches were made. The node is found when the watch is made, and again
// after a batch lands in a children entry on its route (the folders its path went through), by a
// plain walk of the children entries that tells the scheduler nothing; a fact is told only if its
// id is that node, found by one lookup of the id. A table event is told as one fact. A watch stopped on the way is not told
typedef struct pl_watch pl_watch;
typedef void (*pl_watch_fn)(const pl_fact *fact, void *ctx);
// only the part, when has_part; only the patches touching at (a path in the value: a patch's path,
// or its move's, is at, above at or under at), when has_at: the fact told with only those patches,
// and not told if none touch. The pieces are copied
typedef struct {
	int has_part;
	tb_key part;
	int has_at;
	const op_key *at;
	size_t at_length;
} pl_watching;
// path (n names) copied; options may be NULL. Gives back the watch, for pl_stop
pl_watch *pl_watch_path(pl *p, const char *const *path, size_t n, pl_watch_fn fn, void *ctx,
	const pl_watching *options);
// the stop: no more is told; the watch is let go of (a second stop is a mistake)
void pl_stop(pl_watch *w);

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
typedef struct {
	tb_key part;
	tb_key id;
	const op_key *path;
	size_t length;
	int change;
} pl_where;
// a key told to the scheduler (as a run's end has it): when it is one of this places'
// spots, held, 1 and *out where it reads; anything else, or a spot let go: 0
int pl_spot(const pl *l, const void *key, pl_where *out);

// for a cache (cache.h) ------------------------------------------------------------------------

// a set of pointers, in the order added; the pieces are the caller's to read, never to change
typedef struct {
	const void **items;
	size_t n, cap;
	// the hash of the items, once there are many
	size_t *index;
	size_t nindex, used;
} pl_set;
// 1 if added, 0 if it was there
int pl_set_add(pl_set *set, const void *item);
int pl_set_has(const pl_set *set, const void *item);
// 1 if it was there. The order of the rest may change
int pl_set_del(pl_set *set, const void *item);
void pl_set_free(pl_set *set);

// f(ctx), with every read it makes (a spot, or a contributor's pl_track) put into reads and told to
// no one: what a cache works out outside any run. inside another record, apart from it
void pl_record(pl *p, void (*f)(void *ctx), void *ctx, pl_set *reads);
// a key of a contributor's own: told to the scheduler (the status as of any read), or while recording,
// put into the set
void pl_track(pl *p, const void *key);
// a keep on one of this places' spots taken (n 1) or given back (n -1): the keeps left. a kept spot
// is not let go by pl_forget; the keeper calls it once its last keep is given back and no run tracks
// the spot. Anything else: 0, nothing kept
size_t pl_keep(pl *p, const void *key, int n);

// the filesystem, every read told ---------------------------------------------------------------

// a name in a children entry, and the id under it. The name is borrowed from the table
typedef struct {
	const char *name;
	tb_key id;
	// the contributor that gave it; NULL: none given (children alone)
	const char *from;
} pl_member;
typedef struct {
	size_t n;
	pl_member *items;
} pl_members;
void pl_members_free(pl_members *list);

// the steps of a path from an id, each a name and the id under it, one at a time as they are
// taken; nothing under a name: the walk stops there. out has room for n; the steps taken. With
// contributors, each step is the first answer, with its from; from an id that is not the root, the
// path is not known, so a contributor going by path has nothing. pl_walk_at: from a here
size_t pl_walk(pl *p, tb_key from, const char *const *path, size_t n, pl_member *out);
size_t pl_walk_at(pl *p, const pl_here *from, const char *const *path, size_t n, pl_member *out);

// an answer at a path, and the contributor that gave it
typedef struct {
	tb_key id;
	const char *from;
} pl_answer;
typedef struct {
	size_t n;
	pl_answer *items;
} pl_answers;
void pl_answers_free(pl_answers *list);
// every answer at here + name, in the contributors' order
pl_answers pl_answers_at(pl *p, const pl_here *here, const char *name);
// every answer at a path: the walk to the folder it is in, then every contributor asked its name. The
// root: itself, from "root". Nothing there: none
pl_answers pl_entries(pl *p, const char *const *path, size_t n);

// a name at a path, and the first contributor that gives it
typedef struct {
	const char *name;
	const char *from;
} pl_named;
typedef struct {
	size_t n;
	pl_named *items;
} pl_nameds;
void pl_nameds_free(pl_nameds *list);
// the names under here, every contributor's in order, each name once: from the first that gives it
pl_nameds pl_names(pl *p, const pl_here *here);
// the id at a path from the root; 1 and *out, or 0: nothing there
int pl_get(pl *p, const char *const *path, size_t n, tb_key *out);
// the names from where you are (a path from the root), then from each place above it, nearest
// first: for each found, how many of from its path starts with (the path is that many of from,
// then names). depths has room for nfrom + 1; all: each found, nearest first, else the nearest
// only. Returns how many. The walk to where you are is made once
size_t pl_lookup(pl *p, const char *const *names, size_t nnames, const char *const *from,
	size_t nfrom, int all, size_t *depths);
// the names a map holds at a path in the value under (part, id), a read of which names there are: a
// name coming, going or put over tells it, a change deeper under a name does not. ids: only the names
// holding an id. none there: none. Told as places tells its own
void pl_keys(pl *p, tb_key part, tb_key id, const op_key *path, size_t n, int ids, pl_namelist *out);

// the names at a path holding an id, and their ids, in their order there: one read of the children
// map whole, so any change to it reruns the reader (members); or the names the map holds, whatever
// they hold, one read of which names there are, so only a name added or taken out reruns the
// reader (list, its ids not told, left empty). Given contributors: list is every contributor's names,
// each once; members those names, then each name's step as pl_get takes it, with its from.
// nothing there: none. The caller's, pl_members_free
pl_members pl_members_at(pl *p, const char *const *path, size_t n);
pl_members pl_list(pl *p, const char *const *path, size_t n);

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
