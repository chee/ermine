// invert's streams: apply's, asked as invert.
import type { Generator } from "./kit.ts"
import { invariant, streams } from "./apply.ts"

export default { streams: streams("invert"), invariant } satisfies Generator
