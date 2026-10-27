// rules' host: the world (@ermine/slaygrounds/world), the notes and the rules seeded, and a
// policy (may) reading the rules node: a read of a note the rules hide is refused. what the policy
// reads is tracked as the asker's reads are, so editing the rules reruns whatever asked
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"
import { get } from "@ermine/core/places/lib"
import { no, type Policy, yes } from "@ermine/core/protect"

let world: ReturnType<typeof createWorld> | undefined
const may: Policy = (ask, read) => {
	if (world === undefined) return yes // while the world is being made
	const id = get(world.world.places, ["rules"])
	const hidden = (id && (read("value", id) as { hidden: string[] } | undefined)?.hidden) || []
	const path = ask.target.path
	const name = path?.[path.length - 1]
	return ask.op === "read" && path?.[0] === "notes" && name && hidden.includes(name)
		? no("hidden by the rules")
		: yes
}

world = createWorld({ render, processes: [{ name: "reader" }], may })
world.seed((host) => {
	host.ensureNode("/notes/a", "buy milk")
	host.ensureNode("/notes/b", "a secret")
	host.ensureNode("/notes/c", "call mum")
	host.ensureNode("/rules", { hidden: ["b"] })
})

export const reload = world.reload
