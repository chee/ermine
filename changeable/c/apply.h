// Applies patches to a value in C (the same rules as typescript/apply.ts), on op_values (value.h).
//
// Nothing given is changed. The new value holds its own reference on everything it shares, and *out
// holds one for the caller. A failed call takes no reference. The undo, when asked for, holds its
// own key copies and a reference on each value; free it with op_undo_free. With in_place the
// containers given are changed instead of copied, each holding one reference per item, and a failed
// call is undone in place even when no undo was asked for.
#ifndef OP_APPLY_H
#define OP_APPLY_H

#include <stddef.h>
#include <stdint.h>

#include "value.h"

typedef enum { OP_NUM_KEY, OP_STR_KEY, OP_SPAN } op_key_type;
typedef struct {
	op_key_type type;
	union {
		long n; // a number key
		const char *s; // a string key
		struct {
			int64_t a, b; // a span
		};
	};
} op_key;

typedef struct {
	const op_key *path;
	size_t length;
	int has_range;
	int64_t from, to;
} op_target;

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
const char *op_code_name(int code);

typedef struct {
	op_patch *patches;
	size_t n;
	size_t capacity;
} op_undo;

typedef struct {
	op_undo *undo;
	int in_place;
	// In place only: owned gets each container about to change and returns the one to change (the
	// same, or a copy with one reference on each item).
	op_value *(*owned)(op_value *container, void *data);
	void *data;
} op_apply_options;

// Applies the patches in order to value, putting the result in *out. On an invalid patch it
// returns a code and sets *failed (may be NULL) to its index; nothing changes.
int op_apply(const op_value *value, const op_patch *patches, size_t n,
	const op_apply_options *options, op_value **out, size_t *failed);

void op_undo_free(op_undo *undo);

#endif
