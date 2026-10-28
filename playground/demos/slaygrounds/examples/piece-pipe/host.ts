// pipe's host: the world (@ermine/slaygrounds/world) and one process, pipe, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import pipes from "@ermine/pipe"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "pipe" }], features: [pipes] })

export const reload = world.reload
