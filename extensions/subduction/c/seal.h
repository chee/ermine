// A blop (newcore/encoding/BLOP.tex) signed by the device that made it, and the id it is stored
// under (newcore/sync/SEAL.tex), in C. Same shape as seal.ts: the sealed change is the canonical
// map {change, signer, signature}, each a byte string; what is signed is "ermine/v0/change" and
// the blop's name. Signatures are checked strictly (SEAL.tex, Strict).
#ifndef SEAL_H
#define SEAL_H

#include "../../../ermine/encoding/c/json.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	SEAL_OK,
	SEAL_SHAPE,     // not the canonical encoding, not exactly the three keys, a field not a byte string of its size, the blop not a blop
	SEAL_SIGNATURE, // the blop's signer not the seal's, or the signature not good
} seal_code;

// the host's, never held by sync: key, the device's Ed25519 public key; sign(context, message,
// length, signature) writes up to 64 bytes and gives how many. A plain callback: it may block
typedef struct {
	uint8_t key[32];
	size_t (*sign)(void *context, const uint8_t *message, size_t length, uint8_t signature[64]);
	void *context;
} seal_signer;

// the blop decoded (a new value: seal_free), its name, the stored id, and who signed it
typedef struct {
	Json *blop;
	uint8_t name[32], stored[32], signer[32];
} seal_unsealed;

// a blop as the code that encoded it has it: decoded (not owned) and its name
typedef struct {
	const Json *blop;
	uint8_t name[32];
} seal_made;

// good only if S < L; A and R canonical and not of small order; [S]B = R + [k]A, no cofactor
bool seal_good(const uint8_t signature[64], const uint8_t key[32], const uint8_t *message, size_t length);
// the sealed change's bytes, malloc'd into *out (free it). blop is its bytes. The signature sign
// gave is checked as unseal checks it: not 64 bytes, SEAL_SHAPE; not good, SEAL_SIGNATURE. made, or
// NULL: the blop decoded and its name, taken as given: not decoded or named again
seal_code seal_seal(const uint8_t *blop, size_t length, const seal_signer *signer, const seal_made *made, uint8_t **out, size_t *out_length);
// synchronous, needing no key
seal_code seal_unseal(const uint8_t *bytes, size_t length, seal_unsealed *out);
void seal_free(seal_unsealed *u);
// the stored id: the BLAKE3 hash of any bytes; never fails
void seal_stored(const uint8_t *bytes, size_t length, uint8_t stored[32]);

#endif
