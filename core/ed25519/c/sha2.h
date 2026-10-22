// SHA-512 (FIPS 180-4) for ed25519.c, which includes "sha2.h" from beside it.
#ifndef SHA2_H
#define SHA2_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
	uint64_t state[8];
	unsigned char block[128];
	size_t used;
	uint64_t length; // bytes added
} ErmSha512;

void ermSha512Start(ErmSha512 *h);
void ermSha512Add(ErmSha512 *h, const void *data, size_t length);
void ermSha512End(ErmSha512 *h, unsigned char out[64]);
// the hash of data[0 .. length) in one call
void ermSha512(const void *data, size_t length, unsigned char out[64]);

#endif
