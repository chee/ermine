// programs' answers as the harnesses' JSON (typescript/programs_harness.ts documents it): for the
// C harnesses of programs and start. Every function gives a new value.
#ifndef PROGRAMS_JSON_H
#define PROGRAMS_JSON_H

#include "../../../core/op/c/value.h"
#include "programs.h"

op_value *pg_place_json(const pg_place *p);
op_value *pg_step_json(const pg_step *s);
op_value *pg_chain_json(const pg_chain *c);
op_value *pg_found_json(const pg_found *f);
op_value *pg_opened_json(const pg_opened *o);
op_value *pg_path_json(char *const *at, size_t n);

#endif
