// a change made on this device as a blop: which parents, base and Lamport number, and what of its
// header leaves the device (COMMIT.tex). Not sealed, not taken in: the blop only
import type { Blop, Patch } from "@ermine/encoding/blop"
import { Stand } from "@ermine/encoding/cbor"
import type { Header } from "@ermine/graph/change"
import type { Site } from "@ermine/graph/stacktrace"
import { side } from "./apply.ts"
import type { Head, Histories } from "./history.ts"

// a version (a number), a span ([from, to), to not included), or versions popped (PLACES.tex)
export type At = number | readonly [number, number] | { pop: number | readonly [number, number] }

// the change: its node, object, patches and header; the signer this device's key
export type Commitment = {
	node: string
	object: Blop["object"]
	patches: Patch[]
	header: Header
	signer: Uint8Array
}

export type Code = "range"

export class CommitError extends Error {
	constructor(readonly code: Code) {
		super(code)
	}
}

// a live value (ENCODING.tex): a symbol, a function, a Map, an ArrayBuffer, any class's object
// other than a Stand, bytes (a Uint8Array) and typed arrays
function isLive(x: unknown): boolean {
	if (typeof x === "symbol" || typeof x === "function") return true
	if (x === null || typeof x !== "object") return false
	if (x instanceof Stand || ArrayBuffer.isView(x)) return false
	if (Array.isArray(x)) return false
	const proto = Object.getPrototypeOf(x)
	return proto !== Object.prototype && proto !== null
}

// x with each live value in it written as a stand-in over kind(it), null with no kind given; x
// itself where it holds none (and where it holds itself, for encoding to refuse)
export function standIns(
	x: unknown,
	kind?: (live: unknown) => unknown,
	open = new Set<object>(),
): unknown {
	if (isLive(x)) return new Stand((kind?.(x) ?? null) as never)
	if (
		x === null || typeof x !== "object" || x instanceof Stand || ArrayBuffer.isView(x) ||
		open.has(x)
	) return x
	open.add(x)
	let out: unknown = x
	if (Array.isArray(x)) {
		const items = x.map((e) => standIns(e, kind, open))
		if (items.some((e, i) => e !== x[i])) out = items
	} else {
		const keys = Object.keys(x), made: Record<string, unknown> = {}
		let changed = false
		for (const k of keys) {
			const v = standIns((x as Record<string, unknown>)[k], kind, open)
			if (v !== (x as Record<string, unknown>)[k]) changed = true
			Object.defineProperty(made, k, {
				value: v,
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		if (changed) out = made
	}
	open.delete(x)
	return out
}

// bytewise
function compare(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

// a path's parts, split on / and \
const parts = (path: string) => path.split(/[\\/]+/).filter((p) => p !== "")

// a local path: starting /, a drive letter, or file://; as parts, else none
function local(file: string): string[] | undefined {
	if (file.startsWith("file://")) file = file.slice(7).replace(/^\/(?=[A-Za-z]:)/, "")
	else if (!/^(\/|[A-Za-z]:[\\/])/.test(file)) return undefined
	return parts(file)
}

// the site shareable: a local path relative to the nearest root, else its last part; others kept
function share(site: Site, roots: string[]): Site {
	const path = local(site.file)
	if (path === undefined) return site
	let best: string[] | undefined
	for (const root of roots) {
		const r = local(root)
		if (r === undefined || r.length > path.length || !r.every((p, i) => p === path[i])) continue
		if (best === undefined || r.length > best.length) best = r
	}
	const rest = best === undefined ? [] : path.slice(best.length)
	return { ...site, file: rest.length ? rest.join("/") : path[path.length - 1] ?? site.file }
}

// the blop for the change at `at`; CommitError "range" when no version is there, or none to pop.
// kind: the host's, optional: what a live value in the patches, the actor or the cause is
// written as a stand-in over (COMMIT.tex); null with none
export function commit(
	histories: Histories,
	change: Commitment,
	at: At,
	// deno-lint-ignore no-explicit-any
	roots: any, // the source roots, strings; the line protocol hands them untyped
	random: (n: number) => Uint8Array,
	kind?: (live: unknown) => unknown,
): Blop {
	// the versions' heads: every head; a removal as the only head, none
	const all: Head[] = histories.heads(change.object)
	const heads = all.length === 1 && side(histories, all[0].name) === undefined ? [] : all
	const range = (from: number, to: number) => {
		if (!(0 <= from && from < to && to <= heads.length)) throw new CommitError("range")
		return heads.slice(from, to)
	}
	let used: Head[] = []
	let base: Head | undefined
	let combine = false
	let patches = change.patches
	if (typeof at === "number") {
		// the object with no versions: only 0, its removal (if any) the parent
		used = heads.length === 0 && at === 0 ? all : range(at, at + 1)
	} else if (Array.isArray(at)) {
		used = range(at[0], at[1])
		if (used.length > 1) base = used[0], combine = true
	} else {
		const p = (at as { pop: number | readonly [number, number] }).pop
		const [from, to] = typeof p === "number" ? [p, p + 1] : p
		const popped = range(from, to)
		const kept = heads.filter((h) => !popped.includes(h))
		if (kept.length) used = [...popped, kept[0]], base = kept[0], patches = []
		else used = popped, base = popped.length > 1 ? popped[0] : undefined, patches = [{ path: [] }]
	}
	const parents = used.map((h) => h.name).sort(compare)
	const blop: Blop = {
		node: change.node,
		object: change.object,
		actor: standIns(change.header.actor, kind),
		signer: change.signer,
		nonce: random(8),
		parents,
		lamport: 1 + Math.max(0, ...used.map((h) => h.blop.lamport)),
		patches: standIns(patches, kind) as Patch[],
	}
	if (change.header.reader !== undefined) blop.reader = change.header.reader
	if (change.header.site !== undefined) blop.site = share(change.header.site, roots)
	if (change.header.cause !== undefined) blop.cause = standIns(change.header.cause, kind)
	if (change.header.wallclock !== undefined) blop.wallclock = change.header.wallclock
	if (change.header.message !== undefined) blop.message = change.header.message
	if (base !== undefined) blop.base = base.name
	if (combine) blop.combine = true
	return blop
}
