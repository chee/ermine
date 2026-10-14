// Making an entry and a node (core/node/typescript/node.ts), in C. Same shape as node.ts: an entry is
// a value and its latest change; a node is everything at an id, table names to entries; where
// either is kept is a layer above's.
#ifndef NODE_H
#define NODE_H

#include <stddef.h>
#include <stdint.h>

#include "../../op/c/apply.h"
#include "../../op/c/invert.h"
#include "../../op/c/value.h"

// where in code: column only when has_column, function NULL when not known
typedef struct {
	const char *file;
	long line;
	long column;
	const char *function;
	int has_column;
} ch_site;

// the site of the code writing it
#define CH_HERE (&(ch_site){__FILE__, __LINE__, 0, __func__, 0})

// what a change says: has_time, and NULL for the rest = not given
// time: wall-clock, as the caller gives it. actor: the caller's, never read here
// external: where in code, oldest first; NULL: none (an empty array, not NULL, is none yet)
// metadata: entries anyone adds to, in order, repeats allowed; NULL: none. key and value are the
// caller's, value opaque, never read here
// op: the latest edit, set only by update (update.h), never by a caller: has_op, its patches as
// given and undo, their inverse (op's invert); either may be empty, and then NULL
// everything is borrowed: the caller keeps reader, external, metadata, actor and the op's
// patches alive while the header refers to them
typedef struct {
	const char *key;
	const void *value;
} ch_entry;

typedef struct {
	int has_time;
	int64_t time;
	const void *actor;
	const char *reader;
	const ch_site *external;
	size_t external_length;
	const ch_entry *metadata;
	size_t metadata_length;
	int has_op;
	const op_patch *patches;
	size_t patches_length;
	const op_patch *undo;
	size_t undo_length;
} ch_header;

// an entry: value: NULL, none. change: the latest change's header, borrowed pieces and all:
// the caller keeps them alive while the entry refers to them. undo: the entry's own, for update's
// undo (update.h): not read or set by a caller
// in_place: update changes the containers of the value in place (op_apply's in_place); set by
// nd_make_entry only
typedef struct {
	op_value *value;
	ch_header change;
	op_undo undo;
	int in_place;
} nd_entry;

// what nd_make_entry is given besides: in_place 1, an entry whose value update changes in place. Whatever
// else holds the value then sees it change: put in nothing you do not want changed, or copy it
// first
typedef struct {
	int in_place;
} nd_entry_options;

// kept by the caller; nothing checked: checks are a layer above's. The entry takes an op_ref on the
// value (NULL: none), so the caller may op_free its own hold. header: the entry's change, as given,
// not copied (NULL: an empty one); with no time, the time now, whole seconds since 1970. NULL
// when out of memory. options may be NULL
nd_entry *nd_make_entry(op_value *value, const ch_header *header, const nd_entry_options *options);
// frees what the entry owns: its hold on the value, its undo. Nothing given to it
void nd_free_entry(nd_entry *n);

// everything at an id: a table name and its entry, for each table the id has. no id: that is the
// table's key, a layer above's. all borrowed, nothing copied or checked: the caller keeps the slots,
// the table names and the entries alive, and frees the entries (nd_free_entry) itself. table names
// are meant to be distinct; nothing checks
typedef struct {
	const char *table;
	nd_entry *entry;
} nd_slot;

typedef struct {
	const nd_slot *slots;
	size_t length;
} nd_node;

// the node of these slots, by value: nothing allocated, nothing to free. length 0: a node with no
// tables
nd_node nd_make_node(const nd_slot *slots, size_t length);
// the entry at a table name, NULL when the node has none
nd_entry *nd_find(const nd_node *n, const char *table);

#endif
