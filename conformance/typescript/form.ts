// values in their JSON form (ENCODING.tex), as the C codec (core/op/c/json.c) writes them: JSON for
// what JSON holds; {"/": {"bytes": b64}} for bytes, a Uint8Array (no uint8 kind),
// {"/": {"number": "NaN" | "Infinity" | "-Infinity"}},
// {"/": {kind: [elements]}} for a typed array, 64-bit elements as decimal strings, a float's NaN
// and infinities as the words; {"/": {"live": kind}} for a stand-in; {"/": {"map": {"/": x}}} for a map whose one key is "/". Base64:
// the standard alphabet, unpadded. -0 is written -0. For tests only, never encoded (symbols aren't
// saved): {"/": {"symbol": name}}, Symbol.for(name)
import { Stand } from "@ermine/encoding/cbor"
import { ordered } from "./json.ts"

const KINDS: { [kind: string]: { new (b: ArrayBuffer): ArrayBufferView } } = {
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
const NAMES = new Map(Object.entries(KINDS).map(([k, c]) => [c as unknown, k]))

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/=+$/, "")
const slash = (x: unknown) => ({ "/": x })
const isWord = (e: unknown): e is { "/": { number: string } } =>
	typeof e === "object" && e !== null && "/" in e

export function toJson(x: unknown): unknown {
	if (typeof x === "symbol") return slash({ symbol: Symbol.keyFor(x) ?? x.description ?? "" })
	if (typeof x === "number") {
		if (Number.isNaN(x)) return slash({ number: "NaN" })
		if (x === Infinity) return slash({ number: "Infinity" })
		if (x === -Infinity) return slash({ number: "-Infinity" })
		return x
	}
	if (x === null || typeof x !== "object") return x
	if (x instanceof Uint8Array) return slash({ bytes: b64(x) })
	if (ArrayBuffer.isView(x)) {
		const elements = Array.from(
			x as unknown as ArrayLike<number | bigint>,
			(e) => typeof e === "bigint" ? String(e) : toJson(e) as unknown,
		)
		return slash({
			[NAMES.get(x.constructor)!]: elements.map((e) => isWord(e) ? e["/"].number : e),
		})
	}
	if (x instanceof Stand) return slash({ live: toJson(x.kind) })
	if (Array.isArray(x)) return x.map(toJson)
	const keys = Object.keys(x)
	if (keys.length === 1 && keys[0] === "/") {
		return slash({ map: slash(toJson((x as { "/": unknown })["/"])) })
	}
	// in its order, a key that reads as an index too (json.ts)
	return ordered(keys.map((k) => [k, toJson((x as Record<string, unknown>)[k])]))
}

// a JSON form that stands for no value: what json.c's jsonDecode refuses
export class FormError extends Error {}
const no = (why: string): never => {
	throw new FormError(why)
}

const DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
// base64, standard alphabet, unpadded, in the one spelling of its bytes: unused bits zero
function bytesOf(x: unknown): Uint8Array {
	if (typeof x !== "string" || x.length % 4 === 1) return no("bytes")
	const out: number[] = []
	let bits = 0, held = 0
	for (const c of x) {
		const d = DIGITS.indexOf(c)
		if (d < 0) return no("bytes")
		bits = (bits << 6) | d
		held += 6
		if (held >= 8) held -= 8, out.push((bits >> held) & 0xff)
		bits &= (1 << held) - 1
	}
	if (bits) return no("bytes")
	return Uint8Array.from(out)
}

const WORDS: { [w: string]: number } = { NaN: NaN, Infinity: Infinity, "-Infinity": -Infinity }
const RANGE: { [kind: string]: [number, number] } = {
	int8: [-128, 127],
	int16: [-32768, 32767],
	uint16: [0, 65535],
	int32: [-(2 ** 31), 2 ** 31 - 1],
	uint32: [0, 2 ** 32 - 1],
}
// a typed array from the list of its elements: whole numbers in range, 64-bit as decimal
// strings, floats numbers or the words
function typedOf(kind: string, list: unknown): ArrayBufferView {
	const T = KINDS[kind] as unknown as { from(xs: unknown[]): ArrayBufferView }
	if (!T || !Array.isArray(list)) return no("typed")
	const elements = list.map((e) => {
		if (kind === "int64" || kind === "uint64") {
			if (typeof e !== "string" || !/^-?[0-9]+$/.test(e)) return no("typed")
			const n = BigInt(e)
			const [lo, hi] = kind === "int64" ? [-(2n ** 63n), 2n ** 63n - 1n] : [0n, 2n ** 64n - 1n]
			if (n < lo || n > hi || (kind === "uint64" && e.startsWith("-"))) return no("typed")
			return n
		}
		if (kind === "float32" || kind === "float64") {
			if (typeof e === "number") return e
			if (typeof e === "string" && e in WORDS) return WORDS[e]
			return no("typed")
		}
		const [lo, hi] = RANGE[kind]
		if (typeof e !== "number" || !Number.isInteger(e) || e < lo || e > hi) return no("typed")
		return e
	})
	return T.from(elements)
}

const isSlashMap = (x: unknown): x is { "/": unknown } =>
	x !== null && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 1 &&
	Object.hasOwn(x, "/")

// a value from its JSON form; a form that stands for none throws FormError
export function fromJson(x: unknown): unknown {
	if (typeof x === "string") return x.isWellFormed() ? x : no("a lone surrogate")
	if (x === null || typeof x !== "object") return x
	if (Array.isArray(x)) return x.map(fromJson)
	if (isSlashMap(x)) {
		const form = x["/"]
		if (form === null || typeof form !== "object" || Array.isArray(form)) return no("form")
		const keys = Object.keys(form)
		if (keys.length !== 1) return no("form")
		const [tag] = keys, body = (form as Record<string, unknown>)[tag]
		if (tag === "map") return isSlashMap(body) ? { "/": fromJson(body["/"]) } : no("map")
		if (tag === "live") return new Stand(fromJson(body) as never)
		if (tag === "symbol") return typeof body === "string" ? Symbol.for(body) : no("symbol")
		if (tag === "bytes") return bytesOf(body)
		if (tag === "number") {
			return typeof body === "string" && body in WORDS ? WORDS[body] : no("number")
		}
		return typedOf(tag, body)
	}
	const out: Record<string, unknown> = {}
	for (const k of Object.keys(x)) {
		if (!k.isWellFormed()) return no("a lone surrogate")
		Object.defineProperty(out, k, {
			value: fromJson((x as Record<string, unknown>)[k]),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return out
}

// JSON.stringify, but -0 written -0
const MINUS = "\u0000-0\u0000"
export function line(x: unknown, also: (v: unknown) => unknown = (v) => v): string {
	return (JSON.stringify(x, (_, v) => Object.is(v, -0) ? MINUS : also(v)) ?? "undefined")
		.replaceAll(
			JSON.stringify(MINUS),
			"-0",
		)
}

// a value from its JSON form, as fromJson has it, but a string or a key may hold lone surrogates:
// op counts each as a position, and the C codec (core/op/c/json.c) takes them
const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
export function revive(x: unknown): unknown {
	if (Array.isArray(x)) return x.map(revive)
	if (!isMap(x)) return x
	if (isSlashMap(x)) {
		const form = x["/"]
		if (isMap(form) && Object.keys(form).length === 1) {
			if (Object.hasOwn(form, "map") && isSlashMap(form.map)) {
				return { "/": revive(form.map["/"]) }
			}
			if (Object.hasOwn(form, "live")) return new Stand(revive(form.live) as never)
		}
		return fromJson(x)
	}
	const out: Record<string, unknown> = {}
	for (const k of Object.keys(x)) {
		Object.defineProperty(out, k, {
			value: revive(x[k]),
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return out
}
