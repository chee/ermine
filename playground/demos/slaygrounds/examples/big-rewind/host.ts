// big-rewind's host: the world (@ermine/slaygrounds/world) and two processes from program.ts: the
// game (the default export) and the clock that ticks it (the export clock)
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "game" }, { name: "clock", export: "clock" }],
})

export const reload = world.reload
