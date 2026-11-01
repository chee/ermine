// A map from pointer to pointer, by identity (open addressing). A set is a map whose values are
// ignored. A zeroed map is empty. Keys are never NULL.
#ifndef PTRMAP_H
#define PTRMAP_H

#include <stdbool.h>
#include <stddef.h>

// keys and vals are one allocation (keys first); the smallest table is four slots.
typedef struct pm {
	const void **keys;
	void **vals;
	size_t cap;
	size_t count;
} pm;

void *pm_get(const pm *m, const void *key);
bool pm_has(const pm *m, const void *key);
bool pm_set(pm *m, const void *key, void *val);
// Removes key and returns true when it was there. Not while walking the map.
bool pm_delete(pm *m, const void *key);
void pm_clear(pm *m);
void pm_reset(pm *m);
// To walk: for (size_t i = 0; i < m->cap; i++) if (m->keys[i]) ... Changing the map ends the walk.

#endif
