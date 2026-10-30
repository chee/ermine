import { assertEquals, assertThrows } from "@std/assert"
import { CborError, decode, DEPTH, encode, Stand, type Value } from "./cbor.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => new Uint8Array(s.match(/../g)?.map((x) => parseInt(x, 16)) ?? [])
const bytes = (...xs: number[]) => new Uint8Array(xs)

// a number as read back: -0 is 0, a whole number past 2^53 - 1 a bigint, a safe bigint a number
const canon = (x: number | bigint) =>
	typeof x === "bigint"
		? (x >= -(2n ** 53n) + 1n && x <= 2n ** 53n - 1n ? Number(x) : x)
		: Number.isInteger(x) && !Number.isSafeInteger(x)
		? BigInt(x)
		: x === 0
		? 0
		: x

/** Equal as cbor.ts has it: numbers by value (Object.is after canon), kinds apart, maps in any order. */
function same(a: unknown, b: unknown): boolean {
	if (typeof a === "number" || typeof a === "bigint") {
		return (typeof b === "number" || typeof b === "bigint") && Object.is(canon(a), canon(b))
	}
	if (a === null || typeof a !== "object") return a === b
	if (b === null || typeof b !== "object") return false
	if (ArrayBuffer.isView(a)) {
		if (!ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false
		const x = Array.from(a as unknown as ArrayLike<unknown>),
			y = Array.from(b as unknown as ArrayLike<unknown>)
		return x.length === y.length && x.every((e, i) => same(e, y[i]))
	}
	if (a instanceof Stand) return b instanceof Stand && same(a.kind, b.kind)
	if (b instanceof Stand) return false
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((e, i) => same(e, b[i]))
	}
	if (Array.isArray(b) || ArrayBuffer.isView(b)) return false
	const ka = Object.keys(a), kb = Object.keys(b)
	return ka.length === kb.length &&
		ka.every((k) => Object.hasOwn(b, k) && same((a as never)[k], (b as never)[k]))
}

const VECTORS: [string, Value, string][] = [
	["null", null, "f6"],
	["false", false, "f4"],
	["true", true, "f5"],
	["0", 0, "00"],
	["1 is an integer", 1, "01"],
	["-1", -1, "20"],
	["23", 23, "17"],
	["24 in two bytes", 24, "1818"],
	["-25", -25, "3818"],
	["65535", 65535, "19ffff"],
	["65536 in five bytes", 65536, "1a00010000"],
	["100000", 100000, "1a000186a0"],
	["2^32 in nine bytes", 2 ** 32, "1b0000000100000000"],
	["2^53 - 1, the last safe", 2 ** 53 - 1, "1b001fffffffffffff"],
	["-(2^53 - 1)", -(2 ** 53 - 1), "3b001ffffffffffffe"],
	["1.5", 1.5, "f93e00"],
	["smallest half subnormal", 2 ** -24, "f90001"],
	["smallest half normal", 2 ** -14, "f90400"],
	["a half subnormal", 3 * 2 ** -20, "f90030"],
	["65504.5 needs a float32", 65504.5, "fa477fe080"],
	["2^-25 needs a float32", 2 ** -25, "fa33000000"],
	["1.1 needs a float64", 1.1, "fb3ff199999999999a"],
	["0.1", 0.1, "fb3fb999999999999a"],
	["Infinity", Infinity, "f97c00"],
	["-Infinity", -Infinity, "f9fc00"],
	["NaN", NaN, "f97e00"],
	["empty string", "", "60"],
	["a", "a", "6161"],
	["ü", "ü", "62c3bc"],
	["水", "水", "63e6b0b4"],
	["😀", "😀", "64f09f9880"],
	["24-byte string", "x".repeat(24), "7818" + "78".repeat(24)],
	["empty bytes", bytes(), "40"],
	["bytes", bytes(1, 2, 3, 4), "4401020304"],
	["empty list", [], "80"],
	["nested list", [1, [2, 3]], "8201820203"],
	["empty map", {}, "a0"],
	[
		"map keys sorted by encoding",
		{ b: 1, aa: 3, a: 2 },
		"a3616102616201626161 03".replace(" ", ""),
	],
	["a Uint8Array is bytes", new Uint8Array([1, 2]), "420102"],
	["uint16", new Uint16Array([1, 0x0203]), "d84544" + "0100" + "0302"],
	["uint32", new Uint32Array([1]), "d8464401000000"],
	["uint64", new BigUint64Array([2n ** 64n - 1n]), "d84748ffffffffffffffff"],
	["int8", new Int8Array([-1, 1]), "d84842ff01"],
	["int16", new Int16Array([-2]), "d84d42feff"],
	["int32", new Int32Array([-1]), "d84e44ffffffff"],
	["int64", new BigInt64Array([-2n]), "d84f48feffffffffffffff"],
	["float32", new Float32Array([1.5]), "d855440000c03f"],
	["float64", new Float64Array([1]), "d85648000000000000f03f"],
	["empty float64", new Float64Array(0), "d85640"],
	["a stand-in", new Stand("canvas"), "da123456786663616e766173"],
	["a stand-in of null", new Stand(null), "da12345678f6"],
	["a stand-in of a map", new Stand({ w: 2, url: "x" }), "da12345678a26177026375726c6178"],
	[
		"a stand-in of a stand-in in a list",
		[new Stand(new Stand("a"))],
		"81da12345678da123456786161",
	],
	[
		"a typed array and bytes in a map",
		{ u: new Int8Array([7]), b: bytes(7) },
		"a2616241076175d8484107",
	],
]

for (const [name, value, want] of VECTORS) {
	Deno.test(`cbor: ${name}`, () => {
		const got = encode(value)
		assertEquals(hex(got), want)
		const back = decode(got)
		if (!same(back, value)) throw new Error(`round trip of ${name} gave ${String(back)}`)
		assertEquals(hex(encode(back)), want)
	})
}

Deno.test("cbor: a NaN element is the one NaN", () => {
	const f32 = new Float32Array(1)
	new Uint32Array(f32.buffer)[0] = 0x7fc00001
	assertEquals(hex(encode(f32)), "d855440000c07f")
	const f64 = new Float64Array(1)
	new BigUint64Array(f64.buffer)[0] = 0xfff0000000000001n
	assertEquals(hex(encode(f64)), "d85648000000000000f87f")
	assertThrows(() => decode(unhex("d855440100c07f")), CborError)
	assertThrows(() => decode(unhex("d85648010000000000f87f")), CborError)
})

Deno.test("cbor: a view into a larger buffer encodes only its elements", () => {
	const whole = new Uint16Array([1, 2, 3, 4])
	assertEquals(hex(encode(whole.subarray(1, 3))), "d84544" + "0200" + "0300")
	assertEquals(hex(encode(bytes(1, 2, 3, 4).subarray(1, 3))), "420203")
})

Deno.test("cbor: decoding gives fresh values of their own class", () => {
	const t = decode(unhex("d84544" + "0100" + "0302"))
	if (!(t instanceof Uint16Array)) throw new Error("not a Uint16Array")
	assertEquals(Array.from(t), [1, 0x0203])
	assertEquals(t.byteOffset, 0)
	const input = unhex("4401020304")
	const b = decode(input)
	if (!(b instanceof Uint8Array)) throw new Error("bytes are not a Uint8Array")
	assertEquals(Array.from(b), [1, 2, 3, 4])
	assertEquals([b.byteOffset, b.buffer.byteLength], [0, 4])
	input[1] = 9
	assertEquals(b[0], 1)
	const m = decode(unhex("a1695f5f70726f746f5f5ff6")) as { [k: string]: Value }
	assertEquals(Object.keys(m), ["__proto__"])
	assertEquals(Object.getPrototypeOf(m), Object.prototype)
})

const REJECTED: [string, string][] = [
	["an integer in a longer head", "1817"],
	["a negative integer in a longer head", "3817"],
	["an integer in an eight-byte head a four-byte one holds", "1b00000000ffffffff"],
	["an indefinite integer", "1f"],
	["a reserved integer head", "1c"],
	["an integer that ends early", "1a0001"],
	["0 as a half", "f90000"],
	["-0 as a half", "f98000"],
	["1 as a half", "f93c00"],
	["1 as a float32", "fa3f800000"],
	["1 as a float64", "fb3ff0000000000000"],
	["2^53 as a float32", "fa5a000000"],
	["2^64 as a float32", "fa5f800000"],
	["1e300 as a float64", "fb7e37e43c8800759c"],
	["a bignum a plain integer holds", "c2480100000000000000"],
	["a bignum of nothing", "c240"],
	["a bignum with a leading zero", "c24a00010000000000000000"],
	["a negative bignum with a leading zero", "c34a00010000000000000000"],
	["a bignum over a string", "c2696161616161616161 61".replace(" ", "")],
	["a bignum in a longer tag head", "d802490100000000000000 00".replace(" ", "")],
	["1.5 as a float64", "fb3ff8000000000000"],
	["100000 as a float64", "fb40f86a0000000000"],
	["a NaN with a payload", "f97e01"],
	["a signalling NaN", "f97c01"],
	["a negative NaN", "f9fe00"],
	["NaN as a float32", "fa7fc00000"],
	["NaN as a float64", "fb7ff8000000000000"],
	["Infinity as a float32", "fa7f800000"],
	["undefined", "f7"],
	["a simple value", "f820"],
	["a low simple value", "e0"],
	["a break", "ff"],
	["an indefinite string", "7f6161ff"],
	["an indefinite list", "9fff"],
	["an indefinite map", "bfff"],
	["a reserved head", "7c"],
	["a string head longer than needed", "780161"],
	["a list head longer than needed", "990000"],
	["a bytes head longer than needed", "5a0000000101"],
	["a list head of 8 bytes", "9b0000000000000000"],
	["a string that is not UTF-8", "62c328"],
	["a string with a surrogate", "63eda080"],
	["a map key that is not a string", "a14161f6"],
	["a map key that is a number", "a101f6"],
	["a map key that is a float", "a1f93e00f6"],
	["map keys out of order", "a26162f66161f6"],
	["longer key first", "a2626161f66162f6"],
	["a repeated key", "a26161f66161f6"],
	["an unknown tag", "c140"],
	["a big-endian tag", "d84142000100"],
	["tag 64: no uint8 kind, bytes are that", "d840420102"],
	["tag 64 over nothing", "d84040"],
	["a typed array tag head longer than needed", "d9004542 0100"],
	["a typed array over a list", "d84580"],
	["the stand-in's tag in an eight-byte head", "db0000000012345678f6"],
	["a stand-in with no kind", "da12345678"],
	["a stand-in's tag head longer than needed", "db00000000123456786161"],
	["a typed array with part of an element", "d8454101"],
	["a typed array with a long bytes head", "d84558020100"],
	["a tagged tag", "d845d84540"],
	["bytes after the value", "f6f6"],
	["nothing", ""],
	["a value that ends early", "82f6"],
	["a float that ends early", "f93c"],
	["a string that ends early", "6261"],
	["a length past the input", "5bffffffffffffffff"],
]

for (const [name, h] of REJECTED) {
	Deno.test(`cbor: decoding rejects ${name}`, () => {
		assertThrows(() => decode(unhex(h.replaceAll(" ", ""))), CborError)
	})
}

class Canvas {}

const UNENCODABLE: [string, unknown][] = [
	["a live value", new Canvas()],
	["a live value in a list", [new Canvas()]],
	["undefined", undefined],
	["a function", () => 1],
	["a symbol", Symbol("s")],
	["a Date", new Date(0)],
	["a Map", new Map()],
	["a clamped array", new Uint8ClampedArray(1)],
	["a DataView", new DataView(new ArrayBuffer(1))],
	["an ArrayBuffer, which is live,", new ArrayBuffer(1)],
	["an ArrayBuffer in a map", { b: new ArrayBuffer(0) }],
	["a lone surrogate", "\ud800"],
	["a lone surrogate as a key", { "\udc00": 1 }],
	["undefined in a map", { a: undefined }],
]

for (const [name, x] of UNENCODABLE) {
	Deno.test(`cbor: ${name} has no encoding`, () => {
		assertThrows(() => encode(x as Value), CborError)
	})
}

Deno.test("cbor: a value that holds itself has no encoding", () => {
	const a: Value[] = []
	a.push(a)
	assertThrows(() => encode(a), CborError)
	const shared = [1]
	assertEquals(hex(encode([shared, shared])), "8281018101")
})

const s = Symbol("s"), r = Symbol.for("ermine.places.root")
const SYMBOLS: [string, unknown][] = [
	["a symbol for a name", r],
	["a symbol in a map", { a: s, b: 1 }],
	["a symbol key", { [s]: 1, b: 2 }],
	["a symbol in a list", [1, s]],
	["an entry by a symbol", { a: [[r, "x"]] }],
	["a symbol deep", { a: [{ b: [1, s] }] }],
	["a symbol as a stand-in's kind", new Stand(s as never)],
]

for (const [name, x] of SYMBOLS) {
	Deno.test(`cbor: ${name} has no encoding`, () => {
		assertThrows(() => encode(x as Value), CborError)
	})
}

function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed / 0x80000000
	}
}

const NUMBERS = [
	0,
	-0,
	1,
	-1,
	0.5,
	1 / 3,
	65504,
	65505,
	2 ** -24,
	2 ** -25,
	2 ** -1074,
	1e308,
	NaN,
	Infinity,
	-Infinity,
	Number.MAX_SAFE_INTEGER,
	2 ** 53,
	2 ** 64,
	-(2 ** 64),
	2 ** 70,
	5n,
	2n ** 53n + 1n,
	-(2n ** 53n) - 1n,
	2n ** 64n - 1n,
	-(2n ** 64n),
	2n ** 64n,
	-(2n ** 64n) - 1n,
	-(2n ** 100n),
]

function text(r: () => number): string {
	return Array.from(
		{ length: Math.floor(r() * 6) },
		() => String.fromCodePoint([0x61, 0xfc, 0x6c34, 0x1f600][Math.floor(r() * 4)]),
	).join("")
}

function generate(r: () => number, depth: number): Value {
	const n = Math.floor(r() * (depth > 3 ? 7 : 10))
	switch (n) {
		case 0:
			return null
		case 1:
			return r() < 0.5
		case 2: {
			const pick = r()
			if (pick < 0.4) return NUMBERS[Math.floor(r() * NUMBERS.length)]
			if (pick < 0.7) return Math.floor((r() - 0.5) * 2 ** Math.floor(r() * 60))
			const f = new Float64Array(1)
			new Uint32Array(f.buffer).set([Math.floor(r() * 2 ** 32), Math.floor(r() * 2 ** 32)])
			return f[0]
		}
		case 3:
			return text(r)
		case 4:
			return bytes(...Array.from({ length: Math.floor(r() * 5) }, () => Math.floor(r() * 256)))
		case 5: {
			const kinds = [
				Int8Array,
				Int16Array,
				Uint16Array,
				Int32Array,
				Uint32Array,
				Float32Array,
				Float64Array,
			]
			const len = Math.floor(r() * 4)
			if (r() < 0.2) {
				return new (r() < 0.5 ? BigInt64Array : BigUint64Array)(len).map(() =>
					BigInt(Math.floor(r() * 2 ** 40)) - 2n ** 39n
				)
			}
			const t = new kinds[Math.floor(r() * kinds.length)](len)
			new Uint8Array(t.buffer).forEach((_, i, a) => a[i] = Math.floor(r() * 256))
			return t
		}
		case 6:
			return Math.floor(r() * 3) - 1
		case 7:
		case 8:
			return Array.from({ length: Math.floor(r() * 4) }, () => generate(r, depth + 1))
		default: {
			const m: { [k: string]: Value } = {}
			for (let i = Math.floor(r() * 4); i > 0; i--) m[text(r)] = generate(r, depth + 1)
			return m
		}
	}
}

Deno.test("cbor: round trips", () => {
	for (let seed = 1; seed <= 40; seed++) {
		const r = rng(seed)
		for (let i = 0; i < 50; i++) {
			const v = generate(r, 0)
			const e = encode(v)
			const back = decode(e)
			if (!same(back, v)) throw new Error(`seed ${seed}: round trip changed ${hex(e)}`)
			assertEquals(hex(encode(back)), hex(e), `seed ${seed}`)
		}
	}
})

// the shared vectors: each a value in its JSON form (conformance/typescript/form.ts) and its encoding in hex,
// bytes in hex that no value encodes as, or a JSON form that is no value

const TYPED: { [kind: string]: new (xs: never[]) => ArrayBufferView } = {
	int8: Int8Array,
	int16: Int16Array,
	uint16: Uint16Array,
	int32: Int32Array,
	uint32: Uint32Array,
	int64: BigInt64Array,
	uint64: BigUint64Array,
	float32: Float32Array,
	float64: Float64Array,
}

const special = (x: unknown) => typeof x === "string" ? Number(x) : x as number

/** A value from its JSON form. */
function fromJson(x: unknown): Value {
	if (x === null || typeof x !== "object") return x as Value
	if (Array.isArray(x)) return x.map(fromJson)
	const keys = Object.keys(x)
	if (keys.length === 1 && keys[0] === "/") {
		const [[tag, body]] = Object.entries((x as { "/": object })["/"])
		if (tag === "live") return new Stand(fromJson(body))
		if (tag === "bytes") return Uint8Array.from(atob(body as string), (c) => c.charCodeAt(0))
		if (tag === "number") return Number(body)
		if (tag === "bigint") return BigInt(body as string)
		if (tag === "map") return { "/": fromJson((body as { "/": unknown })["/"]) }
		const T = TYPED[tag]
		if (!T) throw new Error(`no value for ${tag}`)
		const big = tag === "int64" || tag === "uint64"
		return new T(
			(body as unknown[]).map((e) =>
				big ? BigInt(/^-?[0-9]+$/.test(e as string) ? e as string : NaN) : special(e)
			) as never[],
		) as Value
	}
	return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fromJson(v)]))
}

Deno.test("cbor: agrees with cbor/conformance/vectors.json", async () => {
	const text = await Deno.readTextFile(
		new URL("../conformance/cbor/vectors.json", import.meta.url),
	)
	const doc = JSON.parse(text)
	const list: { [k: string]: unknown }[] = Array.isArray(doc) ? doc : doc.vectors
	const disagree: string[] = []
	for (const v of list) {
		const want = String(v.cbor ?? v.hex ?? v.encoding ?? v.bytes).toLowerCase()
		const name = String(v.name ?? want)
		const has = (k: string) => Object.hasOwn(v, k)
		if (has("form")) {
			try {
				fromJson(v.form)
				disagree.push(`${JSON.stringify(v.form)}: a value, the vector says none (${v.refused})`)
			} catch {
			}
		} else if (has("value") || has("json")) {
			const value = fromJson(has("value") ? v.value : v.json)
			let got: string
			try {
				got = hex(encode(value))
			} catch (e) {
				got = `throws ${e}`
			}
			if (got !== want) disagree.push(`${name}: encodes as ${got}, the vector says ${want}`)
			try {
				if (!same(decode(unhex(want)), value)) {
					disagree.push(`${name}: decodes to another value`)
				}
			} catch (e) {
				disagree.push(`${name}: decoding throws ${e}`)
			}
		} else {
			try {
				decode(unhex(want))
				disagree.push(`${name}: decodes, the vector says it is no encoding`)
			} catch {
			}
		}
	}
	assertEquals(disagree, [])
})

Deno.test("cbor: strings across the buffer's growing", () => {
	for (let pad = 0; pad < 300; pad += 7) {
		const v = ["x".repeat(pad), "é水😀".repeat(1 + pad % 13), "ü".repeat(30)]
		assertEquals(decode(encode(v)), v)
	}
})

function nest(n: number): Value {
	let v: Value = []
	for (let i = n - 1; i >= 1; i--) v = i === Math.floor(n / 2) ? { k: v } : [v]
	return v
}

Deno.test("cbor: a value nests at most DEPTH containers, either way, refused without overflowing", () => {
	const most = nest(DEPTH)
	assertEquals(decode(encode(most)), most)
	for (const n of [DEPTH + 1, 1_000_000]) {
		assertThrows(() => encode(nest(n)), CborError, "deeper")
		const bytes = new Uint8Array(n).fill(0x81)
		bytes[n - 1] = 0x80
		assertThrows(() => decode(bytes), CborError, "nested deeper than 1024")
	}
	assertThrows(() => decode(new Uint8Array(DEPTH + 1).fill(0xd8)), CborError)
})

function named() {}
class Kennel {}
const LIVE: [string, unknown, string][] = [
	["a named function", named, "function named"],
	["an anonymous function", (() => () => 1)(), "function anonymous"],
	["a symbol", Symbol("s"), "Symbol(s)"],
	["a Map", new Map(), "Map"],
	["a Set", new Set(), "Set"],
	["a Promise", Promise.resolve(), "Promise"],
	["an ArrayBuffer", new ArrayBuffer(1), "ArrayBuffer"],
	["a clamped array", new Uint8ClampedArray(1), "Uint8ClampedArray"],
	["a Date", new Date(0), "Date"],
	["a class object", new Kennel(), "Kennel"],
	["an object with no constructor name", Object.create({ constructor: 1 }), "object"],
]

for (const [name, x, kind] of LIVE) {
	Deno.test(`cbor: live: ${name} is a stand-in of "${kind}"`, () => {
		assertThrows(() => encode(x as Value), CborError)
		assertThrows(() => encode(x as Value, { live: false }), CborError)
		const bytes = encode(x as Value, { live: true })
		assertEquals(hex(bytes), hex(encode(new Stand(kind))))
		assertEquals(decode(bytes), new Stand(kind))
		const inside = { a: [x, 1], b: x } as unknown as Value
		assertEquals(decode(encode(inside, { live: true })), {
			a: [new Stand(kind), 1],
			b: new Stand(kind),
		})
	})
}

Deno.test("cbor: live changes nothing for a value without live things", () => {
	const v: Value = { a: [1, "x", null, new Uint16Array([1]), new Stand("k")], b: 2n ** 70n }
	assertEquals(hex(encode(v, { live: true })), hex(encode(v)))
})

Deno.test("cbor: live still refuses what is not a live value", () => {
	const opt = { live: true }
	const a: Value[] = []
	a.push(a)
	for (let i = 0; i < 70; i++) a.push(a)
	let deep: Value = [], n: Value = deep
	for (let i = 0; i < 70; i++) n = (n as Value[])[0] = [] as Value[]
	;(n as Value[]).push(deep)
	for (
		const x of [
			a,
			deep,
			nest(DEPTH + 1),
			{ [Symbol("k")]: 1 },
			undefined,
			{ a: undefined },
			"\ud800",
			new Stand(undefined as never),
		]
	) {
		assertThrows(() => encode(x as Value, opt), CborError)
	}
	let held: unknown = () => 1
	for (let i = 0; i < DEPTH; i++) held = [held]
	assertThrows(() => encode(held as Value, opt), CborError, "deeper")
})
