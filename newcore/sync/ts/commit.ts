// a change made on this device as a blop: which parents, base and Lamport number, and what of its
// header leaves the device (COMMIT.tex). Not sealed, not taken in: the blop only
import type { Blop, Patch } from "../../encoding/ts/blop.ts"
import type { Header } from "../../nodes/ts/change.ts"
import type { Site } from "../../nodes/ts/stacktrace.ts"
import { side } from "./apply.ts"
import type { Chains, Head } from "./chain.ts"

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

// the blop for the change at `at`; CommitError "range" when no version is there, or none to pop
export function commit(
	chains: Chains,
	change: Commitment,
	at: At,
	// deno-lint-ignore no-explicit-any
	roots: any, // the source roots, strings; the line protocol hands them untyped
	random: (n: number) => Uint8Array,
): Blop {
	// the versions' heads: those that have a side
	const heads: Head[] = chains.heads(change.object).filter((h) =>
		side(chains, h.name) !== undefined
	)
	const range = (from: number, to: number) => {
		if (!(0 <= from && from < to && to <= heads.length)) throw new CommitError("range")
		return heads.slice(from, to)
	}
	let used: Head[] = []
	let base: Head | undefined
	let combine = false
	let patches = change.patches
	if (typeof at === "number") {
		// the object with no versions: only 0, and no parents
		if (!(heads.length === 0 && at === 0)) used = range(at, at + 1)
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
		actor: change.header.actor,
		signer: change.signer,
		nonce: random(8),
		parents,
		lamport: 1 + Math.max(0, ...used.map((h) => h.blop.lamport)),
		patches,
	}
	if (change.header.reader !== undefined) blop.reader = change.header.reader
	if (change.header.site !== undefined) blop.site = share(change.header.site, roots)
	if (change.header.cause !== undefined) blop.cause = change.header.cause
	if (base !== undefined) blop.base = base.name
	if (combine) blop.combine = true
	return blop
}
