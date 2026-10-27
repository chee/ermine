// a demo's graph shown to the ermine devtools extension (playground/devtools), read and written
// through a face over its places, as the extension reads a process api: entries, list, peep, reads,
// change, edit, send. the extension reads ids (a node's items, the one a path reaches) where a
// process holds none, so the face is the host's: made from the graph's places and table, not a
// process's functions. protect is asked when may is given. the face is made the first time devtools
// asks, so a page nobody inspects runs as it did. gives back answer.ts' stop
//
//   import { answer } from "../devtools.ts"
//   answer({ scheduler: s, table, places, scope: host }, { name: "ada's den" })
//   answerWorld(world, { name: "slaygrounds" })     // a slaygrounds world (demo-world/world.ts)
//
// processes: the ones the demo runs, so devtools marks them and can stop them (with stop)
import createEntry, { type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import type { Patch } from "@ermine/core/changeable/apply"
import type { Id, Path, Places } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createGuard, REFUSED, target, type Thing } from "@ermine/core/places/guard"
import { gets, list as listAt } from "@ermine/core/places/lib"
import type { Policy } from "@ermine/core/protect"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Key, Table } from "@ermine/core/table"
import type { Process } from "@ermine/processes/start"
import { devtools, type Travel } from "../devtools/answer.ts"

export type Graph = {
	scheduler: Scheduler
	table: Table
	places: Places
	// the host's scope: the face's writes are made under it (devtools' in a scope of its own under it)
	scope: Scope
	// where a write is said written; none: places.commit
	commit?: (changed: readonly Entry<unknown>[]) => void
	may?: Policy
}

// a node as the extension names one: by path (walked at each use) or by id, and its part
type Node = { path?: Path; id?: Id; part: Key }

// the face: what the extension calls
export function createFace(g: Graph) {
	const { scheduler: s, table, places, scope } = g
	const commit = g.commit ?? ((changed) => places.commit(changed))
	const guard = g.may === undefined
		? undefined
		: createGuard({ places, scheduler: s, table, may: g.may, from: [] })
	const thing = (id: Id, path?: Path): Thing => path === undefined ? { id } : { id, path }
	const idOf = (n: Node): Id | undefined =>
		n.id ?? (n.path ? gets(places, n.path)[0]?.id : undefined)
	const within = <T>(f: () => T): T => {
		const o = s.getCurrentScope()
		return o !== undefined ? f() : s.runWithScope(scope, f)
	}

	function entries(x: Node) {
		if (x.path === undefined) {
			if (x.id === undefined) return []
			const value = places.readValue(x.part, x.id)
			return value === undefined ? [] : [{ value, from: "id", id: x.id }]
		}
		return gets(places, x.path).map((a) => {
			try {
				guard?.read(target(thing(a.id, x.path), x.part))
			} catch {
				return { value: undefined, from: a.from, id: REFUSED, refused: true as const }
			}
			return { value: places.readValue(x.part, a.id), from: a.from, id: a.id }
		})
	}
	const list = (x: Node): string[] => {
		if (x.path !== undefined) return [...listAt(places, x.path)]
		return x.id === undefined ? [] : places.readKeys("children", x.id)
	}
	const peep = (x: Node, path: readonly (string | number)[] = []) => {
		const id = idOf(x)
		return id === undefined ? undefined : places.peep(() => places.readValue(x.part, id, path))
	}
	const reads = (x: Node) => entries(x).map(({ value, from }) => ({ value, from }))
	const change = (x: Node) => {
		const id = idOf(x)
		return id === undefined ? undefined : places.readChange(x.part, id)
	}
	function edit(x: Node, patches: readonly Patch[]) {
		within(() => {
			const id = idOf(x)
			if (id === undefined) throw new Error("nothing there")
			guard?.write("edit", target(thing(id, x.path), x.part))
			const header = createChangeHeader(s, { via: "devtools" })
			const entry = table.get(x.part, id) as Entry<unknown> | undefined
			if (entry === undefined) table.add(x.part, id, createEntry(undefined, header) as never)
			const e = (entry ?? table.get(x.part, id)) as Entry<unknown>
			update(e, patches as Patch[], header)
			commit([e])
		})
		s.pulse()
	}
	// a method: its node's value, a function, called in a scope of its own under the host's
	function send(x: Node, ...args: unknown[]) {
		const fn = peep({ ...x, part: "value" })
		if (typeof fn !== "function") throw new Error("not-a-method")
		const call = s.createScope({ caller: "devtools" }, scope)
		try {
			return s.runWithScope(call, () => (fn as (...a: unknown[]) => unknown)(...args))
		} finally {
			s.teardown(call)
		}
	}
	return { entries, list, peep, reads, change, edit, send }
}
export type Face = ReturnType<typeof createFace>

export function answer(
	g: Graph,
	o: {
		name: string
		processes?: () => Iterable<Process>
		stop?: (p: Process) => void
		travel?: Travel
	},
): () => void {
	const { scheduler: s, places, scope } = g
	let made: Face | undefined
	// the layer, as devtools reads a world holding a face (.api)
	const world = {
		s,
		host: scope,
		places,
		get api() {
			return made ??= createFace(g)
		},
		get apis() {
			return { runs: () => undefined, ...(o.stop ? { stop: (p: Process) => o.stop!(p) } : {}) }
		},
		get processes() {
			return new Map([...o.processes?.() ?? []].map((p) => [p.id, p]))
		},
	}
	return devtools(world, { name: o.name, travel: o.travel })
}

// a slaygrounds world (demo-world/world.ts), answered as its host's graph is: its processes can be
// stopped, its memos' latest runs shown, and a send runs the action through ermine's record
export function answerWorld(
	w: {
		s: Scheduler
		table: Table
		places: Places
		host: Scope
		processes: Map<string, Process>
		stop: (name: string) => void
		runs: (id: Id) => unknown
		call: (address: string[], args: unknown[]) => unknown
		parts: unknown
		statusIds: unknown
	},
	o: { name: string; travel?: Travel },
): () => void {
	const api = createFace({ scheduler: w.s, table: w.table, places: w.places, scope: w.host })
	const named = (p: Process) => [...w.processes].find(([, q]) => q === p)?.[0]
	const layer = {
		s: w.s,
		host: w.host,
		places: w.places,
		api,
		parts: w.parts,
		statusIds: w.statusIds,
		call: w.call,
		apis: {
			runs: w.runs,
			stop: (p: Process) => {
				const name = named(p)
				if (name !== undefined) w.stop(name)
			},
		},
		get processes() {
			return new Map([...w.processes.values()].map((p) => [p.id, p]))
		},
	}
	return devtools(layer, { name: o.name, travel: o.travel })
}
