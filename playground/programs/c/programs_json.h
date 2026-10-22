// programs' answers as the harnesses' JSON (typescript/programs_harness.ts documents it): for the
// C harnesses of programs and start. Every function gives a new value.
#ifndef PROGRAMS_JSON_H
#define PROGRAMS_JSON_H

#include "../../../core/op/c/value.h"
#include "programs.h"

op_value *pg_place_json(const pg_place *p);
op_value *pg_found_json(const pg_found *f);
op_value *pg_opened_json(const pg_opened *o);

#endif
