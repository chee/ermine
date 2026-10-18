// Maps keyed by 32-byte ids (names, stored ids, documents, topics), for the transport and sync, in
// C: open addressing on a keyed hash of the id (keyed.h), deletion by shifting back. A value is a
// pointer; a set keeps (void *)1, a code (void *)(uintptr_t)code. No order: what must be walked in
// the order it came is kept beside, in a list. Out of memory aborts
#ifndef IM_IDS_H
#define IM_IDS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
	uint8_t (*keys)[32];
	void **values;
	uint8_t *used;
	size_t slots, count;
} im_map;

// the value under the key, NULL when there is none
void *im_get(const im_map *m, const uint8_t key[32]);
bool im_has(const im_map *m, const uint8_t key[32]);
// the value under the key, in place of what was there
void im_set(im_map *m, const uint8_t key[32], void *value);
// the key's slot, made (holding NULL) when the key is not there
void **im_slot(im_map *m, const uint8_t key[32]);
// the key taken out: its value, NULL when it was not there
void *im_del(im_map *m, const uint8_t key[32]);
// frees the map, not the values
void im_free(im_map *m);
// walking: for (size_t i = 0; i < m->slots; i++) if (m->used[i]) ... m->keys[i], m->values[i]

#endif
