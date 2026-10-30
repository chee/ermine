// Patches, change headers, entries and nodes on the line protocol, read into C types and written back.
#ifndef PROTOCOL_HARNESS_H
#define PROTOCOL_HARNESS_H

#include <stdio.h>

#include "harness.h"
#include "../../graph/c/node.h"

// It points into the request and the line's memory.
void hh_patch(const op_value *p, op_patch *out);
const char *hh_bad_header(const op_value *header);
// A change header's fields (never an op). Its frame is built from the line's list of infos;
// the caller frees it with ch_frame_free once the entry has taken its own.
ch_header hh_header(const op_value *h);
nd_entry *hh_entry(const op_value *entry);

void hh_put_patch(FILE *out, const op_patch *p);
void hh_put_header(FILE *out, const ch_header *h);
void hh_put_entry(FILE *out, const nd_entry *e);
void hh_put_node(FILE *out, const nd_node *n);

#endif
