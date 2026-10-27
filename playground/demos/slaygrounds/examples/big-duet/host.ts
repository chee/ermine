// big-duet's host: the world and four processes from one module: duet owns the text, cherry and mint
// are one export (person) placed twice, each told its name by args, and the poet. who changed the
// text, and how: the world's change and who. the host is the timer (a program has none that can
// call in): /beat is written every 120ms, and the poet types a letter at each
import { createWorld } from "@ermine/slaygrounds/world"
import { ensureNode, patch } from "@ermine/system"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [
		{ name: "duet" },
		{ name: "cherry", export: "person", args: ["cherry"] },
		{ name: "mint", export: "person", args: ["mint"] },
		{ name: "poet", export: "poet" },
	],
})
world.seed(() => void ensureNode("/beat", 0))
let beats = 0
setInterval(() => {
	world.ermine.within(() => patch("/beat", [{ path: [], value: ++beats }]))
}, 120)

export const reload = world.reload
