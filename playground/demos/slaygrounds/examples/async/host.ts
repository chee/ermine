// async's host: the world (@ermine/slaygrounds/world), /query seeded, one process, demo
import { createWorld } from "@ermine/slaygrounds/world"
import { ensureNode } from "@ermine/system"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "demo" }] })
world.seed(() => void ensureNode("/query", 1))

export const reload = world.reload
