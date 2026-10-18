// lab-load's host: the world (@ermine/slaygrounds/world), one process, loader, and the host's own
// method /host/on/load. a file the 💾 save graph button made (everything a root reaches, packed,
// live values as stand-ins) has its nodes put in the table, and its root placed under /loaded
import { unpack } from "@ermine/encoding/pack"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "loader" }] })

world.seed((host) => {
	const said = host.open("/host/said", "nothing loaded yet")
	host.open("/loaded", null)
	const say = (text: string) => host.edit(said, () => text)
	const { table, s } = world.world

	// a free name under /loaded: the file's name without .ermine, then "name 2", "name 3"…
	function free(file: string) {
		const base = file.replace(/\.ermine$/, "").replace(/^\.*$/, "") || "graph"
		const taken = host.list("/loaded")
		let name = base
		for (let n = 2; taken.includes(name); n++) name = `${base} ${n}`
		return name
	}

	// the method a program sends to, with the file dropped. async: what lands after the await is
	// written as the host, the pulse is its own.
	// the saved root is keyed "root", as this world's own is: it is given a fresh id, and a children
	// entry naming it names that. every other id is kept: one already in this table is the same
	// node, and what is here stays (a file dropped twice: a second root, over the same nodes)
	host.method("/host/on/load", async (file: File) => {
		let entries: ReturnType<typeof unpack>
		try {
			entries = unpack(new Uint8Array(await file.arrayBuffer()))
		} catch (e) {
			return say(`${file.name}: not a saved graph (${(e as Error).message})`)
		}
		if (!entries.some(([, id]) => id === "root")) {
			return say(`${file.name}: no root in it, nothing placed`)
		}
		const fresh = crypto.randomUUID()
		const ids = new Set<string>(), nodes = new Set<unknown>()
		let here = 0
		for (const [part, id, n] of entries) {
			const value = n.value as Record<string, unknown> | undefined
			if (part === "children" && value && typeof value === "object") {
				for (const [name, v] of Object.entries(value)) if (v === "root") value[name] = fresh
			}
			const at = id === "root" ? fresh : id
			ids.add(at)
			nodes.add(n)
			if (table.get(part as "value", at)) here++
			else table.add(part as "value", at, n as never)
		}
		const name = free(file.name)
		host.place(`/loaded/${name}`, { id: fresh, part: "value" })
		s.pulse()
		say(
			`${file.name} → /loaded/${name}: ${file.size} bytes, ${ids.size} ids, ${nodes.size} nodes` +
				(here ? `, ${here} already here (kept as they were)` : ""),
		)
		host.inspect(["loaded", name]) // the graph tab, at what was placed
	})
})

export const reload = world.reload
