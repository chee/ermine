// big-trello's host: the world (@ermine/slaygrounds/world) and one process, trello, running
// program.ts. one extra tool, who: the undo history says who made each step
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "trello" }],
	extend: (_api, ctx) => ({
		// who is calling, from the scope open: the info nests (a scope's pairs, then ["owner", the
		// owner's info]), so the nearest caller and trusted are the call's own. the caller's id is
		// shown as its process's name where it has one
		who() {
			const found: Record<string, unknown> = {}
			for (let info = ctx.scheduler.getInfo(); info;) {
				let next: typeof info | undefined
				for (const [k, v] of info) {
					if (k === "owner") next = v as typeof info
					else if (!(k in found)) found[k] = v
				}
				info = next
			}
			const id = String(found.caller ?? "")
			const named = [...((globalThis as any).ermine?.processes ?? new Map()).entries()]
				.find(([, p]: any) => p.id === id)?.[0]
			return { caller: named ?? id, trusted: found.trusted === true }
		},
	}),
})

export const reload = world.reload
