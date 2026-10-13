// The C apply (apply.h) and invert (invert.h) on the line protocol of
// conformance/op-apply/harness.ts: one JSON request per line in, one answer per line out, in order. Lines are read and answers printed with
// ermine/encoding/c/json.h; a value's "/" forms are decoded one by one (jsonDecode on the form
// alone), so a string anywhere else may hold lone surrogates, as apply counts them.
//
// As the reference, every call is checked: the value given and the patches' values unchanged. And the ownership rules of apply.h and
// invert.h: the value given and the patches' values are let go of before the answer is made from
// what came out.
#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "apply.h"
#include "invert.h"
#include "../../../ermine/encoding/c/json.h"

// values in

// a typed array's elements, its C type's, as op's: little-endian
static op_value *typed_in(const Json *j) {
	size_t z = jsonKindSize(j->typed.kind), n = j->typed.count;
	unsigned char *buf = allocate(n * z + 1);
	for (size_t i = 0; i < n; i++) {
		uint64_t u = 0;
		const unsigned char *at = (const unsigned char *)j->typed.data + i * z;
		if (z == 1) u = *at;
		else if (z == 2) { uint16_t x; memcpy(&x, at, 2); u = x; }
		else if (z == 4) { uint32_t x; memcpy(&x, at, 4); u = x; }
		else memcpy(&u, at, 8);
		for (size_t b = 0; b < z; b++) buf[i * z + b] = (unsigned char)(u >> (8 * b));
	}
	op_value *v = op_typed((op_elements)j->typed.kind, buf, n);
	free(buf);
	return v;
}
// a value with no forms left in it
static op_value *plain(const Json *j) {
	op_value *v;
	switch (j->type) {
	case JSON_NULL: return op_null();
	case JSON_BOOLEAN: return op_bool(j->boolean);
	case JSON_NUMBER: return op_num(j->number);
	case JSON_STRING: return op_str_n(j->string, j->stringLength);
	case JSON_BYTES: return op_bytes(j->bytes.data, j->bytes.length);
	case JSON_TYPED: return typed_in(j);
	case JSON_STAND: return op_stand(plain(j->stand.kind));
	case JSON_ARRAY:
		v = op_list();
		for (int i = 0; i < j->array.count; i++) op_push(v, plain(j->array.items[i]));
		return v;
	case JSON_OBJECT:
		v = op_map();
		for (int i = 0; i < j->object.count; i++) op_set(v, j->object.members[i].key, plain(j->object.members[i].value));
		return v;
	}
	return op_null();
}
static int slash(const Json *j) {
	return jsonIsObject(j) && j->object.count == 1 && j->object.members[0].keyLength == 1 &&
		j->object.members[0].key[0] == '/';
}
// the value a line's JSON stands for; NULL, *bad set, when a form is malformed
static op_value *value_of(Json **at, int *bad) {
	Json *j = *at;
	if (slash(j)) {
		if (!jsonDecode(at)) return *bad = 1, NULL;
		return plain(*at);
	}
	if (j->type != JSON_ARRAY && j->type != JSON_OBJECT) return plain(j);
	int map = j->type == JSON_OBJECT;
	op_value *v = map ? op_map() : op_list();
	int n = map ? j->object.count : j->array.count;
	for (int i = 0; i < n; i++) {
		op_value *x = value_of(map ? &j->object.members[i].value : &j->array.items[i], bad);
		if (x == NULL) {
			op_free(v);
			return NULL;
		}
		if (map) op_set(v, j->object.members[i].key, x);
		else op_push(v, x);
	}
	return v;
}
// where a key's value is in an object, to decode in place; NULL when absent
static Json **member(Json *o, const char *key) {
	if (!jsonIsObject(o)) return NULL;
	for (int i = 0; i < o->object.count; i++)
		if (o->object.members[i].keyLength == strlen(key) && strcmp(o->object.members[i].key, key) == 0)
			return &o->object.members[i].value;
	return NULL;
}

// values out

static Json *json_of(const op_value *v) {
	Json *j;
	switch (v->type) {
	case OP_NULL: return jsonNull();
	case OP_BOOL: return jsonBoolean(v->bool_);
	case OP_NUM: return jsonNumber(v->num);
	case OP_STR: return jsonStringOfLength(v->str, v->bytes);
	case OP_BYTES: return jsonBytes(v->data, v->bytes);
	case OP_STAND: return jsonStand(json_of(v->items[0]));
	case OP_TYPED: {
		size_t z = op_size(v->kind), n = op_length(v);
		unsigned char *buf = allocate(n * z + 1);
		for (size_t i = 0; i < n; i++) {
			uint64_t u = 0;
			for (size_t b = 0; b < z; b++) u |= (uint64_t)v->data[i * z + b] << (8 * b);
			unsigned char *at = buf + i * z;
			if (z == 1) *at = (unsigned char)u;
			else if (z == 2) { uint16_t x = (uint16_t)u; memcpy(at, &x, 2); }
			else if (z == 4) { uint32_t x = (uint32_t)u; memcpy(at, &x, 4); }
			else memcpy(at, &u, 8);
		}
		j = jsonTyped((JsonKind)v->kind, buf, n);
		free(buf);
		return j;
	}
	case OP_LIST:
		j = jsonArray();
		for (size_t i = 0; i < v->count; i++) jsonPush(j, json_of(v->items[i]));
		return j;
	case OP_MAP:
		j = jsonObject();
		for (size_t i = 0; i < v->count; i++) jsonAdd(j, v->keys[i], json_of(v->items[i]));
		return j;
	}
	return jsonNull();
}
// a patch of an undo: its path, range, value, move
static Json *keys_json(const op_target *t) {
	Json *a = jsonArray();
	for (size_t i = 0; i < t->length; i++) {
		op_key k = t->path[i];
		jsonPush(a, k.type == OP_NUM_KEY ? jsonInteger((int64_t)k.n) : jsonStringOfLength(k.s, strlen(k.s)));
	}
	return a;
}
static void target_json(Json *j, const op_target *t) {
	jsonAdd(j, "path", keys_json(t));
	if (!t->has_range) return;
	Json *r = jsonArray();
	jsonPush(r, jsonInteger((int64_t)t->from));
	jsonPush(r, jsonInteger((int64_t)t->to));
	jsonAdd(j, "range", r);
}
static Json *patch_json(const op_patch *p) {
	Json *j = jsonObject();
	target_json(j, &p->place);
	if (p->has_value) jsonAdd(j, "value", json_of(p->value));
	if (p->has_move) {
		Json *m = jsonObject();
		target_json(m, &p->move);
		jsonAdd(j, "move", m);
	}
	return j;
}
static void say(Json *answer) {
	char *s = jsonPrint(answer);
	puts(s);
	free(s);
	jsonFree(answer);
}
static void error(const char *why) {
	Json *a = jsonObject();
	jsonAdd(a, "error", jsonString(why));
	say(a);
}

// patches in

// a key no patch has: not-a-patch
static const op_key bad_key = {.type = OP_STR_KEY, .s = NULL};
static long whole(int64_t n) { return n < 0 ? -1 : n > LONG_MAX ? LONG_MAX : (long)n; }
// a target: its path's keys (*keys, freed by the caller), and a range; anything malformed is a
// key or a range no patch has
static void target_of(const Json *t, op_target *out, op_key **keys) {
	memset(out, 0, sizeof *out);
	*keys = NULL;
	const Json *path = jsonIsObject(t) ? jsonGet(t, "path") : NULL;
	if (!jsonIsArray(path)) {
		out->path = &bad_key;
		out->length = 1;
		return;
	}
	op_key *ks = allocate(((size_t)path->array.count + 1) * sizeof *ks);
	for (int i = 0; i < path->array.count; i++) {
		const Json *k = path->array.items[i];
		int64_t n;
		if (jsonIsString(k)) ks[i] = (op_key){.type = OP_STR_KEY, .s = k->string};
		else if (jsonIsWhole(k, &n)) ks[i] = (op_key){.type = OP_NUM_KEY, .n = whole(n)};
		else ks[i] = bad_key;
	}
	*keys = ks;
	out->path = ks;
	out->length = (size_t)path->array.count;
	const Json *r = jsonGet(t, "range");
	if (r == NULL) return;
	int64_t a, b;
	out->has_range = 1;
	out->from = out->to = -1;
	if (jsonIsArray(r) && r->array.count == 2 && jsonIsWhole(r->array.items[0], &a) &&
		jsonIsWhole(r->array.items[1], &b)) out->from = whole(a), out->to = whole(b);
}

// one request's patches and what was made for them
typedef struct {
	size_t n;
	op_patch *patches;
	op_key **keys; // two a patch: its place's, its move's
	op_value **values;
} batch;
static void batch_free(batch *b) {
	for (size_t i = 0; i < 2 * b->n; i++) free(b->keys[i]);
	free(b->keys);
	free(b->patches);
	free(b->values);
}

// the values given, printed: the same after the call
static char *given(const op_value *value, const batch *b) {
	Json *a = jsonArray();
	jsonPush(a, value ? json_of(value) : jsonString("(none)"));
	for (size_t i = 0; i < b->n; i++) jsonPush(a, b->values[i] ? json_of(b->values[i]) : jsonString("(none)"));
	char *s = jsonPrint(a);
	jsonFree(a);
	return s;
}

static void answer(Json *q) {
	const Json *op = jsonGet(q, "op");
	if (!jsonIsObject(q) || !jsonIsString(op) ||
		(strcmp(op->string, "apply") != 0 && strcmp(op->string, "invert") != 0)) {
		error("unknown op");
		return;
	}
	int inverting = strcmp(op->string, "invert") == 0;
	Json *ps = jsonGet(q, "patches");
	if (!jsonIsArray(ps)) {
		error("patches: not a list");
		return;
	}
	int bad = 0;
	Json **at = member(q, "value");
	op_value *value = at ? value_of(at, &bad) : NULL;
	batch b = {(size_t)ps->array.count, NULL, NULL, NULL};
	b.patches = allocate((b.n + 1) * sizeof *b.patches);
	b.keys = allocate((2 * b.n + 1) * sizeof *b.keys);
	b.values = allocate((b.n + 1) * sizeof *b.values);
	for (size_t i = 0; i < b.n && !bad; i++) {
		Json *p = ps->array.items[i];
		op_patch *o = &b.patches[i];
		target_of(p, &o->place, &b.keys[2 * i]);
		Json **v = member(p, "value");
		if (v) {
			o->has_value = 1;
			o->value = b.values[i] = value_of(v, &bad);
		}
		const Json *m = jsonIsObject(p) ? jsonGet(p, "move") : NULL;
		if (m) {
			o->has_move = 1;
			target_of(m, &o->move, &b.keys[2 * i + 1]);
			// a target is a path and a range: one carrying a value or a move is no patch
			if (jsonIsObject(m) && (jsonGet(m, "value") || jsonGet(m, "move"))) o->move.has_range = 1, o->move.from = o->move.to = -1;
		}
	}
	if (bad) {
		error("a value's form is malformed");
		op_free(value);
		for (size_t i = 0; i < b.n; i++) op_free(b.values[i]);
		batch_free(&b);
		return;
	}
	const Json *l = jsonGet(q, "list");
	if (inverting) {
		op_invert_options io = {l && l->type == JSON_BOOLEAN && l->boolean};
		op_undo undo = {0};
		size_t failed = 0;
		char *before = given(value, &b);
		int code = op_invert(value, b.patches, b.n, &io, &undo, &failed);
		char *after = given(value, &b);
		int changed = strcmp(before, after) != 0;
		free(before);
		free(after);
		// what was given, let go of: the undo holds its own
		op_free(value);
		for (size_t i = 0; i < b.n; i++) op_free(b.values[i]);
		Json *a = jsonObject();
		if (code != OP_OK) {
			Json *err = jsonObject();
			jsonAdd(err, "code", jsonString(op_code_name(code)));
			jsonAdd(err, "patch", jsonInteger((int64_t)failed));
			jsonAdd(a, "error", err);
		} else {
			Json *u = jsonArray();
			for (size_t i = 0; i < undo.n; i++) jsonPush(u, patch_json(&undo.patches[i]));
			jsonAdd(a, "undo", u);
		}
		if (changed) {
			jsonFree(a);
			error("a value given changed");
		} else say(a);
		op_undo_free(&undo);
		batch_free(&b);
		return;
	}
	op_apply_options o = {.list = l && l->type == JSON_BOOLEAN && l->boolean};
	char *before = given(value, &b);
	op_value *out = NULL;
	size_t failed = 0;
	int code = op_apply(value, b.patches, b.n, &o, &out, &failed);
	char *after = given(value, &b);
	int changed = strcmp(before, after) != 0;
	free(before);
	free(after);
	// what was given, let go of: what came out holds its own
	op_free(value);
	for (size_t i = 0; i < b.n; i++) op_free(b.values[i]);
	Json *a = jsonObject();
	if (code != OP_OK) {
		Json *err = jsonObject();
		jsonAdd(err, "code", jsonString(op_code_name(code)));
		jsonAdd(err, "patch", jsonInteger((int64_t)failed));
		jsonAdd(a, "error", err);
	} else if (out) jsonAdd(a, "value", json_of(out));
	if (changed) {
		jsonFree(a);
		error("a value given changed");
	} else say(a);
	op_free(out);
	batch_free(&b);
}

int main(void) {
	char *line = NULL;
	size_t size = 0;
	ssize_t n;
	while ((n = getline(&line, &size, stdin)) > 0) {
		if (strspn(line, " \t\r\n") == (size_t)n) continue;
		char *why = NULL;
		Json *q = jsonParse(line, (size_t)n, &why);
		if (q == NULL) {
			error(why ? why : "bad json");
			free(why);
		} else {
			answer(q);
			jsonFree(q);
		}
		fflush(stdout);
	}
	free(line);
	return 0;
}
