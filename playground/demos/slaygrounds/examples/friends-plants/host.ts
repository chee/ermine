// friends-plants's host: the world (@ermine/slaygrounds/world), four processes from one module (the
// windowsill: default; the clock, the fox and the frog: one export each). who wrote a thing: the
// world's who and change
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [
		{ name: "sill" },
		{ name: "clock", export: "clock" },
		{ name: "fox", export: "fox" },
		{ name: "frog", export: "frog" },
	],
})

export const reload = world.reload
