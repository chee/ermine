// Making an entry and a node (graph/typescript/node.ts), in C. An entry is a value and its latest
// change; a node is everything at an id, table names to entries.
#ifndef NODE_H
#define NODE_H

#include <stddef.h>
#include <stdint.h>
#ifndef ND_NOW
#include <time.h>
#endif

#include "../../changeable/c/apply.h"
#include "../../changeable/c/frame.h"
#include "../../changeable/c/invert.h"
#include "../../changeable/c/value.h"

// What a change says. has_time and has_op say which fields are given; the rest are NULL if not.
// frame is shared, never copied; an entry holds its own reference to it, and the header's is
// borrowed. op is set only by nd_update: patches as given and undo, their inverse. The caller
// keeps reader, actor and the op's patches alive while the header refers to them.
typedef struct {
	int has_time;
	int64_t time;
	const void *actor;
	const char *reader;
	ch_frame *frame;
	int has_op;
	const op_patch *patches;
	size_t patches_length;
	const op_patch *undo;
	size_t undo_length;
} ch_header;

// An entry. A NULL value means none. change holds the latest change's header and its frame; the
// caller keeps the other pieces alive while the entry refers to them. undo is the entry's own,
// for nd_update, and is not read or set by a caller.
typedef struct {
	op_value *value;
	ch_header change;
	op_undo undo;
} nd_entry;

// The time now, used when no time is given: whole seconds since 1970, by default
// (int64_t)time(NULL). A build with no clock can define ND_NOW before node.c is compiled, and
// then <time.h> is not included.
#ifndef ND_NOW
#define ND_NOW() ((int64_t)time(NULL))
#endif

// The entry takes an op_ref on the value (NULL for none) and a hold on the header's frame, so the
// caller may let go of its own. header is the entry's change as given (NULL for an empty one),
// with the time now if it has no time. Nothing is checked. Returns NULL when out of memory.
nd_entry *nd_make_entry(op_value *value, const ch_header *header);
void nd_free_entry(nd_entry *n);

typedef struct {
	const char *table;
	nd_entry *entry;
} nd_slot;

typedef struct {
	nd_slot *slots;
	size_t length;
} nd_node;

typedef struct {
	const char *table;
	op_value *value;
} nd_value;

// Makes a node from plain values, each made an entry by nd_make_entry. All entries share the one
// header, with the time now if it has none. The node owns its slots and entries; the table names
// are borrowed. Nothing is checked. Returns NULL when out of memory. header may be NULL.
nd_node *nd_make_node(const nd_value *values, size_t length, const ch_header *header);
void nd_free_node(nd_node *n);

#endif
