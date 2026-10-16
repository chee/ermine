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
