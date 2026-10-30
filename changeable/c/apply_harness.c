// The C apply and invert on the line protocol of changeable/typescript/apply_harness.ts. Values
// are read by op's codec. Every call also checks that the value and patches' values are unchanged.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "apply.h"
#include "invert.h"
#include "../../conformance/c/protocol_harness.h"

static int by_key(const void *a, const void *b) {
	return strcmp(*(char *const *)a, *(char *const *)b);
}
static op_value *sorted(const op_value *v) {
	if (v->type == OP_LIST) {
		op_value *list = op_list();
		for (size_t i = 0; i < v->count; i++) op_push(list, sorted(v->items[i]));
		return list;
	}
	if (v->type != OP_MAP) return op_ref((op_value *)v);
	char **keys = malloc((v->count + 1) * sizeof *keys);
	if (keys == NULL) hh_fail("out of memory");
	if (v->count) memcpy(keys, v->keys, v->count * sizeof *keys);
	qsort(keys, v->count, sizeof *keys, by_key);
	op_value *map = op_map();
	for (size_t i = 0; i < v->count; i++) op_set(map, keys[i], sorted(op_get(v, keys[i])));
	free(keys);
	return map;
}

static char *given(const op_value *value, op_value *const *values, size_t n, int by_content) {
	char *text;
	size_t size;
	FILE *s = open_memstream(&text, &size);
	if (s == NULL) hh_fail("out of memory");
	for (size_t i = 0; i <= n; i++) {
		const op_value *v = i == 0 ? value : values[i - 1];
		if (v == NULL) {
			fputs("(none)", s);
		} else if (by_content) {
			op_value *c = sorted(v);
			char *t = op_json_text(c);
			fputs(t, s);
			free(t);
			op_free(c);
		} else {
			char *t = op_json_text(v);
			fputs(t, s);
			free(t);
		}
		putc('\n', s);
	}
	fclose(s);
	return text;
}

static void refused(FILE *out, int code, size_t failed) {
	fprintf(out, "{\"error\":{\"code\":\"%s\",\"patch\":%zu}}", op_code_name(code), failed);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *what = hh_str(r, "op");
	if (what == NULL || (strcmp(what, "apply") != 0 && strcmp(what, "invert") != 0)) {
		hh_unknown(out, r);
		return;
	}
	int inverting = strcmp(what, "invert") == 0;
	const op_value *ps = op_get(r, "patches");
	if (ps == NULL || ps->type != OP_LIST) {
		hh_error(out, "patches: not a list");
		return;
	}
	size_t n = ps->count;
	op_patch *patches = hh_take((n + 1) * sizeof *patches);
	op_value **values = hh_take((n + 1) * sizeof *values);
	op_value *copy = op_json_read(hh_text(), NULL);
	if (copy == NULL) hh_fail("the line read twice differs");
	op_value *value = op_ref(op_get(copy, "value"));
	const op_value *cps = op_get(copy, "patches");
	for (size_t i = 0; i < n; i++) {
		hh_patch(ps->items[i], &patches[i]);
		values[i] = NULL;
		if (patches[i].has_value) {
			values[i] = op_ref(op_get(cps->items[i], "value"));
			patches[i].value = values[i];
		}
		if (patches[i].has_move && (op_get(op_get(ps->items[i], "move"), "value") ||
					op_get(op_get(ps->items[i], "move"), "move"))) {
			patches[i].move.has_range = 1;
			patches[i].move.from = patches[i].move.to = -1;
		}
	}
	op_free(copy);
	const op_value *cow = op_get(r, "cow");
	int in_place = cow && cow->type == OP_BOOL && !cow->bool_;
	int wholes = 0;
	for (size_t i = 0; i < n; i++) {
		if (patches[i].place.length == 0 || (patches[i].has_move && patches[i].move.length == 0)) {
			wholes = 1;
		}
	}
	char *before = given(value, values, n, in_place);
	op_undo undo = {0};
	op_value *end = NULL;
	size_t failed = 0;
	int code;
	if (inverting && !in_place) {
		code = op_invert(value, patches, n, &undo, &failed);
	} else {
		op_apply_options o = {.undo = inverting ? &undo : NULL, .in_place = in_place};
		code = op_apply(value, patches, n, &o, &end, &failed);
	}
	char *after = given(value, values, n, in_place);
	int changed = strcmp(before, after) != 0 && !(in_place && code == OP_OK);
	int other = !inverting && in_place && code == OP_OK && !wholes && end != NULL &&
		value != NULL && (value->type == OP_LIST || value->type == OP_MAP) && end != value;
	free(before);
	free(after);
	op_free(value);
	for (size_t i = 0; i < n; i++) op_free(values[i]);
	if (changed || other) {
		hh_error(out, other ? "not the value given" : "a value given changed");
	} else if (code != OP_OK) {
		refused(out, code, failed);
	} else if (inverting) {
		fputs("{\"undo\":[", out);
		for (size_t i = 0; i < undo.n; i++) {
			if (i) putc(',', out);
			hh_put_patch(out, &undo.patches[i]);
		}
		fputs("]}", out);
	} else if (end != NULL) {
		fputs("{\"value\":", out);
		op_json_write(out, end);
		putc('}', out);
	} else {
		fputs("{}", out);
	}
	op_free(end);
	op_undo_free(&undo);
}
