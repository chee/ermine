// transport_harness: transport.ts on the line protocol (conformance/run.ts), several devices in one
// process linked by in-memory pipes (TRANSPORT.tex). values in JSON form (form.ts); names, stored
// ids, keys, seeds, nonces, blobs as lowercase hex; doc: an ermine:// id; object as BLOP.tex; layer
// "stored" (default) | "ephemeral"; lock "unlocked" only. a scenario starts with reset.
//
//   {op: "reset"}                          -> {}  every device closed, every link gone
//   {op: "device", name, seed, store?, lazy?} -> {key}  Ed25519 from seed; store: a labelled
//      storage kept across drop, taken in first; lazy: taken in a doc at a time, when followed
//   {op: "drop", device}                   -> {}  finished and closed; labelled storage stays
//   {op: "follow", device, doc}            -> {}  synced with every peer, ephemeral subscribed
//   {op: "link", a, b}                     -> {}  pipe + handshake (a initiates), then sync
//   {op: "unlink", a, b}                   -> {}  offline
//   {op: "commit", device, doc, object, patches, actor, nonce, at?, layer?} -> {name, stored?}
//      COMMIT.tex's commit (at default 0, time 0); stored: sealed and added; ephemeral: published
//   {op: "put", device, doc, head, parents, blob}  -> {}  addCommit as given, nothing checked
//   {op: "putfragment", device, doc, head, boundary, checkpoints, blob} -> {}  addFragment as given
//   {op: "pump"}                           -> {}  run until quiet
//   {op: "state", device, doc, object?, layer?} -> {heads, history: {waiting, refused},
//      taking: {waiting, refused}}  heads in agreed order; lists sorted by first field:
//      waiting [{commit, waiting: [names]}]; refused [{commit, refused: code}] code
//      lock|shape|signature|stored|document|parents, [{commit, stuck: [names]}],
//      [{fragment, refused: code}]. commit: a loose commit's head, else a seal's stored id or an
//      ephemeral blop's BLAKE3 name
//   {op: "fragments", device, doc}         -> {fragments: [{head, members, boundary}]}  sorted
//   {op: "stored", device, doc}            -> {stored: [ids]}  getCommits heads, sorted
//   {op: "publish", device, doc, payload}  -> {}  hex bytes to publish as given
//   {op: "expire"}                         -> {}  unjoined ephemeral parts dropped now
//   anything that throws                   -> {error: message}
//
// the Device it drives: createDevice({signer}); connect(transport, initiator), disconnect(key),
// follow(doc), histories(doc, layer), add(sealed), publish(doc, blop), put(...), putFragment(...),
// taking(doc, layer), fragments(doc), stored(doc), idle(), close()
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
