// pipe's host: the world (@ermine/slaygrounds/world) and one process, pipe, running program.ts. one
// extra, handed over by extend: as, f run under a scope of its own pairs (an actor, a side), so the
// writes in it say who made them: the lens is its own actor
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "pipe" }],
	extend: (_api, { scheduler: s, scope }) => ({
		as<T>(pairs: [string, unknown][], f: () => T): T {
			const own = s.createScope(pairs, s.getCurrentScope() ?? scope)
			try {
				return s.runWithScope(own, f)
			} finally {
				s.teardown(own)
			}
		},
	}),
})

export const reload = world.reload
