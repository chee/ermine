// hedgehog-notebook's host: the world (@ermine/slaygrounds/world) and one process, demo, running
// program.ts. nothing seeded here: the program seeds its own notebook, once
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "demo" }] })

export const reload = world.reload
