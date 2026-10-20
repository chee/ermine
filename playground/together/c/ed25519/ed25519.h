// ed25519.h: Ed25519 signatures (RFC 8032, pure Ed25519: no prehash, no
// context), checked as strictly as SYNC.tex's "Signatures are checked
// strictly" says.

#ifndef SUBDUCTION_ED25519_H
#define SUBDUCTION_ED25519_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** The public key (RFC 8032 5.1.5) of a 32-byte seed, RFC 8032's private key. */
void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]);

/**
 * The signature (RFC 8032 5.1.6) by the seed's key of message[0 .. length),
 * R then S. The same seed and message always give the same signature.
 * message may be NULL when length is 0.
 */
void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]);

/**
 * A key pair worked out once from a seed: the secret scalar, the nonce prefix and the public key,
 * together so they can never be mismatched (a signature made with the wrong public key gives the
 * private key away). ermEd25519SignPair signs as ermEd25519Sign does, without working out the
 * public key again: half of a sign's time.
 */
typedef struct {
	unsigned char a[32], prefix[32], pub[32];
} ermEd25519Pair;
void ermEd25519PairOf(ermEd25519Pair *pair, const unsigned char seed[32]);
void ermEd25519SignPair(const ermEd25519Pair *pair, const unsigned char *message, size_t length, unsigned char signature[64]);

/**
 * Whether signature is pub's over message[0 .. length) by RFC 8032's
 * verification (5.1.7) with every strict check of SYNC.tex: S less than the
 * group order L; pub (A) and R each in their one canonical encoding, the one
 * RFC 8032 5.1.2 writes (y less than p, and no sign bit on x = 0); neither A
 * nor R of small order (an order dividing 8); and the equation without the
 * cofactor, [S]B = R + [k]A, k being SHA-512(R || A || message) mod L.
 * A or R of mixed order (a small-order part added to a point of order L)
 * passes when the equation holds. message may be NULL when length is 0.
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
