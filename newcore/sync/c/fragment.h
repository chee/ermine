// Many stored blops as one Subduction fragment (newcore/sync/FRAGMENT.tex), in C. Same shape as
// fragment.ts: the walk from a head, and the build over a document's heads. Ids are stored ids, 32
// bytes. lookup and known are the host's.
#ifndef FRAGMENT_H
#define FRAGMENT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	FRAGMENT_OK,
	FRAGMENT_MISSING,    // a commit the walk needs is not here
	FRAGMENT_DEPTH_ZERO, // the head has depth 0
} fragment_code;

// ids in bytewise order, none twice
typedef struct {
	uint8_t (*ids)[32];
	size_t count, capacity;
} fragment_ids;

typedef struct {
	uint8_t head[32];
	fragment_ids members, boundary, checkpoints;
} fragment;

// a commit's parents (count of them, valid until the next call): true; not here: false
typedef bool (*fragment_lookup)(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count);
// a fragment here, by head, or NULL (valid until the next call)
typedef const fragment *(*fragment_known)(void *context, const uint8_t head[32]);

// the number of leading zero bytes
size_t fragment_depth(const uint8_t id[32]);
// adds an id to a list, in place; false if it was there
bool fragment_add(fragment_ids *ids, const uint8_t id[32]);
// one fragment, from a head of depth 1 or more, to *out (fragment_free it)
fragment_code fragment_walk(const uint8_t head[32], fragment_lookup lookup, fragment_known known, void *context, fragment *out);
// the new fragments for these heads (count, ids in a row), malloc'd into *out (fragment_release it)
fragment_code fragment_build(const uint8_t (*heads)[32], size_t count, fragment_lookup lookup, fragment_known known, void *context, fragment **out, size_t *out_count);
void fragment_free(fragment *f);
void fragment_release(fragment *list, size_t count);

#endif
