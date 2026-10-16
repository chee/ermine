import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createPlaces, place } from "@ermine/places"
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
import { createTable, type Key } from "@ermine/table"
import { createChannel } from "@ermine/sync/channel"
import { createSigner } from "@ermine/sync/seal"
import { createSync } from "@ermine/sync/sync"
import { egwalker } from "@ermine/sync/egwalker"
import { render } from "ermine-h"

// host.ts runs once per restart: this page is one device, a whole ermine (a table, places, a
// scheduler) with sync beside it (@ermine/sync over Subduction), joined to wss://galaxy.observer.
// everyone who opens this example is in one room. joining, a device makes a note of its own and
// says so in its presence row (the ephemeral place: a row a device at the room's id, sent over
// sync's ephemeral messages, never kept), renewed by a heartbeat. every device shows a note for
// each row that is alive: when a device leaves, its heartbeat stops, its row lapses, and its note
// drops away. where each one's cursor is goes in its row too.
//   ?server=wss://… another server (ws://localhost:… for a local subduction_cli), ?server=none none
//   ?service=… the server's service name, when it isn't its host (a local subduction_cli: ermine)
//   ?room=ermine://… another room
//
// merging is off at first: a note with several versions shows the first, and settle keeps it.
// switched on, this device merges them by eg-walker (@ermine/sync/egwalker): two windows typing in
// one note see one text. it knows the rule either way, so it takes in what a merging device wrote
//
// what this device has, as nodes (local, never synced):
//   /me      who this device is, the server, its own note's commits and fragments
//   /peers   the notes on show: one a live row, this device's first

type Patch = { path: unknown[]; range?: [number, number]; value?: unknown }
const put = (value: unknown): Patch[] => [{ path: [], value }]
const points = (s: string) => Array.from(s)

const search = new URL(parent.location.href).searchParams
const server = search.get("server") === "none"
	? undefined
	: search.get("server") ?? "wss://galaxy.observer"
const service = search.get("service") ?? undefined
// galaxy stores an id only when its last 16 bytes are zero (until Keyhive)
const zeros = server !== undefined && !/^wss?:\/\/(localhost|127\.)/.test(server)
const ROOM = search.get("room") ?? "ermine://001f0433dad341e9b7664587af0aa79f" + "0".repeat(32)
// a row lasts this long unless renewed; renewed this often, and at once when the cursor moves
const TTL = 6000
const RENEW = 2000
// /me: a redraw is due; the server as last heard
let waiting = false
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
const sync = createSync({
	table,
	signer,
	zeros,
	merges: { "eg-walker": egwalker },
	commit: (entries) => (places.commit(entries), soon()),
})
const device = sync.device
const host = s.createRootScope([["actor", name]])

// patches to the entry under (part, id), made whole first if none: told to places, then sync
function write(part: Key, id: string, patches: Patch[]) {
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
	if (id === mine) changed()
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
let merging = false
local("me", { name, colour, server: server ? "joining" : "none", merging })
local("peers", [])

// ---- my note, and my row in the room ----
const mine = sync.mint()
write("value", mine, put(""))
const world = { table, places, scheduler: s, scope: host }
ensure(world, ROOM)
const channel = createChannel(device, signer.key)
let link = connectPresence(world, channel, { topic: ROOM })
startSweeper(world, 1000)
let cursor: { note: string; from: number; to: number } | undefined
let dirty = true
let last = 0
const beat = () => {
	setPresence(world, ROOM, me, { name, colour, note: mine, cursor }, TTL)
	last = Date.now(), dirty = false
}
setInterval(() => (dirty || Date.now() - last >= RENEW) && beat(), 250)
// leaving: my row taken out and told, so the others don't wait for it to lapse
addEventListener("pagehide", () => clear(world, ROOM, me))

// /me again, soon: after a write or an arrival
function changed() {
	if (waiting) return
	waiting = true
	setTimeout(async () => {
		waiting = false
		const frags = device.fragments(mine)
		set("me", {
			name,
			colour,
			server: serverState,
			merging,
			commits: device.history(mine).all().length,
			loose: (await device.stored(mine)).length,
			fragments: frags.length,
			covered: frags.reduce((t, f) => t + f.members.length, 0),
		})
	}, 30)
}
device.arrived(() => changed())

// ---- the notes on show: one for each live row; each followed as it appears ----
type Peer = {
	who: string
	name: string
	colour: string
	note: string
	me: boolean
	versions: number
}
const ID = /^ermine:\/\/[0-9a-f]{64}$/
const followed = new Set<string>()
let shown = ""
s.runWithScope(host, () =>
	s.createEffect(() => {
		const peers: Peer[] = []
		for (const r of readPresence(world, ROOM)) {
			const v = r.value as { name?: string; colour?: string; note?: string }
			if (typeof v?.note !== "string" || !ID.test(v.note)) continue
			const conflicts = places.readValue("conflicts", v.note) as unknown[] | undefined
			peers.push({
				who: r.who,
				name: String(v.name ?? r.who.slice(0, 8)),
				colour: String(v.colour ?? "#888"),
				note: v.note,
				me: r.who === me,
				versions: 1 + (conflicts?.length ?? 0),
			})
		}
		return peers.sort((a, b) => Number(b.me) - Number(a.me) || (a.name < b.name ? -1 : 1))
	}, (peers) => {
		for (const p of peers) {
			if (followed.has(p.note) || p.note === mine) continue
			followed.add(p.note)
			sync.follow(p.note).catch((e) => console.error("follow", p.note, e))
		}
		const now = JSON.stringify(peers)
		if (now !== shown) (shown = now, set("peers", peers))
	}))

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
			changed()
			return
		} catch (e) {
			serverState = "offline: " + String(e)
			changed()
			await new Promise((r) => setTimeout(r, 5000))
		}
	}
}
join()

// ---- a note's pad: its text, and the others' cursors drawn in a mirror behind it ----
const esc = (t: string) =>
	t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
// where a position in a was, in b: the unchanged start and end hold it, the middle moves it
function carry(a: string, b: string, pos: number) {
	let p = 0
	while (p < a.length && p < b.length && a[p] === b[p]) p++
	let q = 0
	while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
	if (pos <= p) return pos
	if (pos >= a.length - q) return pos + (b.length - a.length)
	return p
}
// code points before a UTF-16 offset
const cp = (t: string, units: number) => points(t.slice(0, units)).length
type Mark = { from: number; to: number; colour: string; name: string }

const pads = new Map<string, HTMLElement>()
function pad(note: string): HTMLElement {
	const kept = pads.get(note)
	if (kept) return kept
	const box = document.createElement("div")
	box.className = "pad"
	const mirror = box.appendChild(document.createElement("div"))
	mirror.className = "mirror"
	const area = box.appendChild(document.createElement("textarea"))
	area.spellcheck = false
	area.placeholder = note === mine ? "your note: type here" : ""
	let text = ""
	// where my cursor is in this note: sent with the next beat
	const where = () => {
		const next = {
			note,
			from: cp(area.value, area.selectionStart),
			to: cp(area.value, area.selectionEnd),
		}
		if (JSON.stringify(next) !== JSON.stringify(cursor)) (cursor = next, dirty = true)
	}
	area.addEventListener("input", () => {
		const a = points(text), b = points(area.value)
		let p = 0
		while (p < a.length && p < b.length && a[p] === b[p]) p++
		let q = 0
		while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) {
			q++
		}
		text = area.value
		write("value", note, [{
			path: [],
			range: [p, a.length - q],
			value: b.slice(p, b.length - q).join(""),
		}])
		where()
	})
	for (const e of ["keyup", "mouseup", "select", "focus"]) area.addEventListener(e, where)
	area.addEventListener("blur", () => (cursor = undefined, dirty = true))
	area.addEventListener("scroll", () => (mirror.scrollTop = area.scrollTop))
	// the text and the cursors on it, drawn again when either changes
	s.runWithScope(host, () =>
		s.createEffect(() => {
			const v = places.readValue("value", note)
			const marks: Mark[] = []
			for (const r of readPresence(world, ROOM)) {
				const row = r.value as { cursor?: { note: string; from: number; to: number } } & Mark
				if (r.who === me || row?.cursor?.note !== note) continue
				marks.push({ ...row.cursor, colour: row.colour, name: row.name })
			}
			return { next: typeof v === "string" ? v : "", marks }
		}, ({ next, marks }) => {
			if (next !== area.value) {
				const focus = document.activeElement === area
				const [s0, e0] = [area.selectionStart, area.selectionEnd]
				area.value = next
				if (focus) area.setSelectionRange(carry(text, next, s0), carry(text, next, e0))
			}
			text = next
			const chars = points(next)
			let out = "", i = 0
			const lo = (m: Mark) => Math.min(m.from, m.to)
			for (const m of marks.sort((a, b) => lo(a) - lo(b))) {
				const at = lo(m), end = Math.max(m.from, m.to)
				if (at < i || at > chars.length) continue
				out += esc(chars.slice(i, at).join(""))
				if (end > at) {
					out += `<mark style="background:color-mix(in srgb, ${m.colour} 35%, transparent)">${
						esc(chars.slice(at, end).join(""))
					}</mark>`
				}
				out += `<span class="caret" data-name="${esc(m.name)}" style="--c:${m.colour}"></span>`
				i = end
			}
			mirror.innerHTML = out + esc(chars.slice(i).join("")) + "\n"
		}))
	pads.set(note, box)
	return box
}

// ---- what the program is handed ----
const tools = {
	me,
	// a note's pad, kept across reloads: put it in the view as it is
	pad,
	// n letters typed at the end of my note, each its own commit (fragments start about every 256)
	type(n: number, letters = "ermine ") {
		const v = places.readValue("value", mine)
		let at = typeof v === "string" ? points(v).length : 0
		for (let i = 0; i < n; i++) {
			write("value", mine, [{ path: [], range: [at, at], value: letters[i % letters.length] }])
			at++
		}
	},
	// a note's versions made one, keeping the one shown
	settle: (note: string) => s.runWithScope(host, () => sync.settle(note, createChangeHeader(s))),
	// merging by eg-walker, on or off: what each note with several versions shows changes at once
	merge(on: boolean) {
		merging = on
		sync.use(on ? "eg-walker" : undefined)
		changed()
		s.pulse()
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
	.pad { position: relative; }
	.pad textarea, .pad .mirror { font: inherit; line-height: 1.4; padding: 4px; margin: 0;
		border: 1px solid #111; box-sizing: border-box; width: 100%; height: 8em; white-space: pre-wrap;
		overflow-wrap: break-word; overflow: auto; }
	.pad textarea { position: relative; background: transparent; resize: vertical; display: block; }
	.pad .mirror { position: absolute; inset: 0; color: transparent; background: #fff;
		border-color: transparent; pointer-events: none; }
	.pad .caret { position: relative; border-left: 2px solid var(--c); margin-left: -1px; }
	.pad .caret::after { content: attr(data-name); position: absolute; top: -1.2em; left: -2px;
		font-size: 10px; line-height: 1.2; color: #fff; background: var(--c); padding: 0 3px;
		white-space: nowrap; }
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
