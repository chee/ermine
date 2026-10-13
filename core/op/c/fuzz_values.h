// op values and patches made from fuzz bytes, for the libFuzzer targets of op, node and paths
// (apply_fuzz.c, update_fuzz.c, paths_fuzz.c): small values of every kind, patches aimed mostly
// at what is there, a deep copy and an equality (maps by content). Bytes run out as zeros.
#ifndef OP_FUZZ_VALUES_H
#define OP_FUZZ_VALUES_H

#include <stdlib.h>
#include <string.h>

#include "apply.h"
#include "value.h"

typedef struct {
	const unsigned char *data;
	size_t size, at;
} fz_bytes;

static inline unsigned fz_byte(fz_bytes *b) { return b->at < b->size ? b->data[b->at++] : 0; }

static const char *const fz_names[] = {"a", "b", "c", "d"};

// code points: one, two, three and four bytes, a lone high and a lone low (as WTF-8)
static const char *const fz_chars[] = {"a", "\xc3\xa9", "\xe2\x82\xac", "\xf0\x9f\x98\x80", "\xed\xa0\x80", "\xed\xb0\x80"};

static inline op_value *fz_value(fz_bytes *b, int depth) {
	unsigned c = fz_byte(b), n;
	switch (c % (depth >= 3 ? 6 : 9)) {
	case 0: return op_null();
	case 1: return op_bool(c >> 4 & 1);
	case 2: return op_num((double)(c >> 4));
	case 3: {
		char s[32];
		size_t len = 0;
		int high = 0;
		for (n = fz_byte(b) % 6; n > 0; n--) {
			unsigned k = fz_byte(b) % 6;
			if (high && k == 5) k = 0; // a high then a low is a pair, not two lone ones
			high = k == 4;
			len += strlen(strcpy(s + len, fz_chars[k]));
		}
		return op_str_n(s, len);
	}
	case 4: {
		unsigned char d[4];
		n = fz_byte(b) % 4;
		for (unsigned i = 0; i < n; i++) d[i] = (unsigned char)fz_byte(b);
		return op_bytes(d, n);
	}
	case 5: {
		unsigned char d[3 * 8];
		op_elements kind = (op_elements)(fz_byte(b) % 9);
		n = fz_byte(b) % 4;
		for (size_t i = 0; i < n * op_size(kind); i++) d[i] = (unsigned char)fz_byte(b);
		return op_typed(kind, d, n);
	}
	case 6: {
		op_value *l = op_list();
		for (n = fz_byte(b) % 4; n > 0; n--) op_push(l, fz_value(b, depth + 1));
		return l;
	}
	case 7: {
		op_value *m = op_map();
		for (n = fz_byte(b) % 4; n > 0; n--) {
			const char *k = fz_names[fz_byte(b) % 4];
			if (op_get(m, k) == NULL) op_set(m, k, fz_value(b, depth + 1));
		}
		return m;
	}
	default: return op_stand(fz_value(b, depth + 1));
	}
}

static inline op_value *fz_copy(const op_value *v) {
	if (v == NULL) return NULL;
	op_value *c;
	switch (v->type) {
	case OP_NULL: return op_null();
	case OP_BOOL: return op_bool(v->bool_);
	case OP_NUM: return op_num(v->num);
	case OP_STR: return op_str_n(v->str, v->bytes);
	case OP_BYTES: return op_bytes(v->data, v->bytes);
	case OP_TYPED: return op_typed(v->kind, v->data, op_length(v));
	case OP_STAND: return op_stand(fz_copy(v->items[0]));
	case OP_LIST:
		c = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(c, fz_copy(v->items[i]));
		return c;
	case OP_MAP:
		c = op_map();
		for (size_t i = 0; i < v->count; i++) op_set(c, v->keys[i], fz_copy(v->items[i]));
		return c;
	}
	abort();
}

// the same content; a map's keys in any order
static inline int fz_equal(const op_value *a, const op_value *b) {
	if (a == NULL || b == NULL) return a == b;
	if (a->type != b->type) return 0;
	switch (a->type) {
	case OP_NULL: return 1;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return a->num == b->num;
	case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
	case OP_TYPED:
		if (a->kind != b->kind) return 0;
		// fall through
	case OP_BYTES: return a->bytes == b->bytes && (a->bytes == 0 || memcmp(a->data, b->data, a->bytes) == 0);
	case OP_STAND: return fz_equal(a->items[0], b->items[0]);
	case OP_LIST:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++)
			if (!fz_equal(a->items[i], b->items[i])) return 0;
		return 1;
	case OP_MAP:
		if (a->count != b->count) return 0;
		for (size_t i = 0; i < a->count; i++)
			if (!fz_equal(a->items[i], op_get(b, a->keys[i]))) return 0;
		return 1;
	}
	return 0;
}

// every value in the tree has no holder past its first: what a caller made and still owns alone
static inline int fz_unshared(const op_value *v) {
	if (v == NULL) return 1;
	if (v->refs != 0) return 0;
	for (size_t i = 0; i < v->count; i++)
		if (!fz_unshared(v->items[i])) return 0;
	return 1;
}

// patches: their keys and values are fz_patches' own
enum { FZ_PATCHES = 6, FZ_DEPTH = 4 };
typedef struct {
	op_patch p[FZ_PATCHES];
	op_key keys[FZ_PATCHES][2][FZ_DEPTH];
	op_value *values[FZ_PATCHES];
	size_t n;
} fz_patches;

// a path: mostly a walk down what is in v (a key there, or one past a list's end), sometimes any
// key; rarely a negative number (not a patch)
static inline void fz_target(fz_bytes *b, const op_value *v, op_target *t, op_key *keys) {
	unsigned c = fz_byte(b);
	size_t n = c % FZ_DEPTH;
	for (size_t i = 0; i < n; i++) {
		unsigned k = fz_byte(b);
		if (k % 8 != 0 && v != NULL && v->type == OP_MAP && v->count) {
			size_t j = (k >> 3) % v->count, x = 0;
			// the name, not the map's copy of it: the patch may outlive the map
			while (x < 3 && strcmp(fz_names[x], v->keys[j]) != 0) x++;
			keys[i] = (op_key){.type = OP_STR_KEY, .s = fz_names[x]};
			v = v->items[j];
		} else if (k % 8 != 0 && v != NULL && v->type == OP_LIST) {
			size_t j = (k >> 3) % (v->count + 1);
			keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)j};
			v = j < v->count ? v->items[j] : NULL;
		} else if (k % 16 == 8) {
			keys[i] = (op_key){.type = OP_NUM_KEY, .n = k == 8 ? -1 : (long)(k >> 4) % 4};
			v = NULL;
		} else {
			keys[i] = (op_key){.type = OP_STR_KEY, .s = fz_names[(k >> 4) % 4]};
			v = NULL;
		}
	}
	*t = (op_target){.path = keys, .length = n};
	if (c & 0x80) {
		unsigned r = fz_byte(b);
		t->has_range = 1;
		t->from = r % 4;
		t->to = r & 0x40 ? t->from + (long)(r >> 2) % 3 : (long)(r >> 2) % 5;
		if (r == 0xff) t->from = -1;
	}
}

// up to FZ_PATCHES patches aimed at v: a put, a removal, or a move
static inline void fz_patch_list(fz_bytes *b, const op_value *v, fz_patches *out) {
	memset(out, 0, sizeof *out);
	out->n = fz_byte(b) % (FZ_PATCHES + 1);
	for (size_t i = 0; i < out->n; i++) {
		op_patch *p = &out->p[i];
		unsigned kind = fz_byte(b) % 4;
		fz_target(b, v, &p->place, out->keys[i][0]);
		if (kind <= 1) {
			p->has_value = 1;
			p->value = out->values[i] = fz_value(b, 1);
		} else if (kind == 3) {
			p->has_move = 1;
			fz_target(b, v, &p->move, out->keys[i][1]);
		}
	}
}

// KNOWN (core/op/c/repro-undo-ranged-move, as in apply.ts): a move whose take is a span
// of a list and whose landing is unranged at or past the span's start in that list: the undo moves
// the span back in front of the landing, then puts what the landing replaced at its old, unshifted
// index. Its round trip is not checked
static inline int fz_known(const fz_patches *ps) {
	for (size_t i = 0; i < ps->n; i++) {
		const op_patch *p = &ps->p[i];
		const op_target *P = &p->place, *F = &p->move;
		if (!p->has_move || !F->has_range || P->has_range || P->length <= F->length) continue;
		size_t k = 0;
		while (k < F->length && P->path[k].type == F->path[k].type &&
			(P->path[k].type == OP_NUM_KEY ? P->path[k].n == F->path[k].n : strcmp(P->path[k].s, F->path[k].s) == 0)) k++;
		if (k == F->length && P->path[k].type == OP_NUM_KEY && P->path[k].n >= F->from) return 1;
	}
	return 0;
}

static inline void fz_patches_free(fz_patches *ps) {
	for (size_t i = 0; i < ps->n; i++) op_free(ps->values[i]);
	ps->n = 0;
}

#endif
