// The world the places and guard harnesses share. Protocol: typescript/world_harness.ts.
// Lines are retained until world_finish because programs and patches refer into them. Results
// are borrowed unless marked New. world_make: NULL or an error the caller frees.
#ifndef PLACES_WORLD_HARNESS_H
#define PLACES_WORLD_HARNESS_H

#include <stdbool.h>
#include <stddef.h>

#include "../../conformance/c/harness.h"
#include "places.h"

extern sc_scheduler *world_scheduler;
extern tb_table *world_table;
extern pt_paths *world_paths;
extern pl *world_places;
extern sc_scope *world_host;

void world_contribute(const pl_contributor *const *list, size_t n);

void world_event(tb_event event, void *ctx);

void world_line(const op_value *request, FILE *out, op_value *(*answer)(const op_value *request));
void world_finish(void);

void world_keep(op_value *value);
void world_keep_node(nd_entry *node);

void *world_alloc(size_t size);
char *world_copy(const char *text);
char *world_format(const char *format, ...) __attribute__((format(printf, 1, 2)));

const char *world_text(const op_value *v);
bool world_is(const op_value *v, op_type type);
bool world_whole(const op_value *v, int64_t *out);
op_value *world_snap(const op_value *v);
op_value *world_patches(const op_patch *patches, size_t n);

char *world_name(sc_scope *o, const char *name);
sc_scope *world_scope(const char *name);

const char *world_hosted(void (*f)(void *data), void *data);

const sc_pair *world_info(const op_value *map, size_t *n);

typedef struct {
	char *name;
	unsigned runs;
	op_value *value;
} world_watch;
char *world_set(void *value, void *data);
bool world_equal(const void *a, const void *b, void *data);
void world_drop(void *value, void *data);
char *world_make(world_watch *w, const char *name, const char *scope, sc_def def, bool effect);

op_value *world_error(const char *why);
op_value *world_error_take(char *why);

tb_key world_key(const op_value *j);
const char *world_part(const op_value *j);
const char **world_address(const op_value *list, size_t *n);
op_key *world_path(const op_value *list, size_t *n);
op_value *world_ids(const pl_members *list);

op_value *world_show(const ch_frame *frame);
op_value *world_show_infos(const op_value *infos);
op_value *world_summary(const ch_header *header);

op_value *world_where(const pl_where *where);
const op_value *world_reads(const sc_computer *c);

int world_edit(const char *part, tb_key id, const op_value *patches, nd_entry **node,
	const char **why, size_t *failed);
int world_write(const op_value *request, const char **why, size_t *failed);

op_value *world_basic(const op_value *e, op_value *(*eval)(const op_value *e, void *ctx), void *ctx, bool *handled,
	char **error);

op_value *world_fill(const op_value *x, op_value *(*eval)(const op_value *e, void *ctx), void *ctx);

#endif
