// layers' host: the world with its overlay on (patch nodes: the draft and the preview are patch
// nodes over the picture), and one process, layers, running program.ts
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, overlay: true, processes: [{ name: "layers" }] })

export const reload = world.reload
