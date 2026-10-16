// toy-drums's host: the world (@ermine/slaygrounds/world) and one process, drums, running program.ts (a drum machine).
// a program.ts edit reloads: drums stopped, then started again on the new code
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "drums" }] })

export const reload = world.reload
