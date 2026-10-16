// toy-stickers's host: the world (@ermine/slaygrounds/world) and one process, stickers, running program.ts (a sticker page).
// a program.ts edit reloads: stickers stopped, then started again on the new code
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "stickers" }] })

export const reload = world.reload
