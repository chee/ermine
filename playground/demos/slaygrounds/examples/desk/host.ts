// desk's host: the world (@ermine/slaygrounds/world) and one process, ui, running the program's desk
// export. what the desk needs that the system functions do not say (extend, below): the id of the
// node at a path (a program names a node by its path and nothing else, and the desk tells a thing
// that sits in two folders by its id). the drawing for each place a thing sits is the desk's own,
// a memo each: a program starts no process, and a renderer is a node holding source text the
// memo compiles
import { createWorld } from "@ermine/slaygrounds/world"
import { get } from "@ermine/core/places/lib"
import { render } from "@ermine/render/dom"

const world = createWorld({
	render,
	processes: [{ name: "ui", export: "desk" }],
	actor: "desk@browser",
	extend: () => ({
		// the id of the node at an absolute path, or none
		idOf: (path: string) => get(world.ermine.places, path.split("/").filter(Boolean)),
	}),
})

export const reload = world.reload
