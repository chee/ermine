// the world an example runs in, on @ermine/system. an example's host.ts makes one, seeds it, and says
// which processes run:
//
//   import { createWorld } from "@ermine/slaygrounds/world"
//   import { render } from "@ermine/render/dom"
//   const world = createWorld({ render, processes: [{ name: "counter" }] })
//   world.seed(() => ensureNode("/data/n", 21))
//   export const reload = world.reload
//
// a world is one createErmine (the host's object, world.ermine; the host calls @ermine/system's functions inside
// ermine.within, which seed does), and what the page needs beside it: boxes in the
// page, a process's view drawn with @ermine/render, the inspector's names. a program is a module; each process
// runs one export (default "default"), given nothing: it imports @ermine/system's functions and
// the world's tools (tools.ts) and calls them while it runs. its return, a view or an element, is
// made real in the process's box in the page. a process runs at /<name> (at: where else), its
// folder the one it is in: "./x" is beside it, a bare "x" is inside the process, gone at stop. a
// folder given (none: the root) is where the process runs: it runs at <folder>/<name>. a name
// under "./" must not be a process's name (a running process shadows it). a program's code is
// written at /code/<export> as a live function, typed javascript.
// reload: code written again, each process stopped ("replaced") and started on the new code.
// globalThis.ermine (the inspector): table, places, s, host (the host's scope), header, writes,
// parts, statusIds, pending, moments (last 4000), call, defined, binds, runs, processes, stop,
// ermine (the host's object)
//
// the world's tools are imported (tools.ts: who, change, up, inspect, host);
// extend gives a process what its host has of its own, read there by host()
import { createChangeHeader, NODE } from "@ermine/core/places/header"
import { move, type Path, place, type Places, rename, unplace } from "@ermine/core/places"
import { isPending } from "@ermine/core/places/status"
import { type Computer, createScheduler, type Info, type Scheduler } from "@ermine/core/scheduler"
import { trace } from "@ermine/core/scheduler/trace"
import type { Id } from "@ermine/core/table"
import type { Process } from "@ermine/processes/start"
import {
	type CreatedFunction,
	createErmine,
	ensureNode,
	type Ermine,
	executeAction,
	type Feature,
	patch,
	patchAttributes,
	type Started,
} from "@ermine/system"
import { installTypes, type Known } from "@ermine/types"
import type { Policy } from "@ermine/core/protect"
import { startSweeper, type World as PresenceWorld } from "@ermine/together/presence"
import { use } from "@ermine/slaygrounds/tools"

const JS = "com.netscape.javascript-source"

// a process an example runs: its name, the export it runs, where (none: /<name>), its folder
// (none: the root: it runs at <folder>/<name>), its args
export type Spec = {
	readonly name: string
	readonly export?: string
	readonly at?: readonly string[]
	readonly folder?: readonly string[]
	readonly args?: readonly string[]
}

// @ermine/render/dom's render, handed in (the world imports no view library): called in a process's
// setup, its bindings that process's; call: an action called from an event, as the process
// the page's, reached loosely: the world names no DOM types (the editor's type checker has no dom lib)
// deno-lint-ignore no-explicit-any
type Element = any
// deno-lint-ignore no-explicit-any
const page = globalThis as any
// (handed { name, call }: the process's name, and an action called as the process)
export type Render = (into: Element, view: never, options: never) => unknown

export type Options = {
	render: Render
	// none: one process, "demo"
	processes?: readonly Spec[]
	// the host's actor (none: "chee@laptop")
	actor?: string
	// a host's own, given each process as it starts and read there by tools' host() (its power:
	// "the host has this power, to let the user create processes with a different api")
	extend?: (process: { at: Path; args: readonly string[] }) => Record<string, unknown>
	// protect: the policy every process is asked of (none: everything allowed)
	may?: Policy
	// presence (playground/together/presence): a presence world on the host's scope, swept each
	// second, the world's presence: the host's, to hand programs as it likes (extend)
	presence?: { sweep?: number }
	// features, given to createErmine as they are (extensions/patchy: a patch node is read through;
	// extensions/pully, ...)
	features?: readonly Feature[]
	// the types (@ermine/types) at /ermine/types, before any seed: true, the well-known list; a list,
	// those too, after it
	types?: true | readonly Known[]
}

// a node: its id, and its path where known
type Item = { id: Id; path?: string[]; name?: string }

export function createWorld(o: Options) {
	// trust is read here, never handed in: a person's event is the one this window is dispatching.
	// the native getter is kept now, before any program runs (window.event can be replaced)
	const native = Object.getOwnPropertyDescriptor(globalThis, "event")?.get?.bind(globalThis)
	const trusted = () => (native?.() as Event | undefined)?.isTrusted === true

	const s: Scheduler = createScheduler()
	const moments: unknown[] = []
	trace(s, (m) => {
		moments.push(m)
		if (moments.length > 4000) moments.splice(0, 1000)
	})

	// for the page: each memo and effect (its node and where it is, its process), each method
	const parts = new Map<Computer, { entry: Item; at: unknown; process: Id }>()
	const statusIds = new Map<Id, Id>()
	const defined = new Map<Id, { process: Id }>()
	const binds = new WeakMap<object, string>()
	const notice = (m: CreatedFunction) => {
		if (m.computer) {
			const path = m.node.path as string[] | undefined
			parts.set(m.computer, {
				entry: { id: m.id, path },
				at: path,
				process: m.process,
			})
			statusIds.set(m.id, m.id)
		} else defined.set(m.id, { process: m.process })
	}

	const ermine: Ermine = createErmine({
		scheduler: s,
		features: [
			...(o.features ?? []),
			{
				name: "demo-world",
				setup: (f) => f.onCreateFunction((m, next) => (notice(m), next(m))),
			},
		],
		may: o.may,
		info: { actor: o.actor ?? "chee@laptop" },
	})
	const { places, table } = ermine
	const hostScope = ermine.getProcessContext()!.scope
	const commit = (changed: Parameters<Places["commit"]>[0]) => places.commit(changed)

	// ---- the world's own nodes: the types, written as the host ----
	s.runWithScope(hostScope, () => {
		if (o.types) commit(installTypes(table, places.root, createChangeHeader(s)))
		if (Array.isArray(o.types)) {
			commit(installTypes(table, places.root, createChangeHeader(s), o.types))
		}
	})
	const presence: PresenceWorld | undefined = o.presence
		? { table, places: { commit, readValue: places.readValue }, scheduler: s, scope: hostScope }
		: undefined
	if (presence) startSweeper(presence, o.presence?.sweep ?? 1000)

	// ---- a process's box in the page, and what its render is handed ----
	const views = new Map<string, Element>()
	function box(name: string): Element {
		let el = views.get(name)
		if (el === undefined) {
			el = page.document.body.appendChild(page.document.createElement("div"))
			el.setAttribute("data-ermine-box", name)
			views.set(name, el)
		}
		return el
	}
	// an action called from an event (nothing open then), made as the process (the scope its setup
	// ran in); a click's trust is the event's, read live by who() as the action runs
	function caller(at: readonly string[], scope: ReturnType<Scheduler["getCurrentScope"]>) {
		return (action: never, ...args: unknown[]) => {
			if (scope === undefined || scope.state !== "alive") {
				throw new Error(`${at.join("/")} has stopped`)
			}
			return s.runWithScope(scope, () => executeAction(action, ...args))
		}
	}
	// only a view is made real in a box: an element, a view or a binding (@ermine/render's, by
	// ermine-h's Symbol.for keys), or a list holding one. any other return (a number, a string, data) is the process's value, and nothing more
	const VIEW = Symbol.for("ermine-h.view"), BOUND = Symbol.for("ermine-h.bound")
	const isView = (v: unknown): boolean =>
		(typeof page.Node === "function" && v instanceof page.Node) ||
		(typeof v === "object" && v !== null && (VIEW in v || BOUND in v)) ||
		(Array.isArray(v) && v.some(isView))

	// ---- the tools, and what a process is told of by name ----
	// a process's node → its name (where it runs), for who's caller
	const named = new Map<unknown, string>()
	const extras = new Map<string, Record<string, unknown>>()
	use({
		trusted,
		s,
		places,
		ermine,
		named,
		extras,
		inspect: (address) => page.parent?.__pick?.([...address]),
	})

	const specs = o.processes ?? [{ name: "demo" }]
	const running = new Map<string, Started>()
	const processes = new Map<string, Process>()

	// a program's code at /code/<name>: a live function, typed javascript (reload writes the exports
	// its processes run; a host, any other)
	function code(name: string, fn: unknown) {
		ermine.within(() => {
			const node = ensureNode(`/code/${name}`)
			patch(node, [{ path: [], value: fn }])
			patchAttributes(node, [{ path: [], value: { "ermine.type": JS } }])
		})
	}

	// a program made a process's setup: its view made real in its box, any other return its value; a
	// setup that throws is told on the console with its stack, then thrown on (status holds it)
	function setup(spec: Spec, fn: () => unknown, at: Path) {
		return () => {
			const scope = s.getCurrentScope()
			const mine = scope === undefined ? undefined : scope.parent
			// the process's node, found in its scope's info, named for who's caller
			for (let o = scope; o !== undefined; o = o.parent) {
				if (NODE in o.info) {
					named.set(o.info[NODE], at.join("/"))
					break
				}
			}
			try {
				const view = fn()
				if (!isView(view)) return view
				return o.render(box(at.join("/")), view as never, {
					name: at.join("/"),
					call: caller(at, mine ?? scope),
				} as never)
			} catch (e) {
				console.error(`${spec.name}: its setup threw:`, e)
				throw e
			}
		}
	}

	// the program's exports written as nodes, each process stopped and started again on them
	function reload(mod: Record<string, unknown>) {
		for (const spec of specs) {
			const name = spec.export ?? "default"
			if (typeof mod[name] === "function") code(name, mod[name])
			else console.error(`program.ts has no export ${name} for ${spec.name}`)
		}
		for (const spec of specs) {
			running.get(spec.name)?.stop("replaced")
			running.delete(spec.name)
			processes.delete(spec.name)
			const name = spec.export ?? "default"
			const fn = mod[name]
			if (typeof fn !== "function") continue
			const at = [...(spec.at ?? [...(spec.folder ?? []), spec.name])]
			const args = spec.args ?? []
			extras.set(at.join("/"), o.extend?.({ at, args }) ?? {})
			const started = ermine.start(setup(spec, fn as () => unknown, at), at, { args: [...args] })
			if ("refused" in started) console.error(`${spec.name}: refused ${started.refused}`)
			else {
				running.set(spec.name, started)
				processes.set(spec.name, started.process)
			}
		}
	}

	// host writes before any program runs: the host's own functions, at the root
	function seed(f: (ermine: Ermine) => void) {
		ermine.within(() => f(ermine))
	}

	// a process stopped by its name
	function stop(name: string, why?: Info[string]) {
		running.get(name)?.stop(why as never)
		running.delete(name)
		processes.delete(name)
	}

	const world = {
		table,
		places,
		s,
		// the host's scope: what the world's own writes are made under
		host: hostScope,
		header: (extra?: Info) => createChangeHeader(s, extra),
		writes: { place, unplace, move, rename },
		parts,
		statusIds,
		pending: (id: Id) => isPending(places, id),
		moments,
		call: (address: string[], args: unknown[]) =>
			ermine.within(() => executeAction("/" + address.join("/"), ...args)),
		defined,
		binds,
		// the latest run of a memo's or effect's node (ermine.records): its record, or one field of it
		runs: (id: Id, field?: string) => {
			const r = ermine.records.run(id)
			return field === undefined
				? r
				: (r as unknown as Record<string, unknown> | undefined)?.[field]
		},
		processes,
		stop,
		presence,
		ermine,
	}
	;(globalThis as Record<string, unknown>).ermine = world

	return { reload, seed, code, world, ermine }
}
