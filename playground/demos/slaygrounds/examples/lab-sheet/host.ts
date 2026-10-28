// lab-sheet' host: the world (@ermine/slaygrounds/world), one process, sheet, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "sheet" }] })

export const reload = world.reload
