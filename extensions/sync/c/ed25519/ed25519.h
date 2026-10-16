// ed25519.h: Ed25519 signatures (RFC 8032, pure Ed25519: no prehash, no
// context), checked as strictly as SYNC.tex's "Signatures are checked
// strictly" says.

#ifndef SUBDUCTION_ED25519_H
#define SUBDUCTION_ED25519_H

#include <stdbool.h>
#include <stddef.h>

/** The public key (RFC 8032 5.1.5) of a 32-byte seed, RFC 8032's private key. */
void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]);

/**
 * The signature (RFC 8032 5.1.6) by the seed's key of message[0 .. length),
 * R then S. The same seed and message always give the same signature.
 * message may be NULL when length is 0.
 */
void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]);

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

#endif
