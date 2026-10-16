// val.c: op_value and Json, each into the other (val.h).

#include "val.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// --- what jsonOfValKept keeps: each value and its Json, both held, by either's address

typedef struct {
	op_value *v;
	Json *j;
	unsigned last; // the turn it was last read
} Kept;

static struct {
	Kept *items;
	size_t n, room;
	size_t *byV, *byJ; // open addressing, items' index + 1; 0: empty
	size_t slots;      // a power of two, more than twice n
	unsigned turn;
} K;

static size_t hashOf(const void *p) {
	uintptr_t x = (uintptr_t)p;
	x ^= x >> 33;
	x *= 0xff51afd7ed558ccdull;
	x ^= x >> 33;
	return (size_t)x;
}

static void rehash(size_t slots) {
	free(K.byV), free(K.byJ);
	K.slots = slots;
	K.byV = calloc(slots, sizeof *K.byV);
	K.byJ = calloc(slots, sizeof *K.byJ);
	for (size_t i = 0; i < K.n; i++) {
		size_t a = hashOf(K.items[i].v) & (slots - 1), b = hashOf(K.items[i].j) & (slots - 1);
		while (K.byV[a]) a = (a + 1) & (slots - 1);
		while (K.byJ[b]) b = (b + 1) & (slots - 1);
		K.byV[a] = i + 1, K.byJ[b] = i + 1;
	}
}

static Kept *byValue(const op_value *v) {
	if (!K.slots) return NULL;
	for (size_t a = hashOf(v) & (K.slots - 1); K.byV[a]; a = (a + 1) & (K.slots - 1))
		if (K.items[K.byV[a] - 1].v == v) return &K.items[K.byV[a] - 1];
	return NULL;
}

static Kept *byJson(const Json *j) {
	if (!K.slots) return NULL;
	for (size_t b = hashOf(j) & (K.slots - 1); K.byJ[b]; b = (b + 1) & (K.slots - 1))
		if (K.items[K.byJ[b] - 1].j == j) return &K.items[K.byJ[b] - 1];
	return NULL;
}

static void keep(op_value *v, Json *j) {
	if (K.n == K.room) {
		K.room = K.room ? K.room * 2 : 1024;
		K.items = realloc(K.items, sizeof *K.items * K.room);
	}
	K.items[K.n++] = (Kept){op_ref(v), jsonRef(j), K.turn};
	if (K.n * 2 >= K.slots) rehash(K.slots ? K.slots * 2 : 4096);
	else {
		size_t a = hashOf(v) & (K.slots - 1), b = hashOf(j) & (K.slots - 1);
		while (K.byV[a]) a = (a + 1) & (K.slots - 1);
		while (K.byJ[b]) b = (b + 1) & (K.slots - 1);
		K.byV[a] = K.n, K.byJ[b] = K.n;
	}
}

void valSweep(void) {
	K.turn++;
	size_t k = 0;
	for (size_t i = 0; i < K.n; i++) {
		if (K.turn - K.items[i].last <= 8) K.items[k++] = K.items[i];
		else op_free(K.items[i].v), jsonFree(K.items[i].j);
	}
	if (k == K.n) return;
	K.n = k;
	rehash(K.slots);
}

static bool kept(const op_value *v) {
	return v->type == OP_LIST || v->type == OP_MAP || v->type == OP_BYTES || v->type == OP_TYPED;
}

Json *jsonOfValKept(const op_value *v) {
	if (!v) return NULL;
	if (!kept(v)) return jsonOfVal(v);
	Kept *was = byValue(v);
	if (was) {
		was->last = K.turn;
		return jsonRef(was->j);
	}
	Json *j;
	if (v->type == OP_LIST) {
		j = jsonArray();
		for (size_t i = 0; i < v->count; i++) jsonPush(j, jsonOfValKept(v->items[i]));
	} else if (v->type == OP_MAP) {
		j = jsonObject();
		for (size_t i = 0; i < v->count; i++) jsonAdd(j, v->keys[i], jsonOfValKept(v->items[i]));
	} else j = jsonOfVal(v);
	keep((op_value *)v, j);
	return j;
}

op_value *valOf(const Json *j) {
	if (!j) return op_null();
	Kept *was = byJson(j);
	if (was) {
		was->last = K.turn;
		return op_ref(was->v);
	}
	switch (j->type) {
	case JSON_NULL: return op_null();
	case JSON_BOOLEAN: return op_bool(j->boolean);
	case JSON_NUMBER: return op_num(j->number);
	case JSON_STRING: return op_str_n(j->string, j->stringLength);
	case JSON_BYTES: return op_bytes(j->bytes.data, j->bytes.length);
	case JSON_TYPED: return op_typed((op_elements)j->typed.kind, j->typed.data, j->typed.count);
	case JSON_STAND: return op_stand(valOf(j->stand.kind));
	case JSON_ARRAY: {
		op_value *l = op_list();
		for (int i = 0; i < j->array.count; i++) op_push(l, valOf(j->array.items[i]));
		return l;
	}
	case JSON_OBJECT: {
		op_value *m = op_map();
		for (int i = 0; i < j->object.count; i++) op_set(m, j->object.members[i].key, valOf(j->object.members[i].value));
		return m;
	}
	}
	return op_null();
}

Json *jsonOfVal(const op_value *v) {
	if (!v) return NULL;
	switch (v->type) {
	case OP_NULL: return jsonNull();
	case OP_BOOL: return jsonBoolean(v->bool_);
	case OP_NUM: return jsonNumber(v->num);
	case OP_STR: return jsonStringOfLength(v->str, v->bytes);
	case OP_BYTES: return jsonBytes(v->data, v->bytes);
	case OP_TYPED: return jsonTyped((JsonKind)v->kind, v->data, op_length(v));
	case OP_STAND: return jsonStand(jsonOfVal(v->count ? v->items[0] : NULL));
	case OP_LIST: {
		Json *a = jsonArray();
		for (size_t i = 0; i < v->count; i++) jsonPush(a, jsonOfVal(v->items[i]));
		return a;
	}
	case OP_MAP: {
		Json *o = jsonObject();
		for (size_t i = 0; i < v->count; i++) jsonAdd(o, v->keys[i], jsonOfVal(v->items[i]));
		return o;
	}
	}
	return jsonNull();
}

op_patch valWhole(const op_value *v) {
	static op_value *null;
	if (!null) null = op_null();
	return (op_patch){ .has_value = 1, .value = v ? v : null };
}

op_patch valKey(const char *key, const op_value *v) {
	static op_value *null;
	if (!null) null = op_null();
	op_key *k = calloc(1, sizeof *k);
	k->type = OP_STR_KEY;
	k->s = strdup(key);
	return (op_patch){ .place = { .path = k, .length = 1 }, .has_value = 1, .value = v ? v : null };
}

int valEqual(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (!a || !b || a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return a->num == b->num || (a->num != a->num && b->num != b->num);
	case OP_STR: return a->bytes == b->bytes && !memcmp(a->str, b->str, a->bytes);
	case OP_BYTES: return a->bytes == b->bytes && (!a->bytes || !memcmp(a->data, b->data, a->bytes));
	case OP_TYPED: return a->kind == b->kind && a->bytes == b->bytes && (!a->bytes || !memcmp(a->data, b->data, a->bytes));
	case OP_STAND:
	case OP_LIST:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++)
			if (!valEqual(a->items[i], b->items[i])) return 0;
		return 1;
	case OP_MAP:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++)
			if (!valEqual(a->items[i], op_get(b, a->keys[i]))) return 0;
		return 1;
	}
	return 0;
}

char *valPrint(const op_value *v) {
	Json *j = jsonOfVal(v);
	char *text = j ? jsonPrint(j) : strdup("(none)");
	jsonFree(j);
	return text;
}
