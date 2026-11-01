// A pack makes a run's steps small on the wire (WIRE.md, pack), in columns. The first step is
// worked
// out from step n - 1 (its prior), or goes whole. unpack rebuilds each step's bytes exactly, and
// throws on a pack that isn't one or was made against a prior not given.
import type { Value } from "@ermine/encoding/cbor"
import { type Columns, decode as patchesOf, encode as columns } from "@ermine/changeable/squish"
import { encode } from "@ermine/encoding/cbor"
import {
	decodeStep,
	encodeStep,
	hashStep,
	hex,
	idsOf,
	key,
	made,
	onOf,
	own,
	readOn,
	type Step,
	unhex,
	written,
	writtenOn,
} from "./step.ts"

export type Packed = [
	first: Uint8Array | number,
	lamport: number[],
	when: number[],
	node: Value[],
	part: Value[],
	who: Value[],
	count: number[],
	columns: Columns,
	on: Value[],
	ids: Value[],
	devices?: Uint8Array[],
]

// devices: the keys named in on and ids, each a table index (a byte string of one byte) in the
// pack; a key past DEVICES stays whole (WIRE.md, pack)
export const DEVICES = 256

const alike = (a: unknown, b: unknown) =>
	a === b ||
	(Array.isArray(a) && Array.isArray(b) && a.length === 1 && b.length === 1 && a[0] === b[0]) ||
	(Array.isArray(a) && Array.isArray(b) && same(encode(a as Value), encode(b as Value)))
const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])

function runs<T>(xs: T[]): T[] {
	const out: T[] = []
	for (const x of xs) {
		const n = out.length
		if (n && alike(out[n - 2], x)) (out[n - 1] as number)++
		else out.push(x, 1 as T)
	}
	return out
}
function unruns<T>(rs: T[]): T[] {
	const out: T[] = []
	for (let i = 0; i < rs.length; i += 2) {
		for (let n = 0; n < (rs[i + 1] as number); n++) out.push(rs[i])
	}
	return out
}

const bad = (): never => {
	throw new TypeError("not a pack")
}
const STEPS = 4096, PATCHES = 65536
// the most bytes a run's steps make, all told (WIRE.md, runs)
export const RUN = 2 ** 24
// a run's steps made past the most a taker takes (RUN, or less)
export class Bound extends RangeError {}

function length(rs: unknown): number {
	if (!Array.isArray(rs) || rs.length % 2) return -1
	let n = 0
	for (let i = 1; i < rs.length; i += 2) {
		if (!Number.isSafeInteger(rs[i]) || rs[i] < 1) return -1
		n += rs[i]
	}
	return n
}
function sum(rs: unknown[]): number {
	let n = 0
	for (let i = 0; i < rs.length; i += 2) {
		if (!Number.isSafeInteger(rs[i]) || (rs[i] as number) < 0) return -1
		n += (rs[i] as number) * (rs[i + 1] as number)
	}
	return n
}
function patchCount(c: Columns): number {
	const n = length(c?.shape)
	if (n < 0 || n > PATCHES || length(c.path) !== n || !Array.isArray(c.paths)) return -1
	let ranged = 0, valued = 0, moved = 0
	for (let i = 0; i < c.shape.length; i += 2) {
		const s = c.shape[i], k = c.shape[i + 1]
		if (!Number.isInteger(s) || s < 0 || s > 7) return -1
		ranged += s & 1 ? k : 0, valued += s & 2 ? k : 0, moved += s & 4 ? k : 0
	}
	const ok = length(c.from) === ranged && length(c.size) === ranged &&
		Array.isArray(c.value) && c.value.length === valued && Array.isArray(c.move) &&
		c.move.length === moved &&
		c.path.every((x, i) => i % 2 || (Number.isInteger(x) && x >= 0 && x < c.paths.length))
	return ok ? n : -1
}

// next: the seq the step after it has
export type Prior = {
	device: string
	n: number
	hash: Uint8Array
	lamport: number
	when: number
	next: number
}
export function priorOf(bytes: Uint8Array): Prior {
	const s = decodeStep(bytes)
	return {
		device: s.device,
		n: s.n,
		hash: hashStep(bytes),
		lamport: s.lamport,
		when: s.when,
		next: s.seq + made(s),
	}
}
export function firstOf(p: Packed): { n: number; prior: boolean } {
	return typeof p[0] === "number"
		? { n: p[0], prior: true }
		: { n: decodeStep(p[0]).n, prior: false }
}

export const stepsIn = (p: Packed) =>
	(typeof p[0] === "number" ? 0 : 1) + (p[1] as number[]).reduce((k, x, i) => i % 2 ? k + x : k, 0)

// with a devices table when that is shorter
export function pack(bytes: readonly Uint8Array[], prior?: Prior): Packed {
	const named = build(bytes, prior, true)
	if (named.length === 10) return named
	const whole = build(bytes, prior, false)
	return encode(whole as Value).length <= encode(named as Value).length ? whole : named
}

function build(bytes: readonly Uint8Array[], prior: Prior | undefined, table: boolean): Packed {
	const steps = bytes.map(decodeStep), s0 = steps[0]
	if (prior && (prior.device !== s0.device || prior.n !== s0.n - 1)) {
		throw new RangeError("not the step before")
	}
	const before: Pick<Step, "lamport" | "when">[] = prior ? [prior, ...steps] : steps
	const rest = prior ? steps : steps.slice(1)
	// a step's seq is not in a pack: the one after the steps before it
	let next = prior ? prior.next : s0.seq + made(s0)
	for (const s of rest) {
		if (s.seq !== next) throw new RangeError("not the seq after the step before")
		next += made(s)
	}
	// Another device's n counts from the last this column gave it, so typing by turns makes runs.
	const last = new Map<string, number>()
	const seen = new Map<string, number>(), devices: Uint8Array[] = []
	const ref = (d: Uint8Array): Uint8Array => {
		const k = hex(d)
		let i = seen.get(k)
		if (i === undefined) {
			if (!table || devices.length >= DEVICES) return d
			seen.set(k, i = devices.length), devices.push(d)
		}
		return Uint8Array.of(i)
	}
	const named = (v: Value): Value =>
		v instanceof Uint8Array ? ref(v) : Array.isArray(v) ? v.map(named) : v
	const on = runs(rest.map((s) =>
		(writtenOn(s) as Value[]).map((o) => {
			if (typeof o === "number") return o
			const [d, n] = o as [Uint8Array, number], k = hex(d), was = last.get(k) ?? 0
			return last.set(k, n), [ref(d), n - was]
		})
	))
	const ids = runs(rest.map((s) => named(s.ids as Value)))
	const out: Packed = [
		prior ? s0.n : bytes[0],
		runs(rest.map((s, i) => s.lamport - before[i].lamport)),
		runs(rest.map((s, i) => s.when - before[i].when)),
		runs(rest.map(written)),
		runs(rest.map((s) => s.part)),
		runs(rest.map((s) => s.who ?? null)),
		runs(rest.map((s) => s.patches.length)),
		columns(rest.flatMap((s) => s.patches)),
		on,
		ids,
	]
	if (devices.length) out.push(devices)
	return out
}

export function unpack(p: unknown, prior?: Prior, max = RUN): Uint8Array[] {
	if (!Array.isArray(p) || (p.length !== 10 && p.length !== 11)) throw new TypeError("not a pack")
	const [first, lamports, whens, nodes, parts, whos, counts, cols, ons, idss, devices] =
		p as Packed
	if (
		p.length === 11 &&
		(!Array.isArray(devices) || devices.length < 1 || devices.length > DEVICES ||
			!devices.every(key))
	) throw new TypeError("not a pack")
	const steps = length(lamports), patches = patchCount(cols)
	const against = typeof first === "number"
	const ok = steps >= 0 && steps < STEPS && patches >= 0 &&
		(first instanceof Uint8Array ||
			(Number.isSafeInteger(first) && (first as number) >= 2 && steps >= 1)) &&
		[whens, nodes, parts, whos, counts, ons, idss].every((c) => length(c) === steps) &&
		sum(counts) === patches
	if (!ok) throw new TypeError("not a pack")
	if (against && prior?.n !== (first as number) - 1) {
		throw new RangeError("the step before is not held")
	}
	const out: Uint8Array[] = against ? [] : [first as Uint8Array]
	let prev: Pick<Step, "device" | "n" | "lamport" | "when"> = against
		? prior!
		: decodeStep(first as Uint8Array)
	let next = against ? prior!.next : (prev as Step).seq + made(prev as Step)
	let hash = against ? prior!.hash : hashStep(first as Uint8Array), at = 0
	// the steps' bytes so far: past max, refused before any more is made
	let bytes = against ? 0 : (first as Uint8Array).length
	if (bytes > max) throw new Bound("a run past its most bytes")
	const lamport = unruns(lamports),
		when = unruns(whens),
		node = unruns(nodes),
		part = unruns(parts),
		who = unruns(whos),
		count = unruns(counts),
		on = unruns(ons),
		ids = unruns(idss)
	const all = patchesOf(cols)
	if (
		!node.every((x) =>
			typeof x === "string" || (Array.isArray(x) && x.length === 1 && typeof x[0] === "string")
		)
	) {
		throw new TypeError("not a pack")
	}
	if (!on.every((x) => Array.isArray(x)) || !ids.every((x) => Array.isArray(x))) {
		throw new TypeError("not a pack")
	}
	// a key whole, or by its table index; a one byte string with no table, or past it: not a pack
	const expand = <T extends Value>(v: T): T =>
		(v instanceof Uint8Array
			? v.length === 1 ? devices?.[v[0]] ?? bad() : v
			: Array.isArray(v)
			? v.map(expand)
			: v) as T
	const device = unhex(prev.device), last = new Map<string, number>()
	for (let i = 0; i < count.length; i++) {
		const written = (on[i] as unknown[]).map((o) => {
			if (!Array.isArray(o) || o.length !== 2 || !(o[0] instanceof Uint8Array)) return o
			const d = expand(o[0]), k = hex(d), n = (last.get(k) ?? 0) + (o[1] as number)
			return last.set(k, n), [d, n]
		})
		if (!written.every(onOf(device, prev.n + 1))) throw new TypeError("not a pack")
		const named = expand(ids[i] as Value) as Value[]
		const s: Step = {
			device: prev.device,
			n: prev.n + 1,
			before: hash,
			...(typeof node[i] === "string"
				? { node: node[i] as string }
				: { node: own(prev.device) + (node[i] as string[])[0], relative: true }),
			part: part[i] as string,
			patches: all.slice(at, at += count[i]),
			lamport: prev.lamport + lamport[i],
			when: prev.when + when[i],
			seq: next,
			...(who[i] !== null && { who: who[i] as string }),
			on: readOn(prev.device, prev.n + 1, written),
			ids: named,
		}
		if (!idsOf(device, s.n, s.patches as unknown[])(named)) throw new TypeError("not a pack")
		if (next > Number.MAX_SAFE_INTEGER - made(s)) throw new TypeError("not a pack")
		next += made(s)
		const b = encodeStep(s)
		if ((bytes += b.length) > max) throw new Bound("a run past its most bytes")
		out.push(b)
		prev = s, hash = hashStep(b)
	}
	return out
}
