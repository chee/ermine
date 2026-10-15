// The path cache (typescript/cache.ts), in C: get, gets, list and members as pl_get, pl_gets,
// pl_list and pl_members give them, each worked out once for a path and kept while someone reads
// it. Same rules as cache.ts, which the suites hold both to (places: 30-cache-fresh.json,
// 31-cache-equal-cut.json, 32-cache-teardown.json). A places without one is a places as it always
// was: nothing here is made or told.
//
//   pc_cache *c = pc_new(places, scheduler);   // after sc_on_tracking_end(s, pl_forget, places)
//   char *id = pc_get(c, path, n);             // in a run: the run tracks one key for the path
//   pc_free(c);                                // before sc_free: it takes its listeners away
//
// an entry: one question (at: every answer at a path; list; members) about one path, its answer,
// the keys its readers track and every key it read working it out.
//   - worked out when first asked, there and then, places' reads recorded into the entry (pl_record)
//     and told to no one, so the reader's run tracks only the entry's key. An entry at a path reads
//     its folder's entry, one step at a time, so a path's walk is shared by every path under it
//   - a key it read marked (the scheduler's mark listener, inside the write): worked out again, there
//     and then, so a read right after a write is fresh. Its key is marked, by the writer's run, only
//     when its answer changed (the equal cut); at has two keys, the first answer (pc_get) and all of
//     them (pc_gets), so a change to what is shadowed reruns no get
//   - kept while a run tracks one of its keys or another entry reads one (the scheduler's track and
//     untrack listeners, and a count of the entries reading each key); then it goes, and what it read
//     with it. A read outside any run keeps nothing: the entry is worked out, answered, and goes
//   - places' spots it reads are kept (pl_keep), so a run that stops reading a spot an entry reads
//     lets nothing go; the cache lets a spot go (pl_forget) once no entry reads it and no run tracks it
//   - it lets go only what it took itself: a spot it made (pl_record, fresh) is its own, one that was a
//     places' spot already (a run tracked it before the cache was made) is not, and is never let go by
//     it; once the runs tracking it end, while an entry reads it, it is the cache's to let go
//   - a cached answer reflects a write once it is committed: commit right after update
//
// The scheduler's sc_on_tracking_start and sc_on_tracking_end are cache.ts' onTrackingStart and
// onTrackingEnd. Open, as in cache.ts: every cache hears every first track and untrack of its
// scheduler; a mark only for the keys it holds (one listener per scheduler, selector.h's sx_index, tells
// each cache the marks of its own keys).
//
// An answer is the caller's: a copy, good after the entry is gone (the cache's own are kept as
// copies too, as a write can free the strings the table lent). The reads told (SC_STOP) are given by
// pl_status. Out of memory aborts.
#ifndef PLACES_CACHE_H
#define PLACES_CACHE_H

#include <stddef.h>

#include "places.h"

typedef struct pc_cache pc_cache;

// the places and the scheduler it is connected to (the places' own, and its untrack listener already
// there). Listens to the scheduler's marks, tracks and untracks
pc_cache *pc_new(pl *places, sc_scheduler *scheduler);
// takes its listeners from the scheduler (still alive) and frees everything; tells nothing
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
