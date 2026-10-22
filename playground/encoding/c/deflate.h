// Raw deflate (RFC 1951, no zlib or gzip wrapper) whose output is fixed by the input alone, in C:
// the same bytes as playground/encoding/typescript/deflate.ts, which states every rule of the encoder
// and which this file follows line for line. Any inflater reads what df_deflate writes; df_inflate
// reads any deflate.
//
// Out of memory aborts, as elsewhere.
#ifndef DEFLATE_H
#define DEFLATE_H

#include <stddef.h>
#include <stdint.h>

typedef enum {
	DF_OK,
	DF_NOT_DEFLATE, // malformed, or ends early
	DF_OVER_THE_LIMIT, // would give more than limit bytes
} df_code;

// the deflate of in[0, n): a new block *out of *outn bytes, free(*out) when done
void df_deflate(const uint8_t *in, size_t n, uint8_t **out, size_t *outn);
// what in[0, n) inflates to, no more than limit bytes (a bomb is refused): a new block, free(*out)
// when done; on a refusal *out is NULL
df_code df_inflate(const uint8_t *in, size_t n, size_t limit, uint8_t **out, size_t *outn);

#endif
