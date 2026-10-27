// layers' host: the world with its overlay on (patch nodes: the draft and the preview are patch
// nodes over the picture), the land service placed at /system/land (a commit sends it the draft),
// and one process, layers, running program.ts
import { land } from "@ermine/patchy/feature"
import { createWorld } from "@ermine/slaygrounds/world"
import { createAction } from "@ermine/system"
import { render } from "ermine-h"

const world = createWorld({ render, overlay: true, processes: [{ name: "layers" }] })
world.seed(() => void createAction("/system/land", land(world.ermine)))

export const reload = world.reload
