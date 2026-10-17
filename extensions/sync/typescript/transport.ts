// commits over Subduction (extensions/subduction/plan.org, Rewrite for the new shape, 7): stored
// ones, sealed, as loose commits and fragments, each fragment with a snapshot of the tables at its
// head; ephemeral ones, never sealed, as its ephemeral messages; and what a device checks of what
// arrives before its histories see it. one sedimentree per node: a commit names no node, it is the
// node's whose sedimentree it came on. adapted from extensions/subduction/typescript/transport.ts,
// which carries blops. only the lock "unlocked" is built
import * as sd from "npm:@automerge/subduction@0.23.0"
import { each as eachRun, pack as packRun, RunError } from "./run.ts"
import { hex, unhex } from "./hex.ts"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, CommitError, decode, name as nameOf, splitKey } from "@ermine/encoding/commit"
import { build, depth, type Fragment, FragmentError, walk } from "@ermine/subduction/fragment"
import { type Added, createHistory, type History, type Judged, type Kept } from "./history.ts"
import { matches, type Merges, type Tables } from "./replay.ts"
import {
	ED25519,
	ed25519Key,
	seal,
	SealError,
	type Signer,
	stored,
	unseal,
	type Verifier,
} from "./seal.ts"
import { tablesOf } from "./snapshot.ts"
import { keep as hooks, type Taking } from "./transport_conformance_hook.ts"

export type { Fragment }

export type Layer = "stored" | "ephemeral"

// a commit taken into a history from elsewhere (the network or storage), after it is taken in;
// heard: from a peer's ephemeral message. a device's own takes are not announced
export type Arrival = { doc: string; layer: Layer; kept: Kept; heard: boolean }

// the integration's: whether a commit whose parents are all taken in applies to its parent's node.
// called for commits from elsewhere only, never for this device's own takes. it may apply them as
// it looks. false: refused "patches"; a refusal: refused so ("merge": a rule not known here);
// "wait": not judged yet, judged again on changed(). a throw is a wait, and idle() throws it
export type Check = (
	doc: string,
	kept: Kept,
	commit: Commit,
	layer: Layer,
) => Judged

// what a lock's open gives: the bytes close was given; not yet; or never
export type Opened = Uint8Array | { wait: true } | { refused: string }

// the part of a lock transport calls; doc: the document's 32 bytes
export type Lock = {
	close(
		doc: Uint8Array,
		name: Uint8Array,
		parents: Uint8Array[],
		bytes: Uint8Array,
	): Uint8Array | Promise<Uint8Array>
	open(doc: Uint8Array, bytes: Uint8Array): Opened | Promise<Opened>
}

// close and open give back what they are given
export const unlocked: Lock = { close: (_d, _n, _p, bytes) => bytes, open: (_d, bytes) => bytes }

// why the transport refused a seal, a fragment or an ephemeral message before a history saw it.
// what a history refuses (lamport, patches, a parent) is the history's: history(doc).refused().
// boundary: a fragment's members, boundary or checkpoints not what its head's walk makes them
export type Code = "lock" | "shape" | "signature" | "stored" | "parents" | "boundary"

// starting: createDevice returns at once, and begins taking in everything the storage holds (every
// fragment, then every loose commit, as a save is taken in; a commit whose parents come later waits,
// as ever). everything that touches the network (connect, connectDiscover, follow) waits for that;
// take's sealing and storing, put and the other work queue behind it. ready() resolves when it is
// done; it throws what the storage threw
export type Device = {
	ready(): Promise<void>
	connect(transport: sd.Transport, initiator: boolean): Promise<void>
	// a server by its WebSocket url, by discovery (the service name its url's host, unless given)
	connectDiscover(url: string, service?: string): Promise<void>
	// every connection to the peer with that key (a multikey)
	disconnect(key: Uint8Array): Promise<void>
	follow(doc: string): Promise<void>
	// default "stored". the ephemeral one holds every stored commit too
	history(doc: string, layer?: Layer): History
	// a commit this device made, its bytes: into the layer's history at once, synchronously, with no
	// check (it has applied here already). then, queued in the order made: stored ones sealed, added
	// as a loose commit, sent; ephemeral ones published unsealed. one waiting on a parent is queued
	// once the parent lets it in. answers as the history does
	take(
		doc: string,
		bytes: Uint8Array,
		layer: Layer,
		made?: { commit: Commit; name: Uint8Array },
	): Added
	arrived(listener: (a: Arrival) => void): () => void
	// told each ephemeral commit heard on a followed document whose signer is the sender, new or
	// heard before (sent again), after any arrival it made: the document, the sender's key (its
	// multikey, as lowercase hex), the commit's name. what keeps another device's ephemeral commits
	// standing
	heard(listener: (doc: string, from: string, name: Uint8Array) => void): () => void
	// an ephemeral commit of this device's (in the ephemeral history, not a stored one) published
	// again, queued as a take is; false: no such commit
	again(doc: string, name: Uint8Array): boolean
	// an ephemeral commit (not a stored one) let go of: out of the ephemeral history and whatever
	// was kept for it, as if never heard; heard again, it comes in again. false: none such, or
	// something goes on it
	forget(doc: string, name: Uint8Array): boolean
	// the tables at a commit, when a fragment headed by it carried a snapshot: new objects each time
	snapshot(doc: string, name: Uint8Array): Tables | undefined
	// bytes to whoever listens on a topic (a string, named by hash so it is never a document's):
	// ephemeral, kept nowhere, not heard here. over LIMIT: sent as parts, joined at the other end
	send(topic: string, bytes: Uint8Array): Promise<void>
	// fn told each message on the topic: the sender's key (its multikey, as lowercase hex), the bytes.
	// subscribes as needed (queued: idle() waits for it); gives back the stop, which only removes fn
	listen(topic: string, fn: (from: string, bytes: Uint8Array) => void): () => void
	stored(doc: string): Promise<Uint8Array[]>
	fragments(doc: string): Fragment[]
	// the lock's or the check's changed(): what waited on the lock, or on the check, is tried again
	changed(): Promise<void>
	// an ephemeral payload's parts not joined yet are dropped now, as the setting would in time
	expire(): void
	// nothing left to take in, build, seal, store or send; throws what one of them threw
	idle(): Promise<void>
	close(): Promise<void>
}

// Subduction drops an ephemeral payload over this; a closed commit over it is sent as parts of at
// most PART bytes
export const LIMIT = 65536
export const PART = 60000

// what a device holds for others at most, each letting go of its oldest past it (heard again, it
// comes in again). pending: a document's seals waiting on a parent's seal, and its stored commits
// waiting on a parent; refused: its refusals noted (each kind), and its snapshot hints; waiting: its
// ephemeral commits waiting on a parent; joins: the ephemeral payloads being joined; parts: the parts
// one may have (so one is at most PART × parts bytes)
export type Limits = {
	pending: number
	refused: number
	waiting: number
	joins: number
	parts: number
}
export const LIMITS: Limits = {
	pending: 65536,
	refused: 4096,
	waiting: 1024,
	joins: 64,
	parts: 1024,
}

const by = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const commitId = (b: Uint8Array) => new sd.CommitId(b)
const ID = /^ermine:\/\/[0-9a-f]{64}$/

// a document's 32 bytes, from its ermine:// id
function bytesOf(doc: string): Uint8Array {
	if (typeof doc !== "string" || !ID.test(doc)) throw new TypeError(`not a document id: ${doc}`)
	return unhex(doc.slice("ermine://".length))
}

// noted in a map (or a set), the oldest let go of past most
function note<K, V>(most: number, m: Map<K, V> | Set<K>, key: K, value?: V) {
	if (!m.has(key) && m.size >= most) m.delete(m.keys().next().value!)
	if (m instanceof Map) m.set(key, value!)
	else m.add(key)
}

const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])

// a seal's commit, as far as the transport reads it: its name, bytes, stored id, lamport, parents
type Sealed = {
	name: Uint8Array
	bytes: Uint8Array
	stored: Uint8Array
	lamport: number
	parents: Uint8Array[]
}

// a taken-in seal: its commit's name, lamport and parents' names, its sealed bytes, and the stored
// ids of the seals it was taken in over (the commit's parents; or, for a seal alone, every seal of
// each)
type Seen = { name: string; lamport: number; parents: string[]; sealed: Uint8Array; ids: string[] }

// a fragment as Subduction's storage is given it: checkpoints as their first 12 bytes
type Saved = {
	head: sd.CommitId
	boundary: sd.CommitId[]
	checkpoints: Uint8Array[]
	blob: Uint8Array
}

// a fragment's member: its sealed bytes, and its commit as the transport reads it
type Member = { sealed: Uint8Array; it: Sealed }

// a loose commit, or a seal alone (a fragment's member), not yet handed to the histories: its parents
// not all here, or one refused. given: the commit's parents' stored ids, sorted
type Pending = {
	commit: boolean
	it: Sealed
	sealed: Uint8Array
	parents: string[]
	given: string[]
	waiting?: string[]
	stuck?: string[]
}

type Document = {
	id: string
	bytes: Uint8Array
	tree: sd.SedimentreeId
	topic: sd.Topic
	histories: Record<Layer, History>
	// what each history was given from elsewhere and has not taken in yet, by name: whether heard
	elsewhere: Record<Layer, Map<string, boolean>>
	// this device's own takes waiting on a parent, by name: sent once let in
	own: Record<Layer, Set<string>>
	// a taken-in seal's name to its stored ids: a signer may have signed twice
	names: Map<string, string[]>
	seen: Map<string, Seen>
	fragments: Map<string, Fragment>
	// the snapshots fragments carried, packed, by their head's name, each checked (hint)
	snapshots: Map<string, Uint8Array>
	// the snapshots not checked yet, by their head's name; the heads checked
	hints: Map<string, Uint8Array>
	judged: Set<string>
	// by the commit's head, or the seal's stored id
	pending: Map<string, Pending>
	refused: Map<string, Code>
	// fragments refused whole, by head
	broken: Map<string, Code>
	// names of seals refused here
	bad: Set<string>
	// waiting on the lock: tried again by changed
	locked: Map<string, { commit: boolean; again(): Promise<void> }>
	// refused ephemeral commits, by their name (BLAKE3 of what the lock opened)
	heard: Map<string, Code>
	// how many taken-in seals have a depth, so a build with none is skipped
	deep: number
}

export function createDevice(
	// join: how long, in ms, the parts of an ephemeral payload may wait for the rest
	options: {
		// its key must be Ed25519: Subduction's peer keys are
		signer: Signer
		// signature algorithms beyond the built in Ed25519, for the seals taken in (seal.ts)
		verifiers?: readonly Verifier[]
		lock?: Lock
		service?: string
		join?: number
		// where Subduction keeps what it saves (taken in on save as ever); default: in memory
		storage?: sd.SedimentreeStorage
		// default: everything applies
		check?: Check
		// the integration's: the tables at a fragment's head, packed (snapshot.ts), for its snapshot;
		// undefined: none for this one (the integration decides when one is worth it)
		snapshotOf?: (doc: string, head: Kept) => Uint8Array | undefined
		// the merge rules a snapshot from elsewhere is checked with (a replay to its head); default none
		merges?: Merges
		// default LIMITS
		limits?: Partial<Limits>
	},
): Device {
	const lock = options.lock ?? unlocked
	const service = options.service ?? "ermine"
	const join = options.join ?? 30000
	const check: Check = options.check ?? (() => true)
	const limits: Limits = { ...LIMITS, ...options.limits }
	const documents = new Map<string, Document>()
	const followed = new Set<string>()
	const peers = new Map<string, sd.PeerId>()
	// topics listened on, by their hash's hex: the Topic and who is told
	const topics = new Map<
		string,
		{ topic: sd.Topic; fns: Set<(from: string, bytes: Uint8Array) => void> }
	>()
	// taking in and building, one at a time, in the order asked
	let tail: Promise<unknown> = Promise.resolve()
	let busy = 0
	const trouble: unknown[] = []
	function run<T>(f: () => Promise<T>): Promise<T> {
		busy++
		const p = tail.then(f)
		tail = p.then(() => {}, () => {}).then(() => {
			busy--
		})
		return p
	}
	// work nobody awaits: what it throws waits for idle
	function later(f: () => Promise<void>) {
		run(f).catch((e) => trouble.push(e))
	}
	// what take queued: sealed and stored, or published, one at a time in the order made, so a
	// commit's parents are stored before it
	let out: Promise<void> = Promise.resolve()
	let sending = 0
	function outgoing(f: () => Promise<void>) {
		sending++
		out = out.then(f).catch((e) => void trouble.push(e)).finally(() => void sending--)
	}

	// ---- taking in

	const listeners = new Set<(a: Arrival) => void>()
	const hearers = new Set<(doc: string, from: string, name: Uint8Array) => void>()
	// arrivals the histories' taken listeners told, told on after the add that let them in, so a
	// listener never runs inside a history's add
	const told: Arrival[] = []
	function tell() {
		for (let a; (a = told.shift()) !== undefined;) {
			for (const l of [...listeners]) {
				try {
					l(a)
				} catch (e) {
					trouble.push(e)
				}
			}
		}
		for (let r; (r = released.shift()) !== undefined;) {
			const { d, layer, kept } = r
			outgoing(() => layer === "stored" ? store(d, kept) : publish(d, kept))
		}
		for (let j; (j = judging.shift()) !== undefined;) judge(j.d, j.name)
	}
	// heads with a snapshot hint, taken in by an add: checked by tell, after it
	const judging: { d: Document; name: string }[] = []
	// own takes that waited, let in by an add: sent by tell, after what let them in
	const released: { d: Document; layer: Layer; kept: Kept }[] = []

	// own takes and the check: everything from elsewhere is marked in elsewhere before its history's
	// add, and stays marked until taken in. the history's check asks the integration's only for a
	// marked commit; one not marked is this device's own take (or a seal of it, handed over after),
	// which applied here already, so passes unchecked and is not announced. a commit from elsewhere
	// that waited, let in by an own take, is still marked: checked, and announced
	function document(tree: Uint8Array): Document {
		const key = hex(tree)
		let d = documents.get(key)
		if (d) return d
		const id = "ermine://" + key
		const elsewhere: Record<Layer, Map<string, boolean>> = {
			stored: new Map(),
			ephemeral: new Map(),
		}
		const own: Record<Layer, Set<string>> = { stored: new Set(), ephemeral: new Set() }
		const make = (layer: Layer) => {
			const from = elsewhere[layer]
			const history = createHistory((kept, commit) => {
				if (!from.has(hex(kept.name))) return true
				try {
					return check(id, kept, commit, layer)
				} catch (e) {
					trouble.push(e)
					return "wait"
				}
			}, {
				most: layer === "ephemeral" ? limits.waiting : limits.pending,
				dropped: (n) => (from.delete(n), own[layer].delete(n)),
			})
			history.taken((kept) => {
				const n = hex(kept.name), heard = from.get(n)
				if (layer === "stored" && d!.hints.has(n)) judging.push({ d: d!, name: n })
				if (heard === undefined) {
					if (own[layer].delete(n)) released.push({ d: d!, layer, kept })
					return
				}
				from.delete(n)
				told.push({ doc: id, layer, kept, heard })
			})
			return history
		}
		d = {
			id,
			bytes: tree,
			tree: sd.SedimentreeId.fromBytes(tree),
			topic: sd.Topic.fromBytes(tree),
			histories: { stored: make("stored"), ephemeral: make("ephemeral") },
			elsewhere,
			own,
			names: new Map(),
			seen: new Map(),
			fragments: new Map(),
			snapshots: new Map(),
			hints: new Map(),
			judged: new Set(),
			pending: new Map(),
			refused: new Map(),
			broken: new Map(),
			bad: new Set(),
			locked: new Map(),
			heard: new Map(),
			deep: 0,
		}
		documents.set(key, d)
		return d
	}
	const named = (doc: string) => document(bytesOf(doc))

	// a commit from elsewhere, added to the layer's history, marked until taken in
	function admit(d: Document, layer: Layer, bytes: Uint8Array, name: Uint8Array, heard: boolean) {
		const from = d.elsewhere[layer], n = hex(name)
		const was = from.get(n)
		if (was === undefined) from.set(n, heard)
		const added = d.histories[layer].add(bytes)
		// refused, or here already (not waiting from before): nothing comes of the mark
		if (typeof added === "object" && "refused" in added) from.delete(n)
		else if (added === "passed" && was === undefined) from.delete(n)
	}

	// handed to the histories: its seal is taken in here. own: a seal of this device's own take,
	// which its histories hold already
	function hand(d: Document, it: Sealed, sealed: Uint8Array, ids: string[], own = false) {
		const n = hex(it.name), s = hex(it.stored)
		d.names.set(n, [...d.names.get(n) ?? [], s])
		d.bad.delete(n)
		d.refused.delete(s)
		d.seen.set(s, { name: n, lamport: it.lamport, parents: it.parents.map(hex), sealed, ids })
		if (depth(it.stored) > 0) d.deep++
		if (own) return
		admit(d, "stored", it.bytes, it.name, false)
		// the ephemeral layer's history holds every stored commit too
		admit(d, "ephemeral", it.bytes, it.name, false)
		tell()
	}

	function refuse(d: Document, key: string, code: Code, name?: string) {
		d.pending.delete(key)
		note(limits.refused, d.refused, key, code)
		if (name !== undefined) note(limits.refused, d.bad, name)
	}

	// for each pending seal, until none moves: stuck while a parent is refused or stuck, waiting while
	// a parent's seal is not here; else a commit's parents each one of its commit's parents' stored
	// ids, and each of them one of the commit's (refused, parents), or handed to the histories
	function settle(d: Document) {
		for (let moved = true; moved;) {
			moved = false
			const gone = new Set(d.bad)
			for (const p of d.pending.values()) if (p.stuck) gone.add(hex(p.it.name))
			for (const [head, p] of [...d.pending].sort(([a], [b]) => by(a, b))) {
				const missing = p.parents.filter((x) => !d.names.has(x))
				const stuck = missing.filter((x) => gone.has(x))
				const before = p.stuck?.join()
				p.stuck = stuck.length ? stuck : undefined
				p.waiting = stuck.length || !missing.length ? undefined : missing
				if (p.stuck?.join() !== before) moved = true
				if (missing.length) continue
				const of = p.parents.map((x) => d.names.get(x)!)
				const match = !p.commit ||
					(p.given.every((g) => of.some((ids) => ids.includes(g))) &&
						of.every((ids) => p.given.some((g) => ids.includes(g))))
				if (!match) refuse(d, head, "parents", hex(p.it.name))
				else {
					d.pending.delete(head)
					hand(d, p.it, p.sealed, p.commit ? p.given : of.flat())
				}
				moved = true
			}
		}
	}

	// a seal opened and checked: its commit, as the transport reads it. a SealError: refused
	async function opened(sealed: Uint8Array): Promise<Sealed> {
		const u = await unseal(sealed, options.verifiers)
		const { lamport, parents } = u.commit
		return { name: u.name, bytes: u.bytes, stored: u.stored, lamport, parents }
	}

	// a loose commit's first steps, the lock, the seal, its stored id: what the lock opened and its
	// commit; "wait": the lock cannot open it yet; undefined: refused, noted
	async function opening(
		d: Document,
		h: string,
		blob: Uint8Array,
	): Promise<{ open: Uint8Array; it: Sealed } | "wait" | undefined> {
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if ("wait" in open) return "wait"
			refuse(d, h, "lock"), settle(d)
			return
		}
		let it: Sealed
		try {
			it = await opened(open)
		} catch (e) {
			if (!(e instanceof SealError)) throw e
			refuse(d, h, e.code)
			return
		}
		if (hex(it.stored) !== h) return void (refuse(d, h, "stored", hex(it.name)), settle(d))
		return { open, it }
	}

	// the steps of a loose commit, in order: the lock, the seal, its stored id, then pending
	async function commit(d: Document, head: Uint8Array, parents: Uint8Array[], blob: Uint8Array) {
		const h = hex(head)
		if (d.seen.has(h)) return
		d.locked.delete(h)
		const got = await opening(d, h, blob)
		if (got === undefined) return
		if (got === "wait") {
			d.refused.delete(h)
			d.locked.set(h, { commit: true, again: () => commit(d, head, parents, blob) })
			return
		}
		d.refused.delete(h)
		pend(d, h, {
			commit: true,
			it: got.it,
			sealed: got.open,
			parents: got.it.parents.map(hex),
			given: parents.map(hex).sort(by),
		})
		settle(d)
	}

	// what Subduction may store of a loose commit (its admission): one that opens to a seal under
	// its stored id, or waits on the lock. what is refused is noted, as taking it in notes it
	async function allows(d: Document, head: Uint8Array, blob: Uint8Array): Promise<boolean> {
		const h = hex(head)
		return d.seen.has(h) || await opening(d, h, blob) !== undefined
	}

	// pending, the oldest let go of past limits.pending (heard again, it comes in again)
	function pend(d: Document, key: string, p: Pending) {
		if (!d.pending.has(key) && d.pending.size >= limits.pending) {
			d.pending.delete(d.pending.keys().next().value!)
		}
		d.pending.set(key, p)
	}

	// a seal taken in as a fragment's member, unsealed: no commit around it
	function member(d: Document, m: Member) {
		const s = hex(m.it.stored)
		if (d.seen.has(s)) return
		d.refused.delete(s)
		pend(d, s, {
			commit: false,
			it: m.it,
			sealed: m.sealed,
			parents: m.it.parents.map(hex),
			given: [],
		})
	}

	// a fragment's blob opened: {run: its members as columns (run.ts), snapshot?: packed tables}, or
	// {members: [sealed…], snapshot?} as it was first written. each member unsealed as it is read,
	// in order: the first that is not good ends it, and the fragment is refused whole with its code
	// (a run that is not one, or comes to too much: shape). the snapshot dropped when it does not
	// read back
	async function contents(
		open: Uint8Array,
	): Promise<{ members: Member[]; snapshot?: Uint8Array } | Code> {
		let x: unknown
		try {
			x = cbor.decode(open)
		} catch (e) {
			if (e instanceof cbor.CborError) return "shape"
			throw e
		}
		if (x === null || typeof x !== "object" || Array.isArray(x) || ArrayBuffer.isView(x)) {
			return "shape"
		}
		const o = x as Record<string, unknown>
		const keys = Object.keys(o).sort().join()
		let seals: Iterable<unknown>
		if (keys === "run" || keys === "run,snapshot") {
			if (!(o.run instanceof Uint8Array)) return "shape"
			seals = eachRun(o.run)
		} else if (keys === "members" || keys === "members,snapshot") {
			if (!Array.isArray(o.members)) return "shape"
			seals = o.members
		} else return "shape"
		const members: Member[] = []
		try {
			for (const sealed of seals) {
				if (!(sealed instanceof Uint8Array)) return "shape"
				members.push({ sealed, it: await opened(sealed) })
			}
		} catch (e) {
			if (e instanceof RunError) return "shape"
			if (e instanceof SealError) return e.code
			throw e
		}
		const snapshot = o.snapshot
		if (snapshot === undefined) return { members }
		if (!(snapshot instanceof Uint8Array)) return "shape"
		try {
			tablesOf(snapshot)
		} catch {
			return { members }
		}
		return { members, snapshot }
	}

	// a fragment's contents, checked against what Subduction says of it: its head one of its members;
	// its head of depth 1 or more, every other member of less depth, and reached from the head along
	// parents among the members; its boundary of the head's depth or more and none of its members; its
	// checkpoints (their first 12 bytes; given as Subduction keeps them, or none said) each member but
	// the head with a depth. a head here whose walk can be made here: its members and boundary that
	// walk's. a code: refused
	async function checked(
		d: Document,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[] | undefined,
		open: Uint8Array,
	): Promise<{ members: Member[]; snapshot?: Uint8Array } | Code> {
		const got = await contents(open)
		if (typeof got === "string") return got
		const h = hex(head), top = depth(head)
		if (!got.members.some((m) => hex(m.it.stored) === h)) return "stored"
		const ids = new Set(got.members.map((m) => hex(m.it.stored)))
		if (top === 0 || reach(head, got.members).size !== ids.size) return "boundary"
		for (const m of got.members) {
			if (hex(m.it.stored) !== h && depth(m.it.stored) >= top) return "boundary"
		}
		for (const b of boundary) if (depth(b) < top || ids.has(hex(b))) return "boundary"
		if (checkpoints !== undefined) {
			const want = new Set<string>()
			for (const id of ids) if (id !== h && depth(unhex(id)) > 0) want.add(id.slice(0, 24))
			const given = new Set(checkpoints.map((c) => hex(c.subarray(0, 12))))
			if (want.size !== given.size || [...want].some((c) => !given.has(c))) return "boundary"
		}
		if (d.seen.has(h)) {
			let w: Fragment | undefined
			try {
				w = walk(head, lookupOf(d), (x) => d.fragments.get(hex(x)))
			} catch (e) {
				if (!(e instanceof FragmentError)) throw e
			}
			const set = (xs: Uint8Array[]) => [...new Set(xs.map(hex))].sort(by).join()
			if (
				w && (set(w.members) !== [...ids].sort(by).join() || set(w.boundary) !== set(boundary))
			) {
				return "boundary"
			}
		}
		return got
	}

	// a commit's parents, by stored id, as fragments are walked
	const lookupOf = (d: Document) => (id: Uint8Array) => d.seen.get(hex(id))?.ids.map(unhex)

	// the stored ids of the members reached from the head, along each one's parents (by name) among
	// the members
	function reach(head: Uint8Array, members: Member[]): Set<string> {
		const byName = new Map<string, Member[]>()
		for (const m of members) {
			const n = hex(m.it.name)
			byName.set(n, [...byName.get(n) ?? [], m])
		}
		const reached = new Set<string>(), todo = members.filter((m) => same(m.it.stored, head))
		for (let m; (m = todo.pop()) !== undefined;) {
			const s = hex(m.it.stored)
			if (reached.has(s)) continue
			reached.add(s)
			for (const p of m.it.parents) todo.push(...byName.get(hex(p)) ?? [])
		}
		return reached
	}

	// what Subduction may store of a fragment (its admission): one that opens and is checked, or
	// waits on the lock. one whose head is not here yet is noted refused whole
	async function allowsFragment(
		d: Document,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[] | undefined,
		blob: Uint8Array,
	): Promise<boolean> {
		const h = hex(head)
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if ("wait" in open) return true
			if (!d.seen.has(h)) broke(d, h, "lock")
			return false
		}
		const got = await checked(d, head, boundary, checkpoints, open)
		if (typeof got !== "string") return true
		if (!d.seen.has(h)) broke(d, h, got)
		return false
	}

	// a fragment refused whole, by head
	function broke(d: Document, h: string, code: Code) {
		note(limits.refused, d.broken, h, code)
	}

	// a snapshot a fragment carried is a hint, checked once: once its head is taken in, the tables
	// are replayed to it, and it is kept only if they are the same; one that is not is let go of, and
	// so is any after it for that head. own: made here, kept as it is. once there is auth: snapshots
	// signed by the fragment's builder (Subduction's issuer), kept if the builder may edit
	function hint(d: Document, name: string, bytes: Uint8Array, own = false) {
		if (d.judged.has(name)) return
		if (own) {
			d.judged.add(name)
			d.snapshots.set(name, bytes)
			return
		}
		if (d.hints.has(name)) return
		note(limits.refused, d.hints, name, bytes)
		judge(d, name)
	}

	// a hint checked, when its head is taken in (replay.ts's matches)
	function judge(d: Document, name: string) {
		const bytes = d.hints.get(name), n = unhex(name)
		if (bytes === undefined || d.histories.stored.get(n) === undefined) return
		d.hints.delete(name)
		d.judged.add(name)
		const history = d.histories.stored
		if (matches(history, n, bytes, (x) => snapshotOf(d, x), options.merges)) {
			d.snapshots.set(name, bytes)
		}
	}

	// the tables at a commit, from a snapshot kept here
	function snapshotOf(d: Document, name: Uint8Array): Tables | undefined {
		if (d.snapshots.size === 0) return undefined
		const bytes = d.snapshots.get(hex(name))
		return bytes === undefined ? undefined : tablesOf(bytes)
	}

	// a fragment taken in: its members (each checked) as seals alone, its snapshot a hint. one whose
	// head is here already has its members checked too, and is only noted
	async function fragment(
		d: Document,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[] | undefined,
		blob: Uint8Array,
	) {
		const h = hex(head)
		const here = d.seen.get(h)
		if (here && d.fragments.has(h) && d.judged.has(here.name)) return
		d.locked.delete("f" + h)
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if (here) {
				if (!d.fragments.has(h)) {
					d.fragments.set(h, { head, members: [], boundary, checkpoints: [] })
				}
			} else if ("wait" in open) {
				d.locked.set("f" + h, {
					commit: false,
					again: () => fragment(d, head, boundary, checkpoints, blob),
				})
			} else broke(d, h, "lock")
			return
		}
		const got = await checked(d, head, boundary, checkpoints, open)
		if (typeof got === "string") {
			if (!here) broke(d, h, got)
			return
		}
		d.broken.delete(h)
		for (const m of got.members) member(d, m)
		if (!d.fragments.has(h)) {
			const members = got.members.map((m) => m.it.stored)
			d.fragments.set(h, { head, members, boundary, checkpoints: [] })
		}
		const top = got.members.find((m) => hex(m.it.stored) === h)!.it.name
		if (got.snapshot !== undefined) hint(d, hex(top), got.snapshot)
		settle(d)
	}

	// an ephemeral commit heard from a device with that key (never sealed): the lock's open, decode
	// (shape), its signer the sender's (signature); then handed to the ephemeral history; never
	// stored, no commit steps
	async function hear(d: Document, blob: Uint8Array, from: Uint8Array) {
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if (!("wait" in open)) note(limits.refused, d.heard, hex(nameOf(blob)), "lock")
			return
		}
		const name = nameOf(open), key = hex(name)
		let c: Commit
		try {
			c = decode(open)
		} catch (e) {
			if (!(e instanceof CommitError)) throw e
			note(limits.refused, d.heard, key, "shape")
			return
		}
		if (hex(c.signer) !== hex(ed25519Key(from))) {
			note(limits.refused, d.heard, key, "signature")
			return
		}
		d.heard.delete(key)
		admit(d, "ephemeral", open, name, true)
		tell()
		for (const fn of [...hearers]) {
			try {
				fn(d.id, hex(c.signer), name)
			} catch (e) {
				trouble.push(e)
			}
		}
	}

	// ---- parts of an ephemeral payload over Subduction's limit

	// by document, sender and whole: the parts here, from when the first came
	const joining = new Map<
		string,
		{
			from: Uint8Array
			whole: Uint8Array
			parts: number
			got: Map<number, Uint8Array>
			at: number
		}
	>()
	const expire = (all = false) => {
		const now = Date.now()
		for (const [k, j] of [...joining]) if (all || now - j.at >= join) joining.delete(k)
	}

	// a payload that is a part: a map of exactly whole, part, parts and bytes. undefined: not one
	// (a commit, or no map); null: one, but its values are not (dropped)
	function partOf(payload: Uint8Array) {
		let x: cbor.Value
		try {
			x = cbor.decode(payload)
		} catch (e) {
			if (e instanceof cbor.CborError) return
			throw e
		}
		if (x === null || typeof x !== "object" || Array.isArray(x) || ArrayBuffer.isView(x)) {
			return
		}
		const m = x as { [key: string]: cbor.Value }
		const keys = Object.keys(m).sort()
		if (keys.join() !== "bytes,part,parts,whole") return
		const { whole, part, parts, bytes } = m
		if (
			!(whole instanceof Uint8Array) || whole.length !== 32 ||
			!(bytes instanceof Uint8Array) ||
			bytes.length > PART || typeof part !== "number" || typeof parts !== "number" ||
			!Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || part >= parts ||
			parts > limits.parts
		) return null
		return { whole, part, parts, bytes }
	}

	// one part from a sender: kept with its whole's; when all are here, joined, the hash checked,
	// and what they make given to done as a payload (a bad hash: dropped). where: the document's id
	// or the topic's hex, to keep the parts of one apart from another's
	async function gather(
		where: string,
		p: NonNullable<ReturnType<typeof partOf>>,
		from: Uint8Array,
		done: (all: Uint8Array) => Promise<void>,
	) {
		expire()
		const k = where + " " + hex(from) + " " + hex(p.whole)
		let j = joining.get(k)
		if (!j) {
			if (joining.size >= limits.joins) joining.delete(joining.keys().next().value!)
			joining.set(
				k,
				j = { from, whole: p.whole, parts: p.parts, got: new Map(), at: Date.now() },
			)
		}
		if (j.parts !== p.parts) return
		if (!j.got.has(p.part)) j.got.set(p.part, p.bytes)
		if (j.got.size < j.parts) return
		joining.delete(k)
		const all = new Uint8Array(
			[...Array(j.parts).keys()].reduce((n, i) => n + j!.got.get(i)!.length, 0),
		)
		let at = 0
		for (let i = 0; i < j.parts; i++) all.set(j.got.get(i)!, at), at += j.got.get(i)!.length
		if (hex(blake3(all)) !== hex(p.whole)) return
		await done(all)
	}

	// ---- building

	// the fragments not built yet, walked from these heads; none given: from every head. each one's
	// blob: its members' seals, in lamport order, and the tables at its head, packed, when the
	// integration gives them
	async function building(d: Document, from?: Uint8Array[]) {
		if (d.deep === 0) return
		const lookup = lookupOf(d)
		let heads = from
		if (heads === undefined) {
			const covered = new Set<string>()
			for (const s of d.seen.keys()) for (const p of lookup(unhex(s)) ?? []) covered.add(hex(p))
			heads = [...d.seen.keys()].filter((s) => !covered.has(s)).map(unhex)
		}
		const fresh = build(heads, lookup, (head) => d.fragments.get(hex(head)))
		for (const f of fresh) d.fragments.set(hex(f.head), f)
		for (const f of fresh) {
			const ms = f.members.map((m) => d.seen.get(hex(m))!)
			ms.sort((a, b) => a.lamport - b.lamport || by(a.name, b.name))
			const top = d.seen.get(hex(f.head))!.name
			const blob: { run: Uint8Array; snapshot?: Uint8Array } = {
				run: packRun(ms.map((m) => m.sealed)),
			}
			const kept = d.histories.stored.get(unhex(top))
			const snapshot = kept && options.snapshotOf?.(d.id, kept)
			if (snapshot) {
				blob.snapshot = snapshot
				hint(d, top, snapshot, true)
			}
			const bytes = cbor.encode(blob as cbor.Value)
			const names = f.boundary.map((b) => unhex(d.seen.get(hex(b))!.name))
				.sort((a, b) => by(hex(a), hex(b)))
			const closed = await lock.close(d.bytes, blake3(bytes), names, bytes)
			await sub.addFragment(
				d.tree,
				commitId(f.head),
				f.boundary.map(commitId),
				f.checkpoints.map(commitId),
				closed,
			)
			await compact(d, f.head)
		}
	}

	// a fragment stored: the loose commits it stands for let go from storage (sedimentree's minimal
	// form, on disk too): the run holds them, about 70 bytes each against about 270. only the members
	// of the fragment the storage holds for that head (Subduction keeps one a head), checked, and
	// reached from its head: whatever is let go of comes back from it
	async function compact(d: Document, head: Uint8Array) {
		const f = await memory.loadFragment(d.tree, commitId(head))
		if (!f) return
		const open = await lock.open(d.bytes, f.blob)
		if (!(open instanceof Uint8Array)) return
		const got = await contents(open)
		if (typeof got === "string") return
		for (const id of reach(head, got.members)) {
			await memory.deleteCommit(d.tree, commitId(unhex(id)))
		}
	}

	// what Subduction's storage is asked to save, taken in; then fragments built
	async function save(
		tree: sd.SedimentreeId,
		commits: { id: sd.CommitId; parents: sd.CommitId[]; blob: Uint8Array }[],
		fragments: Saved[],
	) {
		const d = document(tree.toBytes())
		const deep = d.deep
		for (const c of commits) {
			await commit(d, c.id.toBytes(), c.parents.map((p) => p.toBytes()), c.blob)
		}
		for (const f of fragments) {
			const head = f.head.toBytes()
			await fragment(d, head, f.boundary.map((b) => b.toBytes()), f.checkpoints, f.blob)
			if (d.fragments.get(hex(head))?.members.length) later(() => compact(d, head))
		}
		// only a commit taken in that can head a fragment (a leading zero byte), or a fragment, makes
		// one to build: walking every commit after each would make n commits cost n²
		if (fragments.length || d.deep !== deep) await building(d)
	}

	// ---- sending what take queued

	// a stored commit of this device's: sealed, its seal handed over (taken in already), added as a
	// loose commit; a fragment built when Subduction asks for one (FragmentRequested), from it
	async function store(d: Document, kept: Kept) {
		// this device's own: named already, its signer this one
		const sealed = await seal(kept.bytes, options.signer, { name: kept.name })
		const s = stored(sealed)
		const blob = await lock.close(d.bytes, kept.name, kept.parents, sealed)
		// in the queue, behind the parents' seals handed over before it
		const parents = await run(() => {
			const ids = kept.parents.map((p) => {
				const of = d.names.get(hex(p))
				if (of === undefined) throw new Error("a parent is not taken in")
				return unhex(of[0])
			})
			if (!d.seen.has(hex(s))) {
				const { name, bytes, lamport } = kept
				const it = { name, bytes, stored: s, lamport, parents: kept.parents }
				hand(d, it, sealed, ids.map(hex).sort(by), true)
				// a seal from elsewhere may wait on this one
				settle(d)
			}
			return Promise.resolve(ids)
		})
		const r = await sub.addCommit(d.tree, commitId(s), parents.map(commitId), blob)
		if (r) await run(() => building(d, [s]))
	}

	// an ephemeral commit of this device's: closed, published, as parts when over LIMIT
	async function publish(d: Document, kept: Kept) {
		const blob = await lock.close(d.bytes, kept.name, kept.parents, kept.bytes)
		if (blob.length <= LIMIT) return await sub.publishEphemeral(d.topic, blob)
		const whole = blake3(blob), parts = Math.ceil(blob.length / PART)
		for (let i = 0; i < parts; i++) {
			const bytes = blob.subarray(i * PART, (i + 1) * PART)
			await sub.publishEphemeral(d.topic, cbor.encode({ whole, part: i, parts, bytes }))
		}
	}

	// ---- Subduction

	const memory = options.storage ?? new sd.MemoryStorage()
	// a fragment's checkpoints, as their first 12 bytes
	const checkpointsOf = (f: sd.Fragment) =>
		(f.checkpoints as unknown as { toBytes(): Uint8Array }[]).map((c) => c.toBytes())

	// Subduction's storage, wrapped: it stores only what ermine admits (allows, allowsFragment),
	// and what it stores is then taken in. one not admitted is refused (a throw), noted as refused
	const storage = new Proxy(memory as sd.MemoryStorage, {
		get(target, key) {
			const f = (target as unknown as Record<string | symbol, unknown>)[key]
			if (typeof f !== "function") return f
			if (key === "saveCommit") {
				return async (
					tree: sd.SedimentreeId,
					id: sd.CommitId,
					signed: sd.SignedLooseCommit,
					blob: Uint8Array,
				) => {
					const parents = signed.payload.parents
					if (!(await allows(document(tree.toBytes()), id.toBytes(), blob))) {
						throw new Error("not admitted: refused by ermine")
					}
					await target.saveCommit(tree, id, signed, blob)
					later(() => save(tree, [{ id, parents, blob }], []))
				}
			}
			if (key === "saveFragment") {
				return async (
					tree: sd.SedimentreeId,
					head: sd.CommitId,
					signed: sd.SignedFragment,
					blob: Uint8Array,
				) => {
					const { boundary } = signed.payload, checkpoints = checkpointsOf(signed.payload)
					const d = document(tree.toBytes()), b = boundary.map((x) => x.toBytes())
					if (!(await allowsFragment(d, head.toBytes(), b, checkpoints, blob))) {
						throw new Error("not admitted: refused by ermine")
					}
					await target.saveFragment(tree, head, signed, blob)
					later(() => save(tree, [], [{ head, boundary, checkpoints, blob }]))
				}
			}
			if (key === "saveBatchAll") {
				return async (
					tree: sd.SedimentreeId,
					commits: {
						commitId: sd.CommitId
						signedCommit: sd.SignedLooseCommit
						blob: Uint8Array
					}[],
					fragments: {
						fragmentHead: sd.CommitId
						signedFragment: sd.SignedFragment
						blob: Uint8Array
					}[],
				) => {
					const d = document(tree.toBytes())
					const okCommits = [], okFragments = []
					for (const c of commits) {
						if (await allows(d, c.commitId.toBytes(), c.blob)) okCommits.push(c)
					}
					for (const f of fragments) {
						const p = f.signedFragment.payload
						const b = p.boundary.map((x) => x.toBytes())
						if (
							await allowsFragment(d, f.fragmentHead.toBytes(), b, checkpointsOf(p), f.blob)
						) {
							okFragments.push(f)
						}
					}
					const cs = okCommits.map((c) => ({
						id: c.commitId,
						parents: c.signedCommit.payload.parents,
						blob: c.blob,
					}))
					const fs = okFragments.map((f) => ({
						head: f.fragmentHead,
						boundary: f.signedFragment.payload.boundary,
						checkpoints: checkpointsOf(f.signedFragment.payload),
						blob: f.blob,
					}))
					const n = await target.saveBatchAll(tree, okCommits as never, okFragments as never)
					later(() => save(tree, cs, fs))
					return n
				}
			}
			return f.bind(target)
		},
	}) as unknown as sd.SedimentreeStorage

	const own = splitKey(options.signer.key)
	if (own?.code !== ED25519) throw new Error("a device's key is Ed25519")
	const sub = new sd.Subduction({
		signer: { sign: (m) => options.signer.sign(m), verifyingKey: () => own.key },
		storage,
		onEphemeral: (topic: sd.Topic, from: sd.PeerId, payload: Uint8Array) => {
			const t = topic.toBytes(), k = hex(t), d = documents.get(k)
			const part = partOf(payload)
			// a channel topic (hashed, so never a document's) goes to its listeners
			const c = topics.get(k)
			if (c && !d) {
				const who = hex(ed25519Key(from.toBytes()))
				const tell = (bytes: Uint8Array) => {
					for (const fn of [...c.fns]) fn(who, bytes)
					return Promise.resolve()
				}
				if (part === undefined) tell(payload)
				else if (part) later(() => gather(k, part, from.toBytes(), tell))
				return
			}
			if (!d || !followed.has(k)) return
			if (part === undefined) later(() => hear(d, payload, from.toBytes()))
			else if (part) {
				later(() => gather(d.id, part, from.toBytes(), (all) => hear(d, all, from.toBytes())))
			}
		},
	})

	// starting: what the storage holds, taken in before any connection. read from the storage
	// itself, not through the wrapper, so nothing is saved again. ephemeral commits are never
	// stored, so none come back
	const loaded = run(async () => {
		for (const tree of await memory.loadAllSedimentreeIds()) {
			const d = document(tree.toBytes())
			for (const f of await memory.loadAllFragments(tree)) {
				const signed = f.signed
				await fragment(
					d,
					signed.payload.head.toBytes(),
					signed.payload.boundary.map((b: sd.CommitId) => b.toBytes()),
					checkpointsOf(signed.payload),
					f.blob,
				)
			}
			for (const c of await memory.loadAllCommits(tree)) {
				const signed = c.signed
				await commit(
					d,
					signed.payload.commitId.toBytes(),
					signed.payload.parents.map((p: sd.CommitId) => p.toBytes()),
					c.blob,
				)
			}
			await building(d)
		}
	})
	loaded.catch(() => {})

	// a channel's topic: BLAKE3 of "ermine/v0/topic" then the topic's CBOR, so never a document's
	function channelTopic(name: string) {
		const prefix = new TextEncoder().encode("ermine/v0/topic"), tail = cbor.encode(name)
		const id = blake3(Uint8Array.from([...prefix, ...tail])), k = hex(id)
		let c = topics.get(k)
		if (!c) topics.set(k, c = { topic: sd.Topic.fromBytes(id), fns: new Set() })
		return c
	}

	// every ephemeral topic this device has subscribed to, by its bytes: subscribed again on each
	// connection made after (a subscription reaches only the connections there when it is made)
	const wanted = new Map<string, sd.Topic>()
	async function subscribe(t: sd.Topic) {
		const k = hex(t.toBytes())
		if (wanted.has(k)) return
		wanted.set(k, t)
		await sub.subscribeEphemeral([t])
	}
	const again = async () => {
		if (wanted.size) await sub.subscribeEphemeral([...wanted.values()])
	}

	// the document fetched from every peer, subscribed; then once more subscribed: what was added
	// while the first was out (or before it was asked) is in neither its answer nor a push
	async function fetched(d: Document) {
		await sub.syncWithAllPeers(d.tree, true)
		await sub.syncWithAllPeers(d.tree, true)
	}

	// a followed document asked for again, a while later each time: the server pushes a commit to its
	// subscribers before it stores it, so an ask that lands between is answered without it and hears
	// no push. asked twice more whatever it holds, then on while it holds nothing or a commit waits
	// on a parent; after the last step, every last step while a commit waits
	const backoff = [250, 500, 1000, 2000, 4000, 8000, 16000]
	const timers = new Set<ReturnType<typeof setTimeout>>()
	let closed = false
	const worth = (d: Document, i: number) => {
		const h = d.histories.stored
		return i < 2 || (i < backoff.length && h.all().length === 0) || waits(d)
	}
	// whether a commit waits on a parent: a seal held here for its parents' seals, or a commit in the
	// stored history
	const waits = (d: Document) =>
		[...d.pending.values()].some((p) => p.waiting) || d.histories.stored.waiting().length > 0
	function asking(d: Document, i = 0) {
		if (closed || !worth(d, i)) return
		const t = setTimeout(() => {
			timers.delete(t)
			if (closed || !worth(d, i)) return
			fetched(d).catch((e) => trouble.push(e)).finally(() => asking(d, i + 1))
		}, backoff[Math.min(i, backoff.length - 1)])
		timers.add(t)
	}

	// what a put gave, or nothing when the storage did not admit it (noted refused as it was)
	async function admitted<T>(p: Promise<T>): Promise<T | undefined> {
		try {
			return await p
		} catch (e) {
			if (String(e).includes("not admitted")) return undefined
			throw e
		}
	}

	const device: Device = {
		ready: () => loaded,
		async connect(transport, initiator) {
			await loaded
			const peer = initiator
				? await sub.connectTransport(transport, service)
				: await sub.acceptTransport(transport, service)
			peers.set(hex(peer.toBytes()), peer)
			await again()
			for (const doc of followed) await fetched(documents.get(doc)!)
		},
		async connectDiscover(url, service) {
			await loaded
			const peer = service === undefined
				? await sub.connectDiscover(new URL(url))
				: await sub.connectDiscover(new URL(url), service)
			peers.set(hex(peer.toBytes()), peer)
			await again()
			for (const doc of followed) await fetched(documents.get(doc)!)
		},
		async disconnect(key) {
			// the peer by its Ed25519 key: the multikey's
			const raw = splitKey(key)?.key
			if (raw === undefined) return
			const peer = peers.get(hex(raw)) ?? new sd.PeerId(raw)
			peers.delete(hex(raw))
			await sub.disconnectFromPeer(peer)
		},
		async follow(doc) {
			await loaded
			const d = named(doc)
			followed.add(hex(d.bytes))
			await subscribe(d.topic)
			await fetched(d)
			asking(d)
		},
		history: (doc, layer = "stored") => named(doc).histories[layer],
		take(doc, bytes, layer, made) {
			const d = named(doc)
			const history = d.histories[layer]
			const added = history.add(bytes, made)
			if (layer === "stored") d.histories.ephemeral.add(bytes, made)
			// only what is taken goes out: one passed is here already, one refused would be refused
			// by a receiver too, one waiting on a parent goes once it is let in
			const name = made?.name ?? nameOf(bytes)
			if (added === "taken") {
				const kept = history.get(name)!
				outgoing(() => layer === "stored" ? store(d, kept) : publish(d, kept))
			} else if (typeof added === "object" && "waiting" in added) d.own[layer].add(hex(name))
			// an own take may let in what waited on it: from elsewhere, told; its own, sent after it
			tell()
			return added
		},
		arrived(listener) {
			listeners.add(listener)
			return () => void listeners.delete(listener)
		},
		heard(listener) {
			hearers.add(listener)
			return () => void hearers.delete(listener)
		},
		again(doc, name) {
			const d = named(doc)
			const kept = d.histories.ephemeral.get(name)
			if (kept === undefined || d.histories.stored.get(name) !== undefined) return false
			outgoing(() => publish(d, kept))
			return true
		},
		forget(doc, name) {
			const d = named(doc), n = hex(name)
			if (d.histories.stored.get(name) !== undefined) return false
			if (!d.histories.ephemeral.forget(name)) return false
			d.elsewhere.ephemeral.delete(n)
			d.own.ephemeral.delete(n)
			d.heard.delete(n)
			return true
		},
		snapshot: (doc, name) => snapshotOf(named(doc), name),
		async send(topic, bytes) {
			const t = channelTopic(topic).topic
			// a server relays a publish only from a subscriber of its topic
			await subscribe(t)
			if (bytes.length <= LIMIT && partOf(bytes) === undefined) {
				return await sub.publishEphemeral(t, bytes)
			}
			// a payload that looks like a part is sent as parts too, so it arrives as it was sent
			const whole = blake3(bytes), parts = Math.max(1, Math.ceil(bytes.length / PART))
			for (let i = 0; i < parts; i++) {
				const part = bytes.subarray(i * PART, (i + 1) * PART)
				await sub.publishEphemeral(t, cbor.encode({ whole, part: i, parts, bytes: part }))
			}
		},
		listen(topic, fn) {
			const c = channelTopic(topic)
			c.fns.add(fn)
			later(() => subscribe(c.topic))
			return () => void c.fns.delete(fn)
		},
		async stored(doc) {
			const cs = await sub.getCommits(named(doc).tree)
			return (cs ?? []).map((c) => c.commitId.toBytes())
		},
		fragments: (doc) => [...named(doc).fragments.values()],
		async changed() {
			for (const d of documents.values()) {
				for (const [, l] of [...d.locked]) await run(() => l.again())
				await run(() => {
					for (const layer of ["stored", "ephemeral"] as const) d.histories[layer].again()
					tell()
					return Promise.resolve()
				})
				await run(() => building(d))
			}
		},
		expire: () => expire(true),
		async idle() {
			while (busy > 0 || sending > 0) await Promise.all([tail, out])
			if (trouble.length) throw trouble.shift()
		},
		async close() {
			closed = true
			for (const t of timers) clearTimeout(t)
			timers.clear()
			await device.idle().catch(() => {})
			await sub.disconnectAll()
		},
	}
	hooks(device, {
		async put(doc, head, parents, blob) {
			const d = named(doc)
			const r = await admitted(
				sub.addCommit(d.tree, commitId(head), parents.map(commitId), blob),
			)
			if (r) await run(() => building(d))
		},
		async putFragment(doc, head, boundary, checkpoints, blob) {
			const d = named(doc)
			await admitted(sub.addFragment(
				d.tree,
				commitId(head),
				boundary.map(commitId),
				checkpoints.map(commitId),
				blob,
			))
			await run(() => building(d))
		},
		taking(doc, layer) {
			const d = named(doc)
			if (layer === "ephemeral") {
				return {
					waiting: [],
					refused: [...d.heard].sort(([a], [b]) => by(a, b)).map(([commit, refused]) => ({
						commit,
						refused,
					})),
				}
			}
			const waiting: Taking["waiting"] = []
			const refused: (Taking["refused"][number] & { key: string })[] = []
			for (const [commit, p] of d.pending) {
				if (p.waiting) waiting.push({ commit, waiting: p.waiting })
				else if (p.stuck) refused.push({ key: commit, commit, stuck: p.stuck })
			}
			for (const [commit, c] of d.locked) if (c.commit) waiting.push({ commit, waiting: [] })
			for (const [commit, code] of d.refused) {
				refused.push({ key: commit, commit, refused: code })
			}
			for (const [head, code] of d.broken) {
				refused.push({ key: head, fragment: head, refused: code })
			}
			return {
				waiting: waiting.sort((a, b) => by(a.commit, b.commit)),
				refused: refused.sort((a, b) => by(a.key, b.key)).map(({ key: _, ...r }) => r),
			}
		},
	})
	return device
}
