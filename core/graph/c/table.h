// The table (typescript/table.ts), in C: nodes held under keys of a part and an id. Several parts at
// one id, one node under any number of keys. Same rules as table.ts; the table never looks inside a
// node, only its address matters, and it never frees one. Lookups are O(1) on average.
#ifndef TABLE_H
#define TABLE_H

#include <stddef.h>

typedef struct tb_table tb_table;

// a key: a string, or a symbol (symbol non-NULL: the string is not read). Strings are equal by
// content, symbols by address: the caller's token, one per symbol, alive while any key made from
// it is in the table. The table copies a string it keeps, so the caller may free its own after
// the call; the copy lives as long as the key is in the table
typedef struct {
	const char *string;
	const void *symbol;
} tb_key;

static inline tb_key tb_string(const char *s) { return (tb_key){.string = s}; }
static inline tb_key tb_symbol(const void *token) { return (tb_key){.symbol = token}; }

typedef struct {
	tb_key part;
	void *node;
} tb_entry;

typedef struct {
	tb_key part;
	tb_key id;
} tb_where;

typedef enum { TB_NOTHING_THERE = 1, TB_ALREADY_THERE } tb_code;
// the TypeScript code of a return, "nothing-there" or "already-there"; "" for 0
const char *tb_code_name(int code);

// an empty table; out of memory aborts, as everywhere in core
tb_table *tb_new(void);
// frees the table and what it kept; not the nodes, nor the caller's tokens
void tb_free(tb_table *t);

// the node under the key. 0; the same node there already: 0, nothing changed; a different
// node there: TB_ALREADY_THERE, nothing changed
int tb_add(tb_table *t, tb_key part, tb_key id, void *node);
// the node under the key, in place of what was there; the old node loses only that key. The
// key goes to the end of its id's
void tb_sub(tb_table *t, tb_key part, tb_key id, void *node);

// the node under the key, or NULL
void *tb_get(const tb_table *t, tb_key part, tb_key id);
// the three below give an array in the table's own scratch, live until the next call of that one
// or the next change, and its length in *length; the keys in it are the table's copies, live
// until the key is removed. The orders are the order added.
// a node's ids under the part
const tb_key *tb_ids(tb_table *t, tb_key part, const void *node, size_t *length);
// every part at an id, with its node
const tb_entry *tb_at(tb_table *t, tb_key id, size_t *length);
// every key the node is under, a part's ids together, the parts in the order each was first
// taken; none: not in the table
const tb_where *tb_who(tb_table *t, const void *node, size_t *length);

// all return 0, or TB_NOTHING_THERE when there was nothing to delete (nothing changed)
// the key
int tb_del(tb_table *t, tb_key part, tb_key id);
// the node from every id under the part
int tb_del_part(tb_table *t, tb_key part, const void *node);
// the node from every key
int tb_del_node(tb_table *t, const void *node);

#endif
