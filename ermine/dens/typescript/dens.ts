// dens: one running ermine (one scheduler, one table) as the graph sees it. a den is a process the
// host starts at boot: its node at /system/dens/<id>, placed again at /system/den (a second leaf of
// the same id: "here", in each den). what it can run it offers as nodes under its node (runners,
// compilers, surfaces), and so may any process it runs, under that process's node: attributes are
// what travels, the value (the live function) is this den's alone. start runs a program on a
// runner at a path: the relation of the three, made at start, gone at stop. no lookup, no chain,
// no build, no search: the program given is in the runner's form already
//
//   const den = createDen({ scheduler, table, places, scopes, id: "mac-7f3a", may })
//   den.offer("runners", "javascript",
//     { [TAKES]: "com.netscape.javascript-source", [API]: "ermine.api", [WHERE]: "thread" },
//     context.run)                                // ermine/api's: createProcessContext(...).run
//   const p = den.start("/system/den/runners/javascript", "/apps/clock.js", "/work/clock", { args })
//   // { id: "proc:<uuid>", at: ["work", "clock"], cwd: ["work"], scope }, or { refused: ... }
//   const l = den.load("/work/clock/runners/letter", { id, code, type }, { by: p })
//   // { live, release }, or { refused: ... }
//   den.stop(p, "SIGHUP")
//   den.ask({ op: "start", who, runner: "/system/den/runners/javascript", program: { id, hash }, at })
//   den.close()
//
// createDen, a scope open: an owner scope { den: id } under it; processes' start at
// /system/dens/<id> under the owner, attributes { ermine.type: ermine.den, ermine.den.id,
// .name?, .device? }; in its body: its children { on }, the folder on { start, stop } (method
// nodes: on/start's value (body) => start's answer, on/stop's (body) => stop's), and /system/den
// (addProcess, the same id). its status: gone at the first pulse. id not a name: PlacesError
// not-a-name; /system/dens/<id> or /system/den taken: already-there
// offer(kind, name, attributes?, live?, by?): a node <owner id>/<kind>/<name> in the folder
// <owner id>/<kind> (made at the first offer of that kind, upserted into the owner's children:
// by, a process of this den's; none: the den), its attributes as given and ermine.type
// ermine.runner | ermine.compiler | ermine.surface over them, its value live (none: no value).
// a name taken (offered, or entries at its id already): refused taken, nothing made; not a name:
// PlacesError not-a-name; by no running process of this den's: PlacesError nothing-there; closed:
// refused stopped.
// withdraw: its users stopped (newest first, "withdrawn"), its name out, its node gone. an owner's
// stop withdraws its offers first, its users stopped "runner-stopped"
// a runner (a runner node's value): { start(code, start) → handle, load?(code, start) → live,
// api?(start) → api }, or a function, its start (its own load and api too, if it has them: a
// function is shorthand for { start }). start is a Start: { box, places, process: { id, at, args,
// cwd }, scheduler, table, scope, den }. what the program gets is the runner's: this makes no api
// (no ermine/api here); a runner over ermine/api builds it from context.createAPI(start), api?
// saying how (ermine/api's run is one). programs' runners are functions given the Start where
// programs gives an api (realms.run: createRealms({ createAPI }); dlopen's: its pointer given it).
// its limits are the runner's too: a loop budget, fuel, a cost a call, by wrapping what it starts or
// loads; nothing here counts
// start(runner, program, at, { args, cwd, box, pin }): runner from the den's root; program an
// address from where's root (where: box, else the den's places) or { id, hash?, type?, api?,
// code? }. refused, nothing made, the first that holds:
//   stopped        the den is closed
//   not-a-runner   nothing at runner, or its ermine.type is not ermine.runner
//   not-there      no program node, or no value; by id: none, or not the hash given; code given:
//                  not the hash given
//   wrong-form     the program's ermine.type (code given: type) is not the runner's
//                  ermine.runner.takes (both strings, exact); or it names an api
//                  (ermine.program.api; code given: api) the runner's ermine.runner.api is not
//   not-a-runner   the runner's value is no runner here (no start)
//   no-permission  the policy asked { who: the scope open, op: "start", target the runner },
//                  then { op: "read", target the program's value } (not for code given): no, or
//                  pending
//   taken          a process at, above or under at (processes')
// else processes' start with ermine.type ermine.process, ermine.process.runner { id, at },
// .program { id, at?, hash? } (hash: of its value; none: a live value), .den { id, at }; the code
// read once now; at the first pulse, a one-shot effect, the process's scope open: start(code,
// { box, places, process: { id, at, args, cwd }, scheduler, table, scope, den }). a handle: kept;
// a throw, a rejected promise: the status. a start made outside a run (an ask's too) asks for a
// pulse (setup.schedule; none: queueMicrotask, as ermine/api's), so a start from a DOM callback runs
// with nothing else pulsing
// load(runner, program, { by?, box? }): the program made live on the runner with no process: its
// load(code, start), start by's facts (by: a running process of this den's; none: the den's own,
// let go at its close), the scope open (none: by's). checked as start is, in its order (no path, so never taken; the
// policy asked start on the runner, read on the program); a runner with no load: not-a-runner.
// what load throws: thrown. { live, release }: live held by by, let go (live[Symbol.dispose], if
// it has one) at release or at by's stop, after its handle's, newest first. by no running
// process: PlacesError nothing-there. made outside a run: a pulse asked for. no process: what
// live does is its caller's, a call of it a run of the caller's memo or effect, so its cost is
// that run's time and its throw that run's error and status (ermine/api's runs)
// stop(p, reason?): asked { op: "stop", target p's node } (refused: still running); the users of
// its offers stopped ("runner-stopped"), its handle's stop(reason) (ermine/api's: its teardowns
// told reason), its loads let go, the row out, the node gone.
// twice, or not this den's: nothing. p the den's own: close(reason). the reason is not written
// ask(a): another den's: as start or stop, its who given (device: the transport's). no policy:
// refused no "no policy". stop: of a process this den started; else not-there. a start's fields
// (an ask's, on/start's body's) as given, untyped: runner and at no address: []; program neither
// an address nor a map: { id: "" } (an id that is no string: ""); a step that is no string, args
// given that are no list of strings, a cwd given that is no address: PlacesError not-a-name
// close(reason = "den-stopped"): every process stopped, newest first, each handle given reason;
// the den's rows last. after it: start, load, ask, offer refused stopped
// nodes({ processes }): what others see, tracked; status as "pending" | { failed: message }, an
// attribute with no encoding left out; children: only those dens wrote
// unplace or move never stops a process: its row is in the process part, not in children
// writes: with the owner's scope open (the den, its offers) or the process's. policy reads: the
// table, untracked
// open: a promise never settling; /system/den inside a box; boxed processes in nodes()
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import { CborError, encode, type Value } from "@ermine/encoding/cbor"
import { hash } from "@ermine/encoding/hash"
import { type Address, type Box, inside } from "@ermine/boxes"
import { at as valueAt, type Id, type Path, type Places, PlacesError } from "@ermine/places"
import { get } from "@ermine/places/lib"
import { createChangeBase, NODE } from "@ermine/places/header"
import { STATUS } from "@ermine/places/status"
import { upsert } from "@ermine/places/upsert"
import { addProcess, removeProcess } from "@ermine/processes"
import { createProcesses, type Inside, type Process, type Processes } from "@ermine/processes/start"
import type { ScopeNodes } from "@ermine/processes/scopes"
import { type Answer, may as asking, no, type Policy, type Target } from "@ermine/protect"
import { PENDING, type Scheduler, SchedulerError, type Scope } from "@ermine/scheduler"
import { isPromise } from "@ermine/scheduler/helpers"
import type { Sited } from "@ermine/sites"
import type { Key, Table } from "@ermine/table"
import { capture } from "@ermine/util/stacktrace"

export type { Process }

// where dens are, and here: the one place each path is said
export const DENS: Path = ["system", "dens"]
export const HERE: Path = ["system", "den"]
// the folder a den's methods are in, and their names
export const ON = "on"

// the one field everything matches on (@ermine/types' ATTRIBUTE)
export const ATTRIBUTE = "ermine.type"
export const TYPE = {
	den: "ermine.den",
	process: "ermine.process",
	runners: "ermine.runner",
	compilers: "ermine.compiler",
	surfaces: "ermine.surface",
} as const
export const ID = "ermine.den.id"
export const NAME = "ermine.den.name"
export const DEVICE = "ermine.den.device"
export const TAKES = "ermine.runner.takes"
export const API = "ermine.runner.api"
export const WHERE = "ermine.runner.where"
export const COMPILER_TAKES = "ermine.compiler.takes"
export const GIVES = "ermine.compiler.gives"
export const KIND = "ermine.surface.kind"
export const SIZE = "ermine.surface.size"
export const PROGRAM_API = "ermine.program.api"
export const RUNNER = "ermine.process.runner"
export const PROGRAM = "ermine.process.program"
export const DEN = "ermine.process.den"
export const REASONS = {
	withdrawn: "withdrawn",
	runner: "runner-stopped",
	den: "den-stopped",
} as const

export type Kind = "runners" | "compilers" | "surfaces"
const KINDS: readonly Kind[] = ["runners", "compilers", "surfaces"]
// a node, and the path it was reached by (none: by id alone)
export type Place = { readonly id: Id; readonly at?: Path }
// what a runner gives back; @ermine/programs/start's Handle is one
export type Handle = { readonly stop: (reason?: unknown) => unknown }
// what a runner is handed: the start's facts (@ermine/programs/start's Start, and the den). a
// load's: its by's
export type Start = {
	readonly box: Box
	readonly places: Places
	readonly process: {
		readonly id: Id
		readonly at: Path
		readonly args: readonly string[]
		readonly cwd: Path
	}
	readonly scheduler: Scheduler
	readonly table: Table
	readonly scope: Scope
	readonly den: Den
}
// a live runner: start a process's program; load, a program live with no process; api, what its
// programs get (the runner's, over context.createAPI(start) for ermine/api's)
export type Runner = {
	readonly start: (code: unknown, start: Start) => Handle | PromiseLike<Handle> | void
	readonly load?: (code: unknown, start: Start) => unknown
	readonly api?: (start: Start) => unknown
}
// what a runner node may hold: a Runner, or a function, its start (with its own load and api, if
// it has them); @ermine/programs/start's Runner is one (realms.run, createDlopen's), ermine/api's run
// both
export type Runnable = Runner | (Runner["start"] & Partial<Pick<Runner, "load" | "api">>)
// a load: the live form, and its letting go now (else at its holder's stop)
export type Loaded = { readonly live: unknown; readonly release: () => void }
// a program by id (its hash, when given, must be its value's), or carried (code: run as it is)
export type Program = {
	readonly id: Id
	readonly hash?: string
	readonly type?: string
	readonly api?: string
	readonly code?: unknown
}
export type Setup = {
	scheduler: Scheduler
	table: Table
	// the host's: its contributors start with processes(root) (and away(root), for away)
	places: Places
	scopes: Pick<ScopeNodes, "give">
	// a name: the step under /system/dens, the den's channel name
	id: string
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
export type Offered = {
	readonly id: Id
	readonly at: Path
	readonly kind: Kind
	readonly name: string
	// the owner's node id: the den's, or a process's
	readonly by: Id
}
export type Stopped = { readonly refused: "stopped" }
export type Taken = { readonly refused: "taken"; readonly at: Path }
export type NoPermission = {
	readonly refused: "no-permission"
	readonly op: "start" | "read" | "stop"
	readonly answer: { readonly answer: "no"; readonly reason: string } | {
		readonly answer: "pending"
	}
}
export type Refused =
	| Stopped
	| Taken
	| NoPermission
	| { readonly refused: "not-a-runner"; readonly runner: Path }
	// program: its path (an address given) or its id (a Program given)
	| { readonly refused: "not-there"; readonly program: Path | Id }
	| { readonly refused: "not-there"; readonly process: Id }
	| {
		readonly refused: "wrong-form"
		// each field only when a string
		readonly program: { readonly type?: string; readonly api?: string }
		readonly runner: { readonly takes?: string; readonly api?: string }
	}
export type Options = {
	args?: readonly string[]
	cwd?: Address
	// where it runs, and where program and at are from; none: the den's places
	box?: Box
	// ermine.process.pin, as processes' start writes it
	pin?: unknown
}
export type Ask =
	| {
		readonly op: "start"
		readonly who: unknown
		readonly runner: Address
		readonly program: Program
		readonly at: Address
		readonly args?: readonly string[]
		readonly cwd?: Address
	}
	| { readonly op: "stop"; readonly who: unknown; readonly process: Id; readonly reason?: unknown }
// a start's: { id, at }; a stop's: {}; or the refusal
export type Asked = { readonly id: Id; readonly at: Path } | Record<never, never> | Refused
// a den's description as others see it (away.ts publishes it)
export type Seen = {
	readonly attributes?: Readonly<Record<string, unknown>>
	readonly children?: Readonly<Record<string, Id>>
}
export type Nodes = {
	readonly den: Id
	readonly nodes: Readonly<Record<Id, Seen>>
	// none: left out
	readonly processes?: readonly { readonly id: Id; readonly at: Path }[]
}
export type Den = {
	// the name given (setup.id), and the den's node id
	readonly id: string
	readonly node: Id
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

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// core candidate (@ermine/encoding): hex of a value's hash; no encoding: undefined (programs' hashOf)
export function hashOf(v: unknown): string | undefined {
	try {
		return hex(hash(v as Value))
	} catch (e) {
		if (e instanceof CborError) return undefined
		throw e
	}
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v)

const bad = (name: unknown) =>
	typeof name !== "string" || name === "" || name === "." || name === ".." || name === "/"

const isAddress = (x: unknown): x is Address => typeof x === "string" || Array.isArray(x)

const isNames = (x: unknown): x is string[] =>
	Array.isArray(x) && x.every((s) => typeof s === "string")

// whether a value has an encoding (what travels)
function encodes(v: unknown): boolean {
	try {
		encode(v as Value)
		return true
	} catch (e) {
		if (e instanceof CborError) return false
		throw e
	}
}

// the fields that are strings
function strings<K extends string>(o: Record<K, unknown>): Partial<Record<K, string>> {
	const out: Partial<Record<K, string>> = {}
	for (const k in o) if (typeof o[k] === "string") out[k] = o[k] as string
	return out
}

const STOPPED: Stopped = { refused: "stopped" }

// a den's node or a process's: where it runs, its args and cwd; the folders of what it offers, by
// kind, and its offers in order; the loads it holds, in order
type Owner = {
	readonly id: Id
	readonly at: Path
	readonly scope: Scope
	readonly box: Box
	readonly args: readonly string[]
	readonly cwd: Path
	readonly folders: Map<Kind, { readonly id: Id; readonly scope: Scope }>
	readonly offers: Offer[]
	readonly loads: Held[]
}

// a load's live form, held until let go
type Held = { readonly live: unknown; released: boolean }

// an offer: its node's scope, and the processes running on it, in start order
type Offer = Offered & {
	readonly owner: Owner
	readonly scope: Scope
	readonly users: Running[]
	gone: boolean
}

// a process this den started: processes' (once start gives it back), the offer it runs on, its
// handle once the runner gave one; ended (its handle stopped, or to be as its promise lands), with
// the reason given (told: by a stop)
type Running = Owner & {
	process?: Process
	readonly on?: Offer
	handle?: Handle
	ended: boolean
	told: boolean
	reason?: unknown
}

export function createDen(setup: Setup): Den {
	const { scheduler: s, table, places, scopes } = setup
	if (bad(setup.id)) throw new PlacesError("not-a-name", String(setup.id))
	const createScope = setup.sites?.createScope ?? s.createScope
	const ours = new Set([import.meta.url])
	const host: Places = setup.commit === undefined ? places : { ...places, commit: setup.commit }
	const commit = (changed: readonly Entry<unknown>[]) => host.commit(changed)
	const home: Box = { root: places.root, places: host }
	const owner = createScope({ den: setup.id })
	const processes = createProcesses({
		scheduler: s,
		table,
		places: host,
		scopes,
		sites: setup.sites,
		owner,
		ours: [import.meta.url],
	})
	const policy = setup.may === undefined
		? undefined
		: asking(setup.may, (part, id, path) => valueAt(table.get(part as Key, id)?.value, path ?? []))

	// the processes running, in start order, and by id; the offers by id; what nodes() reads
	const running: Running[] = []
	const byId = new Map<Id, Running>()
	const offers = new Map<Id, Offer>()
	const version = {}
	let closed = false
	// the reason the den's own process goes with, said by close
	let pending: unknown = REASONS.den

	// the header of a write made now, its site the first call outside this file
	function headerOf(): ChangeHeader {
		const who = createChangeBase(s)
		if (who === undefined) throw new SchedulerError("unscoped", "a write with no scope open")
		const h: ChangeHeader = { ...who, time: Math.floor(Date.now() / 1000) }
		const site = capture(ours)
		if (site) h.external = [site]
		return h
	}

	// f with the scope open; torn down already (its own teardown): open, as it is
	const within = <T>(o: Scope, f: () => T): T => o.state === "alive" ? s.runWithScope(o, f) : f()
	const changed = () => void s.mark([version])

	// one pulse asked for outside a run, however many ask (in a run: one is under way)
	let queued = false
	const schedule = setup.schedule ?? queueMicrotask
	function later() {
		if (queued || s.getRun() !== undefined) return
		queued = true
		schedule(() => {
			queued = false
			s.pulse()
		})
	}

	// the den's own node as an owner: its folders and offers
	let mine!: Owner
	const attributes: Record<string, unknown> = { [ATTRIBUTE]: TYPE.den, [ID]: setup.id }
	if (setup.name !== undefined) attributes[NAME] = setup.name
	if (setup.device !== undefined) attributes[DEVICE] = setup.device
	const at = [...DENS, setup.id]
	let made: Process | { refused: "taken" }
	try {
		made = processes.start(home, at, { attributes }, (inside) => {
			mine = {
				id: inside.id,
				at,
				scope: inside.scope,
				box: home,
				args: inside.args,
				cwd: inside.cwd,
				folders: new Map(),
				offers: [],
				loads: [],
			}
			methods(inside)
			commit(addProcess(table, home.root, HERE, inside.id, headerOf()))
			// its status gone at the first pulse
			const first = s.createEffect(() => true, () => s.teardown(first))
			inside.give(first)
			return () => ended()
		})
	} catch (e) {
		s.teardown(owner)
		throw e
	}
	if ("refused" in made) {
		s.teardown(owner)
		throw new PlacesError("already-there", setup.id)
	}
	const self = made
	const node = self.id

	// the den's children { on }, the folder on { start, stop }, each a method node
	function methods(inside: Inside) {
		const folder: Id = `${String(inside.id)}/${ON}`
		commit(upsert(table, "children", inside.id, [ON], folder, headerOf()))
		const on = createScope({ den: ON, [NODE]: folder }, inside.scope)
		scopes.give(on, folder)
		const fns: Record<string, (body: unknown) => unknown> = { start: onStart, stop: onStop }
		const ids: Record<string, Id> = {}
		for (const [name, fn] of Object.entries(fns)) {
			const id: Id = `${String(folder)}/${name}`
			const m = createScope({ den: `${ON}/${name}`, [NODE]: id }, on)
			scopes.give(m, id)
			s.runWithScope(m, () => table.add("value", id, createEntry<unknown>(fn, headerOf())))
			ids[name] = id
		}
		s.runWithScope(on, () => table.add("children", folder, createEntry(ids, headerOf())))
	}

	// on/start: start's answer, the body's runner, program and at
	function onStart(body: unknown): unknown {
		const b = isMap(body) ? body : {}
		const { runner, program, at, options } = shaped(b)
		if (b.pin !== undefined) options.pin = b.pin
		const r = start(runner, program, at, options)
		return "refused" in r ? r : { id: r.id, at: r.at }
	}

	// a start's fields as an untyped caller gives them (another den's ask, on/start's body): runner
	// and at no address: []; program neither an address nor a map: { id: "" }; a step that is no
	// string, args given that are no list of strings, a cwd given that is no address: not-a-name
	function shaped(b: Record<string, unknown>) {
		const steps = (x: unknown): Address | undefined => {
			if (typeof x === "string") return x
			if (!Array.isArray(x)) return undefined
			if (isNames(x)) return x
			throw new PlacesError("not-a-name", String(x.find((s) => typeof s !== "string")))
		}
		const options: Options = {}
		if (b.args !== undefined) {
			if (!isNames(b.args)) throw new PlacesError("not-a-name", "args")
			options.args = b.args
		}
		if (b.cwd !== undefined) {
			const cwd = steps(b.cwd)
			if (cwd === undefined) throw new PlacesError("not-a-name", "cwd")
			options.cwd = cwd
		}
		const program: Address | Program = isMap(b.program)
			? b.program as Program
			: steps(b.program) ?? { id: "" }
		return { runner: steps(b.runner) ?? [], program, at: steps(b.at) ?? [], options }
	}

	// on/stop: stop's answer, the body's process and reason
	function onStop(body: unknown): unknown {
		const b = isMap(body) ? body : {}
		return stop(b.process as Id, b.reason) ?? {}
	}

	// the den's own process going: its offers withdrawn (their users stopped with the den's
	// reason), its loads let go, then here out. every step runs; the first error is thrown after
	function ended() {
		closed = true
		let failed: { error: unknown } | undefined
		for (const o of [...mine.offers].reverse()) {
			try {
				retract(o, pending)
			} catch (error) {
				failed ??= { error }
			}
		}
		const loose = letGo(mine)
		if (loose) failed ??= loose
		try {
			commit(removeProcess(table, home.root, HERE, headerOf()))
		} catch (e) {
			if (!(e instanceof PlacesError && e.code === "nothing-there")) failed ??= { error: e }
		}
		changed()
		if (failed) throw failed.error
	}

	// the policy asked; none: yes here, no for another den's
	function permit(who: unknown, op: string, target: Target, remote: boolean): Answer {
		if (policy === undefined) return remote ? no("no policy") : { answer: "yes" }
		return policy({ who, op, target })
	}

	const refuse = (op: NoPermission["op"], a: Answer): NoPermission => ({
		refused: "no-permission",
		op,
		answer: a.answer === "no" ? { answer: "no", reason: a.reason } : { answer: "pending" },
	})

	function ownerOf(by: Process | Id | undefined): Owner {
		const id = by === undefined ? node : typeof by === "object" ? by.id : by
		if (id === node) return mine
		const p = byId.get(id)
		if (p === undefined || p.ended) throw new PlacesError("nothing-there", String(id))
		return p
	}

	function offer(
		kind: Kind,
		name: string,
		attributes: Readonly<Record<string, unknown>> = {},
		live?: unknown,
		by?: Process | Id,
	): Offered | Taken | Stopped {
		if (closed) return STOPPED
		if (!KINDS.includes(kind)) throw new TypeError(`not a kind of offer: ${String(kind)}`)
		if (bad(name)) throw new PlacesError("not-a-name", String(name))
		const o = ownerOf(by)
		const id: Id = `${String(o.id)}/${kind}/${name}`
		const at = [...o.at, kind, name]
		if (offers.has(id) || table.get(id).length > 0) return { refused: "taken", at }
		let folder = o.folders.get(kind)
		if (folder === undefined) {
			const fid: Id = `${String(o.id)}/${kind}`
			const scope = createScope({ offers: kind, [NODE]: fid }, o.scope)
			scopes.give(scope, fid)
			folder = { id: fid, scope }
			o.folders.set(kind, folder)
			s.runWithScope(scope, () => commit(upsert(table, "children", o.id, [kind], fid, headerOf())))
		}
		const scope = createScope({ offer: name, [NODE]: id }, folder.scope)
		scopes.give(scope, id)
		const made: Offer = { id, at, kind, name, by: o.id, owner: o, scope, users: [], gone: false }
		offers.set(id, made)
		o.offers.push(made)
		s.registerTeardown(scope, () => gone(made))
		const fid = folder.id
		s.runWithScope(scope, () => {
			const attrs: Record<string, unknown> = { ...attributes, [ATTRIBUTE]: TYPE[kind] }
			table.add("attributes", id, createEntry(attrs, headerOf()))
			if (live !== undefined) table.add("value", id, createEntry<unknown>(live, headerOf()))
			commit(upsert(table, "children", fid, [name], id, headerOf()))
		})
		changed()
		return { id, at, kind, name, by: o.id }
	}

	// an offer's node going (withdrawn, or torn down from above): its users still running stopped
	// "runner-stopped", it out of the lists
	function gone(o: Offer) {
		if (o.gone) return
		o.gone = true
		if (offers.get(o.id) === o) offers.delete(o.id)
		const i = o.owner.offers.indexOf(o)
		if (i !== -1) o.owner.offers.splice(i, 1)
		const failed = users(o, REASONS.runner)
		changed()
		if (failed) throw failed.error
	}

	// an offer's users stopped, newest first, with why: the first error
	function users(o: Offer, why: unknown): { error: unknown } | undefined {
		let failed: { error: unknown } | undefined
		for (const u of [...o.users].reverse()) {
			try {
				halt(u, why)
			} catch (error) {
				failed ??= { error }
			}
		}
		return failed
	}

	// its users stopped with why, its name out of its folder, its node gone
	function retract(o: Offer, why: unknown) {
		if (o.gone) return
		const failed = users(o, why)
		const folder = o.owner.folders.get(o.kind)
		try {
			within(o.scope, () => {
				const there = folder && table.get("children", folder.id) as Entry<unknown> | undefined
				if (there !== undefined && isMap(there.value) && Object.hasOwn(there.value, o.name)) {
					update(there, [{ path: [o.name] }], headerOf())
					commit([there])
				}
			})
		} finally {
			s.teardown(o.scope)
		}
		if (failed) throw failed.error
	}

	function withdraw(x: Offered | Id) {
		const o = offers.get(typeof x === "object" ? x.id : x)
		if (o !== undefined) retract(o, REASONS.withdrawn)
	}

	// the node at an address from a box's root, untracked
	const resolve = (where: Box, address: Address): { path: Path; id: Id | undefined } => {
		const path = inside(address)
		return { path, id: where.places.peep(() => get(where.places, path)) }
	}

	const attributesOf = (id: Id) => {
		const v = table.get("attributes", id)?.value
		return isMap(v) ? v : {}
	}

	// a runner node's value as a Runner: a map's or function's own start (load, api), else a
	// function as its start; none: undefined
	function runnerOf(v: unknown): Runner | undefined {
		if (typeof v !== "function" && !isMap(v)) return undefined
		const o = v as Partial<Runner>
		const own = typeof o.start === "function"
		if (!own && typeof v !== "function") return undefined
		const start: Runner["start"] = own
			? (code, start) => o.start!(code, start)
			: (code, start) => (v as Runner["start"])(code, start)
		return {
			start,
			...(typeof o.load === "function" ? { load: (code, start) => o.load!(code, start) } : {}),
			...(typeof o.api === "function" ? { api: (start) => o.api!(start) } : {}),
		}
	}

	// what an owner's runner is handed: its facts
	const startOf = (o: Owner): Start => ({
		box: o.box,
		places: o.box.places,
		process: { id: o.id, at: o.at, args: o.args, cwd: o.cwd },
		scheduler: s,
		table,
		scope: o.scope,
		den,
	})

	// start's checks in order, up to taken (processes'): the runner, the program read once, the
	// policy asked. load: a runner with no load is not-a-runner
	type Checked = {
		readonly runner: { readonly id: Id; readonly path: Path }
		readonly program: { readonly id: Id; readonly at?: Path }
		readonly code: unknown
		readonly digest?: string
		readonly live: Runner
	}
	function check(
		who: unknown,
		remote: boolean,
		runner: Address,
		program: Address | Program,
		where: Box,
		load: boolean,
	): Checked | Refused {
		if (closed) return STOPPED
		const r = resolve(home, runner)
		const notRunner = { refused: "not-a-runner", runner: r.path } as const
		if (r.id === undefined) return notRunner
		const rattrs = attributesOf(r.id)
		if (rattrs[ATTRIBUTE] !== TYPE.runners) return notRunner
		// the program: its node (or carried code), its form, and its code read once
		let id: Id, path: Path | undefined, code: unknown, digest: string | undefined
		let type: unknown, api: unknown
		const carried = !isAddress(program) && program.code !== undefined
		if (isAddress(program)) {
			const p = resolve(where, program)
			path = p.path
			const entry = p.id === undefined ? undefined : table.get("value", p.id)
			if (p.id === undefined || entry === undefined) {
				return { refused: "not-there", program: p.path }
			}
			id = p.id
			code = entry.value
			digest = hashOf(code)
			;({ [ATTRIBUTE]: type, [PROGRAM_API]: api } = attributesOf(id))
		} else if (carried) {
			id = typeof program.id === "string" ? program.id : ""
			code = program.code
			digest = hashOf(code)
			if (program.hash !== undefined && program.hash !== digest) {
				return { refused: "not-there", program: id }
			}
			type = program.type
			api = typeof program.api === "string" ? program.api : undefined
		} else {
			id = typeof program.id === "string" ? program.id : ""
			const entry = table.get("value", id)
			if (entry === undefined) return { refused: "not-there", program: id }
			code = entry.value
			digest = hashOf(code)
			if (program.hash !== undefined && program.hash !== digest) {
				return { refused: "not-there", program: id }
			}
			;({ [ATTRIBUTE]: type, [PROGRAM_API]: api } = attributesOf(id))
		}
		const takes = rattrs[TAKES], given = rattrs[API]
		if (
			typeof type !== "string" || typeof takes !== "string" || type !== takes ||
			(api !== undefined && api !== given)
		) {
			return {
				refused: "wrong-form",
				program: strings({ type, api }),
				runner: strings({ takes, api: given }),
			}
		}
		const live = runnerOf(table.get("value", r.id)?.value)
		if (live === undefined || (load && live.load === undefined)) return notRunner
		const allowed = permit(who, "start", { id: r.id, path: [...r.path] }, remote)
		if (allowed.answer !== "yes") return refuse("start", allowed)
		if (!carried) {
			const target: Target = path === undefined
				? { part: "value", id }
				: { part: "value", id, path: [...path] }
			const read = permit(who, "read", target, remote)
			if (read.answer !== "yes") return refuse("read", read)
		}
		return {
			runner: { id: r.id, path: r.path },
			program: { id, ...(path === undefined ? {} : { at: path }) },
			code,
			...(digest === undefined ? {} : { digest }),
			live,
		}
	}

	// start's checks, then processes' start. who: the policy's; remote: another den's ask
	function begin(
		who: unknown,
		remote: boolean,
		runner: Address,
		program: Address | Program,
		address: Address,
		options: Options,
	): Running | Refused {
		const where = options.box ?? home
		const c = check(who, remote, runner, program, where, false)
		if ("refused" in c) return c
		const { live, code, digest } = c
		const on = offers.get(c.runner.id)
		const attrs = {
			[ATTRIBUTE]: TYPE.process,
			[RUNNER]: { id: c.runner.id, at: c.runner.path },
			[PROGRAM]: digest === undefined ? c.program : { ...c.program, hash: digest },
			[DEN]: { id: node, at },
		}
		let p: Running | undefined
		const made = processes.start(
			where,
			address,
			{ args: options.args, cwd: options.cwd, pin: options.pin, attributes: attrs },
			(inside) => {
				const q: Running = {
					id: inside.id,
					at: inside.at,
					scope: inside.scope,
					box: inside.box,
					args: inside.args,
					cwd: inside.cwd,
					folders: new Map(),
					offers: [],
					loads: [],
					on,
					ended: false,
					told: false,
				}
				p = q
				running.push(q)
				byId.set(q.id, q)
				on?.users.push(q)
				// core candidate (scheduler): an effect that acts once and goes
				const first = s.createEffect(() => true, () => {
					try {
						run(q, inside, live, code)
					} finally {
						s.teardown(first)
					}
				})
				inside.give(first, { run: true })
				return () => done(q)
			},
		)
		if ("refused" in made) return made
		p!.process = made
		changed()
		later()
		return p!
	}

	// the runner's start called, the process's scope open. a handle at once: kept; a throw or a
	// promise: a computer holding the outcome, its status the node's
	function run(p: Running, inner: Inside, live: Runner, code: unknown) {
		let out: { value: unknown } | { error: unknown }
		try {
			const start = startOf(p)
			out = { value: s.runWithScope(p.scope, () => live.start(code, start)) }
		} catch (error) {
			out = { error }
		}
		const o = out
		if ("value" in o && !isPromise(o.value)) return hold(p, o.value)
		// a handle landing late: what its stop throws, the process gone, has nobody to tell
		if ("value" in o) {
			;(o.value as PromiseLike<unknown>).then((h) => {
				try {
					hold(p, h)
				} catch {
					// dropped
				}
			}, () => {})
		}
		const c = s.runWithScope(p.scope, () =>
			s.createComputer(() => {
				if ("error" in o) throw o.error
				return o.value
			}, () => {}))
		inner.give(c)
	}

	// a handle given: kept; ended already, stopped now with its reason. no stop in it: nothing
	function hold(p: Running, h: unknown) {
		if (!isMap(h) || typeof h.stop !== "function") return
		if (p.ended) (h as Handle).stop(p.reason)
		else p.handle = h as Handle
	}

	// a held load let go: out of its holder's list, its live form disposed (if it can be)
	function drop(o: Owner, h: Held) {
		if (h.released) return
		h.released = true
		const i = o.loads.indexOf(h)
		if (i !== -1) o.loads.splice(i, 1)
		const v = h.live
		const dispose = typeof v === "function" || isMap(v)
			? (v as { [Symbol.dispose]?: unknown })[Symbol.dispose]
			: undefined
		if (typeof dispose === "function") dispose.call(v)
	}

	// every load an owner holds let go, newest first: the first error
	function letGo(o: Owner): { error: unknown } | undefined {
		let failed: { error: unknown } | undefined
		for (const h of [...o.loads].reverse()) {
			try {
				drop(o, h)
			} catch (error) {
				failed ??= { error }
			}
		}
		return failed
	}

	// a process going (its done, called by processes' stop, or by its scope torn down from above):
	// its offers withdrawn newest first (their users stopped "runner-stopped"), then its handle's
	// stop with the reason told (none told: the den's, the den going; else none), then its loads let
	// go, newest first. every step runs; the first error is thrown after
	function done(p: Running) {
		if (p.ended) return
		p.ended = true
		if (!p.told) p.reason = owner.state === "alive" ? undefined : pending
		const i = running.indexOf(p)
		if (i !== -1) running.splice(i, 1)
		byId.delete(p.id)
		const j = p.on?.users.indexOf(p) ?? -1
		if (j !== -1) p.on!.users.splice(j, 1)
		let failed: { error: unknown } | undefined
		for (const o of [...p.offers].reverse()) {
			try {
				retract(o, REASONS.runner)
			} catch (error) {
				failed ??= { error }
			}
		}
		const h = p.handle
		p.handle = undefined
		try {
			if (h !== undefined) h.stop(p.reason)
		} catch (error) {
			failed ??= { error }
		}
		const loose = letGo(p)
		if (loose) failed ??= loose
		changed()
		if (failed) throw failed.error
	}

	// a process stopped with a reason: processes' stop (done, the row out, the scope gone)
	function halt(p: Running, why: unknown) {
		if (p.ended) return
		p.told = true
		p.reason = why
		if (p.process !== undefined) processes.stop(p.process)
		else done(p)
	}

	function start(
		runner: Address,
		program: Address | Program,
		at: Address,
		options: Options = {},
	): Process | Refused {
		const r = begin(createChangeBase(s), false, runner, program, at, options)
		return "refused" in r ? r : r.process!
	}

	function load(
		runner: Address,
		program: Address | Program,
		options: { by?: Process | Id; box?: Box } = {},
	): Loaded | Refused {
		if (closed) return STOPPED
		const by = ownerOf(options.by)
		const c = check(createChangeBase(s), false, runner, program, options.box ?? by.box, true)
		if ("refused" in c) return c
		const start = startOf(by)
		const f = () => c.live.load!(c.code, start)
		const live = s.getCurrentScope() !== undefined ? f() : s.runWithScope(by.scope, f)
		const h: Held = { live, released: false }
		by.loads.push(h)
		later()
		return { live, release: () => drop(by, h) }
	}

	function stop(x: Process | Id, reason?: unknown): NoPermission | undefined {
		const id = typeof x === "object" ? x.id : x
		if (id === node) {
			if (closed) return
			const a = permit(createChangeBase(s), "stop", { id, path: [...at] }, false)
			if (a.answer !== "yes") return refuse("stop", a)
			close(reason)
			return
		}
		const p = byId.get(id)
		if (p === undefined || p.ended) return
		const a = permit(createChangeBase(s), "stop", { id, path: [...p.at] }, false)
		if (a.answer !== "yes") return refuse("stop", a)
		halt(p, reason)
	}

	function askedBy(a: Ask): Asked {
		if (closed) return STOPPED
		if (a.op === "start") {
			const { runner, program, at, options } = shaped(a as unknown as Record<string, unknown>)
			const r = begin(a.who, true, runner, program, at, options)
			return "refused" in r ? r : { id: r.id, at: r.at }
		}
		if (a.op === "stop") {
			const p = byId.get(a.process)
			if (p === undefined || p.ended) return { refused: "not-there", process: a.process }
			const allowed = permit(a.who, "stop", { id: p.id, path: [...p.at] }, true)
			if (allowed.answer !== "yes") return refuse("stop", allowed)
			halt(p, a.reason)
			return {}
		}
		throw new TypeError(`not an ask: ${String((a as { op?: unknown }).op)}`)
	}

	// every process stopped, newest first, each given reason; then the den's own (its offers, here,
	// its row); then the owner. every step runs; the first error is thrown after
	function close(reason: unknown = REASONS.den) {
		if (closed) return
		closed = true
		pending = reason
		let failed: { error: unknown } | undefined
		for (const p of [...running].reverse()) {
			try {
				halt(p, reason)
			} catch (error) {
				failed ??= { error }
			}
		}
		try {
			processes.stop(self)
		} catch (error) {
			failed ??= { error }
		}
		try {
			s.teardown(owner)
		} catch (error) {
			failed ??= { error }
		}
		if (failed) throw failed.error
	}

	// the attributes as they travel: the status as "pending" | { failed }, no other with no
	// encoding. none: undefined. tracked
	function shown(id: Id): Record<string, unknown> | undefined {
		const v = places.readValue("attributes", id)
		if (!isMap(v)) return undefined
		const out: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v)) {
			if (k === STATUS) {
				if (x === PENDING) out[k] = "pending"
				else if (x instanceof Error) out[k] = { failed: x.message }
			} else if (encodes(x)) out[k] = x
		}
		return out
	}

	function nodes(options: { processes?: boolean } = {}): Nodes {
		s.track(version)
		const out: Record<Id, Seen> = {}
		const seen = (id: Id, kids: Record<string, Id>) => {
			const attributes = shown(id)
			const n: { attributes?: Record<string, unknown>; children?: Record<string, Id> } = {}
			if (attributes !== undefined) n.attributes = attributes
			if (Object.keys(kids).length > 0) n.children = kids
			out[id] = n
		}
		const offered = (o: Owner, kids: Record<string, Id>) => {
			for (const [kind, folder] of o.folders) kids[kind] = folder.id
			seen(o.id, kids)
			for (const [kind, folder] of o.folders) {
				const names: Record<string, Id> = {}
				for (const x of o.offers) if (x.kind === kind) names[x.name] = x.id
				out[folder.id] = { children: names }
			}
			for (const x of o.offers) seen(x.id, {})
		}
		const on: Id = `${String(node)}/${ON}`
		offered(mine, { [ON]: on })
		out[on] = { children: { start: `${String(on)}/start`, stop: `${String(on)}/stop` } }
		if (options.processes === false) return { den: node, nodes: out }
		const list: { id: Id; at: Path }[] = []
		for (const p of running) {
			if (p.box.root !== places.root) continue
			list.push({ id: p.id, at: p.at })
			offered(p, {})
		}
		return { den: node, nodes: out, processes: list }
	}

	const den: Den = {
		id: setup.id,
		node,
		process: self,
		scope: owner,
		scheduler: s,
		table,
		places,
		offer,
		withdraw,
		start,
		load,
		stop,
		ask: askedBy,
		find: (id) => {
			const p = byId.get(id)
			return p === undefined || p.ended ? undefined : p.process
		},
		processes: () => running.flatMap((p) => p.process === undefined ? [] : [p.process]),
		offers: () =>
			[...offers.values()].map(({ id, at, kind, name, by }) => ({ id, at, kind, name, by })),
		nodes,
		close,
		runs: processes.runs,
	}
	return den
}
