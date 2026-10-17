// invert's streams: apply's (./apply.ts), asked as invert: the undo of the first k patches of a
// batch, and of the batch with a refused patch put in where it fell. apply's properties
import type { Generator } from "./kit.ts"
import { invariant, streams } from "./apply.ts"

export default { streams: streams("invert"), invariant } satisfies Generator
