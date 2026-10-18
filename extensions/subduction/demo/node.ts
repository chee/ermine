// a device of the notes demo, no DOM: runs in a browser tab and in deno (check.ts). everything here
// is the host's side, composed as sync_test.ts composes one: a table, places and a scheduler, with
// sync (@ermine/sync) beside places, and a view that is a compute and an effect. the table's
// listener tells places and then sync; each write is told to places, then to sync.
//
// the picture: subduction is a networked filesystem; the graph in memory is this device's open view
// of it. this device's graph has a local root, "me" (not an ermine:// id, so nothing placed in it
// is ever committed): the shared folder is mounted in it at "folder", and the device's own
// processes live in it. whatever the folder holds is a fact for everyone; nothing is filtered.
//
//   me                       local, never synced
//     tick                   local node, written every half second: what makes the view recompute
//     view                   the one process: a compute reading the folder, an effect drawing it
//     folder  -> F           the shared folder: a kept node; its children are the notes
//       <title>   -> note    a kept node, its value the text
//
// several versions of a note: the value table shows one head, and the others are in the note's
// "conflicts" table; the view lists them all. keeping one writes it and settles the heads.
//
// presence: who is here and where their cursor is, rows in the presence part at the folder
// (playground/presence), sent over sync's channel (the device's ephemeral messages) and never kept.
// a row lasts a few seconds and is renewed while its device is here, so a device that goes quiet
// leaves by itself
import { decode } from "@ermine/encoding/commit"
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { createPlaces } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import {
	connect as connectPresence,
	ensure,
	readPresence,
	setPresence,
	startSweeper,
} from "@ermine/presence"
import { createChannel } from "@ermine/sync/channel"
import type { History } from "@ermine/sync/history"
import { type Conflict, createSync } from "@ermine/sync/sync"
import { createSigner } from "@ermine/sync/seal"
import { hexOf, unhex } from "../live/blob.ts"
import { type Backend, Storage } from "../live/storage.ts"
// deno-lint-ignore no-explicit-any
type Any = any

// the commit `name`, and every commit before it, of one history: names (hex) to their commits
function ancestry(history: History, name: string) {
	const out = new Map<string, ReturnType<typeof decode>>()
	const todo = [name]
	while (todo.length) {
		const n = todo.pop()!
		if (out.has(n)) continue
		const k = history.get(unhex(n))
		if (!k) continue
		out.set(n, decode(k.bytes))
		for (const p of k.parents) todo.push(hexOf(p))
	}
	return out
}

// offsets carried through the text patches of the commits the sender had not seen: those in the
// head's ancestry and not in `at`'s, by lamport then name. undefined: `at` is not here (yet)
export function carried(
	history: History,
	head: string | undefined,
	spot: Spot,
): [number, number] | undefined {
	let { at, from, to } = spot
	if (from === undefined || to === undefined) return undefined
	if (at === undefined || head === undefined || at === head) return [from, to]
	if (!history.get(unhex(at))) return undefined
	const known = ancestry(history, at)
	const unseen = [...ancestry(history, head)].filter(([n]) => !known.has(n))
		.sort(([an, a], [bn, b]) =>
			history.get(unhex(an))!.lamport - history.get(unhex(bn))!.lamport ||
			(an < bn ? -1 : an > bn ? 1 : 0)
		)
	for (const [, commit] of unseen) {
		if (commit.table !== "value") continue
		for (const patch of commit.patches as Patch[]) {
			// a splice of the text; a whole replacement (no range) leaves the offsets
			if (patch.path.length || !patch.range) continue
			const [s, e] = patch.range
			const L = typeof patch.value === "string" ? Array.from(patch.value).length : 0
			const move = (p: number) => p <= s ? p : p >= e ? p + L - (e - s) : s + L
			from = move(from), to = move(to)
		}
	}
	return [from, to]
}

export const SLOT = 500
// a presence row lasts this long (ms) unless renewed; renewed this often
const TTL = 6000
const RENEW = 2000

// selections are offsets (code points) in the text the sender had; "at" names (hex) the commit
// whose version that was, and a receiver carries them through the commits it has that the sender
// had not
export type Spot = { at?: string; from?: number; to?: number }

// versions: the text shown, then the text of each other head that differs in the value
export type Note = { id: string; title: string; loaded: boolean; versions: string[] }
export type Peer = {
	key: string
	name: string
	colour: string
	note?: string
	from?: number
	to?: number
	live: boolean
	self: boolean
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
	// ids are 16 random bytes then zeros, for a server with no grant for a document (until Keyhive)
	zeros?: boolean
	render?: (view: View) => void
	status?: (status: Status) => void
	log?: (line: string) => void
}

export type Notes = Awaited<ReturnType<typeof start>>

export function newSeed(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(32))
}

const ID = /^ermine:\/\/[0-9a-f]{64}$/
const isMap = (x: unknown): x is Record<string, unknown> =>
	x !== null && typeof x === "object" && !Array.isArray(x)
const put = (value: unknown): Patch[] => [{ path: [], value }]

export async function start(o: Options) {
	const log = o.log ?? (() => {})
	const signer = await createSigner(o.seed)
	const me = hexOf(signer.key)
	const storage = await Storage.open(o.backend)
	// saves resolve before they are kept (live/storage.ts): flushed every few seconds, so a write
	// that failed is told, and on the way out, which a browser may not wait for
	const flushed = () => storage.flush().catch((e) => log(`storage: ${e}`))
	const flushing = setInterval(flushed, 2000)
	const away = () => void flushed()
	globalThis.addEventListener?.("pagehide", away)
	globalThis.addEventListener?.("beforeunload", away)

	// ---- the host: table, places, scheduler, and sync beside them

	const scheduler = createScheduler()
	// what comes in from sync changes the table outside a run: a pulse soon makes the view see it
	let due = false
	const soon = () => {
		if (due) return
		due = true
		setTimeout(() => (due = false, scheduler.pulse()), 0)
	}
	const table = createTable((part, id) => {
		places.onTableChange(part, id)
		sync.tableChanged(part, id)
		soon()
	})
	const places = createPlaces({ root: "me", table, paths: createPaths<unknown>(), scheduler })
	scheduler.onTrackingEnd((key) => places.release(key))
	const sync = createSync({
		table,
		signer,
		zeros: o.zeros,
		storage: storage as Any,
		commit: (changed) => (places.commit(changed), soon()),
	})
	const device = sync.device
	const host = scheduler.createRootScope({ actor: me.slice(0, 8) })

	// patches to the entry under (part, id), made whole first if none: told to places, then to sync
	function write(part: Key, id: Id, patches: Patch[]) {
		scheduler.runWithScope(host, () => {
			const header = createChangeHeader(scheduler)
			let entry = table.get(part, id)
			if (entry === undefined) {
				table.add(part, id, createEntry(patches[0].value as never, header))
				patches = patches.slice(1)
				entry = table.get(part, id)!
			}
			if (patches.length) {
				update(entry, patches as never, createChangeHeader(scheduler))
				places.commit([entry])
				sync.wrote([entry])
			}
		})
		scheduler.pulse()
	}

	const F = o.folder ?? sync.mint()
	if (!ID.test(F)) throw new Error("the folder is not an ermine:// id")

	// ---- bringing a node into memory
	//
	// a node in the folder that this device has no version of is followed, and sync writes it to the
	// table as it arrives

	const asked = new Map<string, number>()
	const follow = (id: string) =>
		sync.follow(id).catch((e) => log(`follow ${id.slice(9, 17)}: ${e}`))

	// this device's root is local, never committed: the shared folder is mounted in it at "folder"
	const bump = () => write("value", "tick", put(Date.now()))
	bump()
	write("children", "me", put({ tick: "tick", folder: F }))
	await device.ready()
	follow(F)

	// ---- presence

	const world = { table, places, scheduler, scope: host }
	ensure(world, F)
	const channel = createChannel(device, signer.key)
	let link = connectPresence(world, channel, { topic: F })
	const stopSweeper = startSweeper(world, 1000)
	let here_: { note?: string; from?: number; to?: number; at?: string } = {}
	let dirty = true
	let last = 0
	const beat = () => {
		setPresence(world, F, me, { name: o.name, colour: o.colour, ...here_ }, TTL)
		last = Date.now(), dirty = false
	}

	// ---- the view

	// reads the mounted folder, tracked; its value is what is on show. its effect draws, and does
	// what the folder says to be done: nodes placed here and not loaded are brought in
	// per sender and note, the last selection that could be placed
	const placeable = new Map<string, Spot>()
	const compute = (): Omit<View, "mounted"> & { wanted: string[]; empty: string[] } => {
		places.readValue("value", "tick") // tracked: the compute is due again each tick
		const notes: Note[] = []
		const peers: Peer[] = []
		const wanted: string[] = []
		const empty: string[] = []
		const noteIds = new Map<string, string>()
		const names = places.readKeys("children", F)
		if (!names.length) empty.push(F)
		for (const name of names) {
			const id = places.readValue("children", F, [name])
			if (typeof id !== "string") continue
			const value = places.readValue("value", id)
			const others = (places.readValue("conflicts", id) ?? []) as Conflict[]
			const loaded = table.get("value", id) !== undefined
			const versions = loaded
				? [
					String(value ?? ""),
					...others.filter((c) => "value" in c.tables).map((c) =>
						String(c.tables.value ?? "")
					),
				]
				: []
			if (!loaded) wanted.push(id)
			else if (value === undefined) empty.push(id)
			noteIds.set(name, id)
			notes.push({ id, title: name, loaded, versions })
		}
		for (const row of readPresence(world, F)) {
			const b = row.value as Any
			// the selection, carried forward to the text this device has; one that cannot be placed
			// yet (its `at` not here) is the sender's last one that could be
			let spot: Spot | undefined
			const nid = b?.note !== undefined ? noteIds.get(b.note) : undefined
			if (b && nid && b.from !== undefined) {
				const history = device.history(nid)
				const head = history.heads()[0]
				const h = head ? hexOf(head.name) : undefined
				const pk = row.who + "\0" + b.note
				const raw: Spot = { at: b.at, from: b.from, to: b.to }
				let got = carried(history, h, raw)
				if (got) placeable.set(pk, raw)
				else if (placeable.has(pk)) got = carried(history, h, placeable.get(pk)!)
				if (got) spot = { from: got[0], to: got[1] }
			}
			peers.push({
				key: row.who,
				name: b?.name ?? "?",
				colour: b?.colour ?? "#999",
				note: b?.note,
				from: spot?.from,
				to: spot?.to,
				live: true,
				self: row.who === me,
			})
		}
		return { folder: F, notes, peers, wanted, empty }
	}
	const effect = (value: ReturnType<typeof compute>) => {
		for (const id of value.wanted) follow(id)
		// placed, loaded, and still nothing in it: the sync that follow did may have come before the
		// server had it (follow asks once; nothing says "i am waiting for this"), so ask again
		const now = Date.now()
		for (const id of value.empty) {
			if (now - (asked.get(id) ?? 0) < 2000) continue
			asked.set(id, now)
			device.follow(id).catch(() => {})
		}
		const { wanted: _w, empty: _e, ...shown } = value
		o.render?.({ ...shown, mounted: true })
	}
	scheduler.runWithScope(host, () => scheduler.createEffect(compute, effect))

	// ---- the host's side: actions

	// the id of the note under a title in the folder
	const noteId = (title: string) => {
		const kids = table.get("children", F)?.value
		const id = isMap(kids) ? kids[title] : undefined
		return typeof id === "string" ? id : undefined
	}
	let latest: View | undefined
	const render = o.render
	o.render = (v) => {
		latest = v
		render?.(v)
	}
	const view_ = (title: string) => latest?.notes.find((n) => n.title === title)
	const api = {
		// a new note in the folder; its id. the note is made and sent first, and only then placed in
		// the folder: whoever hears the placement finds the note there to fetch
		async make(title: string, text = ""): Promise<string> {
			const id = sync.mint()
			write("value", id, put(text))
			await sync.idle()
			await follow(id)
			write("children", F, [
				...isMap(table.get("children", F)?.value) ? [] : put({}),
				{ path: [title], value: id },
			])
			return id
		},
		// the note's text from `old` to `text`: one splice (code points), on the version shown
		edit(title: string, old: string, text: string) {
			const a = Array.from(old), b = Array.from(text)
			let p = 0
			while (p < a.length && p < b.length && a[p] === b[p]) p++
			let q = 0
			while (
				q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]
			) q++
			const id = noteId(title)
			if (id === undefined) return
			write("value", id, [{
				path: [],
				range: [p, a.length - q],
				value: b.slice(p, b.length - q).join(""),
			}])
		},
		// of several versions, keep this one: it is written (unless it is the one shown) and the heads
		// are settled
		keep(title: string, version: number) {
			const id = noteId(title)
			if (id === undefined) return
			const text = view_(title)?.versions[version] ?? ""
			if (version > 0) write("value", id, put(text))
			scheduler.runWithScope(host, () => sync.settle(id, createChangeHeader(scheduler)))
			scheduler.pulse()
		},
		// the note leaves the folder; the node is not deleted
		remove(title: string) {
			if (noteId(title) !== undefined) write("children", F, [{ path: [title] }])
		},
		// where this device's cursor is: sent with the next beat
		at(note?: string, from?: number, to?: number) {
			// "at": the commit whose version the offsets are measured in: the head shown
			const id = note === undefined ? undefined : view_(note)?.id
			const head = id ? device.history(id).heads()[0] : undefined
			here_ = { note, from, to, at: head ? hexOf(head.name) : undefined }
			dirty = true
		},
	}

	// each half second: tick, and a beat if the cursor moved or the last one is getting old
	const timer = setInterval(() => {
		bump()
		if (dirty || Date.now() - last >= RENEW) {
			try {
				beat()
			} catch (e) {
				log(`beat: ${e}`)
			}
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
				// a listen made before the connection is not subscribed on it: listen again
				link.stop()
				link = connectPresence(world, channel, { topic: F })
				link.announce()
				return
			} catch (e) {
				o.status?.({ server: "offline", detail: String(e) })
				await new Promise((r) => setTimeout(r, 5000))
			}
		}
	}
	connect()

	return {
		sync,
		device,
		table,
		places,
		folder: F,
		key: me,
		name: o.name,
		...api,
		async idle() {
			await sync.idle()
			await storage.flush()
		},
		async close() {
			stop = true
			clearInterval(timer)
			clearInterval(flushing)
			globalThis.removeEventListener?.("pagehide", away)
			globalThis.removeEventListener?.("beforeunload", away)
			stopSweeper()
			link.stop()
			await sync.idle().catch(() => {})
			await storage.flush()
			await device.close().catch(() => {})
		},
	}
}
