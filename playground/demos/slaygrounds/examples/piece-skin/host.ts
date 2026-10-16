// skin's host: the world (@ermine/slaygrounds/world) with patch nodes (overlay: true: the places
// read through them), a shared card and my tweak seeded, one process, skin. extend adds two tools
// the api has no word for: the latest change of a node (its time is what a patch node is made
// against; its actor, who edited last), and as, f run as another actor (a friend's edit)
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "skin" }],
	overlay: true,
	extend: (api, { places, scheduler: s, scope }) => ({
		change(x: string) {
			const id = api.entries(x)[0]?.id
			return id === undefined ? undefined : places.readChange("value", id)
		},
		as<T>(actor: string, f: () => T): T {
			const own = s.createScope([["actor", actor]], s.getCurrentScope() ?? scope)
			try {
				return s.runWithScope(own, f)
			} finally {
				s.teardown(own)
			}
		},
	}),
})
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
