// libFuzzer target: the input bytes are a value and a list of patches (fuzz_values.h), applied
// with op_apply, with and without the list option. Checked:
// - nothing given changes (the value and the patches' values, against copies made before);
// - refused: *out and the undo as they were; the patches before the refused one apply, and the
//   refused one alone then fails the same way, at index 0; op_invert says the same;
// - done: the same value with no undo asked for; the undo applied to the result gives the value
//   back (maps by content); op_invert gives an undo as long;
// - references balance: once what came out is freed, nothing given has a holder past the caller
//   (and the leak checker sees nothing left).
#include "apply.h"
#include "invert.h"
#include "fuzz_values.h"

#include <stdio.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

// with the list option nothing there and an empty list are one
static int same(const op_value *a, const op_value *b, int list) {
	if (list && a == NULL && b != NULL && b->type == OP_LIST && b->count == 0) return 1;
	if (list && b == NULL && a != NULL && a->type == OP_LIST && a->count == 0) return 1;
	return fz_equal(a, b);
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	fz_bytes b = {data, size, 0};
	unsigned flags = fz_byte(&b);
	int list = flags & 1;
	op_value *value = flags & 2 ? NULL : fz_value(&b, 0);
	// the list option's value is a list (op_apply refuses another only once a patch has landed,
	// and then no undo gives it back)
	if (list && value != NULL && value->type != OP_LIST) {
		op_value *l = op_list();
		op_push(l, value);
		value = l;
	}
	fz_patches ps;
	fz_patch_list(&b, value, &ps);
	op_value *was = fz_copy(value), *given[FZ_PATCHES];
	for (size_t i = 0; i < ps.n; i++) given[i] = fz_copy(ps.values[i]);

	op_value *const sentinel = (op_value *)&b;
	op_value *out = sentinel;
	op_undo undo = {0};
	op_apply_options o = {.list = list, .undo = &undo};
	size_t failed = 999;
	int code = op_apply(value, ps.p, ps.n, &o, &out, &failed);

	if (!fz_equal(value, was)) die("the value given changed");
	for (size_t i = 0; i < ps.n; i++)
		if (!fz_equal(ps.values[i], given[i])) die("a patch's value changed");

	op_undo inverse = {0};
	size_t ifailed = 999;
	int icode = op_invert(value, ps.p, ps.n, &(op_invert_options){list}, &inverse, &ifailed);
	if (icode != code) die("op_invert's code is not op_apply's");

	if (code != OP_OK) {
		if (out != sentinel) die("refused, and *out changed");
		if (undo.n != 0 || undo.patches != NULL) die("refused, and the undo changed");
		if (failed >= ps.n) die("refused at no patch");
		if (ifailed != failed) die("op_invert refused another patch");
		// the patches before it land; then it alone fails the same way
		op_value *before = NULL, *after = sentinel;
		if (op_apply(value, ps.p, failed, &o, &before, NULL) != OP_OK) die("the patches before the refused one fail");
		op_undo_free(&undo);
		size_t again = 999;
		// (with the list option, nothing left by a removal at [] is no [] for the rest of the call,
		// but is for a call after it: that is not tried)
		if (!(list && before == NULL) &&
			(op_apply(before, &ps.p[failed], 1, &o, &after, &again) != code || again != 0))
			die("the refused patch alone does not fail the same way");
		if (after != sentinel) die("refused, and *out changed");
		op_free(before);
	} else {
		if (inverse.n != undo.n) die("op_invert's undo is not op_apply's");
		op_value *plain = NULL;
		if (op_apply(value, ps.p, ps.n, &(op_apply_options){.list = list}, &plain, NULL) != OP_OK)
			die("refused without the undo");
		if (!same(plain, out, list)) die("the undo asked for changed the value made");
		op_value *back = NULL;
		size_t at = 999;
		int c = op_apply(out, undo.patches, undo.n, &(op_apply_options){.list = list}, &back, &at);
		if (c != OP_OK) {
			fprintf(stderr, "fuzz: undo refused: %s at %zu\n", op_code_name(c), at);
			abort();
		}
		if (!same(back, was, list) && !fz_known(&ps)) die("the undo does not give the value back");
		op_free(back);
		op_free(plain);
		op_free(out);
	}
	op_undo_free(&undo);
	op_undo_free(&inverse);

	// all let go of: what was given has no holder but the caller
	if (!fz_unshared(value)) die("a hold on the value is left");
	for (size_t i = 0; i < ps.n; i++)
		if (!fz_unshared(ps.values[i])) die("a hold on a patch's value is left");
	op_free(value);
	op_free(was);
	for (size_t i = 0; i < ps.n; i++) op_free(given[i]);
	fz_patches_free(&ps);
	return 0;
}
