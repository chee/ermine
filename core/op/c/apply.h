// Patches applied to one value (core/op/typescript/apply.ts), in C, on op_values (value.h).
// Same rules as apply.ts. Also op's other types: the keys of a path, a target, a patch.
//
// Strings count code points (as apply.ts); the unit may change, so position -> byte offset is one
// function in apply.c. Bytes are leaves, a typed array a sequence spliced only with one of its
// own kind.
//
// Memory: nothing given is changed. What a patch touches is new (made with value.h's
// constructors), the rest is shared with the value before and with the patches' values. A copy
// made here may change in place across the patches of one call, since only the end is seen.
// Ownership: the value made holds one reference (op_ref) of its own on everything of the old
// value or of the patches it shares; *out itself holds one for the caller (a value unchanged is
// op_ref'd, not copied). So a caller may op_free the old value and the patches' values, and the
// new stays whole; it op_frees the new one when it lets it go. A caller that never frees: as
// before. A failed call takes no reference.
//
// Asked for, the undo of the patches too (invert.h says what it is), built as each lands: one
// walk. The undo holds its own: its keys copied, one reference on each value it holds, which may
// share with the value given, the patches' values and the value made. A caller lets it go with
// op_undo_free.
#ifndef OP_APPLY_H
#define OP_APPLY_H

#include <stddef.h>

#include "value.h"

// a path item: a key (number or string, never the same), or a span [a, b) last
typedef enum { OP_NUM_KEY, OP_STR_KEY, OP_SPAN } op_key_type;
typedef struct {
	op_key_type type;
	long n; // a number key
	const char *s; // a string key
	long a, b; // a span
} op_key;

// what a patch aims at: keys, and maybe a range of the sequence there
typedef struct {
	const op_key *path;
	size_t length;
	int has_range;
	long from, to;
} op_target;

// has_value: a "value" was given (null counts); else the place is removed
// a move: what is at move taken there
typedef struct {
	op_target place;
	int has_value;
	const op_value *value;
	int has_move;
	op_target move;
} op_patch;

enum {
	OP_OK = 0,
	OP_NOT_A_PATCH,
	OP_NO_KEY,
	OP_RANGE,
	OP_WRONG_KIND,
	OP_INTO_ITSELF,
};
// "not-a-patch", "no-key", "range", "wrong-kind", "into-itself"; "ok"
const char *op_code_name(int code);

// the undo of some patches: in the order to apply it
typedef struct {
	op_patch *patches;
	size_t n;
	size_t capacity;
} op_undo;

typedef struct {
	// the value is a list: nothing there starts as [], anything but a list is wrong-kind, and a
	// list left empty is nothing
	int list;
	// given: the undo of the patches is added to it once all have landed, in the order to apply
	// it; a failed call leaves it as it was. NULL: no undo is made
	op_undo *undo;
} op_apply_options;

// the patches, in order, to the value; *out the value after them. value NULL: nothing there; a
// put at [] makes one, any other patch is no-key. *out NULL: nothing there (a removal at [], or
// a list left empty). invalid: a code, *failed the patch's index (may be NULL), and nothing
// changes. options may be NULL
int op_apply(const op_value *value, const op_patch *patches, size_t n,
	const op_apply_options *options, op_value **out, size_t *failed);

// lets go of what an undo holds: its patches, their keys, a reference on each value
void op_undo_free(op_undo *undo);

#endif
