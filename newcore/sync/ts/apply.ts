// what an object holds after a blop, worked out from its chain (APPLY.tex)
// sides: the patches applied, as mutate applies them to a first version, to the base's side
import type { Blop } from "../../encoding/ts/blop.ts"
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
	const before = base === undefined ? undefined : side(chains, base)
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

// a blop's side, or undefined: not taken in, or emptied
export function side(chains: Chains, name: Uint8Array): unknown {
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

// an object's versions: its heads in the agreed order, each with a side; time(name) the caller's
export function versions(
	chains: Chains,
	object: Blop["object"],
	time: (name: string) => number,
): Version[] {
	const out: Version[] = []
	for (const head of chains.heads(object)) {
		const content = side(chains, head.name)
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
