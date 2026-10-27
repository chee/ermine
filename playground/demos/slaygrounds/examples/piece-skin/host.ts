// skin's host: the world (@ermine/slaygrounds/world) with patch nodes (overlay: true: the places
// read through them), a shared card seeded, the land and unload services placed at /system, one process,
// skin. the program uses the world's change (the card's time is what a patch node is made against;
// its actor, who edited last)
import { land } from "@ermine/patchy/feature"
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "skin" }], overlay: true })
world.seed((host) => {
	// a card everyone shares, at /shared/card
	host.ensureNode("/shared/card", {
		title: "our note",
		body: "lunch at one? 🥪",
		x: 36,
		y: 30,
		accent: "#40dcba",
		sticker: "🌱",
	})
	// the service that lands a patch node on what it is over: a program sends it the node
	host.createAction("/system/land", land(host))
	// and the one that takes a patch node out, its patch entry with it (remove: a program's unplace
	// takes the name, and the patch entry is still read through)
	host.createAction("/system/unload", (node: string) => host.remove(node))
})

export const reload = world.reload
