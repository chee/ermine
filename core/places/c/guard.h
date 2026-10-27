// Guard (typescript/guard.ts), in C: the policy (core/protect/c/protect.h) asked before a read or a
// write, and after a list. It asks, and wraps nothing: whoever calls places asks first, or after
// for a list. Same rules as guard.ts, which the suite in core/places/conformance/guard/ holds
// both to.
//
// An ask: who is the scope open (pl_change_base: an op_value map built from its pairs), from where
// the asker is placed (a path) and the box it is in (its folder's id: why the id, guard.ts), the
// policy given. A read is asked through places, told: a run asking tracks what the policy read, so
// a change to the rules reruns it, refused or not. A write is asked of the table, told no one: a
// write makes no run depend on the rules. No policy: everything is allowed.
//
// ANSWERS. GD_OK; GD_REFUSED (a no: gd_refusal says what, why, which grant decided and which target); GD_PENDING (a policy waits for
// what it could not read); GD_FAILED (a read the policy told came back SC_STOP: the
// run must end, as pl_status says, and nothing the guard gave is to be used). A list keeps a
// refused member in its place: its id is the one gd_is_refused says.
//
// MEMORY. A guard keeps its policy, its places and its table as given, and a copy of the path it is
// placed at (names too) and of its box's id, for as long as it lives. Names and paths given are borrowed for
// the call. Out of memory aborts.
#ifndef GUARD_H
#define GUARD_H

#include <stddef.h>

#include "places.h"
#include "../../../core/protect/c/protect.h"

typedef enum { GD_OK, GD_REFUSED, GD_PENDING, GD_FAILED } gd_answer;

typedef struct {
	// what was asked, and why not: borrowed from the policy
	const char *op;
	const char *reason;
	// the grant that decided, when the policy said (protect's grants): grant.where NULL: none
	pr_grant grant;
	// which of the targets given was the one refused (its index; 0 for one, and for a move; a
	// place: 0 the slot, 1 the node)
	size_t target;
} gd_refusal;

// whether an id is what a refused member's is, in a list: a stand-in, refused if asked
int gd_is_refused(tb_key id);

// what is asked about: an id, and the path it was asked by when there was one (path NULL: none;
// an empty path is a non-NULL pointer with npath 0)
typedef struct {
	tb_key id;
	const char *const *path;
	size_t npath;
} gd_thing;

// the node a thing is, at part (NULL: none) and field (an op_value list of steps, NULL: the whole
// node): a path only when the thing has one
typedef struct {
	gd_thing thing;
	const char *part;
	const op_value *field;
} gd_target;
gd_target gd_target_of(gd_thing thing, const char *part, const op_value *field);
// a name in a parent's children: what a write to it changes. *field is the list of the name, new:
// the caller's to op_free
gd_target gd_slot(gd_thing parent, const char *name, op_value **field);

typedef struct {
	pl *places;
	tb_table *table;
	// NULL: everything is allowed. Not freed
	const pr_policy *may;
	// where the asker is placed: a path; NULL: at none (the host)
	const char *const *from;
	size_t nfrom;
	// while an action's call is open, the caller: every ask is made again from its place and its
	// box, both to allow (the first no wins; else a pending; else the first answer). Returns 0: no
	// call open; else 1, and *from, *nfrom its place (*from NULL: the host, at no place), *box its
	// box's folder's id (none: left as it is given, all NULL). The path and the id are borrowed,
	// good till the next ask. NULL: none, as today
	int (*caller)(void *ctx, const char *const **from, size_t *nfrom, tb_key *box);
	void *caller_ctx;
	// the box the asker is in: its folder's id (a string; NULL: not said). every ask's from.box
	tb_key box;
} gd_setup;

typedef struct gd gd;
gd *gd_new(const gd_setup *setup);
void gd_free(gd *g);

// every target asked: the first no is GD_REFUSED (*why filled), else any pending is GD_PENDING
gd_answer gd_read(gd *g, const gd_target *targets, size_t n, gd_refusal *why);
gd_answer gd_write(gd *g, const char *op, const gd_target *targets, size_t n, gd_refusal *why);

// a node given a name: "place" asked of the slot with the node beside it (where it goes, what it
// is, together), then each of ops of the node itself, the asker holding all a name there could
// hand out (protected_hardlinks: read and edit). Both asked as a write's, told no one. The first
// no is GD_REFUSED (*why filled, target 0 the slot, 1 the node), else any pending is GD_PENDING
gd_answer gd_place(gd *g, const gd_target *slot, const gd_target *node, const char *const *ops,
	size_t nops, gd_refusal *why);

// a move by path, refused (GD_REFUSED, *why op "move", reason "into-itself") when to is strictly
// under from: the node would be cut off, its own descendant its parent. The same place is no move.
// Needs no guard, no policy: structural
gd_answer gd_move(const char *const *from, size_t nfrom, const char *const *to, size_t nto,
	gd_refusal *why);

// the members of a list, each asked to be read (at: the path they are under, NULL: none): a
// refused one in its place, its name and from kept and its id one gd_is_refused says. Any pending:
// GD_PENDING. *out is the caller's, pl_members_free; the names are the list's
gd_answer gd_members(gd *g, const pl_members *list, const char *const *at, size_t nat,
	pl_members *out);

#endif
