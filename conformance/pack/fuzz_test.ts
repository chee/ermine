// The reference against a pack harness, on what the scenarios never write. PACK_HARNESS: the other
// implementation (default: the reference, against itself). A few ids, each with some of value,
// attributes and children; nodes shared between keys; values
// of every kind (form.ts): bytes, typed arrays of each kind, NaN, the infinities, -0, floats of
// each width, strings around each head's size, astral and escaped, maps of many keys, "/" and
// "__proto__" as keys.
// - across: each packs and encodes to the same bytes; each reads the other's back as the model
//   says: keys sorted, nodes numbered as first named
// - mutated: bytes cut, grown and flipped; both say the same of each
// a few dozen seeds (memory: fuzz runs small)
import { assertEquals } from "@std/assert"
import { line, toJson } from "./form.ts"
import { ask } from "./ask.ts"

const here = new URL(".", import.meta.url).pathname
const reference = `deno run --quiet --allow-env ${here}harness.ts`.split(" ")
const subject = (Deno.env.get("PACK_HARNESS") ?? reference.join(" ")).split(" ")

const SEEDS = 40, MUTATIONS = 20

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

const STRINGS = [
	"",
	"a",
	"x".repeat(23),
	"x".repeat(24),
	"y".repeat(255),
	"z".repeat(256),
	"é",
	"水",
	"😀",
	'a"b\\c\n\t',
	"\u0000",
	"é".repeat(12),
	"mixed ascii and 😀 and 水".repeat(3),
]
const NUMBERS = [
	0,
	-0,
	1,
	-1,
	1.5,
	65504,
	65505,
	2 ** -24,
	2 ** -25,
	100000,
	0.1,
	-4.1,
	1e300,
	5e-324,
	2 ** 53,
	2 ** 53 + 2,
	2 ** 60,
	NaN,
	Infinity,
	-Infinity,
	3.4028234663852886e38,
	1760000000,
]
const TYPED = [
	Int8Array,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	BigInt64Array,
	BigUint64Array,
	Float32Array,
	Float64Array,
]

function values(pick: (n: number) => number) {
	const typed = () => {
		const T = TYPED[pick(TYPED.length)]
		const n = pick(6)
		if (T === BigInt64Array) {
			return BigInt64Array.from({ length: n }, () => BigInt(pick(1 << 30)) * -12345n)
		}
		if (T === BigUint64Array) {
			return BigUint64Array.from({ length: n }, () => BigInt(pick(1 << 30)) << 30n)
		}
		const t = new T(n)
		for (let i = 0; i < n; i++) {
			t[i] = T === Float32Array || T === Float64Array
				? NUMBERS[pick(NUMBERS.length)]
				: pick(1 << 16) - (1 << 15)
		}
		return t
	}
	const value = (depth: number): unknown => {
		switch (pick(depth > 2 ? 7 : 12)) {
			case 0:
				return [null, true, false][pick(3)]
			case 1:
			case 2:
				return NUMBERS[pick(NUMBERS.length)]
			case 3:
				return STRINGS[pick(STRINGS.length)]
			case 4:
				return Uint8Array.from({ length: pick(30) }, () => pick(256))
			case 5:
				return typed()
			case 6:
			case 7:
				// an entry: a source and an id
				return ["src", `n${pick(4)}`]
			case 8:
			case 9:
				return Array.from({ length: pick(pick(2) ? 4 : 30) }, () => value(depth + 1))
			default: {
				const n = pick(5) === 0 ? 30 : pick(5)
				const keys = pick(6) === 0
					? ["/"]
					: Array.from({ length: n }, () =>
						pick(8) === 0 ? "__proto__" : STRINGS[pick(STRINGS.length)] + pick(40))
				const out: Record<string, unknown> = {}
				for (const k of keys) {
					Object.defineProperty(out, k, {
						value: value(depth + 1),
						enumerable: true,
						writable: true,
						configurable: true,
					})
				}
				return out
			}
		}
	}
	return value
}

type Node = { value?: unknown; change: Record<string, unknown> }
type Table = { entries: unknown[][]; nodes: Node[] }

// a few ids, each with some parts; a node now and then under a second key
function table(seed: number): Table {
	const pick = rand(seed)
	const value = values(pick)
	const nodes: Node[] = []
	const node = (): Node => {
		const change: Record<string, unknown> = { time: 1760000000 + pick(1000) }
		if (pick(2)) change.actor = toJson(value(1))
		if (pick(3) === 0) {
			change.reader = STRINGS[pick(STRINGS.length)]
		}
		if (pick(3) === 0) {
			change.external = Array.from({ length: 1 + pick(2) }, () => {
				const site: Record<string, unknown> = { file: "file:///a.ts", line: 1 + pick(99) }
				if (pick(2)) site.column = pick(80)
				if (pick(2)) site.function = "f"
				return site
			})
		}
		if (pick(3) === 0) {
			change.metadata = Object.fromEntries(
				Array.from({ length: pick(4) }, () => [["sync", "why"][pick(2)], toJson(value(1))]),
			)
		}
		if (pick(3) === 0) {
			const patch = () => {
				const p: Record<string, unknown> = { path: ["a", pick(3)] }
				if (pick(2)) p.range = [0, pick(3)]
				if (pick(2)) p.value = toJson(value(1))
				else if (pick(3) === 0) p.move = { path: ["b"] }
				return p
			}
			change.op = {
				patches: Array.from({ length: pick(3) }, patch),
				undo: Array.from({ length: pick(3) }, patch),
			}
		}
		const n: Node = { change }
		if (pick(4)) n.value = toJson(value(0))
		return n
	}
	const parts = ["value", "attributes", "children", "drag"]
	const ids = Array.from(
		{ length: 1 + pick(5) },
		(_, i) => `n${i}`,
	)
	const entries: unknown[][] = []
	for (const id of ids) {
		for (const part of parts) {
			if (pick(3) === 0) continue
			// now and then a node already under another key
			const n = nodes.length && pick(5) === 0
				? pick(nodes.length)
				: (nodes.push(node()), nodes.length - 1)
			entries.push([part, id, n])
		}
	}
	return { entries, nodes }
}

// a string's order: its UTF-8, the shorter first
const utf8 = new TextEncoder()
function before(a: string, b: string): number {
	const x = utf8.encode(a), y = utf8.encode(b)
	if (x.length !== y.length) return x.length - y.length
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}
// what reading back gives, plainly: the keys sorted, the nodes numbered as first named
function model(t: Table): Table {
	const rows = [...t.entries] as [string, string, number][]
	rows.sort((a, b) => before(a[0], b[0]) || before(a[1], b[1]))
	const numbers = new Map<number, number>(), nodes: Node[] = []
	const entries = rows.map(([p, i, n]) => {
		let k = numbers.get(n)
		if (k === undefined) numbers.set(n, k = nodes.length), nodes.push(t.nodes[n])
		return [p, i, k]
	})
	return { entries, nodes }
}

// a map's keys in any order are the same map
const stable = (x: unknown): string =>
	line(
		x,
		(v) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as never)[k]]))
				: v,
	)

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

function mutate(seed: number, bytes: string): string[] {
	const pick = rand(seed * 7919 + 1)
	return Array.from({ length: MUTATIONS }, () => {
		const b = Array.from(unhex(bytes))
		for (let k = 1 + pick(3); k > 0 && b.length; k--) {
			const at = pick(b.length)
			switch (pick(7)) {
				case 0:
					b[at] ^= 1 << pick(8)
					break
				case 1:
					b[at] = pick(256)
					break
				case 2:
					b.splice(at, 0, pick(256))
					break
				case 3:
					b.splice(at, 1)
					break
				case 4:
					b.length = at
					break
				case 5: {
					const to = pick(b.length)
					;[b[at], b[to]] = [b[to], b[at]]
					break
				}
				default:
					b.splice(at, 0, ...b.slice(at, at + 1 + pick(8)))
			}
		}
		return hex(Uint8Array.from(b))
	})
}

const tables = Array.from({ length: SEEDS }, (_, i) => table(i + 1))

Deno.test(`fuzz: ${SEEDS} tables across, each reads the other's bytes as the model says`, async () => {
	const asks = (
		t: Table,
	) => [{ op: "pack", ...t }, ...t.nodes.map((node) => ({ op: "encode", node }))]
	const [ours, theirs] = await Promise.all([
		ask(subject, tables.flatMap(asks)),
		ask(reference, tables.flatMap(asks)),
	])
	assertEquals(ours, theirs, "pack and encode: the same answers, the same bytes")
	const reads = (a: typeof ours) => {
		const out: Record<string, unknown>[] = []
		let at = 0
		for (const t of tables) {
			out.push({ op: "unpack", bytes: a[at++].bytes })
			for (const _ of t.nodes) out.push({ op: "decode", bytes: a[at++].bytes })
		}
		return out
	}
	const [cross, back] = await Promise.all([
		ask(reference, reads(ours) as never),
		ask(subject, reads(theirs) as never),
	])
	let at = 0
	for (const [i, t] of tables.entries()) {
		const m = model(t)
		for (const [name, a] of [["reference", cross], ["subject", back]] as const) {
			assertEquals(
				stable({ entries: a[at].entries, nodes: a[at].nodes }),
				stable(m),
				`seed ${i + 1}: ${name} unpacks as the model says`,
			)
			t.nodes.forEach((n, k) =>
				assertEquals(
					stable(a[at + 1 + k].node),
					stable(n),
					`seed ${i + 1}: ${name} decodes node ${k}`,
				)
			)
		}
		at += 1 + t.nodes.length
	}
})

Deno.test(`fuzz: ${SEEDS * MUTATIONS} mutated packs, both say the same`, async () => {
	const packed = await ask(reference, tables.map((t) => ({ op: "pack", ...t })))
	const reads = packed.flatMap((a, i) =>
		mutate(i + 1, a.bytes!).flatMap((bytes) => [{ op: "unpack", bytes }, { op: "decode", bytes }])
	)
	const [ours, theirs] = await Promise.all([ask(subject, reads), ask(reference, reads)])
	for (let i = 0; i < reads.length; i++) {
		assertEquals(stable(ours[i]), stable(theirs[i]), `${reads[i].op} ${reads[i].bytes}`)
	}
})
