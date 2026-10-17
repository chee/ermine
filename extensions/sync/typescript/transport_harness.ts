// devices (transport.ts) on the line protocol (conformance/typescript/harness.ts): commits over
// Subduction, with no table, joined by in-memory pipes. state lasts for the process. another
// implementation joins by speaking this (HARNESS). conventions, and a commit by label:
// extensions/sync/conformance/README.md
//
// a device here checks nothing (every commit applies) and gives every fragment it builds a snapshot:
// the tables at its head (replay.ts), packed. a commit a request makes is signed by its seed,
// default the device's. doc: an ermine:// id, default ermine://2a…2a00…00 (16 bytes each)
//
// { op: "device", name, seed, storage?, limits? }  → { key }    storage: a label; a device made with
//                                                        it takes in what that storage holds;
//                                                        limits: the device's (transport.ts Limits)
// { op: "close", device }                 → {}         closed, its pipes cut
// { op: "connect", a, b }                 → {}         a pipe, the handshake done (a starts)
// { op: "disconnect", a, b }              → {}
// { op: "follow", device, doc? }          → {}
// { op: "make", name, ...fields }         → {}         a commit made, labelled and sealed
// { op: "take", device, doc?, layer?, name, ...fields } → { added }   the device's own take (made
//                                                        first when fields are given); layer
//                                                        stored (default) or ephemeral
// { op: "put", device, doc?, commit, head?, parents?, blob? } → {}   addCommit as given: blob the
//                                                        commit's seal (or hex), head its stored
//                                                        id, parents its parents' stored ids,
//                                                        unless given (labels: their stored ids)
// { op: "fragment", device, doc?, head, members?, boundary?, checkpoints?, tables?, form?, blob?,
//   tamper? } → {}                                       addFragment as given: blob {run: the
//                                                        members' seals packed, in order;
//                                                        snapshot?: the tables packed}; form
//                                                        "members": {members: [seal…], snapshot?}
//                                                        (as first written), "list": [seal…];
//                                                        blob: a value (its JSON form) instead.
//                                                        checkpoints: default, each member but the
//                                                        head whose stored id has a leading zero
//                                                        byte. tamper: members whose seals go with
//                                                        their signature's last byte flipped
// { op: "quiet" }                         → {}         every device idle, nothing crossing
// { op: "heads", device, doc?, layer? }   → { heads }   the layer's history's, in the agreed order
// { op: "refused", device, doc?, layer? } → { refused } the history's [{ name, refused }]
// { op: "taking", device, doc?, layer? }  → { waiting, refused }   what the transport holds back
//                                                        or refused before the histories
// { op: "arrived", device }               → { arrived }  [[doc, layer, commit, heard]] announced
//                                                        since last asked, in order
// { op: "stored", device, doc? }          → { stored }   the loose commits Subduction holds,
//                                                        sorted by stored id
// { op: "fragments", device, doc? }       → { fragments }  [{ head, members, boundary }], each list
//                                                        and the fragments sorted by stored id
// { op: "blob", device, doc?, head }      → { members, snapshot?, hash }   the stored fragment's
//                                                        blob: its run's commits in order, its
//                                                        snapshot's tables, BLAKE3 of its bytes
// { op: "snapshot", device, doc?, commit } → { tables } | {}   the tables a fragment headed there
//                                                        carried
// a commit in an answer: its label (for its name and its seal's stored id alike), else hex
import * as sd from "npm:@automerge/subduction@0.23.0"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { revive } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { hex, unhex } from "../../../ermine/encoding/typescript/commit_harness.ts"
import { createCommits, type Made, pipe, quiet, tablesJson } from "./harnesses.ts"
import type { Added } from "./history.ts"
import { replay, type Tables } from "./replay.ts"
import { pack, unpack } from "./run.ts"
import { createSigner, stored as storedOf } from "./seal.ts"
import { snapshot, tablesOf } from "./snapshot.ts"
import { type Arrival, createDevice, type Device } from "./transport.ts"
import {
	transport_conformance_hook_put,
	transport_conformance_hook_putFragment,
	transport_conformance_hook_taking,
} from "./transport_conformance_hook.ts"

const DOC = "ermine://" + "2a".repeat(16) + "00".repeat(16)

// ---- devices

type Held = {
	name: string
	seed: string
	key: Uint8Array
	device: Device
	storage: sd.MemoryStorage
	arrived: Arrival[]
}
const devices = new Map<string, Held>()
const storages = new Map<string, sd.MemoryStorage>()
const links = new Map<string, { cut(): void }>()
const pair = (a: string, b: string) => [a, b].sort().join(" ")
const of = (name: unknown) => {
	const d = devices.get(name as string)
	if (!d) throw new Error(`no device ${name}`)
	return d
}

// ---- commits: labels for names and stored ids alike
const commits = createCommits()
const seals = new Map<string, Uint8Array>()
const labels = new Map<string, string>()
const label = (b: Uint8Array | string) => {
	const h = typeof b === "string" ? b : hex(b)
	return labels.get(h) ?? h
}
async function made(m: Made): Promise<Uint8Array> {
	let s = seals.get(m.label)
	if (s) return s
	s = await commits.sealed(m)
	seals.set(m.label, s)
	for (const h of [hex(m.name), hex(storedOf(s))]) if (!labels.has(h)) labels.set(h, m.label)
	return s
}
// made under its label, signed by its seed (default: seed); made already, that one
async function make(r: Request, seed?: string): Promise<Made> {
	const fresh = commits.get(r.name) === undefined && seed !== undefined && r.seed === undefined
	const m = await commits.make(fresh ? { ...r, seed } : r)
	await made(m)
	return m
}
// a label's seal, by label
function sealOf(x: unknown): Uint8Array {
	const s = seals.get(x as string)
	if (!s) throw new Error(`no commit ${x}`)
	return s
}
// a label (its seal's stored id), or hex
const storedId = (x: unknown) =>
	typeof x === "string" && seals.has(x) ? storedOf(sealOf(x)) : unhex(x as string)

const added = (a: Added): unknown =>
	typeof a === "object" && "waiting" in a ? { waiting: a.waiting.map(label) } : a

async function answer(r: Request): Promise<Answer> {
	const doc = r.doc ?? DOC
	switch (r.op) {
		case "device": {
			if (devices.has(r.name)) throw new Error(`a device ${r.name} already`)
			let storage = new sd.MemoryStorage()
			if (typeof r.storage === "string") {
				storage = storages.get(r.storage) ?? storage
				storages.set(r.storage, storage)
			}
			const signer = await createSigner(unhex(r.seed))
			const arrived: Arrival[] = []
			const device: Device = createDevice({
				signer,
				limits: r.limits,
				storage: storage as unknown as sd.SedimentreeStorage,
				snapshotOf: (d, head) => snapshot(replay(device.history(d), head.name) ?? {}),
			})
			device.arrived((a) => arrived.push(a))
			await device.ready()
			devices.set(r.name, {
				name: r.name,
				seed: r.seed,
				key: signer.key,
				device,
				storage,
				arrived,
			})
			return { key: hex(signer.key) }
		}
		case "close": {
			const d = of(r.device)
			for (const [k, l] of links) if (k.split(" ").includes(d.name)) l.cut(), links.delete(k)
			await d.device.close()
			devices.delete(d.name)
			return {}
		}
		case "connect": {
			const a = of(r.a), b = of(r.b)
			const p = pipe()
			links.set(pair(a.name, b.name), p)
			await Promise.all([a.device.connect(p.ends[0], true), b.device.connect(p.ends[1], false)])
			return {}
		}
		case "disconnect": {
			const a = of(r.a), b = of(r.b)
			await Promise.all([a.device.disconnect(b.key), b.device.disconnect(a.key)])
			links.get(pair(a.name, b.name))?.cut()
			links.delete(pair(a.name, b.name))
			return {}
		}
		case "follow":
			await of(r.device).device.follow(doc)
			return {}
		case "make":
			await make(r)
			return {}
		case "take": {
			const d = of(r.device)
			const m = await make(r, d.seed)
			return {
				added: added(
					d.device.take(doc, m.bytes, r.layer ?? "stored", { commit: m.commit, name: m.name }),
				),
			}
		}
		case "put": {
			const d = of(r.device)
			const m = typeof r.commit === "string" ? commits.get(r.commit) : undefined
			const blob = r.blob !== undefined ? unhex(r.blob) : sealOf(r.commit)
			const head = r.head !== undefined ? storedId(r.head) : storedOf(blob)
			const parents: Uint8Array[] = r.parents !== undefined
				? r.parents.map(storedId)
				: (m?.commit.parents ?? []).map((p) => storedId(label(p)))
			await transport_conformance_hook_put(d.device, doc, head, parents, blob)
			return {}
		}
		case "fragment": {
			const d = of(r.device)
			let blob: Uint8Array
			const tamper = new Set<string>(r.tamper ?? [])
			const seals = (r.members ?? []).map((m: string) => {
				const s = sealOf(m)
				if (!tamper.has(m)) return s
				const o = cbor.decode(s) as { commit: Uint8Array; signature: Uint8Array }
				const signature = o.signature.slice()
				signature[signature.length - 1] ^= 1
				return cbor.encode({ commit: o.commit, signature })
			})
			if (r.blob !== undefined) blob = cbor.encode(revive(r.blob) as cbor.Value)
			else if (r.form === "list") blob = cbor.encode(seals)
			else {
				const o: Record<string, cbor.Value> = r.form === "members"
					? { members: seals }
					: { run: pack(seals) }
				if (r.tables !== undefined) o.snapshot = snapshot(revive(r.tables) as Tables)
				blob = cbor.encode(o)
			}
			const head = storedId(r.head)
			const checkpoints = r.checkpoints !== undefined
				? r.checkpoints.map(storedId)
				: (r.members ?? []).map(storedId).filter((id: Uint8Array) =>
					id[0] === 0 && hex(id) !== hex(head)
				)
			await transport_conformance_hook_putFragment(
				d.device,
				doc,
				head,
				(r.boundary ?? []).map(storedId),
				checkpoints,
				blob,
			)
			return {}
		}
		case "quiet":
			await quiet(() => Promise.all([...devices.values()].map((d) => d.device.idle())))
			return {}
		case "heads":
			return {
				heads: of(r.device).device.history(doc, r.layer ?? "stored").heads().map((k) =>
					label(k.name)
				),
			}
		case "refused":
			return {
				refused: of(r.device).device.history(doc, r.layer ?? "stored").refused().map((x) => ({
					name: label(x.name),
					refused: x.refused,
				})),
			}
		case "taking": {
			const t = transport_conformance_hook_taking(of(r.device).device, doc, r.layer ?? "stored")
			return {
				waiting: t.waiting.map((w) => ({
					commit: label(w.commit),
					waiting: w.waiting.map(label),
				})),
				refused: t.refused.map((x) => {
					if ("fragment" in x) return { fragment: label(x.fragment), refused: x.refused }
					if ("stuck" in x) return { commit: label(x.commit), stuck: x.stuck.map(label) }
					return { commit: label(x.commit), refused: x.refused }
				}),
			}
		}
		case "arrived":
			return {
				arrived: of(r.device).arrived.splice(0).map((a) => [
					a.doc,
					a.layer,
					label(a.kept.name),
					a.heard,
				]),
			}
		case "stored": {
			const ids = (await of(r.device).device.stored(doc)).map(hex).sort()
			return { stored: ids.map(label) }
		}
		case "fragments": {
			const sorted = (xs: Uint8Array[]) => xs.map(hex).sort().map(label)
			const fs = of(r.device).device.fragments(doc).slice().sort((x, y) =>
				hex(x.head) < hex(y.head) ? -1 : 1
			)
			return {
				fragments: fs.map((f) => ({
					head: label(f.head),
					members: sorted(f.members),
					boundary: sorted(f.boundary),
				})),
			}
		}
		case "blob": {
			const d = of(r.device), head = hex(storedId(r.head))
			const tree = sd.SedimentreeId.fromBytes(unhex(doc.slice("ermine://".length)))
			const all = await d.storage.loadAllFragments(tree) as sd.FragmentWithBlob[]
			const f = all.find((f) => hex(f.signed.payload.head.toBytes()) === head)
			if (f === undefined) return {}
			const o = cbor.decode(f.blob) as { run: Uint8Array; snapshot?: Uint8Array }
			const out: Answer = { members: unpack(o.run).map((s) => label(storedOf(s))) }
			if (o.snapshot !== undefined) out.snapshot = tablesJson(tablesOf(o.snapshot))
			out.hash = hex(blake3(f.blob))
			return out
		}
		case "snapshot": {
			const t = of(r.device).device.snapshot(doc, commits.name(r.commit))
			return t === undefined ? {} : { tables: tablesJson(t) }
		}
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	// Subduction's logging (a connection closed, …) is not an answer
	console.warn = () => {}
	await serve(answer)
	for (const d of devices.values()) await d.device.close().catch(() => {})
	Deno.exit(0)
}
