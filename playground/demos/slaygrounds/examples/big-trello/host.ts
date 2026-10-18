// big-trello's host: the world (@ermine/slaygrounds/world) and one process, trello, running
// program.ts. the undo history says who made each step: the world's who
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "trello" }] })

export const reload = world.reload
