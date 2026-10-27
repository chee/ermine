// counter's host: the world (@ermine/slaygrounds/world), /data/n seeded, one process, demo,
// running program.ts. a program.ts edit reloads: demo stopped, then started again on the new code
import { createWorld } from "@ermine/slaygrounds/world"
import { ensureNode } from "@ermine/system"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "demo" }] })
world.seed(() => void ensureNode("/data/n", 21))

export const reload = world.reload
