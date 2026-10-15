// what an object holds after a blop, worked out from its history (APPLY.tex)
// sides: the patches applied, as mutate applies them to a first version, to the base's side
import type { Blop } from "@ermine/encoding/blop"
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { ApplyError } from "@ermine/op/apply"
import type { Histories } from "./history.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// sync's mark on a version: where it sits in the history (its Lamport number and name) and who
// signed it. There is no Because in core today, so this is sync's own
export type Because = {
	layer: "sync"
	place: { lamport: number; name: string }
	why: { signer: string }
}

// one of an object's versions: its head's side, change header and because. The change header holds
// the blop's reader and site (as external); its cause, wallclock and message are metadata entries
// of those names. The node is not in a header today: it is the blop's
export type Version = {
	// absent: a removal among other heads
	content?: unknown
	change: ChangeHeader
	because: Because
}

// sides kept: heads' only, by their blop (APPLY.tex); a side never changes
const kept = new WeakMap<Histories, Map<Blop, unknown>>()
const sides = (histories: Histories) => {
	if (!kept.has(histories)) kept.set(histories, new Map())
	return kept.get(histories)!
}

const base = (blop: Blop) => blop.base ?? blop.parents[0]

// the side after the blop's patches on before; ApplyError when they do not apply
function after(blop: Blop, before: unknown): unknown {
	const entry = createEntry(before, { time: 0, actor: blop.actor })
	update(entry, blop.patches as never, { time: 0, actor: blop.actor })
	return entry.value
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
		if (e instanceof ApplyError) return false
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
		const header: ChangeHeader = { time: time(name), actor: blop.actor }
		if (blop.reader !== undefined) header.reader = blop.reader
		if (blop.site !== undefined) header.external = [blop.site]
		const metadata: [string, unknown][] = []
		if (blop.cause !== undefined) metadata.push(["cause", blop.cause])
		if (blop.wallclock !== undefined) metadata.push(["wallclock", blop.wallclock])
		if (blop.message !== undefined) metadata.push(["message", blop.message])
		if (metadata.length) header.metadata = metadata
		const version: Version = {
			change: header,
			because: {
				layer: "sync",
				place: { lamport: blop.lamport, name },
				why: { signer: hex(blop.signer) },
			},
		}
		if (content !== undefined) version.content = content
		out.push(version)
	}
	return out
}
