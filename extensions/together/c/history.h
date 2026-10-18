// One node's history (extensions/sync/typescript/history.ts), in C: its commits as their bytes, each
// taken in once its parents are, its heads in the agreed order, what waits on a parent and what is
// refused. No values: what a head holds is worked out from the bytes when asked (replay.h), so
// nothing here is ever shared with what changes.
//
// Taking a commit in: its bytes decoded (a commit's shape, commit.h), its parents all here and taken
// (else it waits), its lamport 1 + the highest of theirs (1 for a root: derived, never chosen), and
// check (the integration's: do its patches apply to its parent's node) says yes. A commit taken in
// releases what waited on it, in order, depth first, as history.ts does. One the check cannot judge
// yet waits on nothing named until hy_again. A commit refused for its shape releases nothing, as there. Out of memory
// aborts. Nothing recurses on how long a chain of waiting commits is.
#ifndef HY_HISTORY_H
#define HY_HISTORY_H

#include "../../../ermine/encoding/c/commit.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// merge: a merge commit by a rule this device doesn't know. HY_WAIT is no refusal: what a check
// gives for a commit it cannot judge yet (authority not here yet, say), which waits on the check
typedef enum { HY_SHAPE = 1, HY_LAMPORT, HY_PATCHES, HY_PARENT, HY_MERGE, HY_WAIT } hy_refusal;
// "shape", "lamport", "patches", "parent", "merge"; "" for HY_WAIT
const char *hy_refusal_name(hy_refusal refusal);

// what a commit is kept as: its bytes, and what ordering and replay read without decoding again.
// Owned by the history, good as long as it is (a commit is never let go of)
typedef struct {
	uint8_t name[32];
	uint8_t *bytes;
	size_t length;
	char *table;
	const uint8_t (*parents)[32];
	size_t parents_length;
	// the one its patches are over: the base, else the first parent; none for a root or a merge
	int has_base;
	uint8_t base[32];
	// a merge commit's rule (its patches are over the merge of its parents); NULL: none
	const char *merge;
	int64_t lamport;
} hy_kept;

typedef enum { HY_TAKEN, HY_PASSED, HY_WAITING, HY_REFUSED } hy_kind;
// what add answers. HY_WAITING: the names of the parents not taken in, in parents' order (waiting,
// waiting_length; hy_added_free); none: it waits on the check. HY_REFUSED: refusal. PASSED: it is
// here already
typedef struct {
	hy_kind kind;
	hy_refusal refusal;
	uint8_t (*waiting)[32];
	size_t waiting_length;
} hy_added;
void hy_added_free(hy_added *a);

// given a commit whose parents are all taken (its patches are borrowed, only to be read, and not
// changed), whether its patches apply to its parent's node (the integration's, which may apply
// them as it looks): 0 yes; else the refusal (HY_PATCHES: they don't apply; HY_MERGE: a rule not
// known here); HY_WAIT: it cannot judge it yet
typedef hy_refusal (*hy_check)(void *context, const hy_kept *kept, const cm_commit *commit);

typedef struct hy_history hy_history;
// check may be NULL: every commit's patches apply
hy_history *hy_create(hy_check check, void *context);
// how many commits it holds waiting (on a parent or the check), and refusals, at most (default no
// end): past it, the oldest waiting on a parent is let go of, as if never told (told again, it is
// judged again), and dropped is told its name (may be NULL); the oldest refusal is forgotten
void hy_limit(hy_history *h, size_t most, void (*dropped)(void *context, const uint8_t name[32]), void *context);
void hy_free(hy_history *h);

// the commit's bytes (copied): taken in, waiting, refused or passed. made: its commit and name,
// from whoever just encoded it (this device's own): not decoded or named again; the commit is
// borrowed for the call
typedef struct {
	const cm_commit *commit;
	uint8_t name[32];
} hy_made;
hy_added hy_add(hy_history *h, const uint8_t *bytes, size_t length, const hy_made *made);

// the heads, in the agreed order (higher lamport first; equal, the greater name): *out malloc'd, free
// it; the kept are the history's
size_t hy_heads(const hy_history *h, const hy_kept ***out);
// a commit taken in, or NULL
const hy_kept *hy_get(const hy_history *h, const uint8_t name[32]);
// every commit taken in, in the order taken: *out malloc'd, free it
size_t hy_all(const hy_history *h, const hy_kept ***out);
// a head taken in let go of, as if never told of it (its kept freed): its parents heads again where
// nothing else goes on them. false: not taken, or something goes on it
bool hy_forget(hy_history *h, const uint8_t name[32]);

// told each commit taken in, in the order taken, released ones too
typedef void (*hy_taken)(void *context, const hy_kept *kept);
void hy_on_taken(hy_history *h, hy_taken f, void *context);

// the commits waiting on the check judged again, in the order they came to wait; each keeps its
// place while it waits on
void hy_again(hy_history *h);

// a commit waiting, and the parents it waits on (none: on the check); refused, and why
typedef struct {
	uint8_t name[32];
	uint8_t (*waiting)[32];
	size_t waiting_length;
} hy_waiting_row;
typedef struct {
	uint8_t name[32];
	hy_refusal refusal;
} hy_refused_row;
// in the order they came / were refused: *out malloc'd, free it (hy_waiting_free for the first)
size_t hy_waiting(const hy_history *h, hy_waiting_row **out);
void hy_waiting_free(hy_waiting_row *rows, size_t count);
size_t hy_refused(const hy_history *h, hy_refused_row **out);

// a number no other history in the process has had: whether two are one, past one let go of
uint64_t hy_serial(const hy_history *h);

// the agreed order: higher lamport first; equal, the greater name. negative: a first
int hy_agreed(const hy_kept *a, const hy_kept *b);

// what a commit's tables follow from: a merge's parents, else its base (a commit with a base keeps
// what that one held, whatever its other parents did), else nothing (a root). Points into the kept
size_t hy_follows(const hy_kept *k, const uint8_t (**out)[32]);

// whether the tables at from (one commit's, or several merged) can be had
typedef bool (*hy_known)(void *context, const hy_kept *const *from, size_t n);
// the commits since heads' common ancestors, along follows (history.ts's since, its header the
// rules): *from (in the agreed order) and *commits (in causal order: lower lamport first, equal
// lamport the lesser name first), both malloc'd (free them), the kept the history's. known NULL:
// every start is known
void hy_since(const hy_history *h, const hy_kept *const *heads, size_t n, hy_known known, void *context,
	const hy_kept ***from, size_t *from_length, const hy_kept ***commits, size_t *commits_length);

#endif
