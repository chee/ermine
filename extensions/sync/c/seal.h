// A commit signed by the device that made it, and the id it is stored under (extensions/sync/
// typescript/seal.ts), in C. The sealed commit is the canonical map {commit, signature}: the
// commit's bytes, and 64 bytes; the signer's key is in the commit. What is signed is "ermine/v0/commit"
// then the commit's name. Signatures are checked strictly (ed25519.h): S below the group order, A and R
// canonical and not of small order, the equation without the cofactor. Same bytes as seal.ts.
#ifndef SL_SEAL_H
#define SL_SEAL_H

#include "../../../ermine/encoding/c/commit.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	SL_OK,
	SL_SHAPE,     // not a seal; a seed not 32 bytes; a signature not 64 bytes
	SL_SIGNATURE, // the commit's signer not the signer's, or the signature not good
	SL_COMMIT,    // sealing: the commit's own refusal (cm_code, field)
} sl_code;
// "shape", "signature"; "" for SL_OK and SL_COMMIT (whose name is the commit's: cm_code_name)
const char *sl_code_name(sl_code code);

// the host's, never held by sync: key is the device's Ed25519 public key; sign writes up to 64
// bytes of signature of the message and gives how many. A plain callback: it may block
typedef struct {
	uint8_t key[32];
	size_t (*sign)(void *context, const uint8_t *message, size_t length, uint8_t signature[64]);
	void *context;
} sl_signer;

// a signer that holds its seed (a device that keeps its key in memory, a test): sl_seeded_init
// makes .signer ready; the seed stays in the struct, which must stay where it is
typedef struct {
	sl_signer signer;
	uint8_t seed[32];
} sl_seeded;
void sl_seeded_init(sl_seeded *s, const uint8_t seed[32]);

// the commit as the code that made it has it: decoded (borrowed; may be NULL) and its name. Given
// a name and no commit, the caller vouches that its signer is this one (a device sealing its own)
typedef struct {
	const cm_commit *commit;
	uint8_t name[32];
} sl_made;

// whether the signature is good for the key and the message (strictly)
bool sl_good(const uint8_t signature[64], const uint8_t key[32], const uint8_t *message, size_t length);
// the sealed commit's bytes, malloc'd into *out (free it). made may be NULL: the commit is decoded
// and named here, and a bad one is SL_COMMIT with *why and *field set (free *field) (either may
// be NULL). The commit's signer not the signer's key: SL_SIGNATURE. The signature sign gave not 64
// bytes: SL_SHAPE
sl_code sl_seal(const uint8_t *commit, size_t length, const sl_signer *signer, const sl_made *made,
	uint8_t **out, size_t *out_length, cm_code *why, char **field);

// the commit, checked: its shape, and its signer's signature. bytes: the commit's bytes (the
// unsealed owns them), name: its name, stored: the seal's id
typedef struct {
	cm_commit commit;
	uint8_t *bytes;
	size_t length;
	uint8_t name[32], stored[32];
} sl_unsealed;
// SL_SHAPE: not the canonical encoding, not a map of exactly commit and signature, a commit not
// bytes or not a commit, a signature not 64 bytes. SL_SIGNATURE: not good. sl_free it on SL_OK
sl_code sl_unseal(const uint8_t *sealed, size_t length, sl_unsealed *out);
void sl_free(sl_unsealed *u);
// the id a sealed commit is stored under: the BLAKE3 hash of its sealed bytes
void sl_stored(const uint8_t *sealed, size_t length, uint8_t stored[32]);

#endif
