// a write as it leaves the graph and travels: the patches that landed on one part of one node,
// the change that made them, and, given here, a name and parents. the graph's writes have neither
// (core/node's ChangeHeader, places' Fact); naming them is this experiment's history's (history.ts),
// one way of doing it, not the system's
//
// name: the blake3 of the write's canonical CBOR (node, part, parents, patches, change), as hex.
// two holders holding one write hold the same name, so a union is a union of names
import { blake3 } from "@ermine/blake3"
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { ChangeHeader } from "@ermine/node/entry"
import type { Patch } from "@ermine/op/apply"
import type { Key } from "@ermine/table"

// what of a change travels: the header without its op (the op is the patches, given beside it)
export type Change = Omit<ChangeHeader, "op">

export type Write = {
	readonly name: string
	readonly node: string
	readonly part: Key
	// the names of the writes this one was made on top of, sorted; none: the part's first
	readonly parents: readonly string[]
	readonly patches: readonly Patch[]
	readonly change: Change
}

export type Unnamed = Omit<Write, "name">

const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

// an object with its undefined fields left out: CBOR has no undefined in a map
function defined<T extends object>(x: T): T {
	return Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as T
}

// what is named: the write without its name, in the one shape every side encodes
function content(w: Unnamed) {
	return {
		node: w.node,
		part: w.part,
		parents: [...w.parents].sort(),
		patches: w.patches.map((p) => defined({ ...p, move: p.move && defined({ ...p.move }) })),
		change: defined({ ...w.change }),
	}
}

// the write named, as a fresh value read back from its encoding: nothing in it is shared with what
// was given, so a value changed in place later (places' children, written through unread) never
// changes a named write. a value with no encoding (a function, a symbol): CborError
export function name(w: Unnamed): Write {
	const bytes = encode(content(w) as unknown as Value)
	return { name: hex(blake3(bytes)), ...(decode(bytes) as unknown as Unnamed) }
}

// whether the write's name is its content's
export function named(w: Write): boolean {
	try {
		return name(w).name === w.name
	} catch {
		return false
	}
}

// a fresh copy, read back from its encoding (what lands in a graph: see name)
export function fresh<T>(x: T): T {
	return decode(encode(x as unknown as Value)) as unknown as T
}

// whether two values encode the same; either with no encoding: not
export function same(a: unknown, b: unknown): boolean {
	if (a === undefined || b === undefined) return a === b
	try {
		const x = encode(a as Value), y = encode(b as Value)
		return x.length === y.length && x.every((v, i) => v === y[i])
	} catch {
		return false
	}
}
