// the C tracker (tracker.h) on the line protocol of core/scheduler/typescript/tracker_harness.ts. A
// node's owner is its name.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tracker.h"
#include "../../../conformance/c/harness.h"

typedef struct {
	char *name;
	tg_node *node;
} entry;

static entry *entries;
static size_t count, capacity;

static tg_node *node(const char *name) {
	for (size_t i = 0; i < count; i++)
		if (strcmp(entries[i].name, name) == 0) return entries[i].node;
	if (count == capacity) {
		capacity = capacity ? capacity * 2 : 16;
		entries = realloc(entries, capacity * sizeof *entries);
		if (entries == NULL) hh_fail("out of memory");
	}
	char *copy = strdup(name);
	tg_node *n = copy ? tg_node_new(copy) : NULL;
	if (n == NULL) hh_fail("out of memory");
	entries[count++] = (entry){copy, n};
	return n;
}

static void put_name(FILE *out, const void *owner) { op_json_string(out, owner); }

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) hh_fail("no op");
	const char *of = hh_str(r, "of");
	if (strcmp(op, "reads") == 0 && of) {
		fputs("{\"names\":[", out);
		for (tg_link *l = node(of)->reads; l != NULL; l = l->next) {
			put_name(out, l->to->owner);
			if (l->next != NULL) putc(',', out);
		}
		fputs("]}", out);
		return;
	}
	if (strcmp(op, "readers") == 0 && of) {
		fputs("{\"names\":[", out);
		for (tg_link *l = node(of)->first; l != NULL; l = l->after) {
			put_name(out, l->from->owner);
			if (l->after != NULL) putc(',', out);
		}
		fputs("]}", out);
		return;
	}
	const char *from = hh_str(r, "from"), *to = hh_str(r, "to");
	if (from == NULL) hh_fail("no from");
	tg_node *f = node(from);
	int ok = 0;
	if (strcmp(op, "begin") == 0) ok = tg_begin(f);
	else if (strcmp(op, "end") == 0) tg_end(f);
	else if (strcmp(op, "track") == 0 && to) ok = tg_track(f, node(to));
	else if (strcmp(op, "add") == 0 && to) ok = tg_add(f, node(to));
	else if (strcmp(op, "untrack") == 0) tg_untrack(f, to ? node(to) : NULL);
	else {
		hh_unknown(out, r);
		return;
	}
	if (ok == -2) {
		hh_error(out, "%s in a run", op);
		return;
	}
	if (ok != 0) hh_fail("out of memory");
	fputs("{}", out);
}

void hh_finish(void) {
	for (size_t i = 0; i < count; i++) {
		tg_untrack(entries[i].node, NULL);
	}
	for (size_t i = 0; i < count; i++) {
		tg_node_free(entries[i].node);
		free(entries[i].name);
	}
	free(entries);
}
