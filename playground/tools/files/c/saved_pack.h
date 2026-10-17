// A graph from a root, as bytes (newcore/encoding/PACK.tex), in C. Same shape as pack.ts: one canonical CBOR item,
// {root, nodes, missing}. Values (content outside lists, change, because, actor, cause) are the
// caller's: written and read by its codec, never read here.
#ifndef SAVED_PACK_H
#define SAVED_PACK_H

#include "saved.h"

typedef enum {
	SP_OK,
	SP_NOTHING_THERE,
	SP_CANNOT_CARRY,
	SP_NOT_A_GRAPH,
	SP_NOT_A_NODE,
	SP_NO_MEMORY,
} sp_code;

// the node of an id, or NULL if it is not loaded
typedef const sd_node *(*sp_get)(void *context, const char *id);

// bytes being written; start at {0}; failed: out of memory. free(data) when done
typedef struct {
	uint8_t *data;
	size_t length, capacity;
	int failed;
} sp_bytes;
void sp_put(sp_bytes *b, const void *data, size_t length);

// which field a value is in: each may be a different type of the caller's
typedef enum { SP_CONTENT, SP_CHANGE, SP_BECAUSE, SP_ACTOR, SP_CAUSE } sp_field;

typedef struct {
	// writes one CBOR item for value, in field; nonzero: it cannot be carried
	int (*encode)(void *context, sp_field field, const void *value, sp_bytes *out);
	// a value for field from the one CBOR item at item, length long; nonzero: not one it reads.
	// What it gives is the caller's, kept after sp_free. Give non-NULL: NULL is not there
	int (*decode)(void *context, sp_field field, const uint8_t *item, size_t length,
		const void **value);
	void *context;
} sp_codec;

// root: the id walked from; nodes: the root first, then in the order reached; missing: ids in a
// list reached but not loaded, in the order reached
typedef struct {
	const char *root;
	const sd_node **nodes;
	size_t length;
	const char **missing;
	size_t missing_length;
	void *own; // decode's: what it allocated, the nodes too
} sp_graph;

// the node back, as a graph's nodes are written: out->nodes[0] (length 1, root its id), a new node, headers
// as written. Anything else, or a shape that is not a node: SP_NOT_A_NODE. sp_free it
sp_code sp_decode(const uint8_t *bytes, size_t length, const sp_codec *codec, sp_graph *out);
// what decode allocated
void sp_free(sp_graph *g);

#endif
