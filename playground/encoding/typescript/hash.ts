// a value's name: the BLAKE3 hash of its canonical CBOR (cbor.ts), the same on every device and in
// C (c/hash.h). 32 bytes
import { blake3 } from "@ermine/blake3"
import { encode, type Value } from "@ermine/encoding/cbor"

export const hash = (value: Value): Uint8Array => blake3(encode(value))
