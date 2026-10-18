// The places harness (places_harness.c) for a harness built on it (compiled with -DPH_LIB, so its own
// hh_answer and hh_finish are the builder's): its requests, its program forms, its end. As
// typescript/places_harness.ts's answer and forms.
#ifndef PLACES_HARNESS_H
#define PLACES_HARNESS_H

#include <stdbool.h>

#include "world_harness.h"

// what a program is evaluated in: how it ended early, if it did: stopped (a read said the run must
// end), waited (pending), or an error (malloc'd; set with ph_throw)
typedef struct {
	bool stopped;
	bool waited;
	char *error;
} ph_eval;

// places' requests, answered; NULL: not one of them
op_value *ph_answer(const op_value *request);
// a program form of the builder's: *handled 1 when e is one of its forms (the value is then the form's: NULL
// when it ended early); evaluate a sub-program with ph_eval_of (NULL: it ended early)
typedef op_value *(*ph_form)(const op_value *e, ph_eval *c, bool *handled);
void ph_add_form(ph_form form);
op_value *ph_eval_of(const op_value *e, ph_eval *c);
// the program ends on this error (taken: freed by the harness)
void ph_throw(ph_eval *c, char *error);
// after the last line, before the builder's own
void ph_finish(void);

#endif
