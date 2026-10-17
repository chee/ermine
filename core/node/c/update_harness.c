// The C update on the line protocol (core/node/typescript/update_harness.ts documents it): one
// entry lasts for the process.
//   {op: "start", value?, header?, cow?} -> {}   cow: false, an entry updated in place
//   {op: "update", patches, header?} -> {} | {error: {code, patch}}
//   {op: "entry"} -> {entry: {value?, change}}, change.op as {patches, undo}
// The entry's change refers to the patches and the header's pieces: the line that made them is kept
// (hh_retain) until the next update that works, or start. An entry updated in place is given its
// patches' values from one reading and answers the patches from another: what it was asked, which
// put in, it changes.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "update.h"
#include "../../../conformance/c/harness.h"
#include "../../../conformance/c/protocol.h"

static nd_entry *entry;
// the line the entry's change refers to
static hh_line *kept;
// in place: the patches as asked, read again from the line, answered for the entry's own
static op_value *asked;
static op_patch *asked_patches;
static size_t asked_count;

static void forget_asked(void) {
	op_free(asked);
	free(asked_patches);
	asked = NULL;
	asked_patches = NULL;
	asked_count = 0;
}

// the line now being answered is the one the entry's change refers to
static void keep_line(void) {
	hh_line *line = hh_retain();
	hh_release(kept);
	kept = line;
}

static void start(const op_value *r) {
	nd_free_entry(entry);
	entry = NULL;
	forget_asked();
	const op_value *given = op_get(r, "header"), *cow = op_get(r, "cow");
	ch_header h = given ? hh_header(given) : (ch_header){0};
	nd_entry_options options = {.in_place = cow && cow->type == OP_BOOL && !cow->bool_};
	entry = nd_make_entry((op_value *)op_get(r, "value"), &h, &options);
	if (entry == NULL) hh_fail("out of memory");
	keep_line();
}

static void update(const op_value *r, FILE *out) {
	const op_value *list = op_get(r, "patches");
	if (list == NULL || list->type != OP_LIST) {
		hh_error(out, "update: patches is not a list");
		return;
	}
	size_t n = list->count;
	op_patch *patches = hh_take((n ? n : 1) * sizeof *patches);
	for (size_t i = 0; i < n; i++) hh_patch(list->items[i], &patches[i]);
	const op_value *given = op_get(r, "header");
	ch_header h = given ? hh_header(given)
			    : (ch_header){.has_time = 1, .time = 1, .actor = hh_hold(op_str("me"))};
	// in place: a second reading to answer with
	op_value *again = NULL;
	op_patch *again_patches = NULL;
	if (entry->in_place) {
		again = op_json_read(hh_text(), NULL);
		if (again == NULL) hh_fail("the line reads once and not twice");
		const op_value *twice = op_get(again, "patches");
		again_patches = malloc((n ? n : 1) * sizeof *again_patches);
		if (again_patches == NULL) hh_fail("out of memory");
		for (size_t i = 0; i < n; i++) hh_patch(twice->items[i], &again_patches[i]);
	}
	size_t at = 0;
	int code = nd_update(entry, patches, n, h, &at);
	if (code != OP_OK) {
		op_free(again);
		free(again_patches);
		fprintf(out, "{\"error\":{\"code\":\"%s\",\"patch\":%zu}}", op_code_name(code), at);
		return;
	}
	keep_line();
	forget_asked();
	asked = again;
	asked_patches = again_patches;
	asked_count = n;
	fputs("{}", out);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (entry == NULL && op != NULL && strcmp(op, "start") != 0) {
		entry = nd_make_entry(NULL, NULL, NULL);
		if (entry == NULL) hh_fail("out of memory");
	}
	if (op != NULL && strcmp(op, "start") == 0) {
		start(r);
		fputs("{}", out);
	} else if (op != NULL && strcmp(op, "update") == 0) {
		update(r, out);
	} else if (op != NULL && strcmp(op, "entry") == 0) {
		const op_patch *own = entry->change.patches;
		size_t own_count = entry->change.patches_length;
		if (entry->in_place && entry->change.has_op && asked_patches != NULL) {
			entry->change.patches = asked_patches;
			entry->change.patches_length = asked_count;
		}
		fputs("{\"entry\":", out);
		hh_put_entry(out, entry);
		fputs("}", out);
		entry->change.patches = own;
		entry->change.patches_length = own_count;
	} else {
		hh_unknown(out, r);
	}
}

void hh_finish(void) {
	nd_free_entry(entry);
	forget_asked();
	hh_release(kept);
}
