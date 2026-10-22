// a device's key: ed25519 (RFC 8032), on Monocypher (ed25519/). a device is named by its public
// key; what it signs is the hash of its latest step, so one signature covers every step before it
#include <string.h>

#include "ed25519/ed25519.h"
#include "tippet.h"

void tp_key_of(tp_key *k, const uint8_t seed[32]) {
	ermEd25519Pair pair;
	ermEd25519PairOf(&pair, seed);
	memcpy(k->a, pair.a, 32), memcpy(k->prefix, pair.prefix, 32), memcpy(k->pub, pair.pub, 32);
}

void tp_sign(const tp_key *k, const uint8_t *m, size_t n, uint8_t sig[64]) {
	ermEd25519Pair pair;
	memcpy(pair.a, k->a, 32), memcpy(pair.prefix, k->prefix, 32), memcpy(pair.pub, k->pub, 32);
	ermEd25519SignPair(&pair, m, n, sig);
}

int tp_verify(const uint8_t device[32], const uint8_t *m, size_t n, const uint8_t sig[64]) {
	return ermEd25519Verify(device, m, n, sig);
}
