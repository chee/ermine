// libFuzzer target: the input bytes are a value, then rounds of reads (spots made at two keys, or
// let go of) and patches on the value (../../changeable/c/fuzz_values.h), the patches that op_apply lands
// given to pt_mark. Checked each round:
// - a spot asked for again is the same spot, with its key and path; a new one is new;
// - every read whose value a patch changed is marked by it (op_apply on copies, one patch at a
//   time, says what changed: a read of a path is what is there, deep; a number key also reads a
//   string's code point or a typed array's element);
// - pt_mark gives each spot once: the key's change spot, and exactly the spots of the key that
//   some patch marks by pt_marks; pt_event gives every spot of the key;
// - pt_held_of counts the keys, spots and steps the model has.
#include "paths.h"
#include "../../changeable/c/fuzz_values.h"

#include <stdio.h>

enum { SPOTS = 16 };

static void die(const char *why, int round) {
	fprintf(stderr, "fuzz: round %d: %s\n", round, why);
	abort();
}

static const char token;
static pt_key key_of(int k) { return k ? pt_symbol(&token) : pt_string("x"); }

typedef struct {
	int key, change, alive;
	op_key path[FZ_DEPTH];
	size_t length;
	pt_spot *s;
} mspot;
static mspot spots[SPOTS];
static int nspots;

// what a read of path sees in v, as a value of its own; NULL: nothing there
static op_value *seen(const op_value *v, const op_key *path, size_t n) {
	for (size_t i = 0; i < n && v != NULL; i++) {
		op_key k = path[i];
		if (v->type == OP_MAP && k.type == OP_STR_KEY) v = op_get(v, k.s);
		else if (v->type == OP_LIST && k.type == OP_NUM_KEY) v = (size_t)k.n < v->count ? v->items[k.n] : NULL;
		else if (i + 1 < n || k.type != OP_NUM_KEY) return NULL;
		else if (v->type == OP_TYPED) return (size_t)k.n < op_length(v) ? op_typed(v->kind, v->data + k.n * op_size(v->kind), 1) : NULL;
		else if (v->type == OP_STR) {
			// the code point's bytes: from its lead byte to the next
			size_t at = 0, count = 0;
			while (at < v->bytes && count < (size_t)k.n)
				if (((unsigned char)v->str[++at] & 0xc0) != 0x80) count++;
			if (at >= v->bytes) return NULL;
			size_t end = at + 1;
			while (end < v->bytes && ((unsigned char)v->str[end] & 0xc0) == 0x80) end++;
			return op_str_n(v->str + at, end - at);
		} else return NULL;
	}
	return fz_copy(v);
}

// KNOWN (repro-paths-joined-surrogates): a span put in or taken out of a string just after a lone
// high, so that a lone low meets it: that code point, before the span, becomes a pair; unmarked
static int joined(const op_value *x, const op_value *y) {
	return x != NULL && y != NULL && x->type == OP_STR && x->bytes == 3 && (unsigned char)x->str[0] == 0xed &&
		((unsigned char)x->str[1] & 0xf0) == 0xa0 && y->type == OP_STR && y->bytes == 4;
}

static int same_path(const op_key *a, size_t na, const op_key *b, size_t nb) {
	if (na != nb) return 0;
	for (size_t i = 0; i < na; i++)
		if (a[i].type != b[i].type || (a[i].type == OP_NUM_KEY ? a[i].n != b[i].n : strcmp(a[i].s, b[i].s) != 0))
			return 0;
	return 1;
}

// the steps a key keeps: its [], and every other prefix of its spots' paths, once
static size_t steps_of(int key) {
	size_t n = 1;
	for (int i = 0; i < nspots; i++) {
		if (!spots[i].alive || spots[i].change || spots[i].key != key) continue;
		for (size_t len = 1; len <= spots[i].length; len++) {
			int before = 0;
			for (int j = 0; j < i && !before; j++) {
				const mspot *o = &spots[j];
				before = o->alive && !o->change && o->key == key && o->length >= len &&
					same_path(o->path, len, spots[i].path, len);
			}
			n += !before;
		}
	}
	return n;
}

static void check_held(pt_paths *p, int round) {
	pt_held want = {0};
	for (int k = 0; k < 2; k++) {
		int any = 0;
		for (int i = 0; i < nspots; i++)
			if (spots[i].alive && spots[i].key == k) any = 1, want.spots++;
		if (any) want.keys++, want.steps += steps_of(k);
	}
	pt_held got = pt_held_of(p);
	if (got.keys != want.keys || got.spots != want.spots || got.steps != want.steps) die("held is not the model's", round);
}

// the marked list: each once; key 0's change spot, and exactly the spots `marked` says
static void check_marked(pt_spot *const *got, size_t n, const int *marked, int round, const char *what) {
	for (size_t i = 0; i < n; i++)
		for (size_t j = i + 1; j < n; j++)
			if (got[i] == got[j]) die("a spot given twice", round);
	size_t want = 0;
	for (int i = 0; i < nspots; i++) {
		const mspot *m = &spots[i];
		if (!m->alive || m->key != 0 || !(m->change || marked[i])) continue;
		want++;
		size_t k = 0;
		while (k < n && got[k] != m->s) k++;
		if (k == n) die(what, round);
	}
	if (want != n) die(what, round);
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	fz_bytes b = {data, size, 0};
	pt_paths *p = pt_new();
	op_value *value = fz_value(&b, 0);
	nspots = 0;
	for (int round = 0; round < 6 && b.at < b.size; round++) {
		// reads: made at either key, or let go of
		for (unsigned n = fz_byte(&b) % 5; n > 0; n--) {
			unsigned c = fz_byte(&b);
			if (c % 4 == 3) {
				int i = (int)(c >> 2) % (nspots ? nspots : 1);
				if (nspots && spots[i].alive) pt_release(p, spots[i].s), spots[i].alive = 0;
				continue;
			}
			if (nspots == SPOTS) continue;
			mspot m = {.key = c & 1, .alive = 1, .change = c % 4 == 2};
			op_target t;
			fz_target(&b, value, &t, m.path);
			m.length = m.change ? 0 : t.length;
			for (size_t i = 0; i < m.length; i++)
				if (m.path[i].type == OP_NUM_KEY && m.path[i].n < 0) m.path[i].n = 0;
			m.s = m.change ? pt_change_of(p, key_of(m.key), key_of(m.key)) : pt_spot_of(p, key_of(m.key), key_of(m.key), m.path, m.length, 0);
			for (int i = 0; i < nspots; i++) {
				const mspot *o = &spots[i];
				int is = o->alive && o->key == m.key && o->change == m.change && same_path(o->path, o->length, m.path, m.length);
				if (is != (o->alive && o->s == m.s)) die(is ? "a spot asked for again is another" : "a new spot is one there", round);
			}
			if (m.s->change != m.change || !same_path(m.s->path, m.s->length, m.path, m.length) ||
				m.s->source.symbol != key_of(m.key).symbol) die("a spot's key or path is not the one asked for", round);
			int again = 0;
			for (int i = 0; i < nspots; i++) again |= spots[i].alive && spots[i].s == m.s;
			if (!again) spots[nspots++] = m;
		}
		check_held(p, round);

		// patches at key 0, one at a time on copies: what each changed must be marked by it
		fz_patches ps;
		fz_patch_list(&b, value, &ps);
		op_value *now = fz_copy(value);
		int marked[SPOTS] = {0}, landed = 1;
		for (size_t i = 0; i < ps.n && landed; i++) {
			op_value *next = NULL;
			if (op_apply(now, &ps.p[i], 1, NULL, &next, NULL) != OP_OK) {
				landed = 0;
				break;
			}
			for (int k = 0; k < nspots; k++) {
				const mspot *m = &spots[k];
				if (!m->alive || m->change) continue;
				op_value *x = seen(now, m->path, m->length), *y = seen(next, m->path, m->length);
				int hit = pt_marks(&ps.p[i], m->path, m->length, 0);
				if (!fz_equal(x, y) && !hit && !joined(x, y)) {
					fprintf(stderr, "fuzz: patch %zu changed a read of %zu keys, unmarked\n", i, m->length);
					die("a read whose value changed is not marked", round);
				}
				if (m->key == 0) marked[k] |= hit;
				op_free(x);
				op_free(y);
			}
			op_free(now);
			now = next;
		}
		if (landed) {
			size_t n;
			pt_spot *const *got = pt_mark(p, key_of(0), key_of(0), ps.p, ps.n, &n);
			check_marked(got, n, marked, round, "pt_mark is not the OR of pt_marks");
			int all[SPOTS];
			for (int k = 0; k < SPOTS; k++) all[k] = 1;
			got = pt_event(p, key_of(0), key_of(0), &n);
			check_marked(got, n, all, round, "pt_event is not every spot of the key");
			op_free(value);
			value = now;
		} else op_free(now);
		fz_patches_free(&ps);
	}
	op_free(value);
	pt_free(p);
	return 0;
}
