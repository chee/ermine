// The path cache (typescript/cache.ts), in C: get, entries, list and members as pl_get, pl_entries,
// pl_list and pl_members give them, each worked out once for a path and kept while someone reads
// it. Same rules as cache.ts, which the suites hold both to (places: 30-cache-fresh.json,
// 31-cache-equal-cut.json, 32-cache-teardown.json). A places without one is a places as it always
// was: nothing here is made or told.
//
//   pc_cache *c = pc_new(places, scheduler);   // after sc_on_untrack(s, pl_forget, places)
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
//     them (pc_entries), so a change to what is shadowed reruns no get
//   - kept while a run tracks one of its keys or another entry reads one (the scheduler's track and
//     untrack listeners, and a count of the entries reading each key); then it goes, and what it read
//     with it. A read outside any run keeps nothing: the entry is worked out, answered, and goes
//   - places' spots it reads are kept (pl_keep), so a run that stops reading a spot an entry reads
//     lets nothing go; the cache lets a spot go (pl_forget) once no entry reads it and no run tracks it
//
// The scheduler here has no first-track listener (cache.ts' onTrackingStart): sc_on_track is told
// each track, and the cache takes each as the first (a key known is known again). sc_on_untrack is
// onTrackingEnd. Open, as in cache.ts: every cache hears every mark and every track and untrack of
// its scheduler; made after runs have tracked spots, it does not know those runs track them, so make
// it with the places, before anything reads.
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
// every answer at a path, as pl_entries
pc_answers pc_entries(pc_cache *c, const char *const *path, size_t n);
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
