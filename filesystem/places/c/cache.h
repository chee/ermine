// cache.h: cache.ts in C. pl_get, pl_gets, pl_list, pl_members worked out once per path and kept
// while read. suites: places 30-cache-fresh, 31-cache-equal-cut, 32-cache-teardown. a places
// without one is unchanged.
//
//   pc_cache *c = pc_new(places, scheduler);   // after sc_on_tracking_end(s, pl_forget, places)
//   char *id = pc_get(c, path, n);             // in a run: the run tracks one key for the path
//   pc_free(c);                                // before sc_free: its listeners taken away, its spots given back
//
// an entry: one question (at, list, members) about one path, its answer, its keys, what it read.
// worked out when first asked (pl_record), a path's entry reading its folder's. a read key marked:
// worked out again at once; its own key marked only when the answer changed (equal cut). at has
// three keys: first answer (pc_get), all (pc_gets), contributors gone under it. kept while a run
// tracks it or another entry reads it (clingy.h); a read outside any run keeps nothing. spots it
// reads are pl_keep'd; it pl_forgets only spots it made or inherited once no run tracks them.
// commit right after update for a cached answer to see a write. sc_on_tracking_start/_end are
// cache.ts' onTrackingStart/onTrackingEnd.
// answers are the caller's copies. reads told (SC_STOP): pl_status. out of memory aborts.
// open: every cache hears every first track and untrack of its scheduler (marks: only its own
// keys, sx_index)
#ifndef PLACES_CACHE_H
#define PLACES_CACHE_H

#include <stddef.h>

#include "places.h"

typedef struct pc_cache pc_cache;

// the places and the scheduler it is connected to (the places' own, and its untrack listener already
// there). Listens to the scheduler's marks, tracks and untracks
pc_cache *pc_new(pl *places, sc_scheduler *scheduler);
// takes its listeners from the scheduler (still alive), gives back the spots it keeps (letting go
// those it took that no run tracks) and frees everything; tells nothing
void pc_free(pc_cache *c);

// the id at a path: a copy for the caller to free, NULL: nothing there. The root: its id
char *pc_get(pc_cache *c, const char *const *path, size_t n);

typedef struct {
	char *id;
	// the contributor's own name ("root" for the root)
	const char *from;
} pc_answer;
typedef struct {
	size_t n;
	pc_answer *items;
} pc_answers;
// every answer at a path, as pl_gets
pc_answers pc_gets(pc_cache *c, const char *const *path, size_t n);
void pc_answers_free(pc_answers *list);

typedef struct {
	size_t n;
	char **items;
} pc_names;
// the names at a path, as pl_list
pc_names pc_list(pc_cache *c, const char *const *path, size_t n);
void pc_names_free(pc_names *list);

typedef struct {
	char *name;
	// NULL: a level, no id
	char *id;
	// NULL: none given
	const char *from;
} pc_member;
typedef struct {
	size_t n;
	pc_member *items;
} pc_members;
// the members at a path, as pl_members_at
pc_members pc_members_at(pc_cache *c, const char *const *path, size_t n);
void pc_members_free(pc_members *list);

// what it keeps: entries, and the keys they read
typedef struct {
	size_t entries, reads;
} pc_kept;
pc_kept pc_kept_of(const pc_cache *c);

#endif
