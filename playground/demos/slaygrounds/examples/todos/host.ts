// todos' host: the world (@ermine/slaygrounds/world) and one process, demo, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "demo" }] })

export const reload = world.reload
