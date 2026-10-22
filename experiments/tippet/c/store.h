// what both stores keep in memory: where each step's record is, by device, two numbers a step
#ifndef TIPPET_STORE_H
#define TIPPET_STORE_H

#include "tippet.h"

typedef struct {
	uint8_t device[32];
	uint64_t *where; // step n's record: where[2n - 2] its offset, where[2n - 1] its length
	size_t count, room;
} tp_place;

typedef struct {
	const tp_mem *mem;
	tp_place *places;
	size_t count, room;
} tp_index;

// step at's record is length bytes at offset: at most one past the last held
int tp_index_hold(tp_index *x, const tp_at *at, uint64_t offset, uint64_t length);
// where step n of device's is: 0, or -1 when not held
int tp_index_find(const tp_index *x, const uint8_t device[32], uint64_t n, uint64_t *offset,
	uint64_t *length);
// nothing held, its memory let go
void tp_index_clear(tp_index *x);

#endif
