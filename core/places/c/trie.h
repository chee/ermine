// The trie (typescript/trie.ts), in C: a tree of names, an entry per path made, each with its
// parent, its kids by name and a value that is the caller's. Names are any C strings (no NUL byte:
// TypeScript's may hold one); nothing is joined, so a name may hold "/" or be empty. Same rules as
// trie.ts, which the suite in conformance/trie/ holds both to.
//
// An entry is a pointer that stays the same while the entry is in the trie. Most entries have one
// kid, which is kept in the entry itself; a kids table is made on the second kid, and then holds
// them all. Kids come out in the order made, whatever the names are.
//
// DROPPED HANDLES. The trie frees what it drops or prunes (not the values: they are the caller's).
// A pointer to an entry that was dropped, or pruned, or was under one that was dropped, is dead:
// the caller may not read it, pass it to any call, or compare what it points to. It may compare the
// pointer itself, and forget it. To free values first, tr_each over the entry before dropping it.
// (trie.ts keeps a dropped handle walkable; C does not. The suite uses a dropped handle only for
// what both do: nothing.) The root is never freed but by tr_free: dropping it empties it.
#ifndef TRIE_H
#define TRIE_H

#include <stdbool.h>
#include <stddef.h>

typedef struct tr tr;
typedef struct tr_entry tr_entry;

struct tr_entry {
	tr_entry *parent; // NULL for the root. Read only
	void *value;      // the caller's; NULL: none. The caller's to set
	// the rest is the trie's own: do not read or write
	tr_entry *kid;          // the only kid, while there is one
	struct tr_kids *kids;   // made on the second kid; then it holds them all, and kid is NULL
	tr_entry *next, *prev;  // among its parent's kids, in the order made
	tr_entry *chain;        // in its parent's kids table, among the names that hash alike
	size_t hash;
	char name[];            // its name in its parent; the root's: "". Read only
};

// a trie with only the root; out of memory aborts, as everywhere in core
tr *tr_new(void);
// frees the trie and every entry in it, the root included; not the values
void tr_free(tr *t);
// the root: its name is "", and it has no parent
tr_entry *tr_root(const tr *t);

// the entry at path (n names) from `from` (NULL: the root); NULL when none is made
tr_entry *tr_at(const tr *t, const char *const *path, size_t n, tr_entry *from);
// the same, made where missing, along the way; n of 0 gives `from`
tr_entry *tr_make(tr *t, const char *const *path, size_t n, tr_entry *from);

// the names from the root to e, written to names (up to cap of them, pointing into the entries'
// own names, good while those entries are in the trie); gives the length of the whole path
size_t tr_path(const tr_entry *e, const char **names, size_t cap);

// calls f on e and every entry under it, e first, then each kid's in the order made (depth first);
// f returning true stops the walk, and tr_each returns true. f may read and set values, and may not
// make, drop or prune
bool tr_each(tr *t, tr_entry *e, bool (*f)(tr_entry *e, void *arg), void *arg);

// e and everything under it, out of the trie and freed; the root: its kids and its value
void tr_drop(tr *t, tr_entry *e);
// e, if it has no value and no kids, and then each parent the same way, up to the root (never freed)
void tr_prune(tr *t, tr_entry *e);

// the entries reachable from the root, counted (the root too): for tests and inspectors
size_t tr_size(const tr *t);

#endif
