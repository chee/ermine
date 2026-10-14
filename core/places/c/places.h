// Places (typescript/places.ts), in C: names from a root, walked through children nodes. A children
// node's value maps each name to a list of entries, in order: [source, id], what put it there and
// the id. The list is the order: the front is first. Places knows no source's meaning, and no part
// but children. Same rules as places.ts, which the suite in core/places/conformance/places/ holds both to.
//
// KEYS. A source or an id is a tb_key (table.h): a string, or a symbol (the caller's token, equal
// by address). A string key places gives you lives as long as the item it is in; a string key you
// give places copies when it keeps it. Symbols in a children node's value are the setup's to read
// and write (symbol, symbol_value): an op_value has no symbol of its own. pl_root() is the symbol
// that is the source of a root given as an id (places.ts's ROOT); the setup hooks decide whether
// it may stand in a value.
//
// THE HOLE. Where a source's nodes are kept is the caller's: `children` gives the children node
// of an id as a source has it, NULL: not there. Places never frees or keeps a node. A write is
// op's patches through nd_update, and nd_update's node change refers to the patches until the
// node's next update: places keeps those (one block per node it wrote, let go of at that node's
// next write through places, or at pl_free). A node may be freed by the caller at any time.
//
// ITEMS. An item is immutable, with its strings and its `up` chain; it is reference counted. A
// result from pl_get, pl_lookup, is a pl_list: the caller's, pl_list_free when done. To keep one
// item past its list, pl_item_ref it and pl_item_free it later. An item holds its `up`. An item is
// good as a start for as long as the caller holds it: nothing else about the graph is kept.
//
// OPENED PLACES. pl_open walks an address from the root, kept: pl_items gives what is there now,
// as a list places owns (borrowed: good until the next pl_items of that opened place that walks
// again, or its pl_drop, or pl_close; keep items with pl_item_ref). A children node changed in place
// (in_place) keeps its value, so a step that read one is walked again on every call. Nothing changed: the very
// same list (same pointer and serial), and a step walked again that gives alike items keeps its
// old list, so what stands on it is kept too. Opened places on one beginning share its steps.
#ifndef PLACES_H
#define PLACES_H

#include <limits.h>
#include <stddef.h>
#include <stdint.h>

#include "../../graph/c/table.h"
#include "../../node/c/node.h"
#include "../../node/c/update.h"

// the source of a root given as an id
extern const char pl_root_mark;
static inline tb_key pl_root(void) { return tb_symbol(&pl_root_mark); }

// one thing at a place, and how it was reached: up: the item whose children it was found in,
// under name, at index `at` of that name's list. A start (the root, or an entry given) has none
// (name NULL). Read only
typedef struct pl_item pl_item;
struct pl_item {
	tb_key source, id;
	const pl_item *up; // NULL on a start
	const char *name;  // NULL on a start
	size_t at;
	size_t refs; // places' own
};

// items, front first; serial: every list places makes has its own, 0 for the empty list places
// gives when there is nothing (tell two apart by it, not by address: an address may be reused)
typedef struct {
	size_t n;
	pl_item *const *items;
	uint64_t serial;
} pl_list;
// lets go of the list and one hold of each item; for the lists a call gave. Not for an opened
// place's
void pl_list_free(pl_list *list);

pl_item *pl_item_ref(pl_item *item);
// lets one hold go; the last frees the item (and lets go of its up)
void pl_item_free(pl_item *item);

// the names from the start to the item, written to names (up to cap of them, pointing into the
// items' own names), and the length of the whole path
size_t pl_path(const pl_item *item, const char **names, size_t cap);

// where a read or a write begins: an item (item set), or an entry given (item NULL)
typedef struct {
	const pl_item *item;
	tb_key source, id;
} pl_at;
static inline pl_at pl_at_item(const pl_item *item) { return (pl_at){.item = item}; }
static inline pl_at pl_at_entry(tb_key source, tb_key id) { return (pl_at){NULL, source, id}; }

// the setup: the hole and the tellings. A read is told as `read(source, id, name, keys)`: it rested
// on the children of id as source has them, at `name` in that node's value. keys: a read of which
// names there are (name NULL), not of what is under them. Told whether or not anything was there
typedef struct {
	// where names start: an id with the source pl_root(), or an entry. copied
	tb_key root_source, root_id;
	// the children node of id as source has it; NULL: not there (not loaded, or never made)
	nd_entry *(*children)(void *ctx, tb_key source, tb_key id);
	// told of each read, as it is made. May be NULL
	void (*read)(void *ctx, tb_key source, tb_key id, const char *name, int keys);
	// a value in an entry that is not a string: 1 and *token if it is a symbol. NULL hook: none is
	int (*symbol)(void *ctx, const op_value *v, const void **token);
	// the value that stands for a symbol, new (the caller of the hook is its holder). NULL hook:
	// null. Written wherever places puts an entry with a symbol in it
	op_value *(*symbol_value)(void *ctx, const void *token);
	void *ctx;
} pl_setup;

// a sink for the reads of one call: given to the call, it is told them instead of the setup's
// `read`. NULL for a call: the setup's. Places keeps it only as long as the call (an opened place:
// its open, or an items call), never in what opened places share
typedef struct {
	void (*read)(void *ctx, tb_key source, tb_key id, const char *name, int keys);
	void *ctx;
} pl_sink;

typedef struct pl pl;
// out of memory aborts, as everywhere in core. Close every opened place before pl_free
pl *pl_new(const pl_setup *setup);
// frees the places, the root item, the patches kept; not the nodes. Items the caller holds stay
void pl_free(pl *p);

// reading
// Every reading call takes a sink `read` (see pl_sink), NULL: the setup's.
// the address: n steps, in order: a name, "." here, ".." back one, "/" the root. A name is any
// other string. `from` NULL: the root.

// what is at the address, front first
pl_list *pl_get(pl *p, const char *const *address, size_t n, const pl_at *from, const pl_sink *read);
// the address from the start, then from each place the start was found in, nearest first: what
// the nearest gives (all 0), or what each gives, nearest first
pl_list *pl_lookup(pl *p, const char *const *address, size_t n, const pl_at *from, int all,
	const pl_sink *read);

// the names in an item's children whose value is a list, in their order there (an object's order:
// whole numbers first, ascending); a keys read. The caller's: pl_strings_free
typedef struct {
	size_t n;
	char **names;
} pl_strings;
pl_strings pl_names(pl *p, pl_at at, const pl_sink *read);
void pl_strings_free(pl_strings s);

// every item at a level: each name's entries in an item's children, in name order (as pl_names)
// then slot order. Its reads: a keys read, and each name's list, as pl_get tells for [name]. The
// caller's: pl_list_free. (pl_members is the kept one, of an opened place)
pl_list *pl_members_at(pl *p, pl_at at, const pl_sink *read);

// opened places
typedef struct pl_held pl_held;
// the address from the root, kept. NULL cannot happen. Walks nothing until pl_items. read: the sink
// for its items calls when they are not given one (NULL: the setup's); it must outlive the handle
pl_held *pl_open(pl *p, const char *const *address, size_t n, const pl_sink *read);
// what is there now, borrowed (see above). A walk is made only when the step before gave other
// items or a children node it read is not what it was; each call tells every read the held
// address rests on, to read, else the one given to pl_open, else the setup's (a walk again is the
// asker's). After pl_drop: the empty list
const pl_list *pl_items(pl_held *h, const pl_sink *read);
// the members of each of the opened place's items, concatenated in item order, each in name order
// then slot order (pl_members of each), kept across calls: per item, a name whose list is the one
// walked last time keeps its items (its read is told again, so it stays tracked); a name with a new
// list is walked again; a name gone is let go. A children node in place (in_place) changes its lists
// without a new one: every name is walked again. The sink as for pl_items. Borrowed: good until the
// next pl_members of this opened place, its pl_drop, or pl_close (keep items with pl_item_ref).
// After pl_drop: the empty list
const pl_list *pl_members(pl_held *h, const pl_sink *read);
// lets go of what it shares; idempotent; the handle stays good (empty)
void pl_drop(pl_held *h);
// drops and frees the handle
void pl_close(pl_held *h);

// writing. An error is a code (0: done); *at (may be NULL) the name it was about when there was
// one, a string the caller gave. A change is one nd_update on the parent's children node, with
// the header. An index of PL_END is the end.
//
// *changed (may be NULL): the children nodes the write changed, in order: one for a write within
// one parent, two for a move across parents (the one it went into first), none when nothing
// changed or the write was refused. The caller's struct, filled in, nothing allocated: source and
// id are the parent's as the write was given them (the pl_at's, or its item's: borrowed), node
// the one children gave. The node's change has the patches that landed. A move across parents
// whose second write fails (PL_OP) keeps the first
typedef struct {
	tb_key source, id;
	nd_entry *node;
} pl_wrote;
typedef struct {
	size_t n;
	pl_wrote nodes[2];
} pl_changed;
enum { PL_OK = 0, PL_NOT_A_NAME, PL_NOTHING_THERE, PL_ALREADY_THERE, PL_RANGE, PL_OP };
// "not-a-name", "nothing-there", "already-there", "range"; "op" (op refused patches: never seen
// from a sound node); "ok"
const char *pl_code_name(int code);
#define PL_END LONG_MIN

// entry placed under name, at index (PL_END: the end)
int pl_place(pl *p, pl_at at, const char *name, tb_key source, tb_key id, ch_header header, long index,
	const char **err_at, pl_changed *changed);
// the entry at index under name taken out; the last one: the name too
int pl_unplace(pl *p, pl_at at, const char *name, long index, ch_header header, const char **err_at,
	pl_changed *changed);
// the entry at from under name moved to index to, counted with it taken out. to 0: the front
int pl_order(pl *p, pl_at at, const char *name, long from, long to, ch_header header, const char **err_at,
	pl_changed *changed);
// everything under name moved to the name `to`
int pl_rename(pl *p, pl_at at, const char *name, const char *to, ch_header header, const char **err_at,
	pl_changed *changed);
// the entry at index under one slot put under another, at toindex (PL_END: the end): one children
// node (the same node, whatever keys reach it), one change, given with the target's key; two
// nodes, a change on each, the one it goes into first
int pl_move(pl *p, pl_at at, const char *name, long index, pl_at toat, const char *toname,
	ch_header header, long toindex, const char **err_at, pl_changed *changed);

#endif
