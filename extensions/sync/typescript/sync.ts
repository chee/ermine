// the Subduction integration for the graph of today (extensions/subduction/plan.org, Rewrite for
// the new shape, 8). every entry change at a kept node goes out as one commit naming its table;
// what comes in is written to the table. kept: an ermine:// id, and only the tables given (value,
// attributes and children unless told).
//
// the table is the head shown: its entries are that head's node, and nothing is kept beside them.
// a commit is encoded from the change at once and kept as its bytes (the history's); what comes in
// is decoded from bytes, new objects. so nothing is shared, and nothing is copied: a change costs its
// patches, whatever the size of what it changes.
//
// coming in, a commit on the head shown is applied to its table's entry by update, which is its
// check too: patches that don't apply change nothing, and the commit is refused. any other commit
// (a fork, a merge) is checked on a replay of its parent's node (replay.ts), and the table is told
// only if the head shown changes: then it holds the replay of the new head, whole.
//
// several heads: the first in the agreed order shows; the others are listed in the "conflicts"
// table at the id, with the tables in which they differ. a write extends the head shown, so the
// others stay until settled: settle(id) makes a merge keeping the head shown. merging what they hold
// is a layer of its own
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, compare, decode, encode, name as nameOf } from "@ermine/encoding/commit"
import type { Id, Key, Table } from "@ermine/table"
import type * as sd from "npm:@automerge/subduction@0.23.0"
import { hex } from "./hex.ts"
import type { Kept } from "./history.ts"
import { changeOf, replay, type Tables } from "./replay.ts"
import { snapshot } from "./snapshot.ts"
import type { Signer } from "./seal.ts"
import { createDevice, type Device, type Lock } from "./transport.ts"

// a head that does not show: who made it, and the tables in which it differs from the one shown
export type Conflict = {
	head: string
	lamport: number
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
	signer: Signer
	// the device's (transport.ts): where Subduction keeps what it saves, the lock
	storage?: sd.SedimentreeStorage
	lock?: Lock
	// default: crypto.getRandomValues
	random?: (n: number) => Uint8Array
	// until Keyhive: ids minted with their last 16 bytes zero, which a Subduction server with no
	// Keyhive grant for a document (wss://galaxy.observer) stores. such an id binds no lock
	zeros?: boolean
	// the tables kept; default value, attributes and children
	tables?: readonly Key[]
	// the host's "a write landed" (places.commit): what comes in on the head shown is told through
	// it, as its patches. none: such changes reach places only as table events, whole
	commit?: (changed: readonly Entry<unknown>[]) => void
}

export type Sync = {
	device: Device
	// a new kept id
	mint(): string
	// what comes for this id is taken in (sync follows the ids it writes by itself)
	follow(id: string): Promise<void>
	// after places.commit: each change at a kept node's kept table, one commit
	wrote(changed: readonly Entry<unknown>[]): void
	// the table's event: an entry under (part, id) put or taken out whole
	tableChanged(part: Key, id: Id): void
	// a merge of every head, keeping the head shown; change: who settled
	settle(id: string, change?: ChangeHeader): void
	// the node's tables at a commit: a version
	at(id: string, name: Uint8Array): Tables | undefined
	// resolves when nothing is left to take in, seal, store or send
	idle(): Promise<void>
}

const random32 = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const ID = /^ermine:\/\/[0-9a-f]{64}$/

// the same value, by structure (conflicts only: comparing two versions of a table)
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

// what of a change header a commit can carry: metadata pairs that encode
function carried(
	change: ChangeHeader | undefined,
): Pick<Commit, "time" | "actor" | "reader" | "external" | "metadata"> {
	const out: Pick<Commit, "time" | "actor" | "reader" | "external" | "metadata"> = {
		time: change?.time ?? Math.floor(Date.now() / 1000),
		actor: change?.actor ?? null,
	}
	const ok = (v: unknown) => {
		try {
			cbor.encode(v as cbor.Value)
			return true
		} catch {
			return false
		}
	}
	if (!ok(out.actor)) out.actor = null
	if (change?.reader !== undefined) out.reader = change.reader
	if (change?.external?.length) out.external = change.external.map((s) => ({ ...s }))
	const metadata = change?.metadata?.filter(([k, v]) => typeof k === "string" && ok(v))
	if (metadata?.length) out.metadata = metadata
	return out
}

export function createSync(options: Options): Sync {
	const { table, signer } = options
	const random = options.random ?? random32
	// this device's count of commits, from a random start: two devices with one key don't count alike
	let nonce = new DataView(random(4).buffer).getUint32(0)
	const tables = options.tables ?? ["value", "attributes", "children"]
	const followed = new Set<string>()
	// the head each node's tables show
	const shown = new Map<string, Kept>()
	// commits applied to the table in their check, by name: they are the head shown once taken
	const stepped = new Set<string>()
	// each node's heads that don't show, each one's tables: sync's own, from replays and commits
	// decoded, never shared; a commit on one moves it on in place
	const others = new Map<string, Map<string, Tables>>()
	// nodes whose conflicts are to be worked out again: once a batch, not once a commit
	const dirty = new Set<string>()
	// a snapshot is made when the commits between the last one's head and this one's add up to
	// about the node's size, so making them costs about what writing the commits did, and a replay
	// walks back at most about a node's worth. each commit's place: the bytes of the node's commits
	// taken before it and it, by name (fragments are built after, in a batch, so counting as they
	// are made would not do); the last snapshot's place and size
	const placed = new Map<string, Map<string, number>>()
	const total = new Map<string, number>()
	const last = new Map<string, { at: number; size: number }>()
	// writing what came in: the table's events are sync's own, and go out as nothing
	let applying = false

	const device: Device = createDevice({
		signer,
		storage: options.storage,
		lock: options.lock,
		check,
		snapshotOf,
	})
	device.arrived((a) => {
		if (a.layer !== "stored") return
		applying = true
		try {
			arrive(a.doc, a.kept)
		} finally {
			applying = false
		}
	})

	function grew(doc: string, name: Uint8Array, bytes: number) {
		const at = (total.get(doc) ?? 0) + bytes
		total.set(doc, at)
		let m = placed.get(doc)
		if (!m) placed.set(doc, m = new Map())
		m.set(hex(name), at)
	}
	const othersOf = (doc: string) => {
		let m = others.get(doc)
		if (!m) others.set(doc, m = new Map())
		return m
	}

	// the kept tables as the table holds them, each change as a commit carries it (so a snapshot
	// reads as a replay would): the head shown's node
	function fromTable(doc: string): Tables {
		const out: Tables = {}
		for (const part of tables) {
			const e = table.get(part, doc)
			if (e !== undefined && e.value !== undefined) {
				out[part as string] = { value: e.value, change: carried(e.change) as ChangeHeader }
			}
		}
		return out
	}

	const replayed = (doc: string, name: Uint8Array) =>
		replay(device.history(doc), name, (n) => device.snapshot(doc, n)) ?? {}

	// the tables at a fragment's head, packed, when the commits since the last snapshot are worth
	// one; packed now, so nothing it reads is held
	function snapshotOf(doc: string, head: Kept): Uint8Array | undefined {
		const at = placed.get(doc)?.get(hex(head.name)) ?? total.get(doc) ?? 0
		const before = last.get(doc)
		if (before !== undefined && Math.abs(at - before.at) < before.size) return undefined
		const node = shown.get(doc) === head
			? fromTable(doc)
			: others.get(doc)?.get(hex(head.name)) ?? replayed(doc, head.name)
		const bytes = snapshot(node)
		last.set(doc, { at, size: bytes.length })
		return bytes
	}

	// does a commit from elsewhere apply to its parent's node: on the head shown, applied to the table
	// as it is checked; on a head that doesn't show, applied to that head's own tables; else on a
	// replay, kept as the new head's
	function check(doc: string, kept: Kept, commit: Commit, layer: "stored" | "ephemeral"): boolean {
		// the ephemeral history also holds every stored commit, checked already; what is only
		// ephemeral shows nowhere yet (overlays are to come), so nothing to check it against
		if (layer !== "stored") return true
		grew(doc, kept.name, kept.bytes.length)
		const head = shown.get(doc)
		const single = commit.parents.length === 1 ? hex(commit.parents[0]) : undefined
		const on = commit.parents.length === 0
			? head === undefined
			: head !== undefined && single === hex(head.name)
		if (on && tables.includes(commit.table as Key)) return step(doc, kept, commit)
		// a head that doesn't show, moved on in place: what it held goes with it
		const mine = othersOf(doc)
		const node = single !== undefined && mine.get(single) ||
			(kept.base === undefined ? {} : replayed(doc, kept.base))
		try {
			const value = apply(node[commit.table]?.value, commit.patches as Patch[], { cow: false })
			if (value === undefined) delete node[commit.table]
			else node[commit.table] = { value, change: changeOf(commit) }
		} catch {
			return false
		}
		if (single !== undefined) mine.delete(single)
		mine.set(hex(kept.name), node)
		return true
	}

	// a commit on the head shown, applied to its table's entry: update is its check
	function step(doc: string, kept: Kept, commit: Commit): boolean {
		const part = commit.table as Key
		const change = changeOf(commit)
		const was = applying
		applying = true
		try {
			const entry = table.get(part, doc)
			if (entry === undefined) {
				const value = apply(undefined, commit.patches as Patch[])
				if (value !== undefined) table.add(part, doc, createEntry(value as never, change))
			} else {
				update(entry, commit.patches as never, change)
				if (entry.value === undefined) table.del(part, doc)
				else options.commit?.([entry])
			}
		} catch {
			return false
		} finally {
			applying = was
		}
		stepped.add(hex(kept.name))
		return true
	}

	// a commit taken in from elsewhere: the head shown moves on, or another comes in front of it
	function arrive(doc: string, kept: Kept) {
		const name = hex(kept.name)
		if (stepped.delete(name)) shown.set(doc, kept)
		const heads = device.history(doc).heads()
		const first = heads[0], mine = othersOf(doc)
		if (first !== undefined && shown.get(doc) !== first) {
			// the tables become the first head's own tables (or its replay), whole; the head that
			// showed becomes one that doesn't, replayed
			const was = shown.get(doc)
			const node = mine.get(hex(first.name)) ?? replayed(doc, first.name)
			mine.delete(hex(first.name))
			for (const part of tables) {
				const want = node[part as string], have = table.get(part, doc)
				if (want === undefined) {
					if (have !== undefined) table.del(part, doc)
				} else if (have === undefined) {
					table.add(part, doc, createEntry(want.value as never, want.change))
				} else table.sub(part, doc, createEntry(want.value as never, want.change))
			}
			shown.set(doc, first)
			if (was !== undefined && heads.includes(was)) {
				mine.set(hex(was.name), replayed(doc, was.name))
			}
		}
		// only heads keep tables of their own
		const now = new Set(heads.map((k) => hex(k.name)))
		for (const n of mine.keys()) if (!now.has(n)) mine.delete(n)
		later(doc)
	}

	// the conflicts worked out again, once the commits coming in now are all in
	function later(doc: string) {
		if (dirty.size === 0) queueMicrotask(flush)
		dirty.add(doc)
	}
	function flush() {
		const docs = [...dirty]
		dirty.clear()
		const was = applying
		applying = true
		try {
			for (const doc of docs) conflicts(doc)
		} finally {
			applying = was
		}
	}

	function conflicts(doc: string) {
		const heads = device.history(doc).heads(), mine = othersOf(doc)
		const list: Conflict[] = heads.slice(1).map((k) => {
			let node = mine.get(hex(k.name))
			if (node === undefined) mine.set(hex(k.name), node = replayed(doc, k.name))
			const differ: Record<string, unknown> = {}
			for (const part of tables) {
				const theirs = node[part as string]?.value
				if (!same(theirs, table.get(part, doc)?.value)) differ[part as string] = theirs
			}
			return {
				head: hex(k.name),
				lamport: k.lamport,
				actor: decode(k.bytes).actor,
				tables: differ,
			}
		})
		const have = table.get("conflicts", doc)
		if (list.length === 0) {
			if (have !== undefined) table.del("conflicts", doc)
			return
		}
		const entry = createEntry(list, { time: Math.floor(Date.now() / 1000), actor: null })
		if (have) table.sub("conflicts", doc, entry)
		else table.add("conflicts", doc, entry)
	}

	function follow(id: string): Promise<void> {
		if (followed.has(id)) return Promise.resolve()
		followed.add(id)
		return device.follow(id)
	}

	// one commit at the node, on the head shown: encoded now, so nothing it carries is held after
	function send(
		id: string,
		part: Key,
		patches: readonly Patch[],
		change: ChangeHeader | undefined,
		merge = false,
	) {
		follow(id).catch(() => {})
		const history = device.history(id)
		const head = shown.get(id) ?? history.heads()[0]
		const heads = merge ? history.heads() : head ? [head] : []
		const commit: Commit = {
			table: part as string,
			...carried(change),
			signer: signer.key,
			nonce: nonce++,
			parents: heads.map((k) => k.name).sort(compare),
			lamport: 1 + Math.max(0, ...heads.map((k) => k.lamport)),
			patches: patches as Commit["patches"],
		}
		if (heads.length > 1) commit.base = head!.name
		const bytes = encode(commit), name = nameOf(bytes)
		grew(id, name, bytes.length)
		const added = device.take(id, bytes, "stored", { commit, name })
		if (added === "taken") {
			shown.set(id, history.get(name)!)
			if (merge) {
				const mine = othersOf(id)
				for (const k of heads) mine.delete(hex(k.name))
				later(id)
			}
		}
	}

	const kept = (part: Key, id: Id): id is string =>
		typeof id === "string" && ID.test(id) && tables.includes(part)

	return {
		device,
		mint() {
			const out = random(32)
			if (options.zeros) out.fill(0, 16)
			return "ermine://" + hex(out)
		},
		follow,
		wrote(changed) {
			if (applying) return
			for (const entry of changed) {
				const op = entry.change.op
				if (op === undefined) continue
				for (const [part, id] of table.who(entry)) {
					if (kept(part, id)) send(id, part, op.patches, entry.change)
				}
			}
		},
		tableChanged(part, id) {
			if (applying || !kept(part, id)) return
			const entry = table.get(part, id)
			const patch: Patch = entry?.value === undefined
				? { path: [] }
				: { path: [], value: entry.value }
			send(id, part, [patch], entry?.change)
		},
		settle(id, change) {
			if (device.history(id).heads().length < 2) return
			send(id, "value", [], change, true)
		},
		at: (id, name) => replay(device.history(id), name, (n) => device.snapshot(id, n)),
		idle: async () => {
			await device.idle()
			if (dirty.size) flush()
		},
	}
}
