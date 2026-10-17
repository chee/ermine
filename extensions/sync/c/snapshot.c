// A node's tables, packed (snapshot.h), in C
#include "snapshot.h"

#include <stdlib.h>
#include <string.h>

pk_code sn_snapshot(const rp_tables *tables, uint8_t **out, size_t *length) {
	pk_entry *entries = allocate((tables->length + 1) * sizeof *entries);
	for (size_t i = 0; i < tables->length; i++) {
		entries[i] = (pk_entry){tb_string(tables->slots[i].table), tb_string(""), tables->slots[i].entry};
	}
	pk_bytes b = {0};
	pk_options options = {.no_op = 1};
	pk_code code = pk_pack(entries, tables->length, &options, &b, NULL);
	free(entries);
	if (code != PK_OK) {
		free(b.data);
		*out = NULL;
		*length = 0;
		return code;
	}
	*out = b.data;
	*length = b.length;
	return PK_OK;
}

pk_code sn_tables(const uint8_t *bytes, size_t length, rp_tables *out) {
	pk_read read;
	pk_code code = pk_unpack(bytes, length, NULL, &read);
	if (code != PK_OK) return code;
	rp_adopt(out, &read);
	return PK_OK;
}

// one table's entry, packed alone
static bool one(const nd_slot *slot, uint8_t **out, size_t *length) {
	rp_tables t = {(nd_slot *)slot, 1, NULL};
	return sn_snapshot(&t, out, length) == PK_OK;
}

bool sn_alike(const rp_tables *a, const rp_tables *b) {
	if (a->length != b->length) return false;
	for (size_t i = 0; i < a->length; i++) {
		const nd_slot *x = &a->slots[i], *y = NULL;
		for (size_t k = 0; k < b->length && y == NULL; k++)
			if (strcmp(b->slots[k].table, x->table) == 0) y = &b->slots[k];
		if (y == NULL) return false;
		uint8_t *p = NULL, *q = NULL;
		size_t m = 0, n = 0;
		bool same = one(x, &p, &m) && one(y, &q, &n) && m == n && memcmp(p, q, m) == 0;
		free(p), free(q);
		if (!same) return false;
	}
	return true;
}
