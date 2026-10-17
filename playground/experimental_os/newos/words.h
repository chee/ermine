// words.h: the API's words by name, values in, a value out: the one dispatch. every runner (jsc.c,
// exec.c, dylib.c, drv.c) translates only its own transport to and from op_values; items and
// patches are made from and into values here. arguments positional (js/runner.ts, apiOf), absent
// NULL; wdFields gives their names (exec.c's fields)
//
//   look, lookup, lookups, content  address                        → items
//   children                        address, name?                 → names; with name, its items
//   info                            address, name                  → items
//   node                            id                             → {id, value, info, children}
//                                                                    or none
//   write                           address, patches, index?       → time
//   set                             address, name, patches, index? → time
//   insert                          id, name, child, index?        → time
//   remove, pop                     id, name, index                → time
//   rename                          id, name, to                   → time
//   move                            id, name, index, to, toname, toindex? → time
//   create                          value?, id?, ephemeral?        → id
//   start                           address, program?, code?, name?, deep?, data? → pid
//   call                            address, args?                 → its answer, or none
//   onCleanup                       fn                             → none
//
// address: a list of names, "/" first from the root, else from the part's place
// index: a number, or [from, to] (its from)   program: a path, a list of names
// code: a live function (a setup run once) or {compute, effect?} of live functions
// fn: a live function   ephemeral, deep: anything, by truth
// item: {id, from, route: [{name}], node?: {id}, ephemeral?, versions?: [{content, change: {time,
//   actor?, reader?, site?, cause?}, because?}]}
//   a status's because: {layer: "scheduler", place: "status"}
// patch: {path, range?, value?, move?}, or old {type: "snapshot", value}, {type: "set", path, key,
//   value?}, {type: "splice", path, range, value}
#ifndef ERMOS_WORDS_H
#define ERMOS_WORDS_H

#include "api.h"

/**
 * the word done through api (a part's, its peep, or either as a cause: ap_as), start, call and
 * onCleanup through g (NULL: none running); *out the answer, fresh (op_free), NULL none. An error
 * (NULL: none) is the turn's: an argument that is not what the word takes is "wrong-field", a word
 * not known "wrong-field" too
 */
const ap_error *wdDo(ap_given *g, ap_api *api, const char *word, const op_value *const *args, size_t n, op_value **out);
/** the names of a word's arguments, in order, then NULL; NULL: no such word */
const char *const *wdFields(const char *word);
/** items as a value, fresh: a list, each as above */
op_value *wdItems(const ap_items *items);
/**
 * patches from a list of values (either shape above): the turn's (ap_temp), their values borrowed
 * from the list, which outlives the write; *n how many. NULL with *why when one is not a patch
 */
op_patch *wdPatches(ap_os *os, const op_value *list, size_t *n, const char **why);
/** an address from a list of names: the turn's, NULL-ended; NULL if it is not one */
const char *const *wdNames(ap_os *os, const op_value *list, size_t *n);

#endif
