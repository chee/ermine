// a run of sealed commits as columns: what a fragment carries (extensions/subduction/plan.org,
// Rewrite for the new shape). lossless: unpack gives back each sealed commit's exact bytes, so its
// name, its stored id and its signature are as they were. deterministic: the same commits in the
// same order give the same bytes on any device, so any device builds the same fragment.
//
// what a column saves:
//   table, actor, reader, external, metadata, signer: runs of one value, [value, how many]
//   time, nonce, lamport: the first, then each one's difference from the one before, as zigzag
//            varints in one byte string (a number in this CBOR is a float, 3 bytes at least; a
//            difference of 0 or 1 here is 1)
//   parents: null when they are exactly the commit before's name (a run of typing, as a rule);
//            else each parent by its place in the run, or its name when it is not in it
//   base: as parents' refs, null when there is none
//   patches: a string when the commit is one insert going on from the commit before's last (at
//            the same path, where that one's text ended): its text; else the patches as they are
//   signatures: every one, 64 bytes each, end to end: what is left, about 70 bytes a commit
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, decode, encode, name as nameOf, type Patch } from "@ermine/encoding/commit"
import { hex } from "./hex.ts"

export class RunError extends Error {
	constructor(why: string) {
		super(why)
	}
}

type Ref = number | Uint8Array

// [value, how many] for each stretch of equal values; equal: the same encoding
function runs(values: unknown[]): [unknown, number][] {
	const out: [unknown, number][] = []
	let was = ""
	for (const v of values) {
		const k = hex(cbor.encode(v as cbor.Value))
		if (out.length && k === was) out[out.length - 1][1]++
		else out.push([v, 1])
		was = k
	}
	return out
}
function unruns(r: unknown, n: number): unknown[] {
	if (!Array.isArray(r)) throw new RunError("a column of runs")
	const out: unknown[] = []
	for (const pair of r) {
		if (
			!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[1]) || pair[1] < 1
		) {
			throw new RunError("a run")
		}
		for (let i = 0; i < pair[1]; i++) out.push(pair[0])
	}
	if (out.length !== n) throw new RunError("a column's length")
	return out
}

// whole numbers as the first, then each one's difference from the one before, each zigzag (0, -1,
// 1, -2 … to 0, 1, 2, 3 …) and seven bits a byte, the high bit set on all but the last
function deltas(xs: number[]): Uint8Array {
	const out: number[] = []
	xs.forEach((x, i) => {
		const d = i === 0 ? x : x - xs[i - 1]
		let z = d >= 0 ? 2 * d : -2 * d - 1
		while (z >= 128) {
			out.push(z % 128 + 128)
			z = Math.floor(z / 128)
		}
		out.push(z)
	})
	return Uint8Array.from(out)
}
function undeltas(b: unknown, n: number): number[] {
	if (!(b instanceof Uint8Array)) throw new RunError("a column of differences")
	const out: number[] = []
	let at = 0
	for (let i = 0; i < n; i++) {
		let z = 0, scale = 1
		for (;;) {
			if (at >= b.length || scale > 2 ** 56) throw new RunError("a column of differences")
			const byte = b[at++]
			z += (byte % 128) * scale
			if (byte < 128) break
			scale *= 128
		}
		const d = z % 2 === 0 ? z / 2 : -(z + 1) / 2
		const x = i === 0 ? d : out[i - 1] + d
		if (!Number.isSafeInteger(x)) throw new RunError("a column of differences")
		out.push(x)
	}
	if (at !== b.length) throw new RunError("a column of differences")
	return out
}

const points = (s: string) => [...s].length
const samePath = (a: readonly unknown[], b: readonly unknown[]) =>
	a.length === b.length && a.every((x, i) => x === b[i])
const isInsert = (p: Patch | undefined): p is Patch & { range: [number, number]; value: string } =>
	p !== undefined && p.move === undefined && typeof p.value === "string" &&
	p.range !== undefined &&
	p.range[0] === p.range[1]

// the patch a string stands for: one insert going on from before's last, or undefined: none can
function after(before: Commit | undefined): Patch | undefined {
	const last = before?.patches[before.patches.length - 1]
	if (!isInsert(last)) return
	const at = last.range[0] + points(last.value)
	return { path: [...last.path], range: [at, at] }
}

// the sealed commits, in the run's order, as columns
export function pack(sealed: readonly Uint8Array[]): Uint8Array {
	const commits: Commit[] = [],
		names: string[] = [],
		signatures = new Uint8Array(64 * sealed.length)
	sealed.forEach((s, i) => {
		const o = cbor.decode(s) as { commit: Uint8Array; signature: Uint8Array }
		commits.push(decode(o.commit))
		names.push(hex(nameOf(o.commit)))
		signatures.set(o.signature, 64 * i)
	})
	const place = new Map(names.map((n, i) => [n, i]))
	const ref = (p: Uint8Array): Ref => place.get(hex(p)) ?? p
	const columns: Record<string, unknown> = {
		n: commits.length,
		table: runs(commits.map((c) => c.table)),
		actor: runs(commits.map((c) => c.actor)),
		reader: runs(commits.map((c) => c.reader ?? null)),
		external: runs(commits.map((c) => c.external ?? null)),
		metadata: runs(commits.map((c) => c.metadata ?? null)),
		signer: runs(commits.map((c) => c.signer)),
		time: deltas(commits.map((c) => c.time)),
		nonce: deltas(commits.map((c) => c.nonce)),
		lamport: deltas(commits.map((c) => c.lamport)),
		parents: commits.map((c, i) =>
			i > 0 && c.parents.length === 1 && hex(c.parents[0]) === names[i - 1]
				? null
				: c.parents.map(ref)
		),
		base: runs(commits.map((c) => c.base === undefined ? null : ref(c.base))),
		patches: commits.map((c, i) => {
			const p = c.patches[0], want = after(commits[i - 1])
			if (
				c.patches.length === 1 && want !== undefined && isInsert(p) &&
				samePath(p.path, want.path!) &&
				p.range[0] === want.range![0]
			) return p.value
			return c.patches
		}),
		signatures,
	}
	return cbor.encode(columns as cbor.Value)
}

// the run's sealed commits back, each its exact bytes. RunError: not a run
export function unpack(bytes: Uint8Array): Uint8Array[] {
	let x: unknown
	try {
		x = cbor.decode(bytes)
	} catch {
		throw new RunError("not cbor")
	}
	if (x === null || typeof x !== "object" || Array.isArray(x) || ArrayBuffer.isView(x)) {
		throw new RunError("not a map")
	}
	const o = x as Record<string, unknown>
	const n = o.n
	if (!Number.isSafeInteger(n) || (n as number) < 0) throw new RunError("n")
	const count = n as number
	const signatures = o.signatures
	if (!(signatures instanceof Uint8Array) || signatures.length !== 64 * count) {
		throw new RunError("signatures")
	}
	const table = unruns(o.table, count),
		actor = unruns(o.actor, count),
		reader = unruns(o.reader, count)
	const external = unruns(o.external, count), metadata = unruns(o.metadata, count)
	const signer = unruns(o.signer, count), base = unruns(o.base, count)
	const time = undeltas(o.time, count),
		nonce = undeltas(o.nonce, count),
		lamport = undeltas(o.lamport, count)
	if (!Array.isArray(o.parents) || o.parents.length !== count) throw new RunError("parents")
	if (!Array.isArray(o.patches) || o.patches.length !== count) throw new RunError("patches")
	const names: Uint8Array[] = [], commits: Commit[] = [], out: Uint8Array[] = []
	const deref = (r: unknown, i: number): Uint8Array => {
		if (r instanceof Uint8Array) return r
		if (!Number.isSafeInteger(r) || (r as number) < 0 || (r as number) >= i) {
			throw new RunError("a ref")
		}
		return names[r as number]
	}
	for (let i = 0; i < count; i++) {
		const ps = o.parents[i]
		let parents: Uint8Array[]
		if (ps === null && i > 0) parents = [names[i - 1]]
		else if (Array.isArray(ps)) parents = ps.map((r) => deref(r, i))
		else throw new RunError("parents")
		let patches: Patch[]
		const p = o.patches[i]
		if (typeof p === "string") {
			const want = after(commits[i - 1])
			if (want === undefined) throw new RunError("an insert going on from nothing")
			patches = [{ ...want, value: p }]
		} else if (Array.isArray(p)) patches = p as Patch[]
		else throw new RunError("patches")
		const c: Commit = {
			table: table[i] as string,
			actor: actor[i],
			time: time[i],
			signer: signer[i] as Uint8Array,
			nonce: nonce[i],
			parents,
			lamport: lamport[i],
			patches,
		}
		if (reader[i] !== null) c.reader = reader[i] as string
		if (external[i] !== null) c.external = external[i] as Commit["external"]
		if (metadata[i] !== null) c.metadata = metadata[i] as Commit["metadata"]
		if (base[i] !== null) c.base = deref(base[i], i)
		let b: Uint8Array
		try {
			b = encode(c)
		} catch {
			throw new RunError("a commit")
		}
		commits.push(c)
		names.push(nameOf(b))
		out.push(cbor.encode({ commit: b, signature: signatures.slice(64 * i, 64 * i + 64) }))
	}
	return out
}
