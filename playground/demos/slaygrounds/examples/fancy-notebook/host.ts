// fancy-notebook's host: the world (@ermine/slaygrounds/world) and one process, notebook, running
// program.ts. one extra, for what the notebook needs and no function hands it: builds
// (@ermine/compilers), steps cached in a folder of the graph, made from the world's scheduler,
// table and places. the program reads it by host(), and stops what it makes at its teardown
import { createWorld } from "@ermine/slaygrounds/world"
import { createBuilds } from "@ermine/compilers"
import { render } from "@ermine/render/dom"

type Id = string | symbol

// (declared first: the extras use the world made below, once a process starts)
let world: ReturnType<typeof createWorld>

const extra = () => {
	const { s, table, places } = world.world
	// the id at a path from the root, told to nobody (no read, no spot kept)
	const idAt = (path: readonly string[]): Id | undefined => {
		let id: Id = places.root
		for (const name of path) {
			const kid = (table.get("children", id)?.value as Record<string, unknown> | undefined)
				?.[name]
			if (typeof kid !== "string" && typeof kid !== "symbol") return
			id = kid
		}
		return id
	}
	return {
		// builds (@ermine/compilers): steps cached in the folder at path, a node that is there
		// already. made in the scope open (the process's, as it sets up); the caller stops it
		builds(path: readonly string[]) {
			const cache = idAt(path)
			if (cache === undefined) throw new Error(`no cache folder at ${path.join("/")}`)
			return createBuilds({ scheduler: s, table, places, cache: cache as string })
		},
	}
}

world = createWorld({ render, processes: [{ name: "notebook" }], extend: extra })

export type Extra = ReturnType<typeof extra>
export const reload = world.reload
