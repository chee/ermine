// branches' host: the world and one process, branches, running program.ts. the steps are the
// program's own nodes (./steps/<id>): the graph keeps no history to build a tree from
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

const world = createWorld({ render, processes: [{ name: "branches" }] })

export const reload = world.reload
