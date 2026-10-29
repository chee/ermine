// tippet's own cbor: heads read and written, items passed over, bytes held in a buffer that grows
// through tp_mem to a bound. canonical form is checked once, by encoding's cborCheck;
// what reads here reads what it took
#ifndef TIPPET_WIRE_H
#define TIPPET_WIRE_H

#include "tippet.h"

// reading: from p to end
typedef struct {
	const uint8_t *p, *end;
} tp_in;

// a head: its major type and argument (major 7: the additional info, any float's bytes passed).
// 0, or -1 at the end or a head not cbor's
int tp_head(tp_in *in, int *major, uint64_t *arg);
// one item passed over, whatever it holds; its bytes in *item (may be NULL). 0 or -1
int tp_skip(tp_in *in, tp_span *item);
// a whole number, 0 to TP_WHOLE
int tp_whole(tp_in *in, uint64_t *out);
// an integer, -TP_WHOLE to TP_WHOLE
int tp_int(tp_in *in, int64_t *out);
// a byte string, of length want (0: any)
int tp_bytes(tp_in *in, size_t want, tp_span *out);
// a text string: its bytes
int tp_text(tp_in *in, tp_span *out);
// an array's or map's head (major 4 or 5): how many
int tp_array(tp_in *in, uint64_t *count);
int tp_map(tp_in *in, uint64_t *count);
// whether the next is null, then passed
int tp_null(tp_in *in);
// whether a text span is the C string s
int tp_is(tp_span t, const char *s);
// the bytes are one canonical cbor item (encoding/c/cbor.h)
int tp_canonical(const uint8_t *p, size_t n);

// writing: into p, growing through mem (NULL: p is fixed, cap long) up to max. len counts every
// byte, past cap too; bad: a grow failed or went past max
typedef struct {
	uint8_t *p;
	size_t len, cap, max;
	const tp_mem *mem;
	int bad;
} tp_buf;

void tp_put(tp_buf *b, const void *p, size_t n);
// n bytes more, to be written: where they are (NULL: past cap, or bad)
uint8_t *tp_reserve(tp_buf *b, size_t n);
void tp_put_head(tp_buf *b, int major, uint64_t arg);
void tp_put_int(tp_buf *b, int64_t v);
void tp_put_text(tp_buf *b, const char *s);
// a buffer's memory let go
void tp_buf_free(tp_buf *b);
// what is wrong with it: 0, TP_NOMEM or TP_BOUND
int tp_buf_why(const tp_buf *b);

// n bytes as 2n lowercase hex digits (no 0 after), and back: 0, or -1 not such digits
void tp_hex(char *out, const uint8_t *b, size_t n);
int tp_unhex(uint8_t *out, const uint8_t *s, size_t n);

// a frame's length: 4 bytes, big-endian, read and written
uint32_t tp_get32(const uint8_t *p);
void tp_set32(uint8_t *p, uint32_t n);

// memory through mem: a new, a grown and a let go
void *tp_alloc(const tp_mem *mem, size_t size);
void *tp_grow(const tp_mem *mem, void *p, size_t old, size_t size);
void tp_free(const tp_mem *mem, void *p, size_t size);

#endif
