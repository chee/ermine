// toy-tarot's host: the world (@ermine/slaygrounds/world) and one process, tarot, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "tarot" }] })

export const reload = world.reload
