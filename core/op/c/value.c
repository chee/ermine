// op's value (value.h), in C.
#include "value.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// memory

static void *xrealloc(void *p, size_t n) {
	void *q = realloc(p, n);
	if (q == NULL && n != 0) {
		fputs("op: out of memory\n", stderr);
		abort();
	}
	return q;
}
static char *xdup(const char *s) {
	size_t n = strlen(s) + 1;
	return memcpy(xrealloc(NULL, n), s, n);
}
// room for one more at index count
#define GROW(p, count, capacity) \
	do { \
		if ((count) == (capacity)) { \
			(capacity) = (capacity) ? (capacity) * 2 : 4; \
			(p) = xrealloc((p), (capacity) * sizeof *(p)); \
		} \
	} while (0)

// values

static op_value *make(op_type type) {
	op_value *v = xrealloc(NULL, sizeof *v);
	*v = (op_value){.type = type};
	return v;
}
op_value *op_null(void) { return make(OP_NULL); }
op_value *op_bool(int b) {
	op_value *v = make(OP_BOOL);
	v->bool_ = b != 0;
	return v;
}
op_value *op_num(double n) {
	op_value *v = make(OP_NUM);
	v->num = n;
	return v;
}
op_value *op_str_n(const char *s, size_t n) {
	op_value *v = make(OP_STR);
	v->str = xrealloc(NULL, n + 1);
	memcpy(v->str, s, n);
	v->str[n] = 0;
	v->bytes = n;
	v->ascii = 1;
	for (size_t i = 0; i < n; i++)
		if ((unsigned char)s[i] >= 0x80) v->ascii = 0;
	return v;
}
op_value *op_str(const char *s) { return op_str_n(s, strlen(s)); }
op_value *op_str_take(char *s, size_t n) {
	op_value *v = make(OP_STR);
	v->str = s;
	v->bytes = n;
	v->ascii = 1;
	for (size_t i = 0; i < n; i++)
		if ((unsigned char)s[i] >= 0x80) v->ascii = 0;
	return v;
}
op_value *op_list(void) { return make(OP_LIST); }
op_value *op_bytes(const void *data, size_t n) {
	op_value *v = make(OP_BYTES);
	v->data = xrealloc(NULL, n ? n : 1);
	if (n) memcpy(v->data, data, n);
	v->bytes = n;
	return v;
}
op_value *op_stand(op_value *kind) {
	op_value *v = make(OP_STAND);
	op_push(v, kind);
	return v;
}
size_t op_size(op_elements kind) {
	static const unsigned char sizes[] = {1, 2, 2, 4, 4, 8, 8, 4, 8};
	return (unsigned)kind < sizeof sizes ? sizes[kind] : 1;
}
op_value *op_typed(op_elements kind, const void *data, size_t count) {
	op_value *v = op_bytes(data, count * op_size(kind));
	v->type = OP_TYPED;
	v->kind = kind;
	return v;
}
size_t op_length(const op_value *t) { return t->bytes / op_size(t->kind); }
op_value *op_map(void) { return make(OP_MAP); }
void op_push(op_value *list, op_value *v) {
	GROW(list->items, list->count, list->capacity);
	list->items[list->count++] = v;
}
static size_t hash(const char *s) {
	size_t h = 5381;
	for (; *s; s++) h = h * 33 + (unsigned char)*s;
	return h;
}
static void slot(op_value *m, size_t i) {
	size_t h = hash(m->keys[i]) & (m->slots - 1);
	while (m->index[h]) h = (h + 1) & (m->slots - 1);
	m->index[h] = i + 1;
}
// a map with many keys is found by hash
static op_value *lookup(const op_value *map, const char *key, size_t *at) {
	if (map->count <= 16) {
		for (size_t i = 0; i < map->count; i++) {
			if (strcmp(map->keys[i], key) == 0) {
				if (at) *at = i;
				return map->items[i];
			}
		}
		return NULL;
	}
	op_value *m = (op_value *)map;
	if (m->index == NULL) {
		m->slots = 64;
		while (m->slots < 4 * m->count) m->slots *= 2;
		m->index = xrealloc(NULL, m->slots * sizeof *m->index);
		memset(m->index, 0, m->slots * sizeof *m->index);
		for (size_t i = 0; i < m->count; i++) slot(m, i);
	}
	for (size_t h = hash(key) & (m->slots - 1); m->index[h]; h = (h + 1) & (m->slots - 1)) {
		size_t i = m->index[h] - 1;
		if (strcmp(m->keys[i], key) == 0) {
			if (at) *at = i;
			return m->items[i];
		}
	}
	return NULL;
}
op_value *op_get(const op_value *map, const char *key) {
	if (map == NULL || map->type != OP_MAP) return NULL;
	return lookup(map, key, NULL);
}
void op_set(op_value *map, const char *key, op_value *v) {
	size_t at;
	if (lookup(map, key, &at) != NULL) {
		op_free(map->items[at]);
		map->items[at] = v;
		return;
	}
	if (map->count == map->capacity) {
		map->capacity = map->capacity ? map->capacity * 2 : 4;
		map->items = xrealloc(map->items, map->capacity * sizeof *map->items);
		map->keys = xrealloc(map->keys, map->capacity * sizeof *map->keys);
	}
	map->keys[map->count] = xdup(key);
	map->items[map->count++] = v;
	if (map->index != NULL) {
		if (map->slots >= 2 * map->count) {
			slot(map, map->count - 1);
		} else {
			free(map->index);
			map->index = NULL;
		}
	}
}
op_value *op_ref(op_value *v) {
	if (v != NULL) v->refs++;
	return v;
}
void op_free(op_value *v) {
	if (v == NULL) return;
	if (v->refs) {
		v->refs--;
		return;
	}
	for (size_t i = 0; i < v->count; i++) {
		op_free(v->items[i]);
		if (v->type == OP_MAP) free(v->keys[i]);
	}
	free(v->items);
	free(v->keys);
	free(v->index);
	free(v->str);
	free(v->data);
	free(v);
}
