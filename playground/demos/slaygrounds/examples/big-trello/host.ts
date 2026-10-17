// big-trello's host: the world (@ermine/slaygrounds/world) and one process, trello, running
// program.ts. one extra tool, who: the undo history says who made each step
import { getWho } from "@ermine/places/header"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "trello" }],
	extend: (_api, ctx) => ({
		// who is calling, from the scope open and those above it (a call's caller and trusted). the
		// caller's id is shown as its process's name where it has one
		who() {
			const found: Record<string, unknown> = {}
			for (const [k, v] of getWho(ctx.scheduler)?.metadata ?? []) if (!(k in found)) found[k] = v
			const id = String(found.caller ?? "")
			const named = [...((globalThis as any).ermine?.processes ?? new Map()).entries()]
				.find(([, p]: any) => p.id === id)?.[0]
			return { caller: named ?? id, trusted: found.trusted === true }
		},
	}),
})

export const reload = world.reload
