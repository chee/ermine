// The guard asks the protect policy before a read or a write, and after a list. GD_FAILED means a
// told read ended the run and nothing given may be used. Names and paths passed in are borrowed
// for the call. Out of memory aborts.
#ifndef GUARD_H
#define GUARD_H

#include <stddef.h>

#include "../../places/c/places.h"
#include "../../protect/c/protect.h"

typedef enum { GD_OK, GD_REFUSED, GD_PENDING, GD_FAILED } gd_answer;

typedef struct {
	const char *op;
	const char *reason;
	pr_grant grant;
	size_t target;
} gd_refusal;

int gd_is_refused(tb_key id);

typedef struct {
	tb_key id;
	const char *const *path;
	size_t npath;
} gd_thing;

typedef struct {
	gd_thing thing;
	const char *part;
	const op_value *field;
} gd_target;
gd_target gd_target_of(gd_thing thing, const char *part, const op_value *field);
// A name in a parent's children. *field becomes the list of the name; the caller op_frees it.
gd_target gd_slot(gd_thing parent, const char *name, op_value **field);

typedef struct {
	pl *places;
	tb_table *table;
	const pr_policy *may;
	const char *const *from;
	size_t nfrom;
	// Returns 0 when no call is open, else 1 with *from, *nfrom and *box set (borrowed until the next ask).
	int (*caller)(void *ctx, const char *const **from, size_t *nfrom, tb_key *box);
	void *caller_ctx;
	tb_key box;
} gd_setup;

typedef struct gd gd;
gd *gd_new(const gd_setup *setup);
void gd_free(gd *g);

gd_answer gd_read(gd *g, const gd_target *targets, size_t n, gd_refusal *why);
gd_answer gd_write(gd *g, const char *op, const gd_target *targets, size_t n, gd_refusal *why);

// Asks "place" of the slot with the node beside it, then each of ops of the node itself.
gd_answer gd_place(gd *g, const gd_target *slot, const gd_target *node, const char *const *ops,
	size_t nops, gd_refusal *why);

gd_answer gd_move(const char *const *from, size_t nfrom, const char *const *to, size_t nto,
	gd_refusal *why);

// Asks to read each member of a list. The caller frees *out with pl_members_free; names belong to the list.
gd_answer gd_members(gd *g, const pl_members *list, const char *const *at, size_t nat,
	pl_members *out);

#endif
