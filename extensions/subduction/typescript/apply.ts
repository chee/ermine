// what an object holds after a blop, worked out from its history (APPLY.tex)
// sides: the patches applied, as mutate applies them to a first version, to the base's side
import type { Blop } from "@ermine/encoding/blop"
import createBecause, { type Because } from "@ermine/change/because"
import createChange, { type Change } from "@ermine/change"
import createNode from "@ermine/node"
import mutate, { MutateError } from "@ermine/op/mutate"
import type { Histories } from "./history.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// one of an object's versions: its head's side, change and because
export type Version = {
	// absent: a removal among other heads
	content?: unknown
	change: Change
	because: Because<{ lamport: number; name: string }, { signer: string }>
}

// sides kept: heads' only, by their blop (APPLY.tex); a side never changes
const kept = new WeakMap<Histories, Map<Blop, unknown>>()
const sides = (histories: Histories) => {
	if (!kept.has(histories)) kept.set(histories, new Map())
	return kept.get(histories)!
}

const base = (blop: Blop) => blop.base ?? blop.parents[0]

// the side after the blop's patches on before; MutateError when they do not apply
function after(blop: Blop, before: unknown): unknown {
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

// a blop's side, or undefined: not taken in, or emptied. a stand-in in it stays as it is (APPLY.tex)
export function side(histories: Histories, name: Uint8Array): unknown {
	const blop = histories.get(name)
	if (blop === undefined) return undefined
	const k = sides(histories)
	if (k.has(blop)) return k.get(blop)
	// not kept: back along the bases to the nearest side kept (or the root, none), then forward
	const line: Blop[] = []
	let before: unknown = undefined
	for (let b: Blop | undefined = blop; b !== undefined;) {
		if (k.has(b)) {
			before = k.get(b)
			break
		}
		line.push(b)
		const n = base(b)
		b = n === undefined ? undefined : histories.get(n)
	}
	// taken in: they applied, and apply again
	for (let i = line.length - 1; i >= 0; i--) before = after(line[i], before)
	return before
}

// whether the blop's patches apply to its base's side. They do: it is taken in next (HISTORY.tex,
// step 7 the last), a head, so its side is kept and its parents' let go
export function check(histories: Histories, blop: Blop): boolean {
	const n = base(blop)
	let made
	try {
		made = after(blop, n === undefined ? undefined : side(histories, n))
	} catch (e) {
		if (e instanceof MutateError) return false
		throw e
	}
	const k = sides(histories)
	for (const p of blop.parents) {
		const b = histories.get(p)
		if (b !== undefined) k.delete(b)
	}
	k.set(blop, made)
	return true
}

// an object's versions: its heads in the agreed order, each with a side; time(name) the caller's
export function versions(
	histories: Histories,
	object: Blop["object"],
	time: (name: string) => number,
): Version[] {
	const out: Version[] = []
	const heads = histories.heads(object)
	// a removal as the only head: the object is not there
	if (heads.length === 1 && side(histories, heads[0].name) === undefined) return out
	for (const head of heads) {
		const content = side(histories, head.name)
		const { blop } = head
		const name = hex(head.name)
		const header: Parameters<typeof createChange>[1] = { time: time(name), actor: blop.actor }
		if (blop.reader !== undefined) header.reader = blop.reader
		if (blop.site !== undefined) header.site = blop.site
		if (blop.cause !== undefined) header.cause = blop.cause
		if (blop.wallclock !== undefined) header.wallclock = blop.wallclock
		if (blop.message !== undefined) header.message = blop.message
		const version: Version = {
			change: createChange(blop.node, header),
			because: createBecause("sync", { lamport: blop.lamport, name }, {
				signer: hex(blop.signer),
			}),
		}
		if (content !== undefined) version.content = content
		out.push(version)
	}
	return out
}
