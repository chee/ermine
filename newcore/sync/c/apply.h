// What an object holds after a blop, worked out from its chain (newcore/sync/APPLY.tex), in C.
// Same shape as apply.ts: a blop's side is its patches applied, as mu_mutate applies them to a
// first version, to its base's side. Sides are notify/c's values (nt_value).
//
// Memory: a side is kept for as long as its blop is taken in, and shares structure with the sides
// before it (mu_mutate frees nothing), so none is freed before the process ends.
// Values nt_value cannot hold (bytes, typed arrays, live values) in a patch: the patches do not apply.
#ifndef APPLY_H
#define APPLY_H

#include "chain.h"

#include "../../nodes/c/because.h"
#include "../../nodes/c/change.h"
#include "../../notify/c/notify.h"

// a blop's side, or NULL: not taken in, or emptied
const nt_value *apply_side(chains *c, const uint8_t name[32]);
// whether the blop's patches apply to its base's side; a chain_check
bool apply_check(void *context, chains *c, const Json *blop);

// one of an object's versions: its head's side, change and because. The change borrows the
// head's blop; the because borrows place and why, which are here: so the array is not moved.
// name and signer as 64 lowercase hex digits
typedef struct {
	int64_t lamport;
	char name[65];
} apply_place;
typedef struct {
	char signer[65];
} apply_why;
typedef struct {
	const nt_value *content;
	ch_change change;
	bc_because because;
	apply_place place;
	apply_why why;
} apply_version;

// the caller's time of a head, by its name as hex
typedef int64_t (*apply_time)(void *context, const char *name);

// an object's versions (object: "value" or ["info", name]...): its heads in the agreed order, each
// with a side. Count; *out the array, free it; none: NULL, 0
size_t apply_versions(chains *c, const Json *object, apply_time time, void *context,
	apply_version **out);

#endif
