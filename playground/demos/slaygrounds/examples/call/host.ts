// call's host: the world (@ermine/slaygrounds/world), and two processes, each running an export of
// program.ts: greeter defines a method, asker sends to it
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({
	render,
	processes: [{ name: "greeter", export: "greeter" }, { name: "asker", export: "asker" }],
})

export const reload = world.reload
