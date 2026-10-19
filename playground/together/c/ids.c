// Maps keyed by ids (ids.h)
#include "ids.h"
#include "keyed.h"

#include <stdlib.h>
#include <string.h>

// keyed: what others send chooses ids, and so their first bytes
size_t im_width(const im_map *m) {
	return m->width ? m->width : 32;
}

static size_t hash_of(const im_map *m, const uint8_t *key) {
	return ky_hash(key, im_width(m));
}

const uint8_t *im_key(const im_map *m, size_t slot) {
	return m->keys + slot * im_width(m);
}

static size_t find(const im_map *m, const uint8_t *key, bool *found) {
	size_t mask = m->slots - 1, s = hash_of(m, key) & mask;
	while (m->used[s]) {
		if (memcmp(im_key(m, s), key, im_width(m)) == 0) return *found = true, s;
		s = (s + 1) & mask;
	}
	*found = false;
	return s;
}

void *im_get(const im_map *m, const uint8_t *key) {
	if (m->slots == 0) return NULL;
	bool found;
	size_t s = find(m, key, &found);
	return found ? m->values[s] : NULL;
}

bool im_has(const im_map *m, const uint8_t *key) {
	if (m->slots == 0) return false;
	bool found;
	find(m, key, &found);
	return found;
}

static void grow(im_map *m) {
	im_map old = *m;
	m->slots = old.slots ? old.slots * 2 : 16;
	m->keys = malloc(m->slots * im_width(m));
	m->values = malloc(m->slots * sizeof *m->values);
	m->used = calloc(m->slots, 1);
	if (m->keys == NULL || m->values == NULL || m->used == NULL) abort();
	m->count = 0;
	for (size_t i = 0; i < old.slots; i++) {
		if (!old.used[i]) continue;
		bool found;
		size_t s = find(m, im_key(&old, i), &found);
		memcpy(m->keys + s * im_width(m), im_key(&old, i), im_width(m));
		m->values[s] = old.values[i];
		m->used[s] = 1;
		m->count++;
	}
	free(old.keys);
	free(old.values);
	free(old.used);
}

void **im_slot(im_map *m, const uint8_t *key) {
	if ((m->count + 1) * 2 > m->slots) grow(m);
	bool found;
	size_t s = find(m, key, &found);
	if (!found) {
		memcpy(m->keys + s * im_width(m), key, im_width(m));
		m->values[s] = NULL;
		m->used[s] = 1;
		m->count++;
	}
	return &m->values[s];
}

void im_set(im_map *m, const uint8_t *key, void *value) {
	*im_slot(m, key) = value;
}

void *im_del(im_map *m, const uint8_t *key) {
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
		size_t home = hash_of(m, im_key(m, i)) & mask;
		// i's run from home to i passes the hole: it moves into it
		if ((i > s && (home <= s || home > i)) || (i < s && home <= s && home > i)) {
			memcpy(m->keys + s * im_width(m), im_key(m, i), im_width(m));
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
	*m = (im_map){.width = m->width};
}
