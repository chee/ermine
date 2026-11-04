// The elements of an entry's strings and arrays (see typescript/elements.ts, WIRE.md ids), held as
// runs: elements one after another of one device, numbered one on (or one down), all gone or none.
// A sequence gets its elements at the first splice that touches it. An array item is its origin, the
// element it was inserted as; a move makes new elements that link to it, and a register per origin
// says which element shows (WIRE.md, list moves). State is keyed by container (a node: the step and patch that made it, then
// its place in the value); a cell says what a patch assigned at a slot and no assignment has replaced
// since (WIRE.md, assignments). el_step applies a step's patches to a value, all or none, with that
// state, and gives what undoes both.
// Memory goes through tp_mem; values are the graph's (malloc'd).
#ifndef TIPPET_ELEMENTS_H
#define TIPPET_ELEMENTS_H

#include "../../../lib/changeable/c/apply.h"
#include "tippet.h"
#include "wire.h"

#define EL_NONE UINT32_MAX
// a device named in ids that is not known: no element is its
#define EL_UNKNOWN (UINT32_MAX - 1)

// devices are held by the caller, by index; so are values' bytes (a held value saved and loaded)
typedef struct {
	const tp_mem *mem;
	void *self;
	long (*index)(void *self, const uint8_t device[32]); // the device's index, made if new; -1 no memory
	long (*find)(void *self, const uint8_t device[32]); // the device's index if known, else -1
	const uint8_t *(*bytes)(void *self, uint32_t index);
	int (*put_value)(void *self, tp_buf *b, const op_value *v); // v's cbor put in b; 0 ok
	op_value *(*get_value)(void *self, tp_span cbor); // a value from cbor, NULL if it is not
} el_ctx;

// a step's place: its lamport, n, and seq (how many elements its device's steps before it insert)
typedef struct {
	uint64_t lamport, n, seq;
	uint32_t device;
} el_ref;

// an element: made by a step, c its seq (born 0); or there since a step made its sequence's node
// (born 1), c that step's n, k its place
typedef struct {
	uint32_t device, born;
	uint64_t c, k;
} el_id;
typedef struct {
	el_id id;
	uint64_t count;
} el_gone;
// a patch's ids (WIRE.md, ids). kind: 0 none, 1 [container, pred], 2 [container, pred,
// element] (a put at an index), 3 [container, after, gone, before] (a splice, a removal at an
// index, a list move: gone is what it moves, in order). node: the container, as the bytes of cbor items one after another: the device's index,
// n, the patch, and the place in its value (maps' keys, arrays' places); none (a put of the whole
// value, the first). pred (kinds 1 and 2): the cells it replaces, each a node in the same bytes,
// spans into predbuf
typedef struct {
	int kind;
	uint8_t *node;
	size_t noden;
	uint8_t *predbuf;
	size_t predbufn;
	tp_span *pred;
	size_t npred;
	el_id element;
	int has_after;
	el_id after;
	el_gone *gone;
	size_t ngone;
	int has_before, same;
	el_id before;
} el_anchor;

typedef struct el_list el_list;
// a cell: what a patch assigned at a slot (the key of a map, the element of an array, or the root,
// parent empty) and no assignment has replaced. buf holds the parent, the slot (a key as cbor
// text, an element as a cbor array [device, born, c, k]) and the cell's id, one after another. idn:
// the id's bytes, and two flags: EL_CELL_NODE, it holds a container (its id is the container's
// node), EL_CELL_GHOST, an assignment named it before it landed (no value, no container),
// EL_CELL_TRASH, its container replaced or removed: held hidden with its value, until el_empty.
// device, lamport: its step's, for the order, then its id's n and patch. value: its whole value,
// held while another cell at the slot shows, or trash
#define EL_CELL_GHOST (1u << 31)
#define EL_CELL_NODE (1u << 30)
#define EL_CELL_TRASH (1u << 29)
#define EL_CELL_LEN (EL_CELL_TRASH - 1)
typedef struct {
	uint8_t *buf;
	uint32_t parentn, slotn, idn, device;
	uint64_t lamport;
	op_value *value;
} el_slot;

// the containers among the items a splice or move took away at once, as the run took them: their
// elements from id on, n of them, each one's container or NULL (a cell is made for one only when a
// patch names it). list: the sequence's node
typedef struct {
	uint8_t *list;
	size_t listn;
	el_id id;
	uint64_t n;
	op_value **values;
} el_bin;

// an entry's sequences by container, the cells of what patches assigned, and per device the newest
// step of it that landed here
typedef struct {
	el_list **lists;
	size_t n, room;
	el_slot *slots;
	size_t nslots, roomslots;
	struct {
		uint32_t device;
		uint64_t n;
	} *landed;
	size_t nlanded, roomlanded;
	el_bin **bins;
	size_t nbins, roombins;
	int quiet; // set by the host around a step: no trash is made (a replay of steps before an empty)
	uint64_t passed; // patches passed over, a container gone (counted, never undone)
	int by; // set by the host around a step: the last passed over was for a container made by step byn of device byd
	uint32_t byd;
	uint64_t byn;
} el_state;

// st, empty, as after a put of the whole value by ref (its patch 0); container: it makes one
int el_seed(const tp_mem *mem, el_state *st, const el_ref *ref, int container);

// whether st is only the root cell a put of the whole value by ref made, one patch, with nothing
// else known (a plain entry's)
int el_lone(const el_state *st, const el_ref *ref);

// the cells visible at the path (a key, or an index) in value: the shown first,
// then the rest newest first. value gets a reference on each held value; the caller frees them with
// op_free. path/length as op_target; value the graph's; st the entry's state
typedef struct {
	op_value *value;
	uint32_t device;
	uint64_t n;
} el_version;
int el_cells(const el_ctx *c, el_state *st, const op_value *value, const op_key *path, size_t length,
	el_version **out, size_t *count);
void el_cells_free(const tp_mem *mem, el_version *v, size_t count);

// what undoes the state of a step (or steps): newest last
typedef struct {
	int kind;
	union {
		struct {
			el_list *list;
			uint32_t device; // inserted: m from (device, c) on
			uint64_t c, m;
			int moved; // a list move: what it inserts is gone at first
			el_gone *taken; // taken away, as runs
			size_t ntaken, roomtaken;
			el_gone *shown; // made to show, as runs
			size_t nshown, roomshown;
		} splice;
		struct {
			el_list *list; // registers [at, at + nins) put in place of the nold in old
			size_t at, nins, nold;
			void *old;
		} reg;
		struct {
			el_list *list; // the origin entry put at at
			size_t at;
		} org;
		struct {
			el_slot cell; // the cell added (its buffer the state's), or taken (the record owns it)
		} slot;
		struct {
			const uint8_t *buf; // the cell whose value changed
			op_value *was; // its value before (the record owns it)
		} hold;
		struct {
			uint32_t device; // landed: the device's n before (0: none)
			uint64_t n;
		} landed;
		struct {
			size_t count; // pieces added to the state's bins
		} binadd;
		struct {
			el_bin *bin; // a container taken from a piece (the record owns it)
			uint64_t x;
			op_value *v;
		} bintake;
		struct {
			el_list **lists;
			size_t nlists;
			el_slot *slots;
			size_t nslots;
		} drop;
	};
} el_rec;
typedef struct {
	el_rec *p;
	size_t n, room;
} el_back;

// a step's ids read (one per patch); free with el_anchors_free
int el_read(const el_ctx *c, const tp_step *s, el_anchor **out);
void el_anchors_free(const tp_mem *mem, el_anchor *a, size_t n);
int el_named(const el_anchor *a, size_t n);
// ids as written, by step n of device me, its seq seq
void el_write(tp_buf *b, const el_ctx *c, const el_anchor *a, size_t count, uint32_t me, uint64_t n,
	uint64_t seq);

// values a step made for the patches it applied (the list of items a move brings back): the
// caller's to op_free once the patches are done with
typedef struct {
	op_value **p;
	size_t n, room;
} el_made;
void el_made_free(const tp_mem *mem, el_made *m);

// whether a patch is a list move: one item, or a range of items, of an array to a gap in the same
// array, at most 4096 of them (WIRE.md, list moves)
int el_list_move(const op_patch *p);

// patches (their cbor, and as op patches) applied to *value in order, all or none. keep: 0 for a
// patch to leave out (NULL: all). ids: per patch (NULL: none, a write here: its containers and elements
// are named from the state, *named, one per patch). late: steps
// after it may be applied already; one that can't apply as it is returns TP_LATE. undo gets what
// undoes the value; back gets what undoes the elements. *applied (the patches as applied, by
// position, sharing the values given and *made, their paths in it) is malloc'd, the caller's to free;
// *made (NULL: freed here, so applied is of no use) the values made for them.
// Returns 0, a tp code (below 0), or an op code.
int el_step(const el_ctx *c, el_state *st, op_value **value, const el_ref *ref, tp_span patches,
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int late,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named,
	el_made *made);

// undoes back, newest first, and frees it
void el_back_undo(const tp_mem *mem, el_state *st, el_back *back);
// frees back without undoing
void el_back_free(const tp_mem *mem, el_back *back);
void el_state_free(const tp_mem *mem, el_state *st);
// lets go of the trash in st: every container replaced or removed, with what is under it, whatever
// undoes it (the caller drops its back). returns how many containers went, or a tp code below 0
long el_empty(const tp_mem *mem, el_state *st);
// the trash held: containers (cells in trash, items taken away not yet named) and the bytes of their
// values in memory
void el_trash(const el_state *st, size_t *count, size_t *bytes);
// st's elements as cbor, for a snapshot (the value is the graph's), and st, empty, made from it
void el_save(tp_buf *b, const el_ctx *c, const el_state *st);
int el_load(const el_ctx *c, el_state *st, tp_span bytes);

#endif
