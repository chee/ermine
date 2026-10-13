// Shown nodes on the line protocol, for the C harnesses (shown.c): JSON read as spans of the line,
// values as op_values, changes and patches, and the writing of them
#ifndef SHOWN_H
#define SHOWN_H

#include "node.h"

void fail(const char *why);
// everything one line allocates, freed by clear when its answer is written
void *take(size_t size);
void clear(void);
// at the end: clear, and the arena itself
void finish(void);

// reading JSON: values as spans of the line
const char *space(const char *p);
// past one value
const char *skip(const char *p);
// a JSON string at p, decoded
char *string(const char *p);
// a value's JSON text, as written
char *raw(const char *p);
// the value at key in the object at p; NULL when absent
const char *field(const char *p, const char *key);
// the items of the array at p: count, then each start
size_t items(const char *p, const char ***out);

// a value at p (not in the arena: op_free it). Typed arrays are {"$Int8Array": [...]} (and four
// other kinds), and ENCODING.tex's JSON form ({"/": {"bytes": b64}}, {"/": {kind: [...]}})
op_value *read_value(const char *p);
ch_site site(const char *p);
// a change header's fields (never an op); external, metadata, strings and actor in the arena
ch_header parse_header(const char *p);
// a patch at p: the op_value holding what it refers to is returned (op_free it when the patch is
// done with), its keys are in the arena
op_value *read_patch(const char *p, op_patch *out);
// a shown node's value (the field "value", if any) and header, made by nd_make; nd_free it and
// op_free the value
nd_node *parse_node(const char *p, op_value **value);

// writing JSON
void text(const char *s);
void print_value(const op_value *v);
// a patch as {path, range?, value?, move?}
void print_patch(const op_patch *p);
// the header's fields, with its op if it has one
void print_header(const ch_header *h);
// {"value"?: ..., "change": ...}
void show_node(const nd_node *n);

#endif
