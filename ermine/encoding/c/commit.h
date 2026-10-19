// One entry change as one item in the canonical encoding (cbor.h), and back (ermine/encoding/
// typescript/commit.ts), in C: what sync stores and sends for a node. The shape only: no hashing but
// its name, no signing, no parents looked up. Same bytes and same refusals as commit.ts.
//
// A commit is a cm_commit: the change header as the graph has it (node.h's ch_header, never an op),
// and the rest. The rules are written once, on a value in its Json form (json.h): cm_check. A
// commit that is encoded is checked there, one that is decoded is checked there, and so is a
// pack's column, made into a commit (packer.h). cm_encode writes a cm_commit with no Json made when
// the same rules, on its fields, take it; what they refuse goes to its Json form, which names the field. Out of memory aborts, as elsewhere. Nothing recurses
// on a value's depth.
#ifndef CM_COMMIT_H
#define CM_COMMIT_H

#include "json.h"
#include "../../../core/node/c/node.h"

#include <stddef.h>
#include <stdint.h>

typedef enum {
	CM_OK,
	CM_NOT_A_COMMIT,
	CM_CANNOT_CARRY,
} cm_code;
// the TypeScript code of a return: "not-a-commit", "cannot-carry"; "" for CM_OK
const char *cm_code_name(cm_code code);

// the field a refusal names, if it names one: free(*field) when set. Every function that takes a
// char **field sets *field (NULL when no field is named) unless field is NULL
// not-a-commit names the first thing that says no: a key no commit has (of several, the first in
// canonical order; only cm_encode and cm_check refuse one, cm_decode leaves it out), else the first field in the table's order that is missing or wrong; none for
// what is no map. cannot-carry names the first field holding what has no encoding (a string that is
// not UTF-8, a symbol), none if none is found alone

// a signer is a multikey: the unsigned varint of the key type's multicodec code (shortest form, 1 to 7
// bytes), then the raw key (1 byte or more), CM_SIGNER_MAX bytes in all. Ed25519: 0xed 0x01, then 32
// bytes. Only a verifier needs to know what a type is (cm_key_split says the code, and where the key is)
#define CM_SIGNER_MAX 1024
// a multikey's code and raw key (a pointer into it); 0 when the bytes are none
int cm_key_split(const uint8_t *bytes, size_t length, uint64_t *code, const uint8_t **key, size_t *key_length);
// a multikey from the code and the raw key, into out (CM_SIGNER_MAX bytes at most): how long it is
size_t cm_key_join(uint64_t code, const uint8_t *key, size_t key_length, uint8_t *out);

// a name is a multihash: the unsigned varint of the hash's multicodec code, the varint of its digest's
// length, then the digest (each varint in its shortest form). The hashes known: BLAKE3, code 0x1e,
// 32 bytes of digest; a name of any other code, or of a length that is not its code's, is no name.
// CM_NAME: the bytes of a BLAKE3 name, 0x1e 0x20, then the digest
#define CM_NAME 34
#define CM_BLAKE3 0x1e
// a name's code and digest (a pointer into it); 0 when the bytes are no name
int cm_name_split(const uint8_t *bytes, size_t length, uint64_t *code, const uint8_t **digest, size_t *digest_length);
// a name from the code and the digest, into out (CM_NAME bytes at most): how long it is
size_t cm_name_join(uint64_t code, const uint8_t *digest, size_t digest_length, uint8_t *out);

// what a patch replaces: the names of the writes at or under its path its writer held and means to
// replace. has 0: absent, ancestry decides (an older commit's); has 1, length 0: none
typedef struct {
	int has;
	const uint8_t (*names)[CM_NAME];
	size_t length;
} cm_replaces;

// a decoded commit. Everything it refers to is its own (cm_free), shared with nothing
typedef struct {
	char *table;
	// time, actor (an op_value *, null when null), reader, external, metadata: a header is there as
	// the graph has it. external and metadata are NULL when absent (not an empty list). metadata:
	// a map's entries, keys unique, in canonical order; read from the old form too, a list of [key,
	// value] pairs (of a key repeated, the first). cm_encode writes a map, its keys unique (the
	// caller's to keep)
	ch_header change;
	uint8_t signer[CM_SIGNER_MAX];
	size_t signer_length;
	int64_t nonce;
	// ascending by name
	const uint8_t (*parents)[CM_NAME];
	size_t parents_length;
	// with several parents: the one its patches are over. None needed when every patch is a key patch
	// (a set or a delete at a path of keys: no range, move or list index)
	int has_base;
	uint8_t base[CM_NAME];
	// with several parents and no base: a merge rule's name; NULL when absent
	char *merge;
	int64_t lamport;
	op_patch *patches;
	size_t patches_length;
	// each patch's, patches_length of them; NULL: absent in every patch
	const cm_replaces *replaces;
	void *own;
} cm_commit;

// the commit's bytes, malloc'd into *out (free it). CM_NOT_A_COMMIT (a field wrong, or a parents or
// base that cannot be) or CM_CANNOT_CARRY (a value with no encoding): *field. The commit is as a
// cm_commit holds it: cm_encode of a decoded one gives its bytes (one with metadata in the old form:
// the bytes of the map)
cm_code cm_encode(const cm_commit *commit, uint8_t **out, size_t *length, char **field);
// the same from a commit in its Json form: a map of the fields commit.ts names, byte fields JSON_BYTES.
// Anything but a map: CM_NOT_A_COMMIT, no field. Borrowed, not changed
cm_code cm_encode_json(const Json *commit, uint8_t **out, size_t *length, char **field);
// the rules alone, on a commit in its Json form: CM_OK or CM_NOT_A_COMMIT (*field)
cm_code cm_check(const Json *commit, char **field);
// the same as cm_decode holds a commit to: a key no commit has is left alone
cm_code cm_check_decoded(const Json *commit, char **field);

// the commit back from its bytes; only the canonical encoding. A top-level key no commit has is a
// later device's: left out, the commit taken. Its signature and name are over the bytes, so keep
// them as they came: cm_encode of a decoded commit does not have the key. CM_NOT_A_COMMIT: bytes
// that are no canonical item, no map, or a field the rules say no to (*field). cm_free it
cm_code cm_decode(const uint8_t *bytes, size_t length, cm_commit *out, char **field);
// the commit as its Json form: a fresh value; NULL when a value in it has no Json form
Json *cm_to_json(const cm_commit *commit);
void cm_free(cm_commit *commit);

// the BLAKE3 hash of the bytes, 32 bytes: raw, what hashes anything but a commit's name (a stored id, a
// topic, a payload)
void cm_digest(const uint8_t *bytes, size_t length, uint8_t out[32]);
// the commit's name on every device: the BLAKE3 hash of its bytes, as a multihash (CM_NAME bytes)
void cm_name(const uint8_t *bytes, size_t length, uint8_t name[CM_NAME]);
// bytewise, a shorter one first when it is a prefix: negative, 0, positive
int cm_compare(const uint8_t *a, size_t a_length, const uint8_t *b, size_t b_length);

#endif
