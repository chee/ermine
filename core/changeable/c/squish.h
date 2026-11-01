// Squishing patches and patches as columns, in C (the same rules as typescript/squish.ts). It
// never applies a patch and never needs the content.
//
// Paths, keys, values and moves given in are borrowed: the caller keeps them alive while the
// squisher is. Arrays returned are the caller's to free; what they point into stays borrowed.
#ifndef SQUISH_H
#define SQUISH_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
	const char *s;
	long n;
} sq_key;

// lone says a lone surrogate is in the value or anything it holds. A string sets it itself; for a
// list or other value the caller does, since squish never reads those.
typedef enum { SQ_ANY, SQ_STR, SQ_LIST, SQ_TYPED } sq_kind;
typedef struct {
	sq_kind kind;
	size_t n;
	size_t size;
	const void *data;
	int lone;
	int of;
	size_t each;
} sq_value;

sq_value sq_str(const char *s, size_t size);
sq_value sq_list(const void *const *elements, size_t n);
sq_value sq_typed(int of, size_t each, const void *data, size_t n);
sq_value sq_any(const void *v);

typedef struct {
	const sq_key *path;
	size_t depth;
	int has_range;
	int64_t from, to;
	int has_value;
	sq_value value;
	const void *move;
	const sq_key *move_path;
	size_t move_depth;
	int move_has_range;
} sq_patch;

typedef struct sq sq;

sq *sq_new(void);
void sq_push(sq *s, const sq_patch *patch);
const sq_patch *sq_patches(const sq *s, size_t *n);
void sq_clear(sq *s);
void sq_free(sq *s);

typedef struct {
	int64_t *v;
	size_t n;
} sq_runs;

typedef struct {
	const sq_key *keys;
	size_t depth;
} sq_path;

typedef struct {
	sq_path *paths;
	size_t npaths;
	sq_runs path, shape, from, size;
	sq_value *value;
	size_t nvalue;
	const void **move;
	size_t nmove;
} sq_columns;

sq_columns sq_encode(const sq_patch *patches, size_t n);
void sq_columns_free(sq_columns *c);
// A new array (free it); NULL with *n 0 when empty.
sq_patch *sq_decode(const sq_columns *c, size_t *n);

#endif
