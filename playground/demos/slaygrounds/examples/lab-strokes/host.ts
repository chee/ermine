// lab-strokes' host: the world (@ermine/slaygrounds/world), one process, drawing, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "drawing" }] })

export const reload = world.reload
