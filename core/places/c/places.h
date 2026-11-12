// places.h: the C version of places.ts. Owns none of the table, paths or scheduler it wires.
//   pl *p = pl_new();
//   tb_table *table = tb_new();
//   sc_scheduler *s = sc_new((sc_options){..});
//   sc_on_tracking_end(s, pl_forget, p);
//   pl_connect(p, &(pl_setup){tb_string("R"), table, paths, s});
//   pl_commit(p, &changed);  // after a change in place
//
// Returned values and names are borrowed from the table. Out of memory aborts.
//
// Answerers, as in places.ts. A contributor may answer reads (read) with what it holds for a part
// of a node, front first, nothing when it holds nothing. They are asked in the list's order. The
// table's own values sit where the contributor marked stored is (pl_children), or last with none
// marked: one before it is in front of the table, one after it behind.
//   pl_read_all   every answerer's items in that order, each with who answered (by)
//   pl_read       the first item an answerer in front holds, else the table's value; a gone item
//                 is nothing. The one marked stored and those behind are never asked: what they
//                 hold shows in pl_read_all only, the stored one's right after the table's.
// An answerer says what it holds has moved with pl_moved (places.ts's changed), which marks
// readers and tells no watch. pl_keys, pl_change and pl_read_here are the table's alone.
#ifndef PLACES_H
#define PLACES_H

#include <stddef.h>
#include <stdint.h>

#include "../../reactivity/c/paths.h"
#include "../../reactivity/c/scheduler.h"
#include "../../graph/c/table.h"
#include "../../graph/c/node.h"
#include "../../graph/c/update.h"
#include "../../../lib/crow/c/crow.h"
#include "crowify.h"

typedef struct pl pl;
pl *pl_new(void);
void pl_free(pl *p);
// A host should wire pl_crowify to the scheduler, or a folder held past a run can change.
cr_crow *pl_crow(pl *p);

// Where a walk has got to. gone: a bit per contributor (first 32) that need not be asked again.
typedef struct {
	tb_key id;
	int has_path;
	const char *const *path;
	size_t length;
	uint32_t gone;
} pl_here;

typedef struct {
	const char **items;
	size_t n, cap;
	int none;
} pl_namelist;
void pl_namelist_free(pl_namelist *list);

// One thing an answerer holds. from is the answerer's own account of where it is from (NULL:
// none). The answerer hands over one reference of value and of from (op_ref one it holds, or a
// new one); the list owns them.
typedef struct {
	const op_value *value;
	int gone;
	const op_value *from;
} pl_version;
typedef struct {
	pl_version *items;
	size_t n, cap;
} pl_versions;
void pl_versions_add(pl_versions *out, pl_version item);
void pl_versions_free(pl_versions *list);

// from must outlive the places. A contributor reads through the places it is handed.
typedef struct {
	const char *from;
	// 1 and *out, 0 if nothing is there (maybe deeper), PL_NONE if nothing is under it either.
	// NULL: it answers no names.
	int (*step)(void *ctx, const pl_here *here, const char *name, pl *reads, tb_key *out);
	void (*names)(void *ctx, const pl_here *here, pl *reads, pl_namelist *out);
	// Whether here + name is a level: no id, but names under it. NULL means never.
	int (*level)(void *ctx, const pl_here *here, const char *name, pl *reads);
	void *ctx;
	// What it holds for (part, id) at path, added to out front first; nothing added: not its.
	// Nonzero: the read failed, and pl_read_all stops there. NULL: it answers no reads.
	int (*read)(void *ctx, tb_key part, tb_key id, const op_key *path, size_t n, pl_versions *out);
	// The table's own values are read where this one is among the contributors.
	int stored;
} pl_contributor;
#define PL_NONE 2

tb_key pl_level(void);

typedef struct {
	tb_key root;
	tb_table *table;
	pt_paths *paths;
	sc_scheduler *scheduler;
	const pl_contributor *const *contributors;
	size_t ncontributors;
	int tracking;
	int64_t (*now)(void *ctx);
	void *now_ctx;
} pl_setup;
void pl_connect(pl *p, const pl_setup *setup);
tb_key pl_root(const pl *p);
const pl_contributor *const *pl_contributors(const pl *p, size_t *n);

// The one door for whole entries: write the table, then tell. Nothing is told when the entry is
// already there. pl_add returns 0 or tb_add's code, pl_del 0 or TB_NOTHING_THERE; on a code
// nothing changed or was told. Keys are borrowed for the call, and not the table's own copies.
int pl_add(pl *p, tb_key part, tb_key id, nd_entry *entry);
void pl_sub(pl *p, tb_key part, tb_key id, nd_entry *entry);
int pl_del(pl *p, tb_key part, tb_key id);
// A spot held by pl_keep is not released until its last keep is given back.
void pl_forget(const void *key, void *ctx);
void pl_tracking(const void *key, sc_run *run, void *ctx);

sc_track_status pl_status(pl *p);


typedef struct {
	size_t n;
	nd_entry *entries[2];
} pl_changed;

typedef enum { PL_NOT_A_NAME = 1, PL_NOTHING_THERE, PL_ALREADY_THERE } pl_code;
const char *pl_code_name(int code);

// Valid: any string except "", ".", ".." and "/".
int pl_is_name(const char *name);

void pl_own(pl *p, nd_entry *node);
// Like pl_own, but pl_sweep frees it once the table no longer holds it. Sweep after the pulse.
void pl_own_in(pl *p, nd_entry *node, tb_table *table);
void pl_sweep(pl *p);

// change and entry are NULL when the entry was taken out. Borrowed for the call only.
typedef struct {
	tb_key part;
	tb_key id;
	const op_patch *patches;
	size_t patches_length;
	const ch_header *change;
	const nd_entry *entry;
} pl_fact;

// After a write: marks the spots its patches touch, then tells each watch.
void pl_commit(pl *p, const pl_changed *changed);

typedef struct pl_watch pl_watch;
typedef void (*pl_watch_fn)(const pl_fact *fact, void *ctx);
pl_watch *pl_watch_all(pl *p, pl_watch_fn fn, void *ctx);
void pl_stop(pl_watch *w);

// A typed array element is made in scratch and returned (good until the next call; 64-bit
// elements come as doubles). NULL if nothing is there.
const op_value *pl_at(const op_value *v, const op_key *path, size_t n, op_value *scratch);
// Borrowed until the node changes. A typed array element is good until the next pl_read; a front
// answerer's value until the same spot is read again, or the places is freed.
const op_value *pl_read(pl *l, tb_key part, tb_key id, const op_key *path, size_t n);
// What the delete patch { path, range: [a, b] } would take out: a string, list or typed array of
// its own (a list shares its items), in *out for the caller to op_free. Tracked as pl_read is. It
// fails as that patch does: an OP_ code, *out NULL.
int pl_read_range(pl *l, tb_key part, tb_key id, const op_key *path, size_t n, int64_t a, int64_t b,
	op_value **out);
// A version and who gave it: by is the answerer's from ("table" for the table's with none marked
// stored). The table's item has its entry's change and no from; an answerer's has no change. Each
// item holds a reference of its value and from, let go by pl_showns_free.
typedef struct {
	const op_value *value;
	int gone;
	const op_value *from;
	const ch_header *change;
	const char *by;
} pl_shown;
typedef struct {
	pl_shown *items;
	size_t n, cap;
} pl_showns;
void pl_showns_free(pl_showns *list);
// Tracked as pl_read is. A gone item keeps its value. Returns the first answerer's failure (nonzero), asking none after it; out is to free either way.
int pl_read_all(pl *l, tb_key part, tb_key id, const op_key *path, size_t n, pl_showns *out);
// What an answerer holds for (part, id) has moved: marks its readers as pl_add does (patches
// NULL) or as pl_commit does for the patches, and tells no watch.
void pl_moved(pl *p, tb_key part, tb_key id, const op_patch *patches, size_t n);
const op_value *pl_read_here(pl *l, tb_key part, tb_key id, const op_key *path, size_t n);
const op_value *pl_a_map(void);
const ch_header *pl_change(pl *l, tb_key part, tb_key id);

typedef struct {
	tb_key part;
	tb_key id;
	const op_key *path;
	size_t length;
	int change;
	int keys;
} pl_where;
int pl_spot(const pl *l, const void *key, pl_where *out);


typedef struct {
	const void **items;
	size_t n, cap;
	size_t *index;
	size_t nindex, used;
} pl_set;
int pl_set_add(pl_set *set, const void *item);
int pl_set_has(const pl_set *set, const void *item);
int pl_set_del(pl_set *set, const void *item);
void pl_set_free(pl_set *set);

// Puts every read f makes into reads, telling no one. fresh gets spots that were new.
void pl_record(pl *p, void (*f)(void *ctx), void *ctx, pl_set *reads, pl_set *fresh);
void pl_peep(pl *p, void (*f)(void *ctx), void *ctx);
void pl_track(pl *p, const void *key);
// Takes (n 1) or gives back (n -1) a keep on a spot; returns the keeps left.
size_t pl_keep(pl *p, const void *key, int n);


typedef struct {
	const char *name;
	tb_key id;
	const char *from;
} pl_member;
typedef struct {
	size_t n;
	pl_member *items;
} pl_members;
void pl_members_free(pl_members *list);

// Stops where nothing is under a name; out has room for n; returns the steps taken. From an id
// that is not the root the path is unknown, so a contributor that goes by path has nothing.
size_t pl_walk(pl *p, tb_key from, const char *const *path, size_t n, pl_member *out);
size_t pl_walk_at(pl *p, const pl_here *from, const char *const *path, size_t n, pl_member *out);

typedef struct {
	tb_key id;
	const char *from;
} pl_answer;
typedef struct {
	size_t n;
	pl_answer *items;
	uint32_t gone;
} pl_answers;
void pl_answers_free(pl_answers *list);
pl_answers pl_answers_at(pl *p, const pl_here *here, const char *name);
// The root answers with itself, from "root".
pl_answers pl_gets(pl *p, const char *const *path, size_t n);

typedef struct {
	const char *name;
	const char *from;
} pl_named;
typedef struct {
	size_t n;
	pl_named *items;
	uint32_t gone;
} pl_nameds;
void pl_nameds_free(pl_nameds *list);
pl_nameds pl_names(pl *p, const pl_here *here);
int pl_get(pl *p, const char *const *path, size_t n, tb_key *out);
size_t pl_lookup(pl *p, const char *const *names, size_t nnames, const char *const *from,
	size_t nfrom, int all, size_t *depths);
void pl_keys(pl *p, tb_key part, tb_key id, const op_key *path, size_t n, int ids, pl_namelist *out);

// pl_members_at reads every name and what is at it. pl_list reads only which names there are (ids
// left empty). Both merge every contributor's names, each once.
pl_members pl_members_at(pl *p, const char *const *path, size_t n);
pl_members pl_list(pl *p, const char *const *path, size_t n);

op_value *pl_change_base(pl *l, const sc_pair *extra, size_t n);

typedef struct pl_made pl_made;
// site (NULL: none; CH_HERE: the caller's location) adds a frame. Free *made with pl_made_free
// or pl_hold. On failure returns a fresh error string and sets neither *out nor *made.
char *pl_header(pl *l, const sc_pair *extra, size_t n, const ch_location *site, ch_header *out,
	pl_made **made);
pl_made *pl_made_ref(pl_made *made);
void pl_made_free(void *made);
const op_value *pl_change_value(pl *l, const ch_header *h);

void pl_hold_also(pl *l, const nd_entry *node, void *block, void (*release)(void *block));
void pl_hold(pl *l, const nd_entry *node, void *block, void (*release)(void *block));

#endif
