// sync's side of the graph (WIRING.tex): each record a change made goes out (COMMIT.tex), taken in
// to its histories at once and sealed, stored and sent after; each blop taken in from elsewhere comes
// in (APPLY.tex) as its object's versions. The graph's `changed` is this one's `changed`; the
// scheduler's internal `versions` is given to it
import { type Blop, encode, name as blopName } from "../../encoding/ts/blop.ts"
import type { Changed } from "../../graph/ts/graph.ts"
import { versions as applied } from "./apply.ts"
import { commit } from "./commit.ts"
import { id as idOf, is } from "./id.ts"
import { seal, type Signer } from "./seal.ts"
import type { Device, Layer } from "./transport.ts"

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// the scheduler's internal versions, given its blop just taken in (its header, signer and name)
export type Versions = (
	node: string,
	object: Blop["object"],
	list: ReturnType<typeof applied>,
	from: {
		actor: unknown
		reader?: string
		site?: Blop["site"]
		cause?: unknown
		wallclock?: number
		message?: string
		signer: string
		name: string
	},
) => void

export type Wiring = {
	// the graph's `changed`: commits the record, takes its blop in at once, makes its object's
	// versions; sealing, storing and sending come after
	changed(record: Changed): void
	// resolves when no sealing, storing or sending is left; throws what one of them threw
	idle(): Promise<void>
}

export type Options = {
	versions: Versions
	signer: Signer
	random: (n: number) => Uint8Array
	// the source roots a site is made shareable against (COMMIT.tex)
	roots?: string[]
	// what a live value is written as a stand-in over (COMMIT.tex)
	kind?: (live: unknown) => unknown
}

// an id for a node made, from the lock "unlocked" (ID.tex): the scheduler's id option
export const fresh = (random: (n: number) => Uint8Array): string => idOf("unlocked", random(32))

export function createWiring(device: Device, options: Options): Wiring {
	const { versions, signer, random } = options
	const roots = options.roots ?? []
	// sealing, storing and sending, one at a time in the order made: a blop's parents are stored
	// before it
	let tail: Promise<unknown> = Promise.resolve()
	const trouble: unknown[] = []
	const later = (f: () => Promise<void>) => {
		tail = tail.then(f).catch((e) => void trouble.push(e))
	}
	// documents whose ephemeral layer is what their objects show: an ephemeral change was made or
	// heard there. Which layer an object shows is open (WIRING.tex scenarios)
	const shown = new Set<string>()

	// an object's versions made the histories', after the blop taken in
	function settle(doc: string, layer: Layer, blop: Blop, name: Uint8Array) {
		const list = applied(device.histories(doc, layer), blop.object, () => 0)
		const from: Parameters<Versions>[3] = {
			actor: blop.actor,
			signer: hex(blop.signer),
			name: hex(name),
		}
		if (blop.reader !== undefined) from.reader = blop.reader
		if (blop.site !== undefined) from.site = blop.site
		if (blop.cause !== undefined) from.cause = blop.cause
		if (blop.wallclock !== undefined) from.wallclock = blop.wallclock
		if (blop.message !== undefined) from.message = blop.message
		versions(doc, blop.object, list, from)
	}

	device.arrived((a) => {
		if (a.heard) shown.add(a.doc)
		const layer: Layer = shown.has(a.doc) ? "ephemeral" : "stored"
		if (a.layer !== layer) return
		try {
			settle(a.doc, layer, a.blop, a.name)
		} catch (e) {
			trouble.push(e)
		}
	})

	return {
		changed(record) {
			const doc = record.node
			// a node whose id is not a document's: none
			if (!is(doc)) return
			const layer: Layer = record.ephemeral ? "ephemeral" : "stored"
			if (record.ephemeral) shown.add(doc)
			try {
				const blop = commit(
					device.histories(doc, layer),
					{
						node: doc,
						object: record.object,
						patches: record.patches as Blop["patches"],
						header: record.header,
						signer: signer.key,
					},
					record.at,
					roots,
					random,
					options.kind,
				)
				const bytes = encode(blop)
				// taken in now, so that the next change commits against it
				device.take(doc, bytes, layer)
				// an ephemeral node is its process's own: what it shows is its process's, not the
				// histories' (a process's status is a version in front of its value, the record
				// the first version alone)
				if (!record.ephemeral) settle(doc, layer, blop, blopName(bytes))
				later(async () => {
					if (layer === "stored") await device.add(await seal(bytes, signer))
					else await device.publish(doc, bytes)
				})
			} catch (e) {
				trouble.push(e)
			}
		},
		async idle() {
			for (let t = tail;; t = tail) {
				await t
				if (t === tail) break
			}
			if (trouble.length) throw trouble.shift()
		},
	}
}
