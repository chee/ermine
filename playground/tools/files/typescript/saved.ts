// The node the files store saves (FILES.tex): an id with versions of its value, of each info
// name and of each child name's list of ids, a change and why each is there, and the graph
// from a root of them, as bytes in the canonical encoding. The files store speaks this shape
// whatever shape the graph a host keeps has (core's node is a table name's entries, with no
// versions); a host turns between the two. Nothing is loaded or placed here.
import * as cbor from "@ermine/encoding/cbor"

// where in code something was made
export type Site = { file: string; line: number; column?: number; function?: string }

// one version of an object: its content, the change that made it, why it is there
// change and because: the caller's, never read here
// content is absent (undefined at runtime) in a version that is a removal among racing heads
// (sync/APPLY.tex); readers that take every version guard it
export type Side<C, H> = { content: C; change: H; because?: unknown }

// a list: ids in order, and symbols, which name no node
export type List = readonly (string | symbol)[]

export type Node<V, H> = {
	id: string
	value: Side<V, H>[]
	attributes: Map<string, Side<V, H>[]>
	children: Map<string, Side<List, H>[]>
	// about it being made; the caller's, not copied: never change it. Given back as is when a node
	// comes back from storage
	change: ChangeHeader
}

// a change header's fields; which are required is checked above
export type ChangeHeader = {
	time?: number
	actor?: unknown
	reader?: string
	// where in code it was made
	site?: Site
	cause?: unknown
	// the author's clock, whole seconds since 1970, and a message (CHANGE.tex)
	wallclock?: number
	message?: string
}

// entries in order, as new Map takes them
export type Contents<V, H> = {
	value?: Side<V, H>[]
	attributes?: Iterable<readonly [string, Side<V, H>[]]>
	children?: Iterable<readonly [string, Side<List, H>[]]>
}

export type Options = {
	header?: ChangeHeader
}

// kept by the caller; nothing checked: checks are a layer above's
export default function createNode<V, H>(
	id: string,
	contents: Contents<V, H> = {},
	options: Options = {},
): Node<V, H> {
	const change: ChangeHeader = options.header ?? {}
	return {
		id,
		change: change,
		attributes: new Map(contents.attributes ?? []),
		children: new Map(contents.children ?? []),
		value: contents.value ?? [],
	}
}

// pack ---------------------------------------------------------------------------

// get: the node of an id, or none if it is not loaded (table.ts's get)
export type Get<V, H> = (id: string) => Node<V, H> | undefined

// root: the id walked from; nodes: the root first, then in the order reached;
// missing: ids in a list reached but not loaded, in the order reached
export type Graph<V, H> = { root: string; nodes: Node<V, H>[]; missing: string[] }

export type Code = "nothing-there" | "cannot-carry" | "not-a-graph" | "not-a-node"

export class PackError extends Error {
	constructor(readonly code: Code, readonly id?: string) {
		super(id === undefined ? code : `${code} (${id})`)
	}
}

// the root and every node reachable from it; the root not loaded: nothing-there
export function walk<V, H>(root: string, get: Get<V, H>): Graph<V, H> {
	const first = get(root)
	if (first === undefined) throw new PackError("nothing-there", root)
	const nodes: Node<V, H>[] = [first], missing: string[] = []
	const seen = new Set([root])
	for (let i = 0; i < nodes.length; i++) {
		for (const versions of nodes[i].children.values()) {
			for (const v of versions) {
				for (const id of v.content) {
					if (typeof id !== "string" || seen.has(id)) continue
					seen.add(id)
					const n = get(id)
					if (n === undefined) missing.push(id)
					else nodes.push(n)
				}
			}
		}
	}
	return { root, nodes, missing }
}

type Fields = { [k: string]: cbor.Value }

// a field not there is left out, never written as nothing
function defined(o: object): Fields {
	const out: Fields = {}
	for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v as cbor.Value
	return out
}
const versions = <C, H>(vs: Side<C, H>[]) => vs.map(defined)

// a node as written: id, value, info and children as entries in order, header
function written<V, H>(n: Node<V, H>): Fields {
	return {
		id: n.id,
		value: versions(n.value),
		info: [...n.attributes].map(([name, vs]) => [name, versions(vs)]),
		children: [...n.children].map(([name, vs]) => [name, versions(vs)]),
		header: defined(n.change),
	}
}

// what the encoding cannot carry (a symbol in a list, a function, a Map): cannot-carry
function encoded(x: cbor.Value, id?: string): Uint8Array {
	try {
		return cbor.encode(x)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError("cannot-carry", id)
		throw e
	}
}

// the graph from root as one item, {root, nodes, missing}; cannot-carry: the node's id
export function pack<V, H>(root: string, get: Get<V, H>): Uint8Array {
	const { nodes, missing } = walk(root, get)
	const ws = nodes.map(written)
	try {
		return cbor.encode({ root, nodes: ws, missing })
	} catch (e) {
		if (!(e instanceof cbor.CborError)) throw e
		// which: each again, only when one failed
		for (let i = 0; i < ws.length; i++) encoded(ws[i], nodes[i].id)
		throw new PackError("cannot-carry")
	}
}

// one node alone, as a graph's nodes are written; cannot-carry: its id
export function encode<V, H>(node: Node<V, H>): Uint8Array {
	return encoded(written(node), node.id)
}

const isFields = (x: unknown): x is Fields =>
	x !== null && typeof x === "object" && !Array.isArray(x) && !ArrayBuffer.isView(x)
const isIds = (x: unknown) => Array.isArray(x) && x.every((e) => typeof e === "string")

// versions as written: maps; under children, each content a list of ids; other keys passed over
function read(x: unknown, lists: boolean): Side<unknown, unknown>[] | undefined {
	// a version is its content: there, or it is not one
	if (!Array.isArray(x) || !x.every((v) => isFields(v) && "content" in v)) return
	if (lists && !x.every((v) => isIds(v.content))) return
	return x.map((v) => {
		const out: Side<unknown, unknown> = { content: v.content, change: v.change }
		if (!("change" in v)) delete (out as { change?: unknown }).change
		if ("because" in v) out.because = v.because
		return out
	})
}

// a header as pack writes it: time a number, reader a string, site {file, line, column?,
// function?}, wallclock a whole, message a string; actor and cause any value; other keys
// passed over
function header(x: unknown): ChangeHeader | undefined {
	if (!isFields(x)) return
	const h: ChangeHeader = {}
	if ("time" in x) {
		if (typeof x.time !== "number") return
		h.time = x.time
	}
	if ("actor" in x) h.actor = x.actor
	if ("reader" in x) {
		if (typeof x.reader !== "string") return
		h.reader = x.reader
	}
	if ("site" in x) {
		const s = x.site
		if (!isFields(s) || typeof s.file !== "string" || typeof s.line !== "number") return
		if ("column" in s && typeof s.column !== "number") return
		if ("function" in s && typeof s.function !== "string") return
		h.site = { file: s.file, line: s.line }
		if ("column" in s) h.site.column = s.column as number
		if ("function" in s) h.site.function = s.function as string
	}
	if ("cause" in x) h.cause = x.cause
	if ("wallclock" in x) {
		const w = x.wallclock
		if (typeof w !== "number" || !Number.isInteger(w) || w < 0 || Object.is(w, -0)) return
		h.wallclock = w
	}
	if ("message" in x) {
		if (typeof x.message !== "string") return
		h.message = x.message
	}
	return h
}

function named(x: unknown, lists: boolean): [string, Side<unknown, unknown>[]][] | undefined {
	if (!Array.isArray(x)) return
	const out: [string, Side<unknown, unknown>[]][] = []
	for (const e of x) {
		if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string") return
		const vs = read(e[1], lists)
		if (vs === undefined) return
		out.push([e[0], vs])
	}
	return out
}

// a node from what was written, every field there; none when it is not one
function node<V, H>(x: unknown): Node<V, H> | undefined {
	if (!isFields(x) || typeof x.id !== "string") return
	const value = read(x.value, false), info = named(x.info, false)
	const children = named(x.children, true), h = header(x.header)
	if (!value || !info || !children || !h) return
	return createNode(x.id, {
		value: value as Side<V, H>[],
		attributes: info as [string, Side<V, H>[]][],
		children: children as [string, Side<List, H>[]][],
	}, { header: h })
}

function decoded(b: Uint8Array, code: Code): unknown {
	try {
		return cbor.decode(b)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError(code)
		throw e
	}
}

// the nodes back, new objects, headers as written; none loaded: that is the caller's (intro)
export function unpack<V, H>(b: Uint8Array): Graph<V, H> {
	const g = decoded(b, "not-a-graph")
	if (
		!isFields(g) || typeof g.root !== "string" || !Array.isArray(g.nodes) || !isIds(g.missing)
	) throw new PackError("not-a-graph")
	const nodes: Node<V, H>[] = []
	for (const x of g.nodes) {
		const n = node<V, H>(x)
		if (n === undefined) throw new PackError("not-a-graph")
		nodes.push(n)
	}
	return { root: g.root, nodes, missing: g.missing as string[] }
}

// one node back, as encode wrote it
export function decode<V, H>(b: Uint8Array): Node<V, H> {
	const n = node<V, H>(decoded(b, "not-a-node"))
	if (n === undefined) throw new PackError("not-a-node")
	return n
}
