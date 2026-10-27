// fancy-lisp's host: the world (@ermine/slaygrounds/world), one process, lisp, running program.ts.
// a frame is found walking up the way it was reached: the world's up, with a ceiling (stop) and the
// frames visited told (walk)
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "lisp" }], actor: "you@laptop" })

export const reload = world.reload
