// The store (typescript/store.ts), in C: a table (table.h) per source, each holding nodes under
// (part, id). A part is a name, any string ("children" is places' hole); the store checks none. A
// source's table is made when first written to, and dropped whole when the source ends. One
// listener is told of every table event: a node added, replaced or removed at a key. Same rules
// as store.ts, which the suite in ermine/store/conformance/store/ holds both to.
//
// A source and an id are tb_keys (table.h): a string, or a symbol (the caller's token). A part is
// a string. The store copies a string it keeps. A node is the caller's: the store never looks
// inside it or frees it, only its address matters. Out of memory aborts, as everywhere in core.
#ifndef STORE_H
#define STORE_H

#include <stddef.h>

#include "../../../core/graph/c/table.h"
#include "../../../core/node/c/node.h"

// a key of a node in one source: a part's name, and an id
typedef struct {
	const char *part;
	tb_key id;
} st_key;

// told after a change landed. The key's strings are good for the call
typedef void (*st_event)(void *ctx, tb_key source, const char *part, tb_key id);

typedef struct st_store st_store;
// event may be NULL
st_store *st_new(st_event event, void *ctx);
// frees the store and its tables, not the nodes
void st_free(st_store *s);

// the node under the key, or NULL. A read makes no table
nd_node *st_get(const st_store *s, tb_key source, const char *part, tb_key id);

// the node under the key. 0; the same node there already: 0, nothing changed, no event; a different
// node there: TB_ALREADY_THERE, nothing changed
int st_add(st_store *s, tb_key source, const char *part, tb_key id, nd_node *node);
// the node under the key, in place of what was there. The same node: nothing, no event
void st_sub(st_store *s, tb_key source, const char *part, tb_key id, nd_node *node);
// the node under the key taken out: 0, or TB_NOTHING_THERE (nothing changed, no event)
int st_del(st_store *s, tb_key source, const char *part, tb_key id);

// every key the node is under in the source's table, a part's ids together, the parts in the order
// each was first taken; none: not there. An array of the store's own, live until the next call of
// this one or the next change; the parts and ids in it are the table's copies, live until the key
// is removed
const st_key *st_who(st_store *s, tb_key source, const nd_node *node, size_t *length);

// places' hole: the children node of id as the source has it
nd_node *st_children(const st_store *s, tb_key source, tb_key id);

// the source's whole table gone, then an event at each key it held: ids in the order first held
// (one deleted and held again is last), each id's parts in the order taken. none: nothing
void st_drop(st_store *s, tb_key source);

#endif
