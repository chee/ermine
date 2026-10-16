import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createPlaces, place, unplace } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import * as lib from "@ermine/places/lib"
import { createStatus } from "@ermine/places/status"
import {
	clear,
	connect as connectPresence,
	ensure,
	readPresence,
	setPresence,
	startSweeper,
} from "@ermine/presence"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { trace } from "@ermine/scheduler/trace"
import { createTable } from "@ermine/table"
import { createChannel } from "@ermine/sync/channel"
import { createSigner } from "@ermine/sync/seal"
import { type Conflict, createSync } from "@ermine/sync/sync"
import { render } from "ermine-h"

// host.ts runs once per restart: this page is one device, a whole ermine with sync beside it, on
// wss://galaxy.observer. it knows nothing of what the program shows. read it as a list of what
// the slaygrounds world (@ermine/slaygrounds/world) and the process api (@ermine/api) don't have
// yet, each wired here by hand and handed to the program as a tool:
//   sync in the world      a signer, a device, a server joined (?server, ?service; /me says how)
//   kept nodes by id       node(id): a kept node followed, to bind, wherever it is (placed or not)
//   placing by hand        place(path, id), unplace(path): a node shown at a path under the root,
//                          local folders made on the way; the graph's places, never synced
//   a new kept id          make(): zeros-tailed when the server needs it (galaxy, until Keyhive)
//   a stored write         store(id, value): one commit
//   an ephemeral write     wave(id, value): sync's ephemeral option, for that one write; the last
//                          per id sent once a frame
//   a room                 room: one kept id everyone opening this example shares
//   presence over the wire pointer(at): my row at the room, sent over sync's channel; /pointers.
//                          a row heard comes outside any run: a pulse after it, or nothing redraws
//   messages over the wire send(topic, value), hear(topic, fn): JSON to whoever listens on a topic
//                          (any string), over sync's channel beside presence: ephemeral, stored
//                          nowhere, not heard by its sender. heard outside any run, as rows are
//   versions               /conflicts: every node given with several versions, and their values
//   settle                 settle(id): one node's versions made one, keeping the one shown
//   teardown in a host run teardown(f): f when this run of the program goes (a reload)
//
//   ?server=wss://… another server (ws://localhost:… for a local subduction_cli), ?server=none none
//   ?service=… the server's service name, when it isn't its host
//   ?room=ermine://… another room
//
// what this device has, as nodes (local, never synced):
//   /me         who this device is: {name, colour, server}
//   /pointers   the others' pointers: [{who, name, colour, x, y, ...}]: and whatever else their row
//               says (a terminal's: look, "nethack" or "pixels"; stuck)
//   /conflicts  each node given (node) with several versions: [{id, versions, values}], values
//               the value of each version not shown (undefined where only other tables differ)
// and whatever the program places (place), under its own names

type Patch = { path: unknown[]; range?: [number, number]; value?: unknown }
type At = { x: number; y: number }
const put = (value: unknown): Patch[] => [{ path: [], value }]

const search = new URL(parent.location.href).searchParams
const server = search.get("server") === "none"
	? undefined
	: search.get("server") ?? "wss://galaxy.observer"
const service = search.get("service") ?? undefined
// galaxy stores an id only when its last 16 bytes are zero (until Keyhive)
const zeros = server !== undefined && !/^wss?:\/\/(localhost|127\.)/.test(server)
const ROOM = search.get("room") ?? "ermine://1a42463ee0b3694e305ac7dd448832e0" + "0".repeat(32)
// a row lasts this long unless renewed; renewed this often when nothing moves
const TTL = 6000
const RENEW = 2000
let serverState = server ? "joining" : "none"

const NAMES = ["otter", "newt", "wren", "moth", "vole", "finch", "toad", "hare", "mole", "kiwi"]
const COLOURS = ["#d1495b", "#2e86ab", "#3b8b5a", "#c27c0e", "#8e44ad", "#16a085", "#e4572e"]
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]
const name = pick(NAMES) + "-" + Math.floor(Math.random() * 100)
const colour = pick(COLOURS)

// ---- the device: the graph, and sync beside it ----
const signer = await createSigner()
const me = Array.from(signer.key, (x) => x.toString(16).padStart(2, "0")).join("")
const s = createScheduler()
const moments: unknown[] = []
trace(s, (m) => (moments.length > 600 && moments.splice(0, 300), moments.push(m)))
// what sync writes comes outside a run: a pulse soon lets the views see it
let due = false
const soon = () => {
	if (due) return
	due = true
	setTimeout(() => (due = false, s.pulse()), 0)
}
const table = createTable((part, id) => {
	places.onTableChange(part, id)
	sync.tableChanged(part, id)
	soon()
})
const places = createPlaces({ root: "root", table, paths: createPaths(), scheduler: s })
s.onTrackingEnd((key) => places.release(key))
// waving: the id whose value is being written ephemerally, for the length of that one write
let waving: string | undefined
const sync = createSync({
	table,
	signer,
	zeros,
	commit: (entries) => (places.commit(entries), soon()),
	ephemeral: (doc, part) => doc === waving && part === "value",
})
const device = sync.device
const host = s.createRootScope([["actor", name]])

// patches to the entry under (part, id), made whole first if none: told to places, then sync
function write(part: string, id: string, patches: Patch[]) {
	s.runWithScope(host, () => {
		let e = table.get(part, id)
		if (e === undefined) {
			table.add(part, id, createEntry(patches[0].value as never, createChangeHeader(s)))
			patches = patches.slice(1)
			e = table.get(part, id)!
		}
		if (patches.length) {
			update(e, patches as never, createChangeHeader(s))
			places.commit([e])
			sync.wrote([e])
		}
	})
	s.pulse()
}
// a local node at a name under the root, and its value replaced
function local(name: string, value: unknown) {
	s.runWithScope(host, () => {
		table.add("value", name, createEntry(value as never, createChangeHeader(s)))
		places.commit(place(table.get("children", "root")!, name, name, createChangeHeader(s)))
	})
}
function set(name: string, value: unknown) {
	s.runWithScope(host, () => {
		const e = table.get("value", name)!
		update(e, put(value) as never, createChangeHeader(s))
		places.commit([e])
	})
	s.pulse()
}

s.runWithScope(host, () => {
	table.add("value", "root", createEntry(undefined, createChangeHeader(s)))
	table.add("children", "root", createEntry({}, createChangeHeader(s)))
})
local("me", { name, colour, server: serverState })
local("pointers", [])
local("conflicts", [])

// ---- placing by hand: a node at a path under the root, its folders local nodes, made as needed ----
const kids = (id: string) => table.get("children", id)?.value as Record<string, string> | undefined
function folder(names: string[]): string {
	let id = "root"
	for (let i = 0; i < names.length; i++) {
		let next = kids(id)?.[names[i]]
		if (next === undefined) {
			next = "/" + names.slice(0, i + 1).join("/")
			table.add("value", next, createEntry(undefined, createChangeHeader(s)))
			table.add("children", next, createEntry({}, createChangeHeader(s)))
			places.commit(place(table.get("children", id)!, names[i], next, createChangeHeader(s)))
		} else if (table.get("children", next) === undefined) {
			// a kept node's children are synced: no folder is made in one by hand
			if (next.startsWith("ermine://")) throw new Error(`${names[i]}: a kept node, not a folder`)
			table.add("children", next, createEntry({}, createChangeHeader(s)))
		}
		id = next
	}
	return id
}

// ---- kept nodes the program asked for: followed, and their versions listed ----
const followed = new Set<string>()
const conflicted = new Map<string, { id: string; versions: number; values: unknown[] }>()
let shownConflicts = "[]"
function follow(id: string) {
	if (followed.has(id)) return
	followed.add(id)
	sync.follow(id).catch((e) => console.error("follow", id, e))
	s.runWithScope(host, () =>
		s.createEffect(
			() => places.readValue("conflicts", id) as Conflict[] | undefined,
			(cs) => {
				if (cs?.length) {
					conflicted.set(id, {
						id,
						versions: 1 + cs.length,
						values: cs.map((c) => c.tables.value),
					})
				} else conflicted.delete(id)
				const all = [...conflicted.values()], q = JSON.stringify(all)
				if (q !== shownConflicts) (shownConflicts = q, set("conflicts", all))
			},
		))
	soon()
}

// ---- the room, and my row at it ----
follow(ROOM)
const world = { table, places, scheduler: s, scope: host }
ensure(world, ROOM)
// a row heard is written outside any run: a pulse soon after, so the pointers are drawn again
const wire = createChannel(device, signer.key)
const channel = {
	...wire,
	on: (topic: string, fn: (from: string, bytes: Uint8Array) => void) =>
		wire.on(topic, (from, bytes) => (fn(from, bytes), soon())),
}
let link = connectPresence(world, channel, { topic: ROOM })
startSweeper(world, 1000)
let pointer: At | undefined
let dirty = true
let last = 0
const beat = () => {
	setPresence(world, ROOM, me, { name, colour, pointer }, TTL)
	last = Date.now(), dirty = false
}
// a moving pointer is sent once a frame at most; otherwise the heartbeat
let frame = false
const soonBeat = () => {
	dirty = true
	if (frame) return
	frame = true
	requestAnimationFrame(() => (frame = false, dirty && beat()))
}
setInterval(() => (dirty || Date.now() - last >= RENEW) && beat(), 250)
// leaving: my row taken out and told, so the others don't wait for it to lapse
addEventListener("pagehide", () => clear(world, ROOM, me))

// ---- the others' pointers, and who I am ----
const clamp = (v: unknown) => Math.min(1, Math.max(0, typeof v === "number" && v === v ? v : 0.5))
let shownPointers = "", shownMe = ""
s.runWithScope(host, () =>
	s.createEffect(() => {
		const pointers = []
		for (const r of readPresence(world, ROOM)) {
			const v = r.value as
				& { name?: string; colour?: string; pointer?: At }
				& Record<string, unknown>
			if (r.who !== me && v?.pointer) {
				// what else their row says (look, stuck, ...), as it says it
				const { name: _, colour: __, pointer: ___, ...rest } = v
				pointers.push({
					...rest,
					who: r.who,
					name: String(v.name ?? r.who.slice(0, 8)),
					colour: String(v.colour ?? "#888"),
					x: clamp(v.pointer.x),
					y: clamp(v.pointer.y),
				})
			}
		}
		return pointers
	}, (pointers) => {
		const q = JSON.stringify(pointers)
		const m = JSON.stringify({ name, colour, server: serverState })
		if (q !== shownPointers) (shownPointers = q, set("pointers", pointers))
		if (m !== shownMe) (shownMe = m, set("me", JSON.parse(m)))
	}))

// ---- messages over the wire, beside presence: JSON on a topic ----
const hearings = new Set<
	{ topic: string; fn: (from: string, value: unknown) => void; off: () => void }
>()
function listen(h: { topic: string; fn: (from: string, value: unknown) => void }) {
	return channel.on(h.topic, (from, bytes) => {
		try {
			h.fn(from, JSON.parse(new TextDecoder().decode(bytes)))
		} catch { /* not JSON: not one of ours */ }
	})
}

// ---- the server ----
async function join() {
	if (!server) return
	for (;;) {
		try {
			await device.connectDiscover(server, service)
			serverState = "online"
			// a listen made before the connection is not subscribed on it: listen again
			link.stop()
			link = connectPresence(world, channel, { topic: ROOM })
			link.announce()
			for (const h of hearings) h.off(), h.off = listen(h)
			soonBeat()
			return
		} catch (e) {
			serverState = "offline: " + String(e)
			soonBeat()
			await new Promise((r) => setTimeout(r, 5000))
		}
	}
}
join()

// ---- what the program is handed ----
// ephemeral writes are sent once a frame at most, the last for each id
const waves = new Map<string, unknown>()
let flushing = false
const flush = () => {
	flushing = false
	for (const [id, value] of waves) {
		waving = id
		try {
			write("value", id, put(value))
		} finally {
			waving = undefined
		}
	}
	waves.clear()
}
const tools = {
	me,
	name,
	colour,
	// the kept id everyone who opens this example shares (the presence rows are at it)
	room: ROOM,
	// a new kept id (its last 16 bytes zero when the server needs it)
	make: () => sync.mint(),
	// a kept node by id, to bind (bind(t.node(id), …)): followed, its versions in /conflicts
	node(id: string) {
		follow(id)
		return { id }
	},
	// a node shown at a path under the root ("/pigs/a"): its folders made, what was there replaced
	place(path: string, id: string) {
		const names = path.split("/").filter(Boolean)
		s.runWithScope(host, () => {
			const at = table.get("children", folder(names.slice(0, -1)))!, name = names.at(-1)!
			const had = (at.value as Record<string, unknown> | undefined)?.[name]
			if (had === id) return
			if (had !== undefined) places.commit(unplace(at, name, createChangeHeader(s)))
			places.commit(place(at, name, id, createChangeHeader(s)))
		})
		s.pulse()
	},
	// what is at a path taken out of its place (the node stays); nothing there: nothing
	unplace(path: string) {
		const names = path.split("/").filter(Boolean)
		let id = "root"
		for (const n of names.slice(0, -1)) {
			const next = kids(id)?.[n]
			if (next === undefined) return
			id = next
		}
		const at = table.get("children", id)
		if (at === undefined || kids(id)?.[names.at(-1)!] === undefined) return
		s.runWithScope(host, () => places.commit(unplace(at, names.at(-1)!, createChangeHeader(s))))
		s.pulse()
	},
	// the node's value, a stored commit; an ephemeral one not yet sent for it is dropped
	store(id: string, value: unknown) {
		waves.delete(id)
		follow(id)
		write("value", id, put(value))
	},
	// the node's value, an ephemeral commit: everyone sees it on top of what is stored, nothing
	// stores it, and it stops standing at this device's next store there (or when it goes quiet)
	wave(id: string, value: unknown) {
		follow(id)
		waves.set(id, value)
		if (!flushing) flushing = true, requestAnimationFrame(flush)
	},
	// my pointer over the field (0 to 1 each way), or gone: ephemeral, in my presence row
	pointer(at: At | undefined) {
		pointer = at
		soonBeat()
	},
	// a message, JSON, to whoever listens on the topic (not heard here): ephemeral, stored nowhere
	send(topic: string, value: unknown) {
		wire.send(topic, new TextEncoder().encode(JSON.stringify(value)))
	},
	// each message on the topic: fn(the sender's key, its value), outside any run. gives back the stop
	hear(topic: string, fn: (from: string, value: unknown) => void) {
		const h = { topic, fn, off: () => {} }
		h.off = listen(h)
		hearings.add(h)
		return () => (h.off(), hearings.delete(h))
	},
	// the node's versions made one, keeping the one shown
	settle: (id: string) => s.runWithScope(host, () => sync.settle(id, createChangeHeader(s))),
	// f called when this run of the program goes (a reload)
	teardown(f: () => void) {
		const scope = s.getCurrentScope()
		if (scope) s.registerTeardown(scope, f)
	},
}
export type Tools = typeof tools

// ---- what ermine-h is handed: this device's places, read from its root ----
const viewer = {
	name,
	where: () => [],
	find(address: string[]) {
		const path = address.filter((a) => a !== "/" && a !== "")
		const id = lib.get(places, path)
		return id === undefined ? [] : [{ id, name: path[path.length - 1], path }]
	},
	get: (item: { id: unknown }) => places.readValue("value", item.id as string),
	call: () => undefined,
	effect: (read: () => unknown, act: (v: unknown, before: unknown) => void) =>
		s.createEffect(read, act),
}

const style = document.createElement("style")
style.textContent = `
	body { margin: 0; font: 13px/1.4 ui-monospace, Menlo, monospace; background: #fffbe8; color: #111; }
	button { font: inherit; border: 1px solid #111; background: #fff; padding: 0 6px; cursor: pointer; }
	button:hover { background: #ffe066; }
`
document.head.append(style)
const box = document.body.appendChild(document.createElement("div"))
const scope: { run?: unknown } = {}
globalThis.ermine = {
	table,
	places,
	s,
	header: (extra?: unknown) => createChangeHeader(s, extra as never),
	writes: {},
	parts: new Map(),
	statusIds: new Map(),
	statuses: createStatus({ places, table, scheduler: s }),
	pending: () => false,
	moments,
	host,
	call: () => undefined,
	defined: new Map(),
	binds: new WeakMap(),
	sync,
}

// a reload: the old view goes with its scope, the program runs again
export function reload(mod: { default: (t: Tools) => unknown }) {
	if (scope.run) s.teardown(scope.run as never)
	const run = scope.run = s.createScope([["run", Date.now()]], host)
	s.runWithScope(run, () => {
		const made = mod.default(tools)
		if (made !== undefined) render(box, made as never, viewer as never)
	})
	s.pulse()
}
