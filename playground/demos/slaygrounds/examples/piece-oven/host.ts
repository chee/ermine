// oven's host: the world (@ermine/slaygrounds/world) and one process, bakery, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import pipes from "@ermine/pipe"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "bakery" }], features: [pipes] })

export const reload = world.reload
