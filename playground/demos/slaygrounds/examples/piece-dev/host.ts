// dev's host: the world (@ermine/slaygrounds/world), saved names seeded, and what the world does
// not give a program: the path cache (a cache per path in front of the places) and a sync landing,
// handed over by extend. a process running at a path answers there before what is saved: the
// world's places already ask the process trie first
import createEntry from "@ermine/core/node/entry"
import { createPathCache } from "@ermine/core/places/cache"
import { createChangeHeader } from "@ermine/core/places/header"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "desk" }],
	extend: () => ({
		// the id at a path: the cache's one key for the path
		cached: (path: string[]) => cache.get(path),
		kept: () => cache.kept(),
		sync,
	}),
})
// saved names: /dev/clock, a stopped clock face; /dev/lamp; /work/notes
world.seed((host) => {
	host.ensureNode("/dev/clock", "12:00, stopped")
	host.ensureNode("/dev/lamp", "off")
	host.ensureNode("/work/notes", "buy cherries")
})
const { s, table, places, host } = world.world
const cache = createPathCache({ places, scheduler: s })

// a sync lands the root's children as they already are: a new entry, the same names
function sync() {
	const v = table.get("children", "root")!.value as Record<string, unknown>
	s.runWithScope(
		host,
		() =>
			table.sub(
				"children",
				"root",
				createEntry({ ...v }, createChangeHeader(s, [["via", "sync"]])),
			),
	)
	s.pulse()
}

export const reload = world.reload
