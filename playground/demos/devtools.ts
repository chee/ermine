// a demo's graph shown to the ermine devtools extension (playground/devtools), read and written
// through a process api at its root (@ermine/api), as a program's would be: its reads, its edits,
// its sends, and protect when may is given. the api is made the first time devtools asks, so a page
// nobody inspects runs as it did. gives back answer.ts' stop
//
//   import { answer } from "../devtools.ts"
//   answer({ scheduler: s, table, places, scope: host }, { name: "ada's den" })
//
// processes: the ones the demo runs, so devtools marks them and can stop them (with stop)
import { createProcessAPIs, type ProcessAPIs } from "@ermine/api"
import type { Entry } from "@ermine/core/node/entry"
import type { Places } from "@ermine/places"
import type { Policy } from "@ermine/protect"
import type { Process } from "@ermine/processes/start"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Table } from "@ermine/core/table"
import { devtools, type Travel } from "../devtools/answer.ts"

export type Graph = {
	scheduler: Scheduler
	table: Table
	places: Places
	// the host's scope: the api's writes are made under it (devtools' in a scope of its own under it)
	scope: Scope
	// where a write is said written; none: places.commit
	commit?: (changed: readonly Entry<unknown>[]) => void
	may?: Policy
}

export function answer(
	g: Graph,
	o: {
		name: string
		processes?: () => Iterable<Process>
		stop?: (p: Process) => void
		travel?: Travel
	},
): () => void {
	const { scheduler: s, table, places, scope } = g
	const commit = g.commit ?? ((changed) => places.commit(changed))
	let made: { apis: ProcessAPIs; api: ReturnType<ProcessAPIs["createProcessAPI"]> } | undefined
	const make = () => {
		if (made) return made
		const apis = createProcessAPIs({
			scheduler: s,
			table,
			commit,
			host: { places, table, scheduler: s, commit },
			stop: (p) => o.stop?.(p),
			may: g.may,
		})
		const api = apis.createProcessAPI({
			box: { root: places.root, places },
			places,
			process: { id: "host", at: [], args: [], cwd: [] },
			scheduler: s,
			table,
			scope,
		})
		return (made = { apis, api })
	}
	// the layer, as devtools reads a world holding a process api (.api)
	const world = {
		s,
		host: scope,
		places,
		get api() {
			return make().api
		},
		get apis() {
			const { apis } = make()
			return { runs: apis.runs, ...(o.stop ? { stop: (p: Process) => apis.stop(p) } : {}) }
		},
		get processes() {
			return new Map([...o.processes?.() ?? []].map((p) => [p.id, p]))
		},
	}
	return devtools(world, { name: o.name, travel: o.travel })
}
