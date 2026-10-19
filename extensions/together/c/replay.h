// A node's tables at a commit (extensions/together/typescript/replay.ts), in C: back along the bases
// to the newest snapshot (or the root), then forward, each commit decoded from its bytes and
// applied to its table in place as sync takes it (ls_applies, lists.h). Key patches on several
// parents, or a commit naming what it replaces: its tables are the lists' of it and its ancestors
// (ls_state); the walk starts there too. Everything built here is new:
// decoded from bytes, shared with nothing, so applying in place costs the patches, not the tables.
//
// Tables are entries (core/node/c/node.h): each table's value, and the change that last touched it,
// as the graph has a change header: time, actor, reader, external, metadata, then who signed the
// commit and the commit, ["signer", key] and ["commit", name] in hex (changeOf in replay.ts).
// The tables own what they refer to: the commits they were made from, the entries, a snapshot's
// read. Out of memory aborts
#ifndef RP_REPLAY_H
#define RP_REPLAY_H

#include "history.h"
#include "../../../ermine/encoding/c/pack.h"

#include <stdbool.h>
#include <stddef.h>

// a node's tables: table name and entry, in the order the tables came. Both are borrowed from the
// tables (rp_free lets them go); do not change the slots or the entries' headers
typedef struct {
	nd_slot *slots;
	size_t length;
	void *own;
} rp_tables;

// none; rp_free it
void rp_init(rp_tables *t);
void rp_free(rp_tables *t);
// the entry at a table, NULL when the tables have none
const nd_entry *rp_find(const rp_tables *t, const char *table);

typedef enum {
	RP_OK,
	RP_NOT_TAKEN, // no such commit taken in
	RP_PATCHES,   // a commit's bytes or patches that do not apply (which a history checked)
	RP_UNMERGED,  // a merge commit on the way, by a rule not given (or a walk that does not merge)
} rp_code;

// a table put in, everything copied: a new entry of the value (held), the table's name and the
// change (time, actor, reader, external, metadata; never its op) the tables' own
void rp_put_copy(rp_tables *t, const char *table, op_value *value, const ch_header *change);

// a table put in: a new entry of the value (held) and the change (borrowed: the caller keeps what it
// refers to alive), replacing the table's if it has one
void rp_put(rp_tables *t, const char *table, op_value *value, const ch_header *change);

// the tables of a snapshot's entries (pack.h), keyed by their part; takes *read (left empty). The
// snapshot's tables replace any the tables had
void rp_adopt(rp_tables *t, pk_read *read);

// a snapshot kept at a commit, if there is one: fills *out (empty, rp_init'd) with new tables
// and says so, or leaves it alone and says not
typedef bool (*rp_snapshots)(void *context, const uint8_t name[CM_NAME], rp_tables *out);

// the tables at several commits merged by a rule, or at one, when they are had without merging:
// fills *out (empty, rp_init'd) with new tables and says so, or leaves it alone and says not
typedef bool (*rp_get)(void *context, const hy_kept *const *from, size_t n, rp_tables *out);

// a merge rule (replay.ts's Merge): a node's heads' tables merged, the same on every device, into
// *out (empty, rp_init'd). merge's state NULL: the pure rule, which changes nothing it is given and
// keeps nothing. create (NULL when the rule has none): a state for one node's history that keeps the
// rule's work between merges (not pure), giving the same tables; free lets it go
typedef struct {
	const char *name;
	void (*merge)(void *state, const hy_history *h, const hy_kept *const *heads, size_t n, rp_get get,
		void *context, rp_tables *out);
	void *(*create)(void);
	void (*free)(void *state);
} rp_rule;
// a rule a device knows, and its state (NULL: merged purely)
typedef struct {
	const rp_rule *rule;
	void *state;
} rp_merge;
typedef struct {
	const rp_merge *list;
	size_t length;
} rp_merges;
// the rule of that name, or NULL. merges may be NULL (none)
const rp_merge *rp_merge_find(const rp_merges *merges, const char *name);

// the tables at name: RP_NOT_TAKEN when the history has not that commit; RP_UNMERGED when a merge
// commit on the way is by a rule not in merges (NULL: none). A rule is given what is had without
// merging (rp_plain), so a merge never waits on another. snapshots may be NULL
rp_code rp_replay(const hy_history *h, const uint8_t name[CM_NAME], rp_snapshots snapshots, void *context,
	const rp_merges *merges, rp_tables *out);
// whether a snapshot of the tables at name (packed, snapshot.h) from elsewhere is right: the tables
// replayed to it (from the snapshots given, each checked so itself) are the same (sn_alike). No
// snapshot is signed, so one is a hint, kept only when it matches (transport.c). false: not taken in,
// a merge on the way by a rule not given, or bytes that are no snapshot
bool rp_matches(const hy_history *h, const uint8_t name[CM_NAME], const uint8_t *bytes, size_t length,
	rp_snapshots snapshots, void *context, const rp_merges *merges);

// the tables a commit's own patches make, as its writer had them: on its base's tables (a merge's: on
// its rule's merge), whatever the lists say of it; a whole write's value (lists.h)
rp_code rp_written(const hy_history *h, const uint8_t name[CM_NAME], rp_snapshots snapshots, void *context,
	const rp_merges *merges, rp_tables *out);

// the tables at name when had without merging: a snapshot, or a walk back to one or the root that
// meets no merge commit; else RP_UNMERGED
rp_code rp_plain(const hy_history *h, const uint8_t name[CM_NAME], rp_snapshots snapshots, void *context,
	rp_tables *out);

// one commit applied to the tables in place; takes it (*commit is left empty) on RP_OK. RP_PATCHES:
// the patches do not apply; nothing changed, the commit still the caller's. name: the commit's, its
// change signed (rp_signed); NULL: the commit's header as it is
rp_code rp_apply(rp_tables *t, cm_commit *commit, const uint8_t name[CM_NAME]);
// a commit's change as the graph has it (changeOf in replay.ts, given the commit's name): its header,
// then ["signer", its key (a multikey)] and ["commit", name] after its metadata, both lowercase hex.
// What it adds is the tables' own; the rest is borrowed from change
const ch_header *rp_signed(rp_tables *t, const ch_header *change, const uint8_t *signer, size_t signer_length,
	const uint8_t name[CM_NAME]);
// rp_apply as sync takes the patches (ls_applies, lists.h): a key patch makes its missing parents, one
// under a value not a map is left out
rp_code rp_applies(rp_tables *t, cm_commit *commit, const uint8_t name[CM_NAME]);
// whether the commit's patches would apply to its table (ls_applies): nothing is changed, here or in
// the commit
bool rp_check(const rp_tables *t, const cm_commit *commit);

#endif
