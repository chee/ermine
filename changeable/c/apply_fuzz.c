// libFuzzer target: applies fuzzed values and patches, copy-on-write and in place, and checks that
// refusals change nothing, undo restores the value, references balance, strings stay WTF-8, and
// string spans match a UTF-16 model.
#include "apply.h"
#include "invert.h"
#include "fuzz_values.h"

#include <stdio.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

static int same(const op_value *a, const op_value *b) { return fz_equal(a, b); }

enum { FZ_UNITS = 64 };
typedef struct {
	unsigned u[FZ_UNITS];
	size_t n;
} units;
static int is_high(unsigned u) { return u >= 0xD800 && u < 0xDC00; }
static int is_low(unsigned u) { return u >= 0xDC00 && u < 0xE000; }
static void decode(const op_value *s, units *out) {
	const unsigned char *p = (const unsigned char *)s->str;
	out->n = 0;
	for (size_t i = 0; i < s->bytes;) {
		unsigned c = p[i], n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
		unsigned long cp = n == 1 ? c : c & (0x7Fu >> n);
		for (unsigned j = 1; j < n; j++) cp = cp << 6 | (p[i + j] & 63);
		if (cp >= 0x10000) {
			out->u[out->n++] = 0xD800 + (unsigned)((cp - 0x10000) >> 10);
			out->u[out->n++] = 0xDC00 + (unsigned)((cp - 0x10000) & 0x3FF);
		} else out->u[out->n++] = (unsigned)cp;
		i += n;
	}
}
static size_t encode(const units *s, char *out) {
	unsigned char *o = (unsigned char *)out;
	size_t n = 0;
	for (size_t i = 0; i < s->n; i++) {
		unsigned long cp = s->u[i];
		if (is_high(s->u[i]) && i + 1 < s->n && is_low(s->u[i + 1]))
			cp = 0x10000 + ((cp - 0xD800) << 10) + (s->u[++i] - 0xDC00);
		if (cp < 0x80) o[n++] = (unsigned char)cp;
		else if (cp < 0x800) o[n++] = (unsigned char)(0xC0 | cp >> 6), o[n++] = (unsigned char)(0x80 | (cp & 63));
		else if (cp < 0x10000) {
			o[n++] = (unsigned char)(0xE0 | cp >> 12), o[n++] = (unsigned char)(0x80 | (cp >> 6 & 63));
			o[n++] = (unsigned char)(0x80 | (cp & 63));
		} else {
			o[n++] = (unsigned char)(0xF0 | cp >> 18), o[n++] = (unsigned char)(0x80 | (cp >> 12 & 63));
			o[n++] = (unsigned char)(0x80 | (cp >> 6 & 63)), o[n++] = (unsigned char)(0x80 | (cp & 63));
		}
	}
	return n;
}
static long unit_at(const units *s, int64_t k) {
	size_t i = 0;
	for (; k > 0; k--) {
		if (i >= s->n) return -1;
		i += i + 1 < s->n && is_high(s->u[i]) && is_low(s->u[i + 1]) ? 2 : 1;
	}
	return (long)i;
}
static units splice(const units *s, size_t x, size_t y, const units *in, size_t ix, size_t iy) {
	units o = {.n = 0};
	for (size_t i = 0; i < x; i++) o.u[o.n++] = s->u[i];
	for (size_t i = ix; i < iy; i++) o.u[o.n++] = in->u[i];
	for (size_t i = y; i < s->n; i++) o.u[o.n++] = s->u[i];
	return o;
}

static void model(fz_bytes *b, const op_value *v) {
	unsigned k = fz_byte(b) % 3;
	int64_t x = fz_byte(b) % 8, y = fz_byte(b) % 8, g = fz_byte(b) % 8;
	op_value *piece = fz_text(b);
	units s, in, want = {.n = 0};
	decode(v, &s);
	decode(piece, &in);
	long ux = unit_at(&s, x), uy = unit_at(&s, y);
	int ok = x <= y && uy >= 0;
	op_patch p = {.place = {.has_range = 1, .from = x, .to = y}};
	if (k == 0) p.has_value = 1, p.value = piece;
	if (k == 2) {
		p.place = (op_target){.has_range = 1, .from = g, .to = g};
		p.has_move = 1, p.move = (op_target){.has_range = 1, .from = x, .to = y};
	}
	if (ok && k < 2) want = splice(&s, (size_t)ux, (size_t)uy, &in, 0, k == 0 ? in.n : 0);
	if (ok && k == 2) {
		units rest = splice(&s, (size_t)ux, (size_t)uy, &in, 0, 0);
		long ug = unit_at(&rest, g);
		ok = ug >= 0;
		if (ok) want = splice(&rest, (size_t)ug, (size_t)ug, &s, (size_t)ux, (size_t)uy);
	}
	char bytes[FZ_UNITS * 3];
	size_t n = encode(&want, bytes);
	op_value *out = NULL, *back = NULL;
	op_undo undo = {0};
	int code = op_apply(v, &p, 1, &(op_apply_options){.undo = &undo}, &out, NULL);
	if (!ok) {
		if (code == OP_OK) die("the model: a span past the end or reversed, and not refused");
	} else {
		if (code != OP_OK) {
			fprintf(stderr, "fuzz: the model: refused: %s\n", op_code_name(code));
			abort();
		}
		if (out == NULL || out->type != OP_STR || out->bytes != n || memcmp(out->str, bytes, n) != 0)
			die("the model: another string");
		if (!fz_wtf8(out)) die("the model: a string not WTF-8");
		if (op_apply(out, undo.patches, undo.n, NULL, &back, NULL) != OP_OK) die("the model: the undo is refused");
		if (!same(back, v)) die("the model: the undo does not give the string back");
	}
	op_free(back);
	op_free(out);
	op_undo_free(&undo);
	op_free(piece);
}

static void patches_with(const fz_patches *ps, op_patch *out, op_value **values) {
	for (size_t i = 0; i < ps->n; i++) {
		out[i] = ps->p[i];
		values[i] = ps->values[i] ? fz_copy(ps->values[i]) : NULL;
		if (ps->p[i].has_value) out[i].value = values[i];
	}
}

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
		if (!fz_wtf8(end)) die("in place, a string not WTF-8");
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
	op_value *value = flags & 2 ? NULL : (flags & 12) == 12 ? fz_text(&b) : fz_value(&b, 0);
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
		if (!fz_wtf8(out)) die("a string not WTF-8");
		op_value *back = NULL;
		size_t at = 999;
		int c = op_apply(out, undo.patches, undo.n, NULL, &back, &at);
		if (c != OP_OK) {
			fprintf(stderr, "fuzz: undo refused: %s at %zu\n", op_code_name(c), at);
			abort();
		}
		if (!same(back, was)) die("the undo does not give the value back");
		if (!fz_wtf8(back)) die("undone, a string not WTF-8");
		op_free(back);
		op_free(plain);
		in_place(was, &ps, code, failed, out, &undo);
		op_free(out);
	}
	op_undo_free(&undo);
	op_undo_free(&inverse);

	if (value != NULL && value->type == OP_STR) model(&b, value);

	if (!fz_unshared(value)) die("a hold on the value is left");
	for (size_t i = 0; i < ps.n; i++)
		if (!fz_unshared(ps.values[i])) die("a hold on a patch's value is left");
	op_free(value);
	op_free(was);
	for (size_t i = 0; i < ps.n; i++) op_free(given[i]);
	fz_patches_free(&ps);
	return 0;
}
