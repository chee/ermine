// sync: the Subduction integration for the graph. every entry change at a kept node (an ermine://
// id; value, attributes and children unless told) goes out as one commit naming its table; what
// comes in is written to the table. commits are kept as bytes, decoded fresh: nothing shared, no
// copies, a change costs its patches.
//
// the table shows one head, nothing kept beside it. a commit on it: applied by update, its check
// too (patches that don't apply: refused). any other (fork, merge): checked on a replay of its
// parent (replay.ts); the table told only if the head shown changes, then given the new head whole.
// several heads: the first in agreed order shows, the rest in the "conflicts" table with the
// tables they differ in, the one shown in the "shown" table (both at the id, there together; each
// a head as its commit tells it: Head); settle(id) makes a merge keeping the head shown. what is wrong with a
// node's sync right now (commits waiting or refused, writes no commit could carry) is in the
// "status" table at its id, none when nothing is.
// a merge rule (merge, one of merges): heads show merged; a write is then a merge commit (every
// shown head its parents, the rule named). nothing merges by itself. a merge by a rule not in
// merges is refused ("merge"). use(rule) switches the rule or merging off.
// ephemeral tables: an ephemeral commit on the stored state, never sealed or stored, replacing its
// device's previous one at the table. shown on top: the later standing one (lamport, then name),
// or all merged by the rule; the stored state under is sync's own, listed in the "ephemeral"
// table. stops standing at a later stored commit of that device, after ttl ms unheard, or on stop
// (Sync.stop); resent every beat ms; then let go (device.forget). nothing ephemeral outlives sync.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Patch } from "@ermine/op/apply"
import * as cbor from "@ermine/encoding/cbor"
import {
	type Commit,
	CommitError,
	compare,
	decode,
	encode,
	name as nameOf,
} from "@ermine/encoding/commit"
import type { Id, Key, Table, Tables as Rows } from "@ermine/table"
import type * as sd from "npm:@automerge/subduction@0.23.0"
import { hex } from "./hex.ts"
import { agreed, type Kept, type Refusal } from "./history.ts"
import { changeOf, type Merges, plain, replay, type Tables } from "./replay.ts"
import { snapshot, tablesOf } from "./snapshot.ts"
import type { Signer } from "./seal.ts"
import { createDevice, type Device, type Lock } from "./transport.ts"

// a head as its commit tells it: its name, lamport, actor, signer's key (hex), time and site
// (external; none: not there)
export type Head = {
	head: string
	lamport: number
	actor: unknown
	signer: string
	time: number
	external?: Commit["external"]
}

// a head that does not show: as its commit tells it, and the tables in which it differs from the
// one shown
export type Conflict = Head & { tables: Record<string, unknown> }

// what stands ephemeral at a node: the stored value under each overlaid table, and each standing
// ephemeral commit (its signer's key and its name, hex; its table; its lamport) in the order they
// apply, the one that shows last
export type Ephemeral = {
	under: Record<string, unknown>
	on: { by: string; name: string; tables: string[]; lamport: number }[]
}

// what is wrong with a kept node's sync right now. waiting: commits from elsewhere not taken in
// yet, each on the parents named (their names), or on authority (the lock, or a check that could
// not judge it yet). refused: commits refused here (parent: one of its parents was), or a fragment
// refused whole, with the code (transport.ts's Code, history.ts's Refusal). a commit is its name, or
// the stored id the transport knows it by before it is opened; all hex. unsent: this device's writes
// no commit could carry, each with why (commit.ts's code and field), kept while sync runs. each list
// its first LIST (100), count how many in all
export type Status = {
	waiting: ({ commit: string; parents: string[] } | { commit: string; authority: true })[]
	refused: ({ commit: string; code: string } | { fragment: string; code: string })[]
	unsent: { table: string; error: string; field?: string }[]
	count: { waiting: number; refused: number; unsent: number }
}

declare module "@ermine/table" {
	interface Tables {
		conflicts: Conflict[]
		shown: Head
		ephemeral: Ephemeral
		status: Status
	}
}

export type Options = {
	table: Table
	signer: Signer
	// the device's (transport.ts): where Subduction keeps what it saves, the lock, and lazy: what the
	// storage holds is taken in as each document is followed, so the table holds the followed
	// documents and no other
	storage?: sd.SedimentreeStorage
	lock?: Lock
	lazy?: boolean
	// default: crypto.getRandomValues
	random?: (n: number) => Uint8Array
	// until Keyhive: ids minted with their last 16 bytes zero, which a Subduction server with no
	// Keyhive grant for a document (wss://galaxy.observer) stores. such an id binds no lock
	zeros?: boolean
	// the tables kept; default value, attributes and children
	tables?: readonly Key[]
	// the merge rules this device knows, by name: a merge commit by one is checked and
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
	// where the sites (external) a commit carries are told from: a site whose file starts with a root
	// is the rest after it (the first root it starts with), any other its last part (after the last
	// "/"); line, column and function as they are. default none: every file its last part
	roots?: readonly string[]
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
	// each ephemeral commit standing at the id (this device's too): its signer's key (hex) and its
	// name, by key, then name
	standing(id: string): [string, Uint8Array][]
	// an ephemeral write is the start; this is the stop: this device's standing ephemeral commit at
	// (id, table) ends now. forgotten here (the stored shows again, no beat carries it), and a stop
	// sent (device.stop), on which every peer drops it at once rather than after ttl. sent whether
	// or not one stands (a receiver with nothing standing from this device at the table ignores it)
	stop(id: string, table: Key): void
	// the timers stopped, the device closed
	close(): Promise<void>
}

const random32 = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const ID = /^ermine:\/\/[0-9a-f]{64}$/
// the most of each list in a node's status
const LIST = 100

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

// the metadata keys changeOf adds over a commit's own: who signed it and the commit
const SIGNED = ["signer", "commit"]
// whether a change is a commit's, as changeOf gives it: both keys there, each a string
const signed = (change: ChangeHeader | undefined) => {
	const m = change?.metadata
	return m !== undefined && SIGNED.every((k) => Object.hasOwn(m, k) && typeof m[k] === "string")
}

// a site's file as a commit tells it: the rest after the first root it starts with, else its last
// part
const site = (file: string, roots: readonly string[]) => {
	for (const r of roots) if (file.startsWith(r)) return file.slice(r.length)
	return file.slice(file.lastIndexOf("/") + 1)
}

// what of a change header a commit can carry: metadata keys whose values encode. for a new commit
// (roots given): never a signer or commit key (a replayed change's: not this device's to claim), each
// site's file as the roots say. else a copy, sync's own, of what a commit carried
function carried(
	change: ChangeHeader | undefined,
	roots?: readonly string[],
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
	if (change?.external?.length) {
		out.external = change.external.map((s) =>
			roots === undefined ? { ...s } : { ...s, file: site(s.file, roots) }
		)
	}
	const metadata = Object.entries(change?.metadata ?? {}).filter(([k, v]) =>
		ok(v) && (roots === undefined || !SIGNED.includes(k))
	)
	if (metadata.length) out.metadata = Object.fromEntries(metadata)
	return out
}

export function createSync(options: Options): Sync {
	const { table, signer } = options
	const roots = options.roots ?? []
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
	// the last commit this device sent at each node's table, its name (hex): what a write here
	// replays as (fromTable)
	const sent = new Map<string, Map<string, string>>()
	// each node's writes no commit could carry, all of them (the status lists the first LIST)
	const unsent = new Map<string, Status["unsent"]>()
	// nodes whose status is to be worked out again: once a batch
	const unwell = new Set<string>()

	// ---- ephemeral state
	const me = hex(signer.key)
	const ephemeral = options.ephemeral ?? (() => false)
	const clock = options.now ?? Date.now
	const beat = options.beat ?? 1000, ttl = options.ttl ?? 4000
	// a standing ephemeral commit: it, the highest lamport of the stored commits it went on (base),
	// its table's entry at it (sync's own; none: no value)
	type Stand = { kept: Kept; base: number; entry: Entry<unknown> | undefined }
	// a device's standing ephemeral commits at a node, by table, and when it was last heard from
	// (this device's: last sent)
	type Peer = { stands: Map<string, Stand>; at: number }
	// a node with any: the devices' by signer (hex); what each overlaid table shows (a commit's
	// name, "merge" and the names merged, or "" to be shown again); the stored entries under the
	// overlaid tables
	type Overlay = { peers: Map<string, Peer>; over: Map<string, string>; under: Tables }
	const overlays = new Map<string, Overlay>()
	// the highest lamport of a stored commit from each signer at a node: an ephemeral commit that
	// went on less is followed already
	const latest = new Map<string, Map<string, number>>()
	// an ephemeral commit's table's entry, made in its check, by name, until it arrives
	const fresh = new Map<string, { entry: Entry<unknown> | undefined }>()
	let timer: ReturnType<typeof setTimeout> | undefined
	const overlayOf = (doc: string) => {
		let o = overlays.get(doc)
		if (!o) overlays.set(doc, o = { peers: new Map(), over: new Map(), under: {} })
		return o
	}
	const standsOf = (o: Overlay) => [...o.peers.values()].flatMap((p) => [...p.stands.values()])
	// the stored entry at (part, doc): under the overlay, or the table's
	const storedEntry = (doc: string, part: Key) => {
		const o = overlays.get(doc)
		return o?.over.has(part as string) ? o.under[part as string] : table.get(part, doc)
	}

	const device: Device = createDevice({
		signer,
		storage: options.storage,
		lock: options.lock,
		lazy: options.lazy,
		check,
		snapshotOf,
		merges: options.merges,
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
	// what the device holds back or refused may have changed
	device.moved((doc) => recheck(doc))
	device.heard((doc, from) => {
		const p = overlays.get(doc)?.peers.get(from)
		if (p !== undefined && from !== me) p.at = clock()
	})
	// a peer's stop: what stands for it at the table stops standing now; nothing standing, nothing
	device.stopped((doc, from, table) => {
		if (from === me) return
		const p = overlays.get(doc)?.peers.get(from), s = p?.stands.get(table)
		if (p === undefined || s === undefined) return
		applying = true
		try {
			p.stands.delete(table)
			device.forget(doc, s.kept.name)
			show(doc)
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
			const e = storedEntry(doc, part)
			if (e !== undefined && e.value !== undefined) {
				out[part as string] = { value: e.value, change: asCommit(doc, part, e.change) }
			}
		}
		return out
	}
	// a change as a replay of its commit has it: one from a commit (changeOf's), as it is; one
	// written here, as its commit carried it, then who signed it and the commit (the last sent at
	// the table)
	function asCommit(doc: string, part: Key, change: ChangeHeader): ChangeHeader {
		if (signed(change)) return carried(change) as ChangeHeader
		const c = carried(change, roots) as ChangeHeader
		const name = sent.get(doc)?.get(part as string)
		if (name !== undefined) c.metadata = { ...c.metadata, signer: me, commit: name }
		return c
	}

	// with a rule that can keep its work between merges (Merge's keeping),
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
				else node[commit.table] = { value, change: changeOf(commit, kept.name) }
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
			else node[commit.table] = { value, change: changeOf(commit, kept.name) }
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
		const change = changeOf(commit, kept.name)
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
			} else if (options.commit !== undefined) {
				update(entry, commit.patches as never, change)
				if (entry.value === undefined) table.del(part, doc)
				else options.commit([entry])
			} else {
				// no host's "a write landed": the table's event, a new entry in its place, whole
				const next = createEntry(entry.value, entry.change)
				update(next, commit.patches as never, change)
				if (next.value === undefined) table.del(part, doc)
				else table.sub(part, doc, next)
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
		if (dirty.size === 0 && unwell.size === 0) queueMicrotask(flush)
		dirty.add(doc)
	}
	// the status alone worked out again, once the commits coming in now are all in
	function recheck(doc: string) {
		if (dirty.size === 0 && unwell.size === 0) queueMicrotask(flush)
		unwell.add(doc)
	}
	function flush() {
		const docs = [...dirty], checks = new Set([...docs, ...unwell])
		dirty.clear()
		unwell.clear()
		const was = applying
		applying = true
		try {
			for (const doc of docs) {
				if (rule !== undefined && device.history(doc).heads().length > 1) showMerge(doc)
				conflicts(doc)
				listed(doc)
			}
			for (const doc of checks) status(doc)
		} finally {
			applying = was
		}
	}

	// the "status" table at the id: what the device holds back or refused there (the stored
	// layer's), what its history waits on or refused, and the writes not sent. none when nothing
	function status(doc: string) {
		const t = device.taking(doc), history = device.history(doc)
		const on = (commit: string, parents: string[]): Status["waiting"][number] =>
			parents.length ? { commit, parents } : { commit, authority: true }
		const waiting = [
			...t.waiting.map((w) => on(w.commit, w.waiting)),
			...history.waiting().map((w) => on(w.name, w.waiting)),
		]
		const refused: Status["refused"] = []
		// a commit stuck behind a refused parent waits on that parent: a later change (the rule
		// becoming known) could let both in
		for (const r of t.refused) {
			if ("fragment" in r) refused.push({ fragment: r.fragment, code: r.refused })
			else if ("stuck" in r) waiting.push(on(r.commit, r.stuck))
			else refused.push({ commit: r.commit, code: r.refused })
		}
		for (const r of history.refused()) {
			if (r.on !== undefined) waiting.push(on(r.name, [r.on]))
			else refused.push({ commit: r.name, code: r.refused })
		}
		const mine = unsent.get(doc) ?? []
		const have = table.get("status", doc)
		if (!waiting.length && !refused.length && !mine.length) {
			if (have !== undefined) table.del("status", doc)
			return
		}
		const value: Status = {
			waiting: waiting.slice(0, LIST),
			refused: refused.slice(0, LIST),
			unsent: mine.slice(0, LIST),
			count: { waiting: waiting.length, refused: refused.length, unsent: mine.length },
		}
		const change = { time: Math.floor(Date.now() / 1000), actor: null }
		if (have?.value === undefined) {
			const entry = createEntry(value, change)
			if (have) table.sub("status", doc, entry)
			else table.add("status", doc, entry)
			return
		}
		// each list and count that changed is a patch of its own, so a read of one is not rerun
		// by a change to another
		const was = have.value
		const patches: Patch[] = []
		for (const k of ["waiting", "refused", "unsent"] as const) {
			if (!same(was[k], value[k])) patches.push({ path: [k], value: value[k] })
		}
		for (const k of ["waiting", "refused", "unsent"] as const) {
			if (was.count?.[k] !== value.count[k]) {
				patches.push({ path: ["count", k], value: value.count[k] })
			}
		}
		if (!patches.length) return
		const next = createEntry(was, have.change)
		update(next, patches, change)
		table.sub("status", doc, next)
	}

	// the writes no commit could carry at (id, table) are no longer so: what a send there carried
	// is what other devices have of it again
	function sentAt(id: string, part: Key) {
		const rows = unsent.get(id)
		if (rows === undefined) return
		const left = rows.filter((r) => r.table !== part)
		if (left.length === rows.length) return
		if (left.length) unsent.set(id, left)
		else unsent.delete(id)
		recheck(id)
	}

	// a write at (id, table) no commit could carry: noted in the status
	function failed(id: string, part: Key, e: CommitError) {
		let m = unsent.get(id)
		if (m === undefined) unsent.set(id, m = [])
		m.push({ table: part as string, error: e.code, ...e.field && { field: e.field } })
		recheck(id)
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
			return { ...headOf(k), tables: differ }
		})
		put("conflicts", doc, list.length ? list : undefined)
		put("shown", doc, list.length ? headOf(heads[0]) : undefined)
	}

	// a head as its commit tells it
	function headOf(k: Kept): Head {
		const c = decode(k.bytes)
		return {
			head: hex(k.name),
			lamport: k.lamport,
			actor: c.actor,
			signer: hex(c.signer),
			time: c.time,
			...c.external && { external: c.external },
		}
	}

	// sync's own entry at (part, doc): value, or none when undefined
	function put<P extends "conflicts" | "shown">(
		part: P,
		doc: string,
		value: Rows[P] | undefined,
	) {
		const have = table.get(part, doc)
		if (value === undefined) {
			if (have !== undefined) table.del(part, doc)
			return
		}
		const entry = createEntry(value, { time: Math.floor(Date.now() / 1000), actor: null })
		if (have) table.sub(part, doc, entry)
		else table.add(part, doc, entry)
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
			...carried(change, roots),
			signer: signer.key,
			nonce,
			parents: heads.map((k) => k.name).sort(compare),
			lamport: 1 + Math.max(0, ...heads.map((k) => k.lamport)),
			patches: patches as Commit["patches"],
		}
		if (on !== undefined) commit.merge = rule
		else if (heads.length > 1) commit.base = head!.name
		// what no commit can carry (a value with no encoding) is not sent, and the rest goes on: noted
		let bytes: Uint8Array
		try {
			bytes = encode(commit)
		} catch (e) {
			if (!(e instanceof CommitError)) throw e
			return void failed(id, part, e)
		}
		nonce++
		const name = nameOf(bytes)
		grew(id, name, bytes.length)
		const added = device.take(id, bytes, "stored", { commit, name })
		if (added === "taken") {
			sentAt(id, part)
			let at = sent.get(id)
			if (at === undefined) sent.set(id, at = new Map())
			at.set(part as string, hex(name))
			shown.set(id, history.get(name)!)
			merged.delete(id)
			if (heads.length > 1) {
				const mine = othersOf(id)
				for (const k of heads) mine.delete(hex(k.name))
				if (rule !== undefined) remember(id)
				later(id)
			}
			if (o !== undefined) landed(id, part, all, stored, commit, name)
		}
		return added === "taken" ? { commit, name } : undefined
	}

	const whole = (e: Entry<unknown> | undefined): Patch =>
		e?.value === undefined ? { path: [] } : { path: [], value: e.value }

	// a stored commit of this device's at an overlaid node: what the table shows of its table is
	// stored now, and this device's ephemeral commits there are followed
	function landed(
		id: string,
		part: Key,
		all: boolean,
		stored: unknown,
		commit: Commit,
		name: Uint8Array,
	) {
		const o = overlays.get(id)!, t = part as string
		if (!all && o.over.has(t)) {
			if (stored === undefined) delete o.under[t]
			else o.under[t] = copied({ value: stored, change: changeOf(commit, name) })
			// shown again, whatever it showed
			o.over.set(t, "")
		}
		forgotten(id, o.peers.get(me))
		o.peers.delete(me)
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

	// ephemeral commits that stand no more are let go of, so what is kept of them is the standing
	// ones (beside the stored)
	const forgotten = (doc: string, p: Peer | undefined) => {
		for (const s of p?.stands.values() ?? []) device.forget(doc, s.kept.name)
	}

	// a copy of an entry, sync's own: its value new (through its encoding, never packed: a pack
	// deflates), its change as a commit carries it
	const copied = (e: Entry<unknown>): Entry<unknown> =>
		({
			value: e.value === undefined ? undefined : cbor.decode(cbor.encode(e.value as cbor.Value)),
			change: carried(e.change) as ChangeHeader,
		}) as Entry<unknown>

	// the later of two ephemeral commits: higher lamport, then the greater name
	const after = (a: Kept, b: Kept) =>
		a.lamport !== b.lamport ? a.lamport > b.lamport : compare(a.name, b.name) > 0
	// the later of two ephemeral commits of one device: its count says (a lamport is its parents')
	const newer = (a: Kept, b: Kept) => decode(a.bytes).nonce > decode(b.bytes).nonce

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

	// an ephemeral commit's table's entry at its parents, new: the stored entry when they are what
	// the table shows as stored, else from the ephemeral history (which holds the stored commits too)
	function startOf(doc: string, kept: Kept, commit: Commit): Entry<unknown> | undefined {
		const t = commit.table
		if (commit.parents.length === 0) return undefined
		const on = merged.get(doc), head = shown.get(doc)
		const stored = commit.merge === undefined
			? on === undefined && head !== undefined && commit.parents.length === 1 &&
				compare(commit.parents[0], head.name) === 0
			: commit.merge === rule && on !== undefined && sameHeads(on, commit.parents)
		if (stored && tables.includes(t as Key)) {
			const e = storedEntry(doc, t as Key)
			return e?.value === undefined ? undefined : copied(e)
		}
		const eph = device.history(doc, "ephemeral")
		if (commit.merge !== undefined) {
			return merges[commit.merge](
				eph,
				commit.parents.map((p) => eph.get(p)!),
				(ns) => ns.length === 1 ? plain(eph, ns[0], snapshots(doc)) : undefined,
			)[t]
		}
		if (kept.base === undefined) return undefined
		return replay(eph, kept.base, snapshots(doc), merges)?.[t]
	}

	// an ephemeral commit from elsewhere: does it apply to its table's entry at its parents. what it
	// makes is kept for its arrival
	function fleeting(doc: string, kept: Kept, commit: Commit): boolean {
		// signed with this device's key elsewhere: never stands here
		if (hex(commit.signer) === me) return true
		let value: unknown
		try {
			value = apply(startOf(doc, kept, commit)?.value, commit.patches as Patch[], { cow: false })
		} catch {
			return false
		}
		const entry = value === undefined
			? undefined
			: { value, change: changeOf(commit, kept.name) } as Entry<unknown>
		fresh.set(hex(kept.name), { entry })
		return true
	}

	// an ephemeral commit from elsewhere, taken in: it stands for its device's table in place of the
	// one before, unless that one is the later (by its device's count), or a stored commit of its
	// device follows it already
	function heard(doc: string, kept: Kept) {
		const n = hex(kept.name), made = fresh.get(n)
		fresh.delete(n)
		const who = hex(decode(kept.bytes).signer)
		// one that never stands here is let go of at once
		const gone = () => void device.forget(doc, kept.name)
		if (who === me || made === undefined || !tables.includes(kept.table as Key)) return gone()
		const eph = device.history(doc, "ephemeral")
		const base = Math.max(0, ...kept.parents.map((p) => eph.get(p)?.lamport ?? 0))
		if ((latest.get(doc)?.get(who) ?? -1) > base) return gone()
		const o = overlayOf(doc)
		let p = o.peers.get(who)
		if (p === undefined) o.peers.set(who, p = { stands: new Map(), at: clock() })
		p.at = clock()
		const was = p.stands.get(kept.table)
		if (was !== undefined && !newer(kept, was.kept)) return gone()
		p.stands.set(kept.table, { kept, base, entry: made.entry })
		if (was !== undefined) device.forget(doc, was.kept.name)
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
		const p = o.peers.get(who)
		let gone = false
		for (const [t, s] of p?.stands ?? []) {
			if (kept.lamport <= s.base) continue
			p!.stands.delete(t)
			device.forget(doc, s.kept.name)
			gone = true
		}
		if (gone || (rule !== undefined && o.peers.size)) show(doc)
	}

	// the stored tables the table shows (under any overlay), new
	function storedNow(doc: string): Tables {
		const on = merged.get(doc), head = shown.get(doc)
		if (on !== undefined) {
			return stateOf(doc, keyOf(on.map((k) => k.name))) ?? mergeOf(doc, on, rule!)
		}
		return head === undefined ? {} : replayed(doc, head.name)
	}

	// a change to an ephemeral table here: one ephemeral commit on what a stored write goes on, in
	// place of this device's standing one at the table. its patches take the stored to what the
	// device shows: as made, when the table showed the stored; else tried on what the device showed
	// (its standing one, or the stored), the whole value if they don't apply; and over a standing one
	// of this device's, the whole value it makes (with a rule: that one's patches, then these).
	// its lamport is derived from its parents, as every commit's: one standing beside it on the same
	// stored heads is later or not by name
	function fleet(
		id: string,
		part: Key,
		patches: readonly Patch[],
		change: ChangeHeader | undefined,
	) {
		follow(id).catch(() => {})
		const t = part as string
		const o = overlayOf(id), was = o.peers.get(me)?.stands.get(t)
		const history = device.history(id)
		const on = merged.get(id), head = shown.get(id) ?? history.heads()[0]
		const parents = on ?? (head ? [head] : [])
		const now = table.get(part, id)
		let value = now?.value
		// the table showed the stored, or this device's standing one: it shows the device's now
		const have = o.over.get(t)
		const fine = have === undefined || (was !== undefined && have === hex(was.kept.name))
		let applied = true
		if (!fine) {
			const out = tried(was !== undefined ? was.entry?.value : o.under[t]?.value, patches, now)
			applied = out[0] === patches
			;[patches, value] = out
		}
		if (was !== undefined) {
			patches = rule !== undefined && applied && !fine
				? [...decode(was.kept.bytes).patches as Patch[], ...patches]
				: [value === undefined ? { path: [] } : { path: [], value }]
		}
		const base = Math.max(0, ...parents.map((k) => k.lamport))
		const commit: Commit = {
			table: t,
			...carried(change, roots),
			signer: signer.key,
			nonce,
			parents: parents.map((k) => k.name).sort(compare),
			lamport: 1 + base,
			patches: patches as Commit["patches"],
		}
		if (on !== undefined) commit.merge = rule
		let bytes: Uint8Array
		try {
			bytes = encode(commit)
		} catch (e) {
			if (!(e instanceof CommitError)) throw e
			return void failed(id, part, e)
		}
		nonce++
		const name = nameOf(bytes)
		if (device.take(id, bytes, "ephemeral", { commit, name }) !== "taken") return
		sentAt(id, part)
		const kept = device.history(id, "ephemeral").get(name)!
		// the stored under it, as it was before this write
		if (!o.over.has(t)) {
			const before = storedNow(id)[t]
			if (before === undefined) delete o.under[t]
			else o.under[t] = before
		}
		let mine = o.peers.get(me)
		if (mine === undefined) o.peers.set(me, mine = { stands: new Map(), at: 0 })
		const entry = value === undefined
			? undefined
			: copied({ value, change: changeOf(commit, name) } as Entry<unknown>)
		mine.stands.set(t, { kept, base, entry })
		if (was !== undefined) device.forget(id, was.kept.name)
		mine.at = clock()
		// the table shows the new one when the patches were made on what it showed; else shown again
		o.over.set(t, fine ? hex(name) : "")
		show(id)
		arm()
	}

	// the table shows, for each table, the later standing one's (with a rule, the stored heads and
	// every standing one merged), and the stored again where none stands. again: worked out again
	// even where it shows the same ones
	function show(doc: string, again = false) {
		const o = overlays.get(doc)
		if (o === undefined) return listed(doc)
		const was = applying
		applying = true
		try {
			let merged: Tables | undefined, mark = ""
			const stands = standsOf(o)
			if (rule !== undefined && stands.length) {
				const tips = stands.map((s) => s.kept)
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
				let top: Stand | undefined
				for (const s of stands) {
					if (s.kept.table === t && (top === undefined || after(s.kept, top.kept))) top = s
				}
				if (top !== undefined && merged !== undefined) want = mark, entry = merged[t]
				else if (top !== undefined) want = hex(top.kept.name), entry = top.entry
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
			for (const [who, p] of o.peers) if (p.stands.size === 0) o.peers.delete(who)
			if (o.peers.size === 0 && o.over.size === 0) overlays.delete(doc)
			listed(doc)
		} finally {
			applying = was
		}
	}

	// the "ephemeral" table at the id, while anything stands there: the stored under each overlaid
	// table, and every standing ephemeral commit, the later last. none when nothing stands
	function listed(doc: string) {
		const o = overlays.get(doc)
		const on = o === undefined
			? []
			: [...o.peers].flatMap(([by, p]) =>
				[...p.stands.values()].map((s) => ({ by, kept: s.kept }))
			)
		on.sort((a, b) => after(a.kept, b.kept) ? 1 : -1)
		const under: Record<string, unknown> = {}
		for (const part of tables) {
			const t = part as string, e = o?.under[t]
			if (o?.over.has(t) && e?.value !== undefined) under[t] = e.value
		}
		const value: Ephemeral = {
			under,
			on: on.map(({ by, kept }) => ({
				by,
				name: hex(kept.name),
				tables: [kept.table],
				lamport: kept.lamport,
			})),
		}
		const have = table.get("ephemeral", doc)
		if (on.length > 0 && have !== undefined && same(have.value, value)) return
		const was = applying
		applying = true
		try {
			if (on.length === 0) {
				if (have !== undefined) table.del("ephemeral", doc)
				return
			}
			// sync's own: the values under are copied, or the last list's kept when they are the same
			const before = have?.value as Ephemeral | undefined
			if (before !== undefined && same(before.under, under)) value.under = before.under
			else for (const t of Object.keys(under)) under[t] = copied(o!.under[t]).value
			const entry = createEntry(value, { time: Math.floor(Date.now() / 1000), actor: null })
			if (have) table.sub("ephemeral", doc, entry)
			else table.add("ephemeral", doc, entry)
		} finally {
			applying = was
		}
	}

	// the ms until a beat or a ttl is due, or undefined
	function wait(now: number): number | undefined {
		let next: number | undefined
		for (const o of overlays.values()) {
			for (const [who, p] of o.peers) {
				const due = p.at + (who === me ? beat : ttl)
				if (next === undefined || due < next) next = due
			}
		}
		return next === undefined ? undefined : Math.max(0, next - now)
	}
	function tick(): number | undefined {
		const now = clock()
		for (const [doc, o] of [...overlays]) {
			let dropped = false
			for (const [who, p] of [...o.peers]) {
				if (who === me) {
					if (now - p.at < beat) continue
					for (const s of p.stands.values()) device.again(doc, s.kept.name)
					p.at = now
				} else if (now - p.at >= ttl) {
					forgotten(doc, p)
					o.peers.delete(who)
					dropped = true
				}
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
			const made = send(id, "value", [], change, true)
			// a merge is a write to its table like any other: the entry shown carries its change, as
			// a replay of the merge (and so every other device) has it
			const o = overlays.get(id)
			if (made && o?.over.has("value")) {
				const e = o.under.value
				if (e !== undefined) {
					o.under.value = { value: e.value, change: changeOf(made.commit, made.name) }
				}
				return
			}
			const entry = made && tables.includes("value") ? table.get("value", id) : undefined
			if (entry === undefined) return
			const was = applying
			applying = true
			try {
				if (options.commit !== undefined) {
					update(entry, [], changeOf(made!.commit, made!.name))
					options.commit([entry])
				} else {
					// no host's "a write landed": the table's event, a new entry in its place
					const next = createEntry(entry.value, entry.change)
					update(next, [], changeOf(made!.commit, made!.name))
					table.sub("value", id, next)
				}
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
			if (dirty.size || unwell.size) flush()
		},
		tick,
		standing: (id) =>
			[...overlays.get(id)?.peers ?? []].flatMap(([who, p]) =>
				[...p.stands.values()].map((s): [string, Uint8Array] => [who, s.kept.name])
			).sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : compare(x, y)),
		stop(id, part) {
			if (!kept(part, id)) return
			follow(id).catch(() => {})
			const t = part as string
			const mine = overlays.get(id)?.peers.get(me), s = mine?.stands.get(t)
			if (mine !== undefined && s !== undefined) {
				mine.stands.delete(t)
				device.forget(id, s.kept.name)
				show(id)
				arm()
			}
			device.stop(id, t)
		},
		async close() {
			clearTimeout(timer)
			timer = undefined
			closed = true
			await device.close()
		},
	}
}
