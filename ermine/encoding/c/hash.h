// a value's name: the BLAKE3 hash of its canonical CBOR (cbor.h), the same on every device and in
// TypeScript (typescript/hash.ts). 32 bytes. false when the value has no encoding, with why
#ifndef ERMINE_HASH_H
#define ERMINE_HASH_H

#include <stdbool.h>
#include <stdint.h>

#include "json.h"

bool hashValue(const Json *value, uint8_t out[32], const char **why);

#endif
