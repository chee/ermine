// big-rewind's host: the world (@ermine/slaygrounds/world) and two processes from program.ts: the
// game (the default export) and the clock that ticks it (the export clock), which keeps its own
// metronome
import { createWorld } from "@ermine/slaygrounds/world"
import pipes from "@ermine/pipe"
import { render } from "@ermine/render/dom"

const world = createWorld({
	render,
	processes: [{ name: "game" }, { name: "clock", export: "clock" }],
	features: [pipes],
})

export const reload = world.reload
