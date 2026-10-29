// The C update on the line protocol (changeable/typescript/update_harness.ts documents it): one
// entry lasts for the process.
//   {op: "start", value?, header?} -> {}
//   {op: "update", patches, header?} -> {} | {error: {code, patch}}
//   {op: "entry"} -> {entry: {value?, change}}, change.op as {patches, undo}
// The entry's change refers to the patches and the header's pieces: the line that made them is kept
// (hh_retain) until the next update that works, or start.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "update.h"
#include "../../conformance/c/harness.h"
#include "../../conformance/c/protocol_harness.h"

static nd_entry *entry;
// the line the entry's change refers to
static hh_line *kept;
// the line now being answered is the one the entry's change refers to
static void keep_line(void) {
	hh_line *line = hh_retain();
	hh_release(kept);
	kept = line;
}

static int start(const op_value *r, FILE *out) {
	const op_value *given = op_get(r, "header");
	const char *why = hh_bad_header(given);
	if (why != NULL) return hh_error(out, "%s", why), 0;
	nd_free_entry(entry);
	entry = NULL;
	ch_header h = given ? hh_header(given) : (ch_header){0};
	entry = nd_make_entry((op_value *)op_get(r, "value"), &h);
	if (entry == NULL) hh_fail("out of memory");
	ch_frame_free(h.frame);
	keep_line();
	return 1;
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
	const char *why = hh_bad_header(given);
	if (why != NULL) {
		hh_error(out, "%s", why);
		return;
	}
	ch_header h = given ? hh_header(given)
			    : (ch_header){.has_time = 1, .time = 1, .actor = hh_hold(op_str("me"))};
	size_t at = 0;
	int code = nd_update(entry, patches, n, h, &at);
	ch_frame_free(h.frame);
	if (code != OP_OK) {
		fprintf(out, "{\"error\":{\"code\":\"%s\",\"patch\":%zu}}", op_code_name(code), at);
		return;
	}
	keep_line();
	fputs("{}", out);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (entry == NULL && op != NULL && strcmp(op, "start") != 0) {
		entry = nd_make_entry(NULL, NULL);
		if (entry == NULL) hh_fail("out of memory");
	}
	if (op != NULL && strcmp(op, "start") == 0) {
		if (start(r, out)) fputs("{}", out);
	} else if (op != NULL && strcmp(op, "update") == 0) {
		update(r, out);
	} else if (op != NULL && strcmp(op, "entry") == 0) {
		fputs("{\"entry\":", out);
		hh_put_entry(out, entry);
		fputs("}", out);
	} else {
		hh_unknown(out, r);
	}
}

void hh_finish(void) {
	nd_free_entry(entry);
	hh_release(kept);
}
