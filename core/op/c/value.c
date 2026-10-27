// op's value (value.h), in C.
#include "value.h"
#include "whole.h"

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
// names: a count of holders past the first, then the string
typedef struct {
	size_t refs;
	char s[];
} name;
#define NAME(p) ((name *)((p) - offsetof(name, s)))
char *op_name(const char *s) {
	size_t n = strlen(s) + 1;
	name *k = xrealloc(NULL, sizeof *k + n);
	k->refs = 0;
	return memcpy(k->s, s, n);
}
char *op_name_ref(char *p) {
	NAME(p)->refs++;
	return p;
}
void op_name_free(char *p) {
	if (p == NULL) return;
	name *k = NAME(p);
	if (k->refs) k->refs--;
	else free(k);
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
	memset(v, 0, sizeof *v);
	v->type = type;
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
	v->num = n == 0 ? 0 : n; // -0 is 0
	return v;
}
op_value *op_whole(int negative, const unsigned char *m, size_t n) {
	while (n && !*m) m++, n--;
	if (whole_exact(m, n)) return op_num(whole_near(negative, m, n));
	op_value *v = make(OP_NUM);
	v->num = whole_near(negative, m, n);
	v->big = xrealloc(NULL, n);
	memcpy(v->big, m, n);
	v->bigLength = n;
	v->bigNegative = negative != 0;
	return v;
}
op_value *op_uint(uint64_t n) {
	unsigned char m[8];
	return op_whole(0, m, whole_of_u64(n, m));
}
op_value *op_int(int64_t n) {
	unsigned char m[8];
	uint64_t u = n < 0 ? (uint64_t)0 - (uint64_t)n : (uint64_t)n;
	return op_whole(n < 0, m, whole_of_u64(u, m));
}
int op_as_double(const op_value *v, double *out) {
	if (v == NULL || v->type != OP_NUM) return 0;
	*out = v->num;
	return 1;
}
int op_as_int64(const op_value *v, int64_t *out) {
	if (v == NULL || v->type != OP_NUM) return 0;
	uint64_t u;
	if (v->big) {
		if (!whole_u64(v->big, v->bigLength, &u)) return 0;
		if (v->bigNegative ? u > (uint64_t)INT64_MAX + 1 : u > (uint64_t)INT64_MAX) return 0;
		*out = v->bigNegative ? (int64_t)(0 - u) : (int64_t)u;
		return 1;
	}
	double d = v->num;
	if (!(d >= -9223372036854775808.0 && d < 9223372036854775808.0) || d != floor(d)) return 0;
	*out = (int64_t)d;
	return 1;
}
int op_same_num(const op_value *a, const op_value *b) {
	if (a->big || b->big) {
		return a->big && b->big && a->bigNegative == b->bigNegative && a->bigLength == b->bigLength &&
		       memcmp(a->big, b->big, a->bigLength) == 0;
	}
	return a->num == b->num || (a->num != a->num && b->num != b->num);
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
// the index holds positions plus one. A removal puts the last key in the removed one's place, so a
// removal costs the same however many keys there are (key order is not part of a map's value)
static void slot(op_value *m, size_t e) {
	size_t h = hash(m->keys[e]) & (m->slots - 1);
	while (m->index[h]) h = (h + 1) & (m->slots - 1);
	m->index[h] = e + 1;
}
static void unindex(op_value *m) {
	free(m->index);
	m->index = NULL;
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
long op_find(const op_value *map, const char *key) {
	size_t at;
	if (map == NULL || map->type != OP_MAP || lookup(map, key, &at) == NULL) return -1;
	return (long)at;
}
void op_unset(op_value *map, size_t i) {
	size_t last = map->count - 1;
	if (map->index != NULL) {
		// the key's slot is emptied and the cluster after it closed up
		size_t mask = map->slots - 1, h = hash(map->keys[i]) & mask;
		while (!map->index[h] || map->index[h] - 1 != i) h = (h + 1) & mask;
		for (size_t j = h;;) {
			j = (j + 1) & mask;
			if (!map->index[j]) break;
			size_t k = hash(map->keys[map->index[j] - 1]) & mask;
			if (h <= j ? (h < k && k <= j) : (h < k || k <= j)) continue;
			map->index[h] = map->index[j];
			h = j;
		}
		map->index[h] = 0;
		if (i != last) {
			// the last key is about to be at i
			h = hash(map->keys[last]) & mask;
			while (map->index[h] != last + 1) h = (h + 1) & mask;
			map->index[h] = i + 1;
		}
	}
	op_name_free(map->keys[i]);
	if (i != last && (map->index != NULL || map->count > 16)) {
		map->keys[i] = map->keys[last];
		map->items[i] = map->items[last];
	} else {
		memmove(map->keys + i, map->keys + i + 1, (last - i) * sizeof *map->keys);
		memmove(map->items + i, map->items + i + 1, (last - i) * sizeof *map->items);
	}
	map->count--;
}
// the key a name already (shared: given), or a string to make one of
static void put(op_value *map, const char *key, char *shared, op_value *v) {
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
	map->keys[map->count] = shared != NULL ? op_name_ref(shared) : op_name(key);
	map->items[map->count++] = v;
	if (map->index != NULL) {
		if (map->slots >= 2 * map->count) slot(map, map->count - 1);
		else unindex(map);
	}
}
void op_set(op_value *map, const char *key, op_value *v) { put(map, key, NULL, v); }
void op_set_name(op_value *map, char *name, op_value *v) { put(map, name, name, v); }
op_value *op_map_copy(const op_value *from) {
	op_value *to = make(OP_MAP);
	if (from->count == 0) return to;
	to->items = xrealloc(NULL, from->count * sizeof *to->items);
	memcpy(to->items, from->items, from->count * sizeof *to->items);
	to->keys = xrealloc(NULL, from->count * sizeof *to->keys);
	for (size_t i = 0; i < from->count; i++) to->keys[i] = op_name_ref(from->keys[i]);
	to->capacity = to->count = from->count;
	op_map_table_copy(to, from);
	return to;
}
void op_map_table_copy(op_value *to, const op_value *from) {
	if (from->index == NULL) return;
	to->slots = from->slots;
	to->index = xrealloc(NULL, from->slots * sizeof *from->index);
	memcpy(to->index, from->index, from->slots * sizeof *from->index);
}
op_value *op_ref(op_value *v) {
	if (v != NULL) v->refs++;
	return v;
}
// no recursion: what a value holds waits on a stack of its own, so it may nest as deep as memory allows
void op_free(op_value *v) {
	op_value **stack = NULL;
	size_t n = 0, room = 0;
	for (; v != NULL; v = n ? stack[--n] : NULL) {
		if (v->refs) {
			v->refs--;
			continue;
		}
		if (v->type == OP_LIST || v->type == OP_MAP || v->type == OP_STAND) {
			for (size_t i = 0; i < v->count; i++) {
				if (v->items[i] != NULL) {
					if (n == room) stack = xrealloc(stack, (room = room ? room * 2 : 16) * sizeof *stack);
					stack[n++] = v->items[i];
				}
				if (v->type == OP_MAP) op_name_free(v->keys[i]);
			}
			free(v->items);
			free(v->keys);
			free(v->index);
		} else if (v->type == OP_STR || v->type == OP_BYTES || v->type == OP_TYPED) free(v->str);
		else if (v->type == OP_NUM) free(v->big);
		free(v);
	}
	free(stack);
}
