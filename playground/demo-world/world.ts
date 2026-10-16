// the world an example runs in: what every host copied by hand, once, on the process api
// (ermine/api). an example's host.ts makes one, seeds it, and says which processes run:
//
//   import { createWorld } from "@ermine/slaygrounds/world"
//   import { render } from "ermine-h"
//   const world = createWorld({ render, processes: [{ name: "counter" }] })
//   world.seed((host) => host.open("/data/n", 21))
//   export const reload = world.reload
//
// a program is a module: each process runs one of its exports (default: "default"), given the
// process api and nothing else (createProcessAPI's return; extend may add a host's own tools). its
// return, a view (ermine-h's) or an element, is made real in the process's box, with its scope open
//
// a program's code is a node: /code/<export>, a live function, typed javascript, run by a host
// runner at /code/run (apis.runner). a process runs at /<name> (spec.at), its working folder the
// root (spec.cwd): "./x" is /x, saved, there across reloads; a bare "x" is inside the process,
// gone at its stop. a name a program uses under "./" must not be a process's name (a running
// process shadows what is saved at its path)
//
// a reload (program.ts edited): each export's node written again, each process stopped (its
// teardowns told "replaced") and started again on the new code. what it made under "./" is there
// still; what it made inside itself is not
//
// for the page (globalThis.ermine, the inspector): table, places, s, host, header, writes, parts
// (a computer → its node), statusIds, pending, moments (the last 4000 of the scheduler's), call,
// defined (a method's node id → its process), binds (ermine-h's effects → what each binds), apis,
// programs, processes, sites (ermine/sites: siteOf and sitesOf of a computer or a process's scope)
import createEntry from "@ermine/node/entry"
import { children, createPlaces, move, place, type Places, rename, unplace } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import * as lib from "@ermine/places/lib"
import { plan } from "@ermine/places/path"
import { isPending } from "@ermine/places/status"
import { type Computer, createScheduler, type Pair } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { trace } from "@ermine/scheduler/trace"
import { createTable, type Id, type Key } from "@ermine/table"
import { processes as rows } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { createBuilds } from "@ermine/build"
import { satisfy } from "@ermine/programs"
import { type Context, createPrograms, type Process } from "@ermine/programs/start"
import { type API, createProcessAPIs, type Noticed } from "@ermine/api"
import type { Policy } from "@ermine/protect"
import { startSweeper, type World as PresenceWorld } from "@ermine/presence"
import { createSites } from "@ermine/sites"
import { createOverlay, type Overlay } from "@ermine/patch-nodes"

const JS = "com.netscape.javascript-source"

// a process an example runs: its name, the export it runs, where (none: /<name>), its working
// folder (none: the root), its args
export type Spec = {
	readonly name: string
	readonly export?: string
	readonly at?: readonly string[]
	readonly cwd?: readonly string[]
	readonly args?: readonly string[]
}

// ermine-h's render, handed in (the world imports no view library)
// the page's, reached loosely: the world names no DOM types (the editor's type checker has no dom lib)
// deno-lint-ignore no-explicit-any
type Element = any
// deno-lint-ignore no-explicit-any
const page = globalThis as any
export type Render = (into: Element, view: unknown, process: unknown) => unknown

export type Options = {
	render: Render
	// none: one process, "demo"
	processes?: readonly Spec[]
	// the host's actor (none: "chee@laptop")
	actor?: string
	// a host's own tools, added to what a process is given (its power: "the host has this power, to
	// let the user create processes with a different api")
	extend?: (api: API, ctx: Context) => Record<string, unknown>
	// protect: the policy every process is asked of (none: everything allowed)
	may?: Policy
	// presence (playground/presence): a presence world on the host's scope, swept each second, its
	// rows named who (none: "chee@laptop"); present, absent and presence work. none: they throw
	presence?: { who?: string; sweep?: number }
	// patch nodes (playground/patch-nodes): places over an overlay, so a patch node is read through
	overlay?: boolean
}

// an h item: an id, and its path where known
type Item = { id: Id; path?: string[]; name?: string }

export function createWorld(o: Options) {
	// trust is read here, never handed in: a person's event is the one this window is dispatching.
	// the native getter is kept now, before any program runs (window.event can be replaced)
	const native = Object.getOwnPropertyDescriptor(globalThis, "event")?.get?.bind(globalThis)
	const trusted = () => (native?.() as Event | undefined)?.isTrusted === true

	const s = createScheduler()
	// where each memo, effect, process and send's scope was made (ermine/sites), for the inspector:
	// a site is the first frame outside these libraries, so a memo's is the program's line and a
	// process's is where start was called
	const url = (specifier: string) => {
		try {
			return import.meta.resolve(specifier)
		} catch {
			return specifier
		}
	}
	const sites = createSites(s, {
		ours: ["@ermine/api", "@ermine/scheduler", "@ermine/programs/start", "@ermine/processes/start"]
			.map(url),
	})
	const table = createTable((part, id) =>
		overlay ? overlay.onTableChange(part as Key, id) : places.onTableChange(part as Key, id)
	)
	const overlay: Overlay | undefined = o.overlay ? createOverlay(table, () => places) : undefined
	const paths = createPaths<unknown>()
	const places: Places = createPlaces({
		root: "root",
		table: overlay ?? table,
		paths,
		scheduler: s,
		contributors: [rows("root"), children],
	})
	s.onTrackingEnd((key) => places.release(key))
	const moments: unknown[] = []
	trace(s, (m) => {
		moments.push(m)
		if (moments.length > 4000) moments.splice(0, 1000)
	})
	const host = s.createRootScope([["actor", o.actor ?? "chee@laptop"], ["trusted", true]])
	const above = s.createScope([["role", "programs"]], host)
	const scopes = createScopeNodes({ scheduler: s, table })
	const commit = (changed: Parameters<Places["commit"]>[0]) =>
		overlay ? overlay.commit(changed) : places.commit(changed)
	const presence: PresenceWorld | undefined = o.presence
		? { table, places: { commit, readValue: places.readValue }, scheduler: s, scope: host }
		: undefined
	if (presence) startSweeper(presence, o.presence?.sweep ?? 1000)

	// for the page
	const parts = new Map<Computer, { entry: Item; at: unknown; process: Id }>()
	const statusIds = new Map<Id, Id>()
	const defined = new Map<Id, { process: Id }>()
	const binds = new WeakMap<object, string>()
	const notice = (m: Noticed) => {
		if (m.computer) {
			parts.set(m.computer, {
				entry: { id: m.id, path: m.node.path as string[] },
				at: m.node.path,
				process: m.process,
			})
			statusIds.set(m.id, m.id)
		} else defined.set(m.id, { process: m.process })
	}

	// ---- the world's own nodes: the root, made by hand ----
	s.runWithScope(host, () => {
		table.add("value", "root", createEntry<unknown>(undefined, createChangeHeader(s)))
		table.add("children", "root", createEntry<Record<string, unknown>>({}, createChangeHeader(s)))
	})

	const ctxs = new WeakMap<object, Context>()
	const views = new Map<string, Element>()
	let programs!: ReturnType<typeof createPrograms>
	const apis = createProcessAPIs({
		scheduler: s,
		table,
		commit,
		host: { places, table, scheduler: s, commit },
		programs: () => programs,
		pairs: (): Pair[] => [["trusted", trusted()]],
		notice,
		may: o.may,
		presence,
		who: o.presence?.who ?? o.actor ?? "chee@laptop",
		overlay,
		sites,
	})

	// ---- a process's box in the page, and what ermine-h is handed ----
	function box(name: string): Element {
		let el = views.get(name)
		if (el === undefined) {
			el = page.document.body.appendChild(page.document.createElement("div"))
			el.setAttribute("data-ermine-box", name)
			views.set(name, el)
		}
		return el
	}
	// the names from the root to an id: a walk down, told to nobody
	function where(id: Id): string[] | undefined {
		const seen = new Set<Id>()
		const walk = (at: Id, names: string[]): string[] | undefined => {
			if (at === id) return names
			if (seen.has(at) || names.length > 24) return
			seen.add(at)
			const v = table.get("children", at)?.value as Record<string, unknown> | undefined
			for (const [name, kid] of Object.entries(v ?? {})) {
				if (typeof kid !== "string") continue
				const found = walk(kid, [...names, name])
				if (found) return found
			}
		}
		return walk("root", [])
	}
	const pathOf = (x: Item) => x.path ?? where(x.id)
	function viewer(api: API, ctx: Context) {
		const at = [...ctx.process.at]
		// h's find: "/" or any "." ".." in it, steps from the root (or from from); else the names under
		// the process's own node, and nowhere else: h asks it whether the process has a name, and
		// reads a name it has not from the root
		const find = (address: string[], from?: Item): Item[] => {
			const steps = address.some((a) => a === "/" || a === "." || a === "..")
			const path = !steps && from === undefined ? [...at, ...address] : plan(
				address[0] === "/" ? address : ["/", ...(from ? pathOf(from) ?? [] : []), ...address],
			)
			const id = path && lib.get(places, path)
			return id === undefined ? [] : [{ id, path: path!, name: path![path!.length - 1] }]
		}
		return {
			name: at.join("/"),
			where: (entry?: Item) => entry === undefined ? at : pathOf(entry),
			find,
			get: (item: Item) => places.readValue("value", item.id),
			pending: (item: Item) => isPending(places, item.id),
			members: (item: Item) => {
				const path = pathOf(item) ?? []
				return lib.members(places, path).map((m) => ({ ...m, path: [...path, m.name] }))
			},
			call: (address: string[], args: unknown[]) =>
				api.send({ path: plan(["/", ...address]) ?? [], part: "value" }, ...args),
			effect(read: () => unknown, act: (v: unknown, before: unknown) => void, name?: string) {
				const c = s.createEffect(read, act)
				if (name) binds.set(c, name)
				return c
			},
		}
	}

	// what a process is given: the api, and the host's own tools
	// (the extras put on the api itself: the runner knows a process by its api)
	function createProcessAPI(ctx: Context) {
		const api = apis.createProcessAPI(ctx)
		ctxs.set(api, ctx)
		if (o.extend) Object.assign(api, o.extend(api, ctx))
		return api
	}
	// only a view is made real in a box: an element, ermine-h's view or binding, or a list holding
	// one. any other return (a number, a string, data) is the process's value, and nothing more
	const VIEW = Symbol.for("ermine-h.view"), BOUND = Symbol.for("ermine-h.bound")
	const isView = (v: unknown): boolean =>
		(typeof page.Node === "function" && v instanceof page.Node) ||
		(typeof v === "object" && v !== null && (VIEW in v || BOUND in v)) ||
		(Array.isArray(v) && v.some(isView))
	const show = (view: unknown, api: API) => {
		const ctx = ctxs.get(api)
		if (!isView(view) || ctx === undefined) return view
		return o.render(box(ctx.process.at.join("/")), view, viewer(api, ctx))
	}

	// ---- programs: a runner for javascript at /code/run, each export a node in /code ----
	const hostAPI = apis.createProcessAPI({
		box: { root: "root", places },
		places,
		process: { id: "host", at: [], args: [], cwd: [] },
		scheduler: s,
		table,
		scope: host,
	})
	programs = s.runWithScope(above, () => {
		// describe and watchAll: each process's latest run on its node too (runs.ts)
		const writes = {
			readValue: places.readValue,
			commit,
			describe: places.describe,
			watchAll: places.watchAll,
		}
		const builds = createBuilds({ scheduler: s, table, places: writes, cache: "cache" })
		return createPrograms({
			scheduler: s,
			table,
			places: writes,
			builds,
			scopes,
			createProcessAPI,
			sites,
		})
	})
	// a setup that throws is told on the console with its stack (programs keeps it as the process's
	// status, which nobody here reads), then thrown on as before
	const runner = apis.runner(show)
	const run = (code: unknown, api: unknown) => {
		try {
			return runner(code, api)
		} catch (e) {
			console.error("a program's setup threw:", e)
			throw e
		}
	}
	s.runWithScope(host, () => {
		const runs = hostAPI.open("/code/run", run)
		hostAPI.edit(hostAPI.info(runs), [{ path: [], value: { "ermine.programs.takes": [JS] } }])
	})

	const specs = o.processes ?? [{ name: "demo" }]
	const running = new Map<string, Process>()

	// the program's exports written as nodes, each process stopped and started again on them
	function reload(mod: Record<string, unknown>) {
		for (const spec of specs) {
			const name = spec.export ?? "default"
			const code = mod[name]
			if (typeof code !== "function") {
				console.error(`program.ts has no export ${name} for ${spec.name}`)
				continue
			}
			s.runWithScope(host, () => {
				const node = hostAPI.open(["code", name])
				if (hostAPI.read(node) === undefined) hostAPI.open(["code", name], code)
				else hostAPI.edit(node, [{ path: [], value: code }])
				hostAPI.edit(hostAPI.info(node), [{ path: [], value: { "ermine.type": JS } }])
			})
		}
		for (const spec of specs) {
			const was = running.get(spec.name)
			if (was !== undefined) apis.stop(was, "replaced")
			running.delete(spec.name)
			const name = spec.export ?? "default"
			if (typeof mod[name] !== "function") continue
			for (const way of satisfy(places, `/code/${name}`, [])) {
				const p = s.runWithScope(
					host,
					() =>
						programs.start(places, way, [...(spec.at ?? [spec.name])], {
							...(spec.args ? { args: spec.args } : {}),
							cwd: [...(spec.cwd ?? [])],
						}),
				)
				if ("refused" in p) console.error(`${spec.name}: refused ${p.refused}`)
				else running.set(spec.name, p)
				break
			}
		}
		s.pulse()
	}

	// host writes before any program runs: the host's own api, at the root
	function seed(f: (host: API) => void) {
		s.runWithScope(host, () => f(hostAPI))
		s.pulse()
	}

	const world = {
		table,
		places,
		s,
		host,
		header: (extra?: Iterable<Pair>) => createChangeHeader(s, extra),
		writes: { place, unplace, move, rename },
		parts,
		statusIds,
		pending: (id: Id) => isPending(places, id),
		moments,
		call: (address: string[], args: unknown[]) =>
			s.runWithScope(
				host,
				() => hostAPI.send({ path: plan(["/", ...address]) ?? [], part: "value" }, ...args),
			),
		defined,
		binds,
		apis,
		programs,
		processes: running,
		presence,
		overlay,
		// siteOf(scope) and sitesOf(scope): a memo's or effect's computer (parts' keys), a process's
		// scope (processes' values)
		sites,
	}
	;(globalThis as Record<string, unknown>).ermine = world

	return { reload, seed, world, hostAPI }
}
