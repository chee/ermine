// a holder: somewhere named writes live outside a graph's memory (another graph's history, memory,
// a file, a folder). what it holds and how is its own; a link (link.ts) asks every holder the same
// five things
import type { Write } from "./write.ts"

// where a reader of a holder has got to: the holder's own, opaque to everyone else. none: the start
export type Cursor = unknown

// what is new since a cursor: the writes, in an order where parents come first, and the cursor
// after them. more: the limit stopped it short, ask again
export type Since = { writes: Write[]; cursor: Cursor; more: boolean }

// what a holder did with one write put: took it (new here), passed it (held already) or refused it
// (why: a word, then anything after a colon)
export type Outcome = "taken" | "passed" | { refused: string }

export type Holder = {
	// what is new since cursor, at most limit writes. none: this holder can't list what it holds
	// (it can only be asked by node, with get)
	since?(cursor?: Cursor, limit?: number): Promise<Since>
	// every write it holds of one node, parents first. none: it can't be asked by node
	get?(node: string): Promise<Write[]>
	// one outcome for each write, in order. never throws
	put(writes: readonly Write[]): Promise<Outcome[]>
	// let go of everything it holds of one node
	drop(node: string): Promise<void>
	// poke told whenever since would give something new; gives back the stop
	watch(poke: () => void): () => void
}

// the refusals every holder makes the same way (log.ts): the name is not the content's, or a parent
// is not held here (every holder holds a write's parents before it, so since can give parents first)
export const MISNAMED = "misnamed"
export const ORPHAN = "missing-parents"
