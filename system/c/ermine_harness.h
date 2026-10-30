// What another harness adds to the ermine harness (ermine_harness.c): an extension's tests are the
// same harness with its ops beside. Set before the first request (a constructor does).
#ifndef ERMINE_HARNESS_H
#define ERMINE_HARNESS_H

#include "ermine.h"

// returned by hx_op for a request that is not its op
#define HX_NOT_MINE (-1)

// an op of its own: the request, the ermine, the answer to make (*res, an op map). 0, or an es_code
// (then the answer is the error); HX_NOT_MINE: not its op, the harness goes on
extern int (*hx_op)(const op_value *request, es_ermine *e, op_value **res);
// the places the "start" op's "in" names (NULL: none by that name)
extern pl *(*hx_places)(const char *name);

#endif
