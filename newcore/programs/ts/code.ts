// code: a process's code when its program is a path. each run, the host's finder is called as the
// process, read only and tracked, so a change to what it read runs the process again. what it finds
// becomes the process's code when the process has none yet or is replaced; otherwise a different
// program, an error or nothing found shows in its status as new.
import type { Api } from "../../graph/ts/graph.ts"
import { errorOf } from "./records.ts"
import {
	type Ctx,
	type Finder,
	type Found,
	PENDING,
	type Proc,
	type Process,
} from "../../scheduler/ts/types.ts"

export function createCode(o: {
	finder?: Finder
	// what the finder reads through (process-api.ts)
	view(ctx: Ctx, alive: () => boolean): Api
	// a part run as the process (processes.ts)
	part(p: Proc, fn: () => unknown): { value: unknown } | { error: unknown }
}) {
	const processOf = (p: Proc): Process => ({
		id: p.id,
		name: p.name,
		place: p.place,
		program: p.path ?? [],
	})

	// the code for ctx's run, when its program is a path. answers how the run ends, or nothing:
	// it goes on with the process's code
	function find(
		ctx: Ctx,
	): "stopped" | "pending" | { failed: unknown } | undefined {
		const p = ctx.p
		const run = ctx.run!
		if (!p.path) return
		let alive = true
		const view = o.view(ctx, () => alive)
		const found = o.part(p, () => o.finder!(processOf(p), view))
		alive = false
		if (run.stopped) return "stopped"
		const takes = p.code === undefined || p.replaced
		if ("error" in found) {
			if (takes) return { failed: found.error }
			run.shown = { value: errorOf(found.error) }
		} else if (found.value === PENDING) {
			if (takes) return "pending"
			run.shown = { value: null }
		} else {
			const f = found.value as Found
			if (takes) {
				p.code = f.code
				p.program = f.program
			} else if (
				!p.program ||
				f.program.node !== p.program.node ||
				f.program.time !== p.program.time
			) {
				run.shown = { value: f.program }
			}
		}
	}

	return { find }
}
