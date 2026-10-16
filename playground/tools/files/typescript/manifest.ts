// The manifest's folder, .ermine (FILES.tex, The manifest): the log of frames
// in "manifest", each value kept once in "values/<hex>", "tmp/" for what is
// being written, and "id/", always empty, which links point into.
//
// A frame is a 4-byte big-endian length, then the CBOR of a map from key to
// bytes, or null for a key that goes. Reading tells a last frame cut short,
// which is dropped, from a broken one before others, which makes the store
// invalid; a fold writes through tmp/ and a rename; and kept files are
// removed only once a fold that no longer names them is synced.
//
// Records: "meta", {root, time}; "node:<id>", a node as pack.ts writes it,
// each content of its value and its info replaced by "kept": [hash, form];
// "shown:<id>", a layout; "store"; "plan", while a batch is laid out; and the
// host's. Every record is deterministic CBOR.

// deno-lint-ignore no-import-prefix
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { CborError, decode, encode } from "@ermine/encoding/cbor"
import type { List, Node as Saved, Side } from "./saved.ts"
import * as pack from "./saved.ts"
import * as diag from "./diag.ts"
import * as names from "./names.ts"
import type { Sys } from "./sys.ts"
import {
	type Form,
	FormError,
	type Found,
	type Hash,
	type Id,
	type Info,
	type Kept,
	type Kind,
	kindOf,
	KINDS,
	type Layout,
	type Node,
	type State,
	type Step,
	StoreError,
	type Value,
} from "./types.ts"

/** The key of the graph's root and time. */
export const META = "meta"
/** A node's record's key is NODE + its id. */
export const NODE = "node:"
/** A layout record's key is SHOWN + its node's id. */
export const SHOWN = "shown:"
/** The store record's key. */
export const STORE = "store"
/** The key of the plan of the batch being laid out. */
export const PLAN = "plan"
/** The store record's format. */
export const FORMAT = 1

/** A record's encoding to deterministic CBOR and back; decode throws StoreError for what is not one. */
export type Codec<T> = { encode(x: T): Uint8Array; decode(bytes: Uint8Array): T }

export type Fields = { [k: string]: Value }

const utf8 = new TextEncoder()
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
const FORMS: ReadonlySet<unknown> = new Set(["txt", "bin", "cbor", ...Object.keys(KINDS)])
const HEX = /^[0-9a-f]{64}$/

const isFields = (x: unknown): x is Fields =>
	x !== null && typeof x === "object" && !Array.isArray(x) && !ArrayBuffer.isView(x)

// values ---------------------------------------------------------------------

/** The form a value is kept and shown in: txt for a string, bin for bytes, a typed array's kind, else cbor. */
export function form(value: Value): Form {
	if (typeof value === "string") return "txt"
	if (value instanceof Uint8Array) return "bin"
	return kindOf(value) ?? "cbor"
}

/** A value's file in its form: UTF-8, the bytes, the elements little-endian, or diagnostic notation for cbor. */
export function render(value: Value, form: Form): Uint8Array {
	const wrong = () => new Error(`a value that is not in form ${form}`)
	if (form === "txt") {
		if (typeof value !== "string") throw wrong()
		return utf8.encode(value)
	}
	if (form === "bin") {
		if (!(value instanceof Uint8Array)) throw wrong()
		return value
	}
	if (form === "cbor") {
		if (typeof value === "string" || value instanceof Uint8Array || kindOf(value)) throw wrong()
		return utf8.encode(diag.write(value))
	}
	if (kindOf(value) !== form) throw wrong()
	// the elements end its CBOR, after its tag and its bytes' head; each NaN is the one NaN
	const b = encode(value)
	return b.slice(b.length - (value as ArrayBufferView).byteLength)
}

/** The value a file holds in its form; throws FormError when it does not read, as text not UTF-8 or notation that does not parse. */
export function parse(bytes: Uint8Array, form: Form): Value {
	if (form === "bin") return bytes.slice()
	if (form === "txt" || form === "cbor") {
		let text: string
		try {
			text = strict.decode(bytes)
		} catch {
			throw new FormError("not UTF-8")
		}
		if (form === "txt") return text
		try {
			return diag.read(text)
		} catch (e) {
			if (e instanceof diag.DiagError) throw new FormError(e.message, e.at)
			throw e
		}
	}
	const make = KINDS[form as Kind]
	if (!make) throw new Error(`no form ${form}`)
	const size = make.BYTES_PER_ELEMENT
	if (bytes.length % size) {
		throw new FormError(`${bytes.length} bytes are not whole ${form} elements`)
	}
	const out = new Uint8Array(bytes.length)
	if (LITTLE || size === 1) out.set(bytes)
	else {
		for (let i = 0; i < bytes.length; i += size) {
			for (let j = 0; j < size; j++) out[i + j] = bytes[i + size - 1 - j]
		}
	}
	return new (make as unknown as new (buffer: ArrayBuffer) => Value)(out.buffer)
}

/** Bytes as 64 lowercase hex digits. */
export function hex(bytes: Uint8Array): Hash {
	let s = ""
	for (const b of bytes) s += b.toString(16).padStart(2, "0")
	return s
}

/** The BLAKE3 hash of bytes. */
export function digest(bytes: Uint8Array): Hash {
	return hex(blake3(bytes))
}

/** A CBOR head: the major type and its argument, in the fewest bytes. */
function head(major: number, arg: number): Uint8Array {
	const m = major << 5
	if (arg < 24) return Uint8Array.of(m | arg)
	if (arg < 0x100) return Uint8Array.of(m | 24, arg)
	if (arg < 0x10000) return Uint8Array.of(m | 25, arg >> 8, arg & 0xff)
	const out = new Uint8Array(arg < 0x100000000 ? 5 : 9)
	const v = new DataView(out.buffer)
	if (out.length === 5) {
		out[0] = m | 26
		v.setUint32(1, arg)
	} else {
		out[0] = m | 27
		v.setUint32(1, Math.floor(arg / 0x100000000))
		v.setUint32(5, arg >>> 0)
	}
	return out
}

/** The BLAKE3 hash of a value's deterministic CBOR. Text and bytes are their head, then themselves: hashed in pieces, never copied into one encoding. */
export function hash(value: Value): Hash {
	let body: Uint8Array, major: number
	if (typeof value === "string") {
		if (!value.isWellFormed()) {
			throw new CborError("a string with a lone surrogate has no encoding")
		}
		body = utf8.encode(value), major = 3
	} else if (value instanceof Uint8Array) body = value, major = 2
	else return digest(encode(value))
	return hex(blake3.create({}).update(head(major, body.length)).update(body).digest())
}

/** null's hash: what a node with no value shows. */
export const NULL: Hash = hash(null)

/** A hash as a record holds it: 32 bytes. */
function bytes32(h: Hash): Uint8Array {
	if (typeof h !== "string" || !HEX.test(h)) throw new StoreError(`${h} is not a hash`)
	return Uint8Array.fromHex(h)
}

/** A hash from a record's 32 bytes. */
function unbytes(x: unknown, what: string): Hash {
	if (!(x instanceof Uint8Array) || x.length !== 32) {
		throw new StoreError(`${what} is not a hash`)
	}
	return hex(x)
}

/** A record as a map; StoreError for anything else. */
function map(bytes: Uint8Array, what: string): Fields {
	let r: Value
	try {
		r = decode(bytes)
	} catch (e) {
		if (e instanceof CborError) throw new StoreError(`${what} is not CBOR: ${e.message}`)
		throw e
	}
	if (!isFields(r)) throw new StoreError(`${what} is not a map`)
	return r
}

// node records ---------------------------------------------------------------

/** What saving a node gives: its record, each value it keeps by hash, and its shape for the layout. */
export type Saving = { record: Uint8Array; values: Map<Hash, Value>; shape: Node }

/**
 * A node's record, as pack writes it, each value's and info's content kept by
 * its hash. A version whose content has no encoding, a live value, is left
 * out, as is each symbol and each id skip says in a list: nothing live and
 * nothing ephemeral is saved. A change, a because or a header with no
 * encoding cannot be saved: StoreError. kept caches a content's hash.
 */
export function save(
	n: Saved<unknown, unknown>,
	skip: (id: Id) => boolean = () => false,
	kept: (content: unknown) => Kept | undefined = keptOf,
): Saving {
	const values = new Map<Hash, Value>()
	const keeping = (vs: Side<unknown, unknown>[]) => {
		const out: Fields[] = []
		for (const v of vs) {
			const k = kept(v.content)
			if (!k) continue
			values.set(k[0], v.content as Value)
			out.push(fields({ kept: [bytes32(k[0]), k[1]], change: v.change, because: v.because }))
		}
		return out
	}
	const lists = (vs: Side<List, unknown>[]) =>
		vs.map((v) =>
			fields({
				content: v.content.filter((id): id is string => typeof id === "string" && !skip(id)),
				change: v.change,
				because: v.because,
			})
		)
	const record: Fields = {
		id: n.id,
		value: keeping(n.value),
		info: [...n.attributes].map(([name, vs]) => [name, keeping(vs)]),
		children: [...n.children].map(([name, vs]) => [name, lists(vs)]),
		header: fields(n.change),
	}
	let bytes: Uint8Array
	try {
		bytes = encode(record)
	} catch (e) {
		if (e instanceof CborError) {
			throw new StoreError(`the node ${n.id} holds a change or header that cannot be saved`)
		}
		throw e
	}
	const heads = (h: Hash) => {
		const v = values.get(h)
		return v instanceof Uint8Array ? v.slice(0, names.HEAD) : undefined
	}
	// the shape is built when asked: a record that did not change is never shaped
	let shaped: Node | undefined
	return {
		record: bytes,
		values,
		get shape() {
			return shaped ??= shape(bytes, heads)
		},
	}
}

/** A field not there is left out, never written as nothing. */
function fields(o: object): Fields {
	const out: Fields = {}
	for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v as Value
	return out
}

/** A content's hash and form; none for one with no encoding. */
export function keptOf(content: unknown): Kept | undefined {
	try {
		return [hash(content as Value), form(content as Value)]
	} catch (e) {
		if (e instanceof CborError) return undefined
		throw e
	}
}

/** A node's record as a map, to give kepts, restore and shape in place of its bytes, which each would decode again. */
export function opened(record: Uint8Array): Fields {
	return map(record, "a node's record")
}

/** Each [hash, form] a record keeps, in order: its value's versions, then each info's. */
export function kepts(record: Uint8Array | Fields): Kept[] {
	const r = record instanceof Uint8Array ? opened(record) : record
	const out: Kept[] = []
	const each = (vs: unknown, what: string) => {
		if (!Array.isArray(vs)) throw new StoreError(`${what} is not a list of versions`)
		for (const v of vs) {
			if (
				!isFields(v) || !Array.isArray(v.kept) || v.kept.length !== 2 || !FORMS.has(v.kept[1])
			) {
				throw new StoreError(`${what} holds a version that keeps no [hash, form]`)
			}
			out.push([unbytes(v.kept[0], `${what}'s kept hash`), v.kept[1] as Form])
		}
	}
	each(r.value, "a node's value")
	if (!Array.isArray(r.info)) throw new StoreError("a node's info is not a list")
	for (const e of r.info) {
		if (!Array.isArray(e) || e.length !== 2) throw new StoreError("a node's info is not entries")
		each(e[1], "a node's info")
	}
	return out
}

/** The node a record keeps, each content from values by its hash; StoreError if it is not one. */
export function restore(
	record: Uint8Array | Fields,
	values: (hash: Hash) => Value,
): Saved<unknown, unknown> {
	const r = record instanceof Uint8Array ? opened(record) : record
	const fill = (vs: unknown) =>
		(vs as Fields[]).map(({ kept, ...rest }) => ({
			...rest,
			content: values(unbytes((kept as Value[])[0], "a kept hash")),
		}))
	kepts(r) // checks every kept
	const full = {
		...r,
		value: fill(r.value),
		info: (r.info as [string, unknown][]).map(([name, vs]) => [name, fill(vs)]),
	}
	try {
		return pack.decode(encode(full as unknown as Value))
	} catch (e) {
		if (e instanceof pack.PackError) throw new StoreError(`a node's record is not a node`)
		throw e
	}
}

/**
 * A node's shape for the layout, from its record: its first value's kept, or
 * null's for none, each later version's, each info's first version, and each
 * child name's first list, empty ones left out. heads gives a bin value's
 * first bytes by its hash.
 */
export function shape(
	record: Uint8Array | Fields,
	heads: (hash: Hash) => Uint8Array | undefined,
): Node {
	const r = record instanceof Uint8Array ? opened(record) : record
	const all = kepts(r)
	const nv = Array.isArray(r.value) ? r.value.length : 0
	const head = (k: Kept) => (k[1] === "bin" ? heads(k[0]) : undefined)
	const first: Kept = nv ? all[0] : [NULL, "cbor"]
	const sides = all.slice(1, nv).map((k): readonly [Hash, Form, Uint8Array?] => {
		const h = head(k)
		return h ? [k[0], k[1], h] : [k[0], k[1]]
	})
	const info: [string, Hash, Form][] = []
	let at = nv
	for (const [name, vs] of r.info as [string, unknown[]][]) {
		if (vs.length) info.push([name, all[at][0], all[at][1]])
		at += vs.length
	}
	const directory = new Map<string, Id[]>()
	if (!Array.isArray(r.children)) throw new StoreError("a node's children are not a list")
	for (const e of r.children) {
		if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || !Array.isArray(e[1])) {
			throw new StoreError("a node's children are not entries")
		}
		const v = e[1][0]
		if (v === undefined) continue
		if (
			!isFields(v) || !Array.isArray(v.content) || !v.content.every((x) => typeof x === "string")
		) {
			throw new StoreError(`the child ${JSON.stringify(e[0])} is not a list of ids`)
		}
		if (v.content.length) directory.set(e[0], [...v.content] as Id[])
	}
	const n: Node = { kept: first, sides, info, directory }
	const h = head(first)
	if (h) n.head = h
	return n
}

// the other records ----------------------------------------------------------

function text(x: unknown, what: string): string {
	if (typeof x !== "string") throw new StoreError(`${what} is not text`)
	return x
}

function texts(x: unknown, what: string): string[] {
	if (!Array.isArray(x) || !x.every((s) => typeof s === "string")) {
		throw new StoreError(`${what} is not a list of text`)
	}
	return [...x]
}

function number(x: unknown, what: string): number {
	if (typeof x !== "number") throw new StoreError(`${what} is not a number`)
	return x
}

function yes(x: unknown, what: string): true {
	if (x !== true) throw new StoreError(`${what} is not true`)
	return true
}

/** Throws for a key not among those given. */
function only(r: Fields, keys: ReadonlySet<string>, what: string) {
	for (const k of Object.keys(r)) {
		if (!keys.has(k)) throw new StoreError(`${what} has ${JSON.stringify(k)}`)
	}
}

/** meta: the root's id and the last time given. */
export const meta: Codec<{ root: Id; time: number }> = {
	encode: (x) => encode({ root: x.root, time: x.time }),
	decode: (bytes) => {
		const r = map(bytes, "meta")
		return { root: text(r.root, "meta's root"), time: number(r.time, "meta's time") }
	},
}

const LAYOUT = new Set([
	"home",
	"file",
	"laid",
	"was",
	"sides",
	"folder",
	"entries",
	"left",
	"away",
])

/** A layout record. */
export const shown: Codec<Layout> = {
	encode: (x) => {
		const m: Fields = {}
		if (x.home) m.home = [x.home[0], x.home[1], x.home[2]]
		if (x.file !== undefined) m.file = x.file
		if (x.laid !== undefined) m.laid = bytes32(x.laid)
		if (x.was !== undefined) m.was = bytes32(x.was)
		if (x.sides?.length) m.sides = [...x.sides]
		if (x.folder) m.folder = true
		if (x.entries) {
			m.entries = Object.fromEntries(
				[...x.entries].map(([k, v]) => [k, typeof v === "string" ? v : [...v]]),
			)
		}
		if (x.left) m.left = [...x.left]
		if (x.away) m.away = true
		return encode(m)
	},
	decode: (bytes) => {
		const r = map(bytes, "a layout")
		only(r, LAYOUT, "a layout")
		const x: Layout = {}
		if ("home" in r) {
			const h = r.home
			if (!Array.isArray(h) || h.length !== 3) throw new StoreError("a layout's home is not one")
			x.home = [
				text(h[0], "a home's holder"),
				text(h[1], "a home's name"),
				number(h[2], "a home's position"),
			]
		}
		if ("file" in r) x.file = text(r.file, "a layout's file")
		if ("laid" in r) x.laid = unbytes(r.laid, "a layout's laid")
		if ("was" in r) x.was = unbytes(r.was, "a layout's was")
		if ("sides" in r) x.sides = texts(r.sides, "a layout's sides")
		if ("folder" in r) x.folder = yes(r.folder, "a layout's folder")
		if ("entries" in r) {
			const e = r.entries
			if (!isFields(e)) throw new StoreError("a layout's entries are not a map")
			x.entries = new Map()
			for (const [k, v] of Object.entries(e)) {
				if (typeof v === "string") x.entries.set(k, v)
				else {
					const stems = texts(v, `the entry ${JSON.stringify(k)}`)
					if (!stems.length) throw new StoreError(`the entry ${JSON.stringify(k)} has no stem`)
					x.entries.set(k, stems)
				}
			}
		}
		if ("left" in r) x.left = texts(r.left, "a layout's left")
		if ("away" in r) x.away = yes(r.away, "a layout's away")
		return x
	},
}

/** What a step expects at a place, as a record holds it, and back. */
const where = {
	encode: (x: Found): Value => {
		if (x === null) return null
		if ("file" in x) return { file: bytes32(x.file) }
		if ("link" in x) return { link: x.link }
		return { folder: x.folder }
	},
	decode: (x: unknown, what: string): Found => {
		if (x === null) return null
		if (!isFields(x) || Object.keys(x).length !== 1) throw new StoreError(`${what} is not one`)
		if ("file" in x) return { file: unbytes(x.file, what) }
		if ("link" in x) return { link: text(x.link, what) }
		if ("folder" in x) return { folder: x.folder === null ? null : number(x.folder, what) }
		throw new StoreError(`${what} is not one`)
	},
}

/** A node's info as a record holds it, and back. */
const infos = {
	encode: (x: Info): Value => x.map(([name, h, f]) => [name, bytes32(h), f]),
	decode: (x: unknown, what: string): Info => {
		if (!Array.isArray(x)) throw new StoreError(`${what} is not a list`)
		return x.map((e) => {
			if (!Array.isArray(e) || e.length !== 3 || typeof e[0] !== "string" || !FORMS.has(e[2])) {
				throw new StoreError(`${what} is not [name, hash, form]s`)
			}
			return [e[0], unbytes(e[1], what), e[2] as Form] as const
		})
	},
}

const STEP = new Set([
	"number",
	"what",
	"from",
	"to",
	"before",
	"after",
	"id",
	"slot",
	"form",
	"info",
	"side",
])
const WHAT: ReadonlySet<unknown> = new Set(["file", "link", "folder", "rename", "remove", "info"])

/** A batch's plan. */
export const plan: Codec<Step[]> = {
	encode: (steps) =>
		encode(steps.map((s) => {
			const m: Fields = {
				number: s.number,
				what: s.what,
				before: where.encode(s.before),
				after: where.encode(s.after),
			}
			if (s.from !== undefined) m.from = s.from
			if (s.to !== undefined) m.to = s.to
			if (s.id !== undefined) m.id = s.id
			if (s.slot) m.slot = [s.slot[0], s.slot[1]]
			if (s.form !== undefined) m.form = s.form
			if (s.info !== undefined) m.info = infos.encode(s.info)
			if (s.side !== undefined) m.side = s.side
			return m
		})),
	decode: (bytes) => {
		let list: Value
		try {
			list = decode(bytes)
		} catch (e) {
			if (e instanceof CborError) throw new StoreError(`a plan is not CBOR: ${e.message}`)
			throw e
		}
		if (!Array.isArray(list)) throw new StoreError("a plan is not a list")
		return list.map((r: Value, i: number) => {
			const what = `the plan's step ${i}`
			if (!isFields(r)) throw new StoreError(`${what} is not a map`)
			only(r, STEP, what)
			if (!WHAT.has(r.what)) throw new StoreError(`${what} does nothing a step does`)
			const s: Step = {
				number: number(r.number, `${what}'s number`),
				what: r.what as Step["what"],
				before: where.decode(r.before, `${what}'s before`),
				after: where.decode(r.after, `${what}'s after`),
			}
			if ("from" in r) s.from = text(r.from, `${what}'s from`)
			if ("to" in r) s.to = text(r.to, `${what}'s to`)
			if ("id" in r) s.id = text(r.id, `${what}'s id`)
			if ("slot" in r) {
				const slot = texts(r.slot, `${what}'s slot`)
				if (slot.length !== 2) throw new StoreError(`${what}'s slot is not [holder, name]`)
				s.slot = [slot[0], slot[1]]
			}
			if ("form" in r) {
				if (!FORMS.has(r.form)) throw new StoreError(`${what}'s form is not one`)
				s.form = r.form as Form
			}
			if ("info" in r) s.info = infos.decode(r.info, `${what}'s info`)
			if ("side" in r) s.side = number(r.side, `${what}'s side`)
			return s
		})
	},
}

const STATE = new Set(["format", "done", "pass"])

/** The store record. */
export const state: Codec<State> = {
	encode: (x) => encode({ format: x.format, done: x.done, pass: [...x.pass] }),
	decode: (bytes) => {
		const r = map(bytes, "the store record")
		only(r, STATE, "the store record")
		if (r.format !== FORMAT) {
			throw new StoreError(`a store of format ${String(r.format)}, not ${FORMAT}`)
		}
		return {
			format: FORMAT,
			done: number(r.done, "the store's done"),
			pass: texts(r.pass, "the store's pass"),
		}
	},
}

// the folder -----------------------------------------------------------------

/** A manifest's folder and what is kept in it. */
export interface Manifest {
	/** the folder, .ermine */
	readonly dir: string
	/** Makes the folder and values/ (unless a mirror's, with nothing kept), tmp/ and id/ in it, if missing. */
	make(kept?: boolean): Promise<void>
	/** Whether it has a manifest file. */
	exists(): Promise<boolean>
	/** Every frame, folded into records; a last frame cut short is dropped; a broken one before it throws StoreError. Changes nothing. */
	read(): Promise<Map<string, Uint8Array>>
	/** Appends one frame, synced, cutting off first a last frame read as cut short. */
	append(frame: ReadonlyMap<string, Uint8Array | null>): Promise<void>
	/** Whether the log has grown past four times what it holds, and slack. */
	grown(): boolean
	/** Writes the records as one frame to tmp/, synced, renamed over the log, synced; then removes kept files no record names. */
	fold(records: ReadonlyMap<string, Uint8Array>): Promise<void>
	/** Keeps a value with no kept file: render's bytes, or its CBOR for cbor, in tmp/, synced, renamed into values/, synced. */
	put(value: Value, hash?: Hash): Promise<Kept>
	/** A kept value; throws StoreError when its file is missing or does not hash to its name. */
	get(hash: Hash, form: Form): Promise<Value>
}

/** A frame: its length, 4 bytes big-endian, then the CBOR of a map from key to bytes or null. */
function frame(records: Iterable<[string, Uint8Array | null]>): Uint8Array {
	const body = encode(
		Object.fromEntries([...records].map(([k, v]) => [k, v])),
	)
	if (body.length > 0xffffffff) throw new StoreError("a frame longer than its length can say")
	const out = new Uint8Array(4 + body.length)
	new DataView(out.buffer).setUint32(0, body.length)
	out.set(body, 4)
	return out
}

/** Applies a frame that decoded to the records; StoreError if it is not a map of bytes or null. */
function apply(records: Map<string, Uint8Array>, f: Value, at: number) {
	if (!isFields(f)) throw new StoreError(`the frame at byte ${at} of the manifest is not a map`)
	for (const [k, v] of Object.entries(f)) {
		if (v === null) records.delete(k)
		else if (v instanceof Uint8Array) records.set(k, v)
		else throw new StoreError(`the record ${JSON.stringify(k)} at byte ${at} is not bytes`)
	}
}

const parent = (path: string) => path.slice(0, path.lastIndexOf("/"))

async function missing<T>(p: Promise<T>): Promise<T | undefined> {
	try {
		return await p
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return undefined
		throw e
	}
}

/** The hashes of the values the records name: each node's, and each file a plan expects. */
export function named(records: ReadonlyMap<string, Uint8Array>): Set<Hash> {
	const out = new Set<Hash>()
	for (const [k, v] of records) {
		if (k.startsWith(NODE)) { for (const [h] of kepts(v)) out.add(h) }
		else if (k === PLAN) {
			for (const s of plan.decode(v)) {
				for (const f of [s.before, s.after]) if (f && "file" in f) out.add(f.file)
				for (const [, h] of s.info ?? []) out.add(h)
			}
		}
	}
	return out
}

/** The manifest in the folder dir. */
export function manifest(
	dir: string,
	sys: Sys,
	{ slack = 1 << 20 }: { slack?: number } = {},
): Manifest {
	const log = `${dir}/manifest`
	const values = `${dir}/values`
	const tmp = `${dir}/tmp`
	// once read: each record's size; how many bytes of the log are whole frames; whether a frame
	// cut short follows them; whether the log is there
	let sizes: Map<string, number> | undefined
	let size = 0
	let cut = false
	let there = false
	// values being kept, so two puts of one write it once
	const putting = new Map<Hash, Promise<void>>()

	async function scan(): Promise<Map<string, Uint8Array>> {
		const bytes = await missing(Deno.readFile(log))
		const records = new Map<string, Uint8Array>()
		const all = bytes ?? new Uint8Array()
		const view = new DataView(all.buffer, all.byteOffset, all.byteLength)
		let at = 0
		while (at + 4 <= all.length) {
			const end = at + 4 + view.getUint32(at)
			if (end > all.length) break
			let f: Value
			try {
				f = decode(all.subarray(at + 4, end))
			} catch (e) {
				if (!(e instanceof CborError)) throw e
				// the last frame, cut short by a crash during its append
				if (end === all.length) break
				throw new StoreError(`the frame at byte ${at} of the manifest does not decode`)
			}
			apply(records, f, at)
			at = end
		}
		sizes = new Map([...records].map(([k, v]) => [k, v.byteLength]))
		size = at
		cut = at < all.length
		there = bytes !== undefined
		return records
	}

	function live(): number {
		let n = 0
		for (const [k, v] of sizes!) n += k.length + v + 4
		return n
	}

	/** Writes bytes in tmp/ as name, synced, then renames them to path, and syncs its folder. */
	async function through(name: string, bytes: Uint8Array, path: string) {
		await Deno.mkdir(tmp, { recursive: true })
		const t = `${tmp}/${name}`
		await Deno.writeFile(t, bytes)
		await sys.sync(t)
		await Deno.rename(t, path)
		await sys.sync(parent(path))
	}

	return {
		dir,
		async make(kept = true) {
			for (const d of kept ? [values, tmp, `${dir}/id`] : [tmp, `${dir}/id`]) {
				await Deno.mkdir(d, { recursive: true })
			}
		},
		async exists() {
			return (await missing(Deno.lstat(log)))?.isFile ?? false
		},
		read: scan,
		async append(records) {
			if (!sizes) await scan()
			const bytes = frame(records)
			const made = !there
			try {
				if (cut) await missing(Deno.truncate(log, size))
				await Deno.writeFile(log, bytes, { append: true })
				await sys.sync(log)
				if (made) await sys.sync(dir)
			} catch (e) {
				// what was written of it is cut off before the next append
				cut = true
				throw e
			}
			cut = false
			there = true
			size += bytes.length
			for (const [k, v] of records) v === null ? sizes!.delete(k) : sizes!.set(k, v.byteLength)
		},
		grown() {
			return sizes !== undefined && size > 4 * live() + slack
		},
		async fold(records) {
			const keep = named(records)
			const bytes = frame(records)
			await through("manifest", bytes, log)
			sizes = new Map([...records].map(([k, v]) => [k, v.byteLength]))
			size = bytes.length
			cut = false
			there = true
			// the fold is synced: what it no longer names goes
			const entries = await missing(Array.fromAsync(Deno.readDir(values)))
			for (const e of entries ?? []) {
				if (HEX.test(e.name) && !keep.has(e.name)) {
					await missing(Deno.remove(`${values}/${e.name}`))
				}
			}
		},
		async put(value, given) {
			const f = form(value)
			// text and bytes are hashed as they are, never encoded
			const cbor = f === "txt" || f === "bin" ? undefined : encode(value)
			// a text with no encoding is refused, a hash given or not
			if (given && typeof value === "string" && !value.isWellFormed()) encode(value)
			const h = given ?? (cbor ? digest(cbor) : hash(value))
			const path = `${values}/${h}`
			let p = putting.get(h)
			if (!p) {
				p = (async () => {
					if (await missing(Deno.lstat(path))) return
					await through(h, f === "cbor" ? cbor! : render(value, f), path)
				})().finally(() => putting.delete(h))
				putting.set(h, p)
			}
			await p
			return [h, f]
		},
		async get(h, f) {
			if (typeof h !== "string" || !HEX.test(h)) throw new StoreError(`${h} is not a hash`)
			if (!FORMS.has(f)) throw new StoreError(`${f} is not a form`)
			const bytes = await missing(Deno.readFile(`${values}/${h}`))
			if (!bytes) throw new StoreError(`the kept file of ${h} is missing`)
			let value: Value
			try {
				value = f === "cbor" ? decode(bytes) : parse(bytes, f)
			} catch (e) {
				if (e instanceof CborError || e instanceof FormError) {
					throw new StoreError(`the kept file of ${h} is not ${f}: ${e.message}`)
				}
				throw e
			}
			if (hash(value) !== h) {
				throw new StoreError(`the kept file of ${h} does not hash to its name`)
			}
			return value
		},
	}
}
