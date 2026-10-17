// words.h: the API's words (api.h), each by name, from values to a value: the one dispatch. A
// program's part says a word with its arguments (look, lookup, lookups, content, children, info,
// node, write, set, insert, remove, pop, rename, move, create; start, call, onCleanup) and gets an
// answer or an error. Every runner calls this and translates only its own transport to and from
// op_values: the JavaScript runner (jsc.c) its JSValues, the exec ABI (exec.c) its CBOR frames, the
// dlopen runner (dylib.c) its table of values, the drivers' kit (drv.c) its Json. Items (what a
// read gives) and patches (what a write takes) are made from and into values here, once.
//
// The arguments are positional, as the runner's api takes them (js/runner.ts, apiOf), an absent
// one NULL; wdFields gives their names, as the exec ABI's fields name them (exec.c's header):
//
//   look, lookup, lookups, content  address                         → items
//   children                        address, name?                  → names; with name, that list's items
//   info                            address, name                   → items
//   node                            id                              → {id, value, info, children}, or none
//   write                           address, patches, index?        → time
//   set                             address, name, patches, index?  → time
//   insert                          id, name, child, index?         → time
//   remove, pop                     id, name, index                 → time
//   rename                          id, name, to                    → time
//   move                            id, name, index, to, toname, toindex? → time
//   create                          value?, id?, ephemeral?         → id
//   start                           address, program?, code?, name?, deep?, data? → pid
//   call                            address, args?                  → its answer, or none
//   onCleanup                       fn                              → none
//
// An address is a list of names ("/" first: from the root; else from the part's place); an index a
// number, or a list whose first is one ([from, to]: its from); a program a path, a list of names; code
// a live function (a setup run once, as a compute whose value is its own) or a map {compute, effect?}
// of live functions; fn a live function; ephemeral and deep anything, by truth. An item is core's:
// {id, from, route: [{name}], node?: {id}, ephemeral?, versions?: [{content, change: {time, actor?,
// reader?, site?, cause?}, because?}]}, a status's version because {layer: "scheduler", place:
// "status"}. A patch is core's {path, range?, value?, move?}, or the old core's {type: "snapshot",
// value}, {type: "set", path, key, value?}, {type: "splice", path, range, value}.
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
