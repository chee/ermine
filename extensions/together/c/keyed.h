// A keyed hash of an id (32 bytes, or a name's CM_NAME), for the hash tables that hold what others send (ids.c, history.c):
// SipHash-1-3 under a key drawn once a process. An id is a hash anyone can grind until its first bytes
// say what they like; without the key, ids that land in one slot cannot be chosen
#ifndef KY_KEYED_H
#define KY_KEYED_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define KY_ROTATE(x, b) (uint64_t)(((x) << (b)) | ((x) >> (64 - (b))))
#define KY_ROUND(v0, v1, v2, v3) \
	do { \
		v0 += v1, v1 = KY_ROTATE(v1, 13), v1 ^= v0, v0 = KY_ROTATE(v0, 32); \
		v2 += v3, v3 = KY_ROTATE(v3, 16), v3 ^= v2; \
		v0 += v3, v3 = KY_ROTATE(v3, 21), v3 ^= v0; \
		v2 += v1, v1 = KY_ROTATE(v1, 17), v1 ^= v2, v2 = KY_ROTATE(v2, 32); \
	} while (0)

// SipHash-1-3 of the first n bytes (a multiple of 8, or 34: the last word padded with zeros) under k0, k1
static inline uint64_t ky_sip(uint64_t k0, uint64_t k1, const uint8_t *id, size_t n) {
	uint64_t v0 = k0 ^ 0x736f6d6570736575ull, v1 = k1 ^ 0x646f72616e646f6dull;
	uint64_t v2 = k0 ^ 0x6c7967656e657261ull, v3 = k1 ^ 0x7465646279746573ull;
	for (size_t i = 0; i < n / 8; i++) {
		uint64_t m = 0;
		for (int b = 0; b < 8; b++) m |= (uint64_t)id[8 * i + b] << (8 * b);
		v3 ^= m;
		KY_ROUND(v0, v1, v2, v3);
		v0 ^= m;
	}
	// the length mod 256 in the top byte, with what is left of the id below it
	uint64_t last = (uint64_t)n << 56;
	for (size_t b = 0; b < n % 8; b++) last |= (uint64_t)id[n / 8 * 8 + b] << (8 * b);
	v3 ^= last;
	KY_ROUND(v0, v1, v2, v3);
	v0 ^= last;
	v2 ^= 0xff;
	KY_ROUND(v0, v1, v2, v3);
	KY_ROUND(v0, v1, v2, v3);
	KY_ROUND(v0, v1, v2, v3);
	return v0 ^ v1 ^ v2 ^ v3;
}

// the id's slot hash, under this file's key: drawn at the first call from what a process cannot be
// told from outside (where it was loaded, where its heap and stack are, the clocks)
static inline size_t ky_hash(const uint8_t *id, size_t n) {
	static uint64_t k0, k1;
	static int ready;
	if (!ready) {
		uint8_t seed[32] = {0};
		void *heap = malloc(1);
		uint8_t here;
		uintptr_t at[3] = {(uintptr_t)&k0, (uintptr_t)heap, (uintptr_t)&here};
		free(heap);
		struct timespec now = {0};
		timespec_get(&now, TIME_UTC);
		uint64_t clocks[2] = {(uint64_t)now.tv_sec ^ (uint64_t)clock(), (uint64_t)now.tv_nsec};
		memcpy(seed, at, sizeof at < 24 ? sizeof at : 24);
		k0 = ky_sip(clocks[0], clocks[1], seed, 32);
		memcpy(seed, clocks, sizeof clocks);
		k1 = ky_sip(k0, clocks[1] ^ (uint64_t)at[1], seed, 32);
		ready = 1;
	}
	return (size_t)ky_sip(k0, k1, id, n);
}

#endif
