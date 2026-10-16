// oven's host: the world (@ermine/slaygrounds/world) and one process, bakery, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "bakery" }] })

export const reload = world.reload
