// Sealed blops over Subduction (TRANSPORT.tex): stored ones as loose commits and fragments, ephemeral
// ones as its ephemeral messages; and what a device checks of what arrives before its chains see it.
// Reference for the conformance in conformance/transport. Only the lock "unlocked" is built
import * as sd from "npm:@automerge/subduction@0.23.0"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "../../encoding/ts/cbor.ts"
import type { Blop } from "../../encoding/ts/blop.ts"
import { check } from "./apply.ts"
import { type Chains, createChains } from "./chain.ts"
import { build, depth, type Fragment } from "./fragment.ts"
import { bytes as idbytes } from "./id.ts"
import { SealError, type Signer, stored, unseal, type Unsealed } from "./seal.ts"

export type Layer = "stored" | "ephemeral"

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

export type Heard = { from: Uint8Array; payload: Uint8Array }
export type Topic = { readable: ReadableStream<Heard>; writable: WritableStream<Uint8Array> }

export type Device = {
	connect(transport: sd.Transport, initiator: boolean): Promise<void>
	disconnect(key: Uint8Array): Promise<void>
	follow(doc: string): Promise<void>
	chains(doc: string, layer?: Layer): Chains
	// a stored blop of this device's: taken in, added as a loose commit, fragments built
	add(sealed: Uint8Array): Promise<void>
	// an ephemeral one: taken in, published
	publish(sealed: Uint8Array): Promise<void>
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
	// a topic (32 bytes, the caller's: a document's id or anything agreed): subscribes, every peer
	// connected now or later. readable: each message heard on it, but a blop of a followed
	// document; writable: each payload, as given, published on it. Both done (cancelled, closed
	// or aborted): unsubscribed
	topic(id: Uint8Array): Topic
	// resolves when no taking in or building is left; throws what one of them threw
	idle(): Promise<void>
	close(): Promise<void>
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const by = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const buffer = (u: Uint8Array) => u.slice().buffer as ArrayBuffer
const commitId = (b: Uint8Array) => new sd.CommitId(b)

// a taken-in seal: its name, blop, sealed bytes, its blop's parents' names, and the stored ids of
// the seals it was taken in over (the commit's parents; or, for a seal alone, every seal of each)
type Seen = { name: string; blop: Blop; sealed: Uint8Array; parents: string[]; ids: string[] }

// a loose commit, or a seal alone (a fragment's member), not yet handed to the chains: its parents
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
	chains: Record<Layer, Chains>
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
	// refused ephemeral blops, by the stored id of their seal
	heard: Map<string, Code>
	// how many taken-in seals have a depth, so a build with none is skipped
	deep: number
}

export function createDevice(
	options: { signer: Signer; lock?: Lock; service?: string },
): Device {
	const lock = options.lock ?? unlocked
	const service = options.service ?? "ermine"
	const documents = new Map<string, Document>()
	const followed = new Set<string>()
	const peers = new Map<string, sd.PeerId>()
	// the open streams of each topic, by its hex
	const streams = new Map<string, Set<ReadableStreamDefaultController<Heard>>>()
	const tell = (topic: Uint8Array, from: Uint8Array, payload: Uint8Array) => {
		for (const c of [...streams.get(hex(topic)) ?? []]) c.enqueue({ from, payload })
	}

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
		const make = () => createChains(id, check)
		d = {
			id,
			bytes: tree,
			tree: sd.SedimentreeId.fromBytes(tree),
			topic: sd.Topic.fromBytes(tree),
			chains: { stored: make(), ephemeral: make() },
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
		}
		documents.set(key, d)
		return d
	}
	const named = (doc: string) => document(idbytes(doc))

	// ---- taking in

	// handed to the chains: its seal is taken in here
	function hand(d: Document, u: Unsealed, sealed: Uint8Array, ids: string[]) {
		const n = hex(u.name), s = hex(u.stored)
		d.names.set(n, [...d.names.get(n) ?? [], s])
		d.bad.delete(n)
		d.refused.delete(s)
		d.seen.set(s, { name: n, blop: u.blop, sealed, parents: u.blop.parents.map(hex), ids })
		if (depth(u.stored) > 0) d.deep++
		d.chains.stored.add(u.blop, u.name)
		// the ephemeral layer's chains hold every stored blop too
		d.chains.ephemeral.add(u.blop, u.name)
	}

	function refuse(d: Document, key: string, code: Code, name?: string) {
		d.pending.delete(key)
		d.refused.set(key, code)
		if (name !== undefined) d.bad.add(name)
	}

	// step 5 and on, for each pending seal, until none moves: stuck while a parent is refused or
	// stuck, waiting while a parent's seal is not here; else a commit's parents each one of its
	// blop's parents' stored ids, and each of them one of the commit's (refused, parents), or
	// handed to the chains
	function settle(d: Document) {
		for (let moved = true; moved;) {
			moved = false
			const gone = new Set(d.bad)
			for (const p of d.pending.values()) if (p.stuck) gone.add(hex(p.unsealed.name))
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
				if (!match) refuse(d, head, "parents", hex(p.unsealed.name))
				else {
					d.pending.delete(head)
					hand(d, p.unsealed, p.sealed, p.commit ? p.given : of.flat())
				}
				moved = true
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
			u = unseal(opened)
		} catch (e) {
			if (!(e instanceof SealError)) throw e
			refuse(d, h, e.code)
			return
		}
		const n = hex(u.name)
		if (hex(u.stored) !== h) return refuse(d, h, "stored", n), settle(d)
		if (u.blop.node !== d.id) return refuse(d, h, "document", n), settle(d)
		d.refused.delete(h)
		d.pending.set(h, {
			commit: true,
			unsealed: u,
			sealed: opened,
			parents: u.blop.parents.map(hex),
			given: parents.map(hex).sort(by),
		})
		settle(d)
	}

	// a seal taken in as a fragment's member: from unseal on, no commit around it
	function member(d: Document, sealed: Uint8Array) {
		const s = hex(stored(sealed))
		if (d.seen.has(s)) return
		let u: Unsealed
		try {
			u = unseal(sealed)
		} catch (e) {
			if (!(e instanceof SealError)) throw e
			d.refused.set(s, e.code)
			return
		}
		if (u.blop.node !== d.id) return refuse(d, s, "document", hex(u.name))
		d.refused.delete(s)
		d.pending.set(s, {
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
		if (!Array.isArray(x) || !x.every((m) => m instanceof ArrayBuffer)) return
		return x.map((m) => new Uint8Array(m as ArrayBuffer))
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
		if (here) {
			d.fragments.set(h, {
				head,
				members: (members ?? []).map(stored),
				boundary,
				checkpoints: [],
			})
			return
		}
		if (members === undefined) {
			d.broken.set(h, "shape")
			return
		}
		if (!members.some((m) => hex(stored(m)) === h)) {
			d.broken.set(h, "stored")
			return
		}
		d.broken.delete(h)
		for (const m of members) member(d, m)
		d.fragments.set(h, { head, members: members.map(stored), boundary, checkpoints: [] })
		settle(d)
	}

	// an ephemeral blop heard: as above but the steps on the commit; never stored. False: what the
	// lock opened is not a blop of this document (refused as shape, signature or document)
	async function hear(d: Document, blob: Uint8Array): Promise<boolean> {
		const opened = await lock.open(d.bytes, blob)
		if (!(opened instanceof Uint8Array)) {
			if (!("wait" in opened)) d.heard.set(hex(stored(blob)), "lock")
			return true
		}
		const s = hex(stored(opened))
		let u: Unsealed
		try {
			u = unseal(opened)
		} catch (e) {
			if (!(e instanceof SealError)) throw e
			d.heard.set(s, e.code)
			return false
		}
		if (u.blop.node !== d.id) {
			d.heard.set(s, "document")
			return false
		}
		d.heard.delete(s)
		d.chains.ephemeral.add(u.blop, u.name)
		return true
	}

	// ---- building (FRAGMENT.tex)

	async function building(d: Document) {
		if (d.deep === 0) return
		const lookup = (id: Uint8Array) => {
			const s = d.seen.get(hex(id))
			if (!s) return
			return s.ids.map(unhex)
		}
		const covered = new Set<string>()
		for (const s of d.seen.keys()) for (const p of lookup(unhex(s)) ?? []) covered.add(hex(p))
		const heads = [...d.seen.keys()].filter((s) => !covered.has(s)).map(unhex)
		const fresh = build(heads, lookup, (head) => d.fragments.get(hex(head)))
		for (const f of fresh) d.fragments.set(hex(f.head), f)
		for (const f of fresh) {
			const ms = f.members.map((m) => d.seen.get(hex(m))!)
			ms.sort((a, b) => a.blop.lamport - b.blop.lamport || by(a.name, b.name))
			const bytes = cbor.encode(ms.map((m) => buffer(m.sealed)))
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
		for (const c of commits) {
			await commit(d, c.id.toBytes(), c.parents.map((p) => p.toBytes()), c.blob)
		}
		for (const f of fragments) {
			await fragment(d, f.head.toBytes(), f.boundary.map((b) => b.toBytes()), f.blob)
		}
		await building(d)
	}

	// ---- Subduction

	const memory = new sd.MemoryStorage()
	const storage = new Proxy(memory, {
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
			const t = topic.toBytes(), d = documents.get(hex(t))
			if (d && followed.has(hex(t))) {
				later(async () => {
					if (!await hear(d, payload)) tell(t, from.toBytes(), payload)
				})
			} else later(async () => tell(t, from.toBytes(), payload))
		},
	})

	const device: Device = {
		async connect(transport, initiator) {
			const peer = initiator
				? await sub.connectTransport(transport, service)
				: await sub.acceptTransport(transport, service)
			peers.set(hex(peer.toBytes()), peer)
			for (const doc of followed) await sub.syncWithAllPeers(documents.get(doc)!.tree, true)
		},
		async disconnect(key) {
			const peer = peers.get(hex(key)) ?? new sd.PeerId(key)
			peers.delete(hex(key))
			await sub.disconnectFromPeer(peer)
		},
		async follow(doc) {
			const d = named(doc)
			followed.add(hex(d.bytes))
			await sub.subscribeEphemeral([d.topic])
			await sub.syncWithAllPeers(d.tree, true)
		},
		chains: (doc, layer = "stored") => named(doc).chains[layer],
		async add(sealed) {
			const u = unseal(sealed)
			const d = named(u.blop.node)
			const blob = await lock.close(d.bytes, u.name, u.blop.parents, sealed)
			let parents: Uint8Array[] = []
			await run(async () => {
				parents = u.blop.parents.map((p) => {
					const s = d.names.get(hex(p))
					if (s === undefined) throw new Error("a parent is not taken in")
					return unhex(s[0])
				})
				await commit(d, u.stored, parents, blob)
			})
			await sub.addCommit(d.tree, commitId(u.stored), parents.map(commitId), blob)
			await run(() => building(d))
		},
		async publish(sealed) {
			const u = unseal(sealed)
			const d = named(u.blop.node)
			const blob = await lock.close(d.bytes, u.name, u.blop.parents, sealed)
			await run(() => hear(d, blob))
			await sub.publishEphemeral(d.topic, blob)
		},
		topic(id) {
			const key = hex(id), t = sd.Topic.fromBytes(id)
			let open = 2, controller!: ReadableStreamDefaultController<Heard>
			const set = streams.get(key) ?? new Set()
			streams.set(key, set)
			if (set.size === 0 && !followed.has(key)) sub.subscribeEphemeral([t]).catch(() => {})
			const done = () => {
				if (--open > 0) return
				set.delete(controller)
				if (set.size === 0) {
					streams.delete(key)
					if (!followed.has(key)) sub.unsubscribeEphemeral([t]).catch(() => {})
				}
			}
			const readable = new ReadableStream<Heard>({
				start(c) {
					controller = c
					set.add(c)
				},
				cancel: done,
			})
			const writable = new WritableStream<Uint8Array>({
				write: (payload) => sub.publishEphemeral(t, payload),
				close: done,
				abort: done,
			})
			return { readable, writable }
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
		async idle() {
			while (busy > 0) await tail
			if (trouble.length) throw trouble.shift()
		},
		async close() {
			await device.idle().catch(() => {})
			await sub.disconnectAll()
		},
	}
	return device
}
