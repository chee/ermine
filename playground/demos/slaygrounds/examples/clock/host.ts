// clock's host: the world (@ermine/slaygrounds/world) and two processes, each running an export of
// program.ts: the clock counts /time, the view reads it
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "clock", export: "clock" }, { name: "view", export: "view" }],
	// kill: a process the world started, stopped by its name. a process stops none (it holds none:
	// only the host started them), so the view, which did not start the clock, asks the host
	extend: () => ({ kill: (name: string) => world.world.stop(name) }),
})

<<<<<<< Updated upstream
=======
world.seed((host) => void host.ensureNode("/beat", 0))
let beats = 0
setInterval(() => {
	world.ermine.patch("/beat", [{ path: [], value: ++beats }])
}, 1000)

>>>>>>> Stashed changes
export const reload = world.reload
