// toy-fortune's host: the world (@ermine/slaygrounds/world) and one process, fortune, running program.ts (a magic ball and a diary).
// a program.ts edit reloads: fortune stopped, then started again on the new code
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "fortune" }] })

export const reload = world.reload
