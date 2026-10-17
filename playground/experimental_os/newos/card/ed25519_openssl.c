// ed25519_openssl.c: extensions/sync's Ed25519 (ed25519.h) with its signing by libcrypto, which the
// OS links for the WebSocket's TLS anyway. The portable ed25519.c is small and slow on purpose
// (about 3 ms a signature at -O1): a fresh card seals some 500 commits at boot, which was most of the
// time to the first frame. Ed25519 is deterministic (RFC 8032), so libcrypto gives the same 64 bytes;
// the portable code signs when libcrypto will not. Verifying stays the portable code's, with every
// strict check ed25519.h says (libcrypto's checks fewer). Built in place of ed25519.c
// (test/sources.sh): the portable file is included here, its public-key and signing functions renamed.
#define ermEd25519Public ermEd25519PublicPortable
#define ermEd25519Sign ermEd25519SignPortable
#include "../../../../extensions/sync/c/ed25519/ed25519.c"
#undef ermEd25519Public
#undef ermEd25519Sign

#include <openssl/evp.h>

void ermEd25519Public(const unsigned char seed[32], unsigned char pub[32]);
void ermEd25519Sign(const unsigned char seed[32], const unsigned char *message, size_t length, unsigned char signature[64]);

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
