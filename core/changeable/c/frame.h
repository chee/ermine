// A frame (changeable.ts's Frame) in C: plain data a change points at, shared, never copied.
// Hold one with ch_frame_ref, let go with ch_frame_free; a frame holds its parent.
// ch_frame_make copies the pair keys (op_name) and holds each value (op_ref). Out of memory aborts.
// A location comes from compile time (CH_HERE), never a stack.
#ifndef CH_FRAME_H
#define CH_FRAME_H

#define CH_NODE "node"

#include <stddef.h>

#include "value.h"

typedef struct {
	const char *key;
	const void *value;
} ch_pair;

typedef struct ch_frame ch_frame;
struct ch_frame {
	size_t refs;
	ch_frame *parent;
	ch_pair *pairs;
	size_t n;
};

// Makes a frame under parent (held; may be NULL); refs is 1, the caller's, for ch_frame_free.
ch_frame *ch_frame_make(const ch_pair *pairs, size_t n, ch_frame *parent);
ch_frame *ch_frame_ref(ch_frame *f);
void ch_frame_free(ch_frame *f);
const void *ch_frame_get(const ch_frame *f, const char *key);
const void *ch_frame_find(const ch_frame *f, const char *key);

// The caller op_frees the result (values held, not copied).
op_value *ch_frame_value(const ch_frame *f);

typedef struct {
	const char *file;
	long line;
	long column;
	const char *function;
	int has_column;
} ch_location;

#define CH_HERE (&(ch_location){__FILE__, __LINE__, 0, __func__, 0})

#define CH_LOCATIONS "locations"

// The caller op_frees it.
op_value *ch_locations(const ch_location *at);
ch_frame *ch_frame_at(const ch_location *at, ch_frame *parent);
int ch_frame_located(const ch_frame *f);

#endif
