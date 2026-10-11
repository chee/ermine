// Finding items by path, and placing ids in lists (newcore/graph/places.ts, PLACES.tex), in C. Same
// rules as places.ts. Nothing kept between calls, nothing tracked: each read is said to depend.
// Writing by path is not here: it needs a mutate.
#ifndef PLACES_H
#define PLACES_H

#include <stddef.h>
#include <stdint.h>

#include "../../../c/node.h"

// what a read rests on: an id being loaded, its value, one of its info objects (name), or its
// lists: PL_CHILDREN with no name is which names it has, with one the list of that name
typedef enum { PL_LOADED, PL_VALUE, PL_INFO, PL_CHILDREN } pl_kind;
typedef struct {
	pl_kind kind;
	const char *name; // NULL unless PL_INFO, or PL_CHILDREN of one list
} pl_part;

// told, in order, each part a read rests on
typedef struct {
	void (*fn)(void *ctx, const char *id, pl_part part);
	void *ctx;
} pl_depend;

// why an item was given: the node whose list it was, the name, the id taken, its position
typedef struct {
	const char *node;
	const char *name;
	const char *id;
	size_t at;
} pl_step;

// node: NULL if not loaded, pending. route: a step per name of the address; a lookup's, the
// step to its list. has_up, up: a lookup's, how many nodes above the place's . its list was.
// has_versions: content and info give every version of the object (none: length 0), for a
// loaded item
typedef struct {
	const char *id;
	const pl_step *route;
	size_t nroute;
	const nd_node *node;
	int has_up;
	long up;
	int has_versions;
	const nd_version *versions;
	size_t nversions;
} pl_item;

typedef struct {
	const pl_item *items;
	size_t n;
} pl_items;

typedef struct {
	const char *const *names;
	size_t n;
} pl_namelist;

// a place: names from the root, and the trail cd made (the ids its walk took, the root first),
// if has_trail. a "here" is a spot with a trail; reads at it walk from the trail
typedef struct {
	const char *const *names;
	size_t nnames;
	int has_trail;
	const char *const *trail;
	size_t ntrail;
} pl_spot;

// one, or from up to not including to. an index given as one number a is {a, a}; a slotindex
// given as one number s is {s, s + 1}
typedef struct {
	long from, to;
} pl_span;

enum {
	PL_OK = 0,
	PL_WRONG_FIELD,
	PL_ABOVE_ROOT,
	PL_NOTHING_THERE,
	PL_ALREADY_THERE,
	PL_RANGE,
	PL_NO_BY // placing, with no by
};
// "wrong-field", "above-root", "nothing-there", "already-there", "range"; "no-by"
const char *pl_code_name(int code);

// the world a read is in. get: the node of an id, or NULL if it is not loaded; placing changes
// the nodes it gives, in place. alloc: memory for results and for what placing makes, never
// returns NULL, never freed by the library: an arena. by: the change for a node, asked for each
// change placing makes (an opaque pointer, kept in the versions it makes); NULL: placing is
// no_by. Names and ids given to placing are kept, not copied. fallback: the depend of a read
// given none, or NULL
typedef struct {
	nd_node *(*get)(void *ctx, const char *id);
	void *(*alloc)(void *ctx, size_t size);
	const void *(*by)(void *ctx, const char *node);
	void *ctx;
	const char *root;
	const pl_depend *fallback;
} pl_places;

// reads. a code, PL_OK with the result set. address: an optional "/", any number of "..",
// then names. depend NULL: the fallback
int pl_look(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const pl_depend *depend, pl_items *out);
// the nearest path of names whose last list holds a loaded node, and every such path's list
int pl_lookup(const pl_places *p, const pl_spot *at, const char *const *path, size_t npath,
	const pl_depend *depend, pl_items *out);
int pl_lookups(const pl_places *p, const pl_spot *at, const char *const *path, size_t npath,
	const pl_depend *depend, pl_items *out);
// that list's ids in each loaded node the address selects, node by node
int pl_children(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const char *name, const pl_depend *depend, pl_items *out);
// every name they have, once, first seen first
int pl_names(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const pl_depend *depend, pl_namelist *out);
// look, with the versions of the value, or of the info object of name
int pl_content(const pl_places *p, const pl_spot *at, const char *const *address,
	size_t naddress, const pl_depend *depend, pl_items *out);
int pl_info(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const char *name, const pl_depend *depend, pl_items *out);
// a trail: the address walked once, from at (a spot without a trail starts from the root)
int pl_cd(const pl_places *p, const pl_spot *at, const char *const *address, size_t naddress,
	const pl_depend *depend, pl_spot *out);

// placing. changes: one or two, in order. the first version of a list is the one placing
// reads, as places.ts does
// child put in id's list of name, at index (NULL: the end; a span: the ids there replaced), in
// the version slotindex (NULL: 0; a span: those versions replaced by the one made)
int pl_insert(const pl_places *p, const char *id, const char *name, const char *child,
	const pl_span *index, const pl_span *slotindex, const void **change);
// the ids at index (one number a is {a, a + 1}; from < to) out of the version slotindex (NULL: 0;
// a span merges as insert's does). a list left empty is gone
int pl_remove(const pl_places *p, const char *id, const char *name, pl_span index,
	const pl_span *slotindex, const void **change);
// the versions slotindex of id's list of name dropped whole
int pl_pop(const pl_places *p, const char *id, const char *name, pl_span slotindex,
	const void **change);
// a list to a new name; its entry keeps its slot. two changes
int pl_rename(const pl_places *p, const char *id, const char *name, const char *to,
	const void *changes[2]);
// the entry at index of id's list of name to toid's list of toname, at toindex (NULL: the
// end; counted after it left). one list: one change, else two; nchanges says
int pl_move(const pl_places *p, const char *id, const char *name, long index, const char *toid,
	const char *toname, const long *toindex, const void *changes[2], size_t *nchanges);

#endif
