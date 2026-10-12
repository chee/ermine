// A graph from a root, as bytes (newcore/encoding/PACK.tex), in C. Same shape as pack.ts: one canonical CBOR item,
// {root, nodes, missing}. Values (content outside lists, change, because, actor, cause) are the
// caller's: written and read by its codec, never read here.
#ifndef PACK_H
#define PACK_H

#include "../../nodes/c/node.h"

typedef enum {
	PK_OK,
	PK_NOTHING_THERE,
	PK_CANNOT_CARRY,
	PK_NOT_A_GRAPH,
	PK_NOT_A_NODE,
	PK_NO_MEMORY,
} pk_code;

// the node of an id, or NULL if it is not loaded
typedef const nd_node *(*pk_get)(void *context, const char *id);

// bytes being written; start at {0}; failed: out of memory. free(data) when done
typedef struct {
	uint8_t *data;
	size_t length, capacity;
	int failed;
} pk_bytes;
void pk_put(pk_bytes *b, const void *data, size_t length);

// which field a value is in: each may be a different type of the caller's
typedef enum { PK_CONTENT, PK_CHANGE, PK_BECAUSE, PK_ACTOR, PK_CAUSE } pk_field;

typedef struct {
	// writes one CBOR item for value, in field; nonzero: it cannot be carried
	int (*encode)(void *context, pk_field field, const void *value, pk_bytes *out);
	// a value for field from the one CBOR item at item, length long; nonzero: not one it reads.
	// What it gives is the caller's, kept after pk_free. Give non-NULL: NULL is not there
	int (*decode)(void *context, pk_field field, const uint8_t *item, size_t length,
		const void **value);
	void *context;
} pk_codec;

// root: the id walked from; nodes: the root first, then in the order reached; missing: ids in a
// list reached but not loaded, in the order reached
typedef struct {
	const char *root;
	const nd_node **nodes;
	size_t length;
	const char **missing;
	size_t missing_length;
	void *own; // unpack's: what it allocated, the nodes too
} pk_graph;

// the root and every node reachable from it, by any version of any list; nodes and ids are the
// get's. root not loaded: PK_NOTHING_THERE
pk_code pk_walk(const char *root, pk_get get, void *context, pk_graph *out);
// the walk as one CBOR item, appended to out. A symbol in a list, or a value the codec cannot
// encode: PK_CANNOT_CARRY, *id the node's (id may be NULL)
pk_code pk_pack(const char *root, pk_get get, void *context, const pk_codec *codec,
	pk_bytes *out, const char **id);
// new nodes, by nd_make, headers as written. Only the canonical encoding is read (ENCODING.tex:
// shortest heads, definite lengths, floats not integers, keys in order); anything else, or a shape
// that is not a graph: PK_NOT_A_GRAPH
pk_code pk_unpack(const uint8_t *bytes, size_t length, const pk_codec *codec, pk_graph *out);
// one node alone, as a graph's nodes are written, appended to out. A symbol in a list, or a value
// the codec cannot encode: PK_CANNOT_CARRY
pk_code pk_encode(const nd_node *node, const pk_codec *codec, pk_bytes *out);
// the node back, as encode wrote it: out->nodes[0] (length 1, root its id), a new node, headers
// as written. Anything else, or a shape that is not a node: PK_NOT_A_NODE. pk_free it
pk_code pk_decode(const uint8_t *bytes, size_t length, const pk_codec *codec, pk_graph *out);
// what walk, unpack or decode allocated
void pk_free(pk_graph *g);

#endif
