// the C crow (crow.h) on the line protocol of typescript/crow_harness.ts, which documents
// it (conformance/c/harness.h has the loop). one root and its crow last for the process, and
// what was held and marked: each kept alive (op_ref) and compared by pointer
#define _POSIX_C_SOURCE 200809L // strdup
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../conformance/c/protocol_harness.h"
#include "crow.h"

static cr_crow *crow;
// the root crow writes through (any pointer: its address), what it holds, and the undo of the last
// write that landed
static char root;
static op_value *root_value;
static op_undo last_undo;
static int has_undo;
// a name and what it stands for (NULL: nothing)
typedef struct {
	char *name;
	op_value *value;
} named;
typedef struct {
	named *items;
	size_t count, capacity;
} names;
static names held, marked;
static void keep(names *n, const char *name, op_value *value) {
	for (size_t i = 0; i < n->count; i++) {
		if (strcmp(n->items[i].name, name) != 0) continue;
		op_free(n->items[i].value);
		n->items[i].value = value;
		return;
	}
	if (n->count == n->capacity) {
		n->capacity = n->capacity ? 2 * n->capacity : 8;
		n->items = realloc(n->items, n->capacity * sizeof *n->items);
		if (n->items == NULL) abort();
	}
	n->items[n->count++] = (named){strdup(name), value};
}
static named *look(names *n, const char *name) {
	for (size_t i = 0; i < n->count; i++)
		if (strcmp(n->items[i].name, name) == 0) return &n->items[i];
	return NULL;
}
static void forget(names *n) {
	for (size_t i = 0; i < n->count; i++) free(n->items[i].name), op_free(n->items[i].value);
	free(n->items);
	*n = (names){0};
}

static void reset(void) {
	op_free(root_value);
	cr_free(crow);
	op_undo_free(&last_undo);
	forget(&held);
	forget(&marked);
	root_value = NULL, last_undo = (op_undo){0}, has_undo = 0;
}

void hh_start(void) {
	crow = cr_new();
}

void hh_finish(void) {
	reset();
	crow = NULL;
}

// what is at a path of keys, NULL when nothing
static const op_value *at(const op_value *v, const op_value *path) {
	for (size_t i = 0; path != NULL && i < path->count; i++) {
		const op_value *k = path->items[i];
		if (v == NULL) return NULL;
		if (k->type == OP_NUM && v->type == OP_LIST && k->num >= 0 && (size_t)k->num < v->count) {
			v = v->items[(size_t)k->num];
		} else if (k->type == OP_STR && v->type == OP_MAP) {
			v = op_get(v, k->str);
		} else {
			return NULL;
		}
	}
	return v;
}

// as === has it: a number, string, boolean or null by content, any other value by identity
static int same(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
		case OP_NULL: return 1;
		case OP_BOOL: return a->bool_ == b->bool_;
		case OP_NUM: return op_same_num(a, b);
		case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
		default: return 0;
	}
}

static void put_value(FILE *out, const op_value *v) {
	if (v == NULL) {
		fputs("{}", out);
		return;
	}
	fputs("{\"value\":", out);
	op_json_write(out, v);
	putc('}', out);
}

// crow's update of the patches: the undo, or the error and the patch. a landed write's undo is
// the root's from then (the last one's let go of)
static void write(FILE *out, const op_patch *patches, size_t n, const char *hold) {
	if (hold != NULL) {
		op_value *list = op_list();
		for (size_t i = 0; i < n; i++)
			if (patches[i].has_value) op_push(list, op_ref((op_value *)patches[i].value));
		keep(&held, hold, list);
	}
	size_t failed = 0;
	op_value *after;
	op_undo made = {0};
	int code = cr_update(crow, &root, root_value, patches, n, &after, &made, &failed);
	if (code != OP_OK) {
		fprintf(out, "{\"error\":\"%s\",\"patch\":%zu}", op_code_name(code), failed);
		return;
	}
	op_free(root_value);
	root_value = after;
	op_undo_free(&last_undo);
	last_undo = made, has_undo = 1;
	fputs("{\"undo\":[", out);
	for (size_t i = 0; i < last_undo.n; i++) {
		if (i) putc(',', out);
		hh_put_patch(out, &last_undo.patches[i]);
	}
	fputs("]}", out);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	const char *hold = hh_str(r, "hold");
	if (op == NULL) {
		hh_unknown(out, r);
	} else if (strcmp(op, "start") == 0) {
		reset();
		crow = cr_new();
		root_value = op_ref((op_value *)op_get(r, "value"));
		fputs("{}", out);
	} else if (strcmp(op, "write") == 0) {
		const op_value *list = op_get(r, "patches");
		if (list == NULL || list->type != OP_LIST) {
			hh_error(out, "write: patches is not a list");
			return;
		}
		size_t n = list->count;
		op_patch *patches = hh_take((n + 1) * sizeof *patches);
		for (size_t i = 0; i < n; i++) hh_patch(list->items[i], &patches[i]);
		// marked: patch i given what was marked under marked[i] (nothing: a removal)
		const op_value *names = op_get(r, "marked");
		for (size_t i = 0; names != NULL && names->type == OP_LIST && i < n && i < names->count; i++) {
			if (names->items[i]->type != OP_STR) continue;
			named *m = look(&marked, names->items[i]->str);
			patches[i].value = m != NULL ? m->value : NULL;
			patches[i].has_value = patches[i].value != NULL;
		}
		write(out, patches, n, hold);
	} else if (strcmp(op, "unwrite") == 0) {
		if (!has_undo) {
			fputs("{\"error\":\"nothing-written\"}", out);
			return;
		}
		// the undo is written while this holds it; a write that lands makes its own
		op_undo undo = last_undo;
		last_undo = (op_undo){0}, has_undo = 0;
		write(out, undo.patches, undo.n, hold);
		if (has_undo) op_undo_free(&undo);
		else last_undo = undo, has_undo = 1;
	} else if (strcmp(op, "read") == 0) {
		cr_let_go(crow, &root);
		if (hold != NULL) keep(&held, hold, op_ref(root_value));
		put_value(out, root_value);
	} else if (strcmp(op, "keep") == 0) {
		const op_value *v = at(root_value, op_get(r, "path"));
		op_value *k = op_ref((op_value *)v);
		const op_value *hd = op_get(r, "handed");
		int handed = hd != NULL && hd->type == OP_BOOL && hd->bool_;
		const op_value *wrap = op_get(r, "wrap");
		if (wrap != NULL && wrap->type == OP_BOOL && wrap->bool_) {
			// nothing there, in a list: null, as the line has it
			op_value *list = op_list();
			op_push(list, k != NULL ? k : op_null());
			k = list;
		}
		cr_let_go_in(crow, k, handed ? &v : NULL, handed ? 1 : 0);
		if (hold != NULL) keep(&held, hold, k);
		else op_free(k);
		fputs("{}", out);
	} else if (strcmp(op, "held") == 0) {
		const char *name = hh_str(r, "name");
		named *h = name ? look(&held, name) : NULL;
		put_value(out, h ? h->value : NULL);
	} else if (strcmp(op, "value") == 0) {
		put_value(out, root_value);
	} else if (strcmp(op, "mark") == 0) {
		const char *name = hh_str(r, "name");
		if (name == NULL) hh_error(out, "mark: no name");
		else {
			keep(&marked, name, op_ref((op_value *)at(root_value, op_get(r, "path"))));
			fputs("{}", out);
		}
	} else if (strcmp(op, "same") == 0) {
		const char *name = hh_str(r, "name");
		named *m = name ? look(&marked, name) : NULL;
		fprintf(out, "{\"same\":%s}", same(m ? m->value : NULL, at(root_value, op_get(r, "path"))) ? "true" : "false");
	} else {
		hh_unknown(out, r);
	}
}
