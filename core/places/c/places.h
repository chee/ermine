// places.h: places.ts in C. the filesystem, and the connections between the table, the tracked
// paths and the scheduler; makes none of them, wraps none of their calls. suite:
// core/places/conformance/places/.
//
//   pl *p = pl_new();                                  // only itself: it is the ctx of the hooks
//   tb_table *table = tb_make(pl_event, p);
//   sc_scheduler *s = sc_new((sc_options){..});
//   sc_on_tracking_end(s, pl_forget, p);
//   pl_connect(p, &(pl_setup){tb_string("R"), table, paths, s});
//   pl_place(p, children, name, id, header, &changed); // a write
//   pl_commit(p, &changed);                            // said written
//
// filesystem: a children entry maps names to ids; a name is any string but "", ".", "..", "/".
// a read is told to the scheduler as a spot (paths.h); outside a run it counts for nothing. a write
// marks the spots its patches touch; a table event, its key's. reads told (SC_STOP): pl_status.
// children are written through one unread (pl_unread): a burst of writes to a folder costs one copy.
// a spot: (source, id); each table part gets one pair, made once, the same address always. spots
// unread are let go by pl_forget; one read outside a run is never let go.
// contributors (contributors.org): children (pl_children) plus any given, asked in order per step:
// first answer is pl_get, all are pl_gets, names merged once each (pl_list, pl_members). a
// contributor reads only through pl_read, pl_keys, pl_track. caches: pl_record, pl_keep (cache.h);
// commit right after update.
// pruning: PL_NONE at a step means nothing there or under it; the walk asks no more there, and that
// read is the one tracked.
// pl_view: the same places from another root with its own contributors, everything else shared.
// pl_spot: names a held spot as a place; anything else none.
// change base: levels, innermost first: extra (if any), the scope open, its parents (sc_scope_parent) to
// the root. values are op_values, except a scope's "run" and "mark" (uint64_t, given as numbers).
// actor: the first "actor" over all levels; reader: the first string "reader". metadata: the
// levels merged into one map, inner keys over outer, up to and with the first scope whose own pairs
// hold PL_NODE; none: every level. no scope open: unscoped.
// memory: a header (pl_header) refers to a pl_made block; its node holds it until its next update
// (pl_hold, pl_hold_also). read values and listed names are borrowed from the table. out of memory
// aborts.
#ifndef PLACES_H
#define PLACES_H

#include <stddef.h>
#include <stdint.h>

#include "../../../core/scheduler/c/paths.h"
#include "../../../core/scheduler/c/scheduler.h"
#include "../../../core/table/c/table.h"
#include "../../../core/node/c/node.h"
#include "../../../core/changeable/c/update.h"
#include "../../../core/unread/c/unread.h"

typedef struct pl pl;
// only the places, so that it can be the ctx of the hooks below
pl *pl_new(void);
// its watches stopped, and it let go; with the last of a places and its views (pl_view), the holds,
// the pairs and what is open; none of what it was connected to
void pl_free(pl *p);
// the one unread (core/unread) children writes go through (pl_place and the rest), shared by its views, let
// go of with the last of them. It lets go only of what it is told is held: a host wires un_keeping to the
// scheduler, and un_read on an entry it hands on. Unwired, a folder held past a run changes under its holder
un_unread *pl_unread(pl *p);

// where a walk has got to: the id it is at, its path (the names from the root to it), and gone: the
// contributors that said none at it or above, never asked under it: a bit each, by its place in the
// asker's list (the first 32; any after are always asked). no path (has_path 0): a walk from an id
// alone, where it is from the root not known. gone 0: none
typedef struct {
	tb_key id;
	int has_path;
	const char *const *path;
	size_t length;
	uint32_t gone;
} pl_here;

// names, borrowed (from the table, or the contributor's own); the caller's, pl_namelist_free. none:
// the contributor said none (no names, here or anywhere deeper)
typedef struct {
	const char **items;
	size_t n, cap;
	int none;
} pl_namelist;
void pl_namelist_free(pl_namelist *list);

// what answers one step. from: what it is called, the from of each answer it gives (a string that
// outlives the places). A contributor reads through the places it is handed (pl_read, pl_keys,
// pl_track): told as places tells its own, so in a run the run tracks them, and marks a key of its own
// itself when it changes
typedef struct {
	const char *from;
	// the id it has at here + name: 1 and *out; nothing there (maybe deeper): 0; nothing there or
	// anywhere under it: PL_NONE
	int (*step)(void *ctx, const pl_here *here, const char *name, pl *reads, tb_key *out);
	// the names it has directly under here, in its order: each one step answers, or a level of its
	// own, added to out. none (out->none set): no names, here or anywhere deeper
	void (*names)(void *ctx, const pl_here *here, pl *reads, pl_namelist *out);
	// whether here + name is a level of its own: no id, but names under it, so a walk goes on through it
	// as if it were a folder (the walk, in places.c). NULL: never
	int (*level)(void *ctx, const pl_here *here, const char *name, pl *reads);
	void *ctx;
} pl_contributor;
// a step's answer: nothing at here + name, nor anywhere under it (see PRUNING)
#define PL_NONE 2

// the key of the pair naming a scope's node (its value: the id, an op_value string): a write's
// metadata stops at the first scope holding one. the one spelling: use this, never the string
#define PL_NODE "node"
// the id a walk is at on a level: not an id of any entry, so never given as an answer (pl_get: nothing
// there)
tb_key pl_level(void);
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
	// 1: pl_tracking is the scheduler's tracking-start listener (sc_on_tracking_start), so a spot read
	// outside any run, which no run has tracked since, is let go of as a write reaches it (paths.ts:
	// lazily, a spot a mark gives back with no readers). 0: such a spot is kept, as before
	int tracking;
} pl_setup;
// once: before anything is read or written
void pl_connect(pl *p, const pl_setup *setup);
// where names start
tb_key pl_root(const pl *p);
// the contributors given (*n of them; the array the setup's or view's); none given: NULL, children
// alone, and *n 0
const pl_contributor *const *pl_contributors(const pl *p, size_t *n);
// the same places from another root, asked by contributors of its own (the array kept, the
// caller's, as are the contributors and root's string; none: children alone): one set of spots,
// keeps, holds and watches, one commit (pl_commit on either) and one table hook (pl_event on either)
// with p, so whoever writes tells it nothing more. A box's places (ermine/boxes). Its watches find
// their path from its root. Let go by pl_free on it, before or after p's (what they share goes with
// the last)
pl *pl_view(pl *p, tb_key root, const pl_contributor *const *contributors, size_t n);

// hooks, ctx the pl
// the table's (tb_event): a table event says changed every spot of its key
void pl_event(void *ctx, tb_key part, tb_key id);
// the scheduler's untrack listener (sc_on_tracking_end): a key that is one of this places' spots is released; any other is left alone.
// A spot kept (pl_keep) is not released: whoever keeps it calls this once its last keep is given back
void pl_forget(const void *key, void *ctx);
// the scheduler's tracking-start listener (sc_on_tracking_start), with setup.tracking: one of this
// places' spots is tracked by a run, so not loose
void pl_tracking(const void *key, sc_run *run, void *ctx);

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
// pl_upsert, the write (on an entry there) through pl_unread's un_update: for an entry the caller
// means changed in place until read, as ermine/processes' trie
int pl_upsert_unread(pl *p, tb_key part, tb_key id, const char *const *path, size_t n,
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
// the same, let go of sooner: once table holds it no more (taken out, or another put in its
// place), pl_sweep frees it, and its holds, as the reference's table lets go of an entry taken
// out (one nothing references) [chee 10-26: the C should "garbage collect" via something like a
// weakmap]. a value read of it is borrowed till the node changes, so a sweep comes after the
// pulse
void pl_own_in(pl *p, nd_entry *node, tb_table *table);
// the entries pl_own_in gave that their table holds no more, let go of; at most once as many are
// owned again as the last sweep left (and 64 more). for a pulse's end: nothing may hold one then
void pl_sweep(pl *p);

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
// every fact, anywhere, told to fn as it lands (a commit's, a table event's), after the mark and
// before the watches at paths: what a run wrote, for runs.h. Stopped with pl_stop
pl_watch *pl_watch_all(pl *p, pl_watch_fn fn, void *ctx);

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
// the change spot, reads of the change itself, no path; keys: a read of which names there are at
// path, not what is under them (pl_keys). The places' and paths' own, good while the spot is held
typedef struct {
	tb_key part;
	tb_key id;
	const op_key *path;
	size_t length;
	int change;
	int keys;
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
// no one: what a cache works out outside any run. inside another record or a peep, apart from it. fresh (or
// NULL): the spots f read that were not this places' before, so nothing else tracks or keeps them
void pl_record(pl *p, void (*f)(void *ctx), void *ctx, pl_set *reads, pl_set *fresh);
// f(ctx), with every read it makes untracked: no spot made, nothing told or recorded (a contributor's
// pl_track too), the values only. nothing a write there marks reruns it
void pl_peep(pl *p, void (*f)(void *ctx), void *ctx);
// a key of a contributor's own: told to the scheduler (the status as of any read), or while recording,
// put into the set
void pl_track(pl *p, const void *key);
// a keep on one of this places' spots taken (n 1) or given back (n -1): the keeps left. a kept spot
// is not let go by pl_forget; the keeper calls it once its last keep is given back and no run tracks
// the spot. Anything else: 0, nothing kept
size_t pl_keep(pl *p, const void *key, int n);

// the filesystem, every read told ---------------------------------------------------------------

// a name in a children entry, and the id under it (a contributor's level: pl_level(), no id of its
// own). The name is borrowed from the table
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
// contributors, each step is the first answer, with its from (the gone not asked); from an id that is
// not the root, the path is not known, so a contributor going by path has nothing. pl_walk_at: from
// a here, its gone too
size_t pl_walk(pl *p, tb_key from, const char *const *path, size_t n, pl_member *out);
size_t pl_walk_at(pl *p, const pl_here *from, const char *const *path, size_t n, pl_member *out);

// an answer at a path, and the contributor that gave it
typedef struct {
	tb_key id;
	const char *from;
} pl_answer;
// gone: the contributors gone under here + name (here's, and those that said none), for a walk on
// from there
typedef struct {
	size_t n;
	pl_answer *items;
	uint32_t gone;
} pl_answers;
void pl_answers_free(pl_answers *list);
// every answer at here + name, in the contributors' order (but here's gone)
pl_answers pl_answers_at(pl *p, const pl_here *here, const char *name);
// every answer at a path: the walk to the folder it is in (a level too), then every contributor asked
// its name. The root: itself, from "root". Nothing there, or a level: none
pl_answers pl_gets(pl *p, const char *const *path, size_t n);

// a name at a path, and the first contributor that gives it
typedef struct {
	const char *name;
	const char *from;
} pl_named;
// gone: the contributors gone under here (here's, and those whose names said none), for a walk of
// each name from there
typedef struct {
	size_t n;
	pl_named *items;
	uint32_t gone;
} pl_nameds;
void pl_nameds_free(pl_nameds *list);
// the names under here, every contributor's in order (but here's gone), each name once: from the
// first that gives it
pl_nameds pl_names(pl *p, const pl_here *here);
// the id at a path from the root; 1 and *out, or 0: nothing there, or a level
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
// each once; members those names, then each name's step as pl_get takes it, with its from (a level:
// the id pl_level(), no id of its own). At a level (no id, names under it), list and members read
// under it as under a folder. nothing there: none. The caller's, pl_members_free
pl_members pl_members_at(pl *p, const char *const *path, size_t n);
// (lib.ts' list is an iterator, a generator; C has none, so this returns the array)
pl_members pl_list(pl *p, const char *const *path, size_t n);

// the names a node has now: every children entry's, as {folder, name}, the latest placed last (the
// reverse of children, kept up from table events and commits: an entry already in the table when
// places is made is not in it). n of them; none: NULL, 0. Borrowed: good until the next write or
// table event
typedef struct {
	tb_key folder;
	const char *name;
} pl_slot;
const pl_slot *pl_names_of(const pl *p, tb_key id, size_t *n);

// change base -----------------------------------------------------------------------------------

// the change base the scope open makes, extra (n pairs) its innermost level: a map of actor and
// reader where there are some, and metadata (a map; see change base above). New, the
// caller's to op_free. NULL: no scope open
op_value *pl_change_base(pl *l, const sc_pair *extra, size_t n);

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
// a header pl_header made, as a value: {time, actor, reader, external, metadata}, not its op. made
// once a header, the first time asked, and shared: borrowed, good while the header's block is
// (op_ref it to keep it). a header it didn't make, or one changed since: NULL
const op_value *pl_change_value(pl *l, const ch_header *h);

// keeps something alive for the node's change to refer to (a header's block, a write's patches):
// release(block) is called when the next pl_hold for the same node comes, or at pl_free. _also
// adds a block to those the node holds already, all let go together
void pl_hold_also(pl *l, const nd_entry *node, void *block, void (*release)(void *block));
void pl_hold(pl *l, const nd_entry *node, void *block, void (*release)(void *block));

#endif
