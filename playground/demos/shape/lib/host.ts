// a stand-in, not the process api: the demos' host interface (make, Api, start, call, outro,
// replace, moments), small over today's table, places, status, header, scheduler and protect, so
// the demos run. it goes when the process api comes.
//
// what today's pieces lack is dropped, not invented:
//   - one id under a name: a "list" read gives none or one; insert/remove/pop/move index ignored
//   - one version per node: a process's status is shown as a version in front of its value
//   - info: the attributes entry; ephemeral: the host's mark, removed when its process is killed
//   - no run nodes: a run's reads and writes come with its `ends` moment
//   - a process found by path takes up a new program at once (no "newer" status)
//   - header actor: the root scope's ("host", or as({actor})); who made it is in metadata (whoOf);
//     the change count is the pair "tick" (tickOf); time is the wall clock's
//
// a node: an id with "value", "children" and "attributes". an address: names from a place ("/"
// the root, ".." up); a string is an id. a process: a scope under the host's, its node placed at
// its address under its name. its reads are tracked in a compute, untracked elsewhere.
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import type { Node } from "@ermine/core/node"
import update from "@ermine/core/node/update"
import apply, { type Key as Step_, type Patch } from "@ermine/core/changeable/apply"
import {
	at,
	createPlaces,
	type Fact,
	move,
	place,
	type Places,
	rename,
	unplace,
} from "@ermine/core/places"
import { createChangeBase, createChangeHeader } from "@ermine/core/places/header"
import { plan } from "@ermine/core/places/path"
import { createStatus, STATUS } from "@ermine/core/places/status"
import type { Answer, Policy, Target } from "@ermine/core/protect"
import {
	type Computer,
	createScheduler,
	type Ended,
	type Info,
	PENDING,
	type Scheduler,
	type Scope,
} from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { trace } from "@ermine/core/scheduler/trace"
import { createTable, type Id as TableId, type Key, type Table } from "@ermine/core/table"
import { type FileLocation, frames } from "@ermine/core/util/stacktrace"

export { PENDING }
export type { ChangeHeader, Ended, Node, Patch }

// ---- shapes ----

export type Id = string
// names from a place: "/" first is the root, ".." goes up
export type Address = readonly string[]
// an address, or an id: the node itself
export type Where = Address | Id
// one name walked: the node it was in, the name, the id under it (at: always 0, one id a name)
export type Step = { node: Id; name: string; id: Id; at: number }
// a node's value, or a process's status in front of it (because.place "status")
export type Version = { content: unknown; change: ChangeHeader; because?: { place: "status" } }
// what a read gives per id reached: none or one. node: the node's entries; up: a lookup's, how many
// places above it was found; versions: content's and info's; refused: protect said no
export type Item = {
	id: Id
	route: Step[]
	node?: Node
	up?: number
	versions?: Version[]
	refused?: string
}
// a write's: the node it changed, its tick, its header
export type Change = { node: Id; time: number; header: ChangeHeader }

export type Api = {
	// the node's entries, untracked; none: no node
	node(id: Id): Node | undefined
	look(where: Where): Item[]
	// the names from the place, then from each place above it: the nearest; all of them
	lookup(path: Address): Item[]
	lookups(path: Address): Item[]
	// no name: the names in the node; a name: the item under it
	children(where: Where, name?: string): Item[] | string[]
	names(where: Where, part: "info" | "children"): string[]
	content(where: Where): Item[]
	info(where: Where, name: string): Item[]
	write(where: Where, patches: Iterable<Patch>, index?: number): Change
	set(where: Where, name: string, patches: Iterable<Patch>): Change
	insert(id: Id, name: string, child: Id, index?: unknown): Change
	remove(id: Id, name: string, index?: unknown): Change
	pop(id: Id, name: string, index?: unknown): Change
	rename(id: Id, name: string, to: string): Change[]
	move(id: Id, name: string, index: unknown, toid: Id, toname: string, toindex?: unknown): Change[]
	create(value?: unknown, o?: { id?: Id; ephemeral?: boolean }): Id
	// the same api, its changes carrying these too (actor: the host's only, a root scope of its own,
	// its ops asked of protect)
	as(o: { actor?: unknown; cause?: unknown; message?: string }): Api
}

// a part: called with one map (the given maps below)
// deno-lint-ignore no-explicit-any
export type Fn = (given: any) => unknown
// a setup (a function: once, untracked, its return the value), or a compute (tracked, read only,
// rerun when what it read changes; its return the value) and an effect acting on that value
export type Code = Fn | { readonly compute: Fn; readonly effect?: Fn }
export type Found = { code: Code; program: { node: Id; time: number } }
export type Process = { id: Id; name: string; place: Address; program: Address }
// the host's: a process's code by its program's path, read through view (tracked, read only)
export type Finder = (process: Process, view: Api) => Found | typeof PENDING
export type StartOp = {
	address: Address
	program: Address | Code
	name?: string
	id?: Id
	equal?: (a: unknown, b: unknown) => boolean
	// the host's: where address is read from; default the root
	place?: Address
}
export type CallOp = {
	address: Address
	args?: unknown
	place?: Address
	// the host's: who calls, and whether a person did (keys in the call's header)
	actor?: unknown
	person?: unknown
	trusted?: boolean
}
export type Started = { id: Id; change?: Change }
export type Cleanup = (given: { killed: boolean; api: Api }) => unknown

// what each part is given
export type ComputeGiven = {
	api: Api
	peep: Api
	start: (op: StartOp) => Started
	by: unknown[]
	pending: typeof PENDING
	self: Id
	name: string
}
export type SetupGiven = {
	api: Api
	start: (op: StartOp) => Started
	call: (address: Address, args?: unknown) => unknown
	onCleanup: (f: Cleanup) => void
	self: Id
	name: string
}
export type EffectGiven = SetupGiven & { value: unknown; previous?: unknown }
export type HandlerGiven = Omit<SetupGiven, "onCleanup"> & { args?: unknown }

// a process's parts: a program by path's loader, a setup, a compute (with its effect)
export type Part = "load" | "setup" | "compute"
// where a run read: a children, value or attributes entry, the path in it (null: its change)
export type Read = { part: Key; id: Id; path: readonly Step_[] | null }
// what happened, told as it happens (never read the graph in a hook: collect, read after)
export type Moment =
	| { started: Id; name: string; place: string[] }
	| { gone: Id }
	| { due: Id; part: Part; tick: number; by?: Id; change?: number }
	| { starts: Id; part: Part; run: number; rank: number }
	| {
		ends: Id
		part: Part
		run: number
		ended: Ended
		reads: Read[]
		wrote: number[]
		equal?: boolean
		error?: unknown
		waits?: Id
	}
	| { acts: Id; run: number; wrote: number[]; error?: unknown }
	| { call: Id; handler: string }
	| { called: Id; handler: string; ended: "done" | "failed"; wrote: number[]; error?: unknown }
export type Hook = (moment: Moment) => void

// an entry a change landed on, as places tells a watch (a Fact: part, id, patches, change, entry;
// an entry made or taken out: one patch at the root), with the tick and the ephemeral mark
export type Changed = Fact & { time: number; ephemeral: boolean }

export type Options = {
	// the root's id; "root"
	root?: Id
	// the host's actor; "host"
	actor?: unknown
	// the tick, counted up by each change; ids made are "@" and it
	clock?: { time: number }
	hooks?: readonly Hook[]
	code?: Finder
	// protect: asked for every op of a process, or of an api acting as({actor}); the host's pass
	may?: Policy
	// the site a change is from; default the first frame outside this file
	site?: () => FileLocation | undefined
	changed?: (c: Changed) => void
	// what sits beside the table (sync): told each table event, an entry put or taken out whole,
	// after places; and each write landed, after places
	tableChanged?: (part: Key, id: TableId) => void
	wrote?: (changed: readonly Entry<unknown>[]) => void
}

export class HostError extends Error {
	constructor(
		readonly code:
			| "stopped"
			| "read-only"
			| "nothing-there"
			| "already-there"
			| "not-a-handler"
			| "not-a-process"
			| "wrong-field"
			| "refused",
		message: string,
	) {
		super(`${code}: ${message}`)
		this.name = "HostError"
	}
}

export type Host = Api & {
	clock: { time: number }
	start(op: StartOp): Started
	call(op: CallOp): unknown
	// kills a process (children, cleanups, its ephemeral nodes, its node); any other node: taken out
	outro(id: Id): void
	// the process at address runs its program again from the start
	replace(op: { address: Address; place?: Address }): void
	// many ops, one round after
	batch(fn: () => void): void
	hear(h: Hook): () => void
	ephemeral(id: Id): boolean
	// a node's entries put in as they are (a restore)
	intro(id: Id, node: Node): void
	process(id: Id): { id: Id; name: string; place: string[]; program: Address | Code } | undefined
	// what the host is made of, for a library that runs on them itself (@ermine/solid's setups):
	// its places' commit is the host's, so what it writes is told and timed like the rest
	world(parent?: Id): World
}

export type World = {
	scheduler: Scheduler
	table: Table
	places: Places
	scope: Scope
	parent: Id
}

// ---- the host ----

type Reader = {
	walk(names: readonly string[], from: Id): { name: string; id: Id }[]
	value(part: Key, id: Id, path?: readonly Step_[]): unknown
	keys(part: Key, id: Id): string[]
}

type Kind = Part | "handler"

type Proc = {
	id: Id
	name: string
	place: string[]
	program: Address | Code
	equal?: (a: unknown, b: unknown) => boolean
	// the process: torn down at a kill; its program's, at a replace
	scope: Scope
	run?: Scope
	parent?: Proc
	// children started by name, and the part that started them
	kids: Map<string, { id: Id; part: Kind }>
	// ephemeral nodes it made, in order
	owned: Id[]
	state: "running" | "killing" | "gone"
}

// what an api reads and writes as
type Ctx = {
	place: readonly string[]
	r: Reader
	writes: boolean
	alive: () => boolean
	scope: () => Scope
	proc?: Proc
	asked: boolean
	extra: Info
}

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v)

const plain = (v: unknown): v is Record<string, unknown> =>
	isMap(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))

// plain data compared deep, anything else by identity
export function equal(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]))
	}
	if (!plain(a) || !plain(b)) return false
	const ks = Object.keys(a)
	return ks.length === Object.keys(b).length &&
		ks.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
}

// a change's site: the first frame in the demo's own code, past this file, the shared demo lib and
// every ermine library the host calls through (they call back into it). a deep stack: the limit
// raised for the capture
const ours = (file: string) =>
	/\/ermine\/(core|ermine|extensions)\/|\/demos\/lib\/|^https?:\/\/[^/]+\/lib\/|\/node_modules\/|\/@vite\/|\/@id\//
		.test(file.split("?")[0])
function capture(): FileLocation | undefined {
	const E = Error as { stackTraceLimit?: number }
	const limit = E.stackTraceLimit
	E.stackTraceLimit = 64
	try {
		return frames(new Error().stack ?? "").find((f) => !ours(f.file))
	} finally {
		E.stackTraceLimit = limit
	}
}

export function make(o: Options = {}): Host {
	const ROOT = o.root ?? "root"
	const clock = o.clock ?? { time: 0 }
	const listeners = new Set<Hook>(o.hooks ?? [])
	const tell = (m: Moment) => {
		for (const h of [...listeners]) h(m)
	}

	const table = createTable((part, id) => {
		const e = table.get(part, id)
		marking(e?.change, () => places.onTableChange(part, id))
		o.tableChanged?.(part, id)
		const patch = e?.value === undefined ? { path: [] } : { path: [], value: e.value }
		tap({ part, id, patches: [patch], change: e?.change, entry: e })
	})
	const paths = createPaths()
	const s = createScheduler()
	const places = createPlaces({ root: ROOT, table, paths, scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const statuses = createStatus({ places: { commit }, table, scheduler: s })
	const host = s.createRootScope({ actor: o.actor ?? "host" })

	const procs = new Map<Id, Proc>()
	// each computer's process and part; what each wrote since its last moment
	const parts = new WeakMap<Computer, { p: Proc; part: Part }>()
	const wrote = new WeakMap<Computer, number[]>()
	// what each handler call going on wrote, innermost last
	const calls: number[][] = []
	// the host's ephemeral marks; the process that put each function value (a call runs as it)
	const ephemerals = new Set<Id>()
	const handlers = new Map<Id, Proc>()
	// where each id is placed: parent and name
	const placed = new Map<Id, [Id, string][]>()

	// ---- changes ----

	// a change made now: the next tick, in a header with the open scope's info. quiet: no site
	function header(extra: Info = {}, quiet = false): ChangeHeader {
		const tick = ++clock.time
		const h = createChangeHeader(s, { ...extra, tick })
		const site = quiet ? undefined : o.site ? o.site() : capture()
		if (site) h.external = [site]
		else delete h.external
		return h
	}

	// a write landed: places told (its readers marked), then the host
	function commit(changed: readonly Entry<unknown>[]) {
		marking(changed[0]?.change, () => places.commit(changed))
		o.wrote?.(changed)
		for (const f of places.eachEntryChange(changed)) tap(f)
	}

	// the tick of the change whose readers are being marked: a due moment names it
	let marked: number | undefined
	function marking(h: ChangeHeader | undefined, f: () => void) {
		const was = marked
		marked = tickOf(h)
		try {
			f()
		} finally {
			marked = was
		}
	}

	function tap(f: Fact) {
		const time = tickOf(f.change) ?? ++clock.time
		const r = s.getRun()
		if (r) wrote.get(r.computer)?.push(time)
		calls.at(-1)?.push(time)
		o.changed?.({ ...f, time, ephemeral: ephemerals.has(f.id as Id) })
	}

	// one round after the outermost request: what its changes made due has run when it returns
	let depth = 0
	function request<T>(f: () => T): T {
		depth++
		try {
			return f()
		} finally {
			if (--depth === 0) s.pulse()
		}
	}
	// a promise a run gave settled: its result lands in a round
	s.onSettle(() => queueMicrotask(() => depth === 0 && s.pulse()))

	// ---- reading ----

	const kid = (id: Id, name: string): Id | undefined => {
		const v = table.get("children", id)?.value
		const k = isMap(v) && Object.hasOwn(v, name) ? v[name] : undefined
		return typeof k === "string" ? k : undefined
	}
	// places' reads: told to the scheduler, so a run reading tracks them
	const tracked: Reader = {
		walk: (names, from) => [...places.walk(names, from)] as { name: string; id: Id }[],
		value: (part, id, path) => places.readValue(part, id, path),
		keys: (part, id) => places.readKeys(part, id),
	}
	// the table's: told no one
	const quiet: Reader = {
		walk(names, from) {
			const out: { name: string; id: Id }[] = []
			for (const name of names) {
				const id = kid(out.at(-1)?.id ?? from, name)
				if (id === undefined) break
				out.push({ name, id })
			}
			return out
		},
		value: (part, id, path = []) => at(table.get(part, id)?.value, path),
		keys(part, id) {
			const v = table.get(part, id)?.value
			return isMap(v) ? Object.keys(v) : []
		},
	}

	function nodeOf(id: Id): Node | undefined {
		const entries = table.get(id)
		return entries.length ? Object.fromEntries(entries) as Node : undefined
	}

	// the names an address reaches from a place; above the root: undefined
	const names = (place: readonly string[], address: Address) => plan(["/", ...place, ...address])

	// the item an address reaches (an id: itself), walked with r
	// a node not there yet (sync brings it later): its value read with r, so a compute reading it
	// runs again when it comes
	function reach(r: Reader, place: readonly string[], where: Where): Item | undefined {
		if (typeof where === "string") {
			const node = nodeOf(where)
			if (!node) r.value("value", where)
			return node ? { id: where, route: [], node } : undefined
		}
		const path = names(place, where)
		if (!path) return undefined
		const steps = r.walk(path, ROOT)
		if (steps.length < path.length) return undefined
		const route = steps.map((st, i) => ({ node: steps[i - 1]?.id ?? ROOT, ...st, at: 0 }))
		const id = steps.at(-1)?.id ?? ROOT
		const node = nodeOf(id)
		if (!node) r.value("value", id)
		return node ? { id, route, node } : { id, route }
	}

	// protect asked: a no throws, a pending throws PENDING
	function ask(c: Ctx, op: string, target: Target) {
		if (!o.may || !c.asked) return
		const who = createChangeBase(s, c.extra)
		const answer: Answer = o.may(
			{ who, op, target, from: c.proc ? { path: c.place } : undefined },
			(part, id, path) => c.r.value(part as Key, id as Id, path),
		)
		if (answer.answer === "no") throw new HostError("refused", `${op}: ${answer.reason}`)
		if (answer.answer === "pending") throw PENDING
	}
	const target = (it: Item, part?: Key): Target => ({
		id: it.id,
		part,
		path: it.route.map((st) => st.name),
	})

	// an item read: asked first; refused, it says why and holds nothing
	function read(c: Ctx, it: Item | undefined, part: Key, more?: (it: Item) => Item): Item[] {
		if (!it) return []
		try {
			ask(c, "read", target(it, part))
		} catch (e) {
			if (e instanceof HostError) return [{ id: it.id, route: it.route, refused: e.message }]
			throw e
		}
		return [it.node && more ? more(it) : it]
	}

	// a status as the old versions showed it
	function shown(status: unknown): Record<string, unknown> {
		if (status === PENDING) return { pending: true }
		if (status instanceof Error) {
			if (status.message === "looping") return { loop: {} }
			const code = (status as { code?: unknown }).code
			return { error: { name: status.name, message: status.message, ...(code ? { code } : {}) } }
		}
		return { error: { message: String(status) } }
	}

	// a node's value (its status in front), or one of its infos
	function versions(r: Reader, id: Id, name?: string): Version[] {
		const out: Version[] = []
		if (name === undefined) {
			const status = r.value("status", id, [STATUS])
			if (status !== undefined) {
				const change = table.get("status", id)!.change
				out.push({ content: shown(status), change, because: { place: "status" } })
			}
			const v = r.value("value", id)
			const e = table.get("value", id)
			if (e && v !== undefined) out.push({ content: v, change: e.change })
		} else {
			const v = r.value("attributes", id, [name])
			const e = table.get("attributes", id)
			if (e && v !== undefined) out.push({ content: v, change: e.change })
		}
		return out
	}

	function api(c: Ctx): Api {
		const live = (op: string) => {
			if (!c.alive()) throw new HostError("stopped", `${op}: its part has returned`)
		}
		// a write: alive, not read only, in its scope, a round after
		const writing = <T>(op: string, f: () => T): T => {
			live(op)
			if (!c.writes) throw new HostError("read-only", `${op}: a compute only reads`)
			return request(() => s.runWithScope(c.scope(), f))
		}
		const node = (where: Where, op: string): Item => {
			const it = reach(quiet, c.place, where)
			if (!it?.node) throw new HostError("nothing-there", `${op}: ${String(where)}`)
			return it
		}
		const change = (id: Id, h: ChangeHeader): Change => ({
			node: id,
			time: tickOf(h)!,
			header: h,
		})
		const handing = (id: Id, value: unknown) => {
			if (typeof value === "function" && c.proc) handlers.set(id, c.proc)
		}

		const children = (where: Where, name?: string): Item[] | string[] => {
			live("children")
			const it = reach(c.r, c.place, where)
			if (!it?.node) return []
			if (name === undefined) {
				ask(c, "list", target(it, "children"))
				return c.r.keys("children", it.id).filter((n) => kid(it.id, n) !== undefined)
			}
			const step = c.r.walk([name], it.id)[0]
			if (!step) return []
			const route = [...it.route, { node: it.id, name, id: step.id, at: 0 }]
			const node = nodeOf(step.id)
			return read(c, node ? { id: step.id, route, node } : { id: step.id, route }, "children")
		}

		const found = (path: Address, all: boolean): Item[] => {
			live("lookup")
			const out: Item[] = []
			const here = names(c.place, []) ?? []
			for (let k = here.length; k >= 0; k--) {
				const it = reach(c.r, [], ["/", ...here.slice(0, k), ...path])
				if (!it?.node) continue
				out.push(...read(c, { ...it, up: here.length - k }, "children"))
				if (!all) break
			}
			return out
		}

		const self: Api = {
			node: (id) => (live("node"), nodeOf(id)),
			look: (where) => (live("look"), read(c, reach(c.r, c.place, where), "children")),
			lookup: (path) => found(path, false),
			lookups: (path) => found(path, true),
			children,
			names(where, part) {
				live("names")
				if (part === "children") return children(where) as string[]
				const it = reach(c.r, c.place, where)
				return it?.node ? c.r.keys("attributes", it.id) : []
			},
			content: (
				where,
			) => (live("content"),
				read(c, reach(c.r, c.place, where), "value", (it) => ({
					...it,
					versions: versions(c.r, it.id),
				}))),
			info: (
				where,
				name,
			) => (live("info"),
				read(c, reach(c.r, c.place, where), "attributes", (it) => ({
					...it,
					versions: versions(c.r, it.id, name),
				}))),
			write: (where, patches) =>
				writing("write", () => {
					const it = node(where, "write")
					ask(c, "write", target(it, "value"))
					const ps = [...patches]
					const h = header(c.extra)
					const e = table.get("value", it.id)
					if (e) (update(e, ps, h), commit([e]))
					else table.add("value", it.id, createEntry(apply(undefined, ps), h))
					handing(it.id, table.get("value", it.id)?.value)
					return change(it.id, h)
				}),
			set: (where, name, patches) =>
				writing("set", () => {
					const it = node(where, "set")
					ask(c, "set", { ...target(it, "attributes"), field: [name] })
					const ps = [...patches].map((p) => ({ ...p, path: [name, ...p.path] }))
					const h = header(c.extra)
					const e = table.get("attributes", it.id) as Entry<unknown> | undefined
					if (!e) table.add("attributes", it.id, createEntry(apply({}, ps), h) as never)
					else {
						update(e, isMap(e.value) ? ps : [{ path: [], value: {} }, ...ps], h)
						commit([e])
					}
					return change(it.id, h)
				}),
			insert: (id, name, child) =>
				writing("insert", () => {
					ask(c, "place", { id, part: "children", field: [name] })
					const h = header(c.extra)
					commit(place(childrenOf(id), name, child, h))
					placing(child, id, name)
					return change(id, h)
				}),
			remove: (id, name) => self.pop(id, name),
			pop: (id, name) =>
				writing("remove", () => {
					ask(c, "unplace", { id, part: "children", field: [name] })
					const h = header(c.extra)
					const child = kid(id, name)
					commit(unplace(childrenOf(id), name, h))
					if (child !== undefined) unplacing(child, id, name)
					return change(id, h)
				}),
			rename: (id, name, to) =>
				writing("rename", () => {
					ask(c, "place", { id, part: "children", field: [name] })
					const h = header(c.extra)
					const child = kid(id, name)
					commit(rename(childrenOf(id), name, to, h))
					if (child !== undefined) (unplacing(child, id, name), placing(child, id, to))
					return [change(id, h)]
				}),
			move: (id, name, _index, toid, toname) =>
				writing("move", () => {
					ask(c, "unplace", { id, part: "children", field: [name] })
					ask(c, "place", { id: toid, part: "children", field: [toname] })
					const h = header(c.extra)
					const child = kid(id, name)
					const changed = move([childrenOf(id), name], [childrenOf(toid), toname], h)
					commit(changed)
					if (child !== undefined) (unplacing(child, id, name), placing(child, toid, toname))
					return changed.map(() => change(toid, h))
				}),
			create: (value, more = {}) =>
				writing("create", () => {
					const id = made(value, more.id, header(c.extra), more.ephemeral)
					if (more.ephemeral) c.proc?.owned.push(id)
					handing(id, value)
					return id
				}),
			as(more) {
				const extra: Info = { ...c.extra }
				if (more.cause !== undefined) extra.cause = more.cause
				if (more.message !== undefined) extra.message = more.message
				if (more.actor === undefined || c.proc) return api({ ...c, extra })
				const scope = s.createRootScope({ actor: more.actor })
				return api({ ...c, extra, scope: () => scope, asked: true })
			},
		}
		return self
	}

	// a new node: its value, and children to place under
	function made(value: unknown, id: Id | undefined, h: ChangeHeader, ephemeral = false): Id {
		const at = id ?? `@${tickOf(h)}`
		if (table.get(at).length) throw new HostError("already-there", `create: ${at}`)
		if (ephemeral) ephemerals.add(at)
		table.add("value", at, createEntry(value, h))
		table.add("children", at, createEntry({}, h))
		return at
	}

	// a node's children entry: made when it has none (a node put in by intro)
	function childrenOf(id: Id): Entry<unknown> {
		const e = table.get("children", id)
		if (e) return e
		table.add("children", id, createEntry({}, header({}, true)))
		return table.get("children", id)!
	}
	function placing(child: Id, parent: Id, name: string) {
		placed.set(child, [...placed.get(child) ?? [], [parent, name]])
	}
	function unplacing(child: Id, parent: Id, name: string) {
		const left = (placed.get(child) ?? []).filter(([p, n]) => p !== parent || n !== name)
		if (left.length) placed.set(child, left)
		else placed.delete(child)
	}

	// a node taken out of every place it is in, and out of the table
	function drop(id: Id) {
		for (const [parent, name] of placed.get(id) ?? []) {
			if (kid(parent, name) === id) commit(unplace(childrenOf(parent), name, header({}, true)))
		}
		placed.delete(id)
		ephemerals.delete(id)
		handlers.delete(id)
		for (const [part] of table.get(id)) table.del(part, id)
	}

	// ---- processes ----

	const hostCtx: Ctx = {
		place: [],
		r: quiet,
		writes: true,
		alive: () => true,
		scope: () => host,
		asked: false,
		extra: {},
	}

	// the scope a process's write is made in: the one open, when it is the process's; else its own
	function scopeOf(p: Proc): Scope {
		const open = s.getCurrentScope()
		for (let o = open; o; o = o.parent) if (o === p.scope) return open!
		return p.scope
	}

	// a part's given map. close: it has returned (its api says stopped); an effect's or a setup's
	// children it did not start again are killed
	function given(p: Proc, part: Kind | "effect", more: Record<string, unknown> = {}) {
		let alive = true
		const live = () => alive && p.state === "running"
		const stopped = (op: string) => new HostError("stopped", `${op}: its part has returned`)
		const c: Ctx = {
			place: p.place,
			r: part === "compute" ? tracked : quiet,
			writes: part !== "compute",
			alive: live,
			scope: () => scopeOf(p),
			proc: p,
			asked: true,
			extra: {},
		}
		const matched = new Set<string>()
		const kind: Kind = part === "effect" ? "compute" : part
		const map: Record<string, unknown> = {
			api: api(c),
			start: (op: StartOp) => {
				if (!live()) throw stopped("start")
				return start(op, { p, part: kind, matched })
			},
			self: p.id,
			name: p.name,
			...more,
		}
		if (part === "compute") {
			Object.assign(map, { peep: api({ ...c, r: quiet }), by: [], pending: PENDING })
		} else {
			map.call = (address: Address, args?: unknown) => {
				if (!live()) throw stopped("call")
				return call({ address, args }, p)
			}
		}
		if (part === "setup" || part === "effect") {
			map.onCleanup = (f: Cleanup) => {
				if (!live()) throw stopped("onCleanup")
				s.registerTeardown(s.getCurrentScope() ?? p.scope, () => {
					let going = true
					const api_ = api({ ...c, alive: () => going && p.state !== "gone" })
					try {
						return f({ killed: p.state === "killing", api: api_ })
					} finally {
						going = false
					}
				})
			}
		}
		const close = () => {
			alive = false
			if (part !== "setup" && part !== "effect") return
			for (const [name, k] of [...p.kids]) {
				if (k.part !== kind || matched.has(name)) continue
				p.kids.delete(name)
				const q = procs.get(k.id)
				if (q) kill(q)
			}
		}
		return { map, close }
	}

	// a part run with its map, closed when it returns (an async one: at its first await)
	function run(p: Proc, part: Kind | "effect", f: Fn, more?: Record<string, unknown>) {
		const g = given(p, part, more)
		try {
			return f(g.map)
		} finally {
			g.close()
		}
	}

	// the process's value: written by the computer open (its set or act), no site
	function value(p: Proc, v: unknown) {
		const e = table.get("value", p.id)
		if (v === undefined && e?.value === undefined) return
		const h = header({}, true)
		const patch: Patch = v === undefined ? { path: [] } : { path: [], value: v }
		if (e) (update(e, [patch], h), commit([e]))
		else table.add("value", p.id, createEntry(v, h))
	}

	function computer(c: Computer, p: Proc, part: Part) {
		parts.set(c, { p, part })
		wrote.set(c, [])
		statuses.give(c, p.id)
	}

	// the code's parts, made in the scope open
	function install(p: Proc, code: Code) {
		const same = p.equal ?? equal
		if (typeof code === "function") {
			const c = s.createComputer(() => run(p, "setup", code), (v) => value(p, v), same)
			return computer(c, p, "setup")
		}
		if (!code || typeof code.compute !== "function") {
			throw new HostError("wrong-field", "a program is a function or {compute, effect?}")
		}
		const compute = () => run(p, "compute", code.compute)
		const effect = code.effect
		const c = effect
			? s.createEffect(compute, (v, previous) => {
				value(p, v)
				run(p, "effect", effect, previous === undefined ? { value: v } : { value: v, previous })
			}, same)
			: s.createComputer(compute, (v) => value(p, v), same)
		computer(c, p, "compute")
	}

	// the program, from the start. a path's code is found by the host's finder, tracked, and taken
	// up whenever it gives other code
	function load(p: Proc) {
		const r = p.run = s.createScope({ why: "load" }, p.scope)
		s.runWithScope(r, () => {
			if (!Array.isArray(p.program)) return install(p, p.program as Code)
			const finder = o.code
			if (!finder) throw new HostError("wrong-field", "a program by path needs the host's code")
			const program = p.program as Address
			const view = api({ ...hostCtx, place: p.place, r: tracked, writes: false })
			let inner: Scope | undefined
			const c = s.createComputer<Found>(
				() => finder({ id: p.id, name: p.name, place: p.place, program }, view),
				(found) => {
					if (inner) s.teardown(inner)
					inner = s.createScope({ why: "install" }, r)
					s.runWithScope(inner, () => install(p, found.code))
				},
				(a, b) =>
					a.code === b.code && a.program.node === b.program.node &&
					a.program.time === b.program.time,
			)
			computer(c, p, "load")
		})
	}

	type By = { p: Proc; part: Kind; matched: Set<string> }

	function start(op: StartOp, by?: By): Started {
		return request(() => {
			if (!Array.isArray(op.address)) throw new HostError("wrong-field", "start: address")
			const program = op.program
			if (
				typeof program !== "function" && !Array.isArray(program) &&
				typeof (program as { compute?: unknown })?.compute !== "function"
			) throw new HostError("wrong-field", "start: a program is a path or code")
			const name = op.name
			if (name === "" || name === "." || name === ".." || name === "/") {
				throw new HostError("wrong-field", `start: ${name} is no name`)
			}
			const parent = by?.p
			// a part starting a child it started before by that name: that child again
			if (parent && name !== undefined) {
				const k = parent.kids.get(name)
				const q = k && procs.get(k.id)
				if (q?.state === "running" && k!.part === by!.part) {
					by!.matched.add(name)
					return { id: q.id }
				}
			}
			const from = parent ? parent.place : names([], op.place ?? []) ?? []
			const here = names(from, op.address)
			const at = here && reach(quiet, [], ["/", ...here])
			if (!here || !at?.node) {
				throw new HostError("nothing-there", `start: ${[...from, ...op.address].join("/")}`)
			}
			// made and placed by whoever starts it: the host, or the parent
			const as: Ctx = parent
				? { ...hostCtx, scope: () => scopeOf(parent), proc: parent, asked: true }
				: hostCtx
			const pid = s.runWithScope(as.scope(), () => made(undefined, op.id, header(), true))
			const p: Proc = {
				id: pid,
				name: name ?? pid,
				place: here,
				program,
				equal: op.equal,
				scope: s.createScope({ process: pid, name: name ?? pid }, parent?.scope ?? host),
				kids: new Map(),
				owned: [],
				state: "running",
			}
			if (parent) {
				p.parent = parent
				if (name !== undefined) {
					parent.kids.set(name, { id: pid, part: by!.part })
					by!.matched.add(name)
				}
			}
			// registered first, so it runs last: after its children and cleanups
			s.registerTeardown(p.scope, () => gone(p))
			procs.set(pid, p)
			const change = api(as).insert(at.id, p.name, pid)
			tell({ started: pid, name: p.name, place: here })
			load(p)
			return { id: pid, change }
		})
	}

	function kill(p: Proc) {
		if (p.state !== "running") return
		p.state = "killing"
		request(() => s.runWithScope(host, () => s.teardown(p.scope)))
	}

	// the process gone: what it made ephemeral, then its own node, out
	function gone(p: Proc) {
		p.state = "gone"
		procs.delete(p.id)
		if (p.parent?.kids.get(p.name)?.id === p.id) p.parent.kids.delete(p.name)
		for (const id of p.owned.reverse()) if (table.get(id).length) drop(id)
		if (table.get(p.id).length) drop(p.id)
		tell({ gone: p.id })
	}

	function call(op: CallOp, by?: Proc): unknown {
		return request(() => {
			const place = by ? by.place : names([], op.place ?? []) ?? []
			const it = reach(quiet, place, op.address)
			const fn = it && table.get("value", it.id)?.value
			if (!it) throw new HostError("nothing-there", `call: ${op.address.join("/")}`)
			if (typeof fn !== "function") {
				throw new HostError("not-a-handler", `call: ${op.address.join("/")} holds no function`)
			}
			const owner = handlers.get(it.id)
			const p = owner?.state === "running" ? owner : undefined
			const handler = it.route.at(-1)?.name ?? it.id
			const info: Info = { handler }
			if (by) info.caller = by.id
			else if (op.actor !== undefined) info.caller = op.actor
			if (op.person !== undefined) info.person = op.person
			if (op.trusted !== undefined) info.trusted = op.trusted
			const scope = s.createScope(info, p?.scope ?? host)
			const list: number[] = []
			calls.push(list)
			const who = p?.id ?? "host"
			tell({ call: who, handler })
			try {
				const out = s.runWithScope(scope, () => {
					if (p) {
						return run(p, "handler", fn as Fn, op.args === undefined ? {} : { args: op.args })
					}
					const c: Ctx = { ...hostCtx, scope: () => scope }
					return (fn as Fn)({ api: api(c), self: who, name: who, args: op.args })
				})
				tell({ called: who, handler, ended: "done", wrote: list })
				return out
			} catch (e) {
				tell({ called: who, handler, ended: "failed", wrote: list, error: e })
				throw e
			} finally {
				calls.pop()
				s.teardown(scope)
			}
		})
	}

	// ---- moments ----

	trace(s, (t) => {
		if ("due" in t) {
			const a = parts.get(t.due)
			if (!a) return
			const by = t.by && parts.get(t.by)?.p.id
			const m: Extract<Moment, { due: Id }> = { due: a.p.id, part: a.part, tick: t.tick }
			if (by) m.by = by
			if (marked !== undefined) m.change = marked
			tell(m)
		} else if ("starts" in t) {
			const a = parts.get(t.starts)
			if (a) tell({ starts: a.p.id, part: a.part, run: t.run, rank: t.rank })
		} else if ("ends" in t) {
			const a = parts.get(t.ends)
			if (!a) return
			const list = wrote.get(t.ends) ?? []
			wrote.set(t.ends, [])
			const m: Moment = {
				ends: a.p.id,
				part: a.part,
				run: t.run,
				ended: t.ended,
				reads: t.reads.map((k) => places.describe(k)).filter((w) => w !== undefined) as Read[],
				wrote: list,
			}
			if (t.equal !== undefined) m.equal = t.equal
			if ("error" in t) m.error = t.error
			const waits = t.waits && parts.get(t.waits)?.p.id
			if (waits) m.waits = waits
			tell(m)
		} else {
			const a = parts.get(t.acts)
			if (!a) return
			const list = wrote.get(t.acts) ?? []
			wrote.set(t.acts, [])
			const m = { acts: a.p.id, run: t.run, wrote: list }
			tell("error" in t ? { ...m, error: t.error } : m)
		}
	})

	// an effect that threw: its status says so, as status.ts says a failed run (the next run's end
	// writes it again)
	s.onEffect((c, _n, more) => {
		const a = parts.get(c)
		if (!a || !("error" in more) || c.state !== "alive") return
		const error = more.error instanceof Error ? more.error : new Error(String(more.error))
		s.runWithScope(c, () => {
			const h = header({}, true)
			const e = table.get("status", a.p.id) as Entry<unknown> | undefined
			if (!e) {
				return table.add("status", a.p.id, createEntry({ [STATUS]: error }, h) as never)
			}
			const ps: Patch[] = isMap(e.value) ? [] : [{ path: [], value: {} }]
			update(e, [...ps, { path: [STATUS], value: error }], h)
			commit([e])
		})
	})

	// ---- the root ----

	s.runWithScope(host, () => made(undefined, ROOT, header({}, true)))

	return {
		...api(hostCtx),
		clock,
		start: (op) => start(op),
		call: (op) => call(op),
		outro(id) {
			const p = procs.get(id)
			if (p) return kill(p)
			if (!table.get(id).length) throw new HostError("nothing-there", `outro: ${id}`)
			request(() => s.runWithScope(host, () => drop(id)))
		},
		replace(op) {
			request(() => {
				const it = reach(quiet, names([], op.place ?? []) ?? [], op.address)
				const p = it && procs.get(it.id)
				if (!p || p.state !== "running") {
					throw new HostError("not-a-process", `replace: ${op.address.join("/")}`)
				}
				if (p.run) s.runWithScope(host, () => s.teardown(p.run!))
				load(p)
			})
		},
		batch: (fn) => request(fn),
		hear(h) {
			listeners.add(h)
			return () => void listeners.delete(h)
		},
		ephemeral: (id) => ephemerals.has(id),
		intro(id, node) {
			request(() => {
				for (const [part, entry] of Object.entries(node)) {
					table.sub(part as Key, id, entry as Entry<never>)
					if (part !== "children" || !isMap(entry.value)) continue
					for (const [name, child] of Object.entries(entry.value)) {
						if (typeof child === "string") placing(child, id, name)
					}
				}
			})
		},
		process(id) {
			const p = procs.get(id)
			return p && { id: p.id, name: p.name, place: p.place, program: p.program }
		},
		world: (parent = ROOT) => ({
			scheduler: s,
			table,
			places: { ...places, commit },
			scope: host,
			parent,
		}),
	}
}

// ---- small reads over the api ----

type Versions = readonly { content: unknown; because?: unknown }[] | undefined

// a version that is a process's status, shown in front of its value
export const isStatus = (v: { because?: unknown }) =>
	(v.because as { place?: unknown } | undefined)?.place === "status"

// the first version that is not a status
export function first(vs: Versions): unknown {
	return vs?.find((v) => !isStatus(v))?.content
}

// a process's status, or {}
export function statusOf(vs: Versions): Record<string, unknown> {
	const v = vs?.[0]
	return v && isStatus(v) ? v.content as Record<string, unknown> : {}
}

// the value at an address: the first item with versions, its first not a status
export function val<T = unknown>(api: Pick<Api, "content">, address: Where): T {
	return first(api.content(address).find((i) => i.versions)?.versions) as T
}

// every value at an address (none or one: one id a name)
export function vals<T = unknown>(api: Pick<Api, "content">, address: Where): T[] {
	return api.content(address).filter((i) => i.versions).map((i) => first(i.versions) as T)
}

// an info at an address
export function infoOf<T = unknown>(api: Pick<Api, "info">, address: Where, name: string): T {
	return first(api.info(address, name).find((i) => i.versions)?.versions) as T
}

// the whole value replaced
export const whole = (value: unknown): Patch[] => [{ path: [], value }]

// the value at an address replaced whole
export function set(api: Pick<Api, "write">, address: Where, value: unknown) {
	api.write(address, whole(value))
}

// a node holding value, made and placed under name in parent; its id
export function put(
	api: Pick<Api, "create" | "insert">,
	parent: Id,
	name: string,
	value?: unknown,
	o: { id?: Id; ephemeral?: boolean } = {},
): Id {
	const id = api.create(value, o)
	api.insert(parent, name, id)
	return id
}

// the id of the node at an address
export function idAt(api: Pick<Api, "look">, address: Where): Id | undefined {
	return api.look(address).find((i) => i.node)?.id
}

// the stand-in's tick of a change, from its header's metadata
export function tickOf(h: ChangeHeader | undefined): number | undefined {
	const tick = whoOf(h).tick
	return typeof tick === "number" ? tick : undefined
}

// who made a change: the header's actor, and its metadata (process, name, run, mark, handler,
// caller, person, trusted, cause, message, tick), the innermost of each: the metadata merges the
// levels, inner over outer
export function whoOf(h: ChangeHeader | undefined): Record<string, unknown> {
	return { ...h?.metadata, actor: h?.actor }
}

// the "?" on a demo's try line shows the longer story under it (browser only; no dom types here)
type El = { onclick: unknown; hidden: boolean }
export function tryLine() {
	const doc = (globalThis as { document?: { querySelector(q: string): El | null } }).document
	const more = doc?.querySelector(".try .more")
	const body = doc?.querySelector(".try-more")
	if (more && body) more.onclick = () => (body.hidden = !body.hidden)
}
