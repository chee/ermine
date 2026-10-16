// clock's host: the world (@ermine/slaygrounds/world) and two processes, each running an export of
// program.ts: the clock writes /time, the view reads it
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "clock", export: "clock" }, { name: "view", export: "view" }],
	// kill: a process the world started, stopped by its name. a process holds only those it started
	// itself (api.stop), so the view, which did not start the clock, asks the host
	extend: () => ({
		kill(name: string) {
			const p = world.world.processes.get(name)
			if (p) world.world.apis.stop(p)
		},
	}),
})

export const reload = world.reload
