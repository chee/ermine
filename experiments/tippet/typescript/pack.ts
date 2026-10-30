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
	on?: Value[],
]

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

const STEPS = 4096, PATCHES = 65536
// the most bytes a run's steps make, all told (WIRE.md, runs)
export const RUN = 2 ** 24

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

export type Prior = { device: string; n: number; hash: Uint8Array; lamport: number; when: number }
export function priorOf(bytes: Uint8Array): Prior {
	const s = decodeStep(bytes)
	return { device: s.device, n: s.n, hash: hashStep(bytes), lamport: s.lamport, when: s.when }
}
export function firstOf(p: Packed): { n: number; prior: boolean } {
	return typeof p[0] === "number"
		? { n: p[0], prior: true }
		: { n: decodeStep(p[0]).n, prior: false }
}

export const stepsIn = (p: Packed) =>
	(typeof p[0] === "number" ? 0 : 1) + (p[1] as number[]).reduce((k, x, i) => i % 2 ? k + x : k, 0)

export function pack(bytes: readonly Uint8Array[], prior?: Prior): Packed {
	const steps = bytes.map(decodeStep), s0 = steps[0]
	if (prior && (prior.device !== s0.device || prior.n !== s0.n - 1)) {
		throw new RangeError("not the step before")
	}
	const before: Pick<Step, "lamport" | "when">[] = prior ? [prior, ...steps] : steps
	const rest = prior ? steps : steps.slice(1)
	const p: Packed = [
		prior ? s0.n : bytes[0],
		runs(rest.map((s, i) => s.lamport - before[i].lamport)),
		runs(rest.map((s, i) => s.when - before[i].when)),
		runs(rest.map(written)),
		runs(rest.map((s) => s.part)),
		runs(rest.map((s) => s.who ?? null)),
		runs(rest.map((s) => s.patches.length)),
		columns(rest.flatMap((s) => s.patches)),
	]
	if (rest.some((s) => s.on)) {
		// Another device's n counts from the last this column gave it, so typing by turns makes
		// runs.
		const last = new Map<string, number>()
		p.push(runs(rest.map((s) =>
			s.on
				? (writtenOn(s) as Value[]).map((o) => {
					if (typeof o === "number") return o
					const [d, n] = o as [Uint8Array, number], k = hex(d), was = last.get(k) ?? 0
					return last.set(k, n), [d, n - was]
				})
				: null
		)))
	}
	return p
}

export function unpack(p: unknown, prior?: Prior): Uint8Array[] {
	if (!Array.isArray(p) || (p.length !== 8 && p.length !== 9)) throw new TypeError("not a pack")
	const [first, lamports, whens, nodes, parts, whos, counts, cols] = p as Packed
	const steps = length(lamports), patches = patchCount(cols)
	const ons = p.length === 9 ? (p as Packed)[8]! : steps > 0 ? [null, steps] : []
	const against = typeof first === "number"
	const ok = steps >= 0 && steps < STEPS && patches >= 0 &&
		(first instanceof Uint8Array ||
			(Number.isSafeInteger(first) && (first as number) >= 2 && steps >= 1)) &&
		[whens, nodes, parts, whos, counts, ons].every((c) => length(c) === steps) &&
		sum(counts) === patches
	if (!ok) throw new TypeError("not a pack")
	if (against && prior?.n !== (first as number) - 1) {
		throw new RangeError("the step before is not held")
	}
	const out: Uint8Array[] = against ? [] : [first as Uint8Array]
	let prev: Pick<Step, "device" | "n" | "lamport" | "when"> = against
		? prior!
		: decodeStep(first as Uint8Array)
	let hash = against ? prior!.hash : hashStep(first as Uint8Array), at = 0
	// the steps' bytes so far: past RUN, refused before any more is made
	let bytes = against ? 0 : (first as Uint8Array).length
	if (bytes > RUN) throw new RangeError("a run past its most bytes")
	const lamport = unruns(lamports),
		when = unruns(whens),
		node = unruns(nodes),
		part = unruns(parts),
		who = unruns(whos),
		count = unruns(counts),
		on = unruns(ons)
	const all = patchesOf(cols)
	if (
		!node.every((x) =>
			typeof x === "string" || (Array.isArray(x) && x.length === 1 && typeof x[0] === "string")
		)
	) {
		throw new TypeError("not a pack")
	}
	if (!on.every((x) => x === null || Array.isArray(x))) throw new TypeError("not a pack")
	const device = unhex(prev.device), last = new Map<string, number>()
	for (let i = 0; i < count.length; i++) {
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
			...(who[i] !== null && { who: who[i] as string }),
		}
		if (on[i] !== null) {
			const written = (on[i] as unknown[]).map((o) => {
				if (!Array.isArray(o) || o.length !== 2 || !(o[0] instanceof Uint8Array)) return o
				const k = hex(o[0]), n = (last.get(k) ?? 0) + (o[1] as number)
				return last.set(k, n), [o[0], n]
			})
			if (!written.every(onOf(device, prev.n + 1))) throw new TypeError("not a pack")
			s.on = readOn(prev.device, prev.n + 1, written)
		}
		const b = encodeStep(s)
		if ((bytes += b.length) > RUN) throw new RangeError("a run past its most bytes")
		out.push(b)
		prev = s, hash = hashStep(b)
	}
	return out
}
