// frames (frame.h), in C
#include "frame.h"

#include <stdlib.h>
#include <string.h>

uint32_t ls_crc32(const uint8_t *data, size_t length) {
	uint32_t crc = 0xffffffffu;
	for (size_t i = 0; i < length; i++) {
		crc ^= data[i];
		for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1)));
	}
	return ~crc;
}

void ls_cobs_begin(ls_cobs_out *c, uint8_t *out) { *c = (ls_cobs_out){out, 1, 0, 1}; }

void ls_cobs_put(ls_cobs_out *c, const uint8_t *data, size_t length) {
	uint8_t *out = c->out;
	size_t at = c->at, code_at = c->code_at;
	uint8_t code = c->code;
	for (size_t i = 0; i < length; i++) {
		if (data[i] == 0) {
			out[code_at] = code;
			code_at = at++;
			code = 1;
			continue;
		}
		out[at++] = data[i];
		if (++code == 0xff) {
			out[code_at] = code;
			code_at = at++;
			code = 1;
		}
	}
	c->at = at, c->code_at = code_at, c->code = code;
}

size_t ls_cobs_end(ls_cobs_out *c) {
	c->out[c->code_at] = c->code;
	return c->at;
}

size_t ls_cobs(const uint8_t *data, size_t length, uint8_t *out) {
	ls_cobs_out c;
	ls_cobs_begin(&c, out);
	ls_cobs_put(&c, data, length);
	return ls_cobs_end(&c);
}

long ls_uncobs(const uint8_t *data, size_t length, uint8_t *out) {
	size_t at = 0, i = 0;
	while (i < length) {
		uint8_t code = data[i++];
		if (code == 0) return -1;
		size_t n = (size_t)code - 1;
		if (i + n > length) return -1;
		memmove(out + at, data + i, n);
		at += n, i += n;
		if (code != 0xff && i < length) out[at++] = 0;
	}
	return (long)at;
}

static void room(uint8_t **out, size_t *used, size_t *capacity, size_t more) {
	if (*used + more <= *capacity) return;
	size_t c = *capacity ? *capacity : 256;
	while (c < *used + more) c *= 2;
	uint8_t *p = realloc(*out, c);
	if (p == NULL) abort();
	*out = p;
	*capacity = c;
}

size_t ls_frame_into(const uint8_t *message, size_t length, uint8_t *out) {
	uint8_t l = 'L', crc[4];
	uint32_t c = ls_crc32(message, length);
	for (int i = 0; i < 4; i++) crc[i] = (uint8_t)(c >> (8 * i));
	ls_cobs_out o;
	out[0] = 0;
	ls_cobs_begin(&o, out + 1);
	ls_cobs_put(&o, &l, 1);
	ls_cobs_put(&o, message, length);
	ls_cobs_put(&o, crc, 4);
	size_t m = 1 + ls_cobs_end(&o);
	out[m] = 0;
	return m + 1;
}

void ls_frame(const uint8_t *message, size_t length, uint8_t **out, size_t *used, size_t *capacity) {
	room(out, used, capacity, LS_FRAMED(length));
	*used += ls_frame_into(message, length, *out + *used);
}

ls_framed *ls_framed_of(const uint8_t *message, size_t length) {
	ls_framed *f = malloc(sizeof *f + LS_FRAMED(length));
	if (f == NULL) abort();
	f->refs = 1;
	f->length = ls_frame_into(message, length, f->bytes);
	return f;
}

void ls_framed_drop(ls_framed *f) {
	if (f != NULL && --f->refs == 0) free(f);
}

int ls_unframe(uint8_t *data, size_t length, const uint8_t **message, size_t *message_length) {
	uint8_t *scratch = data;
	long n = ls_uncobs(data, length, scratch);
	if (n < 6 || scratch[0] != 'L') return 0;
	size_t m = (size_t)n - 5;
	uint32_t crc = 0;
	for (int i = 0; i < 4; i++) crc |= (uint32_t)scratch[1 + m + i] << (8 * i);
	if (crc != ls_crc32(scratch + 1, m)) return 0;
	*message = scratch + 1;
	*message_length = m;
	return 1;
}
