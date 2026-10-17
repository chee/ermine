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
//
// In place (in_place): the containers of the value given are changed, not copied; a string is
// replaced in its parent, and a typed array whose length changes too. Every container holds one
// reference on each item, as op_ref made it: what a patch puts is held by the container it goes
// in, what leaves one is let go of at the end of the call. *out is the value given (op_ref'd, a
// hold for the caller as before) unless a patch replaced the whole. The patches' values, once
// put, are the value's: a later patch changes them. A failed call is undone in place by the
// undo it builds (made even when not asked for), a key put back going last in its map.
#ifndef OP_APPLY_H
#define OP_APPLY_H

#include <stddef.h>
#include <stdint.h>

#include "value.h"

// a path item: a key (number or string, never the same), or a span [a, b) last. a number key is a
// list's index: up to 2^31 - 1, what any long holds (the encodings refuse more); a span's ends,
// as a range's, are int64_t: a sequence past 2^31 stays editable on a 32-bit machine
typedef enum { OP_NUM_KEY, OP_STR_KEY, OP_SPAN } op_key_type;
typedef struct {
	op_key_type type;
	// one is live, by the type
	union {
		long n; // a number key
		const char *s; // a string key
		struct {
			int64_t a, b; // a span
		};
	};
} op_key;

// what a patch aims at: keys, and maybe a range of the sequence there
typedef struct {
	const op_key *path;
	size_t length;
	int has_range;
	int64_t from, to;
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
	// given: the undo of the patches is added to it once all have landed, in the order to apply
	// it; a failed call leaves it as it was. NULL: no undo is made
	op_undo *undo;
	// change the value given in place (see above); 0: a copy is changed
	int in_place;
	// in place: which containers may change where they are. a list, map or typed array about to
	// change is given to owned first (with data), which gives back the one to change: the same,
	// or a copy it made (one reference on each item, as op_ref made them), which goes in its
	// place (the given value's root too: then *out is the copy). a container the call made is
	// given too, once it holds its items. NULL: every container changes where it is
	op_value *(*owned)(op_value *container, void *data);
	void *data;
} op_apply_options;

// the patches, in order, to the value; *out the value after them. value NULL: nothing there; a
// put at [] makes one, any other patch is no-key. *out NULL: nothing there (a removal at []). invalid: a code, *failed the patch's index (may be NULL), and nothing
// changes. options may be NULL
int op_apply(const op_value *value, const op_patch *patches, size_t n,
	const op_apply_options *options, op_value **out, size_t *failed);

// lets go of what an undo holds: its patches, their keys, a reference on each value
void op_undo_free(op_undo *undo);

#endif
