// pipe's host: the world (@ermine/slaygrounds/world) and one process, pipe, running program.ts. the
// lens is its own actor: the world's as runs f under a scope of its own pairs (an actor, a side), so
// the writes in it say who made them
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "pipe" }] })

export const reload = world.reload
