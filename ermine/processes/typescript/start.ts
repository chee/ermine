// start: a process's life and its stop, at a path in a box or plain places. a process is a
// scheduler scope with one path (/work/clock). what runs in it is its starter's: this knows no
// programs, chains, loaders, builds or types
//
//   const processes = createProcesses({ scheduler, table, places, scopes })
//   const p = processes.start(b, "/clock", { args, cwd, pin }, (inside) => {
//     inside.give(computer)                // its status on the process's node
//     return () => {}                      // called at its stop
//   })
//   // { id: "proc:<uuid>", at: ["clock"], cwd: [], scope }, or { refused: "taken", at: ["clock"] }
//   processes.stop(p)
//
// start(where, at, opts, body): where a box ({ root, places }) or places. at, cwd: paths from its
// root, names or a string ("." here, ".." back one); cwd default: at's folder. refused "taken",
// nothing made: a process at, above or under the path. else, in order:
//   1. its node's id (proc:<uuid>), then a scope { process: at, [NODE]: id } (given the node,
//      scopes.ts), made through setup.sites when given
//   2. the row: addProcess at the path, committed to the places given
//   3. node attributes: options.attributes, then ermine.process.args, .cwd, .pin, and status
//      PENDING (processes' own win)
//   4. body, scope open, given give(computer, { run }): the computer's status (with run: its
//      latest run) on the node. a function returned: called at stop
// stop(p): body's return (scope open), the row out, the scope torn down (from above: computers go
// first). twice: nothing. every step runs; the first error is thrown after
// writes: each with the process's scope open, its site the call into start or stop
// open: pid("clock") not built (at is a plain path); args as strings; cwd always written, never
// checked to be there
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import { type Address, type Box, inside } from "@ermine/boxes"
import { type Id, type Path, type Places, PlacesError } from "@ermine/places"
import { createChangeBase, NODE } from "@ermine/places/header"
import { createStatus, STATUS } from "@ermine/places/status"
import {
	type Computer,
	PENDING,
	type Scheduler,
	SchedulerError,
	type Scope,
} from "@ermine/scheduler"
import type { Sited } from "@ermine/sites"
import type { Table } from "@ermine/table"
import { capture } from "@ermine/util/stacktrace"
import { addProcess, removeProcess } from "./processes.ts"
import { createRuns, type Runs } from "./runs.ts"
import type { ScopeNodes } from "./scopes.ts"

// the attributes written on a process's node
export const ARGS = "ermine.process.args"
export const CWD = "ermine.process.cwd"
export const PIN = "ermine.process.pin"

// a process: its node, its path from its root, its working folder, its scope
export type Process = {
	readonly id: Id
	readonly at: Path
	readonly cwd: Path
	readonly scope: Scope
}

// what body is given
export type Inside = Process & {
	// where it runs: the box given, or { root, places } of the places given
	readonly box: Box
	readonly args: readonly string[]
	// the computer's status on the process's node; run: its latest run too
	give: (computer: Computer, options?: { run?: boolean }) => void
}

export type Options = {
	args?: readonly string[]
	cwd?: Address
	// written as ermine.process.pin; none: not written
	pin?: unknown
	// written first, in the node's one attributes entry: a name processes' own write too is theirs
	attributes?: Readonly<Record<string, unknown>>
}

// body's: what to do at the stop
export type Body = (inside: Inside) => (() => unknown) | void

export type Refused = { readonly refused: "taken"; readonly at: Path }

export type Setup = {
	scheduler: Scheduler
	table: Table
	// where status.ts' writes are committed: the host's (a box's places shares its commit). with
	// describe and watchAll, give's run is written too (runs.ts)
	places: Pick<Places, "commit"> & Partial<Pick<Places, "describe" | "watchAll">>
	// scope nodes (scopes.ts): each process's scope given its node (its entries go with the scope)
	scopes: Pick<ScopeNodes, "give">
	// where the processes' scopes are made, noting each one's site (ermine/sites; its ours holds
	// this file); none: the scheduler's, no sites
	sites?: Pick<Sited, "createScope">
	// the scope the processes' are made under; torn down, every process goes. none: one made now
	// (through sites), under the scope open, its info [["processes", "start"]]
	owner?: Scope
	// files a write's site skips beside this one: a starter's own, so the site is its caller's
	ours?: Iterable<string>
}

export type Processes = {
	start: (where: Box | Places, at: Address, options?: Options, body?: Body) => Process | Refused
	stop: (p: Process) => void
	// a process's latest run by its node's id (runs.ts); none without describe and watchAll
	runs?: Runs["read"]
}

// a process's path and its working folder, from what start is given
export function pathsOf(at: Address, cwd?: Address): { at: Path; cwd: Path } {
	const path = inside(at)
	return { at: path, cwd: cwd === undefined ? path.slice(0, -1) : inside(cwd) }
}

// a process inside: what body gave back, until it is called; its row still at its root
type State = Process & {
	readonly box: Box
	done?: () => unknown
	ended: boolean
	rowed: boolean
}

export function createProcesses(setup: Setup): Processes {
	const { scheduler: s, table, places, scopes } = setup
	const createScope = setup.sites?.createScope ?? s.createScope
	const ours = new Set([import.meta.url, ...(setup.ours ?? [])])
	const owner = setup.owner ?? createScope({ processes: "start" })
	const statuses = createStatus({ places, table, scheduler: s })
	const { describe, watchAll } = places
	const runs = describe && watchAll
		? createRuns({ places: { describe, watchAll }, table, scheduler: s })
		: undefined
	s.registerTeardown(owner, () => {
		statuses.stop()
		runs?.stop()
	})
	const states = new WeakMap<Process, State>()

	// the header of a write made now, its site the call into entry (start or stop), as boxes' is
	// core candidate (places' header.ts): createChangeHeader taking the function called
	function headerOf(entry?: unknown): ChangeHeader {
		const who = createChangeBase(s)
		if (who === undefined) throw new SchedulerError("unscoped", "a write with no scope open")
		const h: ChangeHeader = { ...who, time: Math.floor(Date.now() / 1000) }
		const site = capture(ours, entry)
		if (site) h.external = [site]
		return h
	}

	// f with the process's scope open; torn down already (its own teardown): open, as it is
	const within = <T>(p: State, f: () => T): T =>
		p.scope.state === "alive" ? s.runWithScope(p.scope, f) : f()

	function start(
		where: Box | Places,
		address: Address,
		options: Options = {},
		body?: Body,
	): Process | Refused {
		const box: Box = "places" in where ? where : { root: where.root, places: where }
		const { at, cwd } = pathsOf(address, options.cwd)
		const id: Id = `proc:${crypto.randomUUID()}`
		const scope = createScope({ process: at, [NODE]: id }, owner)
		scopes.give(scope, id)
		try {
			s.runWithScope(
				scope,
				() => box.places.commit(addProcess(table, box.root, at, id, headerOf(start))),
			)
		} catch (e) {
			s.teardown(scope)
			if (e instanceof PlacesError && e.code === "already-there") return { refused: "taken", at }
			throw e
		}
		const args = options.args ?? []
		const p: State = { id, at, cwd, scope, box, ended: false, rowed: true }
		const process: Process = { id, at, cwd, scope }
		states.set(process, p)
		s.registerTeardown(scope, () => end(p))
		const attrs: Record<string, unknown> = { ...options.attributes }
		if (options.args !== undefined) attrs[ARGS] = options.args
		attrs[CWD] = cwd
		if (options.pin !== undefined) attrs[PIN] = options.pin
		attrs[STATUS] = PENDING
		s.runWithScope(
			scope,
			() => table.add("attributes", id, createEntry(attrs, headerOf(start))),
		)
		if (body === undefined) return process
		const give = (c: Computer, o?: { run?: boolean }) => {
			statuses.give(c, id)
			if (o?.run) runs?.give(c, id)
		}
		try {
			const done = s.runWithScope(scope, () => body({ ...process, box, args, give }))
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
					() => p.box.places.commit(removeProcess(table, p.box.root, p.at, headerOf(entry))),
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
			runs?.drop(p.id)
		}
	}

	return { start, stop, runs: runs?.read }
}
