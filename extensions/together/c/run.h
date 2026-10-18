// A run of sealed commits as columns: what a fragment carries (extensions/sync/typescript/run.ts),
// in C. One signature for a run of typing: a commit the next goes on alone, by the same signer, is
// vouched for by that one's signature, its own left out and its stored id in ids. Unpack gives back
// each commit's exact bytes, its stored id, and each signed one's sealed bytes; deterministic (the
// same commits in the same order give the same bytes on any device). Same bytes, and the same leniency
// on unpack, as run.ts: its header lists the columns and the order the checks run in. Numbers
// are worked out exactly up to 2^53 - 1; text positions count code points.
#ifndef RN_RUN_H
#define RN_RUN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	RN_OK,
	RN_NOT_A_RUN,   // not CBOR, not a map, or a key that is no column (that column named)
	RN_COUNT,       // n not a whole number
	RN_SIGNATURES,  // not a list of n byte strings
	RN_RUNS,        // a column of runs (table, actor, reader, external, metadata, signer, base, merge, headers): column named
	RN_DIFFERENCES, // a column of differences (time, nonce, lamport): column named
	RN_PARENTS,
	RN_PATCHES,
	RN_REF,         // a place not a whole number below the commit's own
	RN_INSERT,      // a string with no insert before it to go on from
	RN_IDS,         // ids not a list of 32-byte strings, one for each commit with no header
	RN_COMMIT,      // what the columns say for one is not a commit (commit.h)
	RN_VOUCHED,     // one with no header that the next does not go on alone by its signer, or the last
	RN_SIZE,        // the commits come to more than 64 times the run's bytes and a MiB
	RN_INPUT,       // pack was not given sealed commits (run.ts would throw): not a RunError
	RN_STOPPED,     // rn_each's each said stop: not a RunError
} rn_code;
// the TypeScript code of a return: "not-a-run", "count", "signatures", "runs", "differences",
// "parents", "patches", "ref", "insert", "ids", "commit", "vouched", "size"; "" for RN_OK, RN_INPUT
// and RN_STOPPED
const char *rn_code_name(rn_code code);

// a member of a run: a sealed commit's bytes (stored NULL), or a commit's bytes and its stored id, a
// commit vouched for by the next one in the run, held without a seal of its own
typedef struct {
	const uint8_t *bytes;
	size_t length;
	const uint8_t *stored;
} rn_item;

// the commits, in the run's order, as columns: *out malloc'd (free it). RN_INPUT: one is no sealed
// commit, or one that must be signed is given without its seal
rn_code rn_pack(const rn_item *sealed, size_t count, uint8_t **out, size_t *length);

// a commit a run gives back: its bytes, name and stored id; its sealed bytes when it is signed in the
// run (NULL: vouched for by the next)
typedef struct {
	const uint8_t *commit;
	size_t commit_length;
	uint8_t name[32], stored[32];
	const uint8_t *sealed;
	size_t sealed_length;
} rn_member;

// a run's commits back, each its exact bytes (the unpacked's own); rn_free it
typedef struct {
	rn_member *members;
	size_t count;
} rn_unpacked;
// refused with the first that says no; column: the column named, malloc'd, or NULL (free it; may be
// NULL itself)
rn_code rn_unpack(const uint8_t *bytes, size_t length, rn_unpacked *out, char **column);
void rn_free(rn_unpacked *u);
// the run's commits one at a time, in order, as they are made (run.ts's each): each is given each one
// (good for the call), and says whether to go on, so a reader can check each signature before the
// next is made; one vouched for comes just before the one that vouches for it. RN_STOPPED: each said
// stop; else as rn_unpack
typedef bool (*rn_each_fn)(void *context, const rn_member *member);
rn_code rn_each(const uint8_t *bytes, size_t length, rn_each_fn each, void *context, char **column);

#endif
