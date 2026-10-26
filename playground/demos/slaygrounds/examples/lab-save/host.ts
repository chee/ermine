// lab-save's host: the world (@ermine/slaygrounds/world), one process, notebook, and the host's own
// methods /host/on/save, load, forget. /data is packed (ermine/encoding's pack) and kept in
// IndexedDB (playground/pack-indexeddb, experimental). a restart starts from what was saved
import type { Entry } from "@ermine/formats/pack"
import createEntry from "@ermine/core/node/entry"
import { createStore as createPacks } from "@ermine/pack-indexeddb"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const packs = createPacks("ermine-slaygrounds")
const NAME = "lab-save"
const DATA = "data"

// a save from before a name held one id kept a list of [source, id] under each name: the id in
// the list is the one the name holds now
function modern(entries: Entry[]) {
	for (const [part, , n] of entries) {
		const v = n.value as Record<string, unknown> | undefined
		if (part !== "children" || !v || typeof v !== "object") continue
		for (const [k, x] of Object.entries(v)) if (Array.isArray(x)) v[k] = x[0]?.[1]
	}
	return entries
}

// what was saved, in words: when, how big, how many nodes
function words(
	kept: { time: number; bytes: Uint8Array } | undefined,
	entries: Entry[],
	how: string,
) {
	if (!kept) return "nothing saved yet"
	const nodes = new Set(entries.map((e) => e[2])).size
	return `${how} ${
		new Date(kept.time).toLocaleTimeString()
	}: ${kept.bytes.length} bytes, ${nodes} nodes`
}

// what was saved, or nothing: a page with no IndexedDB (or a pack it cannot read) starts fresh
const saved = await packs.load(NAME).catch(() => undefined)
const kept = saved && (await packs.saved(NAME))

const world = createWorld({ render, processes: [{ name: "notebook" }] })

world.seed((host) => {
	const { table, s } = world.world
	const said = host.open("/host/saved", words(kept, saved ?? [], "loaded, saved"))
	const say = (text: string) => host.edit(said, () => text)

	// /data has a known id, so a save and a load find it: what was saved is put back whole, else a
	// folder of that id is made, with three notes
	if (saved) {
		for (const [part, id, n] of modern(saved)) table.add(part as "value", id, n as never)
	} else {
		s.runWithScope(world.world.host, () => {
			table.add("value", DATA, createEntry<unknown>(null, world.world.header()))
			table.add("children", DATA, createEntry<Record<string, unknown>>({}, world.world.header()))
		})
	}
	host.place("/data", { id: DATA, part: "value" })
	if (!saved) {
		host.open("/data/order", ["a", "b", "c"])
		host.open("/data/notes/a", "pack the table")
		host.open("/data/notes/b", "keep it in IndexedDB")
		host.open("/data/notes/c", "restart, and it is still here")
	}

	// every stored node /data reaches, each part there: pack's entries
	function reached(id: string): Entry[] {
		const out: Entry[] = [], ids = [id], seen = new Set(ids)
		for (let i = 0; i < ids.length; i++) {
			for (const part of ["value", "attributes", "children"] as const) {
				const n = table.get(part, ids[i])
				if (n) out.push([part, ids[i], n as never])
			}
			const kids = table.get("children", ids[i])?.value as Record<string, unknown> | undefined
			for (const child of Object.values(kids ?? {})) {
				if (typeof child === "string" && !seen.has(child)) seen.add(child), ids.push(child)
			}
		}
		return out
	}

	// the methods a program sends to. each is async: what lands after an await is written as the
	// host, and pulsed
	host.method("/host/on/save", async (options: { op?: boolean } = {}) => {
		const entries = reached(DATA)
		try {
			await packs.save(NAME, entries as never, options)
			say(words(await packs.saved(NAME), entries, "saved"))
		} catch (e) {
			say("not saved: " + (e as Error).message)
		}
	})
	host.method("/host/on/load", async () => {
		const entries = await packs.load(NAME).then((e) => e && modern(e))
		if (!entries) return say("nothing saved yet")
		// each node put back in place of what is there: its readers run again
		s.runWithScope(world.world.host, () => {
			for (const [part, id, n] of entries) table.sub(part as "value", id, n as never)
		})
		s.pulse()
		say(words(await packs.saved(NAME), entries, "loaded, saved"))
	})
	host.method("/host/on/forget", async () => {
		await packs.remove(NAME)
		say("forgotten: a restart starts fresh")
	})
})

export const reload = world.reload
