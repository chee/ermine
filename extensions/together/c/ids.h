// Maps keyed by ids (names: CM_NAME bytes; stored ids, documents, topics: 32), for the transport and sync, in
// C: open addressing on a keyed hash of the id (keyed.h), deletion by shifting back. A value is a
// pointer; a set keeps (void *)1, a code (void *)(uintptr_t)code. No order: what must be walked in
// the order it came is kept beside, in a list. Out of memory aborts
#ifndef IM_IDS_H
#define IM_IDS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
	// how many bytes a key is: 0 is 32 (a map of {0}), a map of names sets CM_NAME
	size_t width;
	uint8_t *keys;
	void **values;
	uint8_t *used;
	size_t slots, count;
} im_map;

// the value under the key, NULL when there is none
void *im_get(const im_map *m, const uint8_t *key);
bool im_has(const im_map *m, const uint8_t *key);
// the value under the key, in place of what was there
void im_set(im_map *m, const uint8_t *key, void *value);
// the key's slot, made (holding NULL) when the key is not there
void **im_slot(im_map *m, const uint8_t *key);
// the key taken out: its value, NULL when it was not there
void *im_del(im_map *m, const uint8_t *key);
// frees the map, not the values
void im_free(im_map *m);
// walking: for (size_t i = 0; i < m->slots; i++) if (m->used[i]) ... im_key(m, i), m->values[i]
const uint8_t *im_key(const im_map *m, size_t slot);
// how many bytes a key is
size_t im_width(const im_map *m);

#endif
