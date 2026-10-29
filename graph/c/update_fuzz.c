// libFuzzer target: the input bytes are an entry's value, then rounds of a header and patches
// (../../changeable/c/fuzz_values.h) given to nd_update. Checked each round:
// - done: the value is op_apply's on a copy of the one before; the change is the header given,
//   with has_op, the very patches given and the entry's own undo; that undo applied to the value
//   gives the one before back (maps by content);
// - refused: op_apply's code and index; the value, the change and the undo just as they were;
// - every string in the value (and the undo's) is WTF-8 as op holds it: a lone high never right
//   before a lone low (fz_wtf8);
// - at the end, nd_free_entry lets go of everything: no patch's value is held past the caller (and the
//   leak checker sees nothing left).
#include "update.h"
#include "../../changeable/c/fuzz_values.h"

#include <stdio.h>

static void die(const char *why, int round) {
	fprintf(stderr, "fuzz: round %d: %s\n", round, why);
	abort();
}

static const ch_location sites[] = {{"a.c", 1, 2, "f", 1}, {"b.c", 3, 0, NULL, 0}};

static int same(const op_value *a, const op_value *b) { return fz_equal(a, b); }

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	ch_frame *frame = ch_frame_at(&sites[0], NULL);
	fz_bytes b = {data, size, 0};
	unsigned flags = fz_byte(&b);
	op_value *value = flags & 1 ? NULL : fz_value(&b, 0);
	ch_header first = {.has_time = flags & 2, .time = 7, .actor = "first"};
	nd_entry *entry = nd_make_entry(value, &first);
	if (entry->value != value || (value != NULL && value->refs != 1)) die("nd_make_entry took no hold on the value", 0);
	if (!entry->change.has_time || (flags & 2 && entry->change.time != 7) || entry->change.actor != first.actor)
		die("nd_make_entry's change is not the header given", 0);
	op_free(value); // the entry's now

	// the patches the entry's change refers to, and the next ones
	static fz_patches ps[2];
	int now = 0, landed = 0;
	for (int round = 0; round < 8 && b.at < b.size; round++) {
		unsigned c = fz_byte(&b);
		fz_patches *next = &ps[!now];
		fz_patch_list(&b, entry->value, next);
		ch_header h = {.has_time = 1, .time = c >> 1, .actor = "me", .reader = c & 2 ? "r" : NULL,
			.frame = c & 4 ? frame : NULL,
			// op fields given are replaced
			.has_op = 1, .patches = (const op_patch *)sites, .patches_length = 99};

		op_value *was = fz_copy(entry->value), *expect = NULL, *const at_was = entry->value;
		ch_header change = entry->change;
		op_undo undo = entry->undo;
		size_t efailed = 999, failed = 999;
		int ecode = op_apply(was, next->p, next->n, NULL, &expect, &efailed);
		int code = nd_update(entry, next->p, next->n, h, &failed);
		if (code != ecode) die("not op_apply's code", round);
		if (code != OP_OK) {
			if (failed != efailed) die("not op_apply's index", round);
			if (entry->value != at_was || memcmp(&entry->change, &change, sizeof change) != 0 ||
				memcmp(&entry->undo, &undo, sizeof undo) != 0) die("refused, and the entry changed", round);
			fz_patches_free(next);
		} else {
			const ch_header *n = &entry->change;
			if (!same(entry->value, expect)) die("the value is not op_apply's", round);
			if (!fz_wtf8(entry->value)) die("a string not WTF-8", round);
			if (n->time != h.time || n->actor != h.actor || n->reader != h.reader || n->frame != h.frame) die("the change is not the header given", round);
			if (!n->has_op || n->patches != next->p || n->patches_length != next->n) die("the change's patches are not those given", round);
			if (n->undo != entry->undo.patches || n->undo_length != entry->undo.n) die("the change's undo is not the entry's", round);
			if (n->undo_length == 0 && n->undo != NULL) die("an empty undo is not NULL", round);
			op_value *back = NULL;
			if (op_apply(entry->value, n->undo, n->undo_length, NULL, &back, NULL) != OP_OK)
				die("the undo is refused", round);
			if (!same(back, was)) die("the undo does not give the value back", round);
			if (!fz_wtf8(back)) die("undone, a string not WTF-8", round);
			op_free(back);
			// what the change referred to before is the caller's again
			if (landed) fz_patches_free(&ps[now]);
			now = !now, landed = 1;
		}
		op_free(expect);
		op_free(was);
	}
	nd_free_entry(entry);
	ch_frame_free(frame);
	if (landed) {
		for (size_t i = 0; i < ps[now].n; i++)
			if (!fz_unshared(ps[now].values[i])) die("a hold on a patch's value is left", -1);
		fz_patches_free(&ps[now]);
	}
	return 0;
}
