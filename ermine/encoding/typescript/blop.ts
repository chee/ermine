// one change to one object of a node, with its patches, as one item in the canonical encoding
// (ENCODING.tex), and back (BLOP.tex). the shape only: no hashing but its name, no signing, no
// parents looked up
import { blake3 } from "@ermine/blake3"
import * as cbor from "./cbor.ts"
import type { FileLocation } from "@ermine/util/stacktrace"

export type Which = "value" | readonly ["info", string] | readonly ["children", string]
export type Key = string | number
export type Place = { path: readonly Key[]; range?: readonly [number, number] }
export type Patch = Place & { value?: unknown; move?: Place }

// an optional field absent, or undefined, is left out; null is a value
export type Blop = {
	node: string
	object: Which
	actor: unknown
	reader?: string
	site?: FileLocation
	cause?: unknown
	wallclock?: number
	message?: string
	signer: Uint8Array
	nonce: Uint8Array
	parents: Uint8Array[]
	base?: Uint8Array
	combine?: true
	lamport: number
	patches: Patch[]
}

export type Code = "cannot-carry" | "not-a-blop"

export class BlopError extends Error {
	constructor(readonly code: Code, readonly field?: string) {
		super(field === undefined ? code : `${code} (${field})`)
	}
}

// the table's order: the first field that says no is the one named
const FIELDS = [
	"node",
	"object",
	"actor",
	"reader",
	"site",
	"cause",
	"wallclock",
	"message",
	"signer",
	"nonce",
	"parents",
	"base",
	"combine",
	"lamport",
	"patches",
] as const
const KNOWN: ReadonlySet<string> = new Set(FIELDS)
const OPTIONAL: ReadonlySet<string> = new Set([
	"reader",
	"site",
	"cause",
	"wallclock",
	"message",
	"base",
	"combine",
])

type Fields = { [k: string]: unknown }

const utf8 = new TextEncoder()
function canonical(a: string, b: string): number {
	const x = utf8.encode(a), y = utf8.encode(b)
	if (x.length !== y.length) return x.length - y.length
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}

const isFields = (x: unknown): x is Fields => {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false
	const p = Object.getPrototypeOf(x)
	return p === Object.prototype || p === null
}
// an integer from 0 to 2^53 - 1
const whole = (n: unknown): n is number =>
	Number.isSafeInteger(n) && !Object.is(n, -0) && (n as number) >= 0
const isKey = (k: unknown) => typeof k === "string" || whole(k) && (k as number) >= 0
const isRange = (r: unknown) =>
	Array.isArray(r) && r.length === 2 && r.every((n) => whole(n) && n >= 0)
const sized = (b: unknown, n: number): b is Uint8Array => b instanceof Uint8Array && b.length === n

function compare(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
	return 0
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && compare(a, b) === 0

function place(x: unknown, keys: ReadonlySet<string>): boolean {
	if (!isFields(x)) return false
	for (const k of Object.keys(x)) if (!keys.has(k)) return false
	if (!Array.isArray(x.path) || !x.path.every(isKey)) return false
	return !("range" in x) || isRange(x.range)
}
const PATCH: ReadonlySet<string> = new Set(["path", "range", "value", "move"])
const MOVE: ReadonlySet<string> = new Set(["path", "range"])

function site(x: unknown): boolean {
	if (!isFields(x) || typeof x.file !== "string" || !whole(x.line)) return false
	for (const k of Object.keys(x)) {
		if (k !== "file" && k !== "line" && k !== "column" && k !== "function") return false
	}
	if ("column" in x && !whole(x.column)) return false
	return !("function" in x) || typeof x.function === "string"
}

// each field's own rule, given the blop for base's
const RULES: { [k in typeof FIELDS[number]]: (v: unknown, b: Fields) => boolean } = {
	node: (v) => typeof v === "string",
	object: (v) =>
		v === "value" ||
		Array.isArray(v) && v.length === 2 && (v[0] === "info" || v[0] === "children") &&
			typeof v[1] === "string",
	actor: () => true,
	reader: (v) => typeof v === "string",
	site,
	cause: () => true,
	wallclock: whole,
	message: (v) => typeof v === "string",
	signer: (v) => sized(v, 32),
	nonce: (v) => sized(v, 8),
	parents: (v) => {
		if (!Array.isArray(v) || !v.every((p) => sized(p, 32))) return false
		for (let i = 1; i < v.length; i++) if (compare(v[i - 1], v[i]) >= 0) return false
		return true
	},
	base: (v, b) =>
		sized(v, 32) && Array.isArray(b.parents) && b.parents.length >= 2 &&
		b.parents.some((p) => p instanceof Uint8Array && same(p, v)),
	// combining its parents; left out, it chooses base
	combine: (v, b) => v === true && "base" in b,
	lamport: (v) => whole(v) && v >= 1,
	patches: (v) =>
		Array.isArray(v) &&
		v.every((p) => place(p, PATCH) && (!("move" in p) || !("value" in p) && place(p.move, MOVE))),
}

// a key not listed, then the first field that says no, in the table's order; none: a blop
function check(b: Fields): string | undefined {
	// of several keys not listed, the first in canonical order: shorter first, then bytewise
	const stray = Object.keys(b).filter((k) => !KNOWN.has(k)).sort(canonical)
	if (stray.length > 0) return stray[0]
	for (const k of FIELDS) {
		if (!(k in b)) {
			const needed = !OPTIONAL.has(k) ||
				k === "base" && Array.isArray(b.parents) && b.parents.length >= 2
			if (needed) return k
		} else if (!RULES[k](b[k], b)) return k
	}
}

// the blop's bytes; nonce, signer, parents, base Uint8Arrays, as bytes everywhere
export function encode(blop: Blop): Uint8Array {
	if (!isFields(blop)) throw new BlopError("not-a-blop")
	// a field with nothing is left out
	const b: Fields = {}
	for (const [k, v] of Object.entries(blop)) if (v !== undefined) b[k] = v
	const field = check(b)
	if (field !== undefined) throw new BlopError("not-a-blop", field)
	try {
		return cbor.encode(b as cbor.Value)
	} catch (e) {
		if (!(e instanceof cbor.CborError)) throw e
		// which: each again, only when one failed
		for (const k of FIELDS) {
			if (!(k in b)) continue
			try {
				cbor.encode(b[k] as cbor.Value)
			} catch {
				throw new BlopError("cannot-carry", k)
			}
		}
		throw new BlopError("cannot-carry")
	}
}

// the blop back, byte fields Uint8Arrays
export function decode(b: Uint8Array): Blop {
	let x: unknown
	try {
		x = cbor.decode(b)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new BlopError("not-a-blop")
		throw e
	}
	if (!isFields(x)) throw new BlopError("not-a-blop")
	const field = check(x)
	if (field !== undefined) throw new BlopError("not-a-blop", field)
	return x as Blop
}

// the change's name on every device: the BLAKE3 hash of the blop's bytes
export function name(b: Uint8Array): Uint8Array {
	return blake3(b)
}
