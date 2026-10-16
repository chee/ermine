// nn's host: the world (@ermine/slaygrounds/world), one process, nn, running program.ts. a
// program.ts edit reloads: nn stopped ("replaced"), then started again on the new code. the host
// adds what the demo measures and the api does not give (extend, below)
import { createWorld } from "@ermine/slaygrounds/world"
import type { API, Node } from "@ermine/api"
import update from "@ermine/node/update"
import { get } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { trace } from "@ermine/scheduler/trace"
import { render } from "ermine-h"

// what the page measures: the writes made, the headers they cost, the runs and acts of the
// scheduler, and (timing on) the ms of each run, the program's own memos and effects apart from
// everyone else's (h's bindings, the inspector's)
export type Stats = {
	writes: number
	headers: number
	acts: number
	starts: number
	calls: number
	bodyMs: number
	pulseMs: number
	timing: boolean
	oursMs: number
	othersMs: number
	othersRuns: number
}
export type Extra = {
	stats: Stats
	// the values put on these nodes with one header and one commit: what the api cannot say (each
	// edit is its own header). for the "one header" row of the measure
	bulk: (puts: [Node, unknown][]) => void
}

const stats: Stats = {
	writes: 0,
	headers: 0,
	acts: 0,
	starts: 0,
	calls: 0,
	bodyMs: 0,
	pulseMs: 0,
	timing: false,
	oursMs: 0,
	othersMs: 0,
	othersRuns: 0,
}

const world = createWorld({
	render,
	processes: [{ name: "nn" }],
	actor: "me@laptop",
	extend: (_api: API, ctx): Extra => ({
		stats,
		bulk(puts) {
			const header = createChangeHeader(ctx.scheduler)
			const changed = []
			for (const [n, value] of puts) {
				const id = n.id ?? get(ctx.places, n.path!)!
				const entry = ctx.table.get("value", id)!
				update(entry, [{ path: [], value }], header)
				changed.push(entry)
			}
			ctx.places.commit(changed)
		},
	}),
})

// every write the api makes is one commit of one entry and its own header; counted where it lands
const { places, s, parts } = world.world
const commit = places.commit
places.commit = (changed) => {
	stats.writes += changed.length
	stats.headers++
	return commit(changed)
}
const began = new Map<unknown, number>()
trace(s, (m) => {
	if ("acts" in m) stats.acts++
	if ("starts" in m) {
		stats.starts++
		if (stats.timing) began.set(m.starts, performance.now())
	} else if ("ends" in m && stats.timing && began.has(m.ends)) {
		const ms = performance.now() - began.get(m.ends)!
		began.delete(m.ends)
		if (parts.has(m.ends)) stats.oursMs += ms
		else (stats.othersMs += ms, stats.othersRuns++)
	}
})

export const reload = world.reload
