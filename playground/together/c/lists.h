// What each path of a node holds, from the commits a device holds (playground/together/typescript/
// lists.ts, its header the rules), in C. A path is the table, then map keys: a key path ends at the
// first list. Everything here is the lists' own (the commits decoded again, the values held), until
// ls_free; the kept are the history's. Out of memory aborts
#ifndef LS_LISTS_H
#define LS_LISTS_H

#include "history.h"
#include "replay.h"

#include <stdbool.h>
#include <stddef.h>

typedef struct ls_lists ls_lists;

// a write: a patch, at its key path (the table, then keys)
typedef struct {
	const hy_kept *kept;
	const cm_commit *commit;
	const char **path;
	size_t length;
	// a set's value (held); whole: the commit's tables at path, once asked
	op_value *value;
	bool has_value, gone, whole, asked;
	// what it names (NULL: absent)
	const cm_replaces *replaces;
	// marked inside, as last looked (ls_items, ls_opens say so)
	bool inside;
} ls_write;

// an item of a path: a standing write there, or (at) a shallow one's value at it. value borrowed
// from the lists (NULL with gone)
typedef struct {
	const ls_write *write;
	const op_value *value;
	bool gone, inside;
	const char *const *at;
	size_t at_length;
} ls_item;

// a commit's tables, its own patches on what they are over (rp_written's), for a whole write's value:
// fills *out (rp_init'd, empty) or leaves it
typedef void (*ls_after)(void *context, const hy_kept *kept, rp_tables *out);

ls_lists *ls_create(const hy_history *h, ls_after after, void *context);
void ls_free(ls_lists *l);
// a commit, its parents added already
void ls_add(ls_lists *l, const hy_kept *kept);
// how many commits added
size_t ls_size(const ls_lists *l);
// the items at path, first shown first: *out malloc'd (free it); none: 0
size_t ls_items(ls_lists *l, const char *const *path, size_t n, ls_item **out);
// the standing writes at path and under it, each path's first shown first: groups, each malloc'd
typedef struct {
	const ls_write **writes;
	size_t length;
} ls_group;
size_t ls_standing(ls_lists *l, const char *const *path, size_t n, ls_group **out);
void ls_groups_free(ls_group *groups, size_t n);
// every open path, with its items, shallow first
typedef struct {
	const char **path;
	size_t length;
	ls_item *items;
	size_t count;
} ls_open;
size_t ls_opens(ls_lists *l, ls_open **out);
void ls_opens_free(ls_open *opens, size_t n);
// the node: each table's first items composed, into *out (rp_init'd here); choose (may be NULL): its
// writes first wherever it has one, and nothing it does not own under them
void ls_compose(ls_lists *l, const hy_kept *choose, rp_tables *out);

// a node's tables from the commits given and their ancestors: the lists of those, composed, into
// *out (rp_init'd here)
void ls_state(const hy_history *h, const hy_kept *const *heads, size_t n, ls_after after, void *context,
	rp_tables *out);

// patches applied as sync takes them: a key patch's missing parents made as maps; one under a value
// that is not a map left out (a clash, which the lists keep); a delete of what is not there, left
// out; the rest as op_apply has them (in_place as its option). value borrowed, *out a hold of its
// own; a code and *failed (may be NULL) as op_apply's
int ls_applies(const op_value *value, const op_patch *patches, size_t n, int in_place, op_value **out,
	size_t *failed);
// a patch with a range, a move or a key not a string: a write of the whole value at its key path
bool ls_whole(const op_patch *p);
// the key path a patch's path makes: how many keys, up to the first not a string
size_t ls_keyed(const op_patch *p);
// the value at keys, or NULL
const op_value *ls_dig(const op_value *v, const char *const *keys, size_t n);

#endif
