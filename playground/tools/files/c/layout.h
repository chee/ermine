// The layout (FILES.tex, The layout), in C. Same functions as layout.ts: from the graph as the records give it, where
// each node is shown, under what names, and the plan that takes the folder from the old layout to the new. Pure but for
// the probe, which says what names are taken on disk, and ino, which gives a folder's file id: both are given in.
// Strings are json.h's (UTF-8, NUL-terminated). Everything a function returns, and every map, list and record it builds,
// is held until layout_release, which frees all of it at once; so is what the caller builds with the helpers below.
#ifndef LAYOUT_H
#define LAYOUT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// an ordered map by string key, as a JS Map is: iterate entries 0..count, skipping the ones not live; setting a key
// already there keeps its place, deleting and setting again puts it last. Values are the caller's pointers.
typedef struct {
	const char *key;
	void *value;
	int next;
	bool live;
} OmapEntry;
typedef struct {
	OmapEntry *entries;
	int count, capacity;
	int *buckets;
	int size, spread;
} Omap;

Omap *omap_new(void);
void *omap_get(const Omap *map, const char *key);
bool omap_has(const Omap *map, const char *key);
void omap_set(Omap *map, const char *key, void *value);
bool omap_delete(Omap *map, const char *key);
Omap *omap_copy(const Omap *map);

typedef struct {
	const char **items;
	int count, capacity;
} Strs;
Strs *strs_new(void);
void strs_push(Strs *list, const char *item);
/** zeroed memory, held until layout_release */
void *layout_grab(size_t size);
/** a string held until layout_release; takes a malloc'd one */
char *layout_own(char *text);
/** frees everything held */
void layout_release(void);

typedef struct {
	const char *name, *hash, *form;
} Item;
/** a node's info as shown: each name with its first version's kept value */
typedef struct {
	Item *items;
	int count;
} Info;
typedef struct {
	const char *hash, *form;
	const uint8_t *head;
	size_t length;
} Side;
/** a node as the layout needs it; directory: slot name -> Strs of ids, none empty */
typedef struct {
	const char *hash, *form;
	const uint8_t *head;
	size_t length;
	Side *sides;
	int nsides;
	Info info;
	Omap *directory;
} Node;
/** nodes: id -> Node */
typedef struct {
	const char *root;
	Omap *nodes;
} Graph;

typedef struct {
	const char *holder, *name;
	int position;
} Home;
/** a slot's stem; a union has stems: its folder's, then each member's in slot order */
typedef struct {
	const char *stem;
	Strs *stems;
} Entry;
/** a node's layout record; NULL says an optional field is none; entries: slot -> Entry */
typedef struct {
	Home *home;
	const char *file, *laid, *was;
	Strs *sides;
	bool folder;
	Omap *entries;
	Strs *left;
	bool away;
} Layout;

typedef enum { LAID_FILE, LAID_SIDE, LAID_FOLDER, LAID_UNION, LAID_LINK } LaidKind;
/** what the layout puts at a path */
typedef struct {
	LaidKind kind;
	const char *id;
	Home *home;
	const char *form, *hash;
	Info info;
	int side;
	const char *holder, *name;
	const char *target, *half;
} Laid;

typedef enum { FOUND_NONE, FOUND_FILE, FOUND_LINK, FOUND_FOLDER } FoundKind;
/** what a plan step expects at a place: a file's hash, a link's target, a folder's file id (known: else any) */
typedef struct {
	FoundKind kind;
	const char *text;
	bool known;
	double ino;
} Found;

typedef struct {
	int number;
	const char *what, *from, *to;
	Found before, after;
	const char *id;
	bool slot;
	const char *holder, *name;
	const char *form;
	bool hasinfo;
	Info info;
	int side; // 0: none
} Step;

typedef struct {
	Omap *layout, *changed;
	Step *plan;
	int count;
} Laying;

/** the entries of a folder on disk, or NULL for none */
typedef const Strs *(*Probe)(void *context, const char *folder);
/** a folder's file id by its path; false for none */
typedef bool (*Ino)(void *context, const char *path, double *id);

/** a path from the folder from to to, both from the store's folder */
const char *layout_relative(const char *from, const char *to);
/** the path of a node's folder, "" for the root's; NULL for one that is away or whose home does not lead to the root */
const char *layout_dir(const Omap *layout, const char *id);
/** every entry the layout puts on disk, by path (Laid), left ones and what is in them not; pass is the store's */
Omap *layout_disk(const Graph *graph, const Omap *layout, const char *const *pass, int count);
/** the records that fit the graph */
Omap *layout_prune(const Graph *graph, const Omap *layout);
bool layout_sameinfo(Info a, Info b);
/** whether an entry the old layout does not put at a path (from the store's folder) is still the store's own: a link it laid */
typedef bool (*Owned)(void *context, const char *path);
/** lays a graph out from the old layout; before (or NULL: the graph) is what old was laid out from; ino may be NULL */
Laying layout_lay(const Graph *graph, const Omap *old, Probe probe, void *context, double time, const char *const *pass, int count, const Graph *before, Ino ino, void *inocontext);

/** layout_lay, with owned (or NULL): an entry it says is the store's own is not another's, so its name is not taken */
Laying layout_lay_owned(const Graph *graph, const Omap *old, Probe probe, void *context, double time, const char *const *pass, int count, const Graph *before, Ino ino, void *inocontext, Owned owned, void *owncontext);

#endif
