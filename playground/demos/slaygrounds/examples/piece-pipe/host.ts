// pipe's host: the world (@ermine/slaygrounds/world) and one process, pipe, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "pipe" }] })

export const reload = world.reload
