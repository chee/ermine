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
// others stay until settled: settle(id) makes a merge keeping the head shown.
//
// given a merge rule (merge, one of merges): several heads show merged by it, once the commits
// coming in now are all in, written to the table as a head switch is; no conflicts are listed. a
// write then is a merge commit: every head it showed its parents, the rule named, its patches
// against the merge (what the table shows). nothing merges by itself: only a write, or settle,
// makes a merge commit. a merge commit coming in is checked on its rule's merge of its parents
// (on the table, when that is what it shows); one by a rule not in merges is refused ("merge").
// use(rule) switches the rule, or merging off, while running
//
// ephemeral (plan.org, Ephemeral): a change to a table the host says is ephemeral goes out as an
// ephemeral commit: on the device's previous one at the node while that stands, else on what a
// stored write would be on; never sealed, never stored. what shows: the stored heads, and on top,
// for each table a device's standing ephemeral commits touched, the later device's (lamport, then
// name; with a rule, the stored heads and every standing one merged by it). the table holds what
// shows; the stored tables under an overlaid one are sync's own (under). a device's ephemeral
// commits stop standing when a stored commit of its follows them (its lamport above what they went
// on), or when nothing is heard from it for ttl ms; while one of this device's stands it is sent
// again every beat ms. a write to a table that does not show what the commit goes on carries its
// whole value. nothing ephemeral outlives the sync
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, compare, decode, encode, name as nameOf } from "@ermine/encoding/commit"
import type { Id, Key, Table } from "@ermine/table"
import type * as sd from "npm:@automerge/subduction@0.23.0"
import { hex } from "./hex.ts"
import { agreed, type Kept, type Refusal } from "./history.ts"
import { changeOf, type Merges, plain, replay, type Tables } from "./replay.ts"
import { snapshot, tablesOf } from "./snapshot.ts"
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
	// the merge rules this device knows, by name (egwalker.ts): a merge commit by one is checked and
	// taken, by any other refused. default none
	merges?: Merges
	// the rule every kept node here merges by, one of merges. none: the first head shows, writes
	// extend it, the others are conflicts
	merge?: string
	// the host's "a write landed" (places.commit): what comes in on the head shown is told through
	// it, as its patches. none: such changes reach places only as table events, whole
	commit?: (changed: readonly Entry<unknown>[]) => void
	// whether a change to (a kept id, a kept table) goes out as an ephemeral commit; asked at each
	// write. default never
	ephemeral?: (doc: string, table: Key) => boolean
	// the time now, ms since 1970. given: sync sets no timers, the host calls tick when it says.
	// default Date.now, ticked here
	now?: () => number
	// ms between sending a standing ephemeral commit of this device's again; default 1000
	beat?: number
	// ms with nothing heard from a device before its ephemeral commits stop standing; default 4000
	ttl?: number
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
	// a merge of every head, keeping what shows (with a rule, the merge); change: who settled
	settle(id: string, change?: ChangeHeader): void
	// the node's tables at a commit: a version
	get(id: string, name: Uint8Array): Tables | undefined
	// the rule kept nodes merge by from now (one of merges), or none: every node with several heads
	// shows again as the rule says (merged, or the first head and its conflicts)
	use(merge: string | undefined): void
	// resolves when nothing is left to take in, seal, store or send
	idle(): Promise<void>
	// the beats due sent, the devices quiet past ttl dropped: the ms until it is due again, or
	// undefined for none
	tick(): number | undefined
	// each device whose ephemeral commits stand at the id (this one's too): its key (hex) and its
	// newest one's name, by key
	standing(id: string): [string, Uint8Array][]
	// the timers stopped, the device closed
	close(): Promise<void>
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
	const merges = options.merges ?? {}
	let rule = options.merge
	if (rule !== undefined && merges[rule] === undefined) throw new Error(`no merge rule ${rule}`)
	// with a rule: the heads whose merge the table shows, when it shows one (else shown's)
	const merged = new Map<string, Kept[]>()
	// with a rule, what a node showed, packed then, the last few a node: the tables at a merge
	// commit that was its one head, and the merge of heads shown (unless the rule keeps its work),
	// by their names (sorted, spaced). where a later merge starts from, and a replay through them,
	// without merging again
	const states = new Map<string, Map<string, Uint8Array>>()
	const STATES = 16
	const keyOf = (names: readonly Uint8Array[]) => names.map(hex).sort().join(" ")
	function keep(doc: string, key: string, node: Tables) {
		let m = states.get(doc)
		if (!m) states.set(doc, m = new Map())
		m.delete(key)
		m.set(key, snapshot(node))
		if (m.size > STATES) m.delete(m.keys().next().value!)
	}
	const stateOf = (doc: string, key: string) => {
		const b = states.get(doc)?.get(key)
		return b === undefined ? undefined : tablesOf(b)
	}
	// a merge commit the one head, shown: its tables kept
	function remember(doc: string) {
		const heads = device.history(doc).heads()
		if (heads.length !== 1 || heads[0].merge === undefined || shown.get(doc) !== heads[0]) return
		keep(doc, keyOf([heads[0].name]), fromTable(doc))
	}
	// a node's tables at a commit when kept: a fragment's snapshot, or a state kept here
	const snapshots = (doc: string) => (n: Uint8Array) =>
		device.snapshot(doc, n) ?? stateOf(doc, keyOf([n]))
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

	// ---- ephemeral state
	const me = hex(signer.key)
	const ephemeral = options.ephemeral ?? (() => false)
	const clock = options.now ?? Date.now
	const beat = options.beat ?? 1000, ttl = options.ttl ?? 4000
	// a device's standing ephemeral commits at a node: the newest (tip), the highest lamport of the
	// stored commits they went on (base), the tables they touched, the tables at the tip (sync's
	// own), when it was last heard from (this device's: last sent)
	type Chain = { tip: Kept; base: number; tables: Set<string>; node: Tables; at: number }
	// a node with any: the chains by signer (hex); what each overlaid table shows (a tip's name,
	// or "merge" and the names merged); the stored entries under the overlaid tables
	type Overlay = { chains: Map<string, Chain>; over: Map<string, string>; under: Tables }
	const overlays = new Map<string, Overlay>()
	// the highest lamport of a stored commit from each signer at a node: an ephemeral commit that
	// went on less is followed already
	const latest = new Map<string, Map<string, number>>()
	// an ephemeral commit's tables, made in its check, by name, until it arrives
	const fresh = new Map<string, Tables>()
	let timer: ReturnType<typeof setTimeout> | undefined
	const overlayOf = (doc: string) => {
		let o = overlays.get(doc)
		if (!o) overlays.set(doc, o = { chains: new Map(), over: new Map(), under: {} })
		return o
	}
	// the stored entry at (part, doc): under the overlay, or the table's
	const storedEntry = (doc: string, part: Key) => {
		const o = overlays.get(doc)
		return o?.over.has(part as string) ? o.under[part as string] : table.get(part, doc)
	}

	const device: Device = createDevice({
		signer,
		storage: options.storage,
		lock: options.lock,
		check,
		snapshotOf,
	})
	device.arrived((a) => {
		const only = a.layer === "ephemeral" && device.history(a.doc).get(a.kept.name) === undefined
		if (a.layer !== "stored" && !(a.heard && only)) return
		applying = true
		try {
			if (a.layer === "stored") arrive(a.doc, a.kept), ended(a.doc, a.kept)
			else heard(a.doc, a.kept)
		} finally {
			applying = false
		}
	})
	device.heard((doc, from) => {
		const c = overlays.get(doc)?.chains.get(from)
		if (c !== undefined && from !== me) c.at = clock()
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
			const e = storedEntry(doc, part)
			if (e !== undefined && e.value !== undefined) {
				out[part as string] = { value: e.value, change: carried(e.change) as ChangeHeader }
			}
		}
		return out
	}

	// with a rule that can keep its work between merges (Merge's keeping: egwalker's, walker.ts),
	// each node's rules: that one its own, kept while the rule is in use
	const keeping = new Map<string, Merges>()
	function rulesOf(doc: string): Merges {
		if (rule === undefined || merges[rule].keeping === undefined) return merges
		let mine = keeping.get(doc)
		if (mine === undefined) {
			keeping.set(doc, mine = { ...merges, [rule]: merges[rule].keeping!() })
		}
		return mine
	}
	const replayed = (doc: string, name: Uint8Array) =>
		replay(device.history(doc), name, snapshots(doc), rulesOf(doc)) ?? {}
	// heads merged by a rule: new tables
	function mergeOf(doc: string, heads: readonly Kept[], by: string): Tables {
		const history = device.history(doc)
		const merge = rulesOf(doc)[by]
		return merge(
			history,
			heads,
			(ns) =>
				ns.length === 1
					? plain(history, ns[0], snapshots(doc))
					: by === rule
					? stateOf(doc, keyOf(ns))
					: undefined,
		)
	}
	const sameHeads = (a: readonly Kept[], b: readonly Uint8Array[]) =>
		a.length === b.length && a.every((k) => b.some((n) => compare(k.name, n) === 0))

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
	// replay, kept as the new head's. a merge: on the table when it shows that merge, else on the
	// merge made now
	function check(
		doc: string,
		kept: Kept,
		commit: Commit,
		layer: "stored" | "ephemeral",
	): boolean | Refusal {
		if (commit.merge !== undefined && merges[commit.merge] === undefined) return "merge"
		// the ephemeral history also holds every stored commit, checked already; what is only
		// ephemeral is checked on the tables it goes on
		if (layer !== "stored") {
			return device.history(doc).get(kept.name) !== undefined || fleeting(doc, kept, commit)
		}
		grew(doc, kept.name, kept.bytes.length)
		if (commit.merge !== undefined) {
			const on = merged.get(doc)
			if (
				on !== undefined && commit.merge === rule && sameHeads(on, commit.parents) &&
				tables.includes(commit.table as Key)
			) return step(doc, kept, commit)
			const history = device.history(doc)
			const node = mergeOf(doc, commit.parents.map((p) => history.get(p)!), commit.merge)
			try {
				const value = apply(node[commit.table]?.value, commit.patches as Patch[], {
					cow: false,
				})
				if (value === undefined) delete node[commit.table]
				else node[commit.table] = { value, change: changeOf(commit) }
			} catch {
				return false
			}
			othersOf(doc).set(hex(kept.name), node)
			return true
		}
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
		// overlaid: the stored entry is sync's own, under it
		const o = overlays.get(doc)
		if (o?.over.has(commit.table)) {
			try {
				const value = apply(o.under[commit.table]?.value, commit.patches as Patch[], {
					cow: false,
				})
				if (value === undefined) delete o.under[commit.table]
				else o.under[commit.table] = { value, change }
			} catch {
				return false
			}
			stepped.add(hex(kept.name))
			return true
		}
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

	// the table holds these tables, whole
	function become(doc: string, node: Tables) {
		const o = overlays.get(doc)
		for (const part of tables) {
			const want = node[part as string]
			if (o?.over.has(part as string)) {
				if (want === undefined) delete o.under[part as string]
				else o.under[part as string] = want
				continue
			}
			const have = table.get(part, doc)
			if (want === undefined) {
				if (have !== undefined) table.del(part, doc)
			} else if (have === undefined) {
				table.add(part, doc, createEntry(want.value as never, want.change))
			} else table.sub(part, doc, createEntry(want.value as never, want.change))
		}
	}

	// a commit taken in from elsewhere: the head shown moves on, or another comes in front of it.
	// with a rule and several heads, their merge shows once the commits coming in now are all in
	function arrive(doc: string, kept: Kept) {
		const name = hex(kept.name)
		if (stepped.delete(name)) shown.set(doc, kept), merged.delete(doc)
		const heads = device.history(doc).heads()
		const first = heads[0], mine = othersOf(doc)
		const merging = rule !== undefined && heads.length > 1
		if (!merging && first !== undefined && shown.get(doc) !== first) {
			// the tables become the first head's own tables (or its replay), whole; the head that
			// showed becomes one that doesn't, replayed
			const was = shown.get(doc)
			const node = mine.get(hex(first.name)) ?? replayed(doc, first.name)
			mine.delete(hex(first.name))
			become(doc, node)
			shown.set(doc, first)
			merged.delete(doc)
			if (was !== undefined && heads.includes(was)) {
				mine.set(hex(was.name), replayed(doc, was.name))
			}
		}
		// only heads keep tables of their own
		const now = new Set(heads.map((k) => hex(k.name)))
		for (const n of mine.keys()) if (!now.has(n)) mine.delete(n)
		if (rule !== undefined) remember(doc)
		later(doc)
	}

	// several heads, by the rule: the table shows their merge, unless it does already
	function showMerge(doc: string) {
		const heads = device.history(doc).heads()
		const on = merged.get(doc)
		if (on !== undefined && sameHeads(on, heads.map((k) => k.name))) return
		const node = mergeOf(doc, heads, rule!)
		// a rule keeping its work starts the next merge where this one ended: not packed again
		if (merges[rule!].keeping === undefined) keep(doc, keyOf(heads.map((k) => k.name)), node)
		become(doc, node)
		shown.delete(doc)
		merged.set(doc, heads)
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
			for (const doc of docs) {
				if (rule !== undefined && device.history(doc).heads().length > 1) showMerge(doc)
				conflicts(doc)
			}
		} finally {
			applying = was
		}
	}

	// with a rule, none: what shows is every head
	function conflicts(doc: string) {
		const heads = device.history(doc).heads(), mine = othersOf(doc)
		const list: Conflict[] = (rule === undefined ? heads.slice(1) : []).map((k) => {
			let node = mine.get(hex(k.name))
			if (node === undefined) mine.set(hex(k.name), node = replayed(doc, k.name))
			const differ: Record<string, unknown> = {}
			for (const part of tables) {
				const theirs = node[part as string]?.value
				if (!same(theirs, storedEntry(doc, part)?.value)) differ[part as string] = theirs
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

	// one commit at the node, on what shows: the head shown, or with a rule, the heads merged.
	// all: on every head, keeping the head shown. encoded now, so nothing it carries is held after
	function send(
		id: string,
		part: Key,
		patches: readonly Patch[],
		change: ChangeHeader | undefined,
		all = false,
	) {
		follow(id).catch(() => {})
		const history = device.history(id)
		const on = merged.get(id)
		const head = shown.get(id) ?? history.heads()[0]
		const heads = on ?? (all ? history.heads() : head ? [head] : [])
		// the table shows something else than the stored: the patches tried on the stored, the
		// whole value if they don't apply
		const o = overlays.get(id)
		let stored: unknown
		if (!all && o?.over.has(part as string)) {
			;[patches, stored] = tried(o.under[part as string]?.value, patches, table.get(part, id))
		}
		const commit: Commit = {
			table: part as string,
			...carried(change),
			signer: signer.key,
			nonce: nonce++,
			parents: heads.map((k) => k.name).sort(compare),
			lamport: 1 + Math.max(0, ...heads.map((k) => k.lamport)),
			patches: patches as Commit["patches"],
		}
		if (on !== undefined) commit.merge = rule
		else if (heads.length > 1) commit.base = head!.name
		const bytes = encode(commit), name = nameOf(bytes)
		grew(id, name, bytes.length)
		const added = device.take(id, bytes, "stored", { commit, name })
		if (added === "taken") {
			shown.set(id, history.get(name)!)
			merged.delete(id)
			if (heads.length > 1) {
				const mine = othersOf(id)
				for (const k of heads) mine.delete(hex(k.name))
				if (rule !== undefined) remember(id)
				later(id)
			}
			if (o !== undefined) landed(id, part, all, stored, commit)
		}
		return added === "taken" ? commit : undefined
	}

	const whole = (e: Entry<unknown> | undefined): Patch =>
		e?.value === undefined ? { path: [] } : { path: [], value: e.value }

	// a stored commit of this device's at an overlaid node: what the table shows of its table is
	// stored now, and this device's ephemeral commits there are followed
	function landed(id: string, part: Key, all: boolean, stored: unknown, commit: Commit) {
		const o = overlays.get(id)!, t = part as string
		if (!all && o.over.has(t)) {
			if (stored === undefined) delete o.under[t]
			else o.under[t] = copied({ value: stored, change: changeOf(commit) })
			// shown again, whatever it showed
			o.over.set(t, "")
		}
		o.chains.delete(me)
		show(id)
	}

	// patches made on what the table shows, for a commit on something else (on): as they are, and
	// what they make of on, when they apply to it; else the table's whole value, and it
	function tried(
		on: unknown,
		patches: readonly Patch[],
		now: Entry<unknown> | undefined,
	): [readonly Patch[], unknown] {
		try {
			return [patches, apply(on, patches as Patch[])]
		} catch {
			return [[whole(now)], now?.value]
		}
	}

	// ---- ephemeral

	// a copy of an entry, sync's own: its value new, its change as a commit carries it
	const copied = (e: Entry<unknown>): Entry<unknown> =>
		tablesOf(snapshot({ e: { value: e.value, change: carried(e.change) as ChangeHeader } })).e

	// the later of two devices' tips: higher lamport, then the greater name
	const after = (a: Kept, b: Kept) =>
		a.lamport !== b.lamport ? a.lamport > b.lamport : compare(a.name, b.name) > 0

	// whether to is from or one of its ancestors
	function reaches(doc: string, from: Kept, to: Kept): boolean {
		const h = device.history(doc, "ephemeral")
		const todo = [from], seen = new Set<string>()
		while (todo.length) {
			const k = todo.pop()!
			if (compare(k.name, to.name) === 0) return true
			const n = hex(k.name)
			if (k.lamport <= to.lamport || seen.has(n)) continue
			seen.add(n)
			for (const p of k.parents) {
				const q = h.get(p)
				if (q !== undefined) todo.push(q)
			}
		}
		return false
	}

	// an ephemeral commit's chain, walked back to the stored commits it went on: their highest
	// lamport (0 for none), and the tables its ephemeral commits touched
	function rootOf(doc: string, kept: Kept): { base: number; tables: Set<string> } {
		const eph = device.history(doc, "ephemeral"), stored = device.history(doc)
		let base = 0
		const touched = new Set<string>(), seen = new Set<string>(), todo = [kept]
		while (todo.length) {
			const k = todo.pop()!, n = hex(k.name)
			if (seen.has(n)) continue
			seen.add(n)
			if (stored.get(k.name) !== undefined) {
				base = Math.max(base, k.lamport)
				continue
			}
			touched.add(k.table)
			for (const p of k.parents) {
				const q = eph.get(p)
				if (q !== undefined) todo.push(q)
			}
		}
		return { base, tables: touched }
	}

	// the tables at an ephemeral commit's parents, new: its device's tip's own when it goes on that,
	// else from the ephemeral history (which holds the stored commits too)
	function startOf(doc: string, kept: Kept, commit: Commit): Tables {
		const eph = device.history(doc, "ephemeral")
		if (commit.merge !== undefined) {
			return merges[commit.merge](
				eph,
				commit.parents.map((p) => eph.get(p)!),
				(ns) => ns.length === 1 ? plain(eph, ns[0], snapshots(doc)) : undefined,
			)
		}
		if (kept.base === undefined) return {}
		return replay(eph, kept.base, snapshots(doc), merges) ?? {}
	}

	// an ephemeral commit from elsewhere: does it apply to the tables it goes on. they are kept for
	// its arrival
	function fleeting(doc: string, kept: Kept, commit: Commit): boolean {
		// signed with this device's key elsewhere: never stands here
		if (hex(commit.signer) === me) return true
		const chain = overlays.get(doc)?.chains.get(hex(commit.signer))
		const on = chain !== undefined && commit.merge === undefined && commit.parents.length === 1 &&
			compare(commit.parents[0], chain.tip.name) === 0
		const node = on ? chain.node : startOf(doc, kept, commit)
		try {
			const value = apply(node[commit.table]?.value, commit.patches as Patch[], { cow: false })
			if (value === undefined) delete node[commit.table]
			else node[commit.table] = { value, change: changeOf(commit) }
		} catch {
			return false
		}
		fresh.set(hex(kept.name), node)
		return true
	}

	// an ephemeral commit from elsewhere, taken in: its device's tip now, unless a stored commit of
	// its follows it already. on the tip shown, its patches go to the table's entry
	function heard(doc: string, kept: Kept) {
		const node = fresh.get(hex(kept.name))
		fresh.delete(hex(kept.name))
		const commit = decode(kept.bytes), who = hex(commit.signer)
		if (who === me || node === undefined) return
		const o = overlayOf(doc), was = o.chains.get(who)
		const on = was !== undefined && kept.parents.length === 1 &&
			compare(kept.parents[0], was.tip.name) === 0
		const { base, tables: touched } = on ? was : rootOf(doc, kept)
		if ((latest.get(doc)?.get(who) ?? -1) > base) {
			if (o.chains.size === 0 && o.over.size === 0) overlays.delete(doc)
			return
		}
		touched.add(kept.table)
		o.chains.set(who, { tip: kept, base, tables: touched, node, at: clock() })
		const t = kept.table
		if (on && rule === undefined && o.over.get(t) === hex(was.tip.name)) {
			const entry = table.get(t as Key, doc)
			if (entry !== undefined && entry.value !== undefined) {
				update(entry, commit.patches as never, changeOf(commit))
				if (entry.value === undefined) table.del(t as Key, doc)
				else options.commit?.([entry])
				o.over.set(t, hex(kept.name))
			}
		}
		show(doc)
		arm()
	}

	// a stored commit from elsewhere: its device's ephemeral commits it follows stop standing
	function ended(doc: string, kept: Kept) {
		const who = hex(decode(kept.bytes).signer)
		let m = latest.get(doc)
		if (!m) latest.set(doc, m = new Map())
		if ((m.get(who) ?? -1) < kept.lamport) m.set(who, kept.lamport)
		const o = overlays.get(doc)
		if (o === undefined) return
		const chain = o.chains.get(who)
		if (chain !== undefined && kept.lamport > chain.base) o.chains.delete(who), show(doc)
		else if (rule !== undefined && o.chains.size) show(doc)
	}

	// the stored tables the table shows (under any overlay), new
	function storedNow(doc: string): Tables {
		const on = merged.get(doc), head = shown.get(doc)
		if (on !== undefined) {
			return stateOf(doc, keyOf(on.map((k) => k.name))) ?? mergeOf(doc, on, rule!)
		}
		return head === undefined ? {} : replayed(doc, head.name)
	}

	// a change to an ephemeral table here: one ephemeral commit on this device's tip at the node, or
	// on what a stored write goes on. lamport above every tip there, so the newest write is the later
	function fleet(
		id: string,
		part: Key,
		patches: readonly Patch[],
		change: ChangeHeader | undefined,
	) {
		follow(id).catch(() => {})
		const t = part as string
		const o = overlayOf(id), mine = o.chains.get(me)
		const history = device.history(id)
		let parents: readonly Kept[], merge: string | undefined
		if (mine !== undefined) parents = [mine.tip]
		else {
			const on = merged.get(id), head = shown.get(id) ?? history.heads()[0]
			parents = on ?? (head ? [head] : [])
			if (on !== undefined) merge = rule
		}
		// the patches were made on what the table shows: what the commit goes on, or they are tried
		// on that (this device's tip, or the stored under others' commits)
		const fine = mine !== undefined ? o.over.get(t) === hex(mine.tip.name) : !o.over.has(t)
		const now = table.get(part, id)
		let value = now?.value
		if (!fine) {
			const on = mine !== undefined ? mine.node[t]?.value : o.under[t]?.value
			;[patches, value] = tried(on, patches, now)
		}
		let top = Math.max(0, ...parents.map((k) => k.lamport))
		for (const c of o.chains.values()) top = Math.max(top, c.tip.lamport)
		const commit: Commit = {
			table: t,
			...carried(change),
			signer: signer.key,
			nonce: nonce++,
			parents: parents.map((k) => k.name).sort(compare),
			lamport: 1 + top,
			patches: patches as Commit["patches"],
		}
		if (merge !== undefined) commit.merge = merge
		const bytes = encode(commit), name = nameOf(bytes)
		if (device.take(id, bytes, "ephemeral", { commit, name }) !== "taken") return
		const kept = device.history(id, "ephemeral").get(name)!
		// the stored under it, as it was before this write
		if (!o.over.has(t)) {
			const before = storedNow(id)[t]
			if (before === undefined) delete o.under[t]
			else o.under[t] = before
		}
		const node = mine?.node ?? tablesOf(snapshot(fromTable(id)))
		if (value === undefined) delete node[t]
		else node[t] = copied({ value, change: changeOf(commit) })
		const touched = mine?.tables ?? new Set<string>()
		touched.add(t)
		const base = mine?.base ?? Math.max(0, ...parents.map((k) => k.lamport))
		o.chains.set(me, { tip: kept, base, tables: touched, node, at: clock() })
		// the table shows the new tip when the patches were made on the one before; else shown again
		o.over.set(t, fine ? hex(name) : "")
		show(id)
		arm()
	}

	// the table shows, for each table a standing chain touched, the later tip's (with a rule, the
	// stored heads and the tips merged), and the stored again where none stands. again: worked out
	// again even where it shows the same tips
	function show(doc: string, again = false) {
		const o = overlays.get(doc)
		if (o === undefined) return
		const was = applying
		applying = true
		try {
			let merged: Tables | undefined, mark = ""
			const chains = [...o.chains.values()]
			if (rule !== undefined && chains.length) {
				const tips = chains.map((c) => c.tip)
				const heads = device.history(doc).heads().filter((h) =>
					!tips.some((t) => reaches(doc, t, h))
				)
				const all = [...heads, ...tips].sort(agreed)
				const eph = device.history(doc, "ephemeral")
				merged = all.length === 1
					? replay(eph, all[0].name, snapshots(doc), merges) ?? {}
					: merges[rule](
						eph,
						all,
						(ns) => ns.length === 1 ? plain(eph, ns[0], snapshots(doc)) : undefined,
					)
				mark = "merge " + keyOf(all.map((k) => k.name))
			}
			for (const part of tables) {
				const t = part as string
				let want: string | undefined, entry: Entry<unknown> | undefined
				let top: Chain | undefined
				for (const c of chains) {
					if (c.tables.has(t) && (top === undefined || after(c.tip, top.tip))) top = c
				}
				if (top !== undefined && merged !== undefined) want = mark, entry = merged[t]
				else if (top !== undefined) want = hex(top.tip.name), entry = top.node[t]
				const have = o.over.get(t)
				if (want === have && !again) continue
				if (want === undefined && have === undefined) continue
				if (have === undefined) {
					const e = table.get(part, doc)
					if (e?.value === undefined) delete o.under[t]
					else o.under[t] = copied(e)
				}
				if (want === undefined) {
					entry = o.under[t]
					delete o.under[t]
					o.over.delete(t)
				} else {
					o.over.set(t, want)
					if (entry !== undefined) entry = copied(entry)
				}
				const at = table.get(part, doc)
				if (entry === undefined || entry.value === undefined) {
					if (at !== undefined) table.del(part, doc)
				} else if (at === undefined) {
					table.add(part, doc, createEntry(entry.value as never, entry.change))
				} else table.sub(part, doc, createEntry(entry.value as never, entry.change))
			}
			if (o.chains.size === 0 && o.over.size === 0) overlays.delete(doc)
		} finally {
			applying = was
		}
	}

	// the ms until a beat or a ttl is due, or undefined
	function wait(now: number): number | undefined {
		let next: number | undefined
		for (const o of overlays.values()) {
			for (const [who, c] of o.chains) {
				const due = c.at + (who === me ? beat : ttl)
				if (next === undefined || due < next) next = due
			}
		}
		return next === undefined ? undefined : Math.max(0, next - now)
	}
	function tick(): number | undefined {
		const now = clock()
		for (const [doc, o] of [...overlays]) {
			let dropped = false
			for (const [who, c] of [...o.chains]) {
				if (who === me) {
					if (now - c.at >= beat) device.again(doc, c.tip.name), c.at = now
				} else if (now - c.at >= ttl) o.chains.delete(who), dropped = true
			}
			if (dropped) show(doc)
		}
		return wait(now)
	}
	// ticked here when the host gives no clock
	let closed = false
	function arm() {
		if (options.now !== undefined || closed) return
		clearTimeout(timer)
		const w = wait(clock())
		timer = w === undefined ? undefined : setTimeout(() => {
			timer = undefined
			tick()
			arm()
		}, w)
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
					if (!kept(part, id)) continue
					if (ephemeral(id, part)) fleet(id, part, op.patches, entry.change)
					else send(id, part, op.patches, entry.change)
				}
			}
		},
		tableChanged(part, id) {
			if (applying || !kept(part, id)) return
			const entry = table.get(part, id)
			if (ephemeral(id, part)) fleet(id, part, [whole(entry)], entry?.change)
			else send(id, part, [whole(entry)], entry?.change)
		},
		settle(id, change) {
			if (device.history(id).heads().length < 2) return
			const commit = send(id, "value", [], change, true)
			// a merge is a write to its table like any other: the entry shown carries its change, as
			// a replay of the merge (and so every other device) has it
			const o = overlays.get(id)
			if (commit && o?.over.has("value")) {
				const e = o.under.value
				if (e !== undefined) o.under.value = { value: e.value, change: changeOf(commit) }
				return
			}
			const entry = commit && tables.includes("value") ? table.get("value", id) : undefined
			if (entry === undefined) return
			const was = applying
			applying = true
			try {
				update(entry, [], changeOf(commit!))
				options.commit?.([entry])
			} finally {
				applying = was
			}
		},
		get: (id, name) => replay(device.history(id), name, snapshots(id), rulesOf(id)),
		use(name) {
			if (name !== undefined && merges[name] === undefined) {
				throw new Error(`no merge rule ${name}`)
			}
			if (name === rule) return
			rule = name
			// what was kept was merged by the rule before
			states.clear()
			keeping.clear()
			const was = applying
			applying = true
			try {
				for (const doc of followed) {
					const heads = device.history(doc).heads()
					merged.delete(doc)
					if (heads.length > 1) {
						if (rule !== undefined) showMerge(doc)
						else {
							const first = heads[0], mine = othersOf(doc)
							become(doc, mine.get(hex(first.name)) ?? replayed(doc, first.name))
							mine.delete(hex(first.name))
							shown.set(doc, first)
						}
					}
					conflicts(doc)
				}
				// merged, or the later: what overlays shows again
				for (const doc of overlays.keys()) show(doc, true)
			} finally {
				applying = was
			}
		},
		idle: async () => {
			await device.idle()
			if (dirty.size) flush()
		},
		tick,
		standing: (id) =>
			[...overlays.get(id)?.chains ?? []].map(([who, c]): [string, Uint8Array] => [
				who,
				c.tip.name,
			]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
		async close() {
			clearTimeout(timer)
			timer = undefined
			closed = true
			await device.close()
		},
	}
}
