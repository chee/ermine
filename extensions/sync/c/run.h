// A run of sealed commits as columns: what a fragment carries (extensions/sync/typescript/run.ts),
// in C. Lossless (unpack gives back each sealed commit's exact bytes) and deterministic (the same
// commits in the same order give the same bytes on any device). Same bytes, and the same leniency
// on unpack, as run.ts: its header lists the columns and the order the checks run in. Numbers
// are worked out exactly up to 2^53 - 1; text positions count code points.
#ifndef RN_RUN_H
#define RN_RUN_H

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
	RN_COMMIT,      // what the columns say for one is not a commit (commit.h)
	RN_INPUT,       // pack was not given sealed commits (run.ts would throw): not a RunError
} rn_code;
// the TypeScript code of a return: "not-a-run", "count", "signatures", "runs", "differences",
// "parents", "patches", "ref", "insert", "commit"; "" for RN_OK and RN_INPUT
const char *rn_code_name(rn_code code);

// bytes and how many
typedef struct {
	const uint8_t *bytes;
	size_t length;
} rn_item;

// the sealed commits (seal.h), in the run's order, as columns: *out malloc'd (free it). RN_INPUT:
// one is not a sealed commit
rn_code rn_pack(const rn_item *sealed, size_t count, uint8_t **out, size_t *length);

// a run's sealed commits back, each its exact bytes; rn_free it
typedef struct {
	uint8_t **sealed;
	size_t *lengths;
	size_t count;
} rn_unpacked;
// refused with the first that says no; column: the column named, malloc'd, or NULL (free it; may be
// NULL itself)
rn_code rn_unpack(const uint8_t *bytes, size_t length, rn_unpacked *out, char **column);
void rn_free(rn_unpacked *u);

#endif
