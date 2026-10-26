// friends-card's host: the world (@ermine/slaygrounds/world), four processes from one module (the
// card: default; the frog, the hedgehog and the snail: friend, each in a folder of its own). who
// wrote a thing: the world's who and change
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

export type { Tools, Who } from "@ermine/slaygrounds/world"

const world = createWorld({
	render,
	processes: [
		{ name: "card" },
		{ name: "frog", export: "friend", folder: ["friends", "frog"], args: ["frog"] },
		{ name: "hedgehog", export: "friend", folder: ["friends", "hedgehog"], args: ["hedgehog"] },
		{ name: "snail", export: "friend", folder: ["friends", "snail"], args: ["snail"] },
	],
})

export const reload = world.reload
