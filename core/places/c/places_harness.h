// The places harness for a harness built on it (compiled with -DPH_LIB, so hh_answer and
// hh_finish are the builder's). Matches typescript/places_harness.ts.
#ifndef PLACES_HARNESS_H
#define PLACES_HARNESS_H

#include <stdbool.h>

#include "world_harness.h"

typedef struct {
	bool stopped;
	bool waited;
	char *error;
} ph_eval;

op_value *ph_answer(const op_value *request);
// A program form of the builder's. *handled is 1 when e is one of its forms. NULL means it ended
// early. Evaluate a sub-program with ph_eval_of.
typedef op_value *(*ph_form)(const op_value *e, ph_eval *c, bool *handled);
void ph_add_form(ph_form form);
op_value *ph_eval_of(const op_value *e, ph_eval *c);
void ph_throw(ph_eval *c, char *error);
void ph_finish(void);

#endif
