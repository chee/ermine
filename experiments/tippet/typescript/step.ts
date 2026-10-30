// A step is one kept write as it travels (WIRE.md, step), and is its bytes: encodeStep makes them,
// decodeStep reads them back and throws on anything that isn't a step, hashStep names them.
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { blake3 } from "@ermine/encoding/blake3"
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
	who?: string
	on?: readonly On[]
}

export type On = { device: string; n: number }

const KEY = /^[0-9a-f]{64}$/

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
	return s.on!.map((o) => o.device === s.device ? s.n - o.n : [unhex(o.device), o.n])
}
export const readOn = (device: string, n: number, on: unknown[]): On[] =>
	on.map((o) =>
		typeof o === "number"
			? { device, n: n - o }
			: { device: hex((o as [Uint8Array])[0]), n: (o as [Uint8Array, number])[1] }
	)

export function encodeStep(s: Step): Uint8Array {
	if (!KEY.test(s.device)) throw new TypeError("not a device")
	const a = [unhex(s.device), s.n, s.before, written(s), s.part, s.patches, s.lamport, s.when]
	if (s.on !== undefined) a.push(writtenOn(s))
	if (s.who !== undefined) a.push(s.who)
	return encode(a as Value)
}

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

// node and part have no NUL, and nesting is at most cbor's DEPTH less one, since a run message
// holds its patches one deeper.
export function decodeStep(bytes: Uint8Array): Step {
	// Read inside one more array, so a step nested to cbor's DEPTH throws.
	const inside = new Uint8Array(bytes.length + 1)
	inside[0] = 0x81, inside.set(bytes, 1)
	const a = (decode(inside) as Value[])[0]
	if (!Array.isArray(a) || a.length < 8 || a.length > 10) throw new TypeError("not a step")
	const said = Array.isArray(a[8]), at = said ? 9 : 8
	if (
		!(a.length === at || (a.length === at + 1 && typeof a[at] === "string")) ||
		!key(a[0]) || !whole(a[1]) || a[1] < 1 || !(a[2] === null || key(a[2])) ||
		!(name(a[3]) || relative(a[3])) || !name(a[4]) ||
		!Array.isArray(a[5]) ||
		!a[5].every(patch) || !whole(a[6]) || !whole(a[7]) ||
		(said && !(a[8] as unknown[]).every(onOf(a[0], a[1])))
	) throw new TypeError("not a step")
	const [device, n, before, node, part, patches, lamport, when] = a
	const who = a[at] as string | undefined
	const d = hex(device)
	const s: Step = typeof node === "string"
		? { device: d, n, before, node, part, patches, lamport, when }
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
		}
	if (said) s.on = readOn(d, n, a[8] as unknown[])
	if (who !== undefined) s.who = who
	return s
}

export const hashStep = (bytes: Uint8Array): Uint8Array => blake3(bytes)

export const same = (a: Uint8Array | null, b: Uint8Array | null) =>
	a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]))

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
