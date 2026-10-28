// trust's host: the world (@ermine/slaygrounds/world) and one process, vault, running program.ts.
// whether a person did something is never handed in: the world reads the window's own event, through
// the native getter it kept before any program ran, and a send carries it as "trusted-event". the
// program reads it with the world's who and change
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "vault" }] })

export const reload = world.reload
