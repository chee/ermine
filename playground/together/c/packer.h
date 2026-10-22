// A pack of sealed commits as columns, in C (playground/together/typescript/packer.ts):
// it packs consecutive sealed commits for any stack to carry (a Subduction fragment is one use). One
// signature for a run of typing: a commit the next goes on alone, by the same signer, is
// vouched for by that one's signature, its own left out and its stored id in ids (only said: a reader
// that knows the id works it out and checks it, as the subduction stack's door does). Unpack gives back
// each commit's exact bytes, its stored id, and each signed one's sealed bytes; deterministic (the
// same commits in the same order give the same bytes on any device). Same bytes, and the same leniency
// on unpack, as packer.ts: its header lists the columns and the order the checks run in. Numbers
// are worked out exactly up to 2^53 - 1; text positions count code points.
#ifndef PKR_PACKER_H
#define PKR_PACKER_H

#include "../../../playground/encoding/c/commit.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	PKR_OK,
	PKR_NOT_A_PACK,   // not CBOR, not a map, or a key that is no column (that column named)
	PKR_COUNT,       // n not a whole number
	PKR_SIGNATURES,  // not a list of n byte strings
	PKR_RUNS,        // a column of runs (table, actor, reader, external, metadata, signer, base, merge, headers, id): column named
	PKR_DIFFERENCES, // a column of differences (time, nonce, lamport): column named
	PKR_PARENTS,
	PKR_PATCHES,
	PKR_REF,         // a place not a whole number below the commit's own
	PKR_INSERT,      // a string with no insert before it to go on from
	PKR_IDS,         // ids not a list of 32-byte strings, one for each commit with no header
	PKR_COMMIT,      // what the columns say for one is not a commit (commit.h)
	PKR_VOUCHED,     // one with no header that the next does not go on alone by its signer, or the last
	PKR_SIZE,        // the commits come to more than 64 times the pack's bytes and a MiB
	PKR_INPUT,       // pack was not given sealed commits (packer.ts would throw): not a PackError
	PKR_STOPPED,     // pkr_each's each said stop: not a PackError
} pkr_code;
// the TypeScript code of a return: "not-a-pack", "count", "signatures", "runs", "differences",
// "parents", "patches", "ref", "insert", "ids", "commit", "vouched", "size"; "" for PKR_OK, PKR_INPUT
// and PKR_STOPPED
const char *pkr_code_name(pkr_code code);

// a member of a pack: a sealed commit's bytes (stored NULL), or a commit's bytes and its stored id, a
// commit vouched for by the next one in the pack, held without a seal of its own
typedef struct {
	const uint8_t *bytes;
	size_t length;
	const uint8_t *stored;
} pkr_item;

// the commits, in the pack's order, as columns: *out malloc'd (free it). PKR_INPUT: one is no sealed
// commit, or one that must be signed is given without its seal
pkr_code pkr_pack(const pkr_item *sealed, size_t count, uint8_t **out, size_t *length);

// a commit a pack gives back: its bytes, name and stored id; its sealed bytes when it is signed in the
// run (NULL: vouched for by the next)
typedef struct {
	const uint8_t *commit;
	size_t commit_length;
	uint8_t name[CM_NAME], stored[32];
	const uint8_t *sealed;
	size_t sealed_length;
} pkr_member;

// a run's commits back, each its exact bytes (the unpacked's own); pkr_free it
typedef struct {
	pkr_member *members;
	size_t count;
} pkr_unpacked;
// refused with the first that says no; column: the column named, malloc'd, or NULL (free it; may be
// NULL itself)
pkr_code pkr_unpack(const uint8_t *bytes, size_t length, pkr_unpacked *out, char **column);
void pkr_free(pkr_unpacked *u);
// the pack's commits one at a time, in order, as they are made (packer.ts's each): each is given each one
// (good for the call), and says whether to go on, so a reader can check each signature before the
// next is made; one vouched for comes just before the one that vouches for it. PKR_STOPPED: each said
// stop; else as pkr_unpack
typedef bool (*pkr_each_fn)(void *context, const pkr_member *member);
pkr_code pkr_each(const uint8_t *bytes, size_t length, pkr_each_fn each, void *context, char **column);

#endif
