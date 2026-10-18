// A commit signed by the device that made it, and the id it is stored under (extensions/sync/
// typescript/seal.ts), in C. The sealed commit is the canonical map {commit, signature}: the
// commit's bytes, and a signature: a varsig header, then the raw signature (Ed25519: 8 bytes of header,
// then 64); the signer's key, a multikey, is in the commit. What is signed is "ermine/v0/commit", the
// document's 32 bytes, the signature's header, then the commit's name: a seal is good in its document
// only, and a header put on another signature is no longer good. A signature is checked by the verifier whose header it begins with. The built in
// is Ed25519, checked strictly (ed25519.h): S below the group order, A and R canonical and not of
// small order, the equation without the cofactor. Same bytes as seal.ts.
#ifndef SL_SEAL_H
#define SL_SEAL_H

#include "../../../ermine/encoding/c/commit.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	SL_OK,
	SL_SHAPE,     // not a seal; a seed not 32 bytes; a signature of no bytes, or not the size its header says
	SL_SIGNATURE, // the commit's signer not the signer's, no verifier for the header, the header and the
	              // signer's key type differ, or the signature not good
	SL_COMMIT,    // sealing: the commit's own refusal (cm_code, field)
} sl_code;
// "shape", "signature"; "" for SL_OK and SL_COMMIT (whose name is the commit's: cm_code_name)
const char *sl_code_name(sl_code code);

// an Ed25519 key as a multikey (commit.h): 0xed 0x01, then the 32 bytes of the key
#define SL_KEY 34
// the most bytes of raw signature a sign callback may write
#define SL_RAW_MAX 1024

// the host's, never held by sync: key is the device's public key, a multikey (key_length bytes);
// header the varsig header its signatures begin with (static); sign writes up to SL_RAW_MAX bytes
// of raw signature of the message, without the header, and gives how many. A plain callback: it
// may block
typedef struct {
	uint8_t key[CM_SIGNER_MAX];
	size_t key_length;
	const uint8_t *header;
	size_t header_length;
	size_t (*sign)(void *context, const uint8_t *message, size_t length, uint8_t signature[SL_RAW_MAX]);
	void *context;
} sl_signer;

// a signature algorithm a seal can be checked with: the varsig header it is found by (a signature
// begins with exactly these bytes; static), the multicodec code its keys must have, how many bytes
// of signature follow the header, and the check, given the raw key
typedef struct {
	const uint8_t *header;
	size_t header_length;
	uint64_t code;
	size_t size;
	bool (*verify)(void *context, const uint8_t *signature, const uint8_t *key, size_t key_length,
		const uint8_t *message, size_t length);
	void *context;
} sl_verifier;
// a table of them: what a caller adds to the built in Ed25519
typedef struct {
	const sl_verifier *items;
	size_t count;
} sl_verifiers;

// a signer that holds its seed (a device that keeps its key in memory, a test): sl_seeded_init
// makes .signer ready, an Ed25519 one (its key SL_KEY bytes); the seed stays in the struct, which
// must stay where it is
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

// how many bytes of a signature are its varsig header (0x34 0x01, an algorithm of those varsig
// names, then the payload encoding: raw, DAG-CBOR, DAG-JSON); 0 for any other, which is no header
// this reads
size_t sl_header_length(const uint8_t *signature, size_t length);
// the sealed commit's bytes for the document (its 32 bytes), malloc'd into *out (free it). made may
// be NULL: the commit is decoded
// and named here, and a bad one is SL_COMMIT with *why and *field set (free *field) (either may
// be NULL). The commit's signer not the signer's key: SL_SIGNATURE. The signature sign gave no
// bytes, or too many: SL_SHAPE
sl_code sl_seal(const uint8_t *commit, size_t length, const sl_signer *signer, const uint8_t doc[32],
	const sl_made *made, uint8_t **out, size_t *out_length, cm_code *why, char **field);

// the commit, checked: its shape, and its signer's signature for the document (its 32 bytes).
// bytes: the commit's bytes (the unsealed owns them), name: its name, stored: the seal's id
typedef struct {
	cm_commit commit;
	uint8_t *bytes;
	size_t length;
	uint8_t name[32], stored[32];
	// on SL_SIGNATURE: why, a static string
	const char *reason;
} sl_unsealed;
// SL_SHAPE: not the canonical encoding, not a map of exactly commit and signature, a commit not
// bytes or not a commit, a signature not bytes or not the size its verifier says. SL_SIGNATURE: no
// verifier for the signature's header, the header's key type not the signer's, or not good. more:
// verifiers beside the built in (NULL: none). sl_free it on SL_OK
sl_code sl_unseal(const uint8_t *sealed, size_t length, const uint8_t doc[32], sl_unsealed *out, const sl_verifiers *more);
void sl_free(sl_unsealed *u);
// the id a sealed commit is stored under: the BLAKE3 hash of its sealed bytes
void sl_stored(const uint8_t *sealed, size_t length, uint8_t stored[32]);

#endif
