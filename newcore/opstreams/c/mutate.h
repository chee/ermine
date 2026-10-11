// Patches applied to one object of a node, as one change (newcore/opstreams/ts/mutate.ts, MUTATE.tex), in C.
// Same rules as mutate.ts, on notify/c's values (nt_value) and patches (nt_patch).
//
// Content: a value or info object's version content is an nt_value * (NULL: absent); bytes are
// leaves, a typed array a sequence spliced only with one of its own kind. A children list's
// content is an nd_list (nodes/c's model, as places/c reads it): for the patches it is seen as an
// nt_value list, an id a string and a symbol a leaf no patch can make (null, as one compares).
// A list starts as []; one left with nothing removes the first version; the content stays a list
// (else wrong-kind), and each item an id or a symbol it held (else wrong-kind: mutate.ts takes
// anything). The new nd_list, its items and new ids are made with the alloc given; an item it
// kept keeps its id or symbol pointer.
//
// Memory: nothing given is changed. What a patch touches is new (made with notify/c's
// constructors), the rest is shared with the content before and with the patches' values. A copy
// made here may change in place across the patches of one call, since only the end is seen. The
// new versions array is made with the alloc given, and becomes the node's object; the old array
// is left as it was, for its holders.
// Ownership (values and info): each version content in the new array holds one reference
// (nt_ref) of its own on everything of the old content or of the patches it shares. So a caller
// may nt_free the old object's contents and the patches' values, and the new stays whole; it
// nt_frees the new contents when it lets the new array go. A caller that never frees: as before.
// A failed call takes no reference.
//
// Positions in strings count code points today (as mutate.ts and notify/c); the unit may change,
// so position -> byte offset is one function in mutate.c.
#ifndef MUTATE_H
#define MUTATE_H

#include <stddef.h>

#include "../../nodes/c/node.h"
#include "../../notify/c/notify.h"

enum {
	MU_OK = 0,
	MU_NOT_A_PATCH,
	MU_NO_KEY,
	MU_RANGE,
	MU_WRONG_KIND,
	MU_INTO_ITSELF,
};
// "not-a-patch", "no-key", "range", "wrong-kind", "into-itself"; "ok"
const char *mu_code_name(int code);

// which object: the value, an info object by name, or a name's children list
typedef enum { MU_VALUE, MU_INFO, MU_CHILDREN } mu_which_kind;
typedef struct {
	mu_which_kind kind;
	const char *name; // MU_INFO and MU_CHILDREN only
} mu_which;

// what notify reads of the content before a patch (notify.ts Fact, Facts):
// place: the patch's place as it is when the patch lands (a move's: with what left already gone).
//   ranged: the sequence at the path; unranged: its parent, had = its last key was there; at []
//   unranged: list 0, length 0, had = the object was there
// from: a move's from-place, the same way. size: a ranged move only, how many places what moved fills
typedef nt_fact mu_fact;
typedef nt_facts mu_facts;

// told of each patch once the change is in, in order, with its facts, the node's id and which
typedef struct {
	void (*fn)(void *ctx, const nt_patch *patch, const mu_facts *facts, const char *node,
		mu_which which);
	void *ctx;
} mu_patched;

typedef struct {
	void *(*alloc)(void *ctx, size_t size); // never NULL; never freed here
	void *ctx;
} mu_alloc;

// the patches, in order, to the object's first version, as one change: change is the caller's,
// kept in the new first version (its because kept as it was). none there: a put at [] makes it;
// any other patch: no-key (a children list: starts as []). a removal at [] removes the first
// version; none left: the object gone (value: length 0; info, children: the name removed). invalid: a code, *failed the patch's place, and
// nothing changes, patched never told. patched may be NULL
int mu_mutate(nd_node *node, mu_which which, const nt_patch *patches, size_t n, const void *change,
	const mu_alloc *alloc, const mu_patched *patched, size_t *failed);

#endif
