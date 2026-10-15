// What an object holds after a blop, worked out from its history (APPLY.tex), in C.
// Same shape as apply.ts: a blop's side is its patches applied, as op_apply applies them to a
// first version, to its base's side. Sides are op's values (op_value, core/op/c/value.h).
//
// Memory: a side is kept while its blop is a head (APPLY.tex), and shares structure with the sides
// before it by reference (op_ref; op/c/apply.h has the ownership rule), so each is let go of alone.
// Another asked for is made again from the nearest side kept, and kept till the next history_trim.
// A side is held in its blop's slot: history_release(c, apply_release) makes history_trim let go
// of those no longer heads', and history_free of all. What apply_side and apply_versions give back
// is borrowed from there: good till the next trim.
// Bytes and typed arrays in a patch are carried as they are. A live value in a patch is held
// nowhere here: the patches do not apply.
#ifndef APPLY_H
#define APPLY_H

#include "history.h"

#include "../../../core/node/c/node.h"
#include "../../../core/op/c/apply.h"
#include "../../../core/op/c/value.h"

// a blop's side, or NULL: not taken in, or emptied
const op_value *apply_side(histories *c, const uint8_t name[32]);
// a slot apply_side or apply_check set in the histories (history_release): lets the side go
void apply_release(void *slot);
// whether the blop's patches apply to its base's side; a history_check: the side in *slot
bool apply_check(void *context, histories *c, const Json *blop, void **slot);

// a blop's patches, a json.h list of {path, range?, value?, move?}, as op's; *out malloc'd, *count
// how many. false: a value op cannot hold. A path that is not one is a patch op refuses
// (not-a-patch). apply_patches_free lets go of them and of the values they hold
bool apply_patches(const Json *list, op_patch **out, size_t *count);
void apply_patches_free(op_patch *patches, size_t count);
// a json.h value as op's, new (op_free it); NULL for what op cannot hold
op_value *apply_value(const Json *j);
// an op value as json.h's, new (jsonFree it)
Json *apply_json(const op_value *v);

// one of an object's versions: its head's side, change header and what sync adds (the because).
// The header borrows: the head's blop (actor, reader), and the pieces here, so the array is not
// moved. Its external holds the blop's site, when it has one; its metadata the blop's cause (a
// const Json *), wallclock (a const int64_t *) and message (a const char *), under those names, in
// that order, when it has them. There is no Because in core: lamport, name and signer are sync's own
// (name and signer as 64 lowercase hex digits)
typedef struct {
	const op_value *content; // NULL: a removal among other heads, no content
	ch_header change;
	const char *layer; // "sync"
	int64_t lamport;
	char name[65];
	char signer[65];
	ch_site site;
	ch_entry entries[3];
	int64_t wallclock;
} apply_version;

// the caller's time of a head, by its name as hex
typedef int64_t (*apply_time)(void *context, const char *name);

// an object's versions (object: "value" or ["info", name]...): its heads in the agreed order, one
// per head (a removal as the only head: none). Count; *out the array, free it; none: NULL, 0
size_t apply_versions(histories *c, const Json *object, apply_time time, void *context,
	apply_version **out);

#endif
