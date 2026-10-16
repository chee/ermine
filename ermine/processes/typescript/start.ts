// start: a process's life, at a path in a box or plain places (the root is the outermost box), and
// its stop. chee 10-15: "the process is a scheduler scope with a path. this is good"; "a process
// isn't in /work, it's at /work/clock"; "a process exists in one place and has 1 path"; "i think
// process and the process api are ermine/ but programs actually arent". what runs in a process is
// its starter's: this knows no programs, chains, loaders, builds or types
//
//   const processes = createProcesses({ scheduler, table, places, scopes })
//   const p = processes.start(b, "/clock", { args, cwd, pin }, (inside) => {
//     inside.give(computer)                // its status on the process's node
//     return () => {}                      // called at its stop
//   })
//   // { id: "proc:<uuid>", at: ["clock"], cwd: [], scope }, or { refused: "taken", at: ["clock"] }
//   processes.stop(p)
//
// start(where, at, { args, cwd, pin }, body): where a box ({ root, places }: ermine/boxes) or places
// (its root the box's, {root: places.root, places}); at a path from that root, names or a string
// (boxes' inside: "." here, ".." back one, at the root staying there); cwd the same, from the same
// root, the process's working folder (none: the folder at is in; pathsOf). refused, nothing made:
//   taken: a process at the path, above it or under it (addProcess's already-there)
// else:
//   1. a scope, createScope([["process", at]]) under the owner, and its node (scope nodes' give:
//      proc:<uuid>). made through setup.sites when given (ermine/sites), the host's, with this file
//      in its ours (and the files of whoever starts through this: their ours)
//   2. the row: addProcess at the root's trie at the path, committed to the places given (a box's
//      places shares its commit with the host's: places' view)
//   3. on the node's attributes: ermine.process.args (given), ermine.process.cwd, ermine.process.pin
//      (given: what was chosen, to show and replay), and status.ts' status, PENDING (mine, open: a
//      process is pending until a computer given to it lands)
//   4. body, with the process's scope open, so what it makes is the scope's and goes at stop. it is
//      given the process, its box and args, and give(computer, { run }): the computer's status on
//      the process's node (status.ts), and with run its latest run too (runs.ts: what it read and
//      wrote), when the places given name reads (describe, watchAll). a function body gives back:
//      called at the stop
//
// stop(p): what body gave back (with the scope open), the row taken out, then the scope torn down:
// its computers go, and its node's entries (scope nodes'). the scope torn down another way (a scope
// above it): the same, but its computers go first. stopped twice: nothing. every step runs; the
// first error is thrown after
//
// writes, each with the process's scope open (its info [["process", at]] after the host's), its
// site the call into start or stop (outside this file and setup.ours): the attributes entry made (a
// table event), the row (committed to the places it runs in); status.ts' to the places given at
// setup (the host's)
//
// open (chee): pid("clock") from chee's start(lookup("clock"), ["work", pid("clock")]) is not built:
// at is a plain path. mine, open: args as strings; cwd from the root as at is, written always (its
// default too), never checked to be there
import createEntry, { type ChangeHeader } from "@ermine/node/entry"
import { type Address, type Box, inside } from "@ermine/boxes"
import { type Id, type Path, type Places, PlacesError } from "@ermine/places"
import { getWho } from "@ermine/places/header"
import { createStatus, STATUS } from "@ermine/places/status"
import { createRuns } from "@ermine/places/runs"
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
	// scope nodes (scopes.ts)
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
	const owner = setup.owner ?? createScope([["processes", "start"]])
	const statuses = createStatus({ places, table, scheduler: s })
	const { describe, watchAll } = places
	const runs = describe && watchAll
		? createRuns({ places: { commit: places.commit, describe, watchAll }, table, scheduler: s })
		: undefined
	s.registerTeardown(owner, () => {
		statuses.stop()
		runs?.stop()
	})
	const states = new WeakMap<Process, State>()

	// the header of a write made now, its site the call into entry (start or stop), as boxes' is
	// core candidate (places' header.ts): createChangeHeader taking the function called
	function headerOf(entry?: unknown): ChangeHeader {
		const who = getWho(s)
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
		const scope = createScope([["process", at]], owner)
		const id = scopes.give(scope, `proc:${crypto.randomUUID()}`)
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
		const attrs: Record<string, unknown> = {}
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
		}
	}

	return { start, stop }
}
