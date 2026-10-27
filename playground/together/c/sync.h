// sync.h: sync.ts in C. every entry change at a kept node (an ermine id, of any kind:
// ermine/ids; value, attributes and
// children unless told) goes out as one commit naming its table (commit.h); what comes in is
// written to the table (core/table/c/table.h). same rules as sync.ts.
//
// what a path holds is a list (lists.h): the table shows the first item at each path, composed. a
// commit on the one head shown, naming nothing it replaces: applied by update (core/changeable/c/update.h);
// any other: checked on a replay of its base (key patches alone never refused by what is there), then
// the table becomes the lists' composed, each table told only when it changes. a node with an open
// path has the "values" table at its id ({[table]: [{path, items: [{value? | gone?, inside?, at?,
// from: head}]}]}); "conflicts" lists each commit with an item not shown ([{head, lamport, actor,
// signer, time, external?, tables}]), "shown" the first head ({head, lamport, actor, signer, time,
// external?}; sync.ts's Head). a write goes on every head (key patches alone when there are several,
// or an edit of one version on its head, as base), replacing what the writer saw, or what its
// change's metadata "replaces" says ("all", or names in hex; never carried). What is wrong with a node's sync right now is in the "status"
// table at its id ({waiting, refused, unsent, count}, sync.ts's Status), none when nothing is: commits
// waiting (on parents, or on authority), refused (with the code), and writes no commit could carry.
// A change from elsewhere keeps who signed it and the commit, after its metadata (replay.h). a merge rule (replay.h): heads show merged; a write is then a
// merge commit; a merge by a rule not in merges is refused (HY_MERGE). sy_use switches the rule.
// ephemeral tables: an ephemeral commit on the stored state, never sealed or stored, one standing
// per device per table, shown on top; listed in the "ephemeral" table. stops standing at a later
// stored commit of that device or after ttl ms; resent every beat ms by sy_run.
// runs no scheduler, knows no places: the host calls sy_wrote and sy_table_changed; incoming
// changes on the head shown arrive through the commit callback, or with none, as the table's events
// (a new entry in the old one's place).
// memory: an entry sync makes is sync's, freed when it leaves the table or at sy_free; what its
// change refers to is kept until rewritten or gone; a host entry sync removes or replaces is given
// back through drop. out of memory aborts. one thread at a time.
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
	// (NULL: erm_host_now), and lazy: what the store holds is taken in as each document is followed, so
	// the table holds the followed documents and no other
	uint8_t seed[32];
	const ErmStore *store;
	bool lazy;
	// the device's lock (transport.h); NULL: lk_unlocked. borrowed
	const lk_lock *lock;
	tp_clock_fn now;
	void *clock;
	// NULL: erm_host_random
	sy_random_fn random;
	// NULL: the device's clock
	sy_time_fn time;
	// accepted and ignored: a tree id always ends in 16 zeros (ermine/ids' tree), which a Subduction
	// server with no Keyhive grant for a document stores
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
	// where the sites a commit carries are told from (copied): a site whose file starts with a root is
	// the rest after it (the first root it starts with), any other its last part (after the last "/");
	// line, column and function as they are. none: every file its last part
	const char *const *roots;
	size_t roots_length;
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

// a minted id's text, its NUL included: "ermine:" and a fresh id's 36 hex digits
#define SY_ID (7 + 36 + 1)
// a new kept id: a fresh ermine id (00 10 and 16 random bytes), its text
void sy_mint(sy_sync *s, char out[SY_ID]);
// what comes for this id is taken in (sync follows the ids it writes by itself). false: not an id
bool sy_follow(sy_sync *s, const char *id);
// after the host's write landed (places.commit): each change at a kept node's kept table, one commit.
// one that could not be encoded (a value with no encoding) is not sent, the rest are, and it is listed
// unsent in the node's status. CM_OK, or the first such refusal
cm_code sy_wrote(sy_sync *s, nd_entry *const *changed, size_t count);
// the table's event: an entry under (part, id) put or taken out whole
void sy_table_changed(sy_sync *s, tb_key part, tb_key id);
// a write on every head of what shows at each open path, replacing every item there (with a rule, the
// merge); change: who settled (NULL: none, stamped now)
cm_code sy_settle(sy_sync *s, const char *id, const ch_header *change);
// the node's tables at a commit (a version), new ones in *out; RP_NOT_TAKEN when it has no such commit
rp_code sy_get(sy_sync *s, const char *id, const uint8_t name[CM_NAME], rp_tables *out);

// the rule kept nodes merge by from now (one of merges), or none (NULL): every followed node with
// several heads shows again as the rule says (merged, or the first head and its conflicts). false: no
// such rule, nothing changed
bool sy_use(sy_sync *s, const char *merge);

// each ephemeral commit standing at the id (this device's too): its signer's key (a multikey) and its name, by key,
// then name; *out malloc'd (free it)
typedef struct {
	uint8_t key[SL_KEY];
	uint8_t tip[CM_NAME];
} sy_standing_row;
size_t sy_standing(sy_sync *s, const char *id, sy_standing_row **out);

// an ephemeral write is the start; this is the stop: this device's standing ephemeral commit at (id,
// table) ends now. Forgotten here (the stored shows again, no beat carries it), and a stop sent
// (tp_stop), on which every peer drops it at once rather than after ttl. Sent whether or not one stands
// (a receiver with nothing standing from this device at the table ignores it). Not an id, or not a
// kept table: nothing
void sy_stop(sy_sync *s, const char *id, const char *table);

// sends the beats due and drops the devices quiet past ttl, runs the device (tp_run), then works out
// the conflicts of what came in: the ms until it must run again (a beat or a ttl due too), as tp_run
int64_t sy_run(sy_sync *s);
// nothing left to take in, seal, store or send, no conflicts to work out
bool sy_idle(const sy_sync *s);

#endif
