// tenfold on dens: the host's part. one den with a surface, a javascript runner and the loop-budget
// compiler; the letters and knobs as nodes; the engine (engine.ts) a program, started on the den
//
//   const t = createTenfold({ surface: createRecording().surface })
//   const engine = t.start()                    // the engine, at /tenfold/view
//   t.write("e/0.js", "move(-1, 0)\nline(1, 0)") // a letter's source, made or changed
//   t.knob(0, { letter: "e/0.js", x: 0.5 })     // cell 0's knob
//   t.pulse()
//
// at the root (R), ids the paths from it:
//   /system/dens/<id>, /system/den     the den (@ermine/dens), offering
//     runners/javascript               ermine/api's run: takes javascript, api ermine.api
//     surfaces/screen                  the surface given: { kind (none: "recording"), size? }
//     compilers/loop-budget            budget.ts' instrument: letter source in, letter out
//   /tenfold/letters/<path>            a letter: its source, ermine.type ermine.tenfold-letter-source
//   /tenfold/knobs                     engine.ts' Knobs
//   /tenfold/engine.js                 the engine: ermine.type javascript, api ermine.api
//   /tenfold/cache                     build's cache: a compile a source, kept by its hash
//   /tenfold/view                      the engine, started
// the processes' api: ermine/api's, and offer (the den's, by the process) and compile (build's,
// the compiler at an address from the root). the host writes in a scope { actor: "host" }
import createEntry, { type Entry } from "@ermine/node/entry"
import { inside } from "@ermine/boxes"
import { COMPILER, createBuilds } from "@ermine/build"
import { createProcessAPIs, type ProcessAPIs } from "@ermine/api"
import {
	API,
	COMPILER_TAKES,
	type Context,
	createDen,
	type Den,
	GIVES,
	KIND,
	type Kind,
	type Process,
	PROGRAM_API,
	type Refused,
	SIZE,
	TAKES,
	WHERE,
} from "@ermine/dens"
import { children, createPlaces, type Id, type Path, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { get } from "@ermine/places/lib"
import { upsert } from "@ermine/places/upsert"
import { processes } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createScheduler, type Scheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key, type Table } from "@ermine/table"
import { instrument } from "./budget.ts"
import engine, { type EngineAPI, type Knob, type Knobs, LETTER } from "./engine.ts"
import { KNOBS, LETTERS } from "./letters.ts"
import type { Surface } from "./surfaces.ts"

export const ROOT = "R"
export const JS = "com.netscape.javascript-source"
export const SOURCE = "ermine.tenfold-letter-source"
export const VIEW = ["tenfold", "view"]
const RUN = "/system/den/runners/javascript"

export type Options = {
	surface: Surface
	kind?: string
	size?: readonly [number, number]
	// the den's name; none: "page"
	id?: string
	// by path under /tenfold/letters; none: letters.ts'
	letters?: Readonly<Record<string, string>>
	knobs?: Knobs
	// as ermine/api's: how a pulse is asked for (none: a microtask)
	schedule?: (f: () => void) => void
}

export type Tenfold = {
	readonly s: Scheduler
	readonly table: Table
	readonly places: Places
	readonly den: Den
	readonly apis: ProcessAPIs
	// f with the host's scope open
	readonly hosted: <T>(f: () => T) => T
	// a value (and attributes) at a path from the root, its folders made
	readonly put: (path: Path, value?: unknown, attributes?: Record<string, unknown>) => void
	// a letter's source, made or changed, by its path under /tenfold/letters
	readonly write: (path: string, source: string) => void
	// a cell's knob changed
	readonly knob: (cell: number, change: Partial<Knob>) => void
	readonly knobs: () => Knobs
	// the engine started at /tenfold/view, with args (engine.ts)
	readonly start: (args?: readonly string[]) => Process
	// the node at a path, untracked
	readonly idAt: (path: Path) => Id | undefined
	// how many times the compiler ran: build's cache saves the rest
	readonly compiles: () => number
	readonly pulse: () => void
}

export function createTenfold(o: Options): Tenfold {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({
		root: ROOT,
		table,
		paths: createPaths<unknown>(),
		scheduler: s,
		contributors: [processes(ROOT), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const host = s.createRootScope({ actor: "host" })
	const hosted = <T>(f: () => T) => s.runWithScope(host, f)
	const header = () => createChangeHeader(s)
	const commit = (changed: readonly Entry<unknown>[]) => places.commit(changed)
	const idAt = (path: Path): Id | undefined => places.peep(() => get(places, path))

	function put(path: Path, value?: unknown, attributes?: Record<string, unknown>) {
		hosted(() => {
			let parent: Id = ROOT
			path.forEach((name, k) => {
				const id = path.slice(0, k + 1).join("/")
				commit(upsert(table, "children", parent, [name], id, header()))
				parent = id
			})
			if (value !== undefined) table.sub("value", parent, createEntry(value as never, header()))
			if (attributes) table.sub("attributes", parent, createEntry(attributes, header()))
		})
	}

	const apis = createProcessAPIs({
		scheduler: s,
		table,
		commit,
		host: { places, table, scheduler: s, commit },
		programs: () => {
			throw new Error("a den starts processes, not programs")
		},
		...(o.schedule ? { schedule: o.schedule } : {}),
	})
	const builds = hosted(() =>
		createBuilds({ scheduler: s, table, places, cache: ["tenfold", "cache"].join("/") })
	)
	const createProcessAPI = (ctx: Context): EngineAPI =>
		Object.assign(apis.createProcessAPI(ctx), {
			offer: (kind: Kind, name: string, attributes: Record<string, unknown>, live: unknown) =>
				ctx.den.offer(kind, name, attributes, live, ctx.process.id),
			compile: (compiler: string, input: unknown) => {
				const id = idAt(inside(compiler))
				return id === undefined
					? new Error(`no compiler at ${compiler}`)
					: builds.compile(id, input)
			},
		})
	const den: Den = hosted(() =>
		createDen({
			scheduler: s,
			table,
			places,
			scopes: createScopeNodes({ scheduler: s, table }),
			createProcessAPI,
			id: o.id ?? "page",
		})
	)

	let compiles = 0
	const budget = (input: unknown) => {
		compiles++
		return instrument(String(input))
	}
	hosted(() => {
		den.offer(
			"runners",
			"javascript",
			{ [TAKES]: JS, [API]: "ermine.api", [WHERE]: "thread" },
			apis.run,
		)
		const size = o.size ? { [SIZE]: [...o.size] } : {}
		den.offer("surfaces", "screen", { [KIND]: o.kind ?? "recording", ...size }, o.surface)
		den.offer("compilers", "loop-budget", {
			[COMPILER_TAKES]: SOURCE,
			[GIVES]: LETTER,
			[COMPILER]: { name: "loop-budget", version: 1 },
			"ermine.programs.gives": LETTER,
		}, budget)
	})

	put(["tenfold", "cache"])
	for (const [path, source] of Object.entries(o.letters ?? LETTERS)) write(path, source)
	put(["tenfold", "knobs"], o.knobs ?? KNOBS)
	put(["tenfold", "engine.js"], { default: engine }, {
		"ermine.type": JS,
		[PROGRAM_API]: "ermine.api",
	})

	function write(path: string, source: string) {
		put(["tenfold", "letters", ...path.split("/")], source, { "ermine.type": SOURCE })
	}

	function knobs(): Knobs {
		return table.get("value", "tenfold/knobs")?.value as Knobs
	}

	function knob(cell: number, change: Partial<Knob>) {
		const now = knobs()
		const cells = [...now.cells]
		cells[cell] = { ...cells[cell], ...change }
		put(["tenfold", "knobs"], { ...now, cells })
	}

	function start(args: readonly string[] = []): Process {
		const p = hosted(() => den.start(RUN, "/tenfold/engine.js", VIEW, { args }))
		if ("refused" in p) throw new Error(`engine refused: ${(p as Refused).refused}`)
		return p
	}

	return {
		s,
		table,
		places,
		den,
		apis,
		hosted,
		put,
		write,
		knob,
		knobs,
		start,
		idAt,
		compiles: () => compiles,
		pulse: () => s.pulse(),
	}
}
