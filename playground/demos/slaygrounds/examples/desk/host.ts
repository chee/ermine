// desk's host: the world (@ermine/slaygrounds/world), one process, ui, running the program's desk
// export, and what the desk needs that the api does not say (extend, below): a walk up from a
// place, the first way to run a program by name from there, and a node's latest change. a drawing
// process per place a thing sits is started by the desk itself (start); its program is a renderer
// node holding source text, run by the runner seeded here
import { createWorld } from "@ermine/slaygrounds/world"
import type { API, Node } from "@ermine/api"
import { get, lookup } from "@ermine/places/lib"
import { satisfy, type Way } from "@ermine/programs"
import { render } from "ermine-h"

const RENDERER = "party.chee.ermine.renderer"

export type Extra = {
	// the nearest place walking up from `from` (names from the root; none: this process's place),
	// where the address is: its node, tracked as any read in a run. places' lookup, as the shell
	// finds a command
	up: (address: string[], from?: string[]) => Node | undefined
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
	extend: (_api: API, ctx): Extra => ({
		up(address, from) {
			const at = lookup(ctx.places, address, from ?? [...ctx.process.at])
			return at && { path: at, part: "value" }
		},
		way(name, from) {
			for (const w of satisfy(ctx.places, name, from)) return w
		},
		about(x) {
			const id = x.id ?? get(ctx.places, x.path!)
			const change = id === undefined ? undefined : ctx.table.get("value", id)?.change
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

// the runner for a renderer: its code is the node's source text, handed to the program's
// drawing export with the process's api. it takes the renderer type, so a renderer found by name
// is run by it
world.seed((host) => {
	const run = host.open(
		"/draw",
		(text: unknown, api: unknown) =>
			world.world.apis.run(
				(api: any) => (current!.drawing as Function)(api, text),
				api as never,
			),
	)
	host.edit(host.info(run), [{ path: [], value: { "ermine.programs.takes": [RENDERER] } }])
})

export const reload = (mod: Record<string, unknown>) => {
	current = mod
	world.reload(mod)
}
