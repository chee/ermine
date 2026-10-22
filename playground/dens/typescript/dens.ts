// dens: one running ermine (one scheduler, one table) as the graph sees it. a den is an install's
// node (its id the install's), reached at /system/dens/<name> and at /system/den ("here", in each
// den); the host starts this session's den at boot, a process at /system/session. what it can run
// it offers as nodes under its node (runners, compilers, surfaces), and so may any process it
// runs, under that process's node: attributes are what travels, the value (the live function) is
// this session's alone. start runs a program on a
// runner at a path: the relation of the three, made at start, gone at stop. no lookup, no chain,
// no build, no search: the program given is in the runner's form already
//
//   const den = createDen({ scheduler, table, places, scopes, id: "mac", install, may })
//   // offers made before the first pulse: asks stored while the den was down are answered then
//   den.offer("runners", "javascript",
//     { [TAKES]: "com.netscape.javascript-source", [API]: "ermine.api", [WHERE]: "thread" },
//     apis.run)                                   // @ermine/programs/api's: createProcessAPIs(...).run
//   const p = den.start("/system/den/runners/javascript", "/apps/clock.js", "/work/clock", { args })
//   // { id: "proc:<uuid>", at: ["work", "clock"], cwd: ["work"], scope }, or { refused: ... }
//   const l = den.load("/work/clock/runners/letter", { id, code, type }, { by: p })
//   // { live, release }, or { refused: ... }
//   den.stop(p, "SIGHUP")
//   den.ask({ op: "start", who, runner: "/system/den/runners/javascript", program: { id, hash }, at })
//   den.close()
//
// the rules are in the parts, each answering one question: offers (what is on offer), start (how a
// program runs on a runner), policy (may it), handlers (how it is told), asks (how it is asked
// through the graph), here (where it is), and common (what they share). this file makes the context, makes the parts, and says what a den is
import type { Address, Box } from "@ermine/boxes"
import { type Id, type Path, type Places, PlacesError } from "@ermine/places"
import { createProcesses, type Process, type Processes } from "@ermine/processes/start"
import type { ScopeNodes } from "@ermine/processes/scopes"
import type { Policy } from "@ermine/protect"
import type { Scheduler, Scope } from "@ermine/scheduler"
import type { Sited } from "@ermine/sites"
import type { Table } from "@ermine/table"
import type { Entry } from "@ermine/node/entry"
import { bad, createCtx, ours } from "./common.ts"
import { type Ask, type Asked, createHandlers } from "./handlers.ts"
import { createOffers, type Kind, type Offered } from "./offers.ts"
import { createPolicy } from "./policy.ts"
import {
	createStart,
	type Loaded,
	type NoPermission,
	type Options,
	type Program,
	type Refused,
	type Stopped,
	type Taken,
} from "./start.ts"
import { createHere, type Nodes } from "./here.ts"

ours.add(import.meta.url)

export type { Process }
export { ATTRIBUTE, REASONS, TYPE } from "./common.ts"
export { API, COMPILER_TAKES, GIVES, KIND, runnerOf, SIZE, TAKES, WHERE } from "./offers.ts"
export { DEN, hashOf, PROGRAM, PROGRAM_API, RUNNER } from "./start.ts"
export { DENS, DEVICE, HERE, ID, NAME, SESSION } from "./here.ts"
export { ON } from "./handlers.ts"
export type { Kind, Offered } from "./offers.ts"
export type { Ask, Asked } from "./handlers.ts"
export type { Nodes, Seen } from "./here.ts"
export type {
	Handle,
	Loaded,
	NoPermission,
	Options,
	Program,
	Refused,
	Runnable,
	Runner,
	Start,
	Stopped,
	Taken,
} from "./start.ts"

// a node, and the path it was reached by (none: by id alone)
export type Place = { readonly id: Id; readonly at?: Path }
export type Setup = {
	scheduler: Scheduler
	table: Table
	// the host's: its contributors start with processes(root) (and away(root), for away)
	places: Places
	scopes: Pick<ScopeNodes, "give">
	// a name: the step under /system/dens, the den's channel name
	id: string
	// whose den it is: its node's id (installs'); none: a fresh id, a den new each start
	install?: { readonly id: Id }
	name?: string
	device?: unknown
	// none: local yes; an ask: no "no policy"
	may?: Policy
	// none: places.commit
	commit?: (changed: readonly Entry<unknown>[]) => void
	sites?: Pick<Sited, "createScope">
	// how a pulse is asked for: f run soon, once (none: queueMicrotask), as ermine/api's
	schedule?: (f: () => void) => void
}
export type Den = {
	// the name given (setup.id), and the den's node id (the install's; none given: a fresh one)
	readonly id: string
	readonly node: Id
	// this session's running den, at /system/session
	readonly process: Process
	// the owner: torn down, every process goes
	readonly scope: Scope
	readonly scheduler: Scheduler
	readonly table: Table
	readonly places: Places
	offer: (
		kind: Kind,
		name: string,
		attributes?: Readonly<Record<string, unknown>>,
		live?: unknown,
		by?: Process | Id,
	) => Offered | Taken | Stopped
	withdraw: (offer: Offered | Id) => void
	start: (runner: Address, program: Address | Program, at: Address, options?: Options) =>
		| Process
		| Refused
	load: (
		runner: Address,
		program: Address | Program,
		options?: { by?: Process | Id; box?: Box },
	) => Loaded | Refused
	stop: (p: Process | Id, reason?: unknown) => NoPermission | undefined
	ask: (a: Ask) => Asked
	find: (id: Id) => Process | undefined
	// the processes it started, running, in start order (not its own)
	processes: () => readonly Process[]
	offers: () => readonly Offered[]
	nodes: (options?: { processes?: boolean }) => Nodes
	close: (reason?: unknown) => void
	runs: Processes["runs"]
}

export function createDen(setup: Setup): Den {
	if (bad(setup.id)) throw new PlacesError("not-a-name", String(setup.id))
	const c = createCtx(setup)
	const processes = createProcesses({
		scheduler: c.s,
		table: c.table,
		places: c.host,
		scopes: c.scopes,
		sites: setup.sites,
		owner: c.owner,
		ours: [...ours],
	})
	const permit = createPolicy(c.table, setup.may)
	const offers = createOffers(c)
	const life = createStart(c, { processes, permit })
	// the den's own (its node, or its session's process): here's; any other: start's
	const stop = (x: Process | Id, reason?: unknown) => {
		const id = typeof x === "object" ? x.id : x
		return id === c.node || id === here.self.id ? here.stop(reason) : life.stop(x, reason)
	}
	const handlers = createHandlers(c, { start: life, permit, stop })
	const here = createHere(c, setup, { processes, methods: handlers.methods, permit })
	const { running, byId } = c
	const den: Den = {
		id: setup.id,
		node: c.node,
		process: here.self,
		scope: c.owner,
		scheduler: c.s,
		table: c.table,
		places: c.places,
		offer: offers.offer,
		withdraw: offers.withdraw,
		start: life.start,
		load: life.load,
		stop,
		ask: handlers.ask,
		find: (id) => {
			const p = byId.get(id)
			return p === undefined || p.ended ? undefined : p.process
		},
		processes: () => running.flatMap((p) => p.process === undefined ? [] : [p.process]),
		offers: () =>
			[...c.offers.values()].map(({ id, at, kind, name, by }) => ({ id, at, kind, name, by })),
		nodes: here.nodes,
		close: here.close,
		runs: processes.runs,
	}
	c.den = den
	return den
}
