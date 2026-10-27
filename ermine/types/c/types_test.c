// the types' extension claims in a folder's order (types.c key_order): canonical CBOR's, where a name
// with U+0000 (held as C0 80) counts it as one byte, so two of them come before "abc". exits 1 if not
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../../core/places/c/places.h"
#include "types.h"
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
		op_set(m, "fileNameExtension", op_str(".qq"));
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
	pl_free(p); tb_free(table); pt_free(paths); sc_free(s);
	return !ok;
}
