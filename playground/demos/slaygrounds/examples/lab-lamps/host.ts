// lab-lamps' host: the world (@ermine/slaygrounds/world), one process, lamps, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "lamps" }] })

export const reload = world.reload
