// What an object holds after a blop, worked out from its history (newcore/sync/APPLY.tex), in C.
// Same shape as apply.ts: a blop's side is its patches applied, as mu_mutate applies them to a
// first version, to its base's side. Sides are notify/c's values (nt_value).
//
// Memory: a side is kept for as long as its blop is taken in, and shares structure with the sides
// before it by reference (nt_ref; mutate.h has the ownership rule), so each is let go of alone.
// A side is held by the histories it is kept in: history_release(c, apply_release) makes history_free
// let them all go. What apply_side and apply_versions give back is borrowed from there.
// Bytes and typed arrays in a patch are carried as they are. A live value in a patch is held
// nowhere here: the patches do not apply.
#ifndef APPLY_H
#define APPLY_H

#include "history.h"

#include "../../nodes/c/because.h"
#include "../../nodes/c/change.h"
#include "../../notify/c/notify.h"

// a blop's side, or NULL: not taken in, or emptied
const nt_value *apply_side(histories *c, const uint8_t name[32]);
// a slot apply_side set in the histories (history_release): lets the side go
void apply_release(void *slot);
// whether the blop's patches apply to its base's side; a history_check
bool apply_check(void *context, histories *c, const Json *blop);

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
	const nt_value *content; // NULL: a removal among other heads, no content
	ch_change change;
	bc_because because;
	apply_place place;
	apply_why why;
} apply_version;

// the caller's time of a head, by its name as hex
typedef int64_t (*apply_time)(void *context, const char *name);

// an object's versions (object: "value" or ["info", name]...): its heads in the agreed order, one
// per head (a removal as the only head: none). Count; *out the array, free it; none: NULL, 0
size_t apply_versions(histories *c, const Json *object, apply_time time, void *context,
	apply_version **out);

#endif
