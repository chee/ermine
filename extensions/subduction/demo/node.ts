// A device of the notes demo, no DOM: runs in a browser tab and in Deno (peer.ts). Everything here
// is the host's side, built from newcore's parts: a device (sync/ts/transport.ts), the wiring
// (sync/ts/wiring.ts), a scheduler, and programs.
//
// The picture: Subduction is a networked filesystem; the graph in memory is this device's open view
// of it. This device's graph has a local root, "me" (not an ermine:// id, so nothing placed in it
// is ever committed): the shared folder is mounted in it at "folder", and the device's own
// processes live in it. Whatever the folder holds is a fact for everyone; nothing is filtered.
//
//   me                       local, never synced
//     tick                   local node, written once a second: what makes "age" recompute
//     view                   the one process: a compute reading the folder, an effect drawing it
//     folder  -> F           the shared folder: a stored node; its children are the notes
//       <title>   -> note    a stored node, its value the text
//       here:<device> -> Q   an ephemeral node per device; its info "b<slot>" are the beats
//
// Presence: ephemeral blops form a history (each names its parent), and nothing ephemeral is kept, so a
// device that starts hearing Q mid-stream could never link a later blop to the one it missed. A
// beat is therefore written to a fresh info name for its half second, "b<slot>", so every beat
// is the first blop of its own history. Readers read the last few slots.
import { ed25519 } from "npm:@noble/curves@1.9.7/ed25519"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { createScheduler } from "@ermine/scheduler"
import { versions as applied } from "../typescript/apply.ts"
import { id as idOf, is } from "../typescript/id.ts"
import { createDevice, type Device } from "../typescript/transport.ts"
import { createWiring, fresh } from "../typescript/wiring.ts"
import { hexOf } from "../live/blob.ts"
import { type Backend, Storage } from "../live/storage.ts"
import createNode from "@ermine/node"
// deno-lint-ignore no-explicit-any
type Any = any

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the blop `name`, and every blop before it, of one history set: names (hex) to blops
// deno-lint-ignore no-explicit-any
function ancestry(histories: any, name: string): Map<string, Any> {
	const out = new Map<string, Any>()
	const todo = [name]
	while (todo.length) {
		const n = todo.pop()!
		if (out.has(n)) continue
		const b = histories.get(unhex(n))
		if (!b) continue
		out.set(n, b)
		for (const p of b.parents) todo.push(hexOf(p))
	}
	return out
}

// offsets carried through the text patches of the blops the sender had not seen: those in the
// head's ancestry and not in `at`'s, by lamport then name. undefined: `at` is not here (yet)
export function carried(
	histories: Any,
	head: string | undefined,
	spot: Spot,
): [number, number] | undefined {
	let { at, from, to } = spot
	if (from === undefined || to === undefined) return undefined
	if (at === undefined || head === undefined || at === head) return [from, to]
	if (!histories.get(unhex(at))) return undefined
	const known = ancestry(histories, at)
	const unseen = [...ancestry(histories, head)].filter(([n]) => !known.has(n))
		.sort(([an, a], [bn, b]) => a.lamport - b.lamport || (an < bn ? -1 : an > bn ? 1 : 0))
	for (const [, blop] of unseen) {
		if (blop.object !== "value") continue
		for (const patch of blop.patches) {
			// a splice of the text; a whole replacement (no range) leaves the offsets
			if (patch.path.length || !patch.range) continue
			const [s, e] = patch.range as [number, number]
			const L = typeof patch.value === "string" ? Array.from(patch.value).length : 0
			const move = (p: number) => p <= s ? p : p >= e ? p + L - (e - s) : s + L
			from = move(from), to = move(to)
		}
	}
	return [from, to]
}

export const SLOT = 500
const WINDOW = 16
// a device not heard from for this long is "away" (ms)
const AWAY = 8000
const PRESENCE = "here:"

// Selections are offsets (code points) in the text the sender had; "at" names (hex) the blop whose
// version that was, and a receiver carries them through the blops it has that the sender had not.
export type Spot = { at?: string; from?: number; to?: number }

export type Note = { id: string; title: string; loaded: boolean; versions: string[] }
export type Peer = {
	key: string
	name: string
	colour: string
	note?: string
	from?: number
	to?: number
	age: number
	live: boolean
	self: boolean
	// the placement is in the folder, but this device has not the node (yet)
	loaded: boolean
}
export type View = { folder: string; notes: Note[]; peers: Peer[]; mounted: boolean }
export type Status = { server: "joining" | "online" | "offline" | "none"; detail?: string }

export type Options = {
	backend: Backend & { host?(key: string): Promise<Uint8Array | undefined> }
	// the device's seed (32 bytes): its signing key
	seed: Uint8Array
	name: string
	colour: string
	// the folder to open; none: a new one is made
	folder?: string
	server?: string
	service?: string
	// ids are 16 random bytes then zeros, for a server with no grant for a document
	legacy?: boolean
	render?: (view: View) => void
	status?: (status: Status) => void
	log?: (line: string) => void
}

export type Notes = Awaited<ReturnType<typeof start>>

export function newSeed(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32))
}

export async function start(o: Options) {
	const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))
	const log = o.log ?? (() => {})
	const legacy = o.legacy ?? false
	const newId = () => legacy ? "ermine://" + hexOf(random(16)) + "0".repeat(32) : fresh(random)
	const key = ed25519.getPublicKey(o.seed)
	const me = hexOf(key)
	const signer = { key, sign: (m: Uint8Array) => Promise.resolve(ed25519.sign(m, o.seed)) }
	const storage = await Storage.open(o.backend)
	const device: Device = createDevice({ signer, storage: storage as Any })
	const F = o.folder ?? newId()
	if (!is(F)) throw new Error("the folder is not an ermine:// id")
	// the beat carrier is this device's, the same every session
	const qid = (() => {
		const h = blake3(new TextEncoder().encode("ermine/demo/here" + F + me))
		return legacy ? "ermine://" + hexOf(h.slice(0, 16)) + "0".repeat(32) : idOf("unlocked", h)
	})()
	const mine = PRESENCE + me.slice(0, 12)

	// ---- the graph, wired to sync

	// every object a blop arrived for, by document: kept for `bring` (what the graph lacks is
	// that nothing tells which objects a document's histories hold)
	const seen = new Map<string, Map<string, unknown>>()
	device.arrived((a) => {
		let m = seen.get(a.doc)
		if (!m) seen.set(a.doc, m = new Map())
		m.set(JSON.stringify(a.blop.object), a.blop.object)
	})
	const held: Any = {}
	const wiring = createWiring(device, {
		versions: (...a: Any[]) => held.s.internal.versions(...a),
		signer,
		random,
	})
	const s: Any = held.s = createScheduler({
		root: createNode("me", {}),
		actor: me.slice(0, 8),
		site: () => undefined,
		id: () => newId(),
		changed: (r: Any) => wiring.changed(r),
	} as Any)

	// starting again: the device takes in what the storage holds before it connects (TRANSPORT.tex,
	// A device); what it takes in for a node not in memory is brought below

	// ---- bringing a node into memory
	//
	// What was missing: a document that arrived (from storage, or the network) for an id the graph
	// does not hold is dropped by `versions` ("a node not in memory: nothing"), and nothing makes it
	// come back when the node is made. WIRING.tex: how a node gets into memory is the host's. So:
	// make the node empty (the graph loads it), follow it, then give it, object by object, what its
	// histories say, as sync does for an arrival.
	const followed = new Set<string>()
	function follow(id: string) {
		if (followed.has(id)) return
		followed.add(id)
		device.follow(id).catch((e) => log(`follow ${id.slice(9, 17)}: ${e}`))
	}
	function bring(api: Any, id: string, ephemeral: boolean) {
		if (!s.get(id)) api.create(undefined, { id, ephemeral })
		reapply(id, ephemeral)
		follow(id)
	}
	function reapply(id: string, ephemeral: boolean) {
		const histories = device.histories(id, ephemeral ? "ephemeral" : "stored")
		for (const object of seen.get(id)?.values() ?? []) {
			s.internal.versions(id, object, applied(histories, object as Any, () => 0))
		}
	}

	// the shared folder, mounted: the host's own root holds it (a local placement, never committed)
	s.create("tick", { id: "tick" })
	s.insert("me", "tick", "tick")
	// the folder, and one made new gets its first change when a note is made in it
	s.batch(() => {
		s.create(undefined, { id: F })
		s.insert("me", "folder", F)
		reapply(F, false)
	})
	follow(F)

	// ---- the programs

	// the view: reads the mounted folder, tracked; its value is what is on show. Its effect draws,
	// and does what the folder says to be done: node placed here and not loaded are brought in, and
	// this device's own presence is placed
	const asked = new Map<string, number>()
	// per sender and note, the last selection that could be placed
	const placeable = new Map<string, Spot>()
	const view = {
		compute: (
			{ api }: Any,
		): Omit<View, "mounted"> & { wanted: Any[]; empty: string[]; placed: boolean } => {
			const now = Date.now()
			api.content(["tick"]) // tracked: the compute is due again each tick
			const names = api.children(["folder"]) as string[]
			const notes: Note[] = []
			const peers: Peer[] = []
			const wanted: { id: string; ephemeral: boolean }[] = []
			const empty: string[] = []
			const noteIds = new Map<string, string>()
			const k = Math.floor(now / SLOT)
			if (!names.length) empty.push(F)
			for (const name of names) {
				if (!name.startsWith(PRESENCE)) {
					for (const it of api.content(["folder", name])) {
						if (!it.node) wanted.push({ id: it.id, ephemeral: false })
						else if (!it.versions?.length) empty.push(it.id)
						noteIds.set(name, it.id)
						notes.push({
							id: it.id,
							title: name,
							loaded: !!it.node,
							versions: (it.versions ?? []).map((v: Any) => String(v.content ?? "")),
						})
					}
					continue
				}
				for (const it of api.look(["folder", name])) {
					if (!it.node) {
						wanted.push({ id: it.id, ephemeral: true })
						peers.push({
							key: name.slice(PRESENCE.length),
							name: "?",
							colour: "#999",
							age: Infinity,
							live: false,
							self: name === mine,
							loaded: false,
						})
						continue
					}
					// the newest beat in the window, of this carrier
					let beat: Any, at = 0
					for (let j = 0; j < WINDOW && !beat; j++) {
						const got = api.info(["folder", name], "b" + (k - j)).find((x: Any) =>
							x.id === it.id
						)
						const v = got?.versions?.[0]?.content
						if (v) beat = v, at = (k - j) * SLOT
					}
					// the selection, carried forward to the text this device has; one that cannot be
					// placed yet (its `at` not here) is the sender's last one that could be
					let spot: Spot | undefined
					const nid = beat?.note !== undefined ? noteIds.get(beat.note) : undefined
					if (beat && nid && beat.from !== undefined) {
						const histories = device.histories(nid, "stored")
						const head = histories.heads("value")[0]
						const h = head ? hexOf(head.name) : undefined
						const pk = name + "\0" + beat.note
						const raw: Spot = { at: beat.at, from: beat.from, to: beat.to }
						let got = carried(histories, h, raw)
						if (got) placeable.set(pk, raw)
						else if (placeable.has(pk)) got = carried(histories, h, placeable.get(pk)!)
						if (got) spot = { from: got[0], to: got[1] }
					}
					peers.push({
						key: name.slice(PRESENCE.length),
						name: beat?.name ?? "?",
						colour: beat?.colour ?? "#999",
						note: beat?.note,
						from: spot?.from,
						to: spot?.to,
						age: beat ? now - at : Infinity,
						live: !!beat && now - at < AWAY,
						self: name === mine,
						loaded: true,
					})
				}
			}
			return { folder: F, notes, peers, wanted, empty, placed: names.includes(mine) }
		},
		effect: ({ api, value }: Any) => {
			if (!value.placed) {
				// this device's presence: an ephemeral node of this process's, placed in the folder
				if (!s.get(qid)) api.create(undefined, { id: qid, ephemeral: true })
				follow(qid)
				api.insert(F, mine, qid)
			}
			for (const w of value.wanted) bring(api, w.id, w.ephemeral)
			// placed, loaded, and still nothing in it: the sync that follow did may have come before
			// the server had it (follow asks once; nothing says "I am waiting for this"), so ask again
			const now = Date.now()
			for (const id of value.empty) {
				if (now - (asked.get(id) ?? 0) < 2000) continue
				asked.set(id, now)
				device.follow(id).catch(() => {})
			}
			const { wanted: _w, empty: _e, placed: _p, ...shown } = value
			o.render?.({ ...shown, mounted: true })
		},
	}
	s.start({ address: [], name: "view", program: view })

	// ---- the host's side: actions

	const addr = (title: string) => ["folder", title]
	const api = {
		// a new note in the folder; its id. The note is made and sent to the server first, and only
		// then placed in the folder: whoever hears the placement finds the note there to fetch
		async make(title: string, text = ""): Promise<string> {
			const id = s.create(text)
			await wiring.idle()
			await device.idle()
			followed.add(id)
			await device.follow(id)
			s.insert(F, title, id)
			return id
		},
		// the note's text from `old` to `text`: one splice (code points), at the version shown first
		edit(title: string, old: string, text: string, version = 0) {
			const a = Array.from(old), b = Array.from(text)
			let p = 0
			while (p < a.length && p < b.length && a[p] === b[p]) p++
			let q = 0
			while (
				q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]
			) q++
			s.write(addr(title), [{
				path: [],
				range: [p, a.length - q],
				value: b.slice(p, b.length - q).join(""),
			}], version)
		},
		// of several versions, keep this one: the rest are replaced by it
		keep(title: string, version: number, count: number) {
			const text = view_(title)?.versions[version] ?? ""
			s.write(addr(title), [{ path: [], value: text }], version, [0, count])
		},
		// the note leaves the folder; the node is not deleted
		remove(title: string, index = 0) {
			s.remove(F, title, index)
		},
		// where this device's cursor is: sent with the next beat
		at(note?: string, from?: number, to?: number) {
			// "at": the blop whose version the offsets are measured in: the head shown
			const id = note === undefined ? undefined : view_(note)?.id
			const head = id ? device.histories(id, "stored").heads("value")[0] : undefined
			here_ = { note, from, to, at: head ? hexOf(head.name) : undefined }
			dirty = true
		},
	}
	let here_: { note?: string; from?: number; to?: number; at?: string } = {}
	let dirty = true
	let last = 0
	let lastSlot = -1
	const view_ = (title: string) => latest?.notes.find((n) => n.title === title)
	let latest: View | undefined
	const render = o.render
	o.render = (v) => {
		latest = v
		render?.(v)
	}

	// each half second: tick, and a beat if the cursor moved (or two seconds passed). A beat is
	// written once per slot, to the slot's own name, so it begins a history of its own
	const timer = setInterval(() => {
		const now = Date.now(), k = Math.floor(now / SLOT)
		s.write(["tick"], [{ path: [], value: now }])
		if (!s.get(qid) || k === lastSlot || (!dirty && now - last < 2000)) return
		try {
			s.set(
				["folder", mine],
				"b" + k,
				[{ path: [], value: { name: o.name, colour: o.colour, ...here_ } }],
			)
			lastSlot = k, last = now, dirty = false
		} catch (e) {
			log(`beat: ${e}`)
		}
	}, SLOT / 2)

	// ---- the server

	let stop = false
	const server = o.server
	async function connect() {
		if (!server) return o.status?.({ server: "none" })
		while (!stop) {
			o.status?.({ server: "joining" })
			try {
				await device.connectDiscover(server, o.service)
				o.status?.({ server: "online" })
				log(`joined ${server}`)
				return
			} catch (e) {
				o.status?.({ server: "offline", detail: String(e) })
				await new Promise((r) => setTimeout(r, 5000))
			}
		}
	}
	connect()

	return {
		s,
		device,
		folder: F,
		key: me,
		name: o.name,
		...api,
		async idle() {
			await wiring.idle()
			await device.idle()
			await storage.flush()
		},
		async close() {
			stop = true
			clearInterval(timer)
			await wiring.idle().catch(() => {})
			await storage.flush()
			await device.close().catch(() => {})
		},
	}
}
