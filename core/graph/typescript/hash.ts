// Hashes of bytes: BLAKE3 (32 bytes), as Subduction's digests are, written as
// 64 lowercase hex digits. From @noble/hashes: pure TypeScript and
// synchronous, so a write stays a synchronous operation; crypto.subtle's
// SHA-256 is asynchronous only. Sync's commits (layers/subduction) and the cache
// (layers/cache) both name things by it.

// deno-lint-ignore no-import-prefix
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3";

/** A hash, as 64 lowercase hex digits: bytewise order is string order. */
export type Hash = string;

export function hex(bytes: Uint8Array): Hash {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** The BLAKE3 hash of bytes. */
export function digest(bytes: Uint8Array): Hash {
  return hex(blake3(bytes));
}
