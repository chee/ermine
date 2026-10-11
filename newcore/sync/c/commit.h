// A change made on this device as a blop (newcore/sync/COMMIT.tex), in C. Same shape as commit.ts:
// which parents, base and Lamport number, and what of the header leaves the device. Not sealed,
// not taken in: the blop only.
//
// A change and a blop are json.h objects (encoding/c/blop.h), their byte fields JSON_BYTES. The
// blop shares the change's values (node, object, actor, patches...): keep the change alive as long
// as the blop; the blop given back is the caller's, and never freed here. C has no live values
// (COMMIT.tex): a stand-in in the patches, actor or cause (JSON_STAND) goes through as data.
#ifndef COMMIT_H
#define COMMIT_H

#include "chain.h"

#include <stddef.h>
#include <stdint.h>

typedef enum {
	COMMIT_OK,
	COMMIT_RANGE, // no version there, or nothing to pop
} commit_code;
// "range"
const char *commit_code_name(commit_code code);

// where: a version (a number; the object with no versions: 0), a span [from, to), to not included,
// or versions popped (a number, or a span; a number n is [n, n + 1))
typedef enum { COMMIT_VERSION, COMMIT_SPAN, COMMIT_POP } commit_kind;
typedef struct {
	commit_kind kind;
	long from;
	long to; // a version's: from + 1
} commit_at;

// the host's n random bytes into out
typedef void (*commit_random)(void *context, size_t n, uint8_t *out);

// change: {node, object, patches, header: {actor, reader?, site?, cause?, ...}, signer}; roots: the
// source roots, strings. The blop, or NULL with *code set
Json *commit_make(chains *c, const Json *change, commit_at at, const char *const *roots,
	size_t count, commit_random random, void *context, commit_code *code);

#endif
