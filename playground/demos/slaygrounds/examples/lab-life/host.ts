// lab-life' host: the world (@ermine/slaygrounds/world), one process, life, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "life" }] })

export const reload = world.reload
