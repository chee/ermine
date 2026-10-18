// A node's tables at a head, packed (extensions/together/typescript/snapshot.ts), in C: each kept table's
// entry, value and change, as pack.h writes a node, under the table and an id of none. Read back as new
// entries each time: replay applies to them in place
#ifndef SN_SNAPSHOT_H
#define SN_SNAPSHOT_H

#include "replay.h"

// the tables packed (no op in a change): *out malloc'd, free it. PK_CANNOT_CARRY: a value or a
// header has no encoding
pk_code sn_snapshot(const rp_tables *tables, uint8_t **out, size_t *length);

// the tables back, new ones, put in out (rp_init'd, empty): PK_NOT_A_PACK when the bytes are no
// snapshot, and out is left as it was
pk_code sn_tables(const uint8_t *bytes, size_t length, rp_tables *out);

// two nodes' tables the same: the same tables, each one's entry packed alike (snapshot.ts's alike)
bool sn_alike(const rp_tables *a, const rp_tables *b);

#endif
