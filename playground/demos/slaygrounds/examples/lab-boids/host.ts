// lab-boids' host: the world (@ermine/slaygrounds/world), one process, boids, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "boids" }] })

export const reload = world.reload
