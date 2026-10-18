// friends-dinner's host: the world (@ermine/slaygrounds/world), two processes from one module (the
// dinner: default; the post: its export, with a folder of its own for what it saves). who is
// calling: the world's who
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

export type { Tools, Who } from "@ermine/slaygrounds/world"

const world = createWorld({
	render,
	processes: [{ name: "dinner" }, { name: "post", export: "post", cwd: ["mail"] }],
})

export const reload = world.reload
