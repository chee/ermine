// store_memory.c: store.h's store in memory, gone when the program ends.
// Portable C: records in one list, found by a hash of their key.

#include "store.h"
#include "platform.h"

#include <stdbool.h>
#include <string.h>

typedef struct Record {
	int kind;
	bool gone;
	uint8_t tree[32]; // zeros for TREE and BLOB
	uint8_t id[32];
	uint8_t *bytes;
	size_t length;
} Record;

typedef struct Memory {
	Record *records;
	size_t count, room;
	size_t *index; // open addressing: record + 1, 0 empty
	size_t slots;
} Memory;

static void *grow(void *pointer, size_t size) {
	void *out = erm_host_realloc(pointer, size ? size : 1);
	if (!out) erm_host_abort();
	return out;
}

static size_t hash(int kind, const uint8_t tree[32], const uint8_t id[32]) {
	uint64_t h = 1469598103934665603u ^ (uint64_t)kind;
	for (int i = 0; i < 32; i++) h = (h ^ tree[i]) * 1099511628211u;
	for (int i = 0; i < 32; i++) h = (h ^ id[i]) * 1099511628211u;
	return (size_t)(h ^ h >> 32);
}

static void reindex(Memory *m) {
	m->slots = m->slots ? m->slots * 2 : 64;
	erm_host_free(m->index);
	m->index = grow(NULL, m->slots * sizeof *m->index);
	memset(m->index, 0, m->slots * sizeof *m->index);
	for (size_t r = 0; r < m->count; r++) {
		size_t at = hash(m->records[r].kind, m->records[r].tree, m->records[r].id) & (m->slots - 1);
		while (m->index[at]) at = (at + 1) & (m->slots - 1);
		m->index[at] = r + 1;
	}
}

/** the record under the key, gone or not; or NULL */
static Record *find(Memory *m, int kind, const uint8_t tree[32], const uint8_t id[32]) {
	if (!m->slots) return NULL;
	for (size_t at = hash(kind, tree, id) & (m->slots - 1); m->index[at]; at = (at + 1) & (m->slots - 1)) {
		Record *r = &m->records[m->index[at] - 1];
		if (r->kind == kind && memcmp(r->tree, tree, 32) == 0 && memcmp(r->id, id, 32) == 0) return r;
	}
	return NULL;
}

static const uint8_t NONE[32];

static int put(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length) {
	Memory *m = self;
	if (!tree) tree = NONE;
	uint8_t *copy = NULL;
	if (length) {
		copy = grow(NULL, length);
		memcpy(copy, bytes, length);
	}
	Record *r = find(m, kind, tree, id);
	if (r) {
		erm_host_free(r->bytes);
	} else {
		if (m->count == m->room) m->records = grow(m->records, (m->room = m->room ? m->room * 2 : 64) * sizeof *m->records);
		r = &m->records[m->count++];
		r->kind = kind;
		memcpy(r->tree, tree, 32);
		memcpy(r->id, id, 32);
		if (m->count * 2 > m->slots) {
			reindex(m);
		} else {
			size_t at = hash(kind, tree, id) & (m->slots - 1);
			while (m->index[at]) at = (at + 1) & (m->slots - 1);
			m->index[at] = m->count;
		}
	}
	r->gone = false;
	r->bytes = copy;
	r->length = length;
	return 0;
}

static int get(void *self, int kind, const uint8_t *tree, const uint8_t id[32], uint8_t **bytes, size_t *length) {
	Record *r = find(self, kind, tree ? tree : NONE, id);
	if (!r || r->gone) return 0;
	*bytes = NULL;
	if (r->length) {
		*bytes = erm_host_malloc(r->length);
		if (!*bytes) return -1;
		memcpy(*bytes, r->bytes, r->length);
	}
	*length = r->length;
	return 1;
}

static int list(void *self, int kind, const uint8_t *tree, void (*each)(void *context, const uint8_t id[32]), void *context) {
	Memory *m = self;
	if (!tree) tree = NONE;
	for (size_t i = 0; i < m->count; i++) {
		Record *r = &m->records[i];
		if (!r->gone && r->kind == kind && memcmp(r->tree, tree, 32) == 0) each(context, r->id);
	}
	return 0;
}

static void forget(Record *r) {
	erm_host_free(r->bytes);
	r->bytes = NULL;
	r->length = 0;
	r->gone = true;
}

static int remove_(void *self, int kind, const uint8_t *tree, const uint8_t *id) {
	Memory *m = self;
	if (!tree) tree = NONE;
	if (id) {
		Record *r = find(m, kind, tree, id);
		if (r && !r->gone) forget(r);
		return 0;
	}
	for (size_t i = 0; i < m->count; i++) {
		Record *r = &m->records[i];
		if (!r->gone && r->kind == kind && memcmp(r->tree, tree, 32) == 0) forget(r);
	}
	return 0;
}

ErmStore ermStoreMemory(void) {
	Memory *m = grow(NULL, sizeof *m);
	memset(m, 0, sizeof *m);
	return (ErmStore){ m, put, get, list, remove_ };
}
