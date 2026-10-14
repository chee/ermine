// libFuzzer target: the input bytes are a value and a list of patches (fuzz_values.h), applied
// with op_apply, and again on copies in place. Checked:
// - nothing given changes (the value and the patches' values, against copies made before);
// - refused: *out and the undo as they were; the patches before the refused one apply, and the
//   refused one alone then fails the same way, at index 0; op_invert says the same;
// - done: the same value with no undo asked for; the undo applied to the result gives the value
//   back (maps by content); op_invert gives an undo as long;
// - references balance: once what came out is freed, nothing given has a holder past the caller
//   (and the leak checker sees nothing left);
// - in place, on copies of the value and the patches' values: refused, the copy as it was (by
//   content) and the same code and index; done, the same value and undo as copy-on-write, and the
//   undo applied to the result gives the value back.
#include "apply.h"
#include "invert.h"
#include "fuzz_values.h"

#include <stdio.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

static int same(const op_value *a, const op_value *b) { return fz_equal(a, b); }

// the patches p, aimed at the same places, with these values in them
static void patches_with(const fz_patches *ps, op_patch *out, op_value **values) {
	for (size_t i = 0; i < ps->n; i++) {
		out[i] = ps->p[i];
		values[i] = ps->values[i] ? fz_copy(ps->values[i]) : NULL;
		if (ps->p[i].has_value) out[i].value = values[i];
	}
}

// the undo of both ways is the same patches
static int same_undo(const op_undo *a, const op_undo *b) {
	if (a->n != b->n) return 0;
	for (size_t i = 0; i < a->n; i++) {
		const op_patch *x = &a->patches[i], *y = &b->patches[i];
		if (x->has_value != y->has_value || x->has_move != y->has_move) return 0;
		if (x->place.length != y->place.length || x->place.has_range != y->place.has_range) return 0;
		if (x->place.has_range && (x->place.from != y->place.from || x->place.to != y->place.to)) return 0;
		if (x->has_value && !fz_equal(x->value, y->value)) return 0;
	}
	return 1;
}

// the same in place, on copies of the value and the patches' values: the code and index as op_apply
// gave, a refused call leaving the copy as it was, a good one the same value and undo
static void in_place(const op_value *was, const fz_patches *ps, int code, size_t failed,
	const op_value *out, const op_undo *undo) {
	op_value *v = fz_copy(was), *values[FZ_PATCHES] = {0};
	op_patch patches[FZ_PATCHES];
	patches_with(ps, patches, values);
	op_value *end = NULL;
	size_t at = 999;
	op_undo again = {0};
	int c = op_apply(v, patches, ps->n, &(op_apply_options){.in_place = 1, .undo = code == OP_OK ? &again : NULL}, &end, &at);
	if (c != code) die("in place, another code");
	if (code != OP_OK) {
		if (at != failed) die("in place, another patch refused");
		if (end != NULL) die("in place, refused, and *out set");
		if (!same(v, was)) die("in place, refused, and the value changed");
	} else {
		if (!same(end, out)) die("in place, another value");
		if (!same_undo(&again, undo)) die("in place, another undo");
		if (end != NULL && v != NULL && end != v && (v->type == OP_LIST || v->type == OP_MAP)) {
			int whole = 0;
			for (size_t i = 0; i < ps->n; i++)
				whole |= ps->p[i].place.length == 0 || (ps->p[i].has_move && ps->p[i].move.length == 0);
			if (!whole) die("in place, not the value given");
		}
		op_value *back = NULL;
		if (op_apply(end, again.patches, again.n, NULL, &back, NULL) != OP_OK) die("in place, the undo is refused");
		if (!same(back, was)) die("in place, the undo does not give the value back");
		op_free(back);
	}
	op_undo_free(&again);
	op_free(end);
	op_free(v);
	for (size_t i = 0; i < ps->n; i++) op_free(values[i]);
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	fz_bytes b = {data, size, 0};
	unsigned flags = fz_byte(&b);
	op_value *value = flags & 2 ? NULL : fz_value(&b, 0);
	fz_patches ps;
	fz_patch_list(&b, value, &ps);
	op_value *was = fz_copy(value), *given[FZ_PATCHES];
	for (size_t i = 0; i < ps.n; i++) given[i] = fz_copy(ps.values[i]);

	op_value *const sentinel = (op_value *)&b;
	op_value *out = sentinel;
	op_undo undo = {0};
	op_apply_options o = {.undo = &undo};
	size_t failed = 999;
	int code = op_apply(value, ps.p, ps.n, &o, &out, &failed);

	if (!fz_equal(value, was)) die("the value given changed");
	for (size_t i = 0; i < ps.n; i++)
		if (!fz_equal(ps.values[i], given[i])) die("a patch's value changed");

	op_undo inverse = {0};
	size_t ifailed = 999;
	int icode = op_invert(value, ps.p, ps.n, &inverse, &ifailed);
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
		if (op_apply(before, &ps.p[failed], 1, &o, &after, &again) != code || again != 0)
			die("the refused patch alone does not fail the same way");
		if (after != sentinel) die("refused, and *out changed");
		op_free(before);
		in_place(was, &ps, code, failed, NULL, &undo);
	} else {
		if (inverse.n != undo.n) die("op_invert's undo is not op_apply's");
		op_value *plain = NULL;
		if (op_apply(value, ps.p, ps.n, NULL, &plain, NULL) != OP_OK)
			die("refused without the undo");
		if (!same(plain, out)) die("the undo asked for changed the value made");
		op_value *back = NULL;
		size_t at = 999;
		int c = op_apply(out, undo.patches, undo.n, NULL, &back, &at);
		if (c != OP_OK) {
			fprintf(stderr, "fuzz: undo refused: %s at %zu\n", op_code_name(c), at);
			abort();
		}
		if (!same(back, was)) die("the undo does not give the value back");
		op_free(back);
		op_free(plain);
		in_place(was, &ps, code, failed, out, &undo);
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
