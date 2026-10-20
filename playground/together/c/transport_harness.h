// What a harness built on transport_harness.c adds (lock_harness.c): built with TRANSPORT_LIBRARY, the
// file's loop (hh_start, hh_finish, hh_answer) is tph_start, tph_finish and tph_answer, for the harness
// to call, and these are its seams, as hooks in transport_harness.ts is. They may stay NULL
#ifndef TPH_TRANSPORT_HARNESS_H
#define TPH_TRANSPORT_HARNESS_H

#include "lock.h"

#include "../../../conformance/c/harness.h"

// the lock a device is made with, from its request (name, lock, ...); NULL: the default, unlocked
extern const lk_lock *(*tph_lock)(const op_value *request);
// bytes closed for a put or a fragment that says closed (another device's lock closing them): into
// hh_take'd bytes, their length in *out_length
extern uint8_t *(*tph_close)(const char *device, const uint8_t doc[32], const uint8_t name[CM_NAME],
	const uint8_t (*parents)[CM_NAME], size_t count, const uint8_t *bytes, size_t length, size_t *out_length);

// a commit's label for its name (CM_NAME bytes) or its seal's stored id (32), else its hex, as an answer has it
void tph_label(FILE *out, const uint8_t *id, size_t length);

void tph_start(void);
void tph_finish(void);
void tph_answer(const op_value *request, FILE *out);

#endif
