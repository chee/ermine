// big-rewind's host: the world (@ermine/slaygrounds/world) and two processes from program.ts: the
// game (the default export) and the clock that ticks it (the export clock). the host is the
// metronome (a program cannot call into the graph from a timer): its effect reads how often the
// clock wants a beat (/clock/every, 0: none) and runs the clock's /clock/on/beat at that interval
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "game" }, { name: "clock", export: "clock" }],
})

let beat: ReturnType<typeof setInterval> | undefined
world.ermine.createEffect("metronome", () => world.ermine.read("/clock/every"), (ms) => {
	clearInterval(beat)
	beat = typeof ms === "number" && ms > 0
		? setInterval(() => world.ermine.executeAction("/clock/on/beat"), ms)
		: undefined
})

export const reload = world.reload
