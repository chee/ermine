// A channel named by a word: its 64 hex digits are the SHA-256 of the UTF-8
// text "ermine channel:" and the name, so every host that is given the same
// name, in any language, finds the same channel. Anyone who knows the name
// can join it; a name is a meeting place, not a secret.

import { sha256 } from "npm:@noble/hashes@1.8.0/sha256";
import { ours } from "../types.ts";

ours(import.meta.url);

/** The channel for a name: hex of sha256("ermine channel:" + name). */
export function named(name: string): string {
  const bytes = sha256(new TextEncoder().encode("ermine channel:" + name));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A channel as given: 64 hex digits stand for themselves; anything else is a name. */
export function channelOf(given: string): string {
  const t = given.trim();
  return /^[0-9a-f]{64}$/i.test(t) ? t.toLowerCase() : named(t);
}
