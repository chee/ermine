// lab-pig's host: the sync world (@ermine/slaygrounds/sync-world), and what is this example's own.
// it knows nothing of what the program shows. read it as a list of what the slaygrounds world and
// the process api (@ermine/api) don't have yet, each wired here by hand and handed to the program
// as a tool (the sync world gives the device, the server, the room, presence, messages, settle and
// teardown):
//   kept nodes by id       node(id): a kept node followed, to bind, wherever it is (placed or not)
//   placing by hand        place(path, id), unplace(path): a node shown at a path under the root,
//                          local folders made on the way; never synced, but in a kept node's
//                          children: a stored commit there
//   a new kept id          make(): a fresh ermine id (sync's mint)
//   a stored write         store(id, value): one commit; set(id, key, value): one key;
//                          clear(id): no value
//   an ephemeral write     wave(id, value): sync's ephemeral option, for that one write; the last
//                          per id sent once a frame
//   presence over the wire pointer(at): my row at the room; /pointers
//   versions               /conflicts: every node given with several versions, their values and
//                          children
//
// what this device has, as nodes (local, never synced):
//   /me         who this device is: {name, colour, server}
//   /pointers   the others' pointers: [{who, name, colour, x, y, ...}]: and whatever else their row
//               says (a terminal's: look, "nethack" or "pixels"; stuck)
//   /conflicts  each node given (node) with several versions: [{id, versions, values, children}],
//               the value and children of each version not shown (undefined where they don't differ)
// and whatever the program places (place), under its own names
import { place, unplace } from "@ermine/places"
import type { Conflict } from "@ermine/together/sync"
import createEntry from "@ermine/core/node/entry"
import { createSyncWorld, put } from "@ermine/slaygrounds/sync-world"
import { render } from "ermine-h"

type At = { x: number; y: number }

// waving: the id whose value is being written ephemerally, for the length of that one write
let waving: string | undefined
const world = await createSyncWorld({
	render,
	room: "ermine:0010bf04115f9b284145026eab6801219d6e",
	ephemeral: (doc, part) => doc === waving && part === "value",
})
const { s, host, table, places, header, me, name, colour, room } = world

world.local("pointers", [])
world.local("conflicts", [])

// ---- placing by hand: a node at a path under the root, its folders local nodes, made as needed ----
const kept = (id: string) => id.startsWith("ermine:")
const kids = (id: string) => table.get("children", id)?.value as Record<string, string> | undefined
function folder(names: string[]): string {
	let id = "root"
	for (let i = 0; i < names.length; i++) {
		let next = kids(id)?.[names[i]]
		if (next === undefined) {
			next = "/" + names.slice(0, i + 1).join("/")
			table.add("value", next, createEntry(undefined, header()))
			table.add("children", next, createEntry({}, header()))
			places.commit(place(table.get("children", id)!, names[i], next, header()))
		} else if (table.get("children", next) === undefined) {
			// a kept node's children are synced: no folder is made in one by hand (the first place
			// in it makes its children, a stored commit)
			if (kept(next)) {
				if (i < names.length - 1) throw new Error(`${names[i]}: a kept node, not a folder`)
			} else table.add("children", next, createEntry({}, header()))
		}
		id = next
	}
	return id
}

// ---- kept nodes the program asked for: followed, and their versions listed ----
const conflicted = new Map<
	string,
	{ id: string; versions: number; values: unknown[]; children: unknown[] }
>()
let shownConflicts = "[]"
function follow(id: string) {
	if (!world.follow(id)) return
	s.runWithScope(host, () =>
		s.createEffect(
			() => places.readValue("conflicts", id) as Conflict[] | undefined,
			(cs) => {
				if (cs?.length) {
					conflicted.set(id, {
						id,
						versions: 1 + cs.length,
						values: cs.map((c) => c.tables.value),
						children: cs.map((c) => c.tables.children),
					})
				} else conflicted.delete(id)
				const all = [...conflicted.values()], q = JSON.stringify(all)
				if (q !== shownConflicts) (shownConflicts = q, world.set("conflicts", all))
			},
		))
	world.soon()
}

// ---- the room, and my row at it: my pointer ----
follow(room)
let pointer: At | undefined
world.join(() => ({ pointer }))
world.onserver(() => world.frame())

// ---- the others' pointers ----
const clamp = (v: unknown) => Math.min(1, Math.max(0, typeof v === "number" && v === v ? v : 0.5))
let shownPointers = ""
s.runWithScope(host, () =>
	s.createEffect(() => {
		const pointers = []
		for (const r of world.rows()) {
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
		if (q !== shownPointers) (shownPointers = q, world.set("pointers", pointers))
	}))

// ---- what the program is handed ----
// ephemeral writes are sent once a frame at most, the last for each id
const waves = new Map<string, unknown>()
let flushing = false
const flush = () => {
	flushing = false
	for (const [id, value] of waves) {
		waving = id
		try {
			world.write("value", id, put(value))
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
	room,
	// a new kept id (its last 16 bytes zero when the server needs it)
	make: () => world.sync.mint(),
	// a kept node by id, to bind (bind(t.node(id), …)): followed, its versions in /conflicts
	node(id: string) {
		follow(id)
		return { id }
	},
	// a node shown at a path under the root ("/pigs/a"): its folders made, what was there replaced.
	// in a kept node ("/room/a"): a stored commit to its children
	place(path: string, id: string) {
		const names = path.split("/").filter(Boolean), name = names.at(-1)!
		const holder = s.runWithScope(host, () => folder(names.slice(0, -1)))
		if (kids(holder)?.[name] === id) return
		if (kept(holder)) return world.write("children", holder, [{ path: [name], value: id }])
		s.runWithScope(host, () => {
			const at = table.get("children", holder)!
			if (kids(holder)?.[name] !== undefined) places.commit(unplace(at, name, header()))
			places.commit(place(at, name, id, header()))
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
		const at = table.get("children", id), name = names.at(-1)!
		if (at === undefined || kids(id)?.[name] === undefined) return
		if (kept(id)) return world.write("children", id, [{ path: [name] }])
		s.runWithScope(host, () => places.commit(unplace(at, name, header())))
		s.pulse()
	},
	// the node's value, a stored commit; an ephemeral one not yet sent for it is dropped
	store(id: string, value: unknown) {
		waves.delete(id)
		follow(id)
		world.write("value", id, put(value))
	},
	// the node's value taken away, a stored commit: it has none
	clear(id: string) {
		waves.delete(id)
		follow(id)
		world.write("value", id, [{ path: [] }])
	},
	// one key of the node's value set, a stored commit: only that key changes (two devices setting
	// different keys don't clobber each other)
	set(id: string, key: string, value: unknown) {
		follow(id)
		world.write("value", id, [{ path: [key], value }])
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
		world.frame()
	},
	// a message, JSON, to whoever listens on the topic (not heard here): ephemeral, stored nowhere
	send: world.send,
	// each message on the topic: fn(the sender's key, its value), outside any run. gives back the stop
	hear: world.hear,
	// the node's versions made one, keeping the one shown
	settle: world.settle,
	// f called when this run of the program goes (a reload)
	teardown: world.teardown,
}
export type Tools = typeof tools

export const reload = (mod: { default: (t: Tools) => unknown }) => world.reload(mod, tools)
