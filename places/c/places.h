// places.h: the C version of places.ts. Owns none of the table, paths or scheduler it wires.
//   pl *p = pl_new();
//   tb_table *table = tb_make(pl_event, p);
//   sc_scheduler *s = sc_new((sc_options){..});
//   sc_on_tracking_end(s, pl_forget, p);
//   pl_connect(p, &(pl_setup){tb_string("R"), table, paths, s});
//   pl_place(p, children, name, id, header, &changed);
//   pl_commit(p, &changed);
//
// Returned values and names are borrowed from the table. Out of memory aborts.
#ifndef PLACES_H
#define PLACES_H

#include <stddef.h>
#include <stdint.h>

#include "../../reactivity/c/paths.h"
#include "../../reactivity/c/scheduler.h"
#include "../../graph/c/table.h"
#include "../../graph/c/node.h"
#include "../../graph/c/update.h"
#include "../../crow/c/crow.h"
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

// from must outlive the places. A contributor reads through the places it is handed.
typedef struct {
	const char *from;
	// 1 and *out, 0 if nothing is there (maybe deeper), PL_NONE if nothing is under it either.
	int (*step)(void *ctx, const pl_here *here, const char *name, pl *reads, tb_key *out);
	void (*names)(void *ctx, const pl_here *here, pl *reads, pl_namelist *out);
	// Whether here + name is a level: no id, but names under it. NULL means never.
	int (*level)(void *ctx, const pl_here *here, const char *name, pl *reads);
	void *ctx;
} pl_contributor;
#define PL_NONE 2

tb_key pl_level(void);
extern const pl_contributor pl_children;

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
pl *pl_view(pl *p, tb_key root, const pl_contributor *const *contributors, size_t n);

void pl_event(void *ctx, tb_key part, tb_key id);
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

// Writes return 0 or a code, and on a code nothing changed. Strings are copied; header pieces
// are borrowed. A name that holds something is never written over.
int pl_place(pl *p, nd_entry *children, const char *name, tb_key id, ch_header header,
	pl_changed *changed);
int pl_unplace(pl *p, nd_entry *children, const char *name, ch_header header, pl_changed *changed);
int pl_rename(pl *p, nd_entry *children, const char *name, const char *to, ch_header header,
	pl_changed *changed);
// Two entries get one change each, the one it goes into first.
int pl_move(pl *p, nd_entry *from, const char *name, nd_entry *into, const char *to,
	ch_header header, pl_changed *changed);

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
// Borrowed until the node changes (a typed array element: until the next pl_read).
const op_value *pl_read(pl *l, tb_key part, tb_key id, const op_key *path, size_t n);
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

// pl_members_at reads the whole children map. pl_list reads only which names there are (ids
// left empty). Both merge every contributor's names, each once.
pl_members pl_members_at(pl *p, const char *const *path, size_t n);
pl_members pl_list(pl *p, const char *const *path, size_t n);

// Latest placed last. An entry already in the table when places was made is missing. Borrowed
// until the next write or table event.
typedef struct {
	tb_key folder;
	const char *name;
} pl_slot;
const pl_slot *pl_names_of(const pl *p, tb_key id, size_t *n);


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
