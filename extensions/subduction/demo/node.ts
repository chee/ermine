// A device of the notes demo, no DOM: runs in a browser tab and in Deno (peer.ts). Everything here
// is the host's side, built from today's parts: a device (typescript/transport.ts), the world around
// the wiring (typescript/world.ts: table, places, scheduler), and a view that is a compute and an
// effect. Left out of the old demo: several heads of a note shown from the table (a note's versions
// are read from its histories), and a presence node's own value.
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
import { versions as applied } from "../typescript/apply.ts"
import { id as idOf, is } from "../typescript/id.ts"
import { createDevice, type Device } from "../typescript/transport.ts"
import { fresh } from "../typescript/wiring.ts"
import { createWorld } from "../typescript/world.ts"
import { hexOf } from "../live/blob.ts"
import { type Backend, Storage } from "../live/storage.ts"
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

	// every object a blop arrived for, by document: kept for `reapply`
	const seen = new Map<string, Map<string, unknown>>()
	device.arrived((a) => {
		let m = seen.get(a.doc)
		if (!m) seen.set(a.doc, m = new Map())
		m.set(JSON.stringify(a.blop.object), a.blop.object)
	})
	const world = createWorld(device, {
		root: "me",
		actor: me.slice(0, 8),
		signer,
		random,
		// the table shows one head of several: the view is due on any blop taken in
		arrived: () => bump(),
	})
	const { scheduler: sch, table, places } = world
	const bump = () => world.write("value", "tick", [{ path: [], value: Date.now() }])
	const isMap = (x: unknown): x is Record<string, unknown> =>
		x !== null && typeof x === "object" && !Array.isArray(x)
	const put = (value: unknown) => [{ path: [], value }]

	// starting again: the device takes in what the storage holds before it connects (TRANSPORT.tex,
	// A device); what it takes in is written to the table as it arrives

	// ---- bringing a node into memory
	//
	// A node in the folder that this device has no version of is followed (the sync that does it
	// asks once), and what its histories say is given to the table, object by object, as sync does
	// for an arrival. For an ephemeral node the layer is its own.
	const followed = new Set<string>()
	function follow(id: string) {
		if (followed.has(id)) return
		followed.add(id)
		device.follow(id).catch((e) => log(`follow ${id.slice(9, 17)}: ${e}`))
	}
	function bring(id: string, ephemeral: boolean) {
		reapply(id, ephemeral)
		follow(id)
	}
	function reapply(id: string, ephemeral: boolean) {
		const histories = device.histories(id, ephemeral ? "ephemeral" : "stored")
		for (const object of seen.get(id)?.values() ?? []) {
			world.versions(id, object as Any, applied(histories, object as Any, () => 0), {
				actor: me,
				signer: me,
				name: "",
			})
		}
	}

	// this device's root is local, never committed: the shared folder is mounted in it at "folder"
	world.write("value", "tick", put(Date.now()))
	world.write("children", "me", put({ tick: "tick", folder: F }))
	reapply(F, false)
	follow(F)

	// ---- the view

	// reads the mounted folder, tracked; its value is what is on show. Its effect draws, and does
	// what the folder says to be done: nodes placed here and not loaded are brought in, and this
	// device's own presence is placed
	const asked = new Map<string, number>()
	// per sender and note, the last selection that could be placed
	const placeable = new Map<string, Spot>()
	const compute = (): Omit<View, "mounted"> & {
		wanted: Any[]
		empty: string[]
		placed: boolean
	} => {
		const now = Date.now()
		places.readValue("value", "tick") // tracked: the compute is due again each tick
		// notes before presences: a beat names the note it is in
		const names = places.readKeys("children", F).sort((a, b) =>
			Number(a.startsWith(PRESENCE)) - Number(b.startsWith(PRESENCE))
		)
		const notes: Note[] = []
		const peers: Peer[] = []
		const wanted: { id: string; ephemeral: boolean }[] = []
		const empty: string[] = []
		const noteIds = new Map<string, string>()
		const k = Math.floor(now / SLOT)
		if (!names.length) empty.push(F)
		for (const name of names) {
			const id = places.readValue("children", F, [name])
			if (typeof id !== "string") continue
			if (!name.startsWith(PRESENCE)) {
				const value = places.readValue("value", id)
				const loaded = table.get("value", id) !== undefined
				const versions = applied(device.histories(id, "stored"), "value", () => 0)
					.map((v) => String(v.content ?? ""))
				if (!loaded) wanted.push({ id, ephemeral: false })
				else if (!versions.length && value === undefined) empty.push(id)
				noteIds.set(name, id)
				notes.push({ id, title: name, loaded, versions })
				continue
			}
			const loaded = table.get("attributes", id) !== undefined
			places.readKeys("attributes", id) // tracked: due when a beat is added
			if (!loaded) {
				wanted.push({ id, ephemeral: true })
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
				const v = places.readValue("attributes", id, ["b" + (k - j)])
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
		return { folder: F, notes, peers, wanted, empty, placed: names.includes(mine) }
	}
	const effect = (value: ReturnType<typeof compute>) => {
		if (!value.placed) {
			// this device's presence: an ephemeral node of this process's, placed in the folder
			follow(qid)
			insert(F, mine, qid)
		}
		for (const w of value.wanted) bring(w.id, w.ephemeral)
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
	}
	sch.runWithScope(world.host, () => sch.createEffect(compute, effect))

	// a name in a node's children, holding an id
	const insert = (parent: string, name: string, id: string) =>
		world.write("children", parent, [
			...isMap(table.get("children", parent)?.value) ? [] : put({}),
			{ path: [name], value: id },
		])

	// ---- the host's side: actions

	// the id of the note under a title in the folder
	const noteId = (title: string) => {
		const kids = table.get("children", F)?.value
		const id = isMap(kids) ? kids[title] : undefined
		return typeof id === "string" ? id : undefined
	}
	const api = {
		// a new note in the folder; its id. The note is made and sent to the server first, and only
		// then placed in the folder: whoever hears the placement finds the note there to fetch
		async make(title: string, text = ""): Promise<string> {
			const id = newId()
			world.write("value", id, put(text))
			await world.wiring.idle()
			await device.idle()
			followed.add(id)
			await device.follow(id)
			insert(F, title, id)
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
			const id = noteId(title)
			if (id === undefined) return
			world.write("value", id, [{
				path: [],
				range: [p, a.length - q],
				value: b.slice(p, b.length - q).join(""),
			}], { at: version })
		},
		// of several versions, keep this one: the rest are replaced by it
		keep(title: string, version: number, count: number) {
			const text = view_(title)?.versions[version] ?? ""
			const id = noteId(title)
			if (id === undefined) return
			world.write("value", id, put(text), { at: [0, count] })
		},
		// the note leaves the folder; the node is not deleted
		remove(title: string, index = 0) {
			// one name holds one id now, so there is only the first
			void index
			if (noteId(title) !== undefined) world.write("children", F, [{ path: [title] }])
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
		bump()
		if (noteId(mine) === undefined || k === lastSlot || (!dirty && now - last < 2000)) return
		try {
			const beat = { name: o.name, colour: o.colour, ...here_ }
			world.write("attributes", qid, [
				...isMap(table.get("attributes", qid)?.value) ? [] : put({}),
				{ path: ["b" + k], value: beat },
			], { ephemeral: true })
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
		world,
		device,
		folder: F,
		key: me,
		name: o.name,
		...api,
		async idle() {
			await world.wiring.idle()
			await device.idle()
			await storage.flush()
		},
		async close() {
			stop = true
			clearInterval(timer)
			await world.wiring.idle().catch(() => {})
			await storage.flush()
			await device.close().catch(() => {})
		},
	}
}
