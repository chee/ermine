// The reference transport.ts on the line protocol (conformance/run.ts: one JSON request per line in,
// one answer per line out, in order; an answer is an object). Several devices in one process, linked by in-memory pipes (TRANSPORT.tex).
// Values (patches, actor) in their JSON form (conformance/typescript/form.ts); names, stored ids, keys, seeds,
// nonces and blobs as lowercase hex; a document an ermine:// id (ID.tex); an object as BLOP.tex
// writes it; layer "stored" (the default) or "ephemeral". Lock: "unlocked" only. A scenario starts
// with reset.
//   {op: "reset"}                    -> {}  every device closed, every link gone
//   {op: "device", name, seed, store?, lazy?}
//                                    -> {key}  a device signing with the Ed25519 key of seed (32
//                                       bytes): its peer id and its blops' signer are key. store: a
//                                       label; the storage under it (made empty at first) is kept
//                                       across drop, and a device made with the label takes in
//                                       everything it holds before anything else (TRANSPORT.tex, A
//                                       device); without one the device has storage of its own.
//                                       lazy: true: what it holds is taken in a document at a
//                                       time, when followed
//   {op: "drop", device}             -> {}  the device finished (its work done) and closed, gone with
//                                       its links; what its labelled storage holds stays
//   {op: "follow", device, doc}      -> {}  doc followed: synced with every peer, subscribe true,
//                                       its ephemeral messages subscribed; from now on, with each
//                                       peer linked too
//   {op: "link", a, b}               -> {}  an in-memory pipe, the handshake done (a initiates,
//                                       where roles exist); each side's followed documents then
//                                       synced with the other as follow says
//   {op: "unlink", a, b}             -> {}  the pipe gone: nothing more crosses (offline)
//   {op: "commit", device, doc, object, patches, actor, nonce, at?, layer?}
//                                    -> {name, stored}  a change made through COMMIT.tex's commit
//                                       (at: the version, default 0; roots none; time 0; random
//                                       hands out nonce, 8 bytes); stored: sealed (SEAL.tex) with
//                                       the device's signer, taken in and added as a loose commit;
//                                       ephemeral: not sealed, its bytes taken in to the ephemeral
//                                       layer and published. name: the blop's; stored: the seal's
//                                       stored id (stored only: an ephemeral blop has none, the
//                                       answer is {name})
//   {op: "put", device, doc, head, parents, blob}
//                                    -> {}  addCommit(tree, head, parents, blob) as given, nothing
//                                       checked or taken in first: how a hand-made loose commit
//                                       (bad seal, head not the stored id, ...) gets in
//   {op: "putfragment", device, doc, head, boundary, checkpoints, blob}
//                                    -> {}  addFragment(tree, head, boundary, checkpoints, blob) as
//                                       given (ids hex lists), nothing checked or taken in first
//   {op: "pump"}                     -> {}  everything runs until quiet: no message crossing, no
//                                       taking in or fragment building left
//   {op: "state", device, doc, object?, layer?}
//                                    -> {heads, history: {waiting, refused}, taking: {waiting,
//                                       refused}}
//        heads: the object's (default "value") heads' names, in the agreed order (HISTORY.tex)
//        history: the layer's histories' waiting() and refused(), as HISTORY.tex gives them
//        taking: Taking in's own (TRANSPORT.tex), each list sorted by its first field:
//          waiting: [{commit, waiting: [names]}]  step 5: the parents (blop names, in parents
//                   order) whose seals are not here
//          refused: [{commit, refused: code}]     code lock|shape|signature|stored|document|
//                                                  parents
//                 | [{commit, stuck: [names]}]    a commit stuck: the names of its parents
//                                                  refused or stuck, in parents order
//                 | [{fragment, refused: code}]   a fragment refused whole (FRAGMENT.tex)
//          commit: a loose commit's head; for what has no commit, a fragment's member the
//          stored id of its seal, an ephemeral blop (or what was heard as one) its name: BLAKE3
//          of its bytes
//   {op: "fragments", device, doc}   -> {fragments: [{head, members, boundary}]}  the fragments here (made or
//                                       taken in, FRAGMENT.tex), sorted by head, lists sorted;
//                                       stored ids. Checkpoints left out: one taken in holds 12
//                                       bytes of each
//   {op: "stored", device, doc}      -> {stored: [ids]}  the loose commits Subduction holds of the tree
//                                       (getCommits), heads, sorted
//   {op: "publish", device, doc, payload}
//                                    -> {}  payload (hex, any bytes) given to the device's publish
//                                       as given: taken in (a blop of another signer, or no blop,
//                                       is refused there as a receiver refuses it), published
//   {op: "expire"}                   -> {}  every device drops, now, the parts of an ephemeral payload
//                                       not yet joined (as its setting would, in time)
//   anything that throws             -> {error: message}
// Another implementation joins by speaking this (TRANSPORT_HARNESS).
//
// transport.ts is not written yet; this shim assumes:
//   createDevice({signer}) -> Device; signer SEAL.tex's {key, sign}; the lock "unlocked"
//   Device:
//     connect(transport, initiator: boolean): Promise<void>  Subduction's Transport
//                                             (sendBytes/recvBytes/disconnect/onDisconnect); the
//                                             handshake, then the followed documents synced with it
//     disconnect(key): Promise<void>          the peer with that key
//     follow(doc): Promise<void>
//     histories(doc, layer): Histories              the document's histories of that layer (HISTORY.tex)
//     add(sealed): Promise<void>              a stored blop of this device's: taken in, then
//                                             addCommit, then fragments built (FRAGMENT.tex)
//     publish(doc, blop: Uint8Array): Promise<void>   an ephemeral one, its bytes, not sealed, as given:
//                                             taken in, then publishEphemeral
//     put(doc, head, parents, blob): Promise<void>   addCommit as given
//     putFragment(doc, head, boundary, checkpoints, blob): Promise<void>   addFragment as given
//     taking(doc, layer): {waiting, refused}  as state's taking, hex
//     fragments(doc): {head, members, boundary, checkpoints}[]  ids as Uint8Array
//     stored(doc): Promise<Uint8Array[]>
//     idle(): Promise<void>                   resolves when no taking in or building is left
//     close(): Promise<void>
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import type { Transport } from "npm:@automerge/subduction@0.23.0"
import { MemoryStorage } from "npm:@automerge/subduction@0.23.0"
import { createDevice } from "@ermine/subduction/transport"
import { commit } from "@ermine/subduction/commit"
import { seal, stored } from "@ermine/subduction/seal"
import { encode, name } from "@ermine/encoding/blop"
import { fromJson } from "../../../conformance/typescript/form.ts"
import { serve } from "../../../conformance/typescript/harness.ts"

type Request = Record<string, unknown> & { op: string }
// deno-lint-ignore no-explicit-any
type Device = any

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
const sorted = (xs: Iterable<Uint8Array>) => [...xs].map(hex).sort()

// a pipe: what one end sends the other receives, in order, while it is open; moved counts
// messages, so pump knows when nothing crosses
let moved = 0
type End = Transport & { other?: End; queue: Uint8Array[]; waiting: ((b: Uint8Array) => void)[] }
function pipe(): { ends: [End, End]; cut(): void } {
	let open = true
	const make = (): End => {
		const end: End = {
			queue: [],
			waiting: [],
			sendBytes(bytes) {
				if (!open) return Promise.reject(new Error("unlinked"))
				moved++
				const o = end.other!, w = o.waiting.shift()
				if (w) w(bytes.slice())
				else o.queue.push(bytes.slice())
				return Promise.resolve()
			},
			recvBytes() {
				const b = end.queue.shift()
				if (b) return Promise.resolve(b)
				if (!open) return Promise.reject(new Error("unlinked"))
				return new Promise((r) => end.waiting.push(r))
			},
			disconnect() {
				open = false
				return Promise.resolve()
			},
			onDisconnect() {},
		}
		return end
	}
	const a = make(), b = make()
	a.other = b, b.other = a
	return { ends: [a, b], cut: () => (open = false) }
}

type Held = {
	device: Device
	key: Uint8Array
	secret: Uint8Array
}
let devices = new Map<string, Held>()
// storages by label, kept across drop
let stores = new Map<string, MemoryStorage>()
let links = new Map<string, { cut(): void }>()
const of = (n: unknown) => {
	const d = devices.get(n as string)
	if (!d) throw new Error(`no device ${n}`)
	return d
}
const pair = (a: unknown, b: unknown) => [a, b].sort().join(" ")

async function pump() {
	let quiet = 0, last = -1
	for (let round = 0; round < 2000; round++) {
		await Promise.all([...devices.values()].map((d) => d.device.idle()))
		await new Promise((r) => setTimeout(r, 2))
		if (moved === last) {
			if (++quiet >= 5) return
		} else quiet = 0, last = moved
	}
	throw new Error("never quiet")
}

export async function answer(r: Request): Promise<Record<string, unknown>> {
	switch (r.op) {
		case "reset":
			for (const l of links.values()) l.cut()
			await Promise.all([...devices.values()].map((d) => d.device.close()))
			devices = new Map(), links = new Map(), stores = new Map()
			return {}
		case "device": {
			const secret = unhex(r.seed as string)
			const key = ed25519.getPublicKey(secret)
			const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, secret)) }
			let storage: MemoryStorage | undefined
			if (typeof r.store === "string") {
				storage = stores.get(r.store)
				if (!storage) stores.set(r.store, storage = new MemoryStorage())
			}
			const device = createDevice({ signer, storage, lazy: r.lazy === true })
			await device.ready()
			devices.set(r.name as string, {
				device,
				key,
				secret,
			})
			return { key: hex(key) }
		}
		case "drop": {
			const d = of(r.device)
			for (const [k, l] of links) {
				if (k.split(" ").includes(r.device as string)) l.cut(), links.delete(k)
			}
			await d.device.idle()
			await d.device.close()
			devices.delete(r.device as string)
			return {}
		}
		case "follow":
			await of(r.device).device.follow(r.doc)
			return {}
		case "link": {
			const a = of(r.a), b = of(r.b)
			const p = pipe()
			links.set(pair(r.a, r.b), p)
			await Promise.all([a.device.connect(p.ends[0], true), b.device.connect(p.ends[1], false)])
			return {}
		}
		case "unlink": {
			const a = of(r.a), b = of(r.b)
			await Promise.all([a.device.disconnect(b.key), b.device.disconnect(a.key)])
			links.get(pair(r.a, r.b))?.cut()
			links.delete(pair(r.a, r.b))
			return {}
		}
		case "commit": {
			const d = of(r.device)
			const layer = (r.layer ?? "stored") as string
			const nonce = unhex(r.nonce as string)
			const blop = commit(
				d.device.histories(r.doc, layer),
				{
					node: r.doc as string,
					object: fromJson(r.object) as never,
					patches: fromJson(r.patches) as never,
					header: { time: 0, actor: fromJson(r.actor) },
					signer: d.key,
				},
				(r.at ?? 0) as number,
				[],
				() => nonce,
			)
			const bytes = encode(blop)
			if (layer === "ephemeral") {
				await d.device.publish(r.doc, bytes)
				return { name: hex(name(bytes)) }
			}
			const sealed = await seal(bytes, {
				key: d.key,
				sign: (m) => Promise.resolve(ed25519.sign(m, d.secret)),
			})
			await d.device.add(sealed)
			return { name: hex(name(bytes)), stored: hex(stored(sealed)) }
		}
		case "publish":
			await of(r.device).device.publish(r.doc, unhex(r.payload as string))
			return {}
		case "put":
			await of(r.device).device.put(
				r.doc,
				unhex(r.head as string),
				(r.parents as string[]).map(unhex),
				unhex(r.blob as string),
			)
			return {}
		case "putfragment":
			await of(r.device).device.putFragment(
				r.doc,
				unhex(r.head as string),
				(r.boundary as string[]).map(unhex),
				(r.checkpoints as string[]).map(unhex),
				unhex(r.blob as string),
			)
			return {}
		case "expire":
			for (const h of devices.values()) h.device.expire()
			return {}
		case "pump":
			await pump()
			return {}
		case "state": {
			const d = of(r.device).device, layer = (r.layer ?? "stored") as string
			const histories = d.histories(r.doc, layer)
			return {
				heads: histories.heads(fromJson(r.object ?? "value")).map((h: { name: Uint8Array }) =>
					hex(h.name)
				),
				history: { waiting: histories.waiting(), refused: histories.refused() },
				taking: d.taking(r.doc, layer),
			}
		}
		case "fragments":
			return {
				fragments: of(r.device).device.fragments(r.doc).map((
					f: { head: Uint8Array; members: Uint8Array[]; boundary: Uint8Array[] },
				) => ({ head: hex(f.head), members: sorted(f.members), boundary: sorted(f.boundary) }))
					.sort((a: { head: string }, b: { head: string }) => a.head < b.head ? -1 : 1),
			}
		case "stored":
			return { stored: sorted(await of(r.device).device.stored(r.doc)) }
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) {
	await serve((r) => answer(r as never))
	Deno.exit(0)
}
