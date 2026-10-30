// What both stores keep in memory: the open steps, the last run read (unpacked), and the memory
// store's index of where each record is. The file store keeps its index on disk (store_file.c).
#ifndef TIPPET_STORE_H
#define TIPPET_STORE_H

#include "tippet.h"
#include "wire.h"

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
	uint8_t device[32];
	uint64_t first;
	tp_steps steps;
	uint8_t odevice[32];
	uint64_t ofirst;
	size_t ocount;
	tp_buf open;
} tp_index;

// A run record is ["run", device, sig, pack(, prior)]; prior is 48 bytes (hash, lamport, when) when
// the pack is against the step before it.
#define TP_HEAD 105
#define TP_SIG 41
#define TP_PRIOR 50
int tp_is_run(const uint8_t *record, size_t length);
void tp_record_pack(const uint8_t *record, size_t length, tp_span *pack, tp_prior *prior, int *has);
int tp_record_unpack(const tp_mem *mem, const uint8_t *record, size_t length, size_t max, tp_steps *out);

int tp_index_hold(tp_index *x, const tp_at *at, uint64_t offset, uint64_t length, int run);
void tp_index_ran(tp_index *x, const tp_at *at);
const tp_held *tp_index_find(const tp_index *x, const uint8_t device[32], uint64_t n);
int tp_index_read(const tp_index *x, const uint8_t device[32], uint64_t n);
long tp_index_step(tp_index *x, const uint8_t device[32], uint64_t n, const tp_held *r,
	const uint8_t *record, uint8_t *out, size_t cap);
int tp_index_open(tp_index *x, const uint8_t *step, size_t length, const tp_at *at);
const uint8_t *tp_index_opened(const tp_index *x, const uint8_t device[32], uint64_t n, size_t *length);
void tp_index_clear(tp_index *x);
long tp_index_drop(tp_index *x, const uint8_t device[32], uint64_t n);

#endif
