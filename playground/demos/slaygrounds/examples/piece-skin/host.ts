// skin's host: the world (@ermine/slaygrounds/world) with patch nodes (overlay: true: the places
// read through them), a shared card and my tweak seeded, one process, skin. the program uses the
// world's change (the card's time is what a patch node is made against; its actor, who edited
// last) and as (a friend's edit)
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "skin" }], overlay: true })
world.seed((host) => {
	// a card everyone shares, at /shared/card
	const card = host.open("/shared/card", {
		title: "our note",
		body: "lunch at one? 🥪",
		x: 36,
		y: 30,
		accent: "#40dcba",
		sticker: "🌱",
	})
	// my tweak, in my own tree at /me/tweaks/cherry: a patch node over the card's value, made
	// against the card's change now
	host.patch("/me/tweaks/cherry", card, [
		{ path: ["accent"], value: "#ff2284" },
		{ path: ["sticker"], value: "🍒" },
	])
})

export const reload = world.reload
