// what both stores keep in memory: where each record holding steps is, by device, one entry a
// record; and the last run read, unpacked, so reading its steps in turn unpacks it once
#ifndef TIPPET_STORE_H
#define TIPPET_STORE_H

#include "tippet.h"
#include "wire.h"

// a record: its steps, first to last; where it is and how long; run: a run message, else a step
// kept alone
typedef struct {
	uint64_t first, last, offset;
	uint32_t length, run;
} tp_held;

typedef struct {
	uint8_t device[32];
	tp_held *held;
	size_t count, room;
} tp_place;

typedef struct {
	const tp_mem *mem;
	size_t max; // the most bytes of a run's steps, unpacked
	tp_place *places;
	size_t count, room;
	// the last run read: its device, its first step's n, its steps
	uint8_t device[32];
	uint64_t first;
	tp_steps steps;
	// the open steps: their device, the n of the first (when none, of the next), how many, and
	// their frames back to back (4 bytes big-endian length, then the step)
	uint8_t odevice[32];
	uint64_t ofirst;
	size_t ocount;
	tp_buf open;
} tp_index;

// a run message's bytes, as a record: a fixed head (["run", device, sig, …]), then the pack; one
// whose pack is against the step before has that step's prior after it (["run", device, sig, pack,
// prior], prior a bstr of 48: its hash, lamport and when, 8 bytes each, big-endian), TP_PRIOR bytes
#define TP_HEAD 105
#define TP_SIG 41
#define TP_PRIOR 50
// 1: the record is a run message, or one with its prior
int tp_is_run(const uint8_t *record, size_t length);
// a run record's pack, and the prior it is packed against into *prior (*has 1) when it has one
void tp_record_pack(const uint8_t *record, size_t length, tp_span *pack, tp_prior *prior, int *has);
// a run record's steps, unpacked: 0 or a code
int tp_record_unpack(const tp_mem *mem, const uint8_t *record, size_t length, size_t max, tp_steps *out);

// a record's place: length bytes at offset, in place of those held that it covers
int tp_index_hold(tp_index *x, const tp_at *at, uint64_t offset, uint64_t length, int run);
// the record holding step n of device's, or NULL
const tp_held *tp_index_find(const tp_index *x, const uint8_t device[32], uint64_t n);
// 1: step n of device's is in the run last read
int tp_index_read(const tp_index *x, const uint8_t device[32], uint64_t n);
// step n of device's, in record (r's bytes; NULL when tp_index_read): its length, its bytes into
// out when no more than cap; -1 when its run doesn't unpack
long tp_index_step(tp_index *x, const uint8_t device[32], uint64_t n, const tp_held *r,
	const uint8_t *record, uint8_t *out, size_t cap);
// a step open, after those open (one that doesn't follow them: the only one). 0 or a code
int tp_index_open(tp_index *x, const uint8_t *step, size_t length, const tp_at *at);
// open step n of device's: its bytes, *length long; NULL: not open
const uint8_t *tp_index_opened(const tp_index *x, const uint8_t device[32], uint64_t n, size_t *length);
// nothing held, open steps neither, its memory let go
void tp_index_clear(tp_index *x);
// forgetting: those holding device's steps through n out: how many
long tp_index_drop(tp_index *x, const uint8_t device[32], uint64_t n);

#endif
