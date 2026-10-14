// Guard (typescript/guard.ts), in C: the policy (core/protect/c/protect.h) asked before a read or a
// write, and after a list. It asks, and wraps nothing: whoever calls places or link asks first, or
// after for a list. Same rules as guard.ts, which the suite in ermine/link/conformance/guard/ holds both to.
//
// An ask: who is the scope open (lk_who: an op_value map built from its pairs), from where the asker
// is placed, the policy given. A read is asked through link, told: a run asking tracks what the
// policy read, so a change to the rules reruns it, refused or not. A write is asked of the store,
// told no one: a write makes no run depend on the rules. No policy: everything is allowed.
//
// ANSWERS. GD_OK; GD_REFUSED (a no: gd_refusal says what and why); GD_PENDING (a policy waits for
// what it could not read); GD_FAILED (a read the policy told came back SC_STOP or SC_CLOSED: the
// run must end, as lk_status says, and nothing the guard gave is to be used). A list keeps a refused
// item in its place, flagged: its source and id are none of the asker's to read.
//
// MEMORY. A guard keeps its policy, its link and its store as given, and the item it is placed at,
// for as long as it lives. Out of memory aborts.
#ifndef GUARD_H
#define GUARD_H

#include <stddef.h>

#include "link.h"
#include "../../../core/protect/c/protect.h"

typedef enum { GD_OK, GD_REFUSED, GD_PENDING, GD_FAILED } gd_answer;

typedef struct {
	// what was asked, and why not: borrowed from the policy
	const char *op;
	const char *reason;
} gd_refusal;

// an item of a list, and whether the guard refused it
typedef struct {
	const pl_item *item;
	int refused;
} gd_item;

// a node asked about, with as much as the asker knows: an item (how it was reached: its path and
// route) or an entry (by id alone); part (NULL: none), field (an op_value list of steps, NULL: the
// whole node). A refused item is refused, never asked
typedef struct {
	gd_item item;
	tb_key source, id;
	const char *part;
	const op_value *field;
} gd_target;
gd_target gd_item_target(gd_item item, const char *part, const op_value *field);
gd_target gd_entry_target(tb_key source, tb_key id, const char *part, const op_value *field);

typedef struct {
	lk *link;
	st_store *store;
	// NULL: everything is allowed. Not freed
	const pr_policy *may;
	// where the asker is placed: an item or an entry; NULL: at none (the host)
	const pl_at *from;
} gd_setup;

typedef struct gd gd;
gd *gd_new(const gd_setup *setup);
void gd_free(gd *g);

// every target asked: the first no is GD_REFUSED (*why filled), else any pending is GD_PENDING
gd_answer gd_read(gd *g, const gd_target *targets, size_t n, gd_refusal *why);
gd_answer gd_write(gd *g, const char *op, const gd_target *targets, size_t n, gd_refusal *why);

// the items of a list, each asked to be read: a refused one flagged in its place, its name and index
// kept. Any pending: GD_PENDING. *out is the caller's, gd_list_free; the items are the list's
typedef struct {
	size_t n;
	gd_item *items;
} gd_list;
gd_answer gd_items(gd *g, const pl_list *list, gd_list *out);
void gd_list_free(gd_list *list);

#endif
