#include "ptrmap.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MIN_CAP 4
// A reset map bigger than this is freed, so one that was once huge does not keep its memory.
#define KEEP_CAP 1024

static size_t hash(const void *p, size_t cap) {
	uint64_t x = (uint64_t)(uintptr_t)p >> 3;
	x *= 0x9e3779b97f4a7c15ull;
	return (size_t)(x >> 20) & (cap - 1);
}

static size_t slot(const pm *m, const void *key) {
	size_t i = hash(key, m->cap);
	while (m->keys[i] != NULL && m->keys[i] != key) i = (i + 1) & (m->cap - 1);
	return i;
}

void *pm_get(const pm *m, const void *key) {
	if (m->cap == 0) return NULL;
	size_t i = slot(m, key);
	return m->keys[i] != NULL ? m->vals[i] : NULL;
}

bool pm_has(const pm *m, const void *key) {
	if (m == NULL || m->cap == 0) return false;
	return m->keys[slot(m, key)] != NULL;
}

static void grow(pm *m) {
	pm old = *m;
	m->cap = old.cap ? old.cap * 2 : MIN_CAP;
	m->keys = calloc(2 * m->cap, sizeof *m->keys);
	if (m->keys == NULL) abort();
	m->vals = (void **)(m->keys + m->cap);
	for (size_t i = 0; i < old.cap; i++) {
		if (old.keys[i] == NULL) continue;
		size_t j = slot(m, old.keys[i]);
		m->keys[j] = old.keys[i];
		m->vals[j] = old.vals[i];
	}
	free(old.keys);
}

bool pm_set(pm *m, const void *key, void *val) {
	if (m->cap == 0 || (m->count + 1) * 4 > m->cap * 3) grow(m);
	size_t i = slot(m, key);
	bool added = m->keys[i] == NULL;
	if (added) m->count++;
	m->keys[i] = key;
	m->vals[i] = val;
	return added;
}

bool pm_delete(pm *m, const void *key) {
	if (m->cap == 0) return false;
	size_t i = slot(m, key);
	if (m->keys[i] == NULL) return false;
	m->count--;
	size_t mask = m->cap - 1;
	size_t j = i;
	for (;;) {
		m->keys[i] = NULL;
		m->vals[i] = NULL;
		for (;;) {
			j = (j + 1) & mask;
			if (m->keys[j] == NULL) return true;
			size_t home = hash(m->keys[j], m->cap);
			if (i <= j ? (home <= i || home > j) : (home <= i && home > j)) break;
		}
		m->keys[i] = m->keys[j];
		m->vals[i] = m->vals[j];
		i = j;
	}
}

void pm_clear(pm *m) {
	free(m->keys);
	*m = (pm){0};
}

void pm_reset(pm *m) {
	if (m->cap > KEEP_CAP) {
		pm_clear(m);
		return;
	}
	if (m->count == 0) return;
	memset(m->keys, 0, 2 * m->cap * sizeof *m->keys);
	m->count = 0;
}
