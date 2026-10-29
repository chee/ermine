// what the encoding's fuzz tests share (cbor_fuzz_test.ts; @ermine/formats' commit and hash
// fuzz tests): seeded numbers, values of every kind, value equality, non-canonical rewrites of an
// encoding and bytes near one. seeded and deterministic: a seed is a run
// the rules (cbor.ts): whole numbers are integers (bignums past 64 bits), -0 is 0, other numbers
// the shortest float; read back a number while safe, a bigint past that. same() compares numbers
// so; rewrites write an integer as a float, as a bignum, a bignum with a leading zero
import { decode, Stand, type Value } from "./cbor.ts"
import { line, toJson } from "../../conformance/typescript/form.ts"

export function rand(seed: number) {
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
export type Pick = (n: number) => number

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const cat = (...parts: (Uint8Array | number[])[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) out.set(p, at), at += p.length
	return out
}

// values ---------------------------------------------------------------------

export const NUMBERS = [
	0,
	-0,
	1,
	-1,
	1.5,
	0.1,
	-4.1,
	65504,
	65505,
	65520,
	-65504,
	2 ** -14,
	2 ** -24,
	3 * 2 ** -24,
	2 ** -25,
	2 ** -126,
	2 ** -149,
	2 ** -150,
	5e-324,
	2.2250738585072014e-308,
	2 ** 53 - 1,
	2 ** 53,
	2 ** 53 + 1,
	2 ** 53 + 2,
	-(2 ** 53),
	2 ** 64,
	1e300,
	-1e300,
	1.7976931348623157e308,
	3.4028234663852886e38,
	3.4028235677973366e38,
	16777216,
	16777217,
	100000,
	NaN,
	Infinity,
	-Infinity,
	-(2 ** 64),
	2 ** 63,
	2 ** 100,
	-(2 ** 100),
	5n,
	-5n,
	2n ** 53n - 1n,
	2n ** 53n + 1n,
	-(2n ** 53n) - 1n,
	2n ** 63n,
	2n ** 64n - 1n,
	2n ** 64n,
	-(2n ** 64n),
	-(2n ** 64n) - 1n,
	2n ** 200n + 3n,
]
// a whole number near an edge: 2^k and its neighbours, either sign, a number or a bigint
export function whole(pick: Pick): number | bigint {
	const k = BigInt([7, 8, 15, 16, 31, 32, 52, 53, 54, 63, 64, 65, 100][pick(13)])
	const n = (pick(2) ? -1n : 1n) * (2n ** k + BigInt(pick(5)) - 2n)
	return pick(2) ? n : Number(n)
}
// a double from 64 random bits, or one a half or a single holds exactly, or a whole number
export function number(pick: Pick): number | bigint {
	const v = new DataView(new ArrayBuffer(8))
	switch (pick(6)) {
		case 5:
			return whole(pick)
		case 0:
			return NUMBERS[pick(NUMBERS.length)]
		case 1:
			v.setUint32(0, pick(2 ** 32)), v.setUint32(4, pick(2 ** 32))
			return v.getFloat64(0)
		case 2:
			v.setUint32(0, pick(2 ** 32))
			return v.getFloat32(0)
		case 3:
			v.setUint16(0, pick(2 ** 16))
			return v.getFloat16(0)
		default:
			return (pick(2) ? -1 : 1) * pick(2 ** 20) * 2 ** (pick(80) - 40)
	}
}

export const PARTS = [
	"a",
	"é",
	"中",
	"😀",
	"👍🏽",
	"\uD83D",
	"\uDE00",
	"\uD800",
	"\uDC00",
	"😀",
	"\u0000",
	"￿",
	"﻿",
	"\u007F",
	"\u0080",
	"߿",
	"ࠀ",
	"􏿿",
	'"\\\n',
	"/",
]
// a string; lone surrogates only when asked
export function text(pick: Pick, lone: boolean, most = 6): string {
	const ps = lone ? PARTS : PARTS.filter((p) => p.isWellFormed())
	let s = ""
	for (let n = pick(most + 1); n > 0; n--) s += ps[pick(ps.length)]
	// a high then a low from two parts is a pair: whole, as asked
	return lone || s.isWellFormed() ? s : s.toWellFormed()
}

export const KEYS = [
	"",
	"a",
	"b",
	"0",
	"1",
	"10",
	"01",
	"-1",
	"4294967294",
	"4294967295",
	"__proto__",
	"constructor",
	"toString",
	"hasOwnProperty",
	"/",
	"😀",
	"￿a",
	"ｚ",
	"\u0000",
	"a\u0000",
	"x".repeat(23),
	"x".repeat(24),
	"é",
]

export const KINDS = [
	Int8Array,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	BigInt64Array,
	BigUint64Array,
	Float32Array,
	Float64Array,
] as const

// elements from random bytes (a float NaN with any payload, -0), some set to edges
export function typed(pick: Pick): Value {
	const T = KINDS[pick(KINDS.length)]
	const n = pick(5)
	const size = T.BYTES_PER_ELEMENT
	// sometimes a view into a bigger buffer, not at its start
	const skip = pick(3) === 0 ? pick(3) : 0
	const buf = new Uint8Array((n + skip + 1) * size)
	for (let i = 0; i < buf.length; i++) buf[i] = pick(256)
	const t = new T(buf.buffer, skip * size, n)
	if (t instanceof Float32Array || t instanceof Float64Array) {
		for (let i = 0; i < n; i++) if (pick(3) === 0) t[i] = [NaN, -0, Infinity, 0.1][pick(4)]
	}
	return t as Value
}

export function bytes(pick: Pick): Uint8Array {
	const n = [0, 1, 2, 23, 24, 255, 256][pick(7)]
	const buf = new Uint8Array(n + 4)
	for (let i = 0; i < buf.length; i++) buf[i] = pick(256)
	return pick(3) === 0 ? buf.subarray(2, 2 + n) : buf.slice(0, n)
}

// a value; lone: strings and keys may hold lone surrogates
export function value(pick: Pick, lone = false, depth = 0): Value {
	const k = pick(depth >= 4 ? 7 : 11)
	switch (k) {
		case 0:
			return [null, true, false][pick(3)]
		case 1:
		case 2:
			return number(pick)
		case 3:
			return text(pick, lone, pick(4) === 0 ? 40 : 6)
		case 4:
			return bytes(pick)
		case 5:
			return typed(pick)
		case 6:
			return pick(4) === 0 ? text(pick, lone, 600) : number(pick)
		case 7:
		case 8:
			return Array.from({ length: pick(5) }, () => value(pick, lone, depth + 1))
		case 9: {
			const n = pick(4) === 0 ? 17 + pick(30) : pick(6)
			const m: Record<string, Value> = {}
			for (let i = 0; i < n; i++) {
				const key = pick(2) ? KEYS[pick(KEYS.length)] : text(pick, lone, 4)
				Object.defineProperty(m, key, {
					value: value(pick, lone, depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
			return m
		}
		default:
			return new Stand(value(pick, lone, depth + 1))
	}
}

// the same value, made again: maps' keys in another order, typed arrays and bytes in fresh buffers
export function shuffled(pick: Pick, v: Value): Value {
	if (v === null || typeof v !== "object") return v
	if (v instanceof Stand) return new Stand(shuffled(pick, v.kind))
	if (ArrayBuffer.isView(v)) return (v as Uint8Array).slice()
	if (Array.isArray(v)) return v.map((x) => shuffled(pick, x))
	const keys = Object.keys(v)
	for (let i = keys.length - 1; i > 0; i--) {
		const j = pick(i + 1)
		;[keys[i], keys[j]] = [keys[j], keys[i]]
	}
	const m = pick(2) ? Object.create(null) : {}
	for (const k of keys) {
		Object.defineProperty(m, k, {
			value: shuffled(pick, (v as Record<string, Value>)[k]),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return m
}

// a number as read back: -0 is 0, a whole number past 2^53 - 1 a bigint, a safe bigint a number
export const canon = (x: number | bigint) =>
	typeof x === "bigint"
		? (x >= -(2n ** 53n) + 1n && x <= 2n ** 53n - 1n ? Number(x) : x)
		: Number.isInteger(x) && !Number.isSafeInteger(x)
		? BigInt(x)
		: x === 0
		? 0
		: x

// equal as cbor.ts has it: numbers by value (canon, then Object.is), kinds apart, NaN elements
// equal, maps by content. a typed array's elements as they are (-0 kept)
export function same(a: unknown, b: unknown, inside = false): boolean {
	if (inside) return Object.is(a, b)
	if (typeof a === "number" || typeof a === "bigint") {
		return (typeof b === "number" || typeof b === "bigint") && Object.is(canon(a), canon(b))
	}
	if (a === null || typeof a !== "object") return a === b
	if (b === null || typeof b !== "object") return false
	if (ArrayBuffer.isView(a)) {
		if (!ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false
		const x = Array.from(a as unknown as ArrayLike<unknown>),
			y = Array.from(b as unknown as ArrayLike<unknown>)
		return x.length === y.length && x.every((e, i) => same(e, y[i], true))
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

export const show = (v: unknown) => {
	const s = line(toJson(v))
	return s.length > 300 ? s.slice(0, 300) + "…" : s
}

// an encoding's items, read plainly (only what encode writes: definite heads, floats, f4-f6)
export type Item = {
	at: number
	body: number
	end: number
	major: number
	arg: number
	kids: Item[]
}
export function items(b: Uint8Array, at = 0): Item {
	const ib = b[at], major = ib >> 5, info = ib & 31
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
	let arg = info, body = at + 1
	if (major !== 7) {
		if (info === 24) arg = b[at + 1], body += 1
		else if (info === 25) arg = v.getUint16(at + 1), body += 2
		else if (info === 26) arg = v.getUint32(at + 1), body += 4
		else if (info === 27) arg = Number(v.getBigUint64(at + 1)), body += 8
	} else body += info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0
	const kids: Item[] = []
	let end = body
	if (major === 2 || major === 3) end = body + arg
	else if (major === 4 || major === 5 || major === 6) {
		const n = major === 4 ? arg : major === 5 ? 2 * arg : 1
		for (let i = 0; i < n; i++) {
			const kid = items(b, end)
			kids.push(kid)
			end = kid.end
		}
	}
	return { at, body, end, major, arg, kids }
}
export function every(i: Item, out: Item[] = []): Item[] {
	out.push(i)
	for (const k of i.kids) every(k, out)
	return out
}

// a head, in the fewest bytes, or in `info`'s width
export function head(major: number, arg: number | bigint, info?: number): Uint8Array {
	const n = BigInt(arg)
	info ??= n < 24n ? Number(n) : n < 0x100n ? 24 : n < 0x10000n ? 25 : n < 0x100000000n ? 26 : 27
	const width = info < 24 ? 0 : 2 ** (info - 24)
	const out = new Uint8Array(1 + width)
	out[0] = (major << 5) | info
	for (let i = 0; i < width; i++) out[width - i] = Number((n >> BigInt(8 * i)) & 0xffn)
	return out
}

// the bytes with [from, to) replaced
export const splice = (b: Uint8Array, from: number, to: number, by: Uint8Array | number[]) =>
	cat(b.subarray(0, from), by, b.subarray(to))

export const BAD_UTF8 = [
	[0xff],
	[0x80],
	[0xc0, 0x80],
	[0xc1, 0xbf],
	[0xc3],
	[0xe0, 0x80, 0x80],
	[0xed, 0xa0, 0x80],
	[0xed, 0xb0, 0x80],
	[0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80],
	[0xf0, 0x80, 0x80, 0x80],
	[0xf4, 0x90, 0x80, 0x80],
	[0xf5, 0x80, 0x80, 0x80],
	[0xf0, 0x9f, 0x98],
]
export const UNKNOWN_TAGS = [
	0,
	1,
	21,
	24,
	32,
	55799,
	64,
	68,
	73,
	76,
	80,
	84,
	87,
	0x12345679,
	2 ** 32,
]

// non-canonical rewrites of an encoding: each is no encoding. [what, bytes]
export function rewrites(pick: Pick, b: Uint8Array): [string, Uint8Array][] {
	const root = items(b)
	const all = every(root)
	const out: [string, Uint8Array][] = []
	const any = <T>(xs: T[]) => xs[pick(xs.length)]
	// a head longer than it need be
	const headed = all.filter((i) => i.major !== 7)
	if (headed.length) {
		const i = any(headed)
		const info = b[i.at] & 31
		const wider = info < 24 ? 24 + pick(4) : info + 1 + pick(28 - info - 1 + 1)
		if (wider <= 27) {
			out.push(["a longer head", splice(b, i.at, i.body, head(i.major, i.arg, wider))])
		}
	}
	// an indefinite length
	const sized = all.filter((i) => i.major >= 2 && i.major <= 5)
	if (sized.length) {
		const i = any(sized)
		const indefinite = i.major <= 3
			? cat([(i.major << 5) | 31], b.subarray(i.at, i.end), [0xff])
			: cat([(i.major << 5) | 31], b.subarray(i.body, i.end), [0xff])
		out.push(["an indefinite length", splice(b, i.at, i.end, indefinite)])
	}
	// a float a longer float holds; a whole one as an integer
	const floats = all.filter((i) => i.major === 7 && i.body - i.at > 1)
	if (floats.length) {
		const i = any(floats)
		const x = decode(b.subarray(i.at, i.end)) as number
		const width = i.body - i.at
		const v = new DataView(new ArrayBuffer(9))
		if (width === 3) {
			v.setUint8(0, 0xfa), v.setFloat32(1, x)
			out.push(["a longer float", splice(b, i.at, i.end, new Uint8Array(v.buffer, 0, 5))])
		}
		if (width <= 5) {
			v.setUint8(0, 0xfb), v.setFloat64(1, x)
			out.push(["a longer float", splice(b, i.at, i.end, new Uint8Array(v.buffer, 0, 9))])
		}
		// a NaN not the one: a payload, a sign, a longer one
		const nan = any([[0xf9, 0x7e, 0x01], [0xf9, 0xfe, 0x00], [0xf9, 0x7c, 0x01], [
			0xfa,
			0x7f,
			0xc0,
			0,
			0,
		], [0xfb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0]])
		out.push(["another NaN", splice(b, i.at, i.end, nan)])
	}
	// an integer as a float (the shortest that holds it), or as a bignum a plain integer holds
	const ints = all.filter((i) => i.major <= 1)
	if (ints.length) {
		const i = any(ints)
		const m = i.body - i.at === 9
			? new DataView(b.buffer, b.byteOffset).getBigUint64(i.at + 1)
			: BigInt(i.arg)
		const n = i.major === 0 ? m : -1n - m
		const x = Number(n)
		if (BigInt(x) === n) {
			const v = new DataView(new ArrayBuffer(9))
			const f = Object.is(Math.f16round(x), x) ? 3 : Object.is(Math.fround(x), x) ? 5 : 9
			if (f === 3) v.setUint8(0, 0xf9), v.setFloat16(1, x)
			else if (f === 5) v.setUint8(0, 0xfa), v.setFloat32(1, x)
			else v.setUint8(0, 0xfb), v.setFloat64(1, x)
			out.push([
				"a whole number as a float",
				splice(b, i.at, i.end, new Uint8Array(v.buffer, 0, f)),
			])
		}
		const raw = new Uint8Array(8)
		new DataView(raw.buffer).setBigUint64(0, m)
		out.push([
			"a bignum a plain integer holds",
			splice(b, i.at, i.end, cat([i.major === 0 ? 0xc2 : 0xc3], head(2, 8), raw)),
		])
	}
	// a bignum with a leading zero
	const bigs = all.filter((i) => i.major === 6 && (i.arg === 2 || i.arg === 3))
	if (bigs.length) {
		const t = any(bigs), raw = t.kids[0]
		const grown = cat(head(2, raw.end - raw.body + 1), [0], b.subarray(raw.body, raw.end))
		out.push(["a bignum with a leading zero", splice(b, raw.at, raw.end, grown)])
	}
	// a simple value not false, true or null
	{
		const i = any(all)
		const simple = any([[0xf7], [0xe0], [0xf3], [0xf8, 0x20], [0xf8, 0x14], [0xfc], [0xff]])
		out.push(["another simple value", splice(b, i.at, i.end, simple)])
	}
	// map keys out of order, twice, not text
	const maps = all.filter((i) => i.major === 5 && i.arg >= 1)
	if (maps.length) {
		const m = any(maps)
		const pairs: [Item, Item][] = []
		for (let k = 0; k < m.kids.length; k += 2) pairs.push([m.kids[k], m.kids[k + 1]])
		const bytesOf = ([k, v]: [Item, Item]) => b.subarray(k.at, v.end)
		if (pairs.length >= 2) {
			const k = pick(pairs.length - 1)
			const swapped = pairs.slice()
			;[swapped[k], swapped[k + 1]] = [swapped[k + 1], swapped[k]]
			out.push(["keys out of order", splice(b, m.body, m.end, cat(...swapped.map(bytesOf)))])
		}
		const k = pick(pairs.length)
		const twice = [...pairs.slice(0, k + 1), pairs[k], ...pairs.slice(k + 1)]
		out.push([
			"a key twice",
			splice(b, m.at, m.end, cat(head(5, pairs.length + 1), ...twice.map(bytesOf))),
		])
		const key = pairs[pick(pairs.length)][0]
		const not = any([
			cat(head(2, key.end - key.body), b.subarray(key.body, key.end)),
			new Uint8Array([0xf9, 0x3c, 0x00]),
			new Uint8Array([0x01]),
			new Uint8Array([0xf6]),
		])
		out.push(["a key not text", splice(b, key.at, key.end, not)])
	}
	// text that is not UTF-8
	const texts = all.filter((i) => i.major === 3)
	if (texts.length) {
		const t = any(texts)
		const body = b.subarray(t.body, t.end)
		const cut = pick(body.length + 1)
		// cut at a code point's start, so only the bad sequence is bad
		let at = cut
		while (at > 0 && at < body.length && (body[at] & 0xc0) === 0x80) at--
		const bad = cat(body.subarray(0, at), any(BAD_UTF8), body.subarray(at))
		out.push(["text not UTF-8", splice(b, t.at, t.end, cat(head(3, bad.length), bad))])
	}
	// a tag no value has, a typed array's over something not bytes or not whole elements
	{
		const i = any(all)
		const tag = head(6, any(UNKNOWN_TAGS))
		out.push(["an unknown tag", splice(b, i.at, i.at, tag)])
		if (i.major !== 2) {
			out.push([
				"a typed array not over bytes",
				splice(b, i.at, i.at, head(6, any([69, 85, 86]))),
			])
		}
	}
	const typedArrays = all.filter((i) => i.major === 6 && i.arg !== 0x12345678)
	if (typedArrays.length) {
		const t = any(typedArrays)
		const raw = t.kids[0]
		const size = { 69: 2, 70: 4, 71: 8, 72: 1, 77: 2, 78: 4, 79: 8, 85: 4, 86: 8 }[t.arg]!
		if (size > 1) {
			const more = 1 + pick(size - 1)
			const grown = cat(
				head(2, raw.end - raw.body + more),
				b.subarray(raw.body, raw.end),
				new Uint8Array(more),
			)
			out.push(["part of an element", splice(b, raw.at, raw.end, grown)])
		}
		if (t.arg === 85 || t.arg === 86) {
			const nan = t.arg === 85 ? [0x01, 0x00, 0xc0, 0x7f] : [1, 0, 0, 0, 0, 0, 0xf8, 0x7f]
			const n = raw.end - raw.body
			out.push([
				"a NaN element not the one",
				splice(
					b,
					raw.at,
					raw.end,
					cat(head(2, n + nan.length), b.subarray(raw.body, raw.end), nan),
				),
			])
		}
	}
	// a container saying more than it holds
	const containers = all.filter((i) => i.major === 4 || i.major === 5)
	if (containers.length) {
		const c = any(containers)
		out.push(["more items than there are", splice(b, c.at, c.body, head(c.major, c.arg + 1))])
	}
	// bytes after, a prefix
	out.push(["bytes after", cat(b, [pick(256)])])
	if (b.length > 1) out.push(["a prefix", b.subarray(0, 1 + pick(b.length - 1))])
	out.push(["nothing", new Uint8Array()])
	return out
}

// bytes near an encoding: cut, grown and flipped
export function mutate(pick: Pick, b: Uint8Array): Uint8Array {
	const out = Array.from(b)
	for (let n = 1 + pick(3); n > 0; n--) {
		const at = pick(out.length + 1)
		switch (pick(4)) {
			case 0:
				if (out.length) out[Math.min(at, out.length - 1)] ^= 1 << pick(8)
				break
			case 1:
				out.splice(at, 0, pick(256))
				break
			case 2:
				out.splice(at, 1)
				break
			default:
				if (out.length) out[Math.min(at, out.length - 1)] = pick(256)
		}
	}
	return Uint8Array.from(out)
}

// whether a string or key in it holds a lone surrogate
export function lone(v: unknown): boolean {
	if (typeof v === "string") return !v.isWellFormed()
	if (v instanceof Stand) return lone(v.kind)
	if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return false
	if (Array.isArray(v)) return v.some(lone)
	return Object.keys(v).some((k) => !k.isWellFormed() || lone((v as never)[k]))
}

// a map whose content is the same, keys sorted (answers compare maps by content)
export const stable = (x: unknown) =>
	line(
		x,
		(v) =>
			v && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as never)[k]]))
				: v,
	)

// what a field may hold that its rule says no to (or yes: an edge)
export const JUNK: unknown[] = [
	null,
	true,
	0,
	-0,
	1,
	0.5,
	-1,
	2 ** 31 - 1,
	2 ** 31,
	-(2 ** 31),
	2 ** 53 - 1,
	2 ** 53,
	2n ** 53n + 1n,
	-(2n ** 64n) - 1n,
	NaN,
	Infinity,
	"",
	"x",
	"\uD800",
	"a\uDC00",
	[],
	[1],
	{},
	{ a: 1 },
	new Uint8Array(0),
	new Uint8Array(31),
	new Uint8Array(32),
	new Uint8Array(33),
	new Int8Array(2),
	new Float64Array([1]),
	new Stand("k"),
]
