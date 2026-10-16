// sequencer's host: the world and three processes, each at /run/<name> so that /clock, /song and
// /player are saved folders of their own (a running process shadows what is saved at its path):
// the clock (the playhead), the roll (the song and its notes, the editor), the player (reads the
// notes at each step, and plays them). a pattern can be in two places at once: place puts a node
// at a second name, unplace takes it out without taking the node away, move takes a note from one
// step to another
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [
		{ name: "clock", export: "clock", at: ["run", "clock"] },
		{ name: "roll", export: "roll", at: ["run", "roll"] },
		{ name: "player", export: "player", at: ["run", "player"] },
	],
})

export const reload = world.reload
