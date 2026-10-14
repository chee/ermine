// the loop of every suite's C harness (harness.c): one JSON request per line in, one answer per
// line out, in order, read and written with op's JSON codec (core/op/c/json.h). a suite's binary is
// this, its adapter (<package>/c/<suite>_harness.c) and the library it speaks for. a line that is
// not JSON, or not an object, is answered { "error": "text" } and the loop goes on
#ifndef HARNESS_H
#define HARNESS_H

#include <stddef.h>
#include <stdio.h>

#include "../../core/op/c/json.h"
#include "../../core/op/c/value.h"

// --- what the adapter has ---

// before the first line: the adapter makes what it keeps (a default does nothing)
void hh_start(void);
// answers a request: writes the answer, a JSON value, to out (op_json_write, op_json_string, or
// plain fputs). what lasts between lines is the adapter's. an answer that is an error is written
// by hh_error, before anything else of it
void hh_answer(const op_value *request, FILE *out);
// after the last line: the adapter lets go of what it kept (a default does nothing)
void hh_finish(void);

// --- what the loop has ---

// { "error": why }, why as printf has it
void hh_error(FILE *out, const char *why, ...) __attribute__((format(printf, 2, 3)));
// the request is no request of the protocol: { "error": "unknown op ..." }
void hh_unknown(FILE *out, const op_value *request);
// the string at key in the map; NULL when absent or not a string
const char *hh_str(const op_value *map, const char *key);

// memory that lives as long as the line: freed when its answer is written (or, a retained line,
// when it is let go of). malloc'd, not zeroed
void *hh_take(size_t size);
// and a value, op_free'd then
op_value *hh_hold(op_value *v);
// the line's text, as it came
const char *hh_text(void);

// the line being answered, its request and all it holds, kept past its answer: for the adapter that
// keeps pieces of a request, such as a node whose change refers to them. let it go with hh_release
typedef struct hh_line hh_line;
hh_line *hh_retain(void);
void hh_release(hh_line *line);

// the protocol broke: the message on stderr, the process ends
void hh_fail(const char *why) __attribute__((noreturn));

#endif
