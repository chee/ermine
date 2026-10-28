// start: a process's life and its stop, at a path in places. a process is a
// scheduler scope with one path (/work/clock). what runs in it is its starter's: this knows no
// programs, chains, loaders, builds or types
//
//   const processes = createProcesses({ scheduler, table, places, scopes })
//   const p = processes.start(places, "/clock", { args, folder, pin }, (inside) => {
//     inside.give(computer)                // its status on the process's node
//     return () => {}                      // called at its stop
//   })
//   // { id: "proc:3fa9c1d2e4b5a6f7-1", at: ["clock"], folder: [], scope }, or { refused: "taken", at: ["clock"] }
//   processes.stop(p)
//
// start(places, at, opts, body): at, folder: paths from the places' root, names or a string ("." here, ".." back one); folder default: at's folder. refused "taken",
// nothing made: a process already at exactly the path (above or under it is fine; whether it may is protect's). else, in order:
//   1. its node's id (setup.id's, else proc:<boot>-<n>), then a scope { process: at, [NODE]: id } (given the node,
//      scopes.ts) under options.under (none: the owner), made through setup.sites when given
//   2. the row: addProcess at the path, committed to the places given
//   3. node attributes: options.attributes, then ermine.process.args, .folder, .pin (processes' own
//      win); its status PENDING, in the status table (places' status.ts)
//   4. body, scope open, given give(computer, { run }): the computer's status (with run: its
//      latest run) on the node. a function returned: called at stop
// stop(p): body's return (scope open), the row out, the scope torn down, its run record out. its
// scope torn down from above (under's, the owner's): what is under it first, then the same. twice:
// nothing. every step runs; the first error is thrown after
// writes: each with the process's scope open, its site the call into start or stop
// open: pid("clock") not built (at is a plain path); args as strings; folder always written, never
// checked to be there
import createEntry, { type ChangeHeader } from "@ermine/core/node/entry"
import { type Id, type Path, type Places, PlacesError, type Writer } from "@ermine/core/places"
import { parse } from "@ermine/core/places/path"
import { createChangeHeader, NODE } from "@ermine/core/places/header"
import { createStatus, STATUS, TABLE } from "@ermine/core/places/status"
import { type Computer, PENDING, type Scheduler, type Scope } from "@ermine/core/scheduler"
import type { Sited } from "@ermine/sites"
import type { Table } from "@ermine/core/table"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import { addProcess, removeProcess } from "./processes.ts"
import { createRuns, type Runs } from "./runs.ts"
import type { ScopeNodes } from "./scopes.ts"

// the attributes written on a process's node
// this module's own file, by its URL: for whoever finds a write's site by skipping library frames
// (ermine's sites), so no one resolves a name to find it
export const FILES: readonly string[] = [import.meta.url]

export const ARGS = "ermine.process.args"
export const FOLDER = "ermine.process.folder"
export const PIN = "ermine.process.pin"

// a process: its node, its path from its root, its folder (the one it is in), its scope
export type Process = {
	readonly id: Id
	readonly at: Path
	readonly folder: Path
	readonly scope: Scope
}

// what body is given
export type Inside = Process & {
	readonly args: readonly string[]
	// the computer's status on the process's node; run: its latest run too
	give: (computer: Computer, options?: { run?: boolean }) => void
}

export type Options = {
	args?: readonly string[]
	folder?: Address
	// written as ermine.process.pin; none: not written
	pin?: unknown
	// written first, in the node's one attributes entry: a name processes' own write too is theirs
	attributes?: Readonly<Record<string, unknown>>
	// the scope its scope is made under: torn down, the process goes. none: the owner
	under?: Scope
	// the site its writes take (its starter's rule gives it); none: the call into start's, found once
	site?: FileLocation
}

// body's: what to do at the stop
export type Body = (inside: Inside) => (() => unknown) | void

export type Refused = { readonly refused: "taken"; readonly at: Path }

export type Setup = {
	scheduler: Scheduler
	table: Table
	// where status.ts' writes are committed: the host's. with
	// describe and watchAll, give's run is written too (runs.ts)
	places: Pick<Places, "commit"> & Partial<Pick<Places, "describe" | "watchAll">>
	// scope nodes (scopes.ts): each process's scope given its node (its entries go with the scope)
	scopes: Pick<ScopeNodes, "give">
	// where the processes' scopes are made, noting each one's site (ermine/sites; its ours holds
	// this file); none: the scheduler's, no sites
	sites?: Pick<Sited, "createScope" | "siteOf">
	// the scope the processes' are made under; torn down, every process goes. none: one made now
	// (through sites), under the scope open, its info [["processes", "start"]]
	owner?: Scope
	// files a write's site skips beside this one: a starter's own, so the site is its caller's
	ours?: Iterable<string>
	// none: each write made here (places' commit, table.add); given (places' Writer): every write
	// of a start or stop (the row, the node's attributes, statuses') handed to it to do and say
	write?: Writer
	// a new process's node id, the host's (unique for as long as its nodes are kept). none:
	// "proc:<boot>-<n>", boot 16 hex random once per createProcesses, n from 1 (most of it the same
	// each time, so it packs small)
	id?: () => Id
}

export type Processes = {
	start: (places: Places, at: Address, options?: Options, body?: Body) => Process | Refused
	stop: (p: Process) => void
	// a process's latest run by its node's id (runs.ts); none without describe and watchAll
	runs?: Runs["read"]
}

// an address: a string ("a/b", "../c", "/d"; path.ts' parse) or steps, each a name, ".", ".." or "/"
export type Address = string | Path

// the names an address comes to from where you are (names from the root): "." here, ".." back one
// (at the root: stays there), "/" back to the root
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

// a process's path and its folder, from what start is given
export function pathsOf(at: Address, folder?: Address): { at: Path; folder: Path } {
	const path = inside(at)
	return { at: path, folder: folder === undefined ? path.slice(0, -1) : inside(folder) }
}

// a process inside: what body gave back, until it is called; its row still at its root
type State = Process & {
	readonly places: Places
	done?: () => unknown
	ended: boolean
	rowed: boolean
}

// process ids: proc:<boot>-<n>, boot 16 hex random once per maker, n from 1
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
	const createScope = setup.sites?.createScope ?? s.createScope
	const ours = new Set([import.meta.url, ...(setup.ours ?? [])])
	const owner = setup.owner ?? createScope({ processes: "start" })
	const makeId = setup.id ?? processIds()
	const statuses = createStatus({ places, table, scheduler: s, write: setup.write })
	const { describe, watchAll } = places
	const runs = describe && watchAll
		? createRuns({ places: { describe, watchAll }, table, scheduler: s })
		: undefined
	s.registerTeardown(owner, () => {
		statuses.stop()
		runs?.stop()
	})
	const states = new WeakMap<Process, State>()

	// the header of a write made now (places' createChangeHeader), its site the call into entry
	// (start or stop)
	const headerOf = (entry?: unknown): ChangeHeader => createChangeHeader(s, undefined, ours, entry)

	// f with the process's scope open; torn down already (its own teardown): open, as it is
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
		// its writes' headers: the site given, else its scope's (held as it was made: the call into
		// start, read once), else the first header's
		let site = options.site
		const header = (): ChangeHeader => {
			site ??= setup.sites?.siteOf(scope)
			const h = createChangeHeader(s, undefined, ours, start, site)
			site ??= h.external?.[0]
			return h
		}
		const scope = createScope({ process: at, [NODE]: id }, options.under ?? owner)
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
			// its status in the status table, not its attributes (places' status.ts)
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
		// stop given it, as it is given the process
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

	// what body gave back, once; the row taken out, once (taken out already: nothing). every step
	// runs; the first error is thrown after
	function end(p: State, entry?: unknown) {
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
							removeProcess(table, p.places.root, p.at, headerOf(entry), setup.write),
						),
				)
			} catch (e) {
				if (!(e instanceof PlacesError && e.code === "nothing-there")) failed ??= { error: e }
			}
		}
		if (failed) throw failed.error
	}

	// core candidate (scheduler): a teardown that runs before what is under its scope goes, so a
	// scope torn down from above stops what body made while its computers are still there
	function stop(process: Process) {
		const p = states.get(process)
		if (p === undefined) return
		try {
			end(p, stop)
		} finally {
			s.teardown(p.scope)
		}
	}

	return { start, stop, runs: runs?.read }
}
