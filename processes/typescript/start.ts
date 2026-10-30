// A process's life and its stop at a path in places. A process is a scheduler scope with one
// path. It knows no programs, loaders or types.
import createEntry, { type ChangeHeader } from "@ermine/graph/entry"
import { type Id, type Path, type Places, PlacesError, type Writer } from "@ermine/places"
import { parse } from "@ermine/places/path"
import { createChangeHeader, locationsHere } from "@ermine/places/header"
import { createStatus, STATUS, TABLE } from "./status.ts"
import { type Computer, PENDING, type Scheduler, type Scope } from "@ermine/reactivity"
import type { Table } from "@ermine/graph/table"
import type { Location } from "@ermine/changeable/stacktrace"
import { addProcess, removeProcess } from "./processes.ts"
import { createRuns, type Runs } from "./runs.ts"
import type { ScopeNodes } from "./scopes.ts"

export const ARGS = "ermine.process.args"
export const FOLDER = "ermine.process.folder"
export const PIN = "ermine.process.pin"

export type Process = {
	readonly id: Id
	readonly at: Path
	readonly folder: Path
	readonly scope: Scope
}

export type Inside = Process & {
	readonly args: readonly string[]
	give: (computer: Computer, options?: { run?: boolean }) => void
}

export type Options = {
	args?: readonly string[]
	folder?: Address
	pin?: unknown
	attributes?: Readonly<Record<string, unknown>>
	under?: Scope
	build?: Location
	cut?: unknown
}

export type Body = (inside: Inside) => (() => unknown) | void

export type Refused = { readonly refused: "taken"; readonly at: Path }

export type Setup = {
	scheduler: Scheduler
	table: Table
	// where status.ts' writes are committed: the host's. with
	// describe and watchAll, give's run is written too (runs.ts)
	places: Pick<Places, "commit"> & Partial<Pick<Places, "describe" | "watchAll">>
	scopes: Pick<ScopeNodes, "give">
	owner?: Scope
	write?: Writer
	id?: () => Id
	now?: () => number
}

export type Processes = {
	start: (places: Places, at: Address, options?: Options, body?: Body) => Process | Refused
	stop: (p: Process) => void
	runs?: Runs["read"]
}

export type Address = string | Path

export function inside(address: Address, from: Path = []): string[] {
	const names = [...from]
	for (const step of typeof address === "string" ? parse(address) : address) {
		if (step === ".") continue
		if (step === "/") names.length = 0
		else if (step === "..") names.pop()
		else names.push(step)
	}
	return names
}

export function pathsOf(at: Address, folder?: Address): { at: Path; folder: Path } {
	const path = inside(at)
	return { at: path, folder: folder === undefined ? path.slice(0, -1) : inside(folder) }
}

type State = Process & {
	readonly places: Places
	done?: () => unknown
	ended: boolean
	rowed: boolean
}

export function processIds(): () => string {
	const boot = Array.from(
		crypto.getRandomValues(new Uint8Array(8)),
		(b) => b.toString(16).padStart(2, "0"),
	)
		.join("")
	let made = 0
	return () => `proc:${boot}-${++made}`
}

export function createProcesses(setup: Setup): Processes {
	const { scheduler: s, table, places, scopes } = setup
	const owner = setup.owner ?? s.createScope({ processes: "start" })
	const makeId = setup.id ?? processIds()
	const statuses = createStatus({
		places,
		table,
		scheduler: s,
		write: setup.write,
		now: setup.now,
	})
	const { describe, watchAll } = places
	const runs = describe && watchAll
		? createRuns({ places: { describe, watchAll }, table, scheduler: s })
		: undefined
	s.registerTeardown(owner, () => {
		statuses.stop()
		runs?.stop()
	})
	const states = new WeakMap<Process, State>()

	const headerOf = (): ChangeHeader => createChangeHeader(s, { now: setup.now })

	const within = <T>(p: State, f: () => T): T =>
		p.scope.state === "alive" ? s.runWithScope(p.scope, f) : f()

	function start(
		places: Places,
		address: Address,
		options: Options = {},
		body?: Body,
	): Process | Refused {
		const { at, folder } = pathsOf(address, options.folder)
		const id: Id = makeId()
		const header = headerOf
		const locations = locationsHere(s, options.build, options.cut)
		const scope = s.createScope(
			{ process: at, node: id, ...locations !== undefined && { locations } },
			options.under ?? owner,
		)
		scopes.give(scope, id)
		try {
			s.runWithScope(
				scope,
				() => places.commit(addProcess(table, places.root, at, id, header(), setup.write)),
			)
		} catch (e) {
			s.teardown(scope)
			if (e instanceof PlacesError && e.code === "already-there") return { refused: "taken", at }
			throw e
		}
		const args = options.args ?? []
		const p: State = { id, at, folder, scope, places, ended: false, rowed: true }
		const process: Process = { id, at, folder, scope }
		states.set(process, p)
		if (runs !== undefined) s.registerTeardown(scope, () => runs.drop(id))
		s.registerTeardown(scope, () => end(p))
		try {
			const attrs: Record<string, unknown> = { ...options.attributes }
			if (options.args !== undefined) attrs[ARGS] = options.args
			attrs[FOLDER] = folder
			if (options.pin !== undefined) attrs[PIN] = options.pin
			const status = { [STATUS]: PENDING }
			s.runWithScope(scope, () => {
				if (setup.write) {
					setup.write("attributes", id, [{ path: [], value: attrs }], header())
					setup.write(TABLE, id, [{ path: [], value: status }], header())
					return
				}
				table.add("attributes", id, createEntry(attrs, header()))
				table.add(TABLE, id, createEntry(status, header()))
			})
		} catch (e) {
			stop(process)
			throw e
		}
		if (body === undefined) return process
		const give = (c: Computer, o?: { run?: boolean }) => {
			statuses.give(c, id)
			if (o?.run) runs?.give(c, id)
		}
		const inside: Inside = { ...process, args, give }
		states.set(inside, p)
		try {
			const done = s.runWithScope(scope, () => body(inside))
			if (typeof done === "function") p.done = done
		} catch (e) {
			stop(process)
			throw e
		}
		return process
	}

	function end(p: State) {
		let failed: { error: unknown } | undefined
		if (!p.ended) {
			p.ended = true
			const done = p.done
			p.done = undefined
			try {
				if (done !== undefined) within(p, done)
			} catch (error) {
				failed = { error }
			}
		}
		if (p.rowed) {
			p.rowed = false
			try {
				within(
					p,
					() =>
						p.places.commit(
							removeProcess(table, p.places.root, p.at, headerOf(), setup.write),
						),
				)
			} catch (e) {
				if (!(e instanceof PlacesError && e.code === "nothing-there")) failed ??= { error: e }
			}
		}
		if (failed) throw failed.error
	}

	// Runs before what is under the scope goes, so a scope torn down from above stops what body
	// made while its computers are still there.
	function stop(process: Process) {
		const p = states.get(process)
		if (p === undefined) return
		try {
			end(p)
		} finally {
			s.teardown(p.scope)
		}
	}

	return { start, stop, runs: runs?.read }
}
