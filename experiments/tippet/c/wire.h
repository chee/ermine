// Tippet's own cbor: heads read and written, items passed over, and bytes held in a buffer that
// grows through tp_mem up to a bound.
#ifndef TIPPET_WIRE_H
#define TIPPET_WIRE_H

#include "tippet.h"

typedef struct {
	const uint8_t *p, *end;
} tp_in;

int tp_head(tp_in *in, int *major, uint64_t *arg);
int tp_skip(tp_in *in, tp_span *item);
int tp_whole(tp_in *in, uint64_t *out);
int tp_int(tp_in *in, int64_t *out);
int tp_bytes(tp_in *in, size_t want, tp_span *out);
int tp_text(tp_in *in, tp_span *out);
int tp_array(tp_in *in, uint64_t *count);
int tp_map(tp_in *in, uint64_t *count);
int tp_null(tp_in *in);
int tp_is(tp_span t, const char *s);
int tp_canonical(const uint8_t *p, size_t n);
// How deep a step may nest: cbor's CBOR_DEPTH less one, since a run message holds its patches one
// deeper.
#define TP_DEPTH 1023
// 1 yes, 0 no, -1 no memory. Past 64 deep the stack is malloc'd and freed before it returns.
int tp_deeper(const uint8_t *p, size_t n, size_t most);

typedef struct {
	uint8_t *p;
	size_t len, cap, max;
	const tp_mem *mem;
	int bad;
} tp_buf;

void tp_put(tp_buf *b, const void *p, size_t n);
uint8_t *tp_reserve(tp_buf *b, size_t n);
void tp_put_head(tp_buf *b, int major, uint64_t arg);
void tp_put_int(tp_buf *b, int64_t v);
void tp_put_text(tp_buf *b, const char *s);
void tp_buf_free(tp_buf *b);
int tp_buf_why(const tp_buf *b);

void tp_hex(char *out, const uint8_t *b, size_t n);
int tp_unhex(uint8_t *out, const uint8_t *s, size_t n);

uint32_t tp_get32(const uint8_t *p);
void tp_set32(uint8_t *p, uint32_t n);

void *tp_alloc(const tp_mem *mem, size_t size);
void *tp_grow(const tp_mem *mem, void *p, size_t old, size_t size);
void tp_free(const tp_mem *mem, void *p, size_t size);

#endif
