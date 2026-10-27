// Tracked paths (core/scheduler/typescript/paths.ts), in C: which reads a patch reaches. Same rule
// and shape as paths.ts; the patches are op's (core/op/c/apply.h). Out of memory aborts: nothing
// here returns it.
//
// A spot is (source, id, path): a read of path, deep, in the value at that key. A keys spot reads
// which keys there are at path, not what is under them (see pt_marks). Spots are held by
// address, shared by everyone who reads the same path, in a trie per key; a list's number kids
// are also held in order, so a range finds those from its start with one binary search.
// Pruning: pt_release lets a spot go; the wiring calls it once no reader holds the spot (its
// tracker node, in owner, has no readers: first == NULL), after untrack, or when pt_mark gives a
// spot no one reads.
#ifndef PATHS_H
#define PATHS_H

#include <stddef.h>
#include <stdint.h>

#include "../../op/c/apply.h"

// a source or an id: a string (equal by content; copied), or a symbol (symbol non-NULL: the
// string is not read; the caller's token, equal by address)
typedef struct {
	const char *string;
	const void *symbol;
} pt_key;

static inline pt_key pt_string(const char *s) { return (pt_key){.string = s}; }
static inline pt_key pt_symbol(const void *token) { return (pt_key){.symbol = token}; }

typedef struct pt_paths pt_paths;
typedef struct pt_step pt_step;
typedef struct pt_root pt_root;

// source, id: the key's, held here. path: its keys (numbers and strings), held here.
// change: the change spot, reads of the change itself (time, actor, metadata); no path.
// owner: the caller's, never read here
typedef struct {
	pt_key source, id;
	const op_key *path;
	size_t length;
	int change;
	// a read of the keys at path only
	int keys;
	void *owner;
	// the mark call that last gave it, so a call gives it once
	uint64_t seen;
	// where it is held: its step, or only its key's root for the change spot
	pt_step *step;
	pt_root *root;
} pt_spot;

pt_paths *pt_new(void);
// frees it and every spot
void pt_free(pt_paths *p);

// the spot of a read of path at (source, id): made or found. path: number and string keys only.
// keys: the spot of a read of the keys at path (a separate spot from the plain one)
pt_spot *pt_spot_of(pt_paths *p, pt_key source, pt_key id, const op_key *path, size_t length,
	int keys);
// the change spot at (source, id): made or found
pt_spot *pt_change_of(pt_paths *p, pt_key source, pt_key id);

// the spots one update's patches at (source, id) mark, each once, the change spot with them;
// *length of them, live until the next pt_mark or pt_event
pt_spot *const *pt_mark(pt_paths *p, pt_key source, pt_key id, const op_patch *patches, size_t n,
	size_t *length);
// a whole-node event at (source, id) (the table adding, replacing or removing the node): every
// spot of that key, as a patch at [] would
pt_spot *const *pt_event(pt_paths *p, pt_key source, pt_key id, size_t *length);

// lets a spot go and frees it, with the steps left empty above it, then its key when nothing is
// left: never use s again
void pt_release(pt_paths *p, pt_spot *s);

// whether the patch marks a read of path: the rule, as a function. keys: a keys read of path,
// reached where a read of path would be (a place at it or above it), and below it only by a place
// exactly one step down and unranged (a key set, removed, taken or landed); deeper, or ranged into
// a key's value, it is not
int pt_marks(const op_patch *patch, const op_key *path, size_t length, int keys);

// what is held: keys with a spot, spots, trie steps (a held key's [] and every other prefix of a
// held spot's path)
typedef struct {
	size_t keys, spots, steps;
} pt_held;
pt_held pt_held_of(const pt_paths *p);

#endif
