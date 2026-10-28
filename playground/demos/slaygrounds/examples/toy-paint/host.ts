// toy-paint's host: the world (@ermine/slaygrounds/world) and one process, paint, running program.ts (a pixel pad).
// a program.ts edit reloads: paint stopped, then started again on the new code
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "paint" }] })

export const reload = world.reload
