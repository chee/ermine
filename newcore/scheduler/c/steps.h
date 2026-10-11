// Programs as data (newcore/scheduler/conformance/steps.ts, normal.ts), in C: the step language a
// conformance harness interprets, and the JSON forms of what the scheduler gives. See steps.ts
// for the language.
#ifndef STEPS_H
#define STEPS_H

#include <stddef.h>

#include "scheduler.h"

// what the log step appends to
typedef struct {
	sc_sched *s;
	void (*log)(void *ctx, nt_value *v);
	void *ctx;
} st_env;

// a growing string
typedef struct {
	char *s;
	size_t n, cap;
} st_buf;
void st_put(st_buf *b, const char *x, size_t n);
// v as JSON (a live value as "<live>"); b is malloc'd, free b->s
void st_dump(st_buf *b, const nt_value *v);

// a program's code from its JSON ({setup}, {compute}, {compute, effect}); not-a-program otherwise
const sc_error *st_load(st_env *env, const nt_value *p, sc_code *out);
// a start step's or request's program: a list of names is a path; else code. address of a path
// is in the arena
const sc_error *st_program(st_env *env, const nt_value *p, sc_startop *op);

// an error's code: its own, else "thrown"
const char *st_code(const sc_error *e);

// the JSON forms of what an interface gives (normal.ts): a version, an item
nt_value *st_json(const nt_value *v);
nt_value *st_version(sc_sched *s, const nd_version *v);
nt_value *st_item(sc_sched *s, const sc_item *it, int content);

// an operation of an interface (normal.ts operate): fields a map; the answer in *out. an unknown
// op: an error with code "unknown-op"
const sc_error *st_operate(sc_sched *s, sc_api *api, const char *op, const nt_value *fields,
	nt_value **out);

#endif
