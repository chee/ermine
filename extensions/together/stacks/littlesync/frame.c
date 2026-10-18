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

size_t ls_cobs(const uint8_t *data, size_t length, uint8_t *out) {
	size_t at = 1, code_at = 0;
	uint8_t code = 1;
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
	out[code_at] = code;
	return at;
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

void ls_frame(const uint8_t *message, size_t length, uint8_t **out, size_t *used, size_t *capacity) {
	size_t n = length + 5;
	uint8_t *raw = malloc(n + n / 254 + 8);
	if (raw == NULL) abort();
	uint8_t *plain = malloc(n);
	if (plain == NULL) abort();
	plain[0] = 'L';
	memcpy(plain + 1, message, length);
	uint32_t crc = ls_crc32(message, length);
	for (int i = 0; i < 4; i++) plain[1 + length + i] = (uint8_t)(crc >> (8 * i));
	size_t m = ls_cobs(plain, n, raw);
	room(out, used, capacity, m + 2);
	(*out)[(*used)++] = 0;
	memcpy(*out + *used, raw, m);
	*used += m;
	(*out)[(*used)++] = 0;
	free(plain);
	free(raw);
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
