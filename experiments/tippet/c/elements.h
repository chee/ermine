// The elements of an entry's strings and arrays (see typescript/elements.ts, WIRE.md ids), held as
// runs: elements one after another of one device, numbered one on (or one down), all gone or none.
// A sequence gets its elements at the first
// splice that touches it. State is keyed by container (a node: the step and patch that made it, then
// its place in the value); a record says what each patch put at a slot. el_step applies a step's
// patches to a value, all or none, with that state, and gives what undoes both.
// Memory goes through tp_mem; values are the graph's (malloc'd).
#ifndef TIPPET_ELEMENTS_H
#define TIPPET_ELEMENTS_H

#include "../../../lib/changeable/c/apply.h"
#include "tippet.h"
#include "wire.h"

#define EL_NONE UINT32_MAX
// a device named in ids that is not known: no element is its
#define EL_UNKNOWN (UINT32_MAX - 1)

// devices are held by the caller, by index
typedef struct {
	const tp_mem *mem;
	void *self;
	long (*index)(void *self, const uint8_t device[32]); // the device's index, made if new; -1 no memory
	long (*find)(void *self, const uint8_t device[32]); // the device's index if known, else -1
	const uint8_t *(*bytes)(void *self, uint32_t index);
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
// a patch's ids (WIRE.md, ids). kind: 0 none (a move), 1 [container, pred], 2 [container, pred,
// element] (a put at an index), 3 [container, after, gone, before] (a splice, a removal at an
// index). node: the container, as the bytes of cbor items one after another: the device's index,
// n, the patch, and the place in its value (maps' keys, arrays' places); none (a put of the whole
// value, the first)
typedef struct {
	int kind;
	uint8_t *node;
	size_t noden;
	el_id element;
	int has_after;
	el_id after;
	el_gone *gone;
	size_t ngone;
	int has_before, same;
	el_id before;
} el_anchor;

typedef struct el_list el_list;
// what a patch put at a slot: the key of a map, the element of an array, or the root (parent empty):
// the container there (node empty: a scalar, or nothing), and the step that put it, for the order
// (its lamport and device). buf holds the parent, the slot (a key as cbor text, an element as a cbor
// array [device, born, c, k]) and the node, one after another
typedef struct {
	uint8_t *buf;
	uint32_t parentn, slotn, noden, device;
	uint64_t lamport;
} el_slot;

// an entry's sequences by container, and the records of what patches put
typedef struct {
	el_list **lists;
	size_t n, room;
	el_slot *slots;
	size_t nslots, roomslots;
} el_state;

// st, empty, as after a put of the whole value by ref (its patch 0)
int el_seed(const tp_mem *mem, el_state *st, const el_ref *ref);

// what undoes the state of a step (or steps): newest last
typedef struct {
	int kind;
	union {
		struct {
			el_list *list;
			uint32_t device; // inserted: m from (device, c) on
			uint64_t c, m;
			el_gone *taken; // taken away, as runs
			size_t ntaken, roomtaken;
			el_ref was; // the list's newest splice before it
		} splice;
		struct {
			el_slot added; // the record put (its buffer the state's)
			int has_added, had;
			el_slot was; // the record it replaced
		} slot;
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

// patches (their cbor, and as op patches) applied to *value in order, all or none. keep: 0 for a
// patch to leave out (NULL: all). ids: per patch (NULL: none, a write here: its containers and elements
// are named from the state, *named, one per patch). late: steps
// after it may be applied already; one whose effect needs them returns TP_LATE. undo gets what
// undoes the value; back gets what undoes the elements. *applied (the patches as applied, by
// position, sharing the values given, their paths in it) is malloc'd, the caller's to free.
// Returns 0, a tp code (below 0), or an op code.
int el_step(const el_ctx *c, el_state *st, op_value **value, const el_ref *ref, tp_span patches,
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int late,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named);

// undoes back, newest first, and frees it
void el_back_undo(const tp_mem *mem, el_state *st, el_back *back);
// frees back without undoing
void el_back_free(const tp_mem *mem, el_back *back);
void el_state_free(const tp_mem *mem, el_state *st);
// st's elements as cbor, for a snapshot (the value is the graph's), and st, empty, made from it
void el_save(tp_buf *b, const el_ctx *c, const el_state *st);
int el_load(const el_ctx *c, el_state *st, tp_span bytes);

#endif
