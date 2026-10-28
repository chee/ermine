// a world's graph as a file (the 💾 save graph button; examples/lab-load drops one back in): every
// node the root reaches through children, each table at each id, packed (ermine/encoding's pack).
//
// the world is in its iframe, another realm: cbor would take its maps and lists for live values,
// so every node is saved as a copy made here, nothing in the world changed. a live value (a
// function, an element, a Map, undefined in a list…) cannot be carried: a stand-in (cbor's Stand)
// saying what it was goes in its place, in a value and in a change (functions, symbols and class
// objects by pack's live option, the rest by the copy). a field holding undefined is
// left out, as pack leaves it. a symbol id cannot be carried either: its name is left out of the
// children it was in, and it is not reached
import { type Entry, pack, unpack } from "@ermine/formats/pack"
import { Stand } from "@ermine/encoding/cbor"
import type { ChangeHeader, Entry as Node } from "@ermine/core/node/entry"
import type { Id, Key, Table } from "@ermine/core/table"

export type Saved = {
	bytes: Uint8Array
	// ids reached, nodes written (one node under several keys is one)
	ids: number
	nodes: number
	// each stand-in's kind, and how many, most first
	stands: [string, number][]
	// names left out: their id was a symbol
	symbols: number
}

// the typed arrays cbor carries, by name: one from the iframe is made again as this realm's
const TYPED: Record<string, new (from: ArrayLike<never>) => ArrayBufferView> = {
	Uint8Array,
	Uint16Array,
	Uint32Array,
	BigUint64Array,
	Int8Array,
	Int16Array,
	Int32Array,
	BigInt64Array,
	Float32Array,
	Float64Array,
} as never

const isMap = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x)

// root: the world's root id (places.root, a fresh id per world). it is written as "root", so a file
// says which node is its root whatever the id was
export function save(table: Pick<Table, "get">, root: Id = "root"): Saved {
	const stands = new Map<string, number>()
	let symbols = 0
	// something left out that leaves no stand-in to count
	const note = (kind: string) => void stands.set(kind, (stands.get(kind) ?? 0) + 1)
	const live = (kind: string) => new Stand(kind)

	// a value as cbor holds it, made in this realm
	function carry(x: unknown, open = new Set<object>()): unknown {
		switch (typeof x) {
			case "string":
				return x.isWellFormed() ? x : live("string with a lone surrogate")
			case "number":
			case "boolean":
				return x
			case "undefined":
				return live("undefined")
			case "bigint":
				return live(`bigint ${x}`)
			// pack's live option makes these stand-ins
			case "symbol":
			case "function":
				return x
		}
		if (x === null) return x
		const o = x as object
		const name = (o.constructor as { name?: string } | undefined)?.name
		if (ArrayBuffer.isView(o)) {
			const make = name === undefined ? undefined : TYPED[name]
			return make ? new make(o as never) : live(name ?? "typed array")
		}
		// a stand-in already (a graph loaded from a file): its class is another realm's
		if (name === "Stand" && "kind" in o) return new Stand(carry(o.kind, open) as never)
		if (open.has(o)) return live("cycle")
		const proto = Object.getPrototypeOf(o)
		const plain = proto === null || Object.getPrototypeOf(proto) === null
		if (!Array.isArray(o) && !plain) return o
		open.add(o)
		let out: unknown
		if (Array.isArray(o)) out = o.map((v) => carry(v, open))
		else {
			const copy: Record<string, unknown> = {}
			for (const k of Object.getOwnPropertySymbols(o)) note(`${k.toString()} key`)
			for (const [k, v] of Object.entries(o)) if (v !== undefined) copy[k] = carry(v, open)
			out = copy
		}
		open.delete(o)
		return out
	}

	// a children entry's value: a name whose id is a symbol is left out
	function children(v: unknown): unknown {
		if (!isMap(v)) return carry(v)
		const out: Record<string, unknown> = {}
		for (const [name, id] of Object.entries(v)) {
			if (typeof id === "symbol") symbols++
			else if (id !== undefined) out[name] = carry(id === root ? "root" : id)
		}
		return out
	}

	const copies = new Map<Node<unknown>, Node<unknown>>()
	function copy(n: Node<unknown>, part: Key): Node<unknown> {
		let c = copies.get(n)
		if (c) return c
		const change = carry(n.change) as ChangeHeader
		if (change.reader !== undefined && typeof change.reader !== "string") {
			delete change.reader
			note("reader not a string")
		}
		c = { change }
		if (n.value !== undefined) c.value = part === "children" ? children(n.value) : carry(n.value)
		copies.set(n, c)
		return c
	}

	const out: Entry[] = []
	const ids: Id[] = [root], seen = new Set<Id>(ids)
	for (let i = 0; i < ids.length; i++) {
		for (const [part, n] of table.get(ids[i])) {
			out.push([part, ids[i] === root ? "root" : ids[i], copy(n, part)])
			if (part !== "children" || !isMap(n.value)) continue
			for (const id of Object.values(n.value)) {
				if (typeof id === "string" && !seen.has(id)) seen.add(id), ids.push(id)
			}
		}
	}
	const bytes = pack(out, { live: true })
	// the stand-ins written, by kind: read back, each node once
	const counted = new Set<object>()
	const count = (x: unknown) => {
		if (x === null || typeof x !== "object" || ArrayBuffer.isView(x) || counted.has(x)) return
		counted.add(x)
		if (x instanceof Stand) note(String(x.kind))
		for (const v of x instanceof Stand ? [x.kind] : Object.values(x)) count(v)
	}
	for (const [, , node] of unpack(bytes)) count(node)
	return {
		bytes,
		ids: ids.length,
		nodes: copies.size,
		stands: [...stands].sort((a, b) => b[1] - a[1]),
		symbols,
	}
}
