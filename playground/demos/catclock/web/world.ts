// world.ts: the demo's graph, as the slaygrounds' hosts make theirs: a table of entries, places
// naming them, the scheduler running what reads them. A box (@ermine/boxes) is a plain folder in
// it, its places a view of these. Every write is the host's, in its scope, told to the places.
//
//   /ermine/types/<uti>         the types (@ermine/types)
//   /catclock/src/<file>        the C, text; ermine.type public.c-source (.c), public.c-header (.h)
//   /loaders                    ermine.programs.loaders: its children are loaders
//   /loaders/clang              the host's compiler: a live function asking serve.ts's clang
//   /loaders/canvas             the host's runner: a live function running a wasm on the canvas
//   /loaders/canvas.js          the runner's code, text: canvas runs what this says
//   /cache/<key>                each build (@ermine/build), by its key
import createEntry, { type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import produce from "@ermine/op/produce"
import { createPlaces, place, unplace } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import * as lib from "@ermine/places/lib"
import { createScheduler, type Ended } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable } from "@ermine/table"

export type Path = readonly string[]

export function createWorld() {
	// deno-lint-ignore prefer-const
	let places: ReturnType<typeof createPlaces>
	const table = createTable((part, id) => places.onTableChange(part, id))
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	// a settled promise (a build) waits for the next pulse
	s.onSettle(() => queueMicrotask(() => s.pulse()))
	const paths = createPaths()
	places = createPlaces({ root: "root", table, paths, scheduler: s })
	// a write landed: told to the places (a box's are a view of them: told too)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	const host = s.createRootScope({ actor: "catclock demo", "trusted-event": true })
	const header = () => createChangeHeader(s)
	// writes inside writes: one pulse, once the outermost is done (several files changed as one)
	let depth = 0
	const writing = <T>(f: () => T): T => {
		depth++
		try {
			return s.runWithScope(host, f)
		} finally {
			if (--depth === 0) s.pulse()
		}
	}

	writing(() => {
		table.add("value", "root", createEntry(undefined, header()))
		table.add("children", "root", createEntry({}, header()))
	})

	// tracked reads: the id at a path, its value, its attributes, the names under it
	const id = (path: Path) => lib.get(places, path)
	const read = (path: Path) => {
		const at = id(path)
		return at === undefined ? undefined : places.readValue("value", at)
	}
	const attributes = (path: Path) => {
		const at = id(path)
		return at === undefined
			? undefined
			: places.readValue("attributes", at) as Record<string, unknown> | undefined
	}
	// (list gives an iterator, or an array as it once did: a list either way)
	const list = (path: Path): string[] => Array.from(lib.list(places, path) as Iterable<string>)

	// a node at path, its folders made on the way: a new id, its value, attributes and children
	// entries in the table, placed under its name
	function make(path: Path, value?: unknown, attrs?: Record<string, unknown>) {
		return writing(() => {
			let parent = "root"
			for (let i = 0; i < path.length; i++) {
				const kids = table.get("children", parent)!
				const there = (kids.value as Record<string, string>)[path[i]]
				if (there !== undefined && i < path.length - 1) {
					parent = there
					continue
				}
				const id = crypto.randomUUID()
				const last = i === path.length - 1
				table.add("value", id, createEntry(last ? value : undefined, header()))
				table.add("children", id, createEntry({}, header()))
				if (last && attrs) table.add("attributes", id, createEntry(attrs, header()))
				commit(place(kids, path[i], id, header()))
				parent = id
			}
			return parent
		})
	}

	// the node at path taken out of its folder (its entries stay in the table, out of reach)
	function remove(path: Path) {
		writing(() => {
			const kids = table.get("children", id(path.slice(0, -1))!)!
			commit(unplace(kids, path.at(-1)!, header()))
		})
	}

	// the node at path put last in its folder: the same node taken out and put back
	function toEnd(path: Path) {
		writing(() => {
			const kids = table.get("children", id(path.slice(0, -1))!)!
			const name = path.at(-1)!, at = (kids.value as Record<string, string>)[name]
			if (at === undefined || Object.keys(kids.value as object).at(-1) === name) return
			commit(unplace(kids, name, header()))
			commit(place(kids, name, at, header()))
		})
	}

	// the value at path, whole
	function put(path: Path, value: unknown) {
		writing(() => {
			const n = table.get("value", s.runWithScope(host, () => id(path))!)!
			update(n, [{ path: [], value }], header())
			commit([n])
		})
	}

	// text at path changed to text: the patches produce makes for the span that changed (in code
	// points, as apply counts them), not the whole
	function edit(path: Path, text: string) {
		writing(() => {
			const n = table.get("value", id(path)!)!
			const before = Array.from(String(n.value ?? "")), after = Array.from(text)
			let start = 0
			while (start < before.length && start < after.length && before[start] === after[start]) {
				start++
			}
			let end = 0
			while (
				end < before.length - start && end < after.length - start &&
				before[before.length - 1 - end] === after[after.length - 1 - end]
			) end++
			const insert = after.slice(start, after.length - end).join("")
			const patches = produce(String(n.value ?? ""), (draft, { splice }) => {
				splice(draft as string, start, before.length - start - end, insert)
			})
			if (!patches.length) return
			update(n, patches, header())
			commit([n])
		})
	}

	// what reads the graph: an effect (read, then act on what it read), run again when what it
	// read changes; a computer, its value set. each named before its first run, for whoever shows
	// them (the scheduler keeps no names)
	type Computer = ReturnType<typeof s.createEffect>
	const named = new Map<Computer, string>()
	const naming = (name: string, c: Computer) => {
		named.set(c, name)
		s.pulse()
		return c
	}
	const effect = <T>(name: string, f: () => T, act: (v: T, before: T | undefined) => void) =>
		naming(name, s.runWithScope(host, () => s.createEffect(f, act)))
	const computer = <T>(name: string, f: () => T | Promise<T>, set: (v: T) => void) =>
		naming(name, s.runWithScope(host, () => s.createComputer(f, set)))

	// what each named one's latest run did, as the scheduler tells it: when it started, how it
	// ended (a run waiting on a promise ends pending, and ends again once it settles), the nodes
	// it read. kept from the start, for whoever shows them; each change told to the listening
	const runs = new Map<Computer, Run>()
	const listening = new Set<(run: Run) => void>()
	s.onRunStart((c, n) => {
		const name = named.get(c)
		if (name === undefined) return
		const run: Run = {
			name,
			kind: c.kind,
			state: "running",
			since: performance.now(),
			n,
			reads: runs.get(c)?.reads ?? [],
		}
		runs.set(c, run)
		for (const f of listening) f(run)
	})
	s.onRunEnd((c, n, ended, reads, more) => {
		const run = runs.get(c)
		if (!run || run.n !== n) return
		run.state = ended
		if (ended !== "pending") run.took = performance.now() - run.since
		run.error = more.error
		const ids = new Set<string | symbol>()
		for (const r of reads) {
			const at = places.describe(r)
			if (at && at.part === "value") ids.add(at.id)
		}
		run.reads = [...ids]
		for (const f of listening) f(run)
	})
	const onRun = (f: (run: Run) => void) => (listening.add(f), () => void listening.delete(f))

	// a read made outside any run: told to no one
	const peek = <T>(f: () => T): T => s.runWithScope(host, f)

	return {
		table,
		places,
		commit,
		s,
		host,
		id,
		read,
		attributes,
		list,
		make,
		remove,
		toEnd,
		put,
		edit,
		effect,
		computer,
		runs,
		onRun,
		peek,
		writing,
	}
}

export type World = ReturnType<typeof createWorld>

// a computation's latest run
export type Run = {
	name: string
	kind: "compute" | "effect"
	state: "running" | Ended
	since: number // when it started (performance.now)
	took?: number // ms, once it ended other than pending
	n: number // its number: how many runs so far
	reads: (string | symbol)[] // the ids of the nodes it read
	error?: unknown
}
