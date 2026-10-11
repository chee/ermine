// The blops of one node, each object's in a chain of its own, and which are its heads
// (newcore/sync/CHAIN.tex), in C. Same shape as chain.ts: blops already unsealed, no bytes, no
// signatures; patches only checked, through the check given (apply.h's).
//
// A blop is a json.h value (encoding/c/blop.h), its byte fields JSON_BYTES. Memory: a blop given
// to chain_add is kept, never changed or freed here: it must live as long as the chains do.
// Rows and lists given back are the caller's: chain_rows_free.
#ifndef CHAIN_H
#define CHAIN_H

#include "../../encoding/c/json.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct chains chains;

// step 7's: whether the blop's patches apply to its base's side
typedef bool (*chain_check)(void *context, chains *c, const Json *blop);

typedef enum {
	CHAIN_TAKEN,
	CHAIN_PASSED,
	CHAIN_WAITING, // names: the parents not taken in
	CHAIN_STUCK,   // names: the parents refused or stuck
	CHAIN_REFUSED, // refusal
} chain_kind;

typedef enum {
	CHAIN_NODE = 1,
	CHAIN_CHAIN,
	CHAIN_LAMPORT,
	CHAIN_PATCHES,
} chain_refusal;
// "node", "chain", "lamport", "patches"
const char *chain_refusal_name(chain_refusal refusal);

// what add answers, and a row of waiting or refused. name: the row's blop (not set by add)
typedef struct {
	uint8_t name[32];
	chain_kind kind;
	chain_refusal refusal;
	uint8_t (*names)[32];
	size_t count;
} chain_row;

typedef struct {
	uint8_t name[32];
	const Json *blop;
} chain_head;

// the chains of one node, empty
chains *chain_create(const char *node, chain_check check, void *context);
void chain_free(chains *c);
// the steps of CHAIN.tex, Adding; names: free with chain_row_free
chain_row chain_add(chains *c, const Json *blop, const uint8_t name[32]);
// the chain's heads in the agreed order; none: NULL, 0. object: "value" or ["info", name]...
size_t chain_heads(chains *c, const Json *object, chain_head **out);
// a blop taken in, or NULL
const Json *chain_get(chains *c, const uint8_t name[32]);
// sorted by name
size_t chain_waiting(chains *c, chain_row **out);
size_t chain_refused(chains *c, chain_row **out);
void chain_row_free(chain_row *row);
void chain_rows_free(chain_row *rows, size_t count);
// the caller's own pointer for a blop taken in, NULL at first; NULL when not taken in
void **chain_slot(chains *c, const uint8_t name[32]);

#endif
