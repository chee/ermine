// a map from pointer to pointer, by identity (open addressing). a set is a map whose values are
// ignored. a zeroed map is empty. keys are never NULL.
#ifndef PTRMAP_H
#define PTRMAP_H

#include <stdbool.h>
#include <stddef.h>

// keys and vals are one allocation (keys first), the smallest table four slots
typedef struct pm {
	const void **keys;
	void **vals;
	size_t cap;
	size_t count;
} pm;

// the value at key; NULL when absent
void *pm_get(const pm *m, const void *key);
bool pm_has(const pm *m, const void *key);
// sets key; returns true when it was new
bool pm_set(pm *m, const void *key, void *val);
// removes key; returns true when it was there. not while walking the map
bool pm_delete(pm *m, const void *key);
// frees the memory; the map is empty again
void pm_clear(pm *m);
// empties the map, keeping its memory for the next keys (a map grown big is freed instead)
void pm_reset(pm *m);
// walk: for (size_t i = 0; i < m->cap; i++) if (m->keys[i]) ...; changing the map ends the walk

#endif
