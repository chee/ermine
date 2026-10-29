// whole.h: whole numbers as bytes, for those no double holds exactly (past 2^53): a sign and a
// magnitude, big-endian, no leading zero. header only: op's value (value.h) and the encoding's
// (encoding/c/json.h) hold a number as a double, and such a whole number as these bytes
// beside the double nearest it (whole numbers are integers, encoding/typescript/cbor.ts).
#ifndef WHOLE_H
#define WHOLE_H

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/** how many bits the magnitude is (0 for 0) */
static inline size_t whole_bits(const unsigned char *m, size_t n) {
	size_t i = 0;
	while (i < n && !m[i]) i++;
	if (i == n) return 0;
	size_t bits = (n - i) * 8;
	for (unsigned char top = m[i]; !(top & 0x80); top <<= 1) bits--;
	return bits;
}

/** whether a double holds the magnitude exactly: at most 53 bits from its highest set to its lowest */
static inline bool whole_exact(const unsigned char *m, size_t n) {
	size_t bits = whole_bits(m, n);
	if (bits <= 53) return true;
	if (bits > 1024) return false;
	size_t low = 0; // trailing zero bits
	for (size_t i = n; i-- > 0;) {
		if (m[i]) {
			for (unsigned char b = m[i]; !(b & 1); b >>= 1) low++;
			break;
		}
		low += 8;
	}
	return bits - low <= 53;
}

/** the double nearest the magnitude, signed (rounded to even; past every double, an infinity) */
static inline double whole_near(bool negative, const unsigned char *m, size_t n) {
	size_t bits = whole_bits(m, n);
	if (bits == 0) return 0;
	// the top 64 bits, then one bit standing for any below them (so rounding is right)
	uint64_t top = 0;
	bool sticky = false;
	size_t shift = bits > 64 ? bits - 64 : 0; // bits dropped below the top 64
	for (size_t k = 0; k < bits; k++) {
		size_t bit = bits - 1 - k; // from the highest
		size_t byte = n - 1 - bit / 8;
		int on = (m[byte] >> (bit % 8)) & 1;
		if (k < 64) top = (top << 1) | (uint64_t)on;
		else if (on) sticky = true;
	}
	if (sticky) top |= 1;
	double d = ldexp((double)top, (int)(shift > 2000 ? 2000 : shift));
	return negative ? -d : d;
}

/** a whole finite double's magnitude, big-endian, no leading zero, into out (128 bytes is room for any); its length */
static inline size_t whole_of_double(double d, unsigned char out[128]) {
	d = fabs(d);
	if (d == 0) return 0;
	int e;
	double f = frexp(d, &e); // d = f 2^e, f in [0.5, 1)
	uint64_t sig = (uint64_t)ldexp(f, 53); // 53 bits
	int low = e - 53; // d = sig 2^low
	unsigned char m[128 + 8] = { 0 };
	size_t n = sizeof m;
	if (low < 0) {
		sig >>= -low; // whole: the bits shifted out are zero
		low = 0;
	}
	// sig << low, big-endian, at the end of m
	for (int bit = 0; bit < 64; bit++) {
		if (!((sig >> bit) & 1)) continue;
		int at = bit + low;
		m[n - 1 - (size_t)(at / 8)] |= (unsigned char)(1u << (at % 8));
	}
	size_t i = 0;
	while (i < n && !m[i]) i++;
	memcpy(out, m + i, n - i);
	return n - i;
}

/** the magnitude as decimal digits, a '-' first when negative, NUL after; out has room for 3n + 3; its length */
static inline size_t whole_decimal(bool negative, const unsigned char *m, size_t n, char *out) {
	unsigned char *work = malloc(n ? n : 1);
	if (!work) abort();
	if (n) memcpy(work, m, n);
	char *digits = malloc(3 * n + 2);
	if (!digits) abort();
	size_t count = 0, from = 0;
	while (from < n && !work[from]) from++;
	while (from < n) {
		unsigned rest = 0;
		for (size_t i = from; i < n; i++) {
			unsigned cur = (rest << 8) | work[i];
			work[i] = (unsigned char)(cur / 10);
			rest = cur % 10;
		}
		digits[count++] = (char)('0' + rest);
		while (from < n && !work[from]) from++;
	}
	if (!count) digits[count++] = '0';
	size_t o = 0;
	if (negative && !(count == 1 && digits[0] == '0')) out[o++] = '-';
	while (count) out[o++] = digits[--count];
	out[o] = 0;
	free(work);
	free(digits);
	return o;
}

/** decimal digits (no sign) as a magnitude, malloc'd, no leading zero; its length in *n */
static inline unsigned char *whole_parse(const char *digits, size_t length, size_t *n) {
	size_t room = length / 2 + 2;
	unsigned char *m = calloc(room, 1);
	if (!m) abort();
	for (size_t k = 0; k < length; k++) {
		unsigned carry = (unsigned)(digits[k] - '0');
		for (size_t i = room; i-- > 0;) {
			unsigned cur = m[i] * 10u + carry;
			m[i] = (unsigned char)(cur & 0xff);
			carry = cur >> 8;
		}
	}
	size_t i = 0;
	while (i < room && !m[i]) i++;
	memmove(m, m + i, room - i);
	*n = room - i;
	return m;
}

/** a magnitude of at most 8 bytes as a uint64; false past that */
static inline bool whole_u64(const unsigned char *m, size_t n, uint64_t *out) {
	size_t i = 0;
	while (i < n && !m[i]) i++;
	if (n - i > 8) return false;
	uint64_t u = 0;
	for (; i < n; i++) u = (u << 8) | m[i];
	*out = u;
	return true;
}

/** a uint64 as a magnitude into out (8 bytes of room), no leading zero; its length */
static inline size_t whole_of_u64(uint64_t u, unsigned char out[8]) {
	size_t n = 0;
	for (int k = 7; k >= 0; k--) {
		unsigned char b = (unsigned char)(u >> (8 * k));
		if (n || b) out[n++] = b;
	}
	return n;
}

/** a whole double below 1e21 as JSON.stringify writes it: its shortest round-trip digits, then
 * zeros to its point (2^60 is 1152921504606847000, not 1152921504606846976). NUL after; its length */
static inline size_t whole_js_digits(double d, char out[32]) {
	char e[40];
	for (int p = 0; p <= 17; p++) {
		snprintf(e, sizeof e, "%.*e", p, d);
		if (strtod(e, NULL) == d) break;
	}
	// e: [-]D[.DDD]e[+-]XX
	size_t o = 0;
	const char *c = e;
	if (*c == '-') out[o++] = *c++;
	char digits[24];
	size_t n = 0;
	for (; *c && *c != 'e'; c++)
		if (*c != '.') digits[n++] = *c;
	int exponent = atoi(c + 1);
	// digits[0] is at 10^exponent: n digits, then exponent + 1 - n zeros
	for (size_t i = 0; i < n && (int)i <= exponent; i++) out[o++] = digits[i];
	for (int z = exponent + 1 - (int)n; z > 0; z--) out[o++] = '0';
	if (exponent < 0) out[o++] = '0';
	out[o] = 0;
	return o;
}

#endif
