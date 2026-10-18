// Nodes under keys of a part and an id (ermine/encoding/typescript/pack.ts), in C: written as one
// canonical CBOR item, {columns: <deflate of a map of columns>} (deflate.h; pack.ts's header lists
// the columns), and read back, that or the first form {keys: [[part, id, n], ...], nodes: [node,
// ...]}. Which nodes is the caller's; nothing is loaded or placed here. A node: {change, value?}; a
// change: {time, actor?, reader?, external?, metadata?, op?}; metadata a map, the header's entries
// (keys unique: the caller's to keep), read from the old form too, a list of [key, value] pairs (of
// a key repeated, the first). Same bytes as pack.ts.
//
// pack.c includes deflate.c, so whatever links pack.c has deflate too.
//
// SYMBOLS. A key with a symbol in it (table.h) cannot be carried: PK_CANNOT_CARRY, that key. An
// op_value has no symbol, so there is nothing to look for in a value.
//
// VALUES. A node's value, its actor, each metadata value and each patch's value are op_values
// (the header's actor and metadata values are void *: pack takes them as op_value *, and gives
// them back as such). A number in a header that C holds whole (time, a site's line and column, a
// path's keys, a range) is read only if it is one: a pack with another there is PK_NOT_A_PACK.
//
// Out of memory aborts, as elsewhere. Nothing recurses on a value's depth.
#ifndef PACK_H
#define PACK_H

#include "json.h"
#include "../../../core/table/c/table.h"
#include "../../../core/node/c/node.h"

#include <stdint.h>

typedef enum {
	PK_OK,
	PK_NOT_A_PACK,
	PK_NOT_A_NODE,
	PK_CANNOT_CARRY,
	PK_ALREADY_THERE,
} pk_code;
// the TypeScript code of a return: "not-a-pack", "not-a-node", "cannot-carry", "already-there";
// "" for PK_OK
const char *pk_code_name(pk_code code);

// a node under a key: what pack is given and unpack gives. A node under several keys is one node,
// the same pointer
typedef struct {
	tb_key part, id;
	const nd_entry *node;
} pk_entry;

// bytes being written; start at {0}. free(data) when done
typedef struct {
	uint8_t *data;
	size_t length, capacity;
} pk_bytes;

// how to write: zero is the default
typedef struct {
	int no_op; // a change's op (patches and undo) is not written
} pk_options;
// how to read: zero is the default
typedef struct {
	// in every map a key not known is passed over, not refused; none of it reaches a node. All else
	// stays strict
	int loosy;
	// the most bytes the columns may inflate to; more: PK_NOT_A_PACK. 0: the default, 1 GiB
	size_t limit;
} pk_reading;

// the entries as one item, appended to out. The same key twice with the same node is once; with
// two nodes: PK_ALREADY_THERE. A node that cannot be carried (a string that is not text, a key with a symbol, a header that is no change): PK_CANNOT_CARRY. For both, *at
// is the key at fault (the node's first key in the keys' order), if at is not NULL
pk_code pk_pack(const pk_entry *entries, size_t length, const pk_options *options, pk_bytes *out,
	const pk_entry **at);
// one node alone, as a pack writes each node, appended to out; PK_CANNOT_CARRY as above
pk_code pk_encode(const nd_entry *node, const pk_options *options, pk_bytes *out);

// what unpack or decode made: new nodes (nd_make_entry), all freed by pk_free. entries: in the keys'
// order, strings; nodes: one for each written, numbered in the order the keys first name them, so
// a node under several keys is one node; decode gives one node and no entries
typedef struct {
	pk_entry *entries;
	size_t length;
	nd_entry **nodes;
	size_t count;
	void *own; // what it allocated
} pk_read;

// only the canonical encoding is read, and exactly what pack writes: anything else, or a shape that
// is not a pack (a field missing or another, keys out of order or twice, nodes not numbered as first
// named): PK_NOT_A_PACK. Nothing is made then
pk_code pk_unpack(const uint8_t *bytes, size_t length, const pk_reading *reading, pk_read *out);
// one node back, as encode wrote it: out->nodes[0]. Anything else: PK_NOT_A_NODE
pk_code pk_decode(const uint8_t *bytes, size_t length, const pk_reading *reading, pk_read *out);
// what unpack or decode made, the nodes and what their headers refer to; no-op on {0}
void pk_free(pk_read *r);

// values as json.h holds them, for callers whose values are Json. pk_to_json: a fresh value, NULL
// when a stand-in has no kind
Json *pk_to_json(const op_value *v);
// a fresh op_value holding what j holds (a stand-in, bytes, a typed array too); j is not changed
op_value *pk_of_json(const Json *j);

#endif
