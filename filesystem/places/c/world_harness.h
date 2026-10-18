// For the harnesses of places and guard: the world they share, made as a composer makes it. One
// scheduler, one table, one paths and one places (root "R"); the host's scope; the names of scopes and computations, the moments told, the computes made by watches, and
// the requests about them (typescript/world_harness.ts documents the protocol). A harness adds its own
// requests and programs, and answers its lines with world_line.
//
// Every write below is made in a scope: the host's (sc_run_with_scope) for a request, the run's own for a
// program's. The world's own scope pairs have op_values as values, as places.h says.
#ifndef PLACES_WORLD_HARNESS_H
#define PLACES_WORLD_HARNESS_H

#include <stdbool.h>
#include <stddef.h>

#include "../../../conformance/c/harness.h"
#include "cache.h"
#include "places.h"

extern sc_scheduler *world_scheduler;
extern tb_table *world_table;
extern pt_paths *world_paths;
extern pl *world_places;
// the host's scope: its info is {"actor":"test"}
extern sc_scope *world_host;
// the path cache (cache.h), made at the first ask (or the cache request), once; NULL until then
pc_cache *world_cached(void);

// the contributors the world's places is given (places.h; none: children alone), set before the first
// line, the caller's own and kept alive
void world_contribute(const pl_contributor *const *list, size_t n);

// the event and ctx the world's table is made with, set before the first line, the caller's own and
// kept alive; never set: pl_event and the places, as the table always was
void world_event(tb_event event, void *ctx);

// a line answered: the world is made at the first, and every line is kept (retained) until
// world_finish, for the programs, patches and scope info that refer into it. answer gives a
// harness's answer to the request, or NULL: not one of its own (the world's is tried); the answer
// is written to out and let go of
void world_line(const op_value *request, FILE *out, op_value *(*answer)(const op_value *request));
// the world let go, and the lines (a harness first lets go of what it made in it)
void world_finish(void);

// what the harnesses keep until the end: a value made (programs and patches refer into it), a node
void world_keep(op_value *value);
void world_keep_node(nd_entry *node);

// calloc that aborts (zeroed), a copy of a string, a string as printf has it: all fresh, the caller's to free
void *world_alloc(size_t size);
char *world_copy(const char *text);
char *world_format(const char *format, ...) __attribute__((format(printf, 1, 2)));

// the parts of a value, as a request holds them
const char *world_text(const op_value *v);
bool world_is(const op_value *v, op_type type);
bool world_whole(const op_value *v, int64_t *out);
// a value a program gives: the value itself, held (values are never changed). NULL: null
op_value *world_snap(const op_value *v);
// a header's patches, as a list of {path, range?, value?, move?}, new
op_value *world_patches(const op_patch *patches, size_t n);

// scopes and computations, by name. world_name: NULL, or an error (the name is taken)
char *world_name(sc_scope *o, const char *name);
sc_scope *world_scope(const char *name);

// f once in the host's scope, as sc_run_with_scope
const char *world_hosted(void (*f)(void *data), void *data);

// pairs of scope info, from a request's info object: each key, the value the line's own
// (the line is kept). NULL, *n 0: none
const sc_pair *world_info(const op_value *map, size_t *n);

// a compute made by a harness's watch: its runs counted by the harness, its results kept. A
// harness makes the compute with world_make: def.data is a struct of its own that starts with a
// world_watch. world_set and world_equal go in its sc_def, as world_drop in the scheduler's. The
// harness frees the struct, after world_finish
typedef struct {
	char *name;
	unsigned runs;
	op_value *value;
} world_watch;
char *world_set(void *value, void *data);
bool world_equal(const void *a, const void *b, void *data);
void world_drop(void *value, void *data);
// def made a compute (an effect) with the scope named open, and named. NULL, or an error
char *world_make(world_watch *w, const char *name, const char *scope, sc_def def, bool effect);

op_value *world_error(const char *why);
// the same, then why freed
op_value *world_error_take(char *why);

// the parts of a request
tb_key world_key(const op_value *j);
// a part: the name given; not a string: "value"
const char *world_part(const op_value *j);
// the names of an address, a list of strings: borrowed from it, freed by the caller
const char **world_address(const op_value *list, size_t *n);
// a path's keys, from a list of strings and whole numbers: borrowed from it
op_key *world_path(const op_value *list, size_t *n);
// the ids of a list of members as strings
op_value *world_ids(const pl_members *list);

// a header, summed up: { actor?, reader?, metadata?, timely, sites }
// a status (status.h) as the requests tell it: "pending", { error: message }, or null
op_value *world_status_json(const op_value *status);
op_value *world_summary(const ch_header *header);

// where a spot reads, as JSON: { part, id, path } (path null: the change spot). New
op_value *world_where(const pl_where *where);
// the reads of the computation's latest ended run, in order, as pl_spot named each as the run
// ended: where, or null for a key not one of places' spots. NULL: no run of it ended. Borrowed
const op_value *world_reads(const sc_computer *c);

// a value write, with a scope open: the patches to the node there, then said written; none there:
// a node made with them, then added (a table event). 0, or op's code with *failed the patch; -1
// with *why. *node (may be NULL): the node. The patches are the line's, or kept by world_keep
int world_edit(const char *part, tb_key id, const op_value *patches, nd_entry **node,
	const char **why, size_t *failed);
// a write request ({edit, place, unplace, rename, move}), with a scope open. 0, or the
// code, *why its name, *failed the patch an edit was about. An error that is not a places code is -1
int world_write(const op_value *request, const char **why, size_t *failed);

// the programs' plain forms (typescript/world_harness.ts): cat, join, count, add, lt, if, do, quote,
// within, header. *handled: whether e is one of them. eval evaluates a sub-program (NULL: it ended
// early, and so does this). *error: set when this ends early on an error of its own (a string for
// the caller to free)
op_value *world_basic(const op_value *e, op_value *(*eval)(const op_value *e, void *ctx), void *ctx, bool *handled,
	char **error);

// a copy of the request with {"eval": e} anywhere in it replaced by e evaluated; NULL: e ended
op_value *world_fill(const op_value *x, op_value *(*eval)(const op_value *e, void *ctx), void *ctx);

#endif
