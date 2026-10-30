// Tracked paths in C, the counterpart of reactivity/typescript/paths.ts: which reads a patch
// reaches. Out of memory aborts. A spot is a read of a path (deep) in the value at a key; spots
// are shared by everyone reading the same path, in a trie per key. Call pt_release once no reader
// holds a spot.
#ifndef PATHS_H
#define PATHS_H

#include <stddef.h>
#include <stdint.h>

#include "../../changeable/c/apply.h"

// A source or an id: a string (compared by content, copied) or a symbol (the caller's token,
// compared by address; symbol is non-NULL and string is not read).
typedef struct {
	const char *string;
	const void *symbol;
} pt_key;

static inline pt_key pt_string(const char *s) { return (pt_key){.string = s}; }
static inline pt_key pt_symbol(const void *token) { return (pt_key){.symbol = token}; }

typedef struct pt_paths pt_paths;
typedef struct pt_step pt_step;
typedef struct pt_root pt_root;

// source, id and path are copied and held here. The change spot reads the change itself (time,
// actor, metadata) and has no path. owner belongs to the caller and is never read here.
typedef struct {
	pt_key source, id;
	const op_key *path;
	size_t length;
	int change;
	// A read of the keys at path only.
	int keys;
	// A read of what is at path itself, not what is in it.
	int here;
	void *owner;
	// The mark call that last gave it, so a call gives it once.
	uint64_t seen;
	// Where it is held: its step, or only its key's root for the change spot.
	pt_step *step;
	pt_root *root;
} pt_spot;

pt_paths *pt_new(void);
// Frees p and every spot.
void pt_free(pt_paths *p);

// What a spot reads: everything under path, the keys at path, or what is at path itself.
enum { PT_ALL = 0, PT_KEYS = 1, PT_HERE = 2 };

// The spot for a read of path at (source, id), made or found. path has number and string keys
// only. keys is PT_ALL, PT_KEYS (the keys at path) or PT_HERE (what is at path itself); each is a
// separate spot.
pt_spot *pt_spot_of(pt_paths *p, pt_key source, pt_key id, const op_key *path, size_t length,
	int keys);
// The change spot at (source, id), made or found.
pt_spot *pt_change_of(pt_paths *p, pt_key source, pt_key id);

// The spots marked by one update's patches at (source, id), each once and the change spot too.
// *length is their number. They stay valid until the next pt_mark or pt_event.
pt_spot *const *pt_mark(pt_paths *p, pt_key source, pt_key id, const op_patch *patches, size_t n,
	size_t *length);
// A whole-node event at (source, id), such as the table adding, replacing or removing the node:
// every spot of that key, as a patch at [] would.
pt_spot *const *pt_event(pt_paths *p, pt_key source, pt_key id, size_t *length);

// Lets a spot go and frees it, along with steps and keys left empty. Never use s afterwards.
void pt_release(pt_paths *p, pt_spot *s);

// Whether the patch marks a read of path (see paths.ts for the rule). keys selects a plain, keys
// (PT_KEYS) or here (PT_HERE) read.
int pt_marks(const op_patch *patch, const op_key *path, size_t length, int keys);

// What is held: keys with a spot, spots, and trie steps (every prefix of a held spot's path).
typedef struct {
	size_t keys, spots, steps;
} pt_held;
pt_held pt_held_of(const pt_paths *p);

#endif
