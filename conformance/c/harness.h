// One JSON request per line in, one answer per line out; a non-object line gets { "error": text }.
#ifndef HARNESS_H
#define HARNESS_H

#include <stddef.h>
#include <stdio.h>

#include "../../changeable/c/json.h"
#include "../../changeable/c/value.h"


void hh_start(void);
void hh_answer(const op_value *request, FILE *out);
void hh_finish(void);


void hh_error(FILE *out, const char *why, ...) __attribute__((format(printf, 2, 3)));
void hh_unknown(FILE *out, const op_value *request);
const char *hh_str(const op_value *map, const char *key);

// Memory freed when the line's answer is written (or when a retained line is released).
void *hh_take(size_t size);
// Like hh_take, for a value; freed with op_free.
op_value *hh_hold(op_value *v);
const char *hh_text(void);

// Keeps the line being answered, with everything its request holds, alive past its answer.
// For adapters that keep pieces of a request. Free it with hh_release.
typedef struct hh_line hh_line;
hh_line *hh_retain(void);
void hh_release(hh_line *line);

void hh_fail(const char *why) __attribute__((noreturn));

#endif
