// Squishing patches, and patches as columns (newcore/squish.ts), in C. Same rules as squish.ts.
// Never applies a patch and never needs the content.
#ifndef SQUISH_H
#define SQUISH_H

#include <stddef.h>
#include <stdint.h>

// a key into the content: a string (s), or a whole number (s NULL, n)
typedef struct {
	const char *s;
	long n;
} sq_key;

// what joins and cuts: a string (UTF-8; n counts code points), a list (n opaque elements),
// bytes; anything else is SQ_ANY and never joins. size: data's length in bytes
typedef enum { SQ_ANY, SQ_STR, SQ_LIST, SQ_BYTES } sq_kind;
typedef struct {
	sq_kind kind;
	size_t n;
	size_t size;
	const void *data;
} sq_value;

sq_value sq_str(const char *s, size_t size);
sq_value sq_list(const void *const *elements, size_t n);
sq_value sq_bytes(const uint8_t *b, size_t n);
sq_value sq_any(const void *v);

// GRAPH.tex's patch. move: opaque, never read, NULL for none
typedef struct {
	const sq_key *path;
	size_t depth;
	int has_range;
	long from, to;
	int has_value;
	sq_value value;
	const void *move;
} sq_patch;

typedef struct sq sq;

sq *sq_new(void);
// path, keys, values and moves are borrowed: kept alive by the caller while the squisher is
void sq_push(sq *s, const sq_patch *patch);
// what has been pushed, squished; valid until the next push or sq_free
const sq_patch *sq_patches(const sq *s, size_t *n);
// empties it, keeping its memory; joined values made before are freed
void sq_clear(sq *s);
void sq_free(sq *s);

// [value, count, value, count, ...]; n: how many longs
typedef struct {
	long *v;
	size_t n;
} sq_runs;

typedef struct {
	const sq_key *keys;
	size_t depth;
} sq_path;

// as squish.ts's Columns. shape: 1 a range, 2 a value, 4 a move. from: the step from the last
// ranged patch's from; size: to - from. Paths, values and moves are the patches', borrowed
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
// a new array (free it), its paths, values and moves borrowed from c; NULL, *n 0 when empty
sq_patch *sq_decode(const sq_columns *c, size_t *n);

#endif
