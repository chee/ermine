// big-rewind's host: the world (@ermine/slaygrounds/world) and two processes from program.ts: the
// game (the default export) and the clock that ticks it (the export clock), which keeps its own
// metronome
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "game" }, { name: "clock", export: "clock" }],
})

<<<<<<< Updated upstream
=======
let beat: ReturnType<typeof setInterval> | undefined
world.ermine.createEffect("metronome", () => world.ermine.read("/clock/every"), (ms) => {
	clearInterval(beat)
	beat = typeof ms === "number" && ms > 0
		? setInterval(() => world.ermine.executeAction("/clock/on/beat"), ms)
		: undefined
})

>>>>>>> Stashed changes
export const reload = world.reload
