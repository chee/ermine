// A step is one kept write as it travels (WIRE.md, step), and is its bytes: encodeStep makes them,
// decodeStep reads them back and throws on anything that isn't a step, hashStep names them.
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { blake3 } from "@ermine/blake3"
import type { Patch } from "@ermine/changeable/apply"

export type Step = {
	device: string
	n: number
	before: Uint8Array | null
	node: string
	relative?: boolean
	part: string
	patches: readonly Patch[]
	lamport: number
	when: number
	// how many elements its device's steps before it insert (WIRE.md, ids)
	seq: number
	who?: string
	on: readonly On[]
	// per patch: the elements it names, as written (WIRE.md, ids), or null
	ids: readonly Value[]
}

export type On = { device: string; n: number }
// an element of a string or array: made by a step, c its number among its device's elements; or
// there since a step made its sequence new, c that step's n, k its place
export type Id = { device: string; c: number; k?: number }
// a splice by ids: it goes after one element (null: the start) and before another (none: the end;
// true: the one its after element goes before), and takes these away, each an id and how many from
// it, its c or k on
export type Anchor = { after: Id | null; gone: readonly [Id, number][]; before?: Id | true }
// a container (a map, an array, a string) or a scalar a patch made, as a key: the step that made it
// (device, n), its patch (i) and its place in that patch's value (rel: map keys, array places), each
// field after a NUL; see nodeKey
export type Node = string
// what a patch names by ids: container, the node its path ends in the container of (null: no root
// yet); pred: the cells a put or removal replaces; splice: its elements (a list move: gone is what it
// moves, in order); element: the array item a put at an index replaces
export type Named = { container: Node | null; pred?: Node[]; splice?: Anchor; element?: Id }
const NUL = "\0"
export const nodeKey = (
	device: string,
	n: number,
	i: number,
	rel: readonly (string | number)[] = [],
): Node => [device, n, i, ...rel.map((x) => JSON.stringify(x))].join(NUL)
export const nodeOf = (k: Node) => {
	const [device, n, i, ...rel] = k.split(NUL)
	return { device, n: +n, i: +i, rel: rel.map((x) => JSON.parse(x) as string | number) }
}

export const KEY = /^[0-9a-f]{64}$/

export const own = (device: string) => `ermine:ed01${device}`
export function rest(device: string, node: string): string | undefined {
	const id = own(device)
	if (!node.startsWith(id)) return
	const r = node.slice(id.length)
	return r === "" || r[0] === "/" ? r : undefined
}
export function written(s: Step): Value {
	if (!s.relative) return s.node
	const r = rest(s.device, s.node)
	if (r === undefined) throw new TypeError("not a node relative to its device")
	return [r]
}

export function writtenOn(s: Step): Value {
	return s.on.map((o) => o.device === s.device ? s.n - o.n : [unhex(o.device), o.n])
}
export const readOn = (device: string, n: number, on: unknown[]): On[] =>
	on.map((o) =>
		typeof o === "number"
			? { device, n: n - o }
			: { device: hex((o as [Uint8Array])[0]), n: (o as [Uint8Array, number])[1] }
	)

// how many elements a patch inserts: a splice's (a patch with a range) string's code points or
// array's items, a move's into a slot (a range) the items it moves
export const inserts = (p: Patch) =>
	p.move
		? p.range === undefined
			? 0
			: p.move.range
			? Math.max(0, p.move.range[1] - p.move.range[0])
			: 1
		: p.range === undefined
		? 0
		: typeof p.value === "string"
		? [...p.value].length
		: Array.isArray(p.value)
		? p.value.length
		: 0
// a list move: one item, or a range of items, of an array to a gap in the same array, at most
// MOVED of them; the patch is {path: the array, range: [j, j], move: {path: the item, or the array
// and range}}, j counted in the array without what moves
export const MOVED = 4096
const sameKeys = (a: readonly unknown[], b: readonly unknown[]) =>
	a.length === b.length && a.every((k, i) => k === b[i])
export const listMove = (p: Patch): boolean => {
	const m = p.move
	if (!m || !p.range || p.range[0] !== p.range[1] || p.value !== undefined) return false
	if (m.range) {
		const n = m.range[1] - m.range[0]
		return n >= 1 && n <= MOVED && sameKeys(m.path, p.path)
	}
	const k = m.path[m.path.length - 1]
	return typeof k === "number" && sameKeys(m.path.slice(0, -1), p.path)
}
// how many items a list move moves
export const moved = (p: Patch) => p.move?.range ? p.move.range[1] - p.move.range[0] : 1
// a patch that names a container: every patch but a move that is no list move
export const needs = (p: Patch) => !p.move || listMove(p)
export const made = (s: Pick<Step, "patches">) => s.patches.reduce((n, p) => n + inserts(p), 0)

// where a step is: its device, its n, and seq: how many elements its device's steps before it insert
export type At = { device: string; n: number; seq: number }
// this device's own by how far back: x (seq - x) or [x, k] (step n - x); another's whole
const writeId = (s: At, i: Id): Value =>
	i.device === s.device
		? i.k === undefined ? s.seq - i.c : [s.n - i.c, i.k]
		: i.k === undefined
		? [unhex(i.device), i.c]
		: [unhex(i.device), i.c, i.k]
// a node: this device's [n, i, rel…], another's [device, n, i, rel…]
const writeNode = (s: At, k: Node | null): Value => {
	if (k === null) return null
	const { device, n, i, rel } = nodeOf(k)
	return device === s.device ? [n, i, ...rel] : [unhex(device), n, i, ...rel]
}
export const writeIds = (s: At, ids: readonly (Named | null)[]): Value[] =>
	ids.map((x) => {
		if (!x) return null
		const c = writeNode(s, x.container), a = x.splice
		if (a) {
			return [
				c,
				a.after && writeId(s, a.after),
				a.gone.map(([i, c]) => [writeId(s, i), c]),
				a.before === undefined ? null : a.before === true ? true : writeId(s, a.before),
			]
		}
		const pred = (x.pred ?? []).map((n) => writeNode(s, n))
		return x.element ? [c, pred, writeId(s, x.element)] : [c, pred]
	})
const readId = (s: At, i: unknown): Id => {
	if (typeof i === "number") return { device: s.device, c: s.seq - i }
	const a = i as [unknown, number, number?]
	if (typeof a[0] === "number") return { device: s.device, c: s.n - a[0], k: a[1] }
	const d = hex(a[0] as Uint8Array)
	return a.length === 2 ? { device: d, c: a[1] } : { device: d, c: a[1], k: a[2] }
}
const readNode = (s: At, v: unknown): Node | null => {
	if (v === null) return null
	const a = v as unknown[]
	return typeof a[0] === "number"
		? nodeKey(s.device, a[0], a[1] as number, a.slice(2) as (string | number)[])
		: nodeKey(
			hex(a[0] as Uint8Array),
			a[1] as number,
			a[2] as number,
			a.slice(3) as (string | number)[],
		)
}
export const readIds = (s: At, ids: readonly Value[]): (Named | null)[] =>
	ids.map((x) => {
		if (x === null) return null
		const w = x as unknown[], container = readNode(s, w[0])
		if (w.length === 2 || w.length === 3) {
			const pred = (w[1] as unknown[]).map((n) => readNode(s, n)!)
			return w.length === 2 ? { container, pred } : { container, pred, element: readId(s, w[2]) }
		}
		const [, after, gone, before] = w as [unknown, unknown, [unknown, number][], unknown]
		const a: Anchor = {
			after: after === null ? null : readId(s, after),
			gone: gone.map(([i, c]) => [readId(s, i), c] as [Id, number]),
		}
		if (before !== null) a.before = before === true ? true : readId(s, before)
		return { container, splice: a }
	})

export function encodeStep(s: Step): Uint8Array {
	if (!KEY.test(s.device)) throw new TypeError("not a device")
	const a = [
		unhex(s.device),
		s.n,
		s.before,
		written(s),
		s.part,
		s.patches,
		s.lamport,
		s.when,
		s.seq,
		writtenOn(s),
		s.ids as Value[],
	]
	if (s.who !== undefined) a.push(s.who)
	return encode(a as Value)
}

const MAX = Number.MAX_SAFE_INTEGER
export const whole = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
export const key = (x: unknown): x is Uint8Array => x instanceof Uint8Array && x.length === 32
const only = (o: object, keys: string[]) => Object.keys(o).every((k) => keys.includes(k))
const isMap = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x) && !ArrayBuffer.isView(x)
const target = (t: Record<string, unknown>) =>
	Array.isArray(t.path) && t.path.every((k) => typeof k === "string" || whole(k)) &&
	(t.range === undefined ||
		(Array.isArray(t.range) && t.range.length === 2 && t.range.every(whole)))
const patch = (p: unknown) =>
	isMap(p) && only(p, ["path", "range", "value", "move"]) && target(p) &&
	(p.move === undefined || (isMap(p.move) && only(p.move, ["path", "range"]) && target(p.move)))

const name = (x: unknown): x is string => typeof x === "string" && !x.includes("\0")

const relative = (x: unknown): x is [string] =>
	Array.isArray(x) && x.length === 1 && name(x[0]) && (x[0] === "" || x[0][0] === "/")

export const onOf = (device: Uint8Array, n: number) => (o: unknown) =>
	whole(o) ? o >= 1 && o < n : Array.isArray(o) && o.length === 2 && key(o[0]) && whole(o[1]) &&
		o[1] >= 1 && !same(o[0], device)

// an element id as written: this device's x (whole or negative) or [x, k] (x whole, below n);
// another's [device, c] or [device, n, k] (n from 1)
export const idOf = (device: Uint8Array, n: number) => (i: unknown) =>
	Number.isSafeInteger(i) || Array.isArray(i) &&
		(typeof i[0] === "number"
			? i.length === 2 && whole(i[0]) && i[0] < n && whole(i[1])
			: key(i[0]) && !same(i[0], device) && whole(i[1]) &&
				(i.length === 2 || (i.length === 3 && i[1] >= 1 && whole(i[2]))))
// a node as written: this device's [n, i, rel…] (n from 1 to the step's, and if the step's, i below
// its patch's index at), another's [device, n, i, rel…] (n from 1); rel: tstr or whole, at most 1021
export const nodeOfIds = (device: Uint8Array, n: number, at: number) => (v: unknown) => {
	if (!Array.isArray(v) || v.length < 2) return false
	const own = typeof v[0] === "number", rel = v.slice(own ? 2 : 3)
	if (rel.length > 1021 || !rel.every((r) => typeof r === "string" || whole(r))) return false
	if (own) return whole(v[0]) && v[0] >= 1 && v[0] <= n && whole(v[1]) && (v[0] < n || v[1] < at)
	return v.length >= 3 && key(v[0]) && !same(v[0], device) && whole(v[1]) && v[1] >= 1 &&
		whole(v[2])
}
// ids as written: one per patch; the patch's container (a node; null only for
// a put of the whole value, the first) and
//   a put or removal at a key, or the whole: [container, pred]    pred: array of cells it replaces
//   a put at an index of an array: [container, pred, element]
//   a splice (a patch with a range), a removal at an index, a list move: [container, after, gone, before]
//   (a list move's gone: what it moves, in order, their counts summing to what it moves)
//   before null for the end, true for after's own (after not null)
export const idsOf = (device: Uint8Array, n: number, patches: unknown[]) => (ids: unknown) => {
	const id = idOf(device, n)
	return Array.isArray(ids) && ids.length === patches.length &&
		ids.every((x, i) => {
			const p = patches[i] as Patch, node = nodeOfIds(device, n, i)
			if (x === null || !Array.isArray(x)) return false
			if (p.move && !listMove(p)) return false
			const last = p.path[p.path.length - 1]
			if (!(x[0] === null ? p.path.length === 0 && p.range === undefined : node(x[0]))) {
				return false
			}
			const sliced = p.range !== undefined || (typeof last === "number" && p.value === undefined)
			if (sliced) {
				// a removal at an index: no after, the one element, no before
				if (
					p.range === undefined &&
					!(x[1] === null && Array.isArray(x[2]) && x[2].length === 1 && x[3] === null)
				) return false
				if (p.range === undefined && !(Array.isArray(x[2][0]) && x[2][0][1] === 1)) return false
				return x.length === 4 && x[0] !== null && (x[1] === null || id(x[1])) &&
					Array.isArray(x[2]) &&
					(x[3] === true ? x[1] !== null : x[3] === null || id(x[3])) &&
					x[2].every((g) =>
						Array.isArray(g) && g.length === 2 && id(g[0]) && whole(g[1]) && g[1] >= 1
					) && (!p.move || x[2].reduce((n: number, g: [unknown, number]) =>
								n + g[1], 0) === moved(p))
			}
			if (!Array.isArray(x[1]) || !x[1].every(node)) return false
			if (typeof last === "number") return x.length === 3 && id(x[2]) && x[0] !== null
			return x.length === 2
		})
}

// node and part have no NUL, and nesting is at most cbor's DEPTH less one, since a run message
// holds its patches one deeper.
export function decodeStep(bytes: Uint8Array): Step {
	// Read inside one more array, so a step nested to cbor's DEPTH throws.
	const inside = new Uint8Array(bytes.length + 1)
	inside[0] = 0x81, inside.set(bytes, 1)
	const a = (decode(inside) as Value[])[0]
	if (!Array.isArray(a) || a.length < 11 || a.length > 12) throw new TypeError("not a step")
	if (
		!(a.length === 11 || typeof a[11] === "string") ||
		!key(a[0]) || !whole(a[1]) || a[1] < 1 || !(a[2] === null || key(a[2])) ||
		!(name(a[3]) || relative(a[3])) || !name(a[4]) ||
		!Array.isArray(a[5]) ||
		!a[5].every(patch) || !whole(a[6]) || !whole(a[7]) ||
		!whole(a[8]) || a[8] + a[5].reduce((n: number, p: Patch) => n + inserts(p), 0) > MAX ||
		!Array.isArray(a[9]) || !a[9].every(onOf(a[0], a[1])) || !idsOf(a[0], a[1], a[5])(a[10])
	) throw new TypeError("not a step")
	const [device, n, before, node, part, patches, lamport, when] = a
	const who = a[11] as string | undefined
	const seq = a[8] as number, d = hex(device), on = readOn(d, n, a[9] as unknown[])
	const ids = a[10] as Value[]
	const s: Step = typeof node === "string"
		? { device: d, n, before, node, part, patches, lamport, when, seq, on, ids }
		: {
			device: d,
			n,
			before,
			node: own(d) + node[0],
			relative: true,
			part,
			patches,
			lamport,
			when,
			seq,
			on,
			ids,
		}
	if (who !== undefined) s.who = who
	return s
}

export const hashStep = (bytes: Uint8Array): Uint8Array => blake3(bytes)

export const same = (a: Uint8Array | null, b: Uint8Array | null) =>
	a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]))

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
