// ed25519.c: ed25519.h, written after TweetNaCl's Ed25519 (Bernstein, van
// Gastel, Janssen, Lange, Schwabe and Smetsers, 2014; public domain): its
// numbers mod p as sixteen 16-bit limbs, its complete point addition in
// extended coordinates with a ladder that does the same work for every bit,
// and its reduction mod L. Written out again in this repo's style, with no
// shift of a negative number. Verification makes the checks TweetNaCl leaves
// out, to be as strict as SYNC.tex's "Signatures are checked strictly".
//
// Small and slow on purpose (this is for tests and small devices): a sign or
// a verify is a few scalar multiplications of 256 doublings and additions.
// The curve's constants are derived from RFC 8032 5.1 (crypto_test.c checks
// each against its definition).

#include "ed25519.h"
#include "sha2.h"

#include <stdint.h>
#include <string.h>

// ---------------------------------------------------------------- numbers mod p

// A number mod p = 2^255 - 19 as 16 limbs of 16 bits, the least first. Sums
// and differences are taken limb by limb, so a limb may stray outside 0 ..
// 65535 (even below 0) until fieldCarry brings it back. fieldPack gives the
// number's one canonical form.
typedef int64_t Field[16];

static const Field zero = { 0 };
static const Field one = { 1 };
// d = -121665/121666, the curve's constant
static const Field curveD = {
	0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070,
	0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203,
};
// 2d
static const Field curveD2 = {
	0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0,
	0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406,
};
// a square root of -1: 2^((p-1)/4)
static const Field rootMinusOne = {
	0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43,
	0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83,
};

static void fieldCopy(Field o, const Field a) {
	memcpy(o, a, sizeof(Field));
}

static void fieldAdd(Field o, const Field a, const Field b) {
	for (int i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

static void fieldSub(Field o, const Field a, const Field b) {
	for (int i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

// Moves each limb's bits above 16 into the next limb, the top limb's into the
// first 38 times over (2^256 = 38 mod p). >> on a negative number rounds down
// on every compiler this is built with (C leaves it to the compiler).
static void fieldCarry(Field o) {
	for (int i = 0; i < 16; i++) {
		int64_t carry = o[i] >> 16;
		o[i] -= carry * 65536;
		if (i < 15) o[i + 1] += carry;
		else o[0] += 38 * carry;
	}
}

// o = a b; o may be a or b
static void fieldMul(Field o, const Field a, const Field b) {
	int64_t t[31] = { 0 };
	for (int i = 0; i < 16; i++)
		for (int j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
	for (int i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
	for (int i = 0; i < 16; i++) o[i] = t[i];
	fieldCarry(o);
	fieldCarry(o);
}

// Swaps a and b when bit is 1 and leaves them when it is 0, with the same work either way
static void fieldSwap(Field a, Field b, int bit) {
	int64_t mask = -(int64_t)bit;
	for (int i = 0; i < 16; i++) {
		int64_t t = mask & (a[i] ^ b[i]);
		a[i] ^= t;
		b[i] ^= t;
	}
}

// The 32 bytes, little-endian, of a's canonical form, 0 .. p-1
static void fieldPack(unsigned char out[32], const Field a) {
	Field t, m;
	fieldCopy(t, a);
	fieldCarry(t);
	fieldCarry(t);
	fieldCarry(t);
	// t is now below 2^256, under 3p: take p away twice, each time it does not go below 0
	for (int pass = 0; pass < 2; pass++) {
		m[0] = t[0] - 0xffed;
		for (int i = 1; i < 15; i++) {
			m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
			m[i - 1] &= 0xffff;
		}
		m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
		int below = (int)((m[15] >> 16) & 1);
		m[14] &= 0xffff;
		fieldSwap(t, m, 1 - below);
	}
	for (int i = 0; i < 16; i++) {
		out[2 * i] = (unsigned char)(t[i] & 0xff);
		out[2 * i + 1] = (unsigned char)((t[i] >> 8) & 0xff);
	}
}

// The number whose 255 bits are in[0 .. 32) with in[31]'s top bit left out, not reduced
static void fieldUnpack(Field o, const unsigned char in[32]) {
	for (int i = 0; i < 16; i++) o[i] = in[2 * i] + ((int64_t)in[2 * i + 1] << 8);
	o[15] &= 0x7fff;
}

static bool fieldEqual(const Field a, const Field b) {
	unsigned char x[32], y[32];
	fieldPack(x, a);
	fieldPack(y, b);
	return memcmp(x, y, 32) == 0;
}

// The low bit of a's canonical form: RFC 8032's sign of x
static int fieldParity(const Field a) {
	unsigned char x[32];
	fieldPack(x, a);
	return x[0] & 1;
}

// o = a^(p-2), which is 1/a (and 0 for 0), over the bits of p - 2 = 2^255 -
// 21: ones from bit 254 down, but for bits 4 and 2
static void fieldInvert(Field o, const Field a) {
	Field c;
	fieldCopy(c, a);
	for (int bit = 253; bit >= 0; bit--) {
		fieldMul(c, c, c);
		if (bit != 4 && bit != 2) fieldMul(c, c, a);
	}
	fieldCopy(o, c);
}

// o = a^((p-5)/8), for square roots, over the bits of (p-5)/8 = 2^252 - 3:
// ones from bit 251 down, but for bit 1
static void fieldRootPower(Field o, const Field a) {
	Field c;
	fieldCopy(c, a);
	for (int bit = 250; bit >= 0; bit--) {
		fieldMul(c, c, c);
		if (bit != 1) fieldMul(c, c, a);
	}
	fieldCopy(o, c);
}

// ---------------------------------------------------------------- points

// A point (x, y) of the curve -x^2 + y^2 = 1 + d x^2 y^2 in extended
// coordinates: x = X/Z, y = Y/Z, x y = T/Z.
typedef struct {
	Field x, y, z, t;
} Point;

static const Point identity = { { 0 }, { 1 }, { 1 }, { 0 } };

// B, the base point (RFC 8032 5.1): y = 4/5, x even
static const Point base = {
	{ 0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169 },
	{ 0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666 },
	{ 1 },
	{ 0xdda3, 0xa5b7, 0x8ab3, 0x6dde, 0x52f5, 0x7751, 0x9f80, 0x20f0, 0xe37d, 0x64ab, 0x4e8e, 0x66ea, 0x7665, 0xd78b, 0x5f0f, 0x6787 },
};

// p = p + q by Hisil, Wong, Carter and Dawson's formulas (2008) for a = -1,
// which hold for every two points of this curve, a point and itself
// included, small orders too. p and q may be the same point.
static void pointAdd(Point *p, const Point *q) {
	Field a, b, c, d, t, e, f, g, h;
	fieldSub(a, p->y, p->x);
	fieldSub(t, q->y, q->x);
	fieldMul(a, a, t);
	fieldAdd(b, p->x, p->y);
	fieldAdd(t, q->x, q->y);
	fieldMul(b, b, t);
	fieldMul(c, p->t, q->t);
	fieldMul(c, c, curveD2);
	fieldMul(d, p->z, q->z);
	fieldAdd(d, d, d);
	fieldSub(e, b, a);
	fieldSub(f, d, c);
	fieldAdd(g, d, c);
	fieldAdd(h, b, a);
	fieldMul(p->x, e, f);
	fieldMul(p->y, h, g);
	fieldMul(p->z, g, f);
	fieldMul(p->t, e, h);
}

static void pointSwap(Point *p, Point *q, int bit) {
	fieldSwap(p->x, q->x, bit);
	fieldSwap(p->y, q->y, bit);
	fieldSwap(p->z, q->z, bit);
	fieldSwap(p->t, q->t, bit);
}

// out = [s]q for the 256-bit little-endian s, with the same work for every
// bit of s: r - p stays q as the bits go by. out may be q.
static void pointMul(Point *out, const Point *q, const unsigned char s[32]) {
	Point p = identity, r = *q;
	for (int i = 255; i >= 0; i--) {
		int bit = (s[i / 8] >> (i % 8)) & 1;
		pointSwap(&p, &r, bit);
		pointAdd(&r, &p);
		pointAdd(&p, &p);
		pointSwap(&p, &r, bit);
	}
	*out = p;
}

// RFC 8032 5.1.2: y's 255 bits, little-endian, with x's low bit above them,
// the one canonical encoding of p
static void pointPack(unsigned char out[32], const Point *p) {
	Field inverse, x, y;
	fieldInvert(inverse, p->z);
	fieldMul(x, p->x, inverse);
	fieldMul(y, p->y, inverse);
	fieldPack(out, y);
	out[31] |= (unsigned char)(fieldParity(x) << 7);
}

static bool pointEqual(const Point *p, const Point *q) {
	unsigned char a[32], b[32];
	pointPack(a, p);
	pointPack(b, q);
	return memcmp(a, b, 32) == 0;
}

// RFC 8032 5.1.3: the point in[0 .. 32) encodes, in *p, when it is a point's
// one canonical encoding. False when y is p or more (step 1); when x^2 = u/v,
// with u = y^2 - 1 and v = d y^2 + 1, has no root (step 3); and when x is 0
// with the sign bit set (step 4). The first and last are what a decoder that
// reduces y, or ignores the sign of 0, lets through.
static bool pointDecode(Point *p, const unsigned char in[32]) {
	unsigned char y[32], again[32];
	int sign = in[31] >> 7;
	Field u, v, v3, x, check;
	memcpy(y, in, 32);
	y[31] &= 0x7f;
	fieldUnpack(p->y, y);
	fieldPack(again, p->y);
	if (memcmp(again, y, 32) != 0) return false; // y is p or more
	fieldCopy(p->z, one);
	fieldMul(u, p->y, p->y);
	fieldMul(v, u, curveD);
	fieldSub(u, u, one);
	fieldAdd(v, v, one);
	// step 2: the candidate root x = u v^3 (u v^7)^((p-5)/8)
	fieldMul(v3, v, v);
	fieldMul(v3, v3, v);
	fieldMul(x, v3, v3);
	fieldMul(x, x, v);
	fieldMul(x, x, u);
	fieldRootPower(x, x);
	fieldMul(x, x, v3);
	fieldMul(x, x, u);
	// step 3: v x^2 = u, or v x^2 = -u and x times the root of -1 is the root, or there is none
	fieldMul(check, x, x);
	fieldMul(check, check, v);
	if (!fieldEqual(check, u)) fieldMul(x, x, rootMinusOne);
	fieldMul(check, x, x);
	fieldMul(check, check, v);
	if (!fieldEqual(check, u)) return false;
	// step 4
	if (fieldEqual(x, zero) && sign == 1) return false;
	if (fieldParity(x) != sign) fieldSub(x, zero, x);
	fieldCopy(p->x, x);
	fieldMul(p->t, p->x, p->y);
	return true;
}

// Whether p's order divides 8: [8]p is the identity
static bool pointSmall(const Point *p) {
	Point q = *p;
	pointAdd(&q, &q);
	pointAdd(&q, &q);
	pointAdd(&q, &q);
	return pointEqual(&q, &identity);
}

// ---------------------------------------------------------------- numbers mod L

// L = 2^252 + 27742317777372353535851937790883648493, the order of B, little-endian
static const int64_t order[32] = {
	0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
};

// out = x mod L, x being the sum of x[i] 256^i (each x[i] small, of either
// sign). As 2^256 = -16 (L - 2^252) mod L, each byte from the top down is
// folded into the 20 below it 32 places lower; then what is left above 2^252
// is taken away as L's, and L added back once if that went below 0. x is
// spent.
static void scalarModL(unsigned char out[32], int64_t x[64]) {
	for (int i = 63; i >= 32; i--) {
		int64_t carry = 0;
		int j;
		for (j = i - 32; j < i - 12; j++) {
			x[j] += carry - 16 * x[i] * order[j - (i - 32)];
			carry = (x[j] + 128) >> 8;
			x[j] -= carry * 256;
		}
		x[j] += carry;
		x[i] = 0;
	}
	int64_t carry = 0;
	for (int j = 0; j < 32; j++) {
		x[j] += carry - (x[31] >> 4) * order[j];
		carry = x[j] >> 8;
		x[j] &= 255;
	}
	for (int j = 0; j < 32; j++) x[j] -= carry * order[j];
	for (int i = 0; i < 32; i++) {
		x[i + 1] += x[i] >> 8;
		out[i] = (unsigned char)(x[i] & 255);
	}
}

// out = the 64 little-endian bytes of in, mod L
static void scalarReduce(unsigned char out[32], const unsigned char in[64]) {
	int64_t x[64];
	for (int i = 0; i < 64; i++) x[i] = in[i];
	scalarModL(out, x);
}

// out = a b + c mod L
static void scalarMulAdd(unsigned char out[32], const unsigned char a[32], const unsigned char b[32], const unsigned char c[32]) {
	int64_t x[64] = { 0 };
	for (int i = 0; i < 32; i++) x[i] = c[i];
	for (int i = 0; i < 32; i++)
		for (int j = 0; j < 32; j++) x[i + j] += (int64_t)a[i] * b[j];
	scalarModL(out, x);
}

// Whether the 256-bit little-endian s is less than L
static bool scalarBelowL(const unsigned char s[32]) {
	for (int i = 31; i >= 0; i--) {
		if (s[i] != order[i]) return s[i] < order[i];
	}
	return false;
}

// ---------------------------------------------------------------- Ed25519

// RFC 8032 5.1.5: the seed's SHA-512; its first half, pruned, is the secret
// scalar a, and its second half the prefix that each signature's r is hashed from
static void expand(const unsigned char seed[32], unsigned char a[32], unsigned char prefix[32]) {
	unsigned char h[64];
	ermSha512(seed, 32, h);
	memcpy(a, h, 32);
	a[0] &= 248;
	a[31] &= 127;
	a[31] |= 64;
	memcpy(prefix, h + 32, 32);
}

// k = SHA-512(R || A || message) mod L, from R's and A's bytes as given
static void challenge(unsigned char k[32], const unsigned char r[32], const unsigned char pub[32], const unsigned char *message, size_t length) {
	unsigned char wide[64];
	ErmSha512 h;
	ermSha512Start(&h);
	ermSha512Add(&h, r, 32);
	ermSha512Add(&h, pub, 32);
	ermSha512Add(&h, message, length);
	ermSha512End(&h, wide);
	scalarReduce(k, wide);
}

void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]) {
	unsigned char a[32], prefix[32];
	Point A;
	expand(seed, a, prefix);
	pointMul(&A, &base, a);
	pointPack(pub, &A);
}

void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]) {
	unsigned char a[32], prefix[32], pub[32], wide[64], r[32], k[32];
	Point A, R;
	ErmSha512 h;
	expand(seed, a, prefix);
	pointMul(&A, &base, a);
	pointPack(pub, &A);
	// r = SHA-512(prefix || message) mod L; R = [r]B
	ermSha512Start(&h);
	ermSha512Add(&h, prefix, 32);
	ermSha512Add(&h, message, length);
	ermSha512End(&h, wide);
	scalarReduce(r, wide);
	pointMul(&R, &base, r);
	pointPack(signature, &R);
	// S = r + k a mod L
	challenge(k, signature, pub, message, length);
	scalarMulAdd(signature + 32, k, a, r);
}

// The first strict check a signature fails, in the order they are made, or
// VERIFY_GOOD. An encoding fails when it is not a point's one canonical
// encoding (pointDecode).
typedef enum { VERIFY_GOOD, VERIFY_S, VERIFY_A_ENCODING, VERIFY_A_SMALL, VERIFY_R_ENCODING, VERIFY_R_SMALL, VERIFY_EQUATION } Verdict;

// the checks after A's: S, R, the equation; A decoded and checked already
static Verdict verdictWith(const Point *A, const unsigned char pub[32], const unsigned char *message, size_t length,
	const unsigned char signature[64]) {
	Point R, left, right;
	unsigned char k[32];
	if (!pointDecode(&R, signature)) return VERIFY_R_ENCODING;
	if (pointSmall(&R)) return VERIFY_R_SMALL;
	// [S]B = R + [k]A, without the cofactor
	challenge(k, signature, pub, message, length);
	pointMul(&left, &base, signature + 32);
	pointMul(&right, A, k);
	pointAdd(&right, &R);
	return pointEqual(&left, &right) ? VERIFY_GOOD : VERIFY_EQUATION;
}

static Verdict verdict(const unsigned char pub[32], const unsigned char *message, size_t length, const unsigned char signature[64]) {
	Point A;
	if (!scalarBelowL(signature + 32)) return VERIFY_S;
	if (!pointDecode(&A, pub)) return VERIFY_A_ENCODING;
	if (pointSmall(&A)) return VERIFY_A_SMALL;
	return verdictWith(&A, pub, message, length, signature);
}

bool ermEd25519Verify(const unsigned char pub[32], const unsigned char *message, size_t length, const unsigned char signature[64]) {
	return verdict(pub, message, length, signature) == VERIFY_GOOD;
}

_Static_assert(sizeof(Point) == sizeof(((ermEd25519Key *)0)->point), "ermEd25519Key holds a Point");

bool ermEd25519KeyOf(ermEd25519Key *key, const unsigned char pub[32]) {
	Point A;
	memcpy(key->pub, pub, 32);
	key->good = pointDecode(&A, pub) && !pointSmall(&A);
	memcpy(key->point, &A, sizeof A);
	return key->good;
}

bool ermEd25519VerifyKey(const ermEd25519Key *key, const unsigned char *message, size_t length, const unsigned char signature[64]) {
	if (!key->good || !scalarBelowL(signature + 32)) return false;
	Point A;
	memcpy(&A, key->point, sizeof A);
	return verdictWith(&A, key->pub, message, length, signature) == VERIFY_GOOD;
}
