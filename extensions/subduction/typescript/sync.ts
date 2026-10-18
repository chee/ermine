// the Subduction integration for the graph of today (extensions/subduction/plan.org). every entry
// change at a kept node goes out as one commit; what comes in is written to the table. kept: an
// ermine:// id, and only the tables given (value, attributes and children unless told).
//
// a node travels as one object, its tables combined, { value, attributes, children }: the blop's
// object "value" holds the whole node, and each commit's patches go under its table's name ("a
// node is its combined table values", core/table/plan.org). so a commit's parents are the node's
// heads, whatever table it changes: one history per node. blop, history, apply, seal and transport
// are as they were; wiring makes and sends the commits.
//
// the host hands sync what it wrote, beside places: wrote(entries) after places.commit, and
// tableChanged(part, id) from the table's one listener (an entry put or taken out whole). sync
// writes what comes in to the table itself (its table events reach places as any do) and sends
// none of it again.
//
// several heads: the first in the agreed order is what the tables show; the others are listed in
// the "conflicts" table at the id, with the tables in which they differ from it. a write extends
// the head shown, so the others stay until settled: settle(id) keeps the head shown and drops the
// rest, which stay in the history. merging them is a layer of its own
//
// copies at the edge: the history keeps what it took in and must never change. an entry changed in
// place (places makes children and attributes so) would change what its commits carry, so what
// goes out from one is copied; what comes in is copied before an entry holds it, as places may
// make that entry in place too
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import type { Id, Key, Table } from "@ermine/table"
import { versions as versionsOf } from "./apply.ts"
import type { At } from "./commit.ts"
import { id as lockId, is } from "./id.ts"
import type { Signer } from "./seal.ts"
import type { Device } from "./transport.ts"
import { createWiring, type Versions } from "./wiring.ts"

// a head that does not show: who made it, and the tables in which it differs from the one shown
export type Conflict = {
	head: string
	lamport: number
	signer: string
	actor: unknown
	tables: Record<string, unknown>
}

declare module "@ermine/table" {
	interface Tables {
		conflicts: Conflict[]
	}
}

export type Options = {
	table: Table
	device: Device
	signer: Signer
	// default: crypto.getRandomValues
	random?: (n: number) => Uint8Array
	// until Keyhive: ids minted with their last 16 bytes zero, which a Subduction server with no
	// Keyhive grant for a document (wss://galaxy.observer) stores. such an id binds no lock
	zeros?: boolean
	// the tables kept; default value, attributes and children
	tables?: readonly Key[]
	// the host's "a write landed" (places.commit): what comes in as the next commit on the head shown
	// is applied as its patches and told through it. none: every change that comes in replaces the
	// tables it touches whole
	commit?: (changed: readonly Entry<unknown>[]) => void
}

export type Sync = {
	// a new kept id
	mint(): string
	// what comes for this id is taken in (sync follows the ids it writes by itself)
	follow(id: string): Promise<void>
	// after places.commit: each change at a kept node's kept table, one commit
	wrote(changed: readonly Entry<unknown>[]): void
	// the table's event: an entry under (part, id) put or taken out whole
	tableChanged(part: Key, id: Id): void
	// the head shown kept, every other dropped (they stay in the history); change: who settled
	settle(id: string, change?: ChangeHeader): void
	// resolves when no sealing, storing or sending is left
	idle(): Promise<void>
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const random32 = (n: number) => crypto.getRandomValues(new Uint8Array(n))

// the same value, by structure: what came in is a new object each time
export function same(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor) {
			return false
		}
		const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
		const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
		return x.length === y.length && x.every((v, i) => v === y[i])
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false
	if (Array.isArray(a)) {
		const y = b as unknown[]
		return a.length === y.length && a.every((v, i) => same(v, y[i]))
	}
	const ka = Object.keys(a), kb = Object.keys(b)
	return ka.length === kb.length &&
		ka.every((k) => Object.hasOwn(b, k) && same((a as never)[k], (b as never)[k]))
}

// a patch to a table, as a patch to the node: its table's name first
const under = (part: Key, p: Patch): Patch => {
	const out = { ...p, path: [part, ...p.path] } as Patch
	if (p.move) out.move = { ...p.move, path: [part, ...p.move.path] } as Patch["move"]
	return out
}

export function createSync(options: Options): Sync {
	const { table, device, signer } = options
	const random = options.random ?? random32
	const tables = options.tables ?? ["value", "attributes", "children"]
	const followed = new Set<string>()
	// writing what came in: the table's events are sync's own, and go out as nothing
	let applying = false
	// making a commit here: its versions are what the table shows already
	let local = false
	// the head each node's tables show
	const heads = new Map<string, string>()

	function header(change: ChangeHeader | undefined): ChangeHeader {
		const h: ChangeHeader = change
			? { ...change }
			: { time: Math.floor(Date.now() / 1000), actor: null }
		// the time goes as the wallclock (a blop has no time of its own)
		if (!Object.hasOwn(h.metadata ?? {}, "wallclock")) {
			h.metadata = { ...h.metadata, wallclock: h.time }
		}
		delete h.op
		return h
	}

	// what the tables show, from a node's versions: the first; the rest listed as conflicts
	// what comes in as the next commit on the head shown: its patches, each table's, applied to that
	// table's entry (their values copied: the history keeps the commit), and told through the host's
	// commit. false: not that, or a patch replaces a table whole
	function step(doc: string, name: string, change: ChangeHeader): boolean {
		if (!options.commit) return false
		const blop = device.histories(doc).get(unhex(name))
		const prev = heads.get(doc)
		if (!blop || prev === undefined || blop.parents.length !== 1) return false
		if (hex(blop.base ?? blop.parents[0]) !== prev) return false
		const by = new Map<Key, Patch[]>()
		for (const p of blop.patches as Patch[]) {
			const part = p.path[0] as Key
			if (p.path.length < 2 || !tables.includes(part) || table.get(part, doc) === undefined) {
				return false
			}
			if (p.move && p.move.path[0] !== part) return false
			const q = { ...p, path: p.path.slice(1) } as Patch
			if (p.move) q.move = { ...p.move, path: p.move.path.slice(1) } as Patch["move"]
			by.set(part, [...by.get(part) ?? [], q])
		}
		const changed: Entry<unknown>[] = []
		for (const [part, patches] of by) {
			const entry = table.get(part, doc)!
			update(entry, structuredClone(patches) as never, change)
			changed.push(entry)
		}
		options.commit(changed)
		return true
	}

	const versions: Versions = (doc, _object, list, from) => {
		const shown = list[0]?.content as Record<string, unknown> | undefined
		const was = applying
		applying = true
		try {
			const head = list[0]?.because.place.name
			if (!local) {
				const time = list[0]?.change.metadata?.wallclock
				const change: ChangeHeader = {
					...list[0]?.change,
					time: typeof time === "number" ? time : Math.floor(Date.now() / 1000),
				} as ChangeHeader
				// the head shown moved on by one commit: its patches. else (a first, a head another
				// came in front of, one settled) each table whole, copied
				const stepped = head === from.name && step(doc, from.name, change)
				if (!stepped) {
					for (const part of tables) {
						const want = shown?.[part], have = table.get(part, doc)
						if (want === undefined) {
							if (have !== undefined) table.del(part, doc)
						} else if (have === undefined) {
							table.add(part, doc, createEntry(structuredClone(want) as never, change))
						} else if (!same(have.value, want)) {
							table.sub(part, doc, createEntry(structuredClone(want) as never, change))
						}
					}
				}
			}
			if (head === undefined) heads.delete(doc)
			else heads.set(doc, head)
			const others: Conflict[] = list.slice(1).map((v) => {
				const content = v.content as Record<string, unknown> | undefined
				const differ: Record<string, unknown> = {}
				for (const part of tables) {
					if (!same(content?.[part], shown?.[part])) differ[part as string] = content?.[part]
				}
				return {
					head: v.because.place.name,
					lamport: v.because.place.lamport,
					signer: v.because.why.signer,
					actor: v.change.actor,
					tables: differ,
				}
			})
			const have = table.get("conflicts", doc)
			if (others.length === 0) {
				if (have !== undefined) table.del("conflicts", doc)
			} else if (!have || !same(have.value, others)) {
				const entry = createEntry(others, header(list[0]?.change))
				if (have) table.sub("conflicts", doc, entry)
				else table.add("conflicts", doc, entry)
			}
		} finally {
			applying = was
		}
	}

	const wiring = createWiring(device, { versions, signer, random })

	function follow(id: string): Promise<void> {
		if (followed.has(id)) return Promise.resolve()
		followed.add(id)
		return device.follow(id)
	}

	// one commit at the node: its patches, made against the head shown (at 0), or at
	function send(id: string, patches: Patch[], change: ChangeHeader | undefined, at: At = 0) {
		follow(id).catch(() => {})
		// the node's first commit makes the object the tables sit in
		const first = device.histories(id).heads("value").length === 0
		const all = first ? [{ path: [], value: {} } as Patch, ...patches] : patches
		local = true
		try {
			wiring.changed({
				node: id,
				object: "value",
				patches: all,
				header: header(change),
				at,
				ephemeral: false,
			})
		} finally {
			local = false
		}
	}

	const kept = (part: Key, id: Id): id is string =>
		typeof id === "string" && is(id) && tables.includes(part)

	return {
		mint() {
			if (!options.zeros) return lockId("unlocked", random(32))
			const out = new Uint8Array(32)
			out.set(random(16))
			return "ermine://" + hex(out)
		},
		follow,
		wrote(changed) {
			if (applying) return
			for (const entry of changed) {
				const op = entry.change.op
				if (op === undefined) continue
				for (const [part, id] of table.who(entry)) {
					if (!kept(part, id)) continue
					const patches = op.patches.map((p) => under(part, p))
					send(id, entry.cow === false ? structuredClone(patches) : patches, entry.change)
				}
			}
		},
		tableChanged(part, id) {
			if (applying || !kept(part, id)) return
			const entry = table.get(part, id)
			const value = entry?.cow === false ? structuredClone(entry.value) : entry?.value
			const patch: Patch = value === undefined
				? { path: [part] }
				: { path: [part], value } as Patch
			send(id, [patch], entry?.change)
		},
		settle(id, change) {
			const n = versionsOf(device.histories(id), "value", () => 0).length
			if (n < 2) return
			send(id, [], change, { pop: [1, n] })
		},
		async idle() {
			await wiring.idle()
			await device.idle()
		},
	}
}
