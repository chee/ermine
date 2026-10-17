// Blops over Subduction (TRANSPORT.tex): stored ones, sealed, as loose commits and fragments, ephemeral
// ones, never sealed, as its ephemeral messages; and what a device checks of what arrives before its
// histories see it.
// Reference for the conformance in extensions/subduction/conformance/subduction-transport. Only the lock "unlocked" is built
import * as sd from "npm:@automerge/subduction@0.23.0"
import { blake3 } from "@ermine/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { type Blop, BlopError, decode, name as blopName } from "@ermine/encoding/blop"
import { check } from "./apply.ts"
import { type Added, createHistories, type Histories } from "./history.ts"
import { build, depth, type Fragment } from "./fragment.ts"
import { bytes as idbytes } from "./id.ts"
import { SealError, type Signer, stored, unseal, type Unsealed } from "./seal.ts"

export type Layer = "stored" | "ephemeral"

// a blop this device made: decoded, and its name
export type Made = { blop: Blop; name: Uint8Array }

// what a lock's open gives (LOCK.tex): the bytes close was given; not yet; or never
export type Opened = Uint8Array | { wait: true } | { refused: string }

// the part of a lock transport calls (LOCK.tex); doc: the bytes its make gave
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

export type Code = "lock" | "shape" | "signature" | "stored" | "document" | "parents"

export type Taking = {
	waiting: { commit: string; waiting: string[] }[]
	refused: (
		| { commit: string; refused: Code }
		| { commit: string; stuck: string[] }
		| { fragment: string; refused: Code }
	)[]
}

// a blop that came to be taken in to a history, from the network or storage (heard: an ephemeral
// message), or that waited there on one that did
export type Arrival = {
	doc: string
	layer: Layer
	blop: Blop
	name: Uint8Array
	heard: boolean
}

// Starting: createDevice returns at once, and begins taking in everything the storage holds (every
// fragment, then every loose commit, as a save is taken in; a commit whose parents come later waits,
// as ever). Everything that touches the network (connect, connectDiscover, follow) waits for that;
// add, put and the other work queue behind it. ready() resolves when it is done; it throws what
// the storage threw. lazy: the storage's documents are only listed at the start; each is taken in
// (fragments, then loose commits, as above) when follow names it, before follow fetches it.
export type Device = {
	ready(): Promise<void>
	// resolves once connected; the documents followed are fetched after (idle waits for that)
	connect(transport: sd.Transport, initiator: boolean): Promise<void>
	// a server by its WebSocket url, by discovery (the service name its url's host, unless given);
	// resolves once connected, as connect
	connectDiscover(url: string, service?: string): Promise<void>
	disconnect(key: Uint8Array): Promise<void>
	follow(doc: string): Promise<void>
	histories(doc: string, layer?: Layer): Histories
	// a stored blop of this device's: taken in, added as a loose commit, fragments built. made: its
	// blop, name and stored id, from the code that took it in and sealed it: its seal is handed to
	// the histories before addCommit, so its save is passed over; not unsealed, checked or taken
	// in again
	add(sealed: Uint8Array, made?: Made & { stored: Uint8Array }): Promise<void>
	// a blop this device made, its bytes, not yet sealed, into that layer's histories at once and
	// synchronously (WIRING.tex): add and publish then pass over the name already taken in. A stored
	// blop goes into the ephemeral layer's histories too. Answers as the histories do. Not announced
	// made: its blop decoded and its name, from the code that encoded it: not decoded or named again
	take(doc: string, blop: Uint8Array, layer: Layer, made?: Made): Added
	// told each blop taken in from elsewhere to a history, after it is taken in
	arrived(listener: (arrival: Arrival) => void): void
	// an ephemeral one, the blop's bytes, not sealed, as given: taken in (refused as a receiver would
	// refuse it, but still sent), published
	publish(doc: string, blop: Uint8Array): Promise<void>
	// bytes to whoever listens on a topic (a string, named by hash so it is never a document's):
	// ephemeral, kept nowhere, not heard here. over LIMIT: sent as parts, joined at the other end
	send(topic: string, bytes: Uint8Array): Promise<void>
	// fn told each message on the topic: the sender's verifying key as lowercase hex, the bytes.
	// subscribes as needed (queued: idle() waits for it); gives back the stop, which only removes fn
	listen(topic: string, fn: (from: string, bytes: Uint8Array) => void): () => void
	// addCommit as given: nothing checked or taken in first
	put(doc: string, head: Uint8Array, parents: Uint8Array[], blob: Uint8Array): Promise<void>
	// addFragment as given: nothing checked or taken in first
	putFragment(
		doc: string,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[],
		blob: Uint8Array,
	): Promise<void>
	taking(doc: string, layer?: Layer): Taking
	fragments(doc: string): Fragment[]
	stored(doc: string): Promise<Uint8Array[]>
	// the lock's changed(): what waited on it is tried again
	changed(): Promise<void>
	// an ephemeral payload's parts not joined yet are dropped now, as the setting would in time
	expire(): void
	// resolves when no fetching after a connection, taking in or building is left; throws what one
	// of them threw
	idle(): Promise<void>
	close(): Promise<void>
}

// Subduction drops an ephemeral payload over this; a closed blop over it is sent as parts of at most
// PART bytes (TRANSPORT.tex, Ephemeral blops)
export const LIMIT = 65536
export const PART = 60000

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const by = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const commitId = (b: Uint8Array) => new sd.CommitId(b)

// a taken-in seal: its name, blop, sealed bytes, its blop's parents' names, and the stored ids of
// the seals it was taken in over (the commit's parents; or, for a seal alone, every seal of each)
type Seen = { name: string; blop: Blop; sealed: Uint8Array; parents: string[]; ids: string[] }

// a loose commit, or a seal alone (a fragment's member), not yet handed to the histories: its parents
// not all here, or one refused. given: the commit's parents' stored ids, sorted
type Pending = {
	commit: boolean
	unsealed: Unsealed
	sealed: Uint8Array
	parents: string[]
	given: string[]
}

type Document = {
	id: string
	bytes: Uint8Array
	tree: sd.SedimentreeId
	topic: sd.Topic
	histories: Record<Layer, Histories>
	// a taken-in seal's name to its stored ids: a signer may have signed twice
	names: Map<string, string[]>
	seen: Map<string, Seen>
	fragments: Map<string, Fragment>
	// by the commit's head, or the seal's stored id
	pending: Map<string, Pending & { waiting?: string[]; stuck?: string[] }>
	refused: Map<string, Code>
	// fragments refused whole, by head
	broken: Map<string, Code>
	// names of seals refused here
	bad: Set<string>
	// waiting on the lock: tried again by changed
	locked: Map<string, { commit: boolean; again(): Promise<void> }>
	// refused ephemeral blops, by their blop's name (BLAKE3 of what the lock opened)
	heard: Map<string, Code>
	// how many taken-in seals have a depth, so a build with none is skipped
	deep: number
	// settle's index: a blop name to the pending seals with it among their parents; pending seals
	// new or changed since settle last ran, and names taken in, refused or stuck since; how many
	// stuck pending seals have each name
	waiters: Map<string, Set<string>>
	dirty: Set<string>
	moved: Set<string>
	stuck: Map<string, number>
}

export function createDevice(
	// join: how long, in ms, the parts of an ephemeral payload may wait for the rest
	options: {
		signer: Signer
		lock?: Lock
		service?: string
		join?: number
		// where Subduction keeps what it saves (taken in on save as ever); default: in memory
		storage?: sd.SedimentreeStorage
		// what the storage holds is taken in a document at a time, when follow names it, not all
		// at the start: a stored document nobody follows never comes in
		lazy?: boolean
	},
): Device {
	const lock = options.lock ?? unlocked
	const service = options.service ?? "ermine"
	const join = options.join ?? 30000
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

	function document(tree: Uint8Array): Document {
		const key = hex(tree)
		let d = documents.get(key)
		if (d) return d
		const id = "ermine://" + key
		const make = () => createHistories(id, check)
		d = {
			id,
			bytes: tree,
			tree: sd.SedimentreeId.fromBytes(tree),
			topic: sd.Topic.fromBytes(tree),
			histories: { stored: make(), ephemeral: make() },
			names: new Map(),
			seen: new Map(),
			fragments: new Map(),
			pending: new Map(),
			refused: new Map(),
			broken: new Map(),
			bad: new Set(),
			locked: new Map(),
			heard: new Map(),
			deep: 0,
			waiters: new Map(),
			dirty: new Set(),
			moved: new Set(),
			stuck: new Map(),
		}
		documents.set(key, d)
		return d
	}
	const named = (doc: string) => document(idbytes(doc))

	// ---- taking in

	const listeners: ((arrival: Arrival) => void)[] = []
	// blops added that wait in a history, by name, to find out which a later one lets in
	const waits = new WeakMap<Histories, Map<string, Blop>>()

	// added to the layer's histories; the blops it let in (itself, those that waited on it)
	function admit(d: Document, layer: Layer, blop: Blop, name: Uint8Array, heard = false) {
		const histories = d.histories[layer]
		const added = histories.add(blop, name)
		if (listeners.length === 0) return []
		let held = waits.get(histories)
		if (!held) waits.set(histories, held = new Map())
		const out: Arrival[] = []
		if (added === "taken") out.push({ doc: d.id, layer, blop, name, heard })
		else if (typeof added === "object" && "waiting" in added) held.set(hex(name), blop)
		for (const [n, b] of [...held]) {
			if (!histories.get(unhex(n))) continue
			held.delete(n)
			if (n !== hex(name)) out.push({ doc: d.id, layer, blop: b, name: unhex(n), heard })
		}
		return out
	}
	const announce = (arrivals: Arrival[]) => {
		for (const a of arrivals) for (const l of listeners) l(a)
	}

	// handed to the histories: its seal is taken in here
	function hand(d: Document, u: Unsealed, sealed: Uint8Array, ids: string[]) {
		const n = hex(u.name), s = hex(u.stored)
		d.names.set(n, [...d.names.get(n) ?? [], s])
		d.bad.delete(n)
		d.moved.add(n)
		d.refused.delete(s)
		d.seen.set(s, { name: n, blop: u.blop, sealed, parents: u.blop.parents.map(hex), ids })
		if (depth(u.stored) > 0) d.deep++
		const arrivals = admit(d, "stored", u.blop, u.name)
		// the ephemeral layer's histories hold every stored blop too
		arrivals.push(...admit(d, "ephemeral", u.blop, u.name))
		announce(arrivals)
	}

	function refuse(d: Document, key: string, code: Code, name?: string) {
		unpend(d, key)
		d.refused.set(key, code)
		if (name !== undefined) d.bad.add(name), d.moved.add(name)
	}

	// a seal held back: in the index under each of its parents, looked at by the next settle
	function pend(d: Document, key: string, p: Pending) {
		unpend(d, key)
		d.pending.set(key, p)
		for (const x of p.parents) {
			let w = d.waiters.get(x)
			if (!w) d.waiters.set(x, w = new Set())
			w.add(key)
		}
		d.dirty.add(key)
	}

	function unpend(d: Document, key: string) {
		const p = d.pending.get(key)
		if (!p) return
		for (const x of p.parents) {
			const w = d.waiters.get(x)
			w?.delete(key)
			if (w?.size === 0) d.waiters.delete(x)
		}
		if (p.stuck) stick(d, hex(p.unsealed.name), -1)
		d.pending.delete(key)
	}

	function stick(d: Document, name: string, by: 1 | -1) {
		const n = (d.stuck.get(name) ?? 0) + by
		if (n) d.stuck.set(name, n)
		else d.stuck.delete(name)
		d.moved.add(name)
	}

	// step 5 and on, for the pending seals that may move, until none does: stuck while a parent is
	// refused or stuck, waiting while a parent's seal is not here; else a commit's parents each one
	// of its blop's parents' stored ids, and each of them one of the commit's (refused, parents),
	// or handed to the histories. What may move: a seal new since, or one with a parent taken in,
	// refused, or stuck or no longer stuck since; each round in key order
	function settle(d: Document) {
		const gone = (x: string) => d.bad.has(x) || d.stuck.has(x)
		for (;;) {
			const keys = new Set(d.dirty)
			d.dirty.clear()
			for (const n of d.moved) for (const k of d.waiters.get(n) ?? []) keys.add(k)
			d.moved.clear()
			if (keys.size === 0) return
			for (const head of [...keys].sort(by)) {
				const p = d.pending.get(head)
				if (!p) continue
				const missing = p.parents.filter((x) => !d.names.has(x))
				const stuck = missing.filter(gone)
				const was = p.stuck !== undefined
				p.stuck = stuck.length ? stuck : undefined
				p.waiting = stuck.length || !missing.length ? undefined : missing
				if (was !== (p.stuck !== undefined)) stick(d, hex(p.unsealed.name), was ? -1 : 1)
				if (missing.length) continue
				const of = p.parents.map((x) => d.names.get(x)!)
				const match = !p.commit ||
					(p.given.every((g) => of.some((ids) => ids.includes(g))) &&
						of.every((ids) => p.given.some((g) => ids.includes(g))))
				if (!match) refuse(d, head, "parents", hex(p.unsealed.name))
				else {
					unpend(d, head)
					hand(d, p.unsealed, p.sealed, p.commit ? p.given : of.flat())
				}
			}
		}
	}

	// the steps of a loose commit, in order (TRANSPORT.tex, Taking in)
	async function commit(d: Document, head: Uint8Array, parents: Uint8Array[], blob: Uint8Array) {
		const h = hex(head)
		if (d.seen.has(h)) return
		d.locked.delete(h)
		const opened = await lock.open(d.bytes, blob)
		if (!(opened instanceof Uint8Array)) {
			if ("wait" in opened) {
				d.refused.delete(h)
				d.locked.set(h, { commit: true, again: () => commit(d, head, parents, blob) })
			} else refuse(d, h, "lock"), settle(d)
			return
		}
		let u: Unsealed
		try {
			u = await unseal(opened)
		} catch (e) {
			if (!(e instanceof SealError)) throw e
			refuse(d, h, e.code)
			return
		}
		const n = hex(u.name)
		if (hex(u.stored) !== h) return refuse(d, h, "stored", n), settle(d)
		if (u.blop.node !== d.id) return refuse(d, h, "document", n), settle(d)
		d.refused.delete(h)
		pend(d, h, {
			commit: true,
			unsealed: u,
			sealed: opened,
			parents: u.blop.parents.map(hex),
			given: parents.map(hex).sort(by),
		})
		settle(d)
	}

	// a seal taken in as a fragment's member, its stored id: from unseal on, no commit around it
	async function member(d: Document, sealed: Uint8Array, id: Uint8Array) {
		const s = hex(id)
		if (d.seen.has(s)) return
		let u: Unsealed
		try {
			u = await unseal(sealed, id)
		} catch (e) {
			if (!(e instanceof SealError)) throw e
			d.refused.set(s, e.code)
			return
		}
		if (u.blop.node !== d.id) return refuse(d, s, "document", hex(u.name))
		d.refused.delete(s)
		pend(d, s, {
			commit: false,
			unsealed: u,
			sealed,
			parents: u.blop.parents.map(hex),
			given: [],
		})
	}

	// the members of a fragment's blob, as the sealed changes it lists; undefined: not such a list
	function list(opened: Uint8Array): Uint8Array[] | undefined {
		let x: unknown
		try {
			x = cbor.decode(opened)
		} catch (e) {
			if (e instanceof cbor.CborError) return
			throw e
		}
		if (!Array.isArray(x) || !x.every((m) => m instanceof Uint8Array)) return
		return x as Uint8Array[]
	}

	// FRAGMENT.tex, Taking in
	async function fragment(
		d: Document,
		head: Uint8Array,
		boundary: Uint8Array[],
		blob: Uint8Array,
	) {
		const h = hex(head)
		const here = d.seen.has(h)
		if (here && d.fragments.has(h)) return
		d.locked.delete("f" + h)
		const opened = await lock.open(d.bytes, blob)
		if (!(opened instanceof Uint8Array)) {
			if (here) d.fragments.set(h, { head, members: [], boundary, checkpoints: [] })
			else if ("wait" in opened) {
				d.locked.set("f" + h, { commit: false, again: () => fragment(d, head, boundary, blob) })
			} else d.broken.set(h, "lock")
			return
		}
		const members = list(opened)
		// each member hashed once, here
		const ids = (members ?? []).map(stored)
		if (here) {
			d.fragments.set(h, { head, members: ids, boundary, checkpoints: [] })
			return
		}
		if (members === undefined) {
			d.broken.set(h, "shape")
			return
		}
		if (!ids.some((id) => hex(id) === h)) {
			d.broken.set(h, "stored")
			return
		}
		d.broken.delete(h)
		for (let i = 0; i < members.length; i++) await member(d, members[i], ids[i])
		d.fragments.set(h, { head, members: ids, boundary, checkpoints: [] })
		settle(d)
	}

	// an ephemeral blop heard from a device with that key, or published here (never sealed): the lock's
	// open, decode (shape), its signer the sender's (signature), its document; then handed to the
	// ephemeral histories; never stored, no commit steps
	async function hear(d: Document, blob: Uint8Array, from: Uint8Array) {
		const opened = await lock.open(d.bytes, blob)
		if (!(opened instanceof Uint8Array)) {
			if (!("wait" in opened)) d.heard.set(hex(blopName(blob)), "lock")
			return
		}
		const n = blopName(opened), key = hex(n)
		let blop: Blop
		try {
			blop = decode(opened)
		} catch (e) {
			if (!(e instanceof BlopError)) throw e
			d.heard.set(key, "shape")
			return
		}
		if (hex(blop.signer) !== hex(from)) {
			d.heard.set(key, "signature")
			return
		}
		if (blop.node !== d.id) {
			d.heard.set(key, "document")
			return
		}
		d.heard.delete(key)
		announce(admit(d, "ephemeral", blop, n, true))
	}

	// ---- parts of an ephemeral payload over Subduction's limit (TRANSPORT.tex)

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
	// (a blop, or no map); null: one, but its values are not (dropped)
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
			!Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || part >= parts
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

	// ---- building (FRAGMENT.tex)

	// the fragments not built yet, walked from these heads; none given: from every head
	async function building(d: Document, from?: Uint8Array[]) {
		if (d.deep === 0) return
		const lookup = (id: Uint8Array) => {
			const s = d.seen.get(hex(id))
			if (!s) return
			return s.ids.map(unhex)
		}
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
			ms.sort((a, b) => a.blop.lamport - b.blop.lamport || by(a.name, b.name))
			const bytes = cbor.encode(ms.map((m) => m.sealed))
			const names = f.boundary.map((b) => unhex(d.seen.get(hex(b))!.name))
				.sort((a, b) => by(hex(a), hex(b)))
			const blob = await lock.close(d.bytes, blake3(bytes), names, bytes)
			await sub.addFragment(
				d.tree,
				commitId(f.head),
				f.boundary.map(commitId),
				f.checkpoints.map(commitId),
				blob,
			)
		}
	}

	// what Subduction's storage is asked to save, taken in; then fragments built
	async function save(
		tree: sd.SedimentreeId,
		commits: { id: sd.CommitId; parents: sd.CommitId[]; blob: Uint8Array }[],
		fragments: { head: sd.CommitId; boundary: sd.CommitId[]; blob: Uint8Array }[],
	) {
		const d = document(tree.toBytes())
		const deep = d.deep
		for (const c of commits) {
			await commit(d, c.id.toBytes(), c.parents.map((p) => p.toBytes()), c.blob)
		}
		for (const f of fragments) {
			await fragment(d, f.head.toBytes(), f.boundary.map((b) => b.toBytes()), f.blob)
		}
		// only a commit taken in that can head a fragment (a leading zero byte), or a fragment, makes
		// one to build: walking every commit after each would make n commits cost n²
		if (fragments.length || d.deep !== deep) await building(d)
	}

	// ---- Subduction

	const memory = options.storage ?? new sd.MemoryStorage()
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
					const boundary = signed.payload.boundary
					await target.saveFragment(tree, head, signed, blob)
					later(() => save(tree, [], [{ head, boundary, blob }]))
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
					const cs = commits.map((c) => ({
						id: c.commitId,
						parents: c.signedCommit.payload.parents,
						blob: c.blob,
					}))
					const fs = fragments.map((f) => ({
						head: f.fragmentHead,
						boundary: f.signedFragment.payload.boundary,
						blob: f.blob,
					}))
					const n = await target.saveBatchAll(tree, commits as never, fragments as never)
					later(() => save(tree, cs, fs))
					return n
				}
			}
			return f.bind(target)
		},
	}) as unknown as sd.SedimentreeStorage

	const sub = new sd.Subduction({
		signer: { sign: (m) => options.signer.sign(m), verifyingKey: () => options.signer.key },
		storage,
		onEphemeral: (topic: sd.Topic, from: sd.PeerId, payload: Uint8Array) => {
			const t = topic.toBytes(), k = hex(t), d = documents.get(k)
			const part = partOf(payload)
			// a channel topic (hashed, so never a document's) goes to its listeners
			const c = topics.get(k)
			if (c && !d) {
				const who = hex(from.toBytes())
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

	// starting: what the storage holds, taken in before any connection (TRANSPORT.tex, A device).
	// Read from the storage itself, not through the wrapper, so nothing is saved again. Ephemeral
	// blops are never stored, so none come back. lazy: only the trees listed, each taken in when
	// followed
	const unloaded = new Map<string, sd.SedimentreeId>()
	async function load(tree: sd.SedimentreeId) {
		const d = document(tree.toBytes())
		for (const f of await memory.loadAllFragments(tree)) {
			const signed = f.signed
			await fragment(
				d,
				signed.payload.head.toBytes(),
				signed.payload.boundary.map((b: sd.CommitId) => b.toBytes()),
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
	const loaded = run(async () => {
		for (const tree of await memory.loadAllSedimentreeIds()) {
			if (options.lazy) unloaded.set(hex(tree.toBytes()), tree)
			else await load(tree)
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

	// the document fetched from every peer, subscribed; then once more subscribed: what was added
	// while the first was out (or before it was asked) is in neither its answer nor a push
	async function fetched(d: Document) {
		await sub.syncWithAllPeers(d.tree, true)
		await sub.syncWithAllPeers(d.tree, true)
	}

	// after a connection: the documents followed then, fetched all at once; idle waits for it. One
	// followed later fetches itself, the new peer among every peer
	const fetching = new Set<Promise<void>>()
	function fetchFollowed() {
		const p: Promise<void> = Promise.all(
			[...followed].map((doc) => fetched(documents.get(doc)!)),
		).then(
			() => void fetching.delete(p),
			(e) => void (fetching.delete(p), trouble.push(e)),
		)
		fetching.add(p)
	}

	const device: Device = {
		ready: () => loaded,
		async connect(transport, initiator) {
			await loaded
			const peer = initiator
				? await sub.connectTransport(transport, service)
				: await sub.acceptTransport(transport, service)
			peers.set(hex(peer.toBytes()), peer)
			fetchFollowed()
		},
		async connectDiscover(url, service) {
			await loaded
			const peer = service === undefined
				? await sub.connectDiscover(new URL(url))
				: await sub.connectDiscover(new URL(url), service)
			peers.set(hex(peer.toBytes()), peer)
			fetchFollowed()
		},
		async disconnect(key) {
			const peer = peers.get(hex(key)) ?? new sd.PeerId(key)
			peers.delete(hex(key))
			await sub.disconnectFromPeer(peer)
		},
		async follow(doc) {
			await loaded
			const d = named(doc)
			const tree = unloaded.get(hex(d.bytes))
			if (tree) {
				unloaded.delete(hex(d.bytes))
				await run(() => load(tree))
			}
			followed.add(hex(d.bytes))
			await sub.subscribeEphemeral([d.topic])
			await fetched(d)
		},
		histories: (doc, layer = "stored") => named(doc).histories[layer],
		take(doc, bytes, layer, made) {
			const d = named(doc)
			const blop = made?.blop ?? decode(bytes), n = made?.name ?? blopName(bytes)
			const added = d.histories[layer].add(blop, n)
			if (layer === "stored") d.histories.ephemeral.add(blop, n)
			return added
		},
		arrived: (listener) => void listeners.push(listener),
		async add(sealed, made) {
			const u = made ? { ...made, signer: made.blop.signer } : await unseal(sealed)
			const d = named(u.blop.node)
			const blob = await lock.close(d.bytes, u.name, u.blop.parents, sealed)
			let parents: Uint8Array[] = []
			await run(async () => {
				parents = u.blop.parents.map((p) => {
					const s = d.names.get(hex(p))
					if (s === undefined) throw new Error("a parent is not taken in")
					return unhex(s[0])
				})
				if (!made) await commit(d, u.stored, parents, blob)
				else if (!d.seen.has(hex(u.stored))) hand(d, u, sealed, parents.map(hex).sort(by))
			})
			// Subduction asks for a fragment when the commit is on a boundary (FragmentRequested), and
			// that one is built, from it
			const r = await sub.addCommit(d.tree, commitId(u.stored), parents.map(commitId), blob)
			if (r) await run(() => building(d, [u.stored]))
		},
		async publish(doc, bytes) {
			const d = named(doc)
			let parents: Uint8Array[] = []
			try {
				parents = decode(bytes).parents
			} catch (e) {
				if (!(e instanceof BlopError)) throw e
			}
			const blob = await lock.close(d.bytes, blopName(bytes), parents, bytes)
			await run(() => hear(d, blob, options.signer.key))
			if (blob.length <= LIMIT) return await sub.publishEphemeral(d.topic, blob)
			const whole = blake3(blob), parts = Math.ceil(blob.length / PART)
			for (let i = 0; i < parts; i++) {
				const bytes = blob.subarray(i * PART, (i + 1) * PART)
				await sub.publishEphemeral(d.topic, cbor.encode({ whole, part: i, parts, bytes }))
			}
		},
		async send(topic, bytes) {
			const t = channelTopic(topic).topic
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
			later(() => sub.subscribeEphemeral([c.topic]))
			return () => void c.fns.delete(fn)
		},
		async put(doc, head, parents, blob) {
			const d = named(doc)
			const r = await sub.addCommit(d.tree, commitId(head), parents.map(commitId), blob)
			if (r) await run(() => building(d))
		},
		async putFragment(doc, head, boundary, checkpoints, blob) {
			const d = named(doc)
			await sub.addFragment(
				d.tree,
				commitId(head),
				boundary.map(commitId),
				checkpoints.map(commitId),
				blob,
			)
			await run(() => building(d))
		},
		taking(doc, layer = "stored") {
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
		fragments: (doc) => [...named(doc).fragments.values()],
		async stored(doc) {
			const cs = await sub.getCommits(named(doc).tree)
			return (cs ?? []).map((c) => c.commitId.toBytes())
		},
		async changed() {
			for (const d of documents.values()) {
				for (const [, l] of [...d.locked]) await run(() => l.again())
				await run(() => building(d))
			}
		},
		expire: () => expire(true),
		async idle() {
			while (busy > 0 || fetching.size) {
				await Promise.all(fetching)
				await tail
			}
			if (trouble.length) throw trouble.shift()
		},
		async close() {
			await device.idle().catch(() => {})
			await sub.disconnectAll()
		},
	}
	return device
}
