// the C paths (paths.h) on the line protocol of reactivity/typescript/paths_harness.ts. A
// symbol is a token per name, the harness's.
#define _POSIX_C_SOURCE 200809L
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "paths.h"
#include "../../conformance/c/harness.h"
#include "../../conformance/c/protocol_harness.h"

static pt_paths *paths;

// symbols: one token per name, held to the end
static char **names;
static size_t count, capacity;

// a source or an id: a string, or {"symbol": name}; 0 when neither
static int key_of(const op_value *x, pt_key *out) {
	if (x == NULL) return 0;
	if (x->type == OP_STR) return *out = pt_string(x->str), 1;
	const char *name = x->type == OP_MAP ? hh_str(x, "symbol") : NULL;
	if (name == NULL) return 0;
	for (size_t i = 0; i < count; i++)
		if (strcmp(names[i], name) == 0) return *out = pt_symbol(names[i]), 1;
	if (count == capacity) {
		capacity = capacity ? capacity * 2 : 8;
		names = realloc(names, capacity * sizeof *names);
		if (names == NULL) abort();
	}
	names[count] = strdup(name);
	if (names[count] == NULL) abort();
	*out = pt_symbol(names[count++]);
	return 1;
}

// keys: numbers and strings; NULL when x is not a list of them. *n how many
static op_key *path_of(const op_value *x, size_t *n) {
	if (x == NULL || x->type != OP_LIST) return NULL;
	op_key *keys = hh_take((x->count + 1) * sizeof *keys);
	for (size_t i = 0; i < x->count; i++) {
		const op_value *k = x->items[i];
		if (k->type == OP_STR) keys[i] = (op_key){.type = OP_STR_KEY, .s = k->str};
		else if (k->type == OP_NUM && k->num >= 0 && k->num == floor(k->num) && k->num < 1e15)
			keys[i] = (op_key){.type = OP_NUM_KEY, .n = (long)k->num};
		else return NULL;
	}
	*n = x->count;
	return keys;
}

// a place of a patch: a map with a path, and a range of two whole numbers when it has one
static int place_ok(const op_value *x) {
	if (x == NULL || x->type != OP_MAP) return 0;
	size_t n;
	if (path_of(op_get(x, "path"), &n) == NULL) return 0;
	const op_value *r = op_get(x, "range");
	if (r == NULL) return 1;
	if (r->type != OP_LIST || r->count != 2) return 0;
	for (size_t i = 0; i < 2; i++) {
		const op_value *k = r->items[i];
		if (k->type != OP_NUM || !isfinite(k->num) || k->num != floor(k->num)) return 0;
	}
	return 1;
}
static int patch_ok(const op_value *x) {
	if (!place_ok(x)) return 0;
	const op_value *mv = op_get(x, "move");
	return mv == NULL || place_ok(mv);
}

static void put_spot(FILE *out, const pt_spot *s) {
	if (s->change) {
		fputs("\"change\"", out);
		return;
	}
	if (s->keys) fputs("{\"keys\":", out);
	else if (s->here) fputs("{\"here\":", out);
	putc('[', out);
	for (size_t i = 0; i < s->length; i++) {
		const op_key *k = &s->path[i];
		if (i) putc(',', out);
		if (k->type == OP_NUM_KEY) fprintf(out, "%ld", k->n);
		else op_json_string(out, k->s);
	}
	putc(']', out);
	if (s->keys || s->here) putc('}', out);
}
static void put_spots(FILE *out, pt_spot *const *spots, size_t n) {
	fputs("{\"spots\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) putc(',', out);
		put_spot(out, spots[i]);
	}
	fputs("]}", out);
}

static int flag(const op_value *r, const char *name) {
	const op_value *x = op_get(r, name);
	return x != NULL && x->type == OP_BOOL && x->bool_;
}

void hh_start(void) { paths = pt_new(); }

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) { hh_error(out, "no op"); return; }
	if (strcmp(op, "held") == 0) {
		pt_held k = pt_held_of(paths);
		fprintf(out, "{\"keys\":%zu,\"spots\":%zu,\"steps\":%zu}", k.keys, k.spots, k.steps);
		return;
	}
	if (strcmp(op, "marks") == 0) {
		const op_value *ps = op_get(r, "paths"), *p = op_get(r, "patch");
		if (p == NULL || ps == NULL || ps->type != OP_LIST) { hh_error(out, "bad patch or paths"); return; }
		if (!patch_ok(p)) { hh_error(out, "bad patch"); return; }
		op_patch patch;
		hh_patch(p, &patch);
		int keys = flag(r, "here") ? PT_HERE : flag(r, "keys") ? PT_KEYS : PT_ALL;
		int *marks = hh_take((ps->count + 1) * sizeof *marks);
		for (size_t i = 0; i < ps->count; i++) {
			size_t n;
			op_key *path = path_of(ps->items[i], &n);
			if (path == NULL) { hh_error(out, "bad path"); return; }
			marks[i] = pt_marks(&patch, path, n, keys);
		}
		fputs("{\"marks\":[", out);
		for (size_t i = 0; i < ps->count; i++) fputs(marks[i] ? (i ? ",true" : "true") : (i ? ",false" : "false"), out);
		fputs("]}", out);
		return;
	}
	pt_key source, id;
	if (!key_of(op_get(r, "source"), &source) || !key_of(op_get(r, "id"), &id)) {
		{ hh_error(out, "a source or id is a string or a symbol"); return; }
	}
	if (strcmp(op, "change") == 0) {
		pt_change_of(paths, source, id);
		fputs("{}", out);
		return;
	}
	size_t n = 0;
	if (strcmp(op, "event") == 0) {
		pt_spot *const *spots = pt_event(paths, source, id, &n);
		put_spots(out, spots, n);
		return;
	}
	if (strcmp(op, "mark") == 0) {
		const op_value *ps = op_get(r, "patches");
		if (ps == NULL || ps->type != OP_LIST) { hh_error(out, "no patches"); return; }
		op_patch *patches = hh_take((ps->count + 1) * sizeof *patches);
		for (size_t i = 0; i < ps->count; i++) {
			if (!patch_ok(ps->items[i])) { hh_error(out, "bad patch"); return; }
		}
		for (size_t i = 0; i < ps->count; i++) hh_patch(ps->items[i], &patches[i]);
		pt_spot *const *spots = pt_mark(paths, source, id, patches, ps->count, &n);
		put_spots(out, spots, n);
		return;
	}
	int keys = flag(r, "here") ? PT_HERE : flag(r, "keys") ? PT_KEYS : PT_ALL;
	const op_value *pj = op_get(r, "path");
	op_key *path = pj == NULL ? NULL : path_of(pj, &n);
	if (pj != NULL && path == NULL) { hh_error(out, "bad path"); return; }
	if (strcmp(op, "spot") == 0) {
		if (path == NULL) { hh_error(out, "no path"); return; }
		pt_spot_of(paths, source, id, path, n, keys);
	} else if (strcmp(op, "release") == 0) {
		// made, then let go: a spot not there stays not there
		pt_release(paths, path ? pt_spot_of(paths, source, id, path, n, keys) : pt_change_of(paths, source, id));
	} else {
		hh_unknown(out, r);
		return;
	}
	fputs("{}", out);
}

void hh_finish(void) {
	pt_free(paths);
	for (size_t i = 0; i < count; i++) free(names[i]);
	free(names);
}
