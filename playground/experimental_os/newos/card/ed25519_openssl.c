// ed25519_openssl.c: extensions/together's Ed25519 (ed25519.h) with its signing and its curve arithmetic
// by libcrypto, which the OS links for the WebSocket's TLS anyway. The portable ed25519.c is small
// and slow on purpose (about 3 ms a signature at -O1, as much a verify): a fresh card seals some 500
// commits at boot, and an old one unseals and verifies every commit it holds, which was most of the
// time to the first frame. Ed25519 is deterministic (RFC 8032), so libcrypto gives the same 64 bytes;
// the portable code signs when libcrypto will not.
//
// Verifying keeps every strict check ed25519.h says, made by the portable code's own functions
// first (S below L; A and R each in their one canonical encoding; neither of small order), and
// only then asks libcrypto the equation: OpenSSL's Ed25519 verify checks S below L and the equation
// without the cofactor, [S]B = R + [k]A, by comparing the encoding of [S]B - [k]A with R's bytes,
// which is the same equation once R is known canonical (ed25519_test in the test build: the two
// agree on every case). When libcrypto will not take the key, the portable verify answers. Built in
// place of ed25519.c (test/sources.sh): the portable file is included here, its public-key, signing
// and verifying functions renamed.
#define ermEd25519Public ermEd25519PublicPortable
#define ermEd25519Sign ermEd25519SignPortable
#define ermEd25519Verify ermEd25519VerifyPortable
#include "../../../../extensions/together/c/ed25519/ed25519.c"
#undef ermEd25519Public
#undef ermEd25519Sign
#undef ermEd25519Verify

#include <openssl/evp.h>

void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]);
void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]);
bool ermEd25519Verify(const unsigned char pub[32], const unsigned char *message, size_t length, const unsigned char signature[64]);

void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]) {
	size_t n = 32;
	EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, seed, 32);
	bool ok = key && EVP_PKEY_get_raw_public_key(key, pub, &n) == 1 && n == 32;
	EVP_PKEY_free(key);
	if (!ok) ermEd25519PublicPortable(seed, pub);
}

void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]) {
	size_t n = 64;
	EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, seed, 32);
	EVP_MD_CTX *c = key ? EVP_MD_CTX_new() : NULL;
	bool ok = c && EVP_DigestSignInit(c, NULL, NULL, NULL, key) == 1 && EVP_DigestSign(c, signature, &n, message, length) == 1 && n == 64;
	EVP_MD_CTX_free(c);
	EVP_PKEY_free(key);
	if (!ok) ermEd25519SignPortable(seed, message, length, signature);
}

bool ermEd25519Verify(const unsigned char pub[32], const unsigned char *message, size_t length, const unsigned char signature[64]) {
	// the strict checks, in the portable verdict's order: S, A, R
	Point A, R;
	if (!scalarBelowL(signature + 32)) return false;
	if (!pointDecode(&A, pub) || pointSmall(&A)) return false;
	if (!pointDecode(&R, signature) || pointSmall(&R)) return false;
	// the equation, by libcrypto: 1 holds, 0 does not, else it could not say
	EVP_PKEY *key = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, NULL, pub, 32);
	EVP_MD_CTX *c = key ? EVP_MD_CTX_new() : NULL;
	int said = -1;
	if (c && EVP_DigestVerifyInit(c, NULL, NULL, NULL, key) == 1)
		said = EVP_DigestVerify(c, signature, 64, message ? message : (const unsigned char *)"", length);
	EVP_MD_CTX_free(c);
	EVP_PKEY_free(key);
	if (said == 1 || said == 0) return said == 1;
	return ermEd25519VerifyPortable(pub, message, length, signature);
}
