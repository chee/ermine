// the well-known UTIs are Markus Felten's (arlac77), from his uti library, with thanks: the list
// itself, word for word, is well-known-utis.mjs (npm uti@8.11.3, 149 entries), its licence beside it
// (well-known-utis.LICENSE, 0BSD). types.ts adds what it lacks (EXTRA)
import type { Known } from "./types.ts"
import list from "./well-known-utis.mjs"

export const KNOWN: readonly Known[] = list
