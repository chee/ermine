// The Subduction integration for the graph of today (extensions/sync/typescript/sync.ts), in C: every
// entry change at a kept node goes out as one commit naming its table (commit.h), and what comes in
// is written to the table (core/table/c/table.h). Kept: an ermine:// id, and only the tables given
// (value, attributes and children unless told). Same rules as sync.ts, whose header says why:
//
// the table is the head shown: its entries are that head's node. Coming in, a commit on the head
// shown is applied to its table's entry by update (core/node/c/update.h), which is its check too;
// any other (a fork, a merge) is checked on a replay of its parent's node (replay.h), and the table is
// told only if the head shown changes: then it holds the replay of the new head, whole. Several
// heads: the first in the agreed order shows; the others are listed in the "conflicts" table at the
// id ([{head, lamport, actor, tables}], head as hex), with the tables in which they differ. A write
// extends the head shown; sy_settle makes a merge keeping it.
//
// Given a merge rule (merge, one of merges, replay.h): several heads show merged by it, once the
// commits coming in now are all in, written to the table as a head switch is; no conflicts are listed.
// A write then is a merge commit: every head it showed its parents, the rule named, its patches
// against the merge. Nothing merges by itself: only a write, or a settle, makes a merge commit. A merge
// commit coming in is checked on its rule's merge of its parents (on the table, when that is what it
// shows); one by a rule not in merges is refused (HY_MERGE). A rule with create keeps a state per node
// while it is in use (eg-walker's walker). sy_use switches the rule, or merging off, while running.
//
// Ephemeral (sync.ts's header says the rules): a change to a table the host says is ephemeral goes
// out as an ephemeral commit on what a stored write goes on (never on another ephemeral one), its
// patches taking that stored state to what the device shows; never sealed, never stored. Each stands
// alone, in place of its device's previous one at its table. The table shows the stored heads and, for
// each table, the later standing one on top (with a rule, all merged by it); the stored entries under
// are sync's own, and the "ephemeral" table at the id ({under: {table: value}, on: [{by, name,
// tables, lamport}]}, by and name as hex, the later last) lists them and what stands while anything
// does. A device's ephemeral commits stop standing when a stored commit of its follows them, or after
// ttl ms with nothing heard from it; this device's standing ones are sent again every beat ms, by
// sy_run on the device's clock. One that stands no more is let go of (tp_forget). Nothing ephemeral
// outlives the sync.
//
// It runs no scheduler and knows no places: the host hands it its writes (sy_wrote, after places'
// commit, with the change headers they carry) and its table's events (sy_table_changed), and is told
// through the commit callback what came in on the head shown, as its patches (places.commit).
//
// Memory, which TypeScript's collector does: an entry sync makes is sync's, freed when it leaves the
// table (by sync, or by the host: sync sees the table's event) or at sy_free. What an entry's change
// refers to when sync wrote it (a commit decoded, a header) sync keeps until it writes that entry's
// change again or the entry leaves the table. An entry of the host's that sync takes out of the table
// or replaces is given back through drop. Out of memory aborts. One thread at a time
#ifndef SY_SYNC_H
#define SY_SYNC_H

#include "transport.h"
#include "../../../core/table/c/table.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct sy_sync sy_sync;

// the host's "a write landed" (places.commit): what came in on the head shown, as its patches
typedef void (*sy_commit_fn)(void *context, nd_entry *const *changed, size_t count);
// an entry of the host's that sync took out of the table, or replaced: the host's to let go of
typedef void (*sy_drop_fn)(void *context, nd_entry *entry);
// n random bytes (n at most 32)
typedef void (*sy_random_fn)(void *context, uint8_t *out, size_t n);
// the time now, whole seconds since 1970: what sync stamps itself (a change with no time, a removal,
// a settle with no change, the conflicts table)
typedef int64_t (*sy_time_fn)(void *context);
// whether a change to (a kept id, a kept table) goes out as an ephemeral commit; asked at each write
typedef bool (*sy_ephemeral_fn)(void *context, const char *doc, const char *table);

typedef struct {
	tb_table *table;
	// the device's (transport.h): its key and signer, where Subduction keeps what it saves, its clock
	// (NULL: erm_host_now)
	uint8_t seed[32];
	const ErmStore *store;
	tp_clock_fn now;
	void *clock;
	// NULL: erm_host_random
	sy_random_fn random;
	// NULL: the device's clock
	sy_time_fn time;
	// until Keyhive: ids minted with their last 16 bytes zero, which a Subduction server with no
	// Keyhive grant for a document stores. Such an id binds no lock
	bool zeros;
	// the tables kept (copied); none: value, attributes and children
	const char *const *tables;
	size_t tables_length;
	// the merge rules this device knows (copied, the rules borrowed: static ones), and the one every
	// kept node merges by (NULL: none; the first head shows, writes extend it, the others are conflicts)
	const rp_rule *const *merges;
	size_t merges_length;
	const char *merge;
	// NULL: never ephemeral
	sy_ephemeral_fn ephemeral;
	// ms between sending a standing ephemeral commit of this device's again (0: 1000); ms with nothing
	// heard from a device before its ephemeral commits stop standing (0: 4000)
	uint64_t beat, ttl;
	// either may be NULL
	sy_commit_fn commit;
	sy_drop_fn drop;
	void *context;
} sy_options;

// NULL when Subduction will not make a node, or merge is not one of merges
sy_sync *sy_create(const sy_options *options);
// lets go of the device and of everything sync holds, the entries it made too, in the table or not:
// take the table down after, or take sync's entries out of it first
void sy_free(sy_sync *s);
tp_device *sy_device(sy_sync *s);

// a new kept id: "ermine://" and 64 hex digits
void sy_mint(sy_sync *s, char out[9 + 64 + 1]);
// what comes for this id is taken in (sync follows the ids it writes by itself). false: not an id
bool sy_follow(sy_sync *s, const char *id);
// after the host's write landed (places.commit): each change at a kept node's kept table, one commit.
// CM_OK, or the first refusal of one that could not be encoded (a value with no encoding)
cm_code sy_wrote(sy_sync *s, nd_entry *const *changed, size_t count);
// the table's event: an entry under (part, id) put or taken out whole
void sy_table_changed(sy_sync *s, tb_key part, tb_key id);
// a merge of every head, keeping what shows (with a rule, the merge); change: who settled (NULL: none,
// stamped now)
cm_code sy_settle(sy_sync *s, const char *id, const ch_header *change);
// the node's tables at a commit (a version), new ones in *out; RP_NOT_TAKEN when it has no such commit
rp_code sy_get(sy_sync *s, const char *id, const uint8_t name[32], rp_tables *out);

// the rule kept nodes merge by from now (one of merges), or none (NULL): every followed node with
// several heads shows again as the rule says (merged, or the first head and its conflicts). false: no
// such rule, nothing changed
bool sy_use(sy_sync *s, const char *merge);

// each ephemeral commit standing at the id (this device's too): its signer's key (a multikey) and its name, by key,
// then name; *out malloc'd (free it)
typedef struct {
	uint8_t key[SL_KEY];
	uint8_t tip[32];
} sy_standing_row;
size_t sy_standing(sy_sync *s, const char *id, sy_standing_row **out);

// sends the beats due and drops the devices quiet past ttl, runs the device (tp_run), then works out
// the conflicts of what came in: the ms until it must run again (a beat or a ttl due too), as tp_run
int64_t sy_run(sy_sync *s);
// nothing left to take in, seal, store or send, no conflicts to work out
bool sy_idle(const sy_sync *s);

#endif
