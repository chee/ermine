// async's host: the world (@ermine/slaygrounds/world), /query seeded, one process, demo
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const world = createWorld({ render, processes: [{ name: "demo" }] })
world.seed((host) => void host.open("/query", 1))

export const reload = world.reload
