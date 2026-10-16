// toy-pet's host: the world (@ermine/slaygrounds/world) and one process, pet, running program.ts (a pet that gets hungry).
// a program.ts edit reloads: pet stopped, then started again on the new code
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "pet" }] })

export const reload = world.reload
