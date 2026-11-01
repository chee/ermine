// ed25519.h: pure Ed25519 signatures (RFC 8032), verified strictly.

#ifndef SUBDUCTION_ED25519_H
#define SUBDUCTION_ED25519_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** The public key (RFC 8032 5.1.5) of a 32-byte seed, RFC 8032's private key. */
void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]);

/**
 * The signature (RFC 8032 5.1.6) of message[0 .. length) by the seed's key, R then S.
 * message may be NULL when length is 0.
 */
void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]);

/**
 * A key pair worked out once from a seed, so the public key can never be mismatched with the
 * secret (a wrong public key in a signature gives the private key away). ermEd25519SignPair signs
 * without working out the public key again, which halves the time.
 */
typedef struct {
	unsigned char a[32], prefix[32], pub[32];
} ermEd25519Pair;
void ermEd25519PairOf(ermEd25519Pair *pair, const unsigned char seed[32]);
void ermEd25519SignPair(const ermEd25519Pair *pair, const unsigned char *message, size_t length, unsigned char signature[64]);

/**
 * Whether signature is pub's over message[0 .. length), checking strictly: S less than the group
 * order L; A and R in their one canonical encoding; neither of small order; and the equation
 * without the cofactor, [S]B = R + [k]A. Points of mixed order pass when the equation holds.
 * message may be NULL when length is 0.
 */
bool ermEd25519Verify(const unsigned char pub[32], const unsigned char *message, size_t length, const unsigned char signature[64]);

/** A public key decoded once, to check many signatures by it (a cache of keys keeps these). */
typedef struct {
	int64_t point[64];
	unsigned char pub[32];
	bool good;
} ermEd25519Key;
/** pub decoded into *key: false (and key not good) when it is not a point's one canonical encoding, or of small order. */
bool ermEd25519KeyOf(ermEd25519Key *key, const unsigned char pub[32]);
/** ermEd25519Verify by a key decoded already: the same answer, without decoding it again. */
bool ermEd25519VerifyKey(const ermEd25519Key *key, const unsigned char *message, size_t length, const unsigned char signature[64]);

#endif
