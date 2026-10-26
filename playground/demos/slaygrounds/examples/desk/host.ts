// desk's host: the world (@ermine/slaygrounds/world), one process, ui, running the program's desk
// export, and what the desk needs that the api does not say (extend, below): the first way to run
// a program by name from a place, and a node's latest change with the run behind it (a walk up from
// a place is the world's up). a drawing
// process per place a thing sits is started by the desk itself (start); its program is a renderer
// node holding source text, run by the runner seeded here
import { createWorld, type Tools } from "@ermine/slaygrounds/world"
import type { Node } from "@ermine/api"
import { get } from "@ermine/core/places/lib"
import { satisfy, type Way } from "@ermine/programs"
import type { Start } from "@ermine/programs/start"
import { render } from "ermine-h"

const RENDERER = "party.chee.ermine.renderer"

export type Extra = Tools & {
	// the first way to run the program named, found from `from` (names from the root), tracked:
	// start takes it. start's own name is found from the starter's working folder, so a program that
	// is found from somewhere else (a thing's place) is found here first
	way: (name: string, from: string[]) => Way | undefined
	// a node's latest change, and the computation behind it with how its last run ended: the change
	// header and a computation's last run are not in the api (the host's table and moments are)
	about: (x: Node) => {
		change: any
		part?: { kind: string; runs: number }
		last?: { run: number; ended: unknown; equal?: boolean; error?: unknown }
	}
}

let current: Record<string, unknown> | undefined
const world = createWorld({
	render,
	processes: [{ name: "ui", export: "desk" }],
	actor: "desk@browser",
	extend: (_api, ctx): Omit<Extra, keyof Tools> => ({
		way(name, from) {
			for (const w of satisfy(ctx.box.places, name, from)) return w
		},
		about(x) {
			const id = x.id ?? get(ctx.box.places, x.path!)
			const change = id === undefined ? undefined : world.world.table.get("value", id)?.change
			let rec
			for (const r of world.world.parts.values()) if (r.entry.id === id) rec = r
			const computer = [...world.world.parts].find(([, r]) => r === rec)?.[0] as any
			const last = computer &&
				[...world.world.moments].reverse().find((m: any) => m.ends === computer) as any
			return {
				change,
				part: computer && { kind: computer.kind, runs: computer.runs },
				last: last &&
					{ run: last.run, ended: last.ended, equal: last.equal, error: last.error },
			}
		},
	}),
})

// the runner for a renderer (@ermine/software's shape): its code is the node's source text, handed
// to the program's drawing export with the process's api, the world's. it takes the renderer type,
// so a renderer found by name is run by it
world.seed((host) => {
	const draw = world.world.apis.runner({ api: world.world.createProcessAPI })
	const run = host.open("/draw", {
		start: (text: unknown, start: Start) =>
			draw.start((api: any) => (current!.drawing as Function)(api, text), start),
		api: draw.api,
	})
	host.edit(host.info(run), [{ path: [], value: { "ermine.programs.takes": [RENDERER] } }])
})

export const reload = (mod: Record<string, unknown>) => {
	current = mod
	world.reload(mod)
}
