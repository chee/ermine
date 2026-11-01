// The table (typescript/table.ts) in C: nodes held under keys of a part and an id. Several parts
// at one id, one node under any number of keys. The table never looks inside a node or frees one;
// only its address matters. Lookups are O(1) on average.
#ifndef TABLE_H
#define TABLE_H

#include <stddef.h>

typedef struct tb_table tb_table;

// A key: a string, or a symbol (when symbol is non-NULL the string is not read). Strings are
// equal by content, symbols by address, so the caller keeps one token per symbol alive while any
// key made from it is in the table. The table copies strings it stores, so the caller may free
// its own after the call.
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
const char *tb_code_name(int code);

// Called after a table event landed, with the ctx given at making: an entry added, replaced or
// taken out at a key. Putting the same node again is no event. Deleting a node from a part or
// from every key gives one event per key, after all are removed, in tb_who's order. The keys are
// only good for the call.
typedef void (*tb_event)(void *ctx, tb_key part, tb_key id);

tb_table *tb_new(void);
tb_table *tb_make(tb_event event, void *ctx);
void tb_free(tb_table *t);

// Puts the node under the key. Returns 0, also if the same node is already there. A different
// node there gives TB_ALREADY_THERE, with nothing changed.
int tb_add(tb_table *t, tb_key part, tb_key id, void *node);
// Puts the node under the key, replacing what was there; the old node loses only that key. The
// key goes to the end of its id's.
void tb_sub(tb_table *t, tb_key part, tb_key id, void *node);

void *tb_get(const tb_table *t, tb_key part, tb_key id);
// The three below return an array in the table's own scratch space, good until the next call of
// that one or the next change, with its length in *length. The keys in it are the table's copies,
// good until the key is removed. Orders are the order added.
const tb_key *tb_ids(tb_table *t, tb_key part, const void *node, size_t *length);
const tb_entry *tb_at(tb_table *t, tb_key id, size_t *length);
// Every key the node is under: a part's ids together, parts in the order first taken.
const tb_where *tb_who(tb_table *t, const void *node, size_t *length);

// All three return 0, or TB_NOTHING_THERE when there was nothing to delete (nothing changes).
int tb_del(tb_table *t, tb_key part, tb_key id);
int tb_del_part(tb_table *t, tb_key part, const void *node);
int tb_del_node(tb_table *t, const void *node);

#endif
