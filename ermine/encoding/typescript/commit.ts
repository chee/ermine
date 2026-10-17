// one entry change, as one item in the canonical encoding (cbor.ts), and back: what sync stores
// and sends for a node (extensions/subduction/plan.org, Rewrite for the new shape). the shape only:
// no hashing but its name, no signing, no parents looked up. replaces blop: the table is named (no
// object per name), there is no node id (a commit is kept in its node's sedimentree), and the
// change header goes as the graph has it (time, actor, reader, external, metadata; never op)
import { blake3 } from "@ermine/blake3"
import * as cbor from "./cbor.ts"
import type { FileLocation } from "@ermine/util/stacktrace"

export type Key = string | number
export type Place = { path: readonly Key[]; range?: readonly [number, number] }
export type Patch = Place & { value?: unknown; move?: Place }

// an optional field absent, or undefined, is left out; null is a value
export type Commit = {
	// the table the change is to
	table: string
	actor: unknown
	reader?: string
	external?: FileLocation[]
	metadata?: [string, unknown][]
	// whole seconds since 1970, as the change header has it
	time: number
	signer: Uint8Array
	// a count, the signer's own: two commits otherwise the same are told apart. counted up one a
	// commit, so a run of them packs to almost nothing (run.ts)
	nonce: number
	// the node's heads it was made on, by name, ascending
	parents: Uint8Array[]
	// with several parents: the one its patches are over (a merge says what it keeps in them)
	base?: Uint8Array
	// with several parents and no base: a merge rule's name. its patches are over the merge of its
	// parents by that rule; a device that doesn't know the rule can't read it
	merge?: string
	lamport: number
	patches: Patch[]
}

export type Code = "cannot-carry" | "not-a-commit"

export class CommitError extends Error {
	constructor(readonly code: Code, readonly field?: string) {
		super(field === undefined ? code : `${code} (${field})`)
	}
}

// the table's order: the first field that says no is the one named
const FIELDS = [
	"table",
	"actor",
	"reader",
	"external",
	"metadata",
	"time",
	"signer",
	"nonce",
	"parents",
	"base",
	"merge",
	"lamport",
	"patches",
] as const
const KNOWN: ReadonlySet<string> = new Set(FIELDS)
const OPTIONAL: ReadonlySet<string> = new Set(["reader", "external", "metadata", "base", "merge"])

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
const isKey = (k: unknown) => typeof k === "string" || whole(k)
const isRange = (r: unknown) => Array.isArray(r) && r.length === 2 && r.every(whole)
const sized = (b: unknown, n: number): b is Uint8Array => b instanceof Uint8Array && b.length === n

export function compare(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

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

// each field's own rule, given the commit for base's
const RULES: { [k in typeof FIELDS[number]]: (v: unknown, c: Fields) => boolean } = {
	table: (v) => typeof v === "string" && v.length > 0,
	actor: () => true,
	reader: (v) => typeof v === "string",
	external: (v) => Array.isArray(v) && v.every(site),
	metadata: (v) =>
		Array.isArray(v) &&
		v.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string"),
	time: whole,
	signer: (v) => sized(v, 32),
	nonce: whole,
	parents: (v) => {
		if (!Array.isArray(v) || !v.every((p) => sized(p, 32))) return false
		for (let i = 1; i < v.length; i++) if (compare(v[i - 1], v[i]) >= 0) return false
		return true
	},
	base: (v, c) =>
		sized(v, 32) && Array.isArray(c.parents) && c.parents.length >= 2 &&
		c.parents.some((p) => p instanceof Uint8Array && compare(p, v) === 0),
	// a rule's name, with several parents and no base
	merge: (v, c) =>
		typeof v === "string" && v.length > 0 && Array.isArray(c.parents) &&
		c.parents.length >= 2 && !("base" in c),
	lamport: (v) => whole(v) && v >= 1,
	patches: (v) =>
		Array.isArray(v) &&
		v.every((p) => place(p, PATCH) && (!("move" in p) || !("value" in p) && place(p.move, MOVE))),
}

// a key not listed, then the first field that says no, in the table's order; none: a commit
function check(c: Fields): string | undefined {
	// of several keys not listed, the first in canonical order: shorter first, then bytewise
	const stray = Object.keys(c).filter((k) => !KNOWN.has(k)).sort(canonical)
	if (stray.length > 0) return stray[0]
	for (const k of FIELDS) {
		if (!(k in c)) {
			const needed = !OPTIONAL.has(k) ||
				k === "base" && Array.isArray(c.parents) && c.parents.length >= 2 && !("merge" in c)
			if (needed) return k
		} else if (!RULES[k](c[k], c)) return k
	}
}

// the commit's bytes
export function encode(commit: Commit): Uint8Array {
	if (!isFields(commit)) throw new CommitError("not-a-commit")
	// a field with nothing is left out
	const c: Fields = {}
	for (const [k, v] of Object.entries(commit)) if (v !== undefined) c[k] = v
	const field = check(c)
	if (field !== undefined) throw new CommitError("not-a-commit", field)
	try {
		return cbor.encode(c as cbor.Value)
	} catch (e) {
		if (!(e instanceof cbor.CborError)) throw e
		// which: each again, only when one failed
		for (const k of FIELDS) {
			if (!(k in c)) continue
			try {
				cbor.encode(c[k] as cbor.Value)
			} catch {
				throw new CommitError("cannot-carry", k)
			}
		}
		throw new CommitError("cannot-carry")
	}
}

// the commit back, its byte fields Uint8Arrays: new objects every time, shared with nothing
export function decode(b: Uint8Array): Commit {
	let x: unknown
	try {
		x = cbor.decode(b)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new CommitError("not-a-commit")
		throw e
	}
	if (!isFields(x)) throw new CommitError("not-a-commit")
	const field = check(x)
	if (field !== undefined) throw new CommitError("not-a-commit", field)
	return x as Commit
}

// the commit's name on every device: the BLAKE3 hash of its bytes
export function name(b: Uint8Array): Uint8Array {
	return blake3(b)
}
