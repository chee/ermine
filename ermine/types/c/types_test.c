// the types' extension claims in a folder's order (types.c key_order): canonical CBOR's, where a name
// with U+0000 (held as C0 80) counts it as one byte, so two of them come before "abc"; and swift's
// UTType over a few types placed by hand. exits 1 if any is wrong
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../core/places/c/places.h"
#include "types.h"
static int failed;
#define CHECK(x) \
	do { \
		if (!(x)) printf("wrong: %s\n", #x), failed = 1; \
	} while (0)
#define SAME(got, want) \
	do { \
		char *g = (got); \
		const char *w = (want); \
		if (!((g == NULL && w == NULL) || (g != NULL && w != NULL && strcmp(g, w) == 0))) \
			printf("wrong: %s is %s, not %s\n", #got, g ? g : "NULL", w ? w : "NULL"), failed = 1; \
		free(g); \
	} while (0)

static op_value *strs(const char *a, const char *b) {
	op_value *l = op_list();
	if (a) op_push(l, op_str(a));
	if (b) op_push(l, op_str(b));
	return l;
}

// a few types placed by hand in R, as a types folder: swift's answers
static int uttype(void) {
	pl *p = pl_new();
	sc_scheduler *s = sc_new((sc_options){0});
	sc_on_tracking_end(s, pl_forget, p);
	tb_table *table = tb_make(pl_event, p);
	pt_paths *paths = pt_new();
	pl_connect(p, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths, .scheduler = s});
	nd_entry *kids = nd_make_entry(NULL, NULL);
	pl_own(p, kids);
	tb_add(table, tb_string("children"), tb_string("R"), kids);
	struct {
		const char *name, *id, *up, *ext1, *ext2, *mime, *url;
		int version;
	} types[] = {
		{"public.item", "IT", NULL, NULL, NULL, NULL, NULL, 0},
		{"public.data", "D", "public.item", NULL, NULL, NULL, NULL, 0},
		{"public.image", "I", "public.data", NULL, NULL, NULL, NULL, 0},
		{"public.jpeg", "J", "public.image", "jpeg", "JPG", "image/jpeg", "https://jpeg.org", 3},
		{"com.apple.package", "P", "public.item", NULL, NULL, NULL, NULL, 0},
		{"com.apple.application-bundle", "AB", "com.apple.package", "app", NULL, NULL, NULL, 0},
	};
	for (size_t i = 0; i < sizeof types / sizeof *types; i++) {
		pl_changed ch;
		if (pl_place(p, kids, types[i].name, tb_string(types[i].id), (ch_header){0}, &ch)) return 0;
		pl_commit(p, &ch);
		op_value *m = op_map();
		op_set(m, "conformsTo", strs(types[i].up, NULL));
		op_set(m, "filenameExtension", strs(types[i].ext1, types[i].ext2));
		op_set(m, "mimeType", strs(types[i].mime, NULL));
		if (types[i].url) op_set(m, "referenceURL", op_str(types[i].url));
		if (types[i].version) op_set(m, "version", op_int(types[i].version));
		nd_entry *e = nd_make_entry(m, NULL);
		op_free(m);
		pl_own(p, e);
		tb_add(table, tb_string("value"), tb_string(types[i].id), e);
	}
	ty_folder f = {.id = "R", .path = NULL, .n = 0};
	CHECK(ty_is_declared(p, &f, TY_JPEG));
	CHECK(!ty_is_declared(p, &f, TY_PNG));
	CHECK(!ty_is_declared(p, NULL, TY_JPEG));
	CHECK(ty_is_public(TY_JPEG) && !ty_is_public(TY_PDF));
	CHECK(ty_is_dynamic("dyn.ah62d4rv4ge80k2u") && !ty_is_dynamic(TY_JPEG));
	SAME(ty_preferred_filename_extension(p, &f, TY_JPEG), "jpeg");
	SAME(ty_preferred_mime_type(p, &f, TY_JPEG), "image/jpeg");
	SAME(ty_preferred_mime_type(p, &f, TY_IMAGE), NULL);
	SAME(ty_preferred_mime_type(p, &f, TY_PNG), NULL);
	SAME(ty_reference_url(p, &f, TY_JPEG), "https://jpeg.org");
	long long v = 0;
	CHECK(ty_version(p, &f, TY_JPEG, &v) && v == 3);
	CHECK(!ty_version(p, &f, TY_IMAGE, &v));
	ty_conformance up = ty_supertypes(p, &f, TY_JPEG);
	CHECK(up.known && up.n == 3 && strcmp(up.all[0], TY_IMAGE) == 0 && strcmp(up.all[2], TY_ITEM) == 0);
	ty_conformance_free(&up);
	CHECK(ty_conforms_to(p, &f, TY_JPEG, TY_IMAGE) && ty_conforms_to(p, &f, TY_JPEG, TY_JPEG));
	CHECK(!ty_conforms_to(p, &f, TY_JPEG, TY_PACKAGE));
	CHECK(ty_is_subtype_of(p, &f, TY_JPEG, TY_DATA) && !ty_is_subtype_of(p, &f, TY_JPEG, TY_JPEG));
	CHECK(ty_is_supertype_of(p, &f, TY_DATA, TY_JPEG) && !ty_is_supertype_of(p, &f, TY_JPEG, TY_DATA));
	SAME(ty_from_filename_extension(p, &f, "jpg", NULL), TY_JPEG);
	SAME(ty_from_filename_extension(p, &f, "JPEG", TY_IMAGE), TY_JPEG);
	SAME(ty_from_filename_extension(p, &f, ".jpg", NULL), NULL);
	SAME(ty_from_filename_extension(p, &f, "jpg", TY_PACKAGE), NULL);
	// an app is a package, not data: none unless asked for what it is
	SAME(ty_from_filename_extension(p, &f, "app", NULL), NULL);
	SAME(ty_from_filename_extension(p, &f, "app", TY_PACKAGE), TY_APPLICATION_BUNDLE);
	SAME(ty_from_mime_type(p, &f, "IMAGE/JPEG", NULL), TY_JPEG);
	SAME(ty_from_mime_type(p, &f, "image/png", NULL), NULL);
	pl_free(p); tb_free(table); pt_free(paths); sc_free(s);
	printf("uttype: %s\n", failed ? "wrong" : "right");
	return !failed;
}

int main(void) {
	pl *p = pl_new();
	sc_scheduler *s = sc_new((sc_options){0});
	sc_on_tracking_end(s, pl_forget, p);
	tb_table *table = tb_make(pl_event, p);
	pt_paths *paths = pt_new();
	pl_connect(p, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths, .scheduler = s});
	nd_entry *kids = nd_make_entry(NULL, NULL);
	pl_own(p, kids);
	tb_add(table, tb_string("children"), tb_string("R"), kids);
	const char *names[] = {"abc", "\xC0\x80\xC0\x80"};
	const char *ids[] = {"A", "B"};
	for (int i = 0; i < 2; i++) {
		pl_changed ch;
		if (pl_place(p, kids, names[i], tb_string(ids[i]), (ch_header){0}, &ch)) return 2;
		pl_commit(p, &ch);
		op_value *m = op_map();
		op_set(m, "filenameExtension", op_str("qq"));
		nd_entry *e = nd_make_entry(m, NULL);
		op_free(m);
		pl_own(p, e);
		tb_add(table, tb_string("value"), tb_string(ids[i]), e);
	}
	ty_folder f = {.id = "R", .path = NULL, .n = 0};
	ty_extensions e = ty_extensions_of(p, &f);
	const char *t = ty_by_name(&e, "x.qq");
	int ok = t && strcmp(t, "\xC0\x80\xC0\x80") == 0;
	printf("claimed by %s\n", ok ? "NULs (right)" : "abc (wrong)");
	ty_extensions_free(&e);
	ok &= uttype();
	pl_free(p); tb_free(table); pt_free(paths); sc_free(s);
	return !ok;
}
