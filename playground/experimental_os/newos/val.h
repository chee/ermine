// val.h: a value as the graph holds it (op_value, core/changeable) and as the OS
// builds and prints it (Json, json.h), each into the other. The two hold
// the same kinds (ENCODING.tex); a live function (api.h's ap_live) is a
// stand-in either way.

#ifndef ERMOS_VAL_H
#define ERMOS_VAL_H

#include "../../../ermine/encoding/c/json.h"
#include "../../../core/changeable/c/apply.h"

/** the graph's value of a Json: fresh. NULL: null */
op_value *valOf(const Json *json);
/** the Json of a graph value: fresh. NULL: NULL */
Json *jsonOfVal(const op_value *v);
/**
 * the same, for a value that is never changed in place (a node's value: api.c's value entries are
 * copy-on-write): its lists, maps, bytes and typed arrays made once and kept while they are read,
 * so an unchanged value, or an unchanged part of a changed one, is the same Json each time (a
 * driver's cache keys on it). A hold for the caller; the op_value is held while it is kept. valOf
 * of a Json made here gives that value again, held, not a copy
 */
Json *jsonOfValKept(const op_value *v);
/** each turn's end: what was kept and not read for a few turns let go */
void valSweep(void);
/** one patch: the whole value, at path [] */
op_patch valWhole(const op_value *v);
/** one patch: a key of a map set */
op_patch valKey(const char *key, const op_value *v);
/** two values the same all the way down */
int valEqual(const op_value *a, const op_value *b);
/** a value printed, for the log: fresh */
char *valPrint(const op_value *v);

#endif
