// ed25519.c: ed25519.h on Monocypher 4.0.3 (monocypher/, BSD-2 or CC0;
// README there): its numbers mod p as ten limbs of 25.5 bits, its points in
// extended coordinates, its comb for [s]B (the same work for every bit) and
// its sliding windows for [S]B - [k]A, with SHA-512 (sha2.c) where
// Monocypher's own EdDSA hashes with BLAKE2b. The checks are this file's:
// Monocypher's crypto_eddsa_check_equation takes A and R in any encoding and
// of small order, and multiplies by the cofactor; SYNC.tex's strict rules take
// none of those, so verification here is Monocypher's loop with the equation
// left without the cofactor and R compared as bytes.

#include "ed25519.h"
#include "sha2.h"

#include <string.h>

// all of monocypher.c, for its static functions (fe_*, ge_*, slide_*); what
// is not used here is dropped by a linker that drops unused sections
#include "monocypher/monocypher.c"

// ---------------------------------------------------------------- encodings

// The y of each of the eight points of order dividing 8: 1 for (0, 1), -1
// for (0, -1), 0 for (sqrt(-1), 0) and (-sqrt(-1), 0), and two for the four
// of order 8, little-endian. With x = 0 a set sign bit is not canonical, and
// otherwise both signs are small points: no encoding with one of these y is
// taken.
static const unsigned char smallY[5][32] = {
	{ 0x01 },
	{ 0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f },
	{ 0x00 },
	{ 0x26, 0xe8, 0x95, 0x8f, 0xc2, 0xb2, 0x27, 0xb0, 0x45, 0xc3, 0xf4, 0x89, 0xf2, 0xef, 0x98, 0xf0,
		0xd5, 0xdf, 0xac, 0x05, 0xd3, 0xc6, 0x33, 0x39, 0xb1, 0x38, 0x02, 0x88, 0x6d, 0x53, 0xfc, 0x05 },
	{ 0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10, 0x67, 0x0f,
		0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77, 0x92, 0xac, 0x03, 0x7a },
};

// Whether in[0 .. 32) may be a point's one canonical encoding (RFC 8032
// 5.1.2), the point not of small order: y less than p, and not one of
// smallY. Whether it is on the curve is left to the decoder.
static bool encodingGood(const unsigned char in[32]) {
	unsigned char y[32];
	memcpy(y, in, 32);
	y[31] &= 0x7f;
	// y >= p = 2^255 - 19: bytes 1 .. 30 all 0xff, the top 0x7f, the first 0xed or more
	bool above = y[31] == 0x7f && y[0] >= 0xed;
	for (int i = 1; i < 31 && above; i++) above = y[i] == 0xff;
	if (above) return false;
	for (int i = 0; i < 5; i++) {
		if (memcmp(y, smallY[i], 32) == 0) return false;
	}
	return true;
}

// ---------------------------------------------------------------- Ed25519

// RFC 8032 5.1.5: the seed's SHA-512; its first half, pruned, is the secret
// scalar a, and its second half the prefix that each signature's r is hashed from
static void expand(const unsigned char seed[32], unsigned char a[32], unsigned char prefix[32]) {
	unsigned char h[64];
	ermSha512(seed, 32, h);
	crypto_eddsa_trim_scalar(a, h);
	memcpy(prefix, h + 32, 32);
	crypto_wipe(h, sizeof h);
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
	crypto_eddsa_reduce(k, wide);
}

void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]) {
	unsigned char a[32], prefix[32];
	expand(seed, a, prefix);
	crypto_eddsa_scalarbase(pub, a);
	crypto_wipe(a, sizeof a);
	crypto_wipe(prefix, sizeof prefix);
}

void ermEd25519PairOf(ermEd25519Pair *pair, const unsigned char seed[32]) {
	expand(seed, pair->a, pair->prefix);
	crypto_eddsa_scalarbase(pair->pub, pair->a);
}

void ermEd25519SignPair(const ermEd25519Pair *pair, const unsigned char *message, size_t length, unsigned char signature[64]) {
	unsigned char wide[64], r[32], k[32];
	ErmSha512 h;
	// r = SHA-512(prefix || message) mod L; R = [r]B
	ermSha512Start(&h);
	ermSha512Add(&h, pair->prefix, 32);
	ermSha512Add(&h, message, length);
	ermSha512End(&h, wide);
	crypto_eddsa_reduce(r, wide);
	crypto_eddsa_scalarbase(signature, r);
	// S = k a + r mod L
	challenge(k, signature, pair->pub, message, length);
	crypto_eddsa_mul_add(signature + 32, k, pair->a, r);
	crypto_wipe(wide, sizeof wide);
	crypto_wipe(r, sizeof r);
}

void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]) {
	ermEd25519Pair pair;
	ermEd25519PairOf(&pair, seed);
	ermEd25519SignPair(&pair, message, length, signature);
	crypto_wipe(&pair, sizeof pair);
}

// -A and [3](-A), as Monocypher's verification looks them up
typedef ge_cached Table[P_W_SIZE];

// pub decoded into table: false when it is not encodingGood, or not on the curve
static bool decode(Table table, const unsigned char pub[32]) {
	ge minusA, minusA2, t;
	if (!encodingGood(pub) || ge_frombytes_neg_vartime(&minusA, pub) != 0) return false;
	ge_double(&minusA2, &minusA, &t);
	ge_cache(&table[0], &minusA);
	for (int i = 1; i < P_W_SIZE; i++) {
		ge_add(&t, &minusA2, &table[i - 1]);
		ge_cache(&table[i], &t);
	}
	return true;
}

// The checks after A's: S less than L; R encodingGood (an R that is not a
// point's canonical encoding never equals the one worked out); and [S]B -
// [k]A encoded is R's bytes, the equation without the cofactor.
static bool check(const Table table, const unsigned char pub[32], const unsigned char *message, size_t length,
	const unsigned char signature[64]) {
	const unsigned char *s = signature + 32;
	unsigned char k[32], sum[32];
	uint32_t s32[8];
	load32_le_buf(s32, s, 8);
	if (is_above_l(s32) || !encodingGood(signature)) return false;
	challenge(k, signature, pub, message, length);
	// Monocypher's double and add over both scalars at once, as in crypto_eddsa_check_equation
	slide_ctx kSlide, sSlide;
	slide_init(&kSlide, k);
	slide_init(&sSlide, s);
	ge point, t;
	ge_zero(&point);
	for (int i = MAX(kSlide.next_check, sSlide.next_check); i >= 0; i--) {
		fe t1, t2;
		ge_double(&point, &point, &t);
		int kDigit = slide_step(&kSlide, P_W_WIDTH, i, k);
		int sDigit = slide_step(&sSlide, B_W_WIDTH, i, s);
		if (kDigit > 0) ge_add(&point, &point, &table[kDigit / 2]);
		if (kDigit < 0) ge_sub(&point, &point, &table[-kDigit / 2]);
		if (sDigit > 0) ge_madd(&point, &point, b_window + sDigit / 2, t1, t2);
		if (sDigit < 0) ge_msub(&point, &point, b_window + -sDigit / 2, t1, t2);
	}
	ge_tobytes(sum, &point);
	return memcmp(sum, signature, 32) == 0;
}

bool ermEd25519Verify(const unsigned char pub[32], const unsigned char *message, size_t length, const unsigned char signature[64]) {
	Table table;
	return decode(table, pub) && check(table, pub, message, length, signature);
}

_Static_assert(sizeof(Table) <= sizeof(((ermEd25519Key *)0)->point), "ermEd25519Key holds a Table");

bool ermEd25519KeyOf(ermEd25519Key *key, const unsigned char pub[32]) {
	Table table;
	memcpy(key->pub, pub, 32);
	memset(key->point, 0, sizeof key->point);
	key->good = decode(table, pub);
	if (key->good) memcpy(key->point, table, sizeof table);
	return key->good;
}

bool ermEd25519VerifyKey(const ermEd25519Key *key, const unsigned char *message, size_t length, const unsigned char signature[64]) {
	Table table;
	if (!key->good) return false;
	memcpy(table, key->point, sizeof table);
	return check(table, key->pub, message, length, signature);
}
