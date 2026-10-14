// Making a node (core/node/typescript/node.ts), in C. Same shape as node.ts: a value and its
// latest change; where it is kept is a layer above's.
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

// value: NULL, none. change: the latest change's header, borrowed pieces and all:
// the caller keeps them alive while the node refers to them. undo: the node's own, for update's
// undo (update.h): not read or set by a caller
// in_place: update changes the containers of the value in place (op_apply's in_place); set by
// nd_make only
typedef struct {
	op_value *value;
	ch_header change;
	op_undo undo;
	int in_place;
} nd_node;

// what nd_make is given besides: in_place 1, a node whose value update changes in place. Whatever
// else holds the value then sees it change: put in nothing you do not want changed, or copy it
// first
typedef struct {
	int in_place;
} nd_options;

// kept by the caller; nothing checked: checks are a layer above's. The node takes an op_ref on the
// value (NULL: none), so the caller may op_free its own hold. header: the node's change, as given,
// not copied (NULL: an empty one); with no time, the time now, whole seconds since 1970. NULL
// when out of memory. options may be NULL
nd_node *nd_make(op_value *value, const ch_header *header, const nd_options *options);
// frees what the node owns: its hold on the value, its undo. Nothing given to it
void nd_free(nd_node *n);

#endif
