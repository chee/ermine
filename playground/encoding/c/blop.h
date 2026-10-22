// A change as bytes (newcore/encoding/BLOP.tex), in C. Same shape as blop.ts: one change to one
// object of a node, with its patches, as one canonical CBOR item, and back. The shape only: no
// hashing but its name, no signing, no parents looked up. A blop is a json.h object; its signer,
// nonce, parents and base are bytes (JSON_BYTES), a typed array there is the wrong kind.
#ifndef BLOP_H
#define BLOP_H

#include "../../../ermine/encoding/c/json.h"

#include <stddef.h>
#include <stdint.h>

typedef enum {
	BLOP_OK,
	BLOP_CANNOT_CARRY,
	BLOP_NOT_A_BLOP,
} blop_code;

// what went wrong: the code, and the key at fault, a new string (free it), NULL when none
typedef struct {
	blop_code code;
	char *field;
} blop_error;

// the blop's bytes, malloc'd into *out (free it), *length long. Fails with the first fault found,
// in BLOP.tex's order
blop_error blop_encode(const Json *blop, uint8_t **out, size_t *length);
// the blop back, a new value (jsonFree it). Anything but the canonical encoding of a blop:
// BLOP_NOT_A_BLOP
blop_error blop_decode(const uint8_t *bytes, size_t length, Json **blop);
// the change's name: the BLAKE3 hash of any bytes; never fails
void blop_name(const uint8_t *bytes, size_t length, uint8_t name[32]);

#endif
