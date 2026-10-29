// ermine ids (ids.h), on encoding's BLAKE3
#include "ids.h"

#include <string.h>

#include "../../encoding/c/blake3/blake3.h"

bool id_utf8(const uint8_t *s, size_t length) {
	for (size_t i = 0; i < length;) {
		uint8_t c = s[i];
		size_t n;
		uint32_t cp, least;
		if (c < 0x80) {
			i++;
			continue;
		} else if ((c & 0xe0) == 0xc0) n = 1, cp = c & 0x1f, least = 0x80;
		else if ((c & 0xf0) == 0xe0) n = 2, cp = c & 0x0f, least = 0x800;
		else if ((c & 0xf8) == 0xf0) n = 3, cp = c & 0x07, least = 0x10000;
		else return false;
		if (length - i <= n) return false;
		for (size_t k = 1; k <= n; k++) {
			if ((s[i + k] & 0xc0) != 0x80) return false;
			cp = cp << 6 | (s[i + k] & 0x3f);
		}
		if (cp < least || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
		i += n + 1;
	}
	return true;
}

void id_fresh(const uint8_t random[16], uint8_t out[ID_SHORT]) {
	out[0] = 0x00, out[1] = 0x10;
	memcpy(out + 2, random, 16);
}

// one piece: its length (an unsigned varint), then its bytes, so no two lists of pieces join alike
static void piece(blake3_hasher *h, const void *data, size_t length) {
	uint8_t v[10];
	size_t n = 0;
	for (size_t x = length; n == 0 || x > 0; x >>= 7) v[n++] = (uint8_t)((x & 0x7f) | (x >> 7 ? 0x80 : 0));
	blake3_hasher_update(h, v, n);
	blake3_hasher_update(h, data, length);
}

// BLAKE3 of the domain, then the parts, each a piece
static void digest(const char *domain, const id_part *parts, size_t count, uint8_t out[32]) {
	blake3_hasher h;
	blake3_hasher_init(&h);
	piece(&h, domain, strlen(domain));
	for (size_t i = 0; i < count; i++) piece(&h, parts[i].data, parts[i].length);
	blake3_hasher_finalize(&h, out, 32);
}

bool id_hashed(const char *domain, const id_part *parts, size_t count, uint8_t out[ID_SHORT]) {
	if (!id_utf8((const uint8_t *)domain, strlen(domain))) return false;
	uint8_t d[32];
	digest(domain, parts, count, d);
	out[0] = 0x1e, out[1] = 0x10;
	memcpy(out + 2, d, 16);
	return true;
}

bool id_child(const uint8_t *parent, size_t size, const char *name, size_t length, uint8_t out[ID_SHORT]) {
	if (id_kind_of(parent, size) == ID_NONE || !id_utf8((const uint8_t *)name, length)) return false;
	id_part p[2] = {{parent, size}, {(const uint8_t *)name, length}};
	return id_hashed(ID_CHILD, p, 2, out);
}

bool id_outside(const uint8_t *data, size_t length, bool utf8, uint8_t out[ID_SHORT]) {
	if (utf8 && !id_utf8(data, length)) return false;
	id_part p = {data, length};
	return id_hashed(ID_OUTSIDE, &p, 1, out);
}

id_kind id_kind_of(const uint8_t *id, size_t length) {
	if (id == NULL) return ID_NONE;
	if (length == ID_SHORT && id[0] == 0x00 && id[1] == 0x10) return ID_FRESH;
	if (length == ID_SHORT && id[0] == 0x1e && id[1] == 0x10) return ID_HASHED;
	if (length == ID_MAX && id[0] == 0xed && id[1] == 0x01) return ID_KEY;
	return ID_NONE;
}

size_t id_text(const uint8_t *id, size_t length, char out[ID_TEXT]) {
	static const char digits[] = "0123456789abcdef";
	if (id_kind_of(id, length) == ID_NONE) return 0;
	memcpy(out, "ermine:", 7);
	for (size_t i = 0; i < length; i++) {
		out[7 + 2 * i] = digits[id[i] >> 4];
		out[8 + 2 * i] = digits[id[i] & 15];
	}
	out[7 + 2 * length] = 0;
	return 7 + 2 * length;
}

// a lowercase hex digit's value; -1 for any other character
static int digit(char c) {
	if (c >= '0' && c <= '9') return c - '0';
	if (c >= 'a' && c <= 'f') return c - 'a' + 10;
	return -1;
}

size_t id_parse(const char *text, size_t length, uint8_t out[ID_MAX]) {
	if (length < 7 || memcmp(text, "ermine:", 7) != 0) return 0;
	size_t n = (length - 7) / 2;
	if (length - 7 != 2 * ID_SHORT && length - 7 != 2 * ID_MAX) return 0;
	uint8_t b[ID_MAX];
	for (size_t i = 0; i < n; i++) {
		int hi = digit(text[7 + 2 * i]), lo = digit(text[8 + 2 * i]);
		if (hi < 0 || lo < 0) return 0;
		b[i] = (uint8_t)(hi << 4 | lo);
	}
	if (id_kind_of(b, n) == ID_NONE) return 0;
	memcpy(out, b, n);
	return n;
}
