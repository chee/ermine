// software: running programs on runners, on processes. what can run here is offered as nodes
// (offers.ts); a program runs on one of them as a process (run.ts). no policy (whoever calls may),
// no den, no asking: what decides who may run what, and what takes work from elsewhere, is a
// program someone starts. processes (@ermine/processes) is a process's life; this builds on it.
// programs (satisfy, openwith, building through compilers) builds on this
//
//   const software = createSoftware({ scheduler, table, places, scopes, scope })
//   const js = software.offer(session, "runners", "javascript",
//     { [TAKES]: "com.netscape.javascript-source", [API]: "ermine.api" }, apis.run)
//   const p = software.run("/system/den/runners/javascript", "/apps/clock.js", "/work/clock")
//   // a Process, or { refused: ... }
//   software.run({ id: RUN, live }, { id: CAT, build }, "/work/cat")   // carried: programs' way
//   const l = software.load("/work/clock/runners/letter", { id, code, type }, { by: p })
//   // { live, release }: one hold; the same program on the same runner again shares the load
//   software.stop(p, "SIGHUP")
//
// an owner: a node things are offered under, with a scope they go with: a process (run here or
// not), or an install's node (stored: what is offered under it stays when its scope goes, only the
// live values go, as an install's does across sessions). made the first time it is named
// writes: with the caller's scope open, or the owner's; each one's site the first call outside
// these files
import type { Address, Box } from "@ermine/boxes"
import { type Id, type Path, type Places, PlacesError } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { createProcesses, type Process, type Processes } from "@ermine/processes/start"
import type { ScopeNodes } from "@ermine/processes/scopes"
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { Sited } from "@ermine/sites"
import type { Table } from "@ermine/core/table"
import { type Ctx, holder, ours, type Owner, type Place, through } from "./common.ts"
import { createOffers, type Kind, type Offered } from "./offers.ts"
import {
	type Carried,
	createRun,
	type Handle,
	type Loaded,
	type LoadOptions,
	type Options,
	type Program,
	type Refused,
} from "./run.ts"

ours.add(import.meta.url)

export type {
	Carried,
	Handle,
	Kind,
	Loaded,
	LoadOptions,
	Offered,
	Options,
	Place,
	Program,
	Refused,
}
export { ATTRIBUTE, TYPE } from "./common.ts"
// the files of software, for a host's sites (@ermine/sites' ours): a scope's site is past them
export { ours } from "./common.ts"
export { API, COMPILER_TAKES, GIVES, KIND, runnerOf, SIZE, TAKES, WHERE } from "./offers.ts"
export { hashOf, PROGRAM, PROGRAM_API, REASONS, RUNNER } from "./run.ts"
export type { Runnable, Runner, Start } from "./run.ts"

export type Setup = {
	scheduler: Scheduler
	table: Table
	// where runners and programs are found from (and processes run, unless a box is given)
	places: Places
	scopes: Pick<ScopeNodes, "give">
	// what runs goes under it (on a runner offered here, under its offer, under its owner's scope
	// too): torn down, everything run here goes
	scope: Scope
	sites?: Pick<Sited, "createScope">
	// how a pulse is asked for: f run soon, once (none: queueMicrotask)
	schedule?: (f: () => void) => void
	// files a write's site skips beside software's: a library's over it (programs'), so the site is
	// its caller's
	ours?: Iterable<string>
	// a new process's node id (processes' Setup.id). none: processes' own
	id?: () => Id
}

export type Software = {
	offer: (
		by: Place,
		kind: Kind,
		name: string,
		attributes?: Readonly<Record<string, unknown>>,
		live?: unknown,
	) => Offered | { readonly refused: "taken"; readonly at: Path }
	withdraw: (offer: Offered | Id) => void
	run: (
		runner: Address | Carried,
		program: Address | Program,
		at: Address,
		options?: Options,
	) => Process | Refused
	load: (runner: Address | Carried, program: Address | Program, options: LoadOptions) =>
		| Loaded
		| Refused
	stop: (p: Process | Id, reason?: unknown) => void
	// the processes it runs, in start order; the offers it holds
	running: () => readonly Process[]
	offers: () => readonly Offered[]
	// a process's latest first run by its node's id (processes'); none without places' describe
	// and watchAll
	runs?: Processes["runs"]
}

export function createSoftware(setup: Setup): Software {
	const { scheduler: s, table, places } = setup
	const schedule = setup.schedule ?? queueMicrotask
	const version = {}
	const queued = { now: false }
	const owners = new Map<Id, Owner>()
	// what a write's site skips: software's files, and the library's over it
	const skip = new Set([...ours, ...setup.ours ?? []])
	const c: Ctx = {
		s,
		table,
		home: { root: places.root, places } as Box,
		scopes: setup.scopes,
		// its own processes, so a write's site skips these files too
		processes: createProcesses({
			scheduler: s,
			table,
			places,
			scopes: setup.scopes,
			sites: setup.sites,
			owner: setup.scope,
			ours: skip,
			id: setup.id,
		}),
		scope: setup.scope,
		createScope: setup.sites?.createScope ?? s.createScope,
		commit: (changed) => {
			if (changed.length) places.commit(changed)
		},
		headerOf: () => createChangeHeader(s, undefined, [...skip, ...through]),
		version,
		changed: () => void s.mark([version]),
		later() {
			if (queued.now || s.getRun() !== undefined) return
			queued.now = true
			schedule(() => {
				queued.now = false
				s.pulse()
			})
		},
		running: [],
		byId: new Map(),
		offers: new Map(),
		loads: new Map(),
		// a process run here is its own owner; any other place, one made the first time, gone with
		// its scope
		ownerOf(by: Place): Owner {
			const run = c.byId.get(by.id)
			if (run !== undefined && !run.ended) return run
			let o = owners.get(by.id)
			if (o !== undefined && o.scope.state === "alive") return o
			if (by.scope.state !== "alive") throw new PlacesError("nothing-there", String(by.id))
			o = {
				...by,
				under: by.scope,
				box: c.home,
				args: [],
				cwd: by.at.slice(0, -1),
				folders: new Map(),
				offers: [],
				loads: [],
			}
			owners.set(by.id, o)
			holder(s, o)
			const made = o
			s.registerTeardown(by.scope, () => {
				if (owners.get(by.id) === made) owners.delete(by.id)
			})
			return o
		},
	}
	const offers = createOffers(c)
	const run = createRun(c)
	return {
		offer: offers.offer,
		withdraw: offers.withdraw,
		run: run.run,
		load: run.load,
		stop: run.stop,
		runs: c.processes.runs,
		running: () => {
			s.track(version)
			return c.running.flatMap((p) => p.process === undefined ? [] : [p.process])
		},
		offers: () => {
			s.track(version)
			return [...c.offers.values()].map(({ id, at, kind, name, by }) => ({
				id,
				at,
				kind,
				name,
				by,
			}))
		},
	}
}
