// Maps keyed by 32-byte ids (ids.h)
#include "ids.h"
#include "keyed.h"

#include <stdlib.h>
#include <string.h>

// keyed: what others send chooses ids, and so their first bytes
static size_t hash_of(const uint8_t key[32]) {
	return ky_hash(key);
}

static size_t find(const im_map *m, const uint8_t key[32], bool *found) {
	size_t mask = m->slots - 1, s = hash_of(key) & mask;
	while (m->used[s]) {
		if (memcmp(m->keys[s], key, 32) == 0) return *found = true, s;
		s = (s + 1) & mask;
	}
	*found = false;
	return s;
}

void *im_get(const im_map *m, const uint8_t key[32]) {
	if (m->slots == 0) return NULL;
	bool found;
	size_t s = find(m, key, &found);
	return found ? m->values[s] : NULL;
}

bool im_has(const im_map *m, const uint8_t key[32]) {
	if (m->slots == 0) return false;
	bool found;
	find(m, key, &found);
	return found;
}

static void grow(im_map *m) {
	im_map old = *m;
	m->slots = old.slots ? old.slots * 2 : 16;
	m->keys = malloc(m->slots * 32);
	m->values = malloc(m->slots * sizeof *m->values);
	m->used = calloc(m->slots, 1);
	if (m->keys == NULL || m->values == NULL || m->used == NULL) abort();
	m->count = 0;
	for (size_t i = 0; i < old.slots; i++) {
		if (!old.used[i]) continue;
		bool found;
		size_t s = find(m, old.keys[i], &found);
		memcpy(m->keys[s], old.keys[i], 32);
		m->values[s] = old.values[i];
		m->used[s] = 1;
		m->count++;
	}
	free(old.keys);
	free(old.values);
	free(old.used);
}

void **im_slot(im_map *m, const uint8_t key[32]) {
	if ((m->count + 1) * 2 > m->slots) grow(m);
	bool found;
	size_t s = find(m, key, &found);
	if (!found) {
		memcpy(m->keys[s], key, 32);
		m->values[s] = NULL;
		m->used[s] = 1;
		m->count++;
	}
	return &m->values[s];
}

void im_set(im_map *m, const uint8_t key[32], void *value) {
	*im_slot(m, key) = value;
}

void *im_del(im_map *m, const uint8_t key[32]) {
	if (m->slots == 0) return NULL;
	bool found;
	size_t s = find(m, key, &found);
	if (!found) return NULL;
	void *value = m->values[s];
	size_t mask = m->slots - 1;
	m->used[s] = 0;
	m->count--;
	// shift back what follows, so no lookup stops at the hole early
	for (size_t i = (s + 1) & mask; m->used[i]; i = (i + 1) & mask) {
		size_t home = hash_of(m->keys[i]) & mask;
		// i's run from home to i passes the hole: it moves into it
		if ((i > s && (home <= s || home > i)) || (i < s && home <= s && home > i)) {
			memcpy(m->keys[s], m->keys[i], 32);
			m->values[s] = m->values[i];
			m->used[s] = 1;
			m->used[i] = 0;
			s = i;
		}
	}
	return value;
}

void im_free(im_map *m) {
	free(m->keys);
	free(m->values);
	free(m->used);
	*m = (im_map){0};
}
