#include "blop.h"

#include "cbor.h"
#include "../../c/blake3/blake3.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

// the table's order: the first field that says no is the one named
static const char *const fields[] = {
	"node", "object", "actor", "reader", "site", "cause", "signer", "nonce", "parents", "base",
	"combine", "lamport", "patches",
};
enum { FIELDS = sizeof fields / sizeof *fields };

static int optional(const char *key) {
	return strcmp(key, "reader") == 0 || strcmp(key, "site") == 0 || strcmp(key, "cause") == 0 ||
		strcmp(key, "base") == 0 || strcmp(key, "combine") == 0;
}

static int known(const char *key, size_t length) {
	for (int i = 0; i < FIELDS; i++)
		if (strlen(fields[i]) == length && memcmp(fields[i], key, length) == 0) return 1;
	return 0;
}

// --- the kinds ---

// an integer from 0 to 2^53 - 1
static int whole(const Json *x) {
	if (x == NULL || x->type != JSON_NUMBER) return 0;
	double n = x->number;
	return isfinite(n) && n == floor(n) && n >= 0 && n <= 9007199254740991.0 && !signbit(n);
}

static int sized(const Json *x, size_t n) {
	return x != NULL && x->type == JSON_BYTES && x->bytes.length == n;
}

static int is_string(const Json *x) {
	return x != NULL && x->type == JSON_STRING;
}

static int compare(const Json *a, const Json *b) {
	return memcmp(a->bytes.data, b->bytes.data, 32);
}

static int has(const Json *o, const char *key) {
	return jsonGet(o, key) != NULL;
}

// every key of the object is in the list
static int only(const Json *o, const char *const *keys, int n) {
	for (int i = 0; i < o->object.count; i++) {
		int found = 0;
		for (int j = 0; j < n; j++) {
			if (strlen(keys[j]) == o->object.members[i].keyLength &&
				memcmp(keys[j], o->object.members[i].key, o->object.members[i].keyLength) == 0)
				found = 1;
		}
		if (!found) return 0;
	}
	return 1;
}

static int is_key(const Json *k) {
	return is_string(k) || whole(k);
}

static int is_range(const Json *r) {
	return r != NULL && r->type == JSON_ARRAY && r->array.count == 2 && whole(r->array.items[0]) &&
		whole(r->array.items[1]);
}

// {path, range?}, with only these keys (and value, move for a patch)
static int place(const Json *x, const char *const *keys, int n) {
	if (!jsonIsObject(x) || !only(x, keys, n)) return 0;
	const Json *path = jsonGet(x, "path");
	if (path == NULL || path->type != JSON_ARRAY) return 0;
	for (int i = 0; i < path->array.count; i++)
		if (!is_key(path->array.items[i])) return 0;
	return !has(x, "range") || is_range(jsonGet(x, "range"));
}

static const char *const patch_keys[] = {"path", "range", "value", "move"};
static const char *const move_keys[] = {"path", "range"};

static int site(const Json *x) {
	static const char *const keys[] = {"file", "line", "column", "function"};
	if (!jsonIsObject(x) || !is_string(jsonGet(x, "file")) || !whole(jsonGet(x, "line"))) return 0;
	if (!only(x, keys, 4)) return 0;
	if (has(x, "column") && !whole(jsonGet(x, "column"))) return 0;
	return !has(x, "function") || is_string(jsonGet(x, "function"));
}

static int object_rule(const Json *v) {
	if (is_string(v)) return strcmp(v->string, "value") == 0;
	if (v == NULL || v->type != JSON_ARRAY || v->array.count != 2) return 0;
	const Json *w = v->array.items[0];
	return is_string(w) && (strcmp(w->string, "info") == 0 || strcmp(w->string, "children") == 0) &&
		is_string(v->array.items[1]);
}

static int parents_rule(const Json *v) {
	if (v == NULL || v->type != JSON_ARRAY) return 0;
	for (int i = 0; i < v->array.count; i++)
		if (!sized(v->array.items[i], 32)) return 0;
	for (int i = 1; i < v->array.count; i++)
		if (compare(v->array.items[i - 1], v->array.items[i]) >= 0) return 0;
	return 1;
}

static int base_rule(const Json *v, const Json *b) {
	const Json *parents = jsonGet(b, "parents");
	if (!sized(v, 32) || parents == NULL || parents->type != JSON_ARRAY || parents->array.count < 2)
		return 0;
	for (int i = 0; i < parents->array.count; i++)
		if (sized(parents->array.items[i], 32) && compare(parents->array.items[i], v) == 0) return 1;
	return 0;
}

static int patches_rule(const Json *v) {
	if (v == NULL || v->type != JSON_ARRAY) return 0;
	for (int i = 0; i < v->array.count; i++) {
		const Json *p = v->array.items[i];
		if (!place(p, patch_keys, 4)) return 0;
		if (has(p, "move") && (has(p, "value") || !place(jsonGet(p, "move"), move_keys, 2))) return 0;
	}
	return 1;
}

// each field's own rule, given the blop for base's
static int rule(int field, const Json *v, const Json *b) {
	switch (field) {
	case 0: return is_string(v);
	case 1: return object_rule(v);
	case 2: return 1;
	case 3: return is_string(v);
	case 4: return site(v);
	case 5: return 1;
	case 6: return sized(v, 32);
	case 7: return sized(v, 8);
	case 8: return parents_rule(v);
	case 9: return base_rule(v, b);
	case 10: return v->type == JSON_BOOLEAN && v->boolean && has(b, "base");
	case 11: return whole(v) && v->number >= 1;
	default: return patches_rule(v);
	}
}

// a key not listed, then the first field that says no, in the table's order; NULL: a blop
static const char *check(const Json *b) {
	// of several keys not listed, the first in canonical order: shorter first, then bytewise
	const char *stray = NULL;
	size_t strayLength = 0;
	for (int i = 0; i < b->object.count; i++) {
		const char *k = b->object.members[i].key;
		size_t n = b->object.members[i].keyLength;
		if (known(k, n)) continue;
		if (stray == NULL || n < strayLength || (n == strayLength && memcmp(k, stray, n) < 0))
			stray = k, strayLength = n;
	}
	if (stray != NULL) return stray;
	for (int i = 0; i < FIELDS; i++) {
		const Json *v = jsonGet(b, fields[i]);
		if (v == NULL) {
			const Json *parents = jsonGet(b, "parents");
			int needed = !optional(fields[i]) ||
				(strcmp(fields[i], "base") == 0 && parents != NULL && parents->type == JSON_ARRAY &&
				 parents->array.count >= 2);
			if (needed) return fields[i];
		} else if (!rule(i, v, b)) return fields[i];
	}
	return NULL;
}

// --- the operations ---

blop_error blop_encode(const Json *blop, uint8_t **out, size_t *length) {
	blop_error e = {BLOP_NOT_A_BLOP, NULL};
	*out = NULL;
	if (!jsonIsObject(blop)) return e;
	const char *field = check(blop);
	if (field != NULL) return e.field = copyString(field), e;
	size_t n = 0;
	const char *why;
	if (!cborEncode(blop, NULL, 0, &n, &why)) {
		// which: each again, only when one failed
		e.code = BLOP_CANNOT_CARRY;
		for (int i = 0; i < FIELDS; i++) {
			const Json *v = jsonGet(blop, fields[i]);
			if (v != NULL && !cborEncode(v, NULL, 0, &n, &why)) return e.field = copyString(fields[i]), e;
		}
		return e;
	}
	uint8_t *bytes = malloc(n ? n : 1);
	if (bytes == NULL) abort();
	cborEncode(blop, bytes, n, &n, &why);
	*out = bytes;
	*length = n;
	return (blop_error){BLOP_OK, NULL};
}

blop_error blop_decode(const uint8_t *bytes, size_t length, Json **blop) {
	blop_error e = {BLOP_NOT_A_BLOP, NULL};
	*blop = NULL;
	Json *x = cborDecode(bytes, length, NULL, NULL);
	if (x == NULL) return e;
	if (!jsonIsObject(x)) return jsonFree(x), e;
	const char *field = check(x);
	if (field != NULL) return e.field = copyString(field), jsonFree(x), e;
	*blop = x;
	return (blop_error){BLOP_OK, NULL};
}

void blop_name(const uint8_t *bytes, size_t length, uint8_t name[32]) {
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, bytes, length);
	blake3_hasher_finalize(&h, name, 32);
}
