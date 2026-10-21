// the pack fuzz: tables of nodes under (part, id) keys (nodes under several keys, the same key
// twice, ermine ids and tricky ones), values of every kind (-0, NaN, typed arrays, bytes,
// stand-ins, maps with "__proto__", "/" and "" keys). checked:
// - round trip: unpack(pack(t)) is t by content, keys sorted, none twice, a node under several
//   keys one node; packing that again, or t in another order, the same bytes; op: false leaves
//   the op out and nothing else
// - encode and decode of one node: back by content, encoding again the same bytes
// - cannot-carry: a lone surrogate or a symbol anywhere a node or a key has a string
// - canonical: the columns rewritten as pack never writes them (a run split in two, a varint
//   longer than it needs, an empty column written, an ermine id as text, …) and deflated as
//   pack does: refused. another deflate of the same columns is told, not checked (open)
// - fields: a key no map has, at every level, refused unless loosyGoosy, which passes it over;
//   whole numbers at their edges (time and range ends safe, line, column and path numbers int32,
//   never a fraction; -0 is 0), in pack, decode, the first form and the columns
// - a run that says it is very long: refused, quickly
// - across: PACK_HARNESS (the C one; default the reference, against itself) answers every request
//   as the reference does, maps by content: packs and encodings, reads of them, of bytes cut,
//   grown and flipped, of every rewrite above, strict and loosy
// a few dozen seeds (fuzz runs small)
// the rules (cbor.ts): whole numbers are integers, run counts and the first form's node numbers
// too; -0 is 0 (so a time or a path number of -0 is taken, as 0); a whole number past 2^53 - 1
// reads back as a bigint, which no field takes; values may be bigints
import { assert, assertEquals } from "@std/assert"
import * as cbor from "./cbor.ts"
import { deflate, inflate } from "./deflate.ts"
import { decode, encode, type Entry, pack, PackError, unpack } from "./pack.ts"
import createEntry, { type Entry as NodeEntry } from "@ermine/node/entry"
import { line, toJson } from "../../../conformance/typescript/form.ts"
import { ask } from "../../../conformance/typescript/ask.ts"

const SEEDS = 40
const root = new URL("../../../", import.meta.url).pathname
const reference = ["deno", "run", "--quiet", "--allow-env", `${root}conformance/pack/harness.ts`]
const subject = Deno.env.get("PACK_HARNESS")?.split(" ") ?? reference

type Pick = (n: number) => number
function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	const pick = (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
	const one = <T>(xs: readonly T[]): T => xs[pick(xs.length)]
	return { pick, one }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const compare = (a: Uint8Array, b: Uint8Array) => {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}
const put = (m: object, k: string, v: unknown) =>
	Object.defineProperty(m, k, { value: v, enumerable: true, writable: true, configurable: true })

// values ---------------------------------------------------------------------

const NUMBERS: unknown[] = [0, -0, 1, -1, 1.5, 0.1, 65504, 2 ** 31, 2 ** 53, 2 ** 53 + 2, 1e300]
	.concat([5e-324, NaN, Infinity, -Infinity, 1760000000, -(2 ** 64), 2 ** 64])
	.concat(
		[5n, 2n ** 53n + 1n, -(2n ** 53n) - 1n, 2n ** 64n - 1n, 2n ** 64n, -(2n ** 70n)] as never[],
	)
const STRINGS = ["", "a", "é", "水", "😀", "\u0000", "a\u0000b", "/", "__proto__", "x".repeat(24)]
const LONE = ["\uD800", "a\uDC00", "\uDBFF!", "😀\uD83D"]
const KEYS = ["", "/", "__proto__", "constructor", "0", "01", "a", "a\u0000", "😀", "ｚ"]
const KINDS = [Int8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array]
	.concat([Float64Array] as never[])

function text(pick: Pick, lone: boolean): string {
	return lone && pick(4) === 0
		? LONE[pick(LONE.length)]
		: STRINGS[pick(STRINGS.length)] + (pick(3) ? "" : STRINGS[pick(STRINGS.length)])
}

function value(pick: Pick, lone = false, depth = 0): unknown {
	switch (pick(depth > 2 ? 6 : 10)) {
		case 0:
			return [null, true, false][pick(3)]
		case 1:
		case 2:
			return pick(3)
				? NUMBERS[pick(NUMBERS.length)]
				: (pick(2) ? -1 : 1) * pick(1e9) / 2 ** pick(40)
		case 3:
			return text(pick, lone)
		case 4:
			return Uint8Array.from({ length: [0, 1, 24][pick(3)] }, () => pick(256))
		case 5: {
			if (pick(4) === 0) return BigInt64Array.from([0n, -(2n ** 63n), BigInt(pick(1000))])
			const T = KINDS[pick(KINDS.length)]
			const t = new T(pick(4))
			for (let i = 0; i < t.length; i++) t[i] = [NaN, -0, 1.5, -1, 300][pick(5)]
			return t
		}
		case 6:
		case 7:
			return Array.from({ length: pick(4) }, () => value(pick, lone, depth + 1))
		case 8:
			return new cbor.Stand(value(pick, lone, depth + 1) as cbor.Value)
		default: {
			const m = {}
			for (let n = pick(5); n > 0; n--) {
				put(
					m,
					pick(2) ? KEYS[pick(KEYS.length)] : text(pick, lone),
					value(pick, lone, depth + 1),
				)
			}
			return m
		}
	}
}

// a number as read back: -0 is 0, a whole number past 2^53 - 1 a bigint, a safe bigint a number
const canon = (x: number | bigint) =>
	typeof x === "bigint"
		? (x >= -(2n ** 53n) + 1n && x <= 2n ** 53n - 1n ? Number(x) : x)
		: Number.isInteger(x) && !Number.isSafeInteger(x)
		? BigInt(x)
		: x === 0
		? 0
		: x

// equal: numbers by value (canon, then Object.is), kinds apart (a typed array's elements as they
// are), maps by content
function same(a: unknown, b: unknown, inside = false): boolean {
	if (inside) return Object.is(a, b)
	if (typeof a === "number" || typeof a === "bigint") {
		return (typeof b === "number" || typeof b === "bigint") && Object.is(canon(a), canon(b))
	}
	if (a === null || typeof a !== "object") return a === b
	if (b === null || typeof b !== "object") return false
	if (ArrayBuffer.isView(a)) {
		if (!ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false
		const x = Array.from(a as never as ArrayLike<unknown>),
			y = Array.from(b as never as ArrayLike<unknown>)
		return x.length === y.length && x.every((e, i) => same(e, y[i], true))
	}
	if (a instanceof cbor.Stand) return b instanceof cbor.Stand && same(a.kind, b.kind)
	if (b instanceof cbor.Stand) return false
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((e, i) => same(e, b[i]))
	}
	if (Array.isArray(b) || ArrayBuffer.isView(b)) return false
	const ka = Object.keys(a), kb = Object.keys(b)
	return ka.length === kb.length &&
		ka.every((k) => Object.hasOwn(b, k) && same((a as never)[k], (b as never)[k]))
}

// nodes and tables -----------------------------------------------------------

type Node = NodeEntry<unknown>
const TIMES = [0, 1, -1, 1760000000, 2 ** 31, -(2 ** 31), 2 ** 53 - 1, -(2 ** 53 - 1)]
const SMALL = [0, 1, -1, 2 ** 31 - 1, -(2 ** 31)]
const SAFE = [0, 3, 2 ** 53 - 1, -(2 ** 53 - 1)]

function node(pick: Pick, lone = false): Node {
	const h: Record<string, unknown> = {
		time: pick(2) ? TIMES[pick(TIMES.length)] : 1760000000 + pick(1000) - 500,
	}
	if (pick(2)) h.actor = value(pick, lone, 1)
	if (pick(3) === 0) h.reader = text(pick, lone)
	if (pick(3) === 0) {
		h.external = Array.from({ length: pick(3) }, () => {
			const s: Record<string, unknown> = {
				file: text(pick, lone),
				line: SMALL[pick(SMALL.length)],
			}
			if (pick(2)) s.column = SMALL[pick(SMALL.length)]
			if (pick(2)) s.function = text(pick, lone)
			return s
		})
	}
	if (pick(3) === 0) {
		h.metadata = Object.fromEntries(
			Array.from({ length: pick(3) }, () => [text(pick, lone), value(pick, lone, 1)]),
		)
	}
	if (pick(3) === 0) {
		const target = () => {
			const t: Record<string, unknown> = {
				path: Array.from(
					{ length: pick(3) },
					() => pick(2) ? text(pick, lone) : SMALL[pick(5)],
				),
			}
			if (pick(2)) t.range = [SAFE[pick(SAFE.length)], SAFE[pick(SAFE.length)]]
			return t
		}
		const patch = () => {
			const p = target()
			if (pick(2)) p.value = value(pick, lone, 1)
			if (pick(3) === 0) p.move = target()
			return p
		}
		h.op = {
			patches: Array.from({ length: pick(3) }, patch),
			undo: Array.from({ length: pick(3) }, patch),
		}
	}
	return createEntry(pick(4) ? value(pick, lone) : undefined, h as never)
}

const PARTS = ["value", "attributes", "children", "", "/", "__proto__", "é", "a\u0000"]
const hexid = (pick: Pick, n = 32) =>
	Array.from({ length: n }, () => "0123456789abcdef"[pick(16)]).join("")
// ermine ids of each kind (fresh, hashed, key), and tricky ones: upper case, a digit short, an
// unknown code, the old ermine:// form
function id(pick: Pick): string {
	switch (pick(10)) {
		case 0:
			return "ermine:0010" + hexid(pick)
		case 1:
			return "ermine:" + ["0010", "1e10"][pick(2)] + hexid(pick)
		case 2:
			return "ermine:ed01" + hexid(pick, 64)
		case 3:
			return "ermine:0010" + hexid(pick).toUpperCase()
		case 4:
			return "ermine:0010" + hexid(pick).slice(1)
		case 5:
			return ["ermine:0011" + hexid(pick), "ermine://" + hexid(pick, 64)][pick(2)]
		case 6:
			return ["", "/", "__proto__", "\u0000", "😀", "ermine:"][pick(6)]
		default:
			return `n${pick(6)}`
	}
}

// a table: nodes under keys, a node now and then under another key, a key now and then twice
function table(pick: Pick, lone = false): Entry[] {
	const out: Entry[] = []
	const nodes: Node[] = []
	for (let n = pick(4) === 0 ? pick(40) : pick(8); n > 0; n--) {
		const part = lone && pick(8) === 0 ? text(pick, true) : PARTS[pick(PARTS.length)]
		const at = id(pick)
		const k = nodes.length && pick(4) === 0
			? pick(nodes.length)
			: nodes.push(node(pick, lone)) - 1
		if (out.some(([p, i]) => p === part && i === at)) continue
		out.push([part, at, nodes[k]])
		if (pick(6) === 0) out.push([part, at, nodes[k]])
	}
	for (let i = out.length - 1; i > 0; i--) {
		const j = pick(i + 1)
		;[out[i], out[j]] = [out[j], out[i]]
	}
	return out
}

// what unpack gives, as the model has it: keys sorted by their encoding, none twice
function model(t: Entry[]): Entry[] {
	const seen = new Map<string, Entry>()
	for (const e of t) seen.set(hex(cbor.encode([e[0] as string, e[1] as string])), e)
	return [...seen.entries()].sort((a, b) => compare(unhex(a[0]), unhex(b[0]))).map(([, e]) => e)
}

// a node as pack writes it: present fields only, sites and patches by theirs
function shown(n: Node, op = true): unknown {
	const h = n.change as Record<string, unknown>
	const c: Record<string, unknown> = { time: h.time }
	for (const k of ["actor", "reader", "external", "metadata"]) if (h[k] !== undefined) c[k] = h[k]
	if (h.op !== undefined && op) c.op = h.op
	const out: Record<string, unknown> = { change: c }
	if (n.value !== undefined) out.value = n.value
	return out
}

function code(f: () => unknown): string {
	try {
		f()
		return "taken"
	} catch (e) {
		if (e instanceof PackError) return e.code
		throw e
	}
}

// the columns of a pack, read; and put back as pack would
const columnsOf = (b: Uint8Array) =>
	cbor.decode(inflate((cbor.decode(b) as { columns: Uint8Array }).columns, 2 ** 30)) as Record<
		string,
		cbor.Value
	>
const wrap = (c: unknown) => cbor.encode({ columns: deflate(cbor.encode(c as cbor.Value)) })

// round trip -----------------------------------------------------------------

Deno.test(`pack fuzz: ${SEEDS} seeds, unpack(pack(t)) is t, one node per node, the same bytes`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed)
		const t = table(pick)
		const b = pack(t)
		const got = unpack(b)
		const want = model(t)
		assertEquals(got.map(([p, i]) => [p, i]), want.map(([p, i]) => [p, i]), `seed ${seed}: keys`)
		for (let i = 0; i < got.length; i++) {
			assert(same(shown(got[i][2]), shown(want[i][2])), `seed ${seed}: node at ${i}`)
			for (let j = 0; j < i; j++) {
				assertEquals(got[i][2] === got[j][2], want[i][2] === want[j][2], `seed ${seed}: shared`)
			}
		}
		assertEquals(hex(pack(got)), hex(b), `seed ${seed}: packed again`)
		assertEquals(hex(pack([...t].reverse())), hex(b), `seed ${seed}: another order`)
		const bare = unpack(pack(t, { op: false }))
		for (let i = 0; i < bare.length; i++) {
			assert(same(shown(bare[i][2]), shown(want[i][2], false)), `seed ${seed}: op false`)
		}
	}
})

Deno.test(`pack fuzz: ${SEEDS * 10} nodes, decode(encode(n)) is n, encoded again the same`, () => {
	for (let seed = 1; seed <= SEEDS * 10; seed++) {
		const { pick } = rand(seed + 1000)
		const n = node(pick)
		const b = encode(n)
		const back = decode(b)
		assert(same(shown(back), shown(n)), `seed ${seed}`)
		assertEquals(hex(encode(back)), hex(b), `seed ${seed}: again`)
		assert(same(decode(b, { loosyGoosy: true }), back), `seed ${seed}: loosy`)
	}
})

// cannot-carry ---------------------------------------------------------------

Deno.test("pack fuzz: a lone surrogate or a symbol anywhere is cannot-carry, at the key", () => {
	const s = Symbol.for("s")
	for (const bad of [...LONE, s]) {
		const places: [string, () => Node][] = [
			["value", () => createEntry(bad, { time: 1 } as never)],
			["value in a map", () => createEntry({ a: [1, { b: bad }] }, { time: 1 } as never)],
			["actor", () => createEntry(1, { time: 1, actor: bad } as never)],
			["reader", () => createEntry(1, { time: 1, reader: bad } as never)],
			// a symbol key is no key of the map's (Object.keys): only a string's is refused
			...typeof bad === "string"
				? [[
					"metadata key",
					() => createEntry(1, { time: 1, metadata: { [bad]: 1 } } as never),
				] as [
					string,
					() => Node,
				]]
				: [],
			["metadata value", () => createEntry(1, { time: 1, metadata: { k: bad } } as never)],
			["file", () => createEntry(1, { time: 1, external: [{ file: bad, line: 1 }] } as never)],
			[
				"function",
				() =>
					createEntry(
						1,
						{ time: 1, external: [{ file: "a", line: 1, function: bad }] } as never,
					),
			],
			[
				"path",
				() =>
					createEntry(1, { time: 1, op: { patches: [{ path: [bad] }], undo: [] } } as never),
			],
			[
				"patch value",
				() =>
					createEntry(
						1,
						{ time: 1, op: { patches: [], undo: [{ path: [], value: bad }] } } as never,
					),
			],
			[
				"move",
				() =>
					createEntry(1, {
						time: 1,
						op: { patches: [{ path: ["a"], move: { path: ["b", bad] } }], undo: [] },
					} as never),
			],
		]
		if (typeof bad === "string") {
			places.push(["map key", () => createEntry({ [bad]: 1 }, { time: 1 } as never)])
		}
		for (const [where, make] of places) {
			const n = make()
			const ok = createEntry(1, { time: 1 } as never)
			let e: unknown
			try {
				pack([["value", "b", ok], ["value", "a", n], ["value", "c", n]])
			} catch (x) {
				e = x
			}
			assert(e instanceof PackError, `${where}: ${String(e)}`)
			assertEquals([e.code, e.part, e.id], ["cannot-carry", "value", "a"], where)
			assertEquals(code(() => encode(n)), "cannot-carry", `${where}: encode`)
		}
		// a key: the first given with one
		const n = createEntry(1, { time: 1 } as never)
		for (const [part, at] of [[bad, "a"], ["value", bad]] as [string, string][]) {
			let e: unknown
			try {
				pack([["value", "z", n], [part, at, n], ["value", bad, n]])
			} catch (x) {
				e = x
			}
			assert(e instanceof PackError && e.code === "cannot-carry", String(e))
			assertEquals([e.part, e.id], [part, at])
		}
	}
})

// canonical ------------------------------------------------------------------

const RUNS = ["parts", "actor", "reader", "external", "metadata"]
const VARINTS = ["which", "nodes", "has", "time"]
const LISTS = ["ids", "op", "values", ...RUNS]

// where each varint in b ends
function ends(b: Uint8Array): number[] {
	const out: number[] = []
	for (let i = 0; i < b.length; i++) if (b[i] < 128) out.push(i)
	return out
}
const zigzag = (d: bigint) => d >= 0n ? d * 2n : -d * 2n - 1n
function varint(x: bigint): number[] {
	const out: number[] = []
	while (x >= 128n) out.push(Number(x & 127n) | 128), x >>= 7n
	out.push(Number(x))
	return out
}

// the columns as pack never writes them, each named; refused, as pack.h says ("only ... exactly
// what pack writes")
function rewrites(pick: Pick, c: Record<string, cbor.Value>): [string, unknown][] {
	const out: [string, unknown][] = []
	const copy = () => cbor.decode(cbor.encode(c)) as Record<string, cbor.Value>
	for (const k of RUNS) {
		const runs = c[k] as [cbor.Value, number][] | undefined
		const at = runs?.findIndex(([, n]) => n > 1) ?? -1
		if (runs && at >= 0) {
			const r = copy(), [it, n] = runs[at], split = 1 + pick(n - 1)
			r[k] = [...runs.slice(0, at), [it, split], [it, n - split], ...runs.slice(at + 1)] as never
			out.push([`a run split in two (${k})`, r])
		}
		if (runs) {
			const r = copy()
			r[k] = [...runs, [runs[0][0], 0]] as never
			out.push([`a run of none (${k})`, r])
			const f = copy()
			f[k] = [...runs.slice(0, -1), [runs.at(-1)![0], runs.at(-1)![1] - 0.5]] as never
			out.push([`a run of a fraction (${k})`, f])
		}
	}
	for (const k of VARINTS) {
		const v = c[k] as Uint8Array | undefined
		if (!v) continue
		const e = ends(v), at = e[pick(e.length)]
		const r = copy()
		r[k] = Uint8Array.from([...v.slice(0, at), v[at] | 128, 0, ...v.slice(at + 1)])
		out.push([`a varint longer than it needs (${k})`, r])
		const t = copy()
		t[k] = Uint8Array.from([...v, 128])
		out.push([`a varint that never ends (${k})`, t])
	}
	for (const k of [...LISTS, ...VARINTS]) {
		if (k in c) continue
		const r = copy()
		r[k] = VARINTS.includes(k) ? new Uint8Array(0) : []
		out.push([`an empty column written (${k})`, r])
	}
	const ids = c.ids as cbor.Value[] | undefined
	const raw = ids?.findIndex((i) => i instanceof Uint8Array) ?? -1
	if (ids && raw >= 0) {
		const r = copy()
		;(r.ids as cbor.Value[])[raw] = "ermine:" + hex(ids[raw] as Uint8Array)
		out.push(["an ermine id as text", r])
		const old = copy()
		;(old.ids as cbor.Value[])[raw] = new Uint8Array(32)
		out.push(["an old pack's id: 32 bytes", old])
	}
	if (c.has) {
		const r = copy(), h = c.has as Uint8Array
		r.has = Uint8Array.from([h[0] | 128, 1, ...h.slice(1)])
		out.push(["a node with a bit past 64", r])
	}
	if (c.time) {
		const r = copy()
		r.time = Uint8Array.from([
			...varint(zigzag(2n ** 53n)),
			...(c.time as Uint8Array).slice(ends(c.time as Uint8Array)[0] + 1),
		])
		out.push(["a time past 2^53", r])
	}
	const s = copy()
	put(s, "stray", 1)
	out.push(["a column no pack has", s])
	return out
}

// a deflate of only stored blocks: the same bytes inflated, not what deflate writes
function stored(b: Uint8Array): Uint8Array {
	const out: number[] = []
	for (let at = 0; at < b.length || at === 0; at += 65535) {
		const n = Math.min(65535, b.length - at), last = at + 65535 >= b.length ? 1 : 0
		out.push(last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255, ...b.slice(at, at + n))
		if (last) break
	}
	return Uint8Array.from(out)
}

function packs(n: number, offset: number): Uint8Array[] {
	const out: Uint8Array[] = []
	for (let seed = 1; seed <= n; seed++) {
		const { pick } = rand(seed + offset)
		let t = table(pick)
		while (t.length < 3) {
			t = [...t, ...table(pick)].filter((e, i, a) =>
				a.findIndex((x) => x[0] === e[0] && x[1] === e[1]) === i
			)
		}
		out.push(pack(t))
	}
	return out
}

Deno.test(`pack fuzz: ${SEEDS} seeds, columns as pack never writes them are refused`, () => {
	const taken = new Map<string, string>()
	let tried = 0
	for (const [i, b] of packs(SEEDS, 2000).entries()) {
		const { pick } = rand(i + 3000)
		for (const [name, c] of rewrites(pick, columnsOf(b))) {
			tried++
			const kind = name.replace(/ \(.*/, "")
			if (code(() => unpack(wrap(c))) === "taken" && !taken.has(kind)) {
				taken.set(kind, `${name}: ${hex(wrap(c))}`)
			}
			// loosy passes over a column no pack has, and only that
			const loose = code(() => unpack(wrap(c), { loosyGoosy: true }))
			if (kind === "a column no pack has") assertEquals(loose, "taken")
		}
	}
	console.log(`  ${tried} rewrites, ${taken.size} kinds taken`)
	assertEquals([...taken.values()], [], "taken, though pack never writes them")
})

Deno.test(`pack fuzz: ${SEEDS} seeds, the columns deflated otherwise (open: told only)`, () => {
	let taken = 0
	for (const b of packs(SEEDS, 2000)) {
		const inner = inflate((cbor.decode(b) as { columns: Uint8Array }).columns, 2 ** 30)
		const other = cbor.encode({ columns: stored(inner) })
		if (code(() => unpack(other)) !== "taken") continue
		taken++
		const a = unpack(b), o = unpack(other)
		assertEquals(hex(pack(o)), hex(pack(a)), "the same read")
	}
	console.log(`  stored blocks: ${taken} of ${SEEDS} taken, each read as pack's own`)
})

// fields ---------------------------------------------------------------------

// a node map as written, with every map that can be in one
const full = () => ({
	change: {
		time: 1,
		actor: "x",
		external: [{ file: "a", line: 1, column: 2, function: "f" }],
		op: {
			patches: [{ path: ["a", 0], range: [0, 1], value: 1, move: { path: ["b"] } }],
			undo: [],
		},
	},
	value: 1,
})
type Full = ReturnType<typeof full>
const LEVELS: [string, (n: Full) => object][] = [
	["node", (n) => n],
	["change", (n) => n.change],
	["site", (n) => n.change.external[0]],
	["op", (n) => n.change.op],
	["patch", (n) => n.change.op.patches[0]],
	["move", (n) => n.change.op.patches[0].move],
]
const first = (n: unknown) => ({ keys: [["value", "a", 0]], nodes: [n] })
// a pack whose columns hold a node map's sites and op
const asColumns = (n: Full) => ({
	ids: ["a"],
	parts: [["value", 1]],
	which: Uint8Array.of(0),
	nodes: Uint8Array.of(0),
	has: Uint8Array.of(1 | 4 | 16 | 32),
	time: Uint8Array.from(varint(zigzag(BigInt(n.change.time)))),
	actor: [[n.change.actor, 1]],
	external: [[n.change.external, 1]],
	op: [n.change.op],
	values: [n.value],
})

Deno.test("pack fuzz: a key no map has, at every level: refused, unless loosyGoosy", () => {
	const plain = decode(cbor.encode(full() as never))
	for (const [level, at] of LEVELS) {
		for (const stray of ["x", "", "__proto__", "/", "valu"]) {
			const n = full()
			put(at(n), stray, 1)
			const ways: [string, Uint8Array, (b: Uint8Array, l: boolean) => unknown][] = [
				["decode", cbor.encode(n as never), (b, l) => decode(b, { loosyGoosy: l })],
				[
					"first form",
					cbor.encode(first(n) as never),
					(b, l) => unpack(b, { loosyGoosy: l })[0][2],
				],
			]
			if (level !== "node" && level !== "change") {
				ways.push(["columns", wrap(asColumns(n)), (b, l) => unpack(b, { loosyGoosy: l })[0][2]])
			}
			for (const [way, b, read] of ways) {
				const name = `${way}, ${stray} in the ${level}`
				assertEquals(
					code(() => read(b, false)),
					way === "decode" ? "not-a-node" : "not-a-pack",
					name,
				)
				assert(same(shown(read(b, true) as Node), shown(plain)), `${name}, loosy`)
			}
		}
	}
	// the outer maps, the map of columns
	const b = pack([["value", "a", plain]])
	const c = columnsOf(b)
	for (
		const x of [
			{ ...cbor.decode(b) as object, stray: 1 },
			{ ...first(full()), stray: 1 },
			{ columns: deflate(cbor.encode({ ...c, stray: 1 })) },
		]
	) {
		const bytes = cbor.encode(x as never)
		assertEquals(code(() => unpack(bytes)), "not-a-pack")
		assert(same(shown(unpack(bytes, { loosyGoosy: true })[0][2]), shown(plain)))
	}
})

// whole numbers' edges, and which each field takes
const EDGES = [0, 1, -1, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), -(2 ** 31) - 1, 2 ** 53 - 1, 2 ** 53]
	.concat([-(2 ** 53 - 1), -(2 ** 53), -0, 0.5, -1.5, NaN, Infinity, -Infinity, 1e300])
const safe = (x: number) => Number.isSafeInteger(x)
const int32 = (x: number) => safe(x) && x >= -(2 ** 31) && x < 2 ** 31
const FIELDS: [string, (n: Full, x: number) => void, (x: number) => boolean][] = [
	["time", (n, x) => n.change.time = x, safe],
	["range start", (n, x) => n.change.op.patches[0].range[0] = x, safe],
	["range end", (n, x) => n.change.op.patches[0].range[1] = x, safe],
	[
		"move's range",
		(n, x) => (n.change.op.patches[0].move as never as { range: number[] }).range = [x, 0],
		safe,
	],
	["line", (n, x) => n.change.external[0].line = x, int32],
	["column", (n, x) => n.change.external[0].column = x, int32],
	["path number", (n, x) => (n.change.op.patches[0].path as unknown[])[1] = x, int32],
	["move's path number", (n, x) => n.change.op.patches[0].move.path.push(x as never), int32],
]

Deno.test("pack fuzz: whole numbers at their edges, in pack, decode, the first form, the columns", () => {
	for (const [field, set, takes] of FIELDS) {
		for (const x of EDGES) {
			const n = full()
			set(n, x)
			const want = takes(x)
			const name = `${field} ${Object.is(x, -0) ? "-0" : x}`
			assertEquals(
				code(() => decode(cbor.encode(n as never))),
				want ? "taken" : "not-a-node",
				name,
			)
			assertEquals(
				code(() => unpack(cbor.encode(first(n) as never))),
				want ? "taken" : "not-a-pack",
				name,
			)
			if (field !== "time") {
				assertEquals(
					code(() => unpack(wrap(asColumns(n)))),
					want ? "taken" : "not-a-pack",
					name,
				)
			}
			// given to pack: a node that cannot be carried
			const given = createEntry(n.value, n.change as never)
			assertEquals(
				code(() => pack([["value", "a", given]])),
				want ? "taken" : "cannot-carry",
				name,
			)
			assertEquals(code(() => encode(given)), want ? "taken" : "cannot-carry", name)
			if (want) {
				const back = unpack(pack([["value", "a", given]]))[0][2]
				assert(same(shown(back), shown(given)), `${name}: back`)
			}
		}
	}
	// the columns' times: deltas summed, each node's time safe
	const two = (a: bigint, d: bigint) => ({
		ids: ["a"],
		parts: [["value", 2]],
		which: Uint8Array.of(0, 0),
		nodes: Uint8Array.of(0, 0),
		has: Uint8Array.of(0, 0),
		time: Uint8Array.from([...varint(zigzag(a)), ...varint(zigzag(d))]),
	})
	const S = 2n ** 53n - 1n
	assertEquals(code(() => unpack(wrap({ ...two(S, 0n), parts: [["a", 1], ["b", 1]] }))), "taken")
	for (const [a, d] of [[S, 1n], [-S, -1n], [S + 1n, -2n], [0n, 2n ** 64n], [S, -2n * S - 1n]]) {
		const c = { ...two(a, d), parts: [["a", 1], ["b", 1]] }
		assertEquals(code(() => unpack(wrap(c))), "not-a-pack", `times ${a} then ${d} more`)
	}
})

// a run very long --------------------------------------------------------------

Deno.test("pack fuzz: a run that says it is 2^32 - 1 long: not-a-pack, quickly", () => {
	const b = wrap({ parts: [["a", 2 ** 32 - 1]] })
	const t = performance.now()
	let e: unknown
	try {
		unpack(b)
	} catch (x) {
		e = x
	}
	const ms = performance.now() - t
	assert(e instanceof PackError && e.code === "not-a-pack", `${hex(b)}: ${String(e)}`)
	assert(ms < 1000, `${hex(b)}: ${ms | 0} ms`)
})

// across ---------------------------------------------------------------------

// a map whose content is the same, keys sorted (answers compare maps by content)
const stable = (x: unknown) =>
	line(
		x,
		(v) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as never)[k]]))
				: v,
	)

// the protocol's form of a node
function form(n: Node): Record<string, unknown> {
	const h = n.change as Record<string, unknown>
	const c: Record<string, unknown> = { ...h }
	if ("actor" in h) c.actor = toJson(h.actor)
	if ("metadata" in h) c.metadata = toJson(h.metadata)
	if ("op" in h) {
		const op = h.op as { patches: Record<string, unknown>[]; undo: Record<string, unknown>[] }
		const ps = (xs: Record<string, unknown>[]) =>
			xs.map((p) => "value" in p ? { ...p, value: toJson(p.value) } : p)
		c.op = { patches: ps(op.patches), undo: ps(op.undo) }
	}
	const out: Record<string, unknown> = { change: c }
	if (n.value !== undefined) out.value = toJson(n.value)
	return out
}
function asked(t: Entry[]) {
	const nodes: Node[] = []
	const entries = t.map(([p, i, n]) => {
		let k = nodes.indexOf(n)
		if (k < 0) k = nodes.push(n) - 1
		return [p, i, k]
	})
	return { entries, nodes: nodes.map(form) }
}

function mutate(pick: Pick, b: Uint8Array): Uint8Array {
	const x = Array.from(b)
	for (let k = 1 + pick(3); k > 0 && x.length; k--) {
		const at = pick(x.length)
		switch (pick(5)) {
			case 0:
				x[at] ^= 1 << pick(8)
				break
			case 1:
				x.splice(at, 0, pick(256))
				break
			case 2:
				x.splice(at, 1)
				break
			case 3:
				x.length = at
				break
			default:
				x.splice(at, 0, ...x.slice(at, at + 1 + pick(8)))
		}
	}
	return Uint8Array.from(x)
}

type Request = Record<string, unknown> & { op: string }

async function across(requests: Request[]) {
	const [got, want] = await Promise.all([
		ask(subject, requests as never),
		ask(reference, requests as never),
	])
	const wrong: string[] = [], counts: Record<string, number> = {}
	requests.forEach((r, i) => {
		const a = got[i] as Record<string, unknown>, w = want[i] as Record<string, unknown>
		const kind = `${r.op} ${w.code ?? "taken"}`
		counts[kind] = (counts[kind] ?? 0) + 1
		// cannot-carry: the C harness names no key for a node it cannot build (a symbol, a lone
		// surrogate or a number C has no form for); keys are compared when both name one
		const both = a.code === "cannot-carry" && w.code === "cannot-carry" &&
			(a.part === undefined || w.part === undefined)
		if (both || stable(a) === stable(w)) return
		wrong.push(
			`${stable(r).slice(0, 400)}\n  reference ${stable(w).slice(0, 300)}\n  harness   ${
				stable(a).slice(0, 300)
			}`,
		)
	})
	console.log(`  ${subject.at(-1)?.split("/").at(-1)}: ${line(counts)}`)
	assertEquals(wrong.slice(0, 10).join("\n"), "", `${wrong.length} of ${requests.length} differ`)
}

Deno.test(`pack fuzz: ${SEEDS} seeds across, packing and encoding (lone surrogates too)`, async () => {
	const requests: Request[] = []
	for (let seed = 1; seed <= SEEDS; seed++) {
		const { pick } = rand(seed + 4000)
		const t = table(pick, seed % 4 === 0)
		requests.push({ op: "pack", ...asked(t) })
		requests.push({ op: "pack", ...asked(t), options: { op: false } })
		for (const n of asked(t).nodes) requests.push({ op: "encode", node: n })
	}
	// the whole-number edges given
	for (const [, set] of FIELDS) {
		for (const x of EDGES) {
			const n = full()
			set(n, x)
			if (Number.isFinite(x)) {
				requests.push({ op: "pack", ...asked([["value", "a", n as never]]) })
			}
		}
	}
	await across(requests)
})

Deno.test(`pack fuzz: ${SEEDS} seeds across, reading packs, nodes and bytes near them`, async () => {
	const requests: Request[] = []
	const reads = (b: Uint8Array, op: string) => {
		requests.push({ op, bytes: hex(b) })
		requests.push({ op, bytes: hex(b), reading: { loosyGoosy: true } })
	}
	for (const [i, b] of packs(SEEDS, 5000).entries()) {
		const { pick } = rand(i + 6000)
		reads(b, "unpack")
		requests.push({ op: "unpack", bytes: hex(b), reading: { limit: 64 + pick(200) } })
		for (let k = 0; k < 10; k++) {
			const m = mutate(pick, b)
			requests.push({ op: "unpack", bytes: hex(m) }, { op: "decode", bytes: hex(m) })
		}
		for (const [, c] of rewrites(pick, columnsOf(b))) reads(wrap(c), "unpack")
		reads(
			cbor.encode({
				columns: stored(inflate((cbor.decode(b) as { columns: Uint8Array }).columns, 2 ** 30)),
			}),
			"unpack",
		)
		for (const [, , n] of unpack(b).slice(0, 3)) {
			const e = encode(n)
			reads(e, "decode")
			for (let k = 0; k < 5; k++) requests.push({ op: "decode", bytes: hex(mutate(pick, e)) })
		}
	}
	// a key no map has; whole numbers at their edges
	for (const [level, at] of LEVELS) {
		const n = full()
		put(at(n), "x", 1)
		reads(cbor.encode(n as never), "decode")
		reads(cbor.encode(first(n) as never), "unpack")
		if (level !== "node" && level !== "change") reads(wrap(asColumns(n)), "unpack")
	}
	for (const [field, set] of FIELDS) {
		for (const x of EDGES) {
			const n = full()
			set(n, x)
			reads(cbor.encode(n as never), "decode")
			reads(cbor.encode(first(n) as never), "unpack")
			if (field !== "time") reads(wrap(asColumns(n)), "unpack")
		}
	}
	// random bytes, short
	const { pick } = rand(7000)
	for (let n = 0; n < 300; n++) {
		const b = Uint8Array.from({ length: 1 + pick(12) }, () => pick(256))
		requests.push({ op: "unpack", bytes: hex(b) }, { op: "decode", bytes: hex(b) })
	}
	await across(requests)
})

// KNOWN PROBLEM, written down and not fixed on purpose (chee 10-17): the first form {keys, nodes} is
// read, and pack.ts says that is on purpose today; open. One content then has two byte forms, so
// the encoding is not canonical. pinned: one form per content, the first form refused. fails today:
// it is read, and packs to other bytes than it came as
Deno.test("pack fuzz: KNOWN PROBLEM (on purpose today per pack.ts; open): the first form is a second encoding of one content", () => {
	const n = createEntry({ change: { time: 1, actor: "x" }, value: "hi" })
	const written = pack([["value", "a", n]])
	const firstForm = cbor.encode({
		keys: [["value", "a", 0]],
		nodes: [{ change: { time: 1, actor: "x" }, value: "hi" }],
	})
	assert(hex(written) !== hex(firstForm), "two byte forms")
	assertEquals(code(() => unpack(written)), "taken")
	assertEquals(code(() => unpack(firstForm)), "not-a-pack", "one form per content")
})
