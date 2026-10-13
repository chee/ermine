// libFuzzer target: the input bytes are a node's value, then rounds of a header and patches
// (../../op/c/fuzz_values.h) given to nd_update. Checked each round:
// - done: the value is op_apply's on a copy of the one before; the change is the header given,
//   with has_op, the very patches given and the node's own undo; that undo applied to the value
//   gives the one before back (maps by content);
// - refused: op_apply's code and index; the value, the change and the undo just as they were;
// - at the end, nd_free lets go of everything: no patch's value is held past the caller (and the
//   leak checker sees nothing left).
#include "update.h"
#include "../../op/c/fuzz_values.h"

#include <stdio.h>

static void die(const char *why, int round) {
	fprintf(stderr, "fuzz: round %d: %s\n", round, why);
	abort();
}

static const ch_site sites[] = {{"a.c", 1, 2, "f", 1}, {"b.c", 3, 0, NULL, 0}};
static const ch_entry entries[] = {{"k", "v"}, {"k", "w"}};

static int same(const op_value *a, const op_value *b, int list) {
	if (list && a == NULL) return b == NULL || (b->type == OP_LIST && b->count == 0);
	if (list && b == NULL) return a->type == OP_LIST && a->count == 0;
	return fz_equal(a, b);
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	fz_bytes b = {data, size, 0};
	unsigned flags = fz_byte(&b);
	op_value *value = flags & 1 ? NULL : fz_value(&b, 0);
	ch_header first = {.has_time = flags & 2, .time = 7, .actor = "first"};
	nd_node *node = nd_make(value, &first);
	if (node->value != value || (value != NULL && value->refs != 1)) die("nd_make took no hold on the value", 0);
	if (!node->change.has_time || (flags & 2 && node->change.time != 7) || node->change.actor != first.actor)
		die("nd_make's change is not the header given", 0);
	op_free(value); // the node's now

	// the patches the node's change refers to, and the next ones
	static fz_patches ps[2];
	int now = 0, landed = 0;
	for (int round = 0; round < 8 && b.at < b.size; round++) {
		unsigned c = fz_byte(&b);
		// the list option on a list (given another, its undo puts back what the option refuses)
		int list = c & 1 && (node->value == NULL || node->value->type == OP_LIST);
		fz_patches *next = &ps[!now];
		fz_patch_list(&b, node->value, next);
		ch_header h = {.has_time = 1, .time = c >> 1, .actor = "me", .reader = c & 2 ? "r" : NULL,
			.external = sites, .external_length = c >> 2 & 3, .metadata = entries, .metadata_length = c >> 4 & 3,
			// op fields given are replaced
			.has_op = 1, .patches = (const op_patch *)sites, .patches_length = 99};
		if (h.external_length > 2) h.external_length = 2;
		if (h.metadata_length > 2) h.metadata_length = 2;

		op_value *was = fz_copy(node->value), *expect = NULL, *const at_was = node->value;
		ch_header change = node->change;
		op_undo undo = node->undo;
		size_t efailed = 999, failed = 999;
		int ecode = op_apply(was, next->p, next->n, &(op_apply_options){.list = list}, &expect, &efailed);
		int code = nd_update(node, next->p, next->n, h, &(nd_update_options){list}, &failed);
		if (code != ecode) die("not op_apply's code", round);
		if (code != OP_OK) {
			if (failed != efailed) die("not op_apply's index", round);
			if (node->value != at_was || memcmp(&node->change, &change, sizeof change) != 0 ||
				memcmp(&node->undo, &undo, sizeof undo) != 0) die("refused, and the node changed", round);
			fz_patches_free(next);
		} else {
			const ch_header *n = &node->change;
			if (!same(node->value, expect, list)) die("the value is not op_apply's", round);
			if (n->time != h.time || n->actor != h.actor || n->reader != h.reader || n->external != h.external ||
				n->external_length != h.external_length || n->metadata != h.metadata ||
				n->metadata_length != h.metadata_length) die("the change is not the header given", round);
			if (!n->has_op || n->patches != next->p || n->patches_length != next->n) die("the change's patches are not those given", round);
			if (n->undo != node->undo.patches || n->undo_length != node->undo.n) die("the change's undo is not the node's", round);
			if (n->undo_length == 0 && n->undo != NULL) die("an empty undo is not NULL", round);
			op_value *back = NULL;
			if (op_apply(node->value, n->undo, n->undo_length, &(op_apply_options){.list = list}, &back, NULL) != OP_OK)
				die("the undo is refused", round);
			if (!same(back, was, list) && !fz_known(next)) die("the undo does not give the value back", round);
			op_free(back);
			// what the change referred to before is the caller's again
			if (landed) fz_patches_free(&ps[now]);
			now = !now, landed = 1;
		}
		op_free(expect);
		op_free(was);
	}
	nd_free(node);
	if (landed) {
		for (size_t i = 0; i < ps[now].n; i++)
			if (!fz_unshared(ps[now].values[i])) die("a hold on a patch's value is left", -1);
		fz_patches_free(&ps[now]);
	}
	return 0;
}
