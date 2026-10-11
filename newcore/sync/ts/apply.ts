// what an object holds after a blop, worked out from its chain (APPLY.tex)
// sides: the patches applied, as mutate applies them to a first version, to the base's side
import type { Blop } from "../../encoding/ts/blop.ts"
import { Stand } from "../../encoding/ts/cbor.ts"
import createBecause, { type Because } from "../../nodes/ts/because.ts"
import createChange, { type Change } from "../../nodes/ts/change.ts"
import createNode from "../../nodes/ts/node.ts"
import mutate, { MutateError } from "../../opstreams/ts/mutate.ts"
import type { Chains } from "./chain.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// one of an object's versions: its head's side, change and because
export type Version = {
	content: unknown
	change: Change
	because: Because<{ lamport: number; name: string }, { signer: string }>
}

// kept for blops taken in only: their sides never change
const kept = new WeakMap<Chains, Map<string, unknown>>()

// the side after the blop's patches; MutateError when they do not apply
function after(chains: Chains, blop: Blop): unknown {
	const base = blop.base ?? blop.parents[0]
	const before = base === undefined ? undefined : data(chains, base)
	const change = createChange(blop.node, { time: 0, actor: blop.actor })
	const versions = before === undefined ? [] : [{ content: before, change }]
	const o = blop.object
	const n = createNode<unknown, typeof change>(blop.node)
	if (o === "value") n.value = versions
	else if (o[0] === "info") n.info.set(o[1], versions)
	else n.children.set(o[1], versions as never)
	mutate(n, o, blop.patches, { time: 0, actor: blop.actor })
	const left = o === "value" ? n.value : (o[0] === "info" ? n.info : n.children).get(o[1])
	return left?.[0]?.content
}

// x with each stand-in in it made into what live(kind) makes of it (a stand-in is not a plain
// object, so it is checked first); a kind it makes nothing of (undefined), or no live: the
// stand-in, as data. Copies only what holds one
function lived(x: unknown, live: Live): unknown {
	if (x instanceof Stand) {
		const made = live(x.kind)
		return made === undefined ? x : made
	}
	if (x === null || typeof x !== "object" || x instanceof ArrayBuffer || ArrayBuffer.isView(x)) {
		return x
	}
	if (Array.isArray(x)) {
		const items = x.map((e) => lived(e, live))
		return items.some((e, i) => e !== x[i]) ? items : x
	}
	const keys = Object.keys(x), made: Record<string, unknown> = {}
	let changed = false
	for (const k of keys) {
		const v = lived((x as Record<string, unknown>)[k], live)
		if (v !== (x as Record<string, unknown>)[k]) changed = true
		Object.defineProperty(made, k, {
			value: v,
			enumerable: true,
			writable: true,
			configurable: true,
		})
	}
	return changed ? made : x
}

/** The host's: what a stand-in's kind makes (a canvas here for a canvas there); undefined: nothing. */
export type Live = (kind: unknown) => unknown

// a blop's side, or undefined: not taken in, or emptied. live (optional, the host's): what the
// stand-ins in it become (APPLY.tex); none given: stand-ins stay as data
export function side(chains: Chains, name: Uint8Array, live?: Live): unknown {
	const content = data(chains, name)
	return live === undefined || content === undefined ? content : lived(content, live)
}

// the side as data, stand-ins as they are
function data(chains: Chains, name: Uint8Array): unknown {
	const blop = chains.get(name)
	if (blop === undefined) return undefined
	if (!kept.has(chains)) kept.set(chains, new Map())
	const sides = kept.get(chains)!
	const n = hex(name)
	if (!sides.has(n)) sides.set(n, after(chains, blop))
	return sides.get(n)
}

// whether the blop's patches apply to its base's side
export function check(chains: Chains, blop: Blop): boolean {
	try {
		after(chains, blop)
		return true
	} catch (e) {
		if (e instanceof MutateError) return false
		throw e
	}
}

// an object's versions: its heads in the agreed order, each with a side; time(name) the caller's;
// live (optional, the host's) makes each stand-in in a side into what it makes of its kind, as side
export function versions(
	chains: Chains,
	object: Blop["object"],
	time: (name: string) => number,
	live?: Live,
): Version[] {
	const out: Version[] = []
	for (const head of chains.heads(object)) {
		const content = side(chains, head.name, live)
		if (content === undefined) continue
		const { blop } = head
		const name = hex(head.name)
		const header: Parameters<typeof createChange>[1] = { time: time(name), actor: blop.actor }
		if (blop.reader !== undefined) header.reader = blop.reader
		if (blop.site !== undefined) header.site = blop.site
		if (blop.cause !== undefined) header.cause = blop.cause
		out.push({
			content,
			change: createChange(blop.node, header),
			because: createBecause("sync", { lamport: blop.lamport, name }, {
				signer: hex(blop.signer),
			}),
		})
	}
	return out
}
