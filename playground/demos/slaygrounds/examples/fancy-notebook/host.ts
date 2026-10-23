// fancy-notebook's host: the world (@ermine/slaygrounds/world) and one process, notebook, running
// program.ts. three extras, each for what the notebook needs and the api does not hand it (and
// the world's scoped: a cell's memo in a scope of its own, to go when the cell goes):
import { createWorld, type Tools } from "@ermine/slaygrounds/world"
import { createBuilds } from "@ermine/compilers"
import type { API } from "@ermine/api"
import { render } from "ermine-h"

type Id = string | symbol

// (declared first: the extras use the world made below, once a process starts)
let world: ReturnType<typeof createWorld>

const extra = (api: API) => {
	const { s, table, places } = world.world
	// the id at a path from the root, told to nobody (no read, no spot kept)
	const idAt = (path: readonly string[]): Id | undefined => {
		let id: Id = "root"
		for (const name of path) {
			const kid = (table.get("children", id)?.value as Record<string, unknown> | undefined)
				?.[name]
			if (typeof kid !== "string" && typeof kid !== "symbol") return
			id = kid
		}
		return id
	}
	return {
		// id(path): the id of the node at a path (names from the root), told to nobody
		id: idAt,
		// builds (@ermine/programs/build): steps cached in the folder at path, a node that is there
		// already. made in the scope open and stopped with it; the world's own builds are the
		// programs' and are not handed out. a cell learns its inputs only by reading them, so the
		// notebook's cache is verifying traces
		builds(path: readonly string[]) {
			const cache = idAt(path)
			if (cache === undefined) throw new Error(`no cache folder at ${path.join("/")}`)
			const b = createBuilds({ scheduler: s, table, places, cache: cache as string })
			api.teardown(() => b.stop())
			return b
		},
		// peek(path, part, at): what is at a path now, told to nobody. a run's bookkeeping, written
		// after the run, reads without becoming a reader
		peek(
			path: readonly string[],
			part: "value" | "attributes" = "value",
			at: readonly string[] = [],
		) {
			const id = idAt(path)
			let v: any = id === undefined ? undefined : table.get(part, id)?.value
			for (const step of at) v = v?.[step]
			return v
		},
	}
}

world = createWorld({ render, processes: [{ name: "notebook" }], extend: extra })

export type Extra = Tools & ReturnType<typeof extra>
export const reload = world.reload
