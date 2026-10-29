// patches, change headers, entries and nodes on the line protocol (protocol_harness.c): what a request holds of
// them, read into op's C types, and written back. for the harnesses of op and node, and what is
// built on them
#ifndef PROTOCOL_HARNESS_H
#define PROTOCOL_HARNESS_H

#include <stdio.h>

#include "harness.h"
#include "../../graph/c/node.h"

// a patch: path, range, value, move. anything malformed is a place no patch can be (a negative
// key: not-a-patch). it points into the request, and into memory of the line
void hh_patch(const op_value *p, op_patch *out);
// why a header is no header (a frame that is not a non-empty list of objects), else NULL
const char *hh_bad_header(const op_value *header);
// a change header's fields (never an op). its frame is made from the line's list of infos, innermost
// first: the caller's hold, to ch_frame_free once the entry has taken its own; reader is the
// line's, actor the request's own value, opaque to node
ch_header hh_header(const op_value *h);
// an entry made of {value?, header?} (hh_bad_header checked first); nd_free_entry it. the value is held (op_ref) by the entry
nd_entry *hh_entry(const op_value *entry);

// a patch as {path, range?, value?, move?}
void hh_put_patch(FILE *out, const op_patch *p);
// the header's fields, with its op if it has one
void hh_put_header(FILE *out, const ch_header *h);
// {"value"?: ..., "change": ...}
void hh_put_entry(FILE *out, const nd_entry *e);
// {"<table>": entry, ...}, the slots in order
void hh_put_node(FILE *out, const nd_node *n);

#endif
