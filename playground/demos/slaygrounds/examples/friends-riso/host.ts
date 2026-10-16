// friends-riso's host: the world (@ermine/slaygrounds/world), one process, riso, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "riso" }] })

export const reload = world.reload
