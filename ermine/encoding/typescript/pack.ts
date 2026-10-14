// nodes under keys of a part and an id (the table's), as one item in the canonical encoding
// (cbor.ts), and back. which nodes is the caller's: a walk, an id's parts, a whole table; nothing
// is loaded or placed here. places are derived from the children nodes, never packed.
//
// a symbol anywhere, in a key or in a node, cannot be carried: getting rid of them first is the
// caller's.
//
// written: {keys: [[part, id, n], …], nodes: [node, …]}. keys: sorted by their encodings, none
// twice; n: the node's place in nodes, numbered in the order the keys first name them, so a node
// under several keys is one node again when read. a node: {change, value?, cow?}, cow only ever
// false, as the node has it (changed in place, not copied on write). a change: {time,
// actor?, reader?, external?, metadata?, op?}; external: sites {file, line, column?, function?};
// metadata: [name, value] lists; op: {patches, undo}, each patch {path, range?, value?, move?},
// move {path, range?}. time, a site's line and column, a path's numbers and a range's ends are
// whole: safe integers, never -0. a field not there is left out, never written as nothing; no
// other key.
// reading takes exactly what writing gives; loosyGoosy, a key it does not know is passed over
import * as cbor from "./cbor.ts"
import createEntry, { type ChangeHeader, type Entry as NodeEntry } from "@ermine/node/entry"
import type { Patch, Target } from "@ermine/op/apply"
import type { FileLocation } from "@ermine/util/stacktrace"

export type Key = string | symbol

// a node under a key: what pack is given and unpack gives
export type Entry = readonly [part: Key, id: Key, node: NodeEntry<unknown>]

export type Options = {
	// false: a change's op (its latest patches and their undo) is not written. default true
	op?: boolean
}

export type Reading = {
	// a key no map of a pack has is passed over, in every map, not refused. default false
	loosyGoosy?: boolean
}

export type Code = "not-a-pack" | "not-a-node" | "cannot-carry" | "already-there"

export class PackError extends Error {
	// the key at fault, as far as there was one
	constructor(readonly code: Code, readonly part?: Key, readonly id?: Key) {
		super([code, part, id].filter((x) => x !== undefined).map(String).join(" "))
	}
}

type Fields = { [k: string]: cbor.Value }

function target(t: Target): Fields {
	const out: Fields = { path: t.path as cbor.Value }
	if (t.range !== undefined) out.range = t.range as cbor.Value
	return out
}

function patch(p: Patch): Fields {
	const out = target(p)
	if (p.value !== undefined) out.value = p.value as cbor.Value
	if (p.move !== undefined) out.move = target(p.move)
	return out
}

function site(s: FileLocation): Fields {
	const out: Fields = { file: s.file, line: s.line }
	if (s.column !== undefined) out.column = s.column
	if (s.function !== undefined) out.function = s.function
	return out
}

function change(h: ChangeHeader, o: Options): Fields {
	const out: Fields = { time: h.time }
	if (h.actor !== undefined) out.actor = h.actor as cbor.Value
	if (h.reader !== undefined) out.reader = h.reader
	if (h.external !== undefined) out.external = h.external.map(site)
	if (h.metadata !== undefined) out.metadata = h.metadata as cbor.Value
	if (h.op !== undefined && o.op !== false) {
		out.op = { patches: h.op.patches.map(patch), undo: h.op.undo.map(patch) }
	}
	return out
}

// a node as written
function written(n: NodeEntry<unknown>, o: Options): Fields {
	const out: Fields = { change: change(n.change, o) }
	if (n.value !== undefined) out.value = n.value as cbor.Value
	if (n.cow === false) out.cow = false
	return out
}

// reading -------------------------------------------------------------------

const isFields = (x: unknown): x is Fields =>
	x !== null && typeof x === "object" && !Array.isArray(x) && !ArrayBuffer.isView(x) &&
	!(x instanceof cbor.Stand)

// a whole number C holds too: a safe integer, never -0
const whole = (x: unknown) => Number.isSafeInteger(x) && !Object.is(x, -0)

const isSpan = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every(whole)
const isPath = (x: unknown) => Array.isArray(x) && x.every((e) => typeof e === "string" || whole(e))
const isEntry = (x: unknown) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string"

// how a map is read: every key of need there, and, unless loose, none but those of may
class Reader {
	constructor(readonly loose: boolean) {}

	only(x: Fields, need: string[], may: string[]): boolean {
		for (const k of need) if (!Object.hasOwn(x, k)) return false
		if (!this.loose) { for (const k of Object.keys(x)) if (!may.includes(k)) return false }
		return true
	}

	// a target's fields read, only those
	target(x: unknown, also: string[]): Target | undefined {
		if (!isFields(x) || !this.only(x, ["path"], ["path", "range", ...also])) return
		if (!isPath(x.path) || ("range" in x && !isSpan(x.range))) return
		const t: { path: Target["path"]; range?: Target["range"] } = {
			path: x.path as unknown as Target["path"],
		}
		if ("range" in x) t.range = x.range as unknown as Target["range"]
		return t
	}

	patch(x: unknown): Patch | undefined {
		const p: Patch | undefined = this.target(x, ["value", "move"])
		if (p === undefined) return
		const f = x as Fields
		if ("value" in f) p.value = f.value
		if ("move" in f) {
			const m = this.target(f.move, [])
			if (m === undefined) return
			p.move = m
		}
		return p
	}

	site(x: unknown): FileLocation | undefined {
		if (!isFields(x) || !this.only(x, ["file", "line"], ["file", "line", "column", "function"])) {
			return
		}
		if (typeof x.file !== "string" || !whole(x.line)) return
		const s: FileLocation = { file: x.file, line: x.line as number }
		if ("column" in x) {
			if (!whole(x.column)) return
			s.column = x.column as number
		}
		if ("function" in x) {
			if (typeof x.function !== "string") return
			s.function = x.function
		}
		return s
	}

	// each read by f; none when one is not
	all<T>(x: unknown, f: (e: unknown) => T | undefined): T[] | undefined {
		if (!Array.isArray(x)) return
		const out: T[] = []
		for (const e of x) {
			const t = f(e)
			if (t === undefined) return
			out.push(t)
		}
		return out
	}

	// a change as written; none when it is not one
	header(x: unknown): ChangeHeader | undefined {
		const may = ["time", "actor", "reader", "external", "metadata", "op"]
		if (!isFields(x) || !this.only(x, ["time"], may) || !whole(x.time)) return
		const h = { time: x.time as number } as ChangeHeader
		if ("actor" in x) h.actor = x.actor
		if ("reader" in x) {
			if (typeof x.reader !== "string") return
			h.reader = x.reader
		}
		if ("external" in x) {
			const sites = this.all(x.external, (e) => this.site(e))
			if (sites === undefined) return
			h.external = sites
		}
		if ("metadata" in x) {
			if (!Array.isArray(x.metadata) || !x.metadata.every(isEntry)) return
			h.metadata = x.metadata as unknown as [string, unknown][]
		}
		if ("op" in x) {
			const op = x.op
			if (!isFields(op) || !this.only(op, ["patches", "undo"], ["patches", "undo"])) return
			const patches = this.all(op.patches, (e) => this.patch(e))
			const undo = this.all(op.undo, (e) => this.patch(e))
			if (patches === undefined || undo === undefined) return
			h.op = { patches, undo }
		}
		return h
	}

	// a node as written, new; none when it is not one
	node(x: unknown): NodeEntry<unknown> | undefined {
		if (!isFields(x) || !this.only(x, ["change"], ["change", "value", "cow"])) return
		if ("cow" in x && x.cow !== false) return
		const h = this.header(x.change)
		if (h === undefined) return
		return createEntry<unknown>(x.value, h, "cow" in x ? { cow: false } : {})
	}
}

const STRICT = new Reader(false), LOOSE = new Reader(true)
const reader = (r: Reading) => r.loosyGoosy ? LOOSE : STRICT

// writing -------------------------------------------------------------------

// a node's encoding: anything not a value in it, or a change that is not one, is cannot-carry at
// the key given
function bytes(n: NodeEntry<unknown>, o: Options, part?: string, id?: string): Uint8Array {
	const w = written(n, o)
	if (STRICT.header(w.change) === undefined) throw new PackError("cannot-carry", part, id)
	try {
		return cbor.encode(w)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError("cannot-carry", part, id)
		throw e
	}
}

function compare(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

// a key's encoding, its order; a string with a lone surrogate: cannot-carry
function keyed(part: string, id: string): Uint8Array {
	try {
		return cbor.encode([part, id])
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError("cannot-carry", part, id)
		throw e
	}
}

const LIST = (n: number): Uint8Array =>
	n < 24
		? Uint8Array.of(0x80 | n)
		: n < 0x100
		? Uint8Array.of(0x98, n)
		: n < 0x10000
		? Uint8Array.of(0x99, n >> 8, n & 0xff)
		: Uint8Array.of(0x9a, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)

function cat(xs: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0))
	let at = 0
	for (const x of xs) out.set(x, at), at += x.length
	return out
}

// "keys" sorts before "nodes": a map of two, the one way
const HEAD = cat([Uint8Array.of(0xa2), cbor.encode("keys")])
const NODES = cbor.encode("nodes")

// the nodes under their keys, as one item; the same key twice with two nodes: already-there; a
// key with a symbol: cannot-carry, that key, the first given; a node that cannot be carried:
// cannot-carry, its first key
export function pack(entries: Iterable<Entry>, options: Options = {}): Uint8Array {
	type Row = { part: string; id: string; node: NodeEntry<unknown>; key: Uint8Array }
	const rows: Row[] = []
	for (const [part, id, node] of entries) {
		if (typeof part !== "string" || typeof id !== "string") {
			throw new PackError("cannot-carry", part, id)
		}
		rows.push({ part, id, node, key: keyed(part, id) })
	}
	rows.sort((a, b) => compare(a.key, b.key))
	const numbers = new Map<NodeEntry<unknown>, number>()
	const nodes: Uint8Array[] = [], keys: cbor.Value[] = []
	let last: Row | undefined
	for (const r of rows) {
		if (last !== undefined && compare(last.key, r.key) === 0) {
			if (last.node !== r.node) throw new PackError("already-there", r.part, r.id)
			continue
		}
		last = r
		let n = numbers.get(r.node)
		if (n === undefined) {
			numbers.set(r.node, n = nodes.length)
			nodes.push(bytes(r.node, options, r.part, r.id))
		}
		keys.push([r.part, r.id, n])
	}
	return cat([HEAD, cbor.encode(keys), NODES, LIST(nodes.length), ...nodes])
}

// one node alone, as a pack writes each node
export function encode(node: NodeEntry<unknown>, options: Options = {}): Uint8Array {
	return bytes(node, options)
}

function decoded(b: Uint8Array, code: Code): unknown {
	try {
		return cbor.decode(b)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError(code)
		throw e
	}
}

// the nodes under their keys, in the keys' order, new nodes made with createEntry: one node for
// each written, under every key that names it. putting them in a table is the caller's
export function unpack(b: Uint8Array, reading: Reading = {}): Entry[] {
	const r = reader(reading)
	const no = () => new PackError("not-a-pack")
	const x = decoded(b, "not-a-pack")
	if (!isFields(x) || !r.only(x, ["keys", "nodes"], ["keys", "nodes"])) throw no()
	if (!Array.isArray(x.keys) || !Array.isArray(x.nodes)) throw no()
	const nodes: NodeEntry<unknown>[] = []
	for (const f of x.nodes) {
		const n = r.node(f)
		if (n === undefined) throw no()
		nodes.push(n)
	}
	const out: Entry[] = []
	let next = 0, last: Uint8Array | undefined
	for (const k of x.keys) {
		if (!Array.isArray(k) || k.length !== 3) throw no()
		const [part, id, n] = k
		if (typeof part !== "string" || typeof id !== "string") throw no()
		// numbered in the order first named
		if (typeof n !== "number" || !Number.isInteger(n) || Object.is(n, -0)) throw no()
		if (n < 0 || n > next || n >= nodes.length) throw no()
		if (n === next) next++
		// sorted, none twice
		const key = cbor.encode([part, id])
		if (last !== undefined && compare(last, key) >= 0) throw no()
		last = key
		out.push([part, id, nodes[n]])
	}
	// every node under a key
	if (next !== nodes.length) throw no()
	return out
}

// one node back, as encode wrote it
export function decode(b: Uint8Array, reading: Reading = {}): NodeEntry<unknown> {
	const n = reader(reading).node(decoded(b, "not-a-node"))
	if (n === undefined) throw new PackError("not-a-node")
	return n
}
