// A commit signed by the device that made it, and the id it is stored under (playground/together/
// typescript/seal.ts), in C. The sealed commit is the canonical map {id, commit, signature}: the id
// it is for (the document's, text), the commit's bytes, and a signature: a varsig header, then the raw
// signature (Ed25519: 8 bytes of header, then 64); the signer's key, a multikey, is in the commit. Its
// stored id is BLAKE3 of the pieces "ermine/v1/stored", the id's UTF-8 and the commit's name (each its
// length as an unsigned varint, then its bytes): what is signed, without the signature, so anyone
// holding the commit and its id works it out; one commit sealed for two documents has two. What is
// signed is "ermine/v1/commit", the
// length of the document's id's UTF-8 (an unsigned varint), that UTF-8, the signature's header, then
// the commit's name: a seal is good in its document only, and a header put on another signature is
// no longer good. An id is any well-formed UTF-8 without U+0000, compared as its bytes, never
// normalised; any other is refused (SL_SHAPE). A signature is checked by the verifier whose header it begins with. The built in
// is Ed25519, checked strictly (ed25519.h): S below the group order, A and R canonical and not of
// small order, the equation without the cofactor. Same bytes as seal.ts.
#ifndef SL_SEAL_H
#define SL_SEAL_H

#include "../../../ermine/encoding/c/commit.h"
#include "../../../core/ed25519/c/ed25519.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
	SL_OK,
	SL_SHAPE,     // not a seal; a seed not 32 bytes; a signature of no bytes, or not the size its header says
	SL_SIGNATURE, // the commit's signer not the signer's, no verifier for the header, the header and the
	              // signer's key type differ, or the signature not good
	SL_COMMIT,    // sealing: the commit's own refusal (cm_code, field)
	SL_ID,        // unsealing: the seal is for another id than the one given (why: SL_ELSEWHERE)
} sl_code;
// "shape", "signature", "id"; "" for SL_OK and SL_COMMIT (whose name is the commit's: cm_code_name)
const char *sl_code_name(sl_code code);
// why a seal for another document is refused, beside the code id
#define SL_ELSEWHERE "the seal is for another id"

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
	// the key pair worked out once from the seed: signing never works the public key out again
	ermEd25519Pair pair;
} sl_seeded;
void sl_seeded_init(sl_seeded *s, const uint8_t seed[32]);

// the commit as the code that made it has it: decoded (borrowed; may be NULL) and its name. Given
// a name and no commit, the caller vouches that its signer is this one (a device sealing its own)
typedef struct {
	const cm_commit *commit;
	uint8_t name[CM_NAME];
} sl_made;

// how many bytes of a signature are its varsig header (0x34 0x01, an algorithm of those varsig
// names, then the payload encoding: raw, DAG-CBOR, DAG-JSON); 0 for any other, which is no header
// this reads
size_t sl_header_length(const uint8_t *signature, size_t length);
// whether the bytes are well-formed UTF-8 (no overlong form, no surrogate, nothing past U+10FFFF)
// without U+0000: what an id must be
bool sl_id(const uint8_t *id, size_t length);
// the sealed commit's bytes for the document (its id's UTF-8, doc_length bytes; not well-formed:
// SL_SHAPE), malloc'd into *out (free it). made may
// be NULL: the commit is decoded
// and named here, and a bad one is SL_COMMIT with *why and *field set (free *field) (either may
// be NULL). The commit's signer not the signer's key: SL_SIGNATURE. The signature sign gave no
// bytes, or too many: SL_SHAPE
sl_code sl_seal(const uint8_t *commit, size_t length, const sl_signer *signer, const uint8_t *doc, size_t doc_length,
	const sl_made *made, uint8_t **out, size_t *out_length, cm_code *why, char **field);

// the commit, checked: its shape, and its signer's signature for the document (its id's UTF-8).
// bytes: the commit's bytes (the unsealed owns them), name: its name, stored: the seal's id
typedef struct {
	cm_commit commit;
	uint8_t *bytes;
	size_t length;
	uint8_t name[CM_NAME], stored[32];
	// on SL_SIGNATURE or SL_ID: why, a static string
	const char *reason;
} sl_unsealed;
// SL_SHAPE: not the canonical encoding, not a map of exactly id, commit and signature, an id not
// text or not well-formed, a commit not bytes or not a commit, a signature not bytes or not the size
// its verifier says. SL_ID: its id not the document's. SL_SIGNATURE: no verifier for the signature's
// header, the header's key type not the signer's, or not good. more: verifiers beside the built in
// (NULL: none). An id given not well-formed: SL_SHAPE. sl_free it on SL_OK
sl_code sl_unseal(const uint8_t *sealed, size_t length, const uint8_t *doc, size_t doc_length, sl_unsealed *out,
	const sl_verifiers *more);
void sl_free(sl_unsealed *u);
// the id a commit is stored under in a document (its id's UTF-8, length bytes): above. false: the id
// is not one
bool sl_stored_id(const uint8_t *id, size_t length, const uint8_t name[CM_NAME], uint8_t stored[32]);
// the same of a sealed commit, from the id and commit in it, unchecked. false: not a seal's shape
bool sl_stored(const uint8_t *sealed, size_t length, uint8_t stored[32]);

// a message (a channel's bytes on a topic, littlesync's say; seal.ts's sealMessage), sealed so its sender
// is the key that signed it, not the connection it came on. The sealed message is the canonical map
// {bytes, signer, signature}, the signer's multikey in it. What is signed is "ermine/v0/message", the
// BLAKE3 of the bytes, the signature's header, then the topic's bytes (the rest): a seal is good on its
// own topic only. A topic is 1 to SL_TOPIC bytes
#define SL_TOPIC 256
// the sealed message's bytes, malloc'd into *out (free it). SL_SHAPE: a topic that is not one, or the
// signature sign gave no bytes, or too many
sl_code sl_seal_message(const char *topic, const uint8_t *bytes, size_t length, const sl_signer *signer, uint8_t **out,
	size_t *out_length);
// a message opened: its signer (a multikey) and its bytes (malloc'd: sl_message_free)
typedef struct {
	uint8_t signer[CM_SIGNER_MAX];
	size_t signer_length;
	uint8_t *bytes;
	size_t length;
	// on SL_SIGNATURE: why, a static string
	const char *reason;
} sl_message;
// the message, checked for the topic. SL_SHAPE: not a map of exactly bytes, signer and signature (each
// bytes), a signer not a multikey, a signature not the size its verifier says, a topic that is not one.
// SL_SIGNATURE as sl_unseal. sl_message_free it on SL_OK
sl_code sl_open_message(const uint8_t *sealed, size_t length, const char *topic, sl_message *out, const sl_verifiers *more);
void sl_message_free(sl_message *m);

#endif
