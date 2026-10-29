// the C Ed25519 (ed25519.h): RFC 8032's first test vector (7.1, TEST 1) and what a strict check
// refuses, as ed25519_test.ts has them. exits 1 at the first thing that is not so.
// make test-c-ed25519-test (test-check-, test-leaks-)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ed25519.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static void unhex(const char *s, unsigned char *out, size_t n) {
	for (size_t i = 0; i < n; i++) {
		unsigned int b;
		CHECK(sscanf(s + 2 * i, "%2x", &b) == 1);
		out[i] = (unsigned char)b;
	}
}

int main(void) {
	unsigned char secret[32], key[32], signature[64], made[64], pub[32];
	unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", secret, 32);
	unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", key, 32);
	unhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
		signature, 64);

	ermEd25519Public(secret, pub);
	CHECK(memcmp(pub, key, 32) == 0);
	ermEd25519Sign(secret, NULL, 0, made);
	CHECK(memcmp(made, signature, 64) == 0);
	CHECK(ermEd25519Verify(key, NULL, 0, signature));

	// another message, a changed signature
	CHECK(!ermEd25519Verify(key, (const unsigned char *)"\x01", 1, signature));
	unsigned char changed[64];
	memcpy(changed, signature, 64);
	changed[0] ^= 1;
	CHECK(!ermEd25519Verify(key, NULL, 0, changed));

	// a key of small order (the identity), and a key not in its one canonical encoding (y = p)
	unsigned char identity[32] = {1}, noncanonical[32];
	memset(noncanonical, 0xff, 32);
	noncanonical[0] = 0xed;
	noncanonical[31] = 0x7f;
	CHECK(!ermEd25519Verify(identity, NULL, 0, signature));
	CHECK(!ermEd25519Verify(noncanonical, NULL, 0, signature));

	// S not below the group order L
	unsigned char big[64];
	memcpy(big, signature, 64);
	memset(big + 32, 0xff, 32);
	big[63] = 0x1f;
	CHECK(!ermEd25519Verify(key, NULL, 0, big));

	// a key decoded once gives the same answers
	ermEd25519Key k;
	CHECK(ermEd25519KeyOf(&k, key));
	CHECK(ermEd25519VerifyKey(&k, NULL, 0, signature));
	CHECK(!ermEd25519VerifyKey(&k, NULL, 0, changed));
	CHECK(!ermEd25519KeyOf(&k, identity));

	puts("ed25519_test: ok");
	return 0;
}
