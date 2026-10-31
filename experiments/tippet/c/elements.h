// The elements of an entry's strings and arrays (see typescript/elements.ts, WIRE.md ids), held as
// runs: elements one after another of one device, numbered one on, the lamports of the steps that made
// them going on evenly, all gone or none. A sequence gets its elements at the first splice that
// touches it. A splice by ids goes after its element and takes its gone elements away wherever they
// are now; a splice by range goes as written. el_step applies a step's patches to a value by
// position, all or none, with the elements, and gives what undoes both.
// Memory goes through tp_mem; values are the graph's (malloc'd).
#ifndef TIPPET_ELEMENTS_H
#define TIPPET_ELEMENTS_H

#include "../../../changeable/c/apply.h"
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

// an element: made by a step, c its seq (born 0); or there since a step made its sequence new
// (born 1), c that step's n, k its place
typedef struct {
	uint32_t device, born;
	uint64_t c, k;
} el_id;
typedef struct {
	el_id id;
	uint64_t count;
} el_gone;
// a splice's ids; named 0: by its range as written
typedef struct {
	int named, has_after;
	el_id after;
	el_gone *gone;
	size_t ngone;
} el_anchor;

typedef struct el_list el_list;
typedef struct {
	uint8_t *key;
	size_t keyn;
	el_ref r;
} el_born;

// an entry's sequences by path, and the put that made what is at each path
typedef struct {
	el_list **lists;
	size_t n, room;
	el_born *born;
	size_t nborn, roomborn;
} el_state;

// what undoes the elements of a step (or steps): newest last
typedef struct {
	int kind;
	union {
		struct {
			el_list *list;
			uint32_t device; // inserted: m from (device, c) on
			uint64_t c, m;
			el_gone *taken; // taken away, as runs
			size_t ntaken, roomtaken;
		} splice;
		struct {
			el_born *born;
			size_t nborn;
			el_list **lists;
			size_t nlists;
			const uint8_t *pushed; // the key this put added to the state's born
		} put;
	};
} el_rec;
typedef struct {
	el_rec *p;
	size_t n, room;
} el_back;

// a step's ids read (one per patch), seq its seq; free with el_anchors_free
int el_read(const el_ctx *c, const tp_step *s, uint64_t seq, el_anchor **out);
void el_anchors_free(const tp_mem *mem, el_anchor *a, size_t n);
int el_named(const el_anchor *a, size_t n);
// ids as written, by step n of device me, its seq seq
void el_write(tp_buf *b, const el_ctx *c, const el_anchor *a, size_t count, uint32_t me, uint64_t n,
	uint64_t seq);

// patches (their cbor, and as op patches) applied to *value in order, all or none. keep: 0 for a
// patch to leave out (NULL: all). ids: per patch (NULL: none). name: splices by range are named
// from the elements instead (*named, one per patch). undo gets what undoes the value; back gets
// what undoes the elements. *applied (the patches as applied, by position, sharing the paths and
// values given) is malloc'd, the caller's to free. Returns 0, a tp
// code (below 0), or an op code.
int el_step(const el_ctx *c, el_state *st, op_value **value, const el_ref *ref, tp_span patches,
	const op_patch *ps, size_t n, const uint8_t *keep, const el_anchor *ids, int name,
	op_undo *undo, el_back *back, op_patch **applied, size_t *napplied, el_anchor **named);

// undoes back, newest first, and frees it
void el_back_undo(const tp_mem *mem, el_state *st, el_back *back);
// frees back without undoing
void el_back_free(const tp_mem *mem, el_back *back);
void el_state_free(const tp_mem *mem, el_state *st);

#endif
