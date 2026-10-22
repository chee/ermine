// transport_harness: devices (transport.ts) on the line protocol (harness.ts), commits over
// Subduction with no table, joined by in-memory pipes. conventions:
// playground/together/conformance/README.md. a device here checks nothing and gives each fragment it
// builds a snapshot (replay.ts). a commit is signed by its seed (default the device's). doc: any
// string within the wire's limits (well-formed, no U+0000), default ermine:0010 then 2a × 16. a take
// is sent only at a document the device follows (else stored there alone). what is put is an
// envelope (subduction.ts): the id (id, default doc) and the seal or the fragment
//
// { op: "device", name, seed, storage?, limits?, lazy?, follow?, lock? } → { key }  storage: a label,
//    taken in; limits: transport.ts Limits; follow: docs followed before the first run; lock: a
//    harness built on this one (lock_harness.ts) says what it makes of it
// { op: "close", device }                 → {}         closed, pipes cut
// { op: "connect", a, b }                 → {}         pipe + handshake (a starts)
// { op: "disconnect", a, b }              → {}
// { op: "follow", device, doc? }          → {}         past the wire's limits: refused
// { op: "pause", device, doc? }           → {}         carried no more (Wired's pause)
// { op: "heard", device, doc? }           → { heard }  puts and fetches for it turned away while
//    not followed
// { op: "offered", device }               → { offered }  [{ tree, count }] by tree (hex): trees not
//    named here a peer put or asked for, once per tree per connection
// { op: "elsewhere", device, doc? }       → { elsewhere }  a peer said it holds heads of it
// { op: "unnamed", device }               → { unnamed }  trees the storage holds whose id is not
//    named yet: listed, not taken in
// { op: "make", name, ...fields }         → {}         made, labelled, sealed
// { op: "take", device, doc?, layer?, name, ...fields } → { added }  the device's take (made
//    first when fields given); layer stored (default) | ephemeral
// { op: "put", device, doc?, commit, head?, parents?, blob?, id?, closed? } → {}  addCommit as
//    given, as from elsewhere (a document not followed: not stored): the envelope {id, sealed};
//    defaults from the commit's seal and stored ids; blob: the seal (hex) instead; id: the
//    envelope's (default doc); closed: the envelope is closed first, as another device's lock would
//    (the harness built on this one says how)
// { op: "fragment", device, doc?, head, members?, boundary?, checkpoints?, tables?, form?, blob?,
//   id?, tamper? } → {}  addFragment as given: the envelope {id, run, snapshot?}; form "members" |
//    "list" (a list of seals, no envelope); blob: a JSON value instead; id: as put's;
//    checkpoints default: members with a leading zero byte; tamper: seals' last signature byte
//    flipped; closed: as put's
// { op: "again", device, doc?, commit }   → { again }  an ephemeral commit of the device's published
//    again (a beat); false: no such commit
// { op: "changed", device, times? }       → {}         the device's changed: what waited on its lock
//    (or check) is tried again. times: told so often (default 1) before any of it runs
// { op: "closed", device, doc?, commit?, head? } → { first }  the first byte (hex) of what the device's
//    storage holds for a loose commit (a label) or a fragment (its head): as the lock closed it
// { op: "quiet" }                         → {}         every device idle, nothing crossing
// { op: "heads", device, doc?, layer? }   → { heads }  agreed order
// { op: "refused", device, doc?, layer? } → { refused } [{ name, refused }]
// { op: "taking", device, doc?, layer? }  → { waiting, refused }  held back before the histories
// { op: "arrived", device }               → { arrived }  [[doc, layer, commit, heard]]
//    since last asked, in order
// { op: "stored", device, doc? }          → { stored }   sorted by stored id
// { op: "fragments", device, doc? }       → { fragments }  [{ head, members, boundary }], sorted
// { op: "blob", device, doc?, head }      → { members, snapshot?, hash }  hash: BLAKE3 of bytes
// { op: "snapshot", device, doc?, commit } → { tables } | {}
// commit in an answer: its label (name and stored id alike), else hex
import * as sd from "npm:@automerge/subduction@0.23.0"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { revive } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { name as nameOf, splitName } from "@ermine/formats/commit"
import { hex, unhex } from "../../encoding/typescript/commit_harness.ts"
import { envelope, treeOf } from "../stacks/subduction/typescript/subduction.ts"
import { createCommits, type Made, pipe, quiet, tablesJson } from "./harnesses.ts"
import type { Added } from "./history.ts"
import { replay, type Tables } from "./replay.ts"
import { pack, unpack } from "./packer.ts"
import { createSigner, stored as storedOf } from "./seal.ts"
import { snapshot, tablesOf } from "./snapshot.ts"
import { type Arrival, createDevice, type Device, type Lock } from "./transport.ts"
import {
	transport_conformance_hook_put,
	transport_conformance_hook_putFragment,
	transport_conformance_hook_taking,
} from "./transport_conformance_hook.ts"

const DOC = "ermine:0010" + "2a".repeat(16)

// a document's id as its UTF-8 (what a lock is given), and its tree id (the stack's)
const idOf = (doc: string) => new TextEncoder().encode(doc)
const treeId = (doc: string) => sd.SedimentreeId.fromBytes(treeOf(doc))

// what a harness built on this one adds (lock_harness.ts): the lock a device is made with (its
// request), and how bytes are closed for a put or a fragment that says closed
export const hooks: {
	lock?: (request: Request) => Lock | undefined
	close?: (
		device: string,
		doc: Uint8Array,
		name: Uint8Array,
		parents: Uint8Array[],
		bytes: Uint8Array,
	) => Uint8Array | Promise<Uint8Array>
} = {}

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
export const label = (b: Uint8Array | string) => {
	const h = typeof b === "string" ? b : hex(b)
	return labels.get(h) ?? h
}
// a commit's seal for a document (a seal is good in its own only), made once
async function made(m: Made, doc: string): Promise<Uint8Array> {
	const k = m.label + " " + doc
	let s = seals.get(k)
	if (s) return s
	s = await commits.sealed(m, doc)
	seals.set(k, s)
	for (const h of [hex(m.name), hex(storedOf(s))]) if (!labels.has(h)) labels.set(h, m.label)
	return s
}
// made under its label, signed by its seed (default: seed); made already, that one
async function make(r: Request, doc: string, seed?: string): Promise<Made> {
	const fresh = commits.get(r.name) === undefined && seed !== undefined && r.seed === undefined
	const m = await commits.make(fresh ? { ...r, seed } : r)
	await made(m, doc)
	return m
}
// a label's seal for the document, by label
async function sealOf(x: unknown, doc: string): Promise<Uint8Array> {
	const m = commits.get(x as string)
	if (!m) throw new Error(`no commit ${x}`)
	return await made(m, doc)
}
// a label (its seal's stored id, in the document), or hex
const storedId = async (x: unknown, doc: string) =>
	typeof x === "string" && commits.get(x) !== undefined
		? storedOf(await sealOf(x, doc))
		: unhex(x as string)
// a seal's stored id; bytes that are no seal: their BLAKE3 (a name for them, as a peer might give)
function storedOfAny(sealed: Uint8Array): Uint8Array {
	try {
		return storedOf(sealed)
	} catch {
		return blake3(sealed)
	}
}
const storedIds = (xs: unknown[], doc: string) => Promise.all(xs.map((x) => storedId(x, doc)))

// bytes closed for a put or a fragment that says closed: by the harness built on this one
async function close(
	device: string,
	doc: string,
	name: Uint8Array,
	parents: Uint8Array[],
	bytes: Uint8Array,
) {
	if (!hooks.close) throw new Error("closed: this harness has no lock")
	return await hooks.close(device, idOf(doc), name, parents, bytes)
}

const added = (a: Added): unknown =>
	typeof a === "object" && "waiting" in a ? { waiting: a.waiting.map(label) } : a

export async function answer(r: Request): Promise<Answer> {
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
				lock: hooks.lock?.(r),
				lazy: r.lazy === true,
				storage: storage as unknown as sd.SedimentreeStorage,
				snapshotOf: (d, head) => snapshot(replay(device.history(d), head.name) ?? {}),
			})
			device.arrived((a) => arrived.push(a))
			const follows = ((r.follow ?? []) as string[]).map((x) => device.follow(x))
			await device.ready()
			await Promise.all(follows)
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
		case "pause":
			await of(r.device).device.pause(doc)
			return {}
		case "heard":
			return { heard: of(r.device).device.turned(doc) }
		case "offered":
			return { offered: of(r.device).device.offered() }
		case "elsewhere":
			return { elsewhere: of(r.device).device.elsewhere(doc) }
		case "unnamed":
			return { unnamed: of(r.device).device.unnamed() }
		case "make":
			await make(r, doc)
			return {}
		case "take": {
			const d = of(r.device)
			const m = await make(r, doc, d.seed)
			return {
				added: added(
					d.device.take(doc, m.bytes, r.layer ?? "stored", { commit: m.commit, name: m.name }),
				),
			}
		}
		case "put": {
			const d = of(r.device)
			const m = typeof r.commit === "string" ? commits.get(r.commit) : undefined
			const sealed = r.blob !== undefined ? unhex(r.blob) : await sealOf(r.commit, doc)
			const head = r.head !== undefined ? await storedId(r.head, doc) : storedOfAny(sealed)
			const blob = envelope(r.id ?? doc, { sealed })
			const closed = r.closed === true
				? await close(d.name, doc, m?.name ?? blake3(blob), m?.commit.parents ?? [], blob)
				: blob
			const parents: Uint8Array[] = r.parents !== undefined
				? await storedIds(r.parents, doc)
				// a name not made here: its digest, raw, as Subduction has it
				: await storedIds(
					(m?.commit.parents ?? []).map((p) =>
						labels.has(hex(p)) ? label(p) : hex(splitName(p)!.digest)
					),
					doc,
				)
			await transport_conformance_hook_put(d.device, doc, head, parents, closed)
			return {}
		}
		case "fragment": {
			const d = of(r.device)
			let blob: Uint8Array
			const tamper = new Set<string>(r.tamper ?? [])
			const seals = (await Promise.all((r.members ?? []).map((m: string) => sealOf(m, doc))))
				.map((s, i) => {
					const m = r.members[i]
					if (!tamper.has(m)) return s
					const o = cbor.decode(s) as { id: string; commit: Uint8Array; signature: Uint8Array }
					const signature = o.signature.slice()
					signature[signature.length - 1] ^= 1
					return cbor.encode({ ...o, signature })
				})
			if (r.blob !== undefined) blob = cbor.encode(revive(r.blob) as cbor.Value)
			else if (r.form === "list") blob = cbor.encode(seals)
			else {
				const o: Record<string, cbor.Value> = r.form === "members"
					? { members: seals }
					// "run": the blob's key, as stored
					: { run: pack(seals) }
				if (r.tables !== undefined) o.snapshot = snapshot(revive(r.tables) as Tables)
				blob = envelope(r.id ?? doc, o)
			}
			const head = await storedId(r.head, doc)
			const boundary = await storedIds(r.boundary ?? [], doc)
			if (r.closed === true) {
				const names = ((r.boundary ?? []) as string[]).map((b) =>
					commits.get(b)?.name ?? unhex(b)
				)
				blob = await close(d.name, doc, nameOf(blob), names, blob)
			}
			const checkpoints = r.checkpoints !== undefined
				? await storedIds(r.checkpoints, doc)
				: (await storedIds(r.members ?? [], doc)).filter((id: Uint8Array) =>
					id[0] === 0 && hex(id) !== hex(head)
				)
			await transport_conformance_hook_putFragment(
				d.device,
				doc,
				head,
				boundary,
				checkpoints,
				blob,
			)
			return {}
		}
		case "again": {
			const d = of(r.device), name = commits.name(r.commit)
			return { again: d.device.again(doc, name) }
		}
		case "changed":
			await Promise.all(
				Array.from({ length: r.times ?? 1 }, () => of(r.device).device.changed()),
			)
			return {}
		case "closed": {
			const d = of(r.device)
			const tree = treeId(doc)
			let blob: Uint8Array | undefined
			if (r.commit !== undefined) {
				const id = hex(await storedId(r.commit, doc))
				const all = await d.storage.loadAllCommits(tree) as sd.CommitWithBlob[]
				blob = all.find((c) => hex(c.signed.payload.commitId.toBytes()) === id)?.blob
			} else {
				const head = hex(await storedId(r.head, doc))
				const all = await d.storage.loadAllFragments(tree) as sd.FragmentWithBlob[]
				blob = all.find((f) => hex(f.signed.payload.head.toBytes()) === head)?.blob
			}
			return blob === undefined ? {} : { first: hex(blob.subarray(0, 1)) }
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
				waiting: t.waiting.map((w) =>
					"fragment" in w
						? { fragment: label(w.fragment), boundary: w.boundary.map(label) }
						: { commit: label(w.commit), waiting: w.waiting.map(label) }
				),
				refused: t.refused.map((x) => {
					const why = "why" in x && x.why !== undefined ? { why: x.why } : {}
					if ("fragment" in x) {
						return { fragment: label(x.fragment), refused: x.refused, ...why }
					}
					if ("stuck" in x) return { commit: label(x.commit), stuck: x.stuck.map(label) }
					return { commit: label(x.commit), refused: x.refused, ...why }
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
			const d = of(r.device), head = hex(await storedId(r.head, doc))
			const tree = treeId(doc)
			const all = await d.storage.loadAllFragments(tree) as sd.FragmentWithBlob[]
			const f = all.find((f) => hex(f.signed.payload.head.toBytes()) === head)
			if (f === undefined) return {}
			// "run": the blob's key, as stored; the envelope's id beside it
			const o = cbor.decode(f.blob) as { run: Uint8Array; snapshot?: Uint8Array }
			const out: Answer = { members: unpack(o.run).map((u) => label(u.stored)) }
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

// every device closed, at the end of a run
export async function finish() {
	for (const d of devices.values()) await d.device.close().catch(() => {})
}

if (import.meta.main) {
	// Subduction's logging (a connection closed, …) is not an answer
	console.warn = () => {}
	await serve(answer)
	await finish()
	Deno.exit(0)
}
