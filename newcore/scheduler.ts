// the reference scheduler (core/scheduler/SCHEDULER.tex), over newcore's libraries: it holds the
// table, places, a trackgraph and one notify per node, and hooks them up. no library knows another:
// places says what a read rested on (depend), the scheduler tracks it in the trackgraph and asks
// that node's notify to watch it; mutate tells the scheduler each patch (patched), the scheduler
// tells the node's notify, and notify's reads mark the processes that read there.
//
// processes are ephemeral nodes made by start; one is killed when its node goes, by outro.
// a program: a setup, run once; a compute, run again when what it read changes; or an effect, a
// compute whose value is acted on. no history: each process's value and status are versions of its
// node's value, its latest run a node named run inside it; four moments go to the hooks.
// what scheduler() answers is the host's interface.
import { decode, encode } from "cbor-x"
import createBecause from "./because.ts"
import createChange, { type Change, type Header } from "./change.ts"
import mutate, { type Which } from "./mutate.ts"
import createNode, { type Node, type Version } from "./node.ts"
import { createNotify, type Facts, facts, type Patch, type Read as Watch } from "./notify.ts"
import {
	type Address,
	createPlaces,
	type Depend,
	type Item,
	type Part,
	type Place,
	type Span,
	type Step,
} from "./places.ts"
import {
	type Answer,
	anyone,
	type Ask,
	check,
	edit,
	list as listAsk,
	type May,
	pass as passing,
	placing,
	read as readAsks,
	type Which as Object,
} from "./protect.ts"
import { capture } from "./stacktrace.ts"
import { createTable } from "./table.ts"
import { createTrackgraph, type Node as Track } from "./trackgraph.ts"

type N = Node<unknown, Change>
type V = Version<unknown, Change>

// what a part, handler or cleanup is: a function called with one map
type Fn = (given: never) => unknown
export type Code = Fn | { readonly compute: Fn; readonly effect?: Fn }

// waiting: a compute returns it, or code gives it, while what it needs is not here
export const PENDING: unique symbol = Symbol.for("ermine.pending")

// a program found by path: its code, and the node and time it came from
export type Found = { code: Code; program: { node: string; time: number } }
// what code is given of a process
export type Process = { id: string; name: string; place: Place; program: Address }
// the host's: finds a process's code by its program's path, reading through view (tracked)
export type Finder = (process: Process, view: Api) => Found | typeof PENDING

export type Ended = "done" | "pending" | "failed" | "stopped" | "parked"

// the moments (SCHEDULER.tex, Hooks)
export type Moment =
	| { due: string; by: number }
	| { starts: string; run?: number; handler?: string; rank?: number }
	| {
		reads: string
		run?: number
		handler?: string
		cleanup?: true
		op: string
		items: unknown[]
		tracked: boolean
	}
	| {
		ends: string
		run?: number
		handler?: string
		ended: Ended
		equal?: boolean
		error?: unknown
		waits?: string
	}
export type Hook = (moment: Moment) => void

export type Options = {
	// the root's id; the host introduces its node (intro), or one is made holding nothing
	root: string
	// who the host's own changes are by
	actor?: unknown
	// the last time given; each change takes the next
	clock?: { time: number }
	hooks?: readonly Hook[]
	// finds the code of a process whose program is a path (LOADERS.tex)
	code?: Finder
	// a fresh id for a node made at a time; "@" and the time if not given
	id?: (time: number) => string
	// who may do what (protect.ts), asked before each operation not the scheduler's own;
	// default anyone
	may?: May
}

export type ErrorCode =
	| "stopped"
	| "read-only"
	| "nothing-there"
	| "not-a-handler"
	| "not-a-process"
	| "wrong-field"
	| "refused"

export class SchedulerError extends Error {
	// refused: protect's why, or {code: "pending"} where it did not know yet
	constructor(readonly code: ErrorCode, message?: string, readonly why?: unknown) {
		super(message === undefined ? code : `${code}: ${message}`)
	}
}

// a status (SCHEDULER.tex, Status); empty: the value is current
type Status = {
	pending?: number
	error?: unknown
	new?: unknown
	loop?: { through: string[]; value?: unknown }
}

// an actor of the scheduler's shape (SCHEDULER.tex, What a process acts as)
type Agent = { actor: unknown; code: Record<string, unknown>[]; [field: string]: unknown }

// what caused a run in its request: its process, and the causes of each change that marked it
class Cause {
	constructor(readonly id: string, readonly parents: readonly Cause[]) {}
}

// a change that marked a process: its where and header (SCHEDULER.tex, Marks), and its causes
export type By = Header & { node: string; which?: Which | "loaded" }
type Kept = { by: By; causes?: Cause }

type Child = { proc: Proc; name: string; part: string; replaced: number }
type Cleanup = (given: { killed: boolean; api: Api }) => unknown
type ReadEntry = { op: string; address?: Address; name?: string; tracked: boolean; times: number[] }

type Proc = {
	id: string
	name: string
	// names from the root to its .
	place: string[]
	// its actor, but for its own step
	base: Record<string, unknown>
	prefix: Record<string, unknown>[]
	started: number
	path?: Address
	code?: Code
	program?: { node: string; time: number }
	equal?: (a: unknown, b: unknown) => boolean
	parent?: Proc
	children: Child[]
	// ephemeral nodes it owns, in the order made
	owned: string[]
	runs: number
	replaced: boolean
	replacements: number
	setup: boolean
	// what marked it since a run ended done, by time
	kept: Map<number, Kept>
	last?: { value: unknown }
	status: Status
	since?: number
	// the processes whose nodes its last run that did not stop read
	values: Set<string>
	waiting?: Run
	cleanups: Cleanup[]
	after?: Proc
	previous?: { value: unknown }
	run?: string
	parked: boolean
	looping?: string[]
	state: "running" | "killing" | "gone"
	busy: number
	track: Track<Owner>
}

type Run = {
	p: Proc
	n: number
	mark: number
	given: Kept[]
	causes: Cause
	reads: ReadEntry[]
	wrote: number[]
	values: Set<string>
	rank: number
	part?: "setup" | "effect"
	value?: unknown
	equal?: boolean
	why?: string
	shown?: { value: unknown }
	stopped?: Proc
	replaced: boolean
	looping?: string[]
}

type PartCall = { part: string; before: Child[]; matched: Set<Child>; replaced: boolean }

type Ctx = {
	p: Proc
	agent: Agent
	base: { run?: number; handler?: string; cleanup?: true }
	run?: Run
	compute?: boolean
	causes?: Cause
	cause?: unknown
	call?: PartCall
}

// a trackgraph node's owner: a process, or a spot (a part of a node something read)
type Spot = { id: string; part: Part; key: string; track: Track<Owner>; watch?: Watch }
type Owner = { proc: Proc } | { spot: Spot }

// who a change is by, as places asks for it
type Acting = { actor: unknown; reader?: string; cause?: unknown; site?: Header["site"] }

// what the host and a part act through: reads, and writes unless read only
export type Api = {
	look(address: Address): Item<unknown, Change>[]
	lookup(path: readonly string[]): Item<unknown, Change>[]
	lookups(path: readonly string[]): Item<unknown, Change>[]
	children(address: Address, name?: string): Item<unknown, Change>[] | string[]
	content(address: Address): (Item<unknown, Change> & { versions?: V[] })[]
	info(address: Address, name: string): (Item<unknown, Change> & { versions?: V[] })[]
	write(address: Address, patches: Iterable<Patch>, index?: number, slotindex?: Span): Change
	set(
		address: Address,
		name: string,
		patches: Iterable<Patch>,
		index?: number,
		slotindex?: Span,
	): Change
	insert(id: string, name: string, child: string, index?: Span, slotindex?: Span): Change
	remove(id: string, name: string, index: Span, slotindex?: Span): Change
	pop(id: string, name: string, slotindex: Span): Change
	rename(id: string, name: string, to: string): Change[]
	move(
		id: string,
		name: string,
		index: number,
		toid: string,
		toname: string,
		toindex?: number,
	): Change[]
	// a new node holding value (none: no value); a process may make it ephemeral
	create(value?: unknown, options?: { id?: string; ephemeral?: boolean }): string
}

export type StartOp = {
	address: Address
	program: Address | Code
	name?: string
	id?: string
	args?: Record<string, unknown>
	equal?: (a: unknown, b: unknown) => boolean
	// the host's: where the address is read from; default the root
	place?: Place
}
export type CallOp = {
	address: Address
	args?: unknown
	place?: Place
	// the host's: who calls, and whether a person did
	actor?: unknown
	person?: unknown
	trusted?: boolean
}

// the newcore files a site is not in
const ours: ReadonlySet<string> = new Set(
	[
		"scheduler.ts",
		"places.ts",
		"mutate.ts",
		"change.ts",
		"node.ts",
		"table.ts",
		"notify.ts",
		"trackgraph.ts",
		"stacktrace.ts",
		"because.ts",
	].map((f) => new URL(`./${f}`, import.meta.url).href),
)

class Stop {
	constructor(readonly at: Proc) {}
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const isAgent = (a: unknown): a is Agent =>
	a !== null && typeof a === "object" && "actor" in a && Array.isArray((a as Agent).code)
const normal = (a: unknown): Agent => (isAgent(a) ? a : { actor: a, code: [] })
// the agent with fields added to its last step; an empty code becomes that one step
function stepped(a: unknown, add: Record<string, unknown>): Agent {
	const agent = normal(a)
	const last = agent.code[agent.code.length - 1]
	const code = last ? [...agent.code.slice(0, -1), { ...last, ...add }] : [add]
	return { ...agent, code }
}

const isPromise = (v: unknown) =>
	v !== null && (typeof v === "object" || typeof v === "function") &&
	typeof (v as { then?: unknown }).then === "function"
const isMap = (v: unknown) =>
	v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype
const isLive = (v: unknown) => typeof v === "function" || typeof v === "symbol"

// a copy, as the scheduler writes it; a live value, or one cbor cannot carry: itself
function copy(v: unknown): unknown {
	if (v === null || typeof v !== "object") return v
	try {
		return decode(encode(v))
	} catch {
		return v
	}
}

// why an effect part ran: its value not the same (SCHEDULER.tex, Processes, Why)
function whyNew(v: unknown, given: boolean): string {
	if (given) return "not equal by its comparison"
	if (Array.isArray(v)) return "a new list"
	if (v instanceof Uint8Array) return "new bytes"
	if (ArrayBuffer.isView(v)) return "a new typed array"
	if (isMap(v)) return "a new map"
	if (typeof v === "object" && v !== null || isLive(v)) return "a new live value"
	return "not equal"
}

// two statuses are the same when their fields are; errors when their messages are
function sameStatus(a: Status, b: Status): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)])
	for (const k of keys) {
		const x = (a as Record<string, unknown>)[k]
		const y = (b as Record<string, unknown>)[k]
		if (x === undefined || y === undefined) return false
		if (JSON.stringify(x) !== JSON.stringify(y)) return false
	}
	return true
}

// an error as a status holds it
function errorOf(e: unknown): unknown {
	if (e instanceof SchedulerError) return { code: e.code, message: e.message }
	if (e instanceof Error) {
		const out: Record<string, unknown> = { name: e.name, message: e.message }
		const code = (e as { code?: unknown }).code
		if (code !== undefined) out.code = code
		return out
	}
	return e
}

// the names from the root an address reaches from a place
function absolute(place: Place, address: Address): string[] {
	let i = 0
	const names = address[0] === "/" ? (i = 1, []) : [...place]
	for (; address[i] === ".."; i++) names.pop()
	return [...names, ...address.slice(i)]
}

const partKey = (id: string, part: Part) =>
	`${id}\u0000${typeof part === "string" ? part : part.join("\u0000")}`
const whichKey = (w: Which) => (typeof w === "string" ? w : w.join("\u0000"))
const pathOf = (w: Which): string[] => (typeof w === "string" ? [w] : [...w])

export function pidOf(time: number): string {
	return `@${time}`
}

export function createScheduler(options: Options) {
	const clock = options.clock ?? { time: 0 }
	const hooks = options.hooks ?? []
	const fresh = options.id ?? pidOf
	const hostActor = options.actor ?? "host"
	const finder = options.code
	const may = options.may ?? anyone

	const table = createTable<unknown, Change>()
	const graph = createTrackgraph<Owner>()

	// who the changes now being made are by; set around each operation
	let acting: Acting | undefined
	// whether mutate's patches are heard, or the operation is told to notify whole
	let hearing = true
	type Heard = { patch: Patch; facts: Facts; id: string; which: Which; header: Header }
	const heard: Heard[] = []
	const made: Header[] = []
	function by(): Header {
		if (acting === undefined) throw new Error("a change made outside an operation")
		const h: Header = { ...acting, time: ++clock.time }
		made.push(h)
		if (!hearing) return h
		return { ...h, patched: hear } as Header
	}
	const hear = (patch: Patch, facts: Facts, id: string, which: Which) =>
		void heard.push({ patch, facts, id, which, header: made[made.length - 1] })

	const places = createPlaces<unknown, Change>(table.get, options.root, { by })

	const procs = new Map<string, Proc>()
	const dueList = new Map<string, number>()
	const ephemeral = new Set<string>()
	const owners = new Map<string, Proc>()
	const runs = new Map<string, Proc>()
	const waiting: Run[] = []
	const queue: (() => void)[] = []
	const deferred: { p: Proc; cause: By }[] = []

	let depth = 0
	let inRound = false
	let active = 0
	const ran = new Set<string>()
	const stamped: Kept[] = []

	const pass = (m: Moment) => {
		for (const h of hooks) h(m)
	}

	// spots and notify: what was read, and the watch on it

	const spots = new Map<string, Spot>()
	const spotsOf = new Map<string, Set<Spot>>()
	const notifies = new Map<string, ReturnType<typeof createNotify>>()

	// a node as notify walks it: plain maps, every version
	function view(n: N, path?: string[], vs?: V[]): Record<string, unknown> {
		const out: Record<string, unknown> = {
			value: n.value,
			info: Object.fromEntries(n.info),
			children: Object.fromEntries(n.children),
		}
		if (path === undefined) return out
		if (path[0] === "value") out.value = vs ?? []
		else {
			const m = out[path[0]] as Record<string, unknown>
			if (vs === undefined || vs.length === 0) delete m[path[1]]
			else m[path[1]] = vs
		}
		return out
	}

	function spot(id: string, part: Part): Spot {
		const key = partKey(id, part)
		let s = spots.get(key)
		if (s) return s
		s = { id, part, key, track: undefined as unknown as Track<Owner> }
		s.track = graph.node({ spot: s })
		spots.set(key, s)
		let of = spotsOf.get(id)
		if (!of) spotsOf.set(id, of = new Set())
		of.add(s)
		watch(s)
		return s
	}

	// notify watches what is read: an object deep, a node's names not
	function watch(s: Spot) {
		if (s.watch || s.part === "loaded") return
		const n = table.get(s.id)
		if (!n) return
		let nf = notifies.get(s.id)
		if (!nf) notifies.set(s.id, nf = createNotify(() => view(n)))
		const path = s.part === "value" ? ["value"] : [...s.part]
		const names = path.length === 1 && path[0] === "children"
		s.watch = nf.read(path, { deep: !names })
		s.watch.on(() => fire(s))
	}

	// the change being told, for the marks it makes
	let telling: { by: By; causes?: Cause; own?: Proc } | undefined

	// readers of a spot: marked by the change being told
	function fire(s: Spot) {
		if (!telling) return
		for (const l of [...graph.readers(s.track)]) {
			const o = l.from.owner
			if (!("proc" in o)) continue
			const q = o.proc
			if (q.state !== "running" || q === telling.own) continue
			mark(q, telling.by, telling.causes)
		}
	}

	function tell(id: string, patch: Patch, f: Facts | (() => Facts)) {
		const nf = notifies.get(id)
		if (nf) nf.patched(patch, typeof f === "function" ? f() : f)
	}

	// a whole object of a node, from old versions to what it has now
	function whole(n: N, which: Which, old: V[] | undefined) {
		const path = pathOf(which)
		const now = versionsOf(n, which)
		if ((old?.length ?? 0) === 0 && now.length === 0) return
		const patch: Patch = now.length ? { path, value: now } : { path }
		tell(n.id, patch, () => facts(patch, view(n, path, old)))
	}

	function versionsOf(n: N, which: Which): V[] {
		if (which === "value") return n.value
		const m = (which[0] === "info" ? n.info : n.children) as Map<string, V[]>
		return m.get(which[1]) ?? []
	}

	// whether the object was there before the change, from its first patch's facts: a patch
	// below [] needs it there; an empty list is none
	function existed(h: Heard): boolean {
		if (h.patch.path.length > 0) return true
		const list = h.which !== "value" && h.which[0] === "children"
		if (h.patch.range === undefined) return h.facts.place.had
		return list ? h.facts.place.length > 0 : true
	}

	// what mutate told, to notify: each patch under its version, or the object whole where a
	// version was made or went
	function flush(slot: number | null) {
		const all = heard.splice(0)
		for (let i = 0; i < all.length;) {
			const first = all[i]
			let j = i + 1
			while (
				j < all.length && all[j].id === first.id &&
				whichKey(all[j].which) === whichKey(first.which) &&
				all[j].header === first.header
			) j++
			const group = all.slice(i, j)
			i = j
			const n = table.get(first.id)
			if (!n) continue
			telling!.by = { ...first.header, node: first.id, which: first.which }
			const now = versionsOf(n, first.which)
			const was = existed(first)
			const at = slot ?? -1
			const mine = at >= 0 ? now[at] : undefined
			if (mine && was && mine.change?.time === first.header.time) {
				// the facts hold under the prefix: at [], the version map, "content" there
				const pre = [...pathOf(first.which), at, "content"]
				for (const h of group) {
					const patch: Patch = { ...h.patch, path: [...pre, ...h.patch.path] }
					if (h.patch.move) {
						patch.move = { ...h.patch.move, path: [...pre, ...h.patch.move.path] }
					}
					tell(n.id, patch, h.facts)
				}
				continue
			}
			// made or gone: the object whole. its old first content is not kept, only that it was
			const rest = now.filter((v) => v.change?.time !== first.header.time)
			const old = was
				? [{ content: null, change: undefined as unknown as Change }, ...rest]
				: rest
			whole(n, first.which, old)
		}
	}

	// an operation making changes: by whom, then notify told, the readers marked
	function changing<T>(
		who: Acting,
		o: { causes?: Cause; own?: Proc; run?: Run; slot?: number | null; snap?: [string, Which][] },
		f: () => T,
	): T {
		const was = { acting, hearing, telling }
		const snaps = (o.snap ?? []).map(([id, which]) => {
			const n = table.get(id)
			return { n, which, old: n ? versionsOf(n, which) : undefined }
		})
		acting = who
		hearing = o.snap === undefined
		const start = made.length
		let out: T
		try {
			out = f()
		} catch (e) {
			heard.length = 0
			made.length = start
			throw e
		} finally {
			acting = was.acting
			hearing = was.hearing
		}
		const mine = made.splice(start)
		const header = mine[mine.length - 1]
		telling = {
			by: { ...(header ?? { time: clock.time }), node: "" },
			causes: o.causes,
			own: o.own,
		}
		try {
			if (o.snap === undefined) flush(o.slot === undefined ? 0 : o.slot)
			else {
				for (const s of snaps) {
					if (!s.n) continue
					telling.by = { ...header, node: s.n.id, which: s.which }
					if (versionsOf(s.n, s.which) !== s.old) whole(s.n, s.which, s.old)
				}
			}
		} finally {
			telling = was.telling
		}
		if (o.run) { for (const h of mine) o.run.wrote.push(h.time!) }
		return out
	}

	// loading: a node in, or out, which kills the process it was

	function loaded(id: string, change: By) {
		const s = spots.get(partKey(id, "loaded"))
		if (!s) return
		const was = telling
		telling = { by: change }
		try {
			fire(s)
		} finally {
			telling = was
		}
	}

	// time: a node made now is loaded by its making's change
	function intro(node: N, who: Acting = { actor: hostActor }, time = ++clock.time) {
		table.intro(node)
		for (const s of spotsOf.get(node.id) ?? []) watch(s)
		loaded(node.id, { ...who, time, node: node.id, which: "loaded" })
	}

	// no longer loaded; a process whose node it was, killed; ephemeral nodes it owned, released
	function outro(id: string, who: Acting = { actor: hostActor }) {
		const cause: By = { ...who, time: ++clock.time, node: id, which: "loaded" }
		release(id, cause)
		const p = procs.get(id)
		if (p?.state === "running") kill([p], cause)
	}

	function release(id: string, cause: By) {
		if (!table.get(id)) return
		table.outro(id)
		notifies.delete(id)
		for (const s of spotsOf.get(id) ?? []) s.watch = undefined
		ephemeral.delete(id)
		const owner = owners.get(id)
		if (owner) {
			owners.delete(id)
			owner.owned = owner.owned.filter((x) => x !== id)
		}
		const r = runs.get(id)
		if (r) {
			runs.delete(id)
			r.run = undefined
		}
		loaded(id, cause)
	}

	// causes and loops

	function caused(c: Cause | undefined, id: string): boolean {
		if (!c || !ran.has(id)) return false
		const seen = new Set<Cause>([c])
		const stack = [c]
		while (stack.length) {
			const x = stack.pop()!
			if (x.id === id) return true
			for (const q of x.parents) if (!seen.has(q)) (seen.add(q), stack.push(q))
		}
		return false
	}
	function idsOf(c: Cause): string[] {
		const ids = new Set<string>()
		const seen = new Set<Cause>([c])
		const stack = [c]
		while (stack.length) {
			const x = stack.pop()!
			ids.add(x.id)
			for (const q of x.parents) if (!seen.has(q)) (seen.add(q), stack.push(q))
		}
		return [...ids].sort(byCodePoint)
	}

	// rank, kept: made again only where what some process is after changed

	let rankOf: Map<Proc, number> | undefined
	const named = new Map<string, number>()
	const name = (id: string, d: 1 | -1) => {
		const n = (named.get(id) ?? 0) + d
		if (n > 0) named.set(id, n)
		else named.delete(id)
	}
	const edge = (p: Proc, q: Proc | undefined) =>
		q !== undefined && q !== p && q.state === "running"
	function started(p: Proc) {
		if (named.has(p.id)) rankOf = undefined
		else rankOf?.set(p, 0)
	}
	function sees(p: Proc, next: Set<string>) {
		for (const id of p.values) {
			if (next.has(id)) continue
			name(id, -1)
			if (edge(p, procs.get(id))) rankOf = undefined
		}
		for (const id of next) {
			if (p.values.has(id)) continue
			name(id, 1)
			if (edge(p, procs.get(id))) rankOf = undefined
		}
		p.values = next
	}
	function waits(p: Proc, q: Proc | undefined) {
		if (p.after === q) return
		if (p.after) {
			name(p.after.id, -1)
			if (edge(p, p.after)) rankOf = undefined
		}
		p.after = q
		if (q) {
			name(q.id, 1)
			if (edge(p, q)) rankOf = undefined
		}
	}

	// agents

	function agentOf(p: Proc, step: Record<string, unknown>): Agent {
		const own: Record<string, unknown> = { process: p.id }
		if (p.program) own.program = p.program
		return { ...p.base, code: [...p.prefix, { ...own, ...step }] } as Agent
	}
	const runAgent = (p: Proc, n: number) => agentOf(p, n > 0 ? { run: n } : {})

	// bookkeeping at a process's node: its value behind its status, in front

	// the status a process's node shows, as a version in front of its value
	function writeStatus(p: Proc, status: Status, n = p.runs, causes?: Cause, force = false) {
		if (p.state !== "running") return
		const node = table.get(p.id)
		if (!node) return
		const had = Object.keys(p.status).length > 0
		const has = Object.keys(status).length > 0
		if (!force && !had && !has) return
		const agent = agentOf(p, { ...(n > 0 ? { run: n } : {}), status })
		changing({ actor: agent, reader: p.id }, { own: p, causes, snap: [[p.id, "value"]] }, () => {
			const change = createChange(p.id, by())
			const version: V = {
				content: status,
				change,
				because: createBecause("scheduler", "status"),
			}
			if (!had && has) node.value = [version, ...node.value]
			else if (had && has) node.value = [version, ...node.value.slice(1)]
			else if (had && !has) node.value = node.value.slice(1)
			else node.value = node.value.map((v) => ({ ...v, change }))
		})
		p.status = status
	}

	function writeValue(p: Proc, value: unknown, status: Status, run: Run) {
		const node = table.get(p.id)
		if (p.state !== "running" || !node) return
		p.last = { value }
		const had = Object.keys(p.status).length > 0
		const agent = agentOf(p, { run: run.n, status })
		const at = had ? 1 : 0
		changing({ actor: agent, reader: p.id }, {
			own: p,
			causes: run.causes,
			snap: [[p.id, "value"]],
		}, () => {
			const change = createChange(p.id, by())
			const vs = node.value.slice()
			vs[at] = { content: isLive(value) ? value : copy(value), change }
			node.value = vs
		})
		if (!sameStatus(status, p.status)) writeStatus(p, status, run.n, run.causes)
	}

	function pendingAt(p: Proc) {
		const status = { ...p.status, pending: p.since ?? dueList.get(p.id)! }
		if (!sameStatus(status, p.status)) writeStatus(p, status)
	}

	// a node made, as the acting one: loaded, not yet placed
	function make(id: string | undefined, value: unknown, who: Acting, has = true): string {
		const time = clock.time + 1
		let pid = id ?? fresh(time)
		if (id === undefined) { for (let k = 1; table.get(pid); k++) pid = `${fresh(time)}-${k}` }
		const header: Header = { ...who, time: ++clock.time }
		const change = createChange(pid, header)
		const node = createNode<unknown, Change>(
			pid,
			has ? { value: [{ content: value, change }] } : {},
			{
				header,
			},
		)
		intro(node, who, header.time)
		return pid
	}

	// the latest run, the value of a node named run inside the process
	function writeRun(p: Proc, run: Run, ended: Ended, error?: unknown) {
		if (p.state !== "running" || !table.get(p.id)) return
		const value: Record<string, unknown> = {
			run: run.n,
			program: p.program ?? null,
			by: run.given.map((k) => k.by.time),
			reads: run.reads,
			wrote: run.wrote,
			rank: run.rank,
			ended,
			after: afterOf(p),
		}
		if (ended === "stopped" && run.stopped) value.waits = run.stopped.id
		if (run.equal !== undefined) value.equal = run.equal
		if (error !== undefined) value.error = error
		const agent = agentOf(p, { run: run.n, status: p.status })
		const who = { actor: agent, reader: p.id }
		const how = { own: p, causes: run.causes }
		const there = p.run === undefined ? undefined : table.get(p.run)
		if (there) {
			changing(who, how, () => mutate(there, "value", [{ path: [], value }], by()))
			return
		}
		const id = make(undefined, value, who)
		ephemeral.add(id)
		p.run = id
		runs.set(id, p)
		changing(who, how, () => places.insert(p.id, "run", id))
	}

	// marks

	function mark(q: Proc, change: By, causes?: Cause) {
		if (!q.kept.has(change.time!)) {
			const k: Kept = { by: change, causes }
			q.kept.set(change.time!, k)
			if (causes) stamped.push(k)
		}
		const loop = caused(causes, q.id)
		q.looping = loop ? idsOf(causes!) : undefined
		if (q.parked) {
			if (loop) return
			q.parked = false
		}
		becomes(q, change.time!)
	}

	function becomes(q: Proc, time: number) {
		if (dueList.has(q.id)) return
		dueList.set(q.id, time)
		q.since ??= time
		pass({ due: q.id, by: time })
	}

	// reads

	// items of process nodes that are due: a compute's read stops, unless that process waits
	// after it; otherwise their pending is written first
	function reached(items: readonly { id: string; node?: unknown }[]): Proc[] {
		const out: Proc[] = []
		for (const it of items) {
			const q = procs.get(it.id)
			if (q && it.node && dueList.has(q.id) && !out.includes(q)) out.push(q)
		}
		return out
	}

	function waitsAfter(q: Proc, r: Proc): boolean {
		const seen = new Set<Proc>()
		for (let x = q.after; x && !seen.has(x); x = x.after) {
			if (x === r) return true
			seen.add(x)
		}
		return false
	}

	// the times of the changes that set what a read got
	function times(items: readonly unknown[]): number[] {
		const out: number[] = []
		const add = (t: unknown) => {
			if (typeof t === "number" && !out.includes(t)) out.push(t)
		}
		for (const it of items) {
			if (typeof it !== "object" || it === null) continue
			const i = it as { route?: { node: string; name: string }[]; versions?: V[] }
			if (i.versions) { for (const v of i.versions) add(v.change?.time) }
			const step = i.route?.[i.route.length - 1]
			if (step) add(table.get(step.node)?.children.get(step.name)?.[0]?.change?.time)
		}
		return out
	}

	type Reader = (depend?: Depend) => unknown

	// a read: as ctx's process, tracked when given a depend; the hooks and the run see it
	function reading(
		op: string,
		f: Reader,
		depend: Depend | undefined,
		ctx?: Ctx,
		args: { address?: Address; name?: string } = {},
	): unknown {
		let out = f(depend)
		const items = (Array.isArray(out) ? out : []).filter((x) => typeof x === "object") as Item<
			unknown,
			Change
		>[]
		const due = op === "children" ? [] : reached(items)
		if (due.length) {
			if (ctx?.compute && ctx.run) {
				for (const q of due) {
					if (q !== ctx.p && !waitsAfter(q, ctx.p)) {
						ctx.run.stopped = q
						throw new Stop(q)
					}
				}
			}
			const before = clock.time
			for (const q of due) pendingAt(q)
			if (clock.time !== before) out = f(undefined)
		}
		if (ctx) {
			const tracked = depend !== undefined
			pass({ reads: ctx.p.id, ...ctx.base, op, items: Array.isArray(out) ? out : [], tracked })
			const run = ctx.run
			if (run) {
				const entry: ReadEntry = { op, tracked, times: times(Array.isArray(out) ? out : []) }
				if (args.address !== undefined) entry.address = args.address
				if (args.name !== undefined) entry.name = args.name
				run.reads.push(entry)
				if (ctx.compute && op !== "children") {
					for (const it of items) if (it.node && procs.has(it.id)) run.values.add(it.id)
				}
			}
		}
		return out
	}

	// protect: asked as the actor, before each operation not the scheduler's own. the policy's
	// own reads are the asker's: tracked when it is

	const policyRead = (depend?: Depend) => (id: string) => {
		depend?.(id, "loaded")
		const n = table.get(id)
		if (!n) return undefined
		depend?.(id, "value")
		return n.value.length ? { value: n.value[0].content } : {}
	}
	const ask = (actor: unknown, asks: Iterable<Ask>, depend?: Depend): Answer =>
		check(may, actor, asks, policyRead(depend)).answer
	function allowed(answer: Answer, op: string) {
		if ("yes" in answer) return
		const why = "no" in answer ? answer.no : { code: "pending" }
		throw new SchedulerError("refused", `${op}: ${why.code}`, why)
	}
	const readAsk = (node: string, object: Object): Ask => ({ op: "read", args: { node, object } })

	// items as the actor may have them: passing each step of its route, and reading the object
	// read; refused: no node, and why; pending: no node
	function guard<T extends { id: string; route: Step[]; node?: unknown }>(
		items: T[],
		actor: unknown,
		depend?: Depend,
		object?: Object,
	): T[] {
		return items.map((it) => {
			const asks = passing(it.route)
			if (it.node && object) asks.push(readAsk(it.id, object))
			const a = ask(actor, asks, depend)
			if ("yes" in a) return it
			const { node: _n, versions: _v, ...rest } = it as T & { versions?: unknown }
			const out = rest as unknown as T & { refused?: unknown }
			if ("no" in a) out.refused = a.no
			return out
		})
	}

	// what reaching a node to write it asks: passing its route, then the edit
	function writing(
		pl: Place,
		address: Address,
		index: number | undefined,
		object: Object,
		slotindex: Span | undefined,
	): Ask[] {
		const items = places.look(pl, address)
		const it = index === undefined ? items.find((i) => i.node) : items[index]
		if (!it?.node) return []
		return [...passing(it.route), edit("write", it.id, object, slotindex ?? 0)]
	}

	// placing an id: and reading it, where its node is loaded
	function placed(
		node: string,
		name: string,
		before: readonly unknown[],
		after: readonly unknown[],
	) {
		const asks = placing(node, name, before, after)
		for (const a of [...asks]) {
			if (a.op !== "place") continue
			const n = table.get(a.args.id!)
			if (n) asks.push(...readAsks(n))
		}
		return asks
	}
	const idsAt = (id: string, name: string, slotindex?: Span) => {
		const at = slotindex === undefined
			? 0
			: typeof slotindex === "number"
			? slotindex
			: slotindex[0]
		return (table.get(id)?.children.get(name)?.[at]?.content ?? []) as readonly unknown[]
	}

	// the interface handed to code, at a place, as an actor; it stops when alive says so

	type Bind = {
		ctx?: Ctx
		place: Place
		agent: unknown
		reader?: string
		depend?: Depend
		writes: boolean
		alive: () => boolean
		// a process's own: may make ephemeral nodes
		owner?: Proc
	}

	function bound(b: Bind): Api {
		const live = (op: string) => {
			if (!b.alive()) throw new SchedulerError("stopped", `${op}: this interface has stopped`)
		}
		const r = (op: string, f: Reader, args?: { address?: Address; name?: string }) => {
			live(op)
			return reading(op, f, b.depend, b.ctx, args)
		}
		const pl = b.place
		const who = (): Acting => {
			const a: Acting = { actor: b.agent }
			if (b.reader !== undefined) a.reader = b.reader
			if (b.ctx?.cause !== undefined) a.cause = b.ctx.cause
			if (b.ctx === undefined) {
				const site = capture(ours)
				if (site) a.site = site
			}
			return a
		}
		const w = <T>(
			op: string,
			f: () => T,
			o: { slot?: number | null; snap?: [string, Which][] } = {},
			asks?: () => Ask[],
		): T => {
			live(op)
			if (!b.writes) throw new SchedulerError("read-only", `${op}: a compute only reads`)
			if (asks) allowed(ask(b.agent, asks()), op)
			return request(() =>
				changing(who(), {
					...o,
					causes: b.ctx?.causes,
					run: b.ctx?.run,
				}, f)
			)
		}
		const slot = (s?: Span) => (s === undefined ? 0 : typeof s === "number" ? s : null)
		const mayPlace = (child: string) => {
			if (ephemeral.has(child) && b.owner === undefined) {
				throw new SchedulerError(
					"not-a-process",
					"only a process makes, places or moves an ephemeral node",
				)
			}
		}
		return {
			look: (address) =>
				r("look", (d) => guard(places.look(pl, address, d), b.agent, d), { address }) as Item<
					unknown,
					Change
				>[],
			lookup: (path) =>
				r("lookup", (d) => guard(places.lookup(pl, path, d), b.agent, d), {
					address: path,
				}) as Item<unknown, Change>[],
			lookups: (path) =>
				r("lookups", (d) => guard(places.lookups(pl, path, d), b.agent, d), {
					address: path,
				}) as Item<unknown, Change>[],
			children: (address, name) =>
				r("children", (d) => {
					if (name !== undefined) {
						return guard(
							places.children(pl, address, name, d) as Item<unknown, Change>[],
							b.agent,
							d,
						)
					}
					// names: of each node the actor may reach and list
					const seen = new Set<string>()
					for (const it of guard(places.look(pl, address, d), b.agent, d)) {
						if (!it.node || !("yes" in ask(b.agent, [listAsk(it.id)], d))) continue
						d?.(it.id, ["children"])
						for (const k of it.node.children.keys()) seen.add(k)
					}
					return [...seen]
				}, { address, name }) as Item<unknown, Change>[] | string[],
			content: (address) =>
				r("content", (d) => guard(places.content(pl, address, d), b.agent, d, "value"), {
					address,
				}) as ReturnType<Api["content"]>,
			info: (address, name) =>
				r("info", (d) => guard(places.info(pl, address, name, d), b.agent, d, ["info", name]), {
					address,
					name,
				}) as ReturnType<Api["info"]>,
			write: (address, patches, index, slotindex) =>
				w(
					"write",
					() => places.write(pl, address, patches, index, slotindex),
					{ slot: slot(slotindex) },
					() => writing(pl, address, index, "value", slotindex),
				),
			set: (address, name, patches, index, slotindex) =>
				w(
					"set",
					() => places.set(pl, address, name, patches, index, slotindex),
					{ slot: slot(slotindex) },
					() => writing(pl, address, index, ["info", name], slotindex),
				),
			insert: (id, name, child, index, slotindex) => {
				mayPlace(child)
				return w(
					"insert",
					() => places.insert(id, name, child, index, slotindex),
					{ slot: slot(slotindex) },
					() => placed(id, name, [], [child]),
				)
			},
			remove: (id, name, index, slotindex) =>
				w(
					"remove",
					() => places.remove(id, name, index, slotindex),
					{ slot: slot(slotindex) },
					() => {
						const [a, z] = typeof index === "number" ? [index, index + 1] : index
						return placing(id, name, idsAt(id, name, slotindex).slice(a, z), [])
					},
				),
			pop: (id, name, slotindex) =>
				w(
					"pop",
					() => places.pop(id, name, slotindex),
					{ snap: [[id, ["children", name]]] },
					() => [edit("pop", id, ["children", name], slotindex)],
				),
			rename: (id, name, to) =>
				w(
					"rename",
					() => places.rename(id, name, to),
					{ snap: [[id, ["children", name]], [id, ["children", to]]] },
					() => {
						const ids = idsAt(id, name)
						return [...placing(id, name, ids, []), ...placed(id, to, [], ids)]
					},
				),
			move: (id, name, index, toid, toname, toindex) => {
				const child = table.get(id)?.children.get(name)?.[0]?.content[index]
				if (typeof child === "string") mayPlace(child)
				// within one list, order alone asks nothing
				const across = id !== toid || name !== toname
				return w(
					"move",
					() => places.move(id, name, index, toid, toname, toindex),
					{},
					() =>
						across
							? [...placing(id, name, [child], []), ...placed(toid, toname, [], [child])]
							: [],
				)
			},
			create: (value, o = {}) => {
				live("create")
				if (!b.writes) throw new SchedulerError("read-only", "create: a compute only reads")
				if (o.ephemeral && b.owner === undefined) {
					throw new SchedulerError("not-a-process", "only a process makes an ephemeral node")
				}
				const id = request(() => make(o.id, value, who(), value !== undefined))
				if (o.ephemeral) {
					ephemeral.add(id)
					owns(b.owner!, id)
				}
				return id
			},
		}
	}

	function owns(p: Proc, id: string) {
		owners.set(id, p)
		p.owned.push(id)
	}

	// what every interface of a process binds: its actor, pid, place
	function processApi(
		ctx: Ctx,
		o: { tracked?: boolean; writes: boolean; alive: () => boolean },
	): Api {
		const p = ctx.p
		return bound({
			ctx,
			place: p.place,
			agent: ctx.agent,
			reader: p.id,
			depend: o.tracked ? (id, part) => graph.track(p.track, spot(id, part).track) : undefined,
			writes: o.writes,
			alive: o.alive,
			owner: p,
		})
	}

	// starting

	function start(op: StartOp, ctx?: Ctx): { id: string; change?: Change } {
		if (!Array.isArray(op.address)) throw new SchedulerError("wrong-field", "address")
		const program = op.program
		if (
			typeof program !== "function" &&
			!Array.isArray(program) &&
			!(program && typeof (program as { compute?: unknown }).compute === "function")
		) throw new SchedulerError("wrong-field", "a program is a path or code")
		if (Array.isArray(program) && finder === undefined) {
			throw new SchedulerError("wrong-field", "a program by path needs the host's code")
		}
		const caller = ctx?.p
		const call = ctx?.call
		if (call && op.name !== undefined) {
			const child = call.before.find((c) =>
				c.name === op.name && !call.matched.has(c) && c.proc.state === "running" &&
				table.get(c.proc.id) !== undefined
			)
			if (child) {
				call.matched.add(child)
				if (Array.isArray(program)) child.proc.path = program as Address
				else child.proc.code = program as Code
				if (call.replaced && child.replaced < caller!.replacements) {
					child.replaced = caller!.replacements
					replacing(child.proc, { actor: ctx!.agent, reader: caller!.id }, ctx!.causes)
				}
				return { id: child.proc.id }
			}
		}
		const place = caller ? caller.place : [...(op.place ?? [])]
		const where = places.look(place, op.address).find((it) => it.node)
		if (!where) throw new SchedulerError("nothing-there", "the address reaches nothing")
		const who: Acting = ctx ? { actor: ctx.agent, reader: caller!.id } : (() => {
			const a: Acting = { actor: hostActor }
			const site = capture(ours)
			if (site) a.site = site
			return a
		})()
		if (ctx?.cause !== undefined) who.cause = ctx.cause
		const placing_: Ask = { op: "place", args: { node: where.id, name: op.name, id: op.id } }
		allowed(ask(who.actor, [...passing(where.route), placing_]), "start")
		const pid = make(op.id, null, who)
		ephemeral.add(pid)
		const agent = normal(who.actor)
		const { person: _p, trusted: _t, code: _c, ...rest } = agent
		const p: Proc = {
			id: pid,
			name: op.name ?? pid,
			place: absolute(place, op.address),
			base: rest,
			prefix: [...agent.code],
			started: clock.time,
			children: [],
			owned: [],
			runs: 0,
			replaced: false,
			replacements: 0,
			setup: false,
			kept: new Map(),
			status: {},
			values: new Set(),
			cleanups: [],
			parked: false,
			state: "running",
			busy: 0,
			track: undefined as unknown as Track<Owner>,
		}
		p.track = graph.node({ proc: p })
		if (op.equal) p.equal = op.equal
		if (Array.isArray(program)) p.path = program as Address
		else {
			p.code = program as Code
			if (caller?.program) p.program = caller.program
		}
		procs.set(pid, p)
		started(p)
		if (caller && caller.state !== "gone") {
			p.parent = caller
			caller.children.push({
				proc: p,
				name: p.name,
				part: call?.part ?? "request",
				replaced: caller.replacements,
			})
			owns(caller, pid)
		}
		// its arguments: nodes inside it, its own
		for (const [k, v] of Object.entries(op.args ?? {})) {
			const id = make(undefined, v, who)
			ephemeral.add(id)
			owns(p, id)
			changing(who, { causes: ctx?.causes }, () => places.insert(pid, k, id))
		}
		const change = changing(
			who,
			{ causes: ctx?.causes, run: ctx?.run },
			() => places.insert(where.id, p.name, pid),
		)
		const mine: Kept = { by: { ...change, which: ["children", p.name] }, causes: ctx?.causes }
		p.kept.set(change.time!, mine)
		if (mine.causes) stamped.push(mine)
		becomes(p, change.time!)
		return { id: pid, change }
	}

	function starter(ctx: Ctx, alive: () => boolean) {
		return (op: StartOp) => {
			if (!alive()) throw new SchedulerError("stopped", "start: this interface has stopped")
			const { place: _, ...rest } = op ?? ({} as StartOp)
			return start(rest as StartOp, ctx)
		}
	}

	// replacing: an empty write at its pid, its status without new; due by it, run as replaced

	function replacing(p: Proc, who: Acting, causes?: Cause) {
		const { new: _n, ...status } = p.status
		writeStatus(p, status, p.runs, causes, true)
		p.replaced = true
		p.replacements++
		mark(p, { ...who, time: clock.time, node: p.id, which: "value" }, causes)
	}

	// handler calls

	function calling(op: CallOp, from: { place: Place; agent: unknown; causes?: Cause }): unknown {
		const items = places.look(from.place, op.address)
		const item = items.find((it) => it.node)
		if (!item) throw new SchedulerError("nothing-there", "the address reaches nothing")
		allowed(ask(from.agent, [...passing(item.route), readAsk(item.id, "value")]), "call")
		const definer = owners.get(item.id)
		const f = item.node!.value[0]?.content
		if (
			!ephemeral.has(item.id) || !definer || definer.state !== "running" ||
			typeof f !== "function"
		) throw new SchedulerError("not-a-handler", "the node is not a handler a process placed")
		const handler = op.address[op.address.length - 1] ?? ""
		const caller = normal(from.agent)
		const step: Record<string, unknown> = { process: definer.id }
		if (definer.program) step.program = definer.program
		step.handler = handler
		const agent: Agent = { ...caller, code: [...caller.code, step] }
		const ctx: Ctx = { p: definer, agent, base: { handler }, causes: from.causes }
		pass({ starts: definer.id, handler })
		let alive = true
		const given: Record<string, unknown> = {
			api: processApi(ctx, { writes: true, alive: () => alive }),
			start: starter(ctx, () => alive),
			call: callerOf(ctx),
			self: definer.id,
			name: definer.name,
		}
		if (op.args !== undefined) given.args = op.args
		const done = part(definer, () => (f as (g: unknown) => unknown)(given))
		alive = false
		const ends: Moment = {
			ends: definer.id,
			handler,
			ended: "error" in done ? "failed" : "done",
		}
		if ("error" in done) ends.error = errorOf(done.error)
		pass(ends)
		if ("error" in done) throw done.error
		return done.value
	}

	// the call a part is given: it lasts until the process is killed
	function callerOf(ctx: Ctx) {
		return (address: Address, args?: unknown) => {
			if (ctx.p.state === "gone") {
				throw new SchedulerError("stopped", "call: the process is gone")
			}
			const op: CallOp = { address }
			if (args !== undefined) op.args = args
			const from = { place: ctx.p.place, agent: ctx.agent, causes: ctx.causes }
			if (inRound || active > 0) {
				queue.push(() => {
					try {
						calling(op, from)
					} catch { /* a queued call's error shows in its moments */ }
				})
				return
			}
			return request(() => calling(op, from))
		}
	}

	// parts

	function part(p: Proc, fn: () => unknown): { value: unknown } | { error: unknown } {
		p.busy++
		active++
		let out: { value: unknown } | { error: unknown }
		try {
			out = { value: fn() }
		} catch (e) {
			out = { error: e }
		} finally {
			p.busy--
			active--
		}
		unwind()
		return out
	}

	function cleaner(p: Proc, alive: () => boolean) {
		return (f: Cleanup) => {
			if (!alive()) throw new SchedulerError("stopped", "onCleanup: this interface has stopped")
			if (typeof f !== "function") {
				throw new SchedulerError("wrong-field", "a cleanup is a function")
			}
			p.cleanups.push(f)
		}
	}

	function cleanups(p: Proc, killed: boolean, run?: Run): unknown {
		const list = p.cleanups.reverse()
		p.cleanups = []
		let first: unknown
		for (const f of list) {
			const agent = run ? runAgent(p, run.n) : agentOf(p, { cleanup: true })
			const ctx: Ctx = {
				p,
				agent,
				base: run ? { run: run.n } : { cleanup: true },
				run,
				causes: run?.causes,
			}
			let alive = true
			const api = processApi(ctx, { writes: true, alive: () => alive })
			const done = part(p, () => f({ killed, api }))
			alive = false
			if ("error" in done && first === undefined) first = done.error
		}
		return first
	}

	// killing

	function busy(p: Proc): boolean {
		if (p.busy > 0) return true
		return p.children.some((c) => c.proc.state === "running" && busy(c.proc))
	}

	function kill(killed: Proc[], cause: By) {
		const set = new Set(killed)
		const inside = (q: Proc) => {
			for (let x = q.parent; x; x = x.parent) if (set.has(x)) return true
			return false
		}
		const roots = killed.filter((q) => !inside(q)).sort((a, b) => b.started - a.started)
		for (const q of roots) end(q, cause)
	}

	// unwinding, newest first: not due; children; cleanups; its ephemeral nodes; untracked
	function end(p: Proc, cause: By) {
		if (p.state !== "running") return
		if (busy(p)) {
			deferred.push({ p, cause })
			return
		}
		p.state = "killing"
		if (named.has(p.id)) rankOf = undefined
		rankOf?.delete(p)
		dueList.delete(p.id)
		const w = p.waiting
		if (w) {
			waiting.splice(waiting.indexOf(w), 1)
			p.waiting = undefined
			pass({ ends: p.id, run: w.n, ended: "stopped" })
		}
		const killing = { ...cause, actor: stepped(cause.actor, { kill: p.id }) }
		for (const c of [...p.children].reverse()) {
			const q = c.proc
			if (q.state !== "running") continue
			release(q.id, { ...killing, time: ++clock.time, node: q.id })
			end(q, cause)
		}
		cleanups(p, true)
		for (const id of [...p.owned].reverse()) {
			if (table.get(id)) release(id, { ...killing, time: ++clock.time, node: id })
		}
		graph.untrack(p.track)
		p.state = "gone"
		for (const id of p.values) name(id, -1)
		p.values = new Set()
		if (p.after) name(p.after.id, -1)
		p.after = undefined
		procs.delete(p.id)
		if (p.parent) p.parent.children = p.parent.children.filter((c) => c.proc !== p)
	}

	function unwind() {
		for (let i = 0; i < deferred.length;) {
			const d = deferred[i]
			if (d.p.state !== "running") deferred.splice(i, 1)
			else if (busy(d.p)) i++
			else {
				deferred.splice(i, 1)
				end(d.p, d.cause)
				i = 0
			}
		}
	}

	// runs

	const processOf = (p: Proc): Process => ({
		id: p.id,
		name: p.name,
		place: p.place,
		program: p.path ?? [],
	})

	function partCall(p: Proc, name: string, replaced: boolean): PartCall {
		return {
			part: name,
			before: p.children.filter((c) => c.part === name),
			matched: new Set<Child>(),
			replaced,
		}
	}

	// when a part's call ends done, the children it started before and not again are released
	function settleChildren(ctx: Ctx) {
		const call = ctx.call!
		const cause: By = {
			actor: stepped(ctx.agent, { kill: ctx.p.id }),
			reader: ctx.p.id,
			time: 0,
			node: "",
		}
		for (const c of [...call.before].reverse()) {
			if (call.matched.has(c) || c.proc.state !== "running") continue
			release(c.proc.id, { ...cause, time: ++clock.time, node: c.proc.id })
			end(c.proc, cause)
		}
	}

	const same = (p: Proc, v: unknown) =>
		p.last !== undefined && (p.equal ? p.equal(v, p.last.value) : Object.is(v, p.last.value))

	// a value a part may give: anything but undefined; a setup's not a promise
	function valueOf(v: unknown, setup: boolean): unknown {
		if (v === undefined || setup && isPromise(v)) {
			throw new SchedulerError("wrong-field", "value: a part gives a value")
		}
		return v
	}

	// a run's first half: code, if the program is a path; then a compute runs, and a setup or an
	// effect's part waits for the second half
	function first(p: Proc, picked: number) {
		let rank = picked
		const earlier = p.waiting
		if (earlier) {
			waiting.splice(waiting.indexOf(earlier), 1)
			p.waiting = undefined
			finish(earlier, "done", undefined, true)
			rank = ranks().get(p) ?? 0
		}
		const markTime = dueList.get(p.id)!
		dueList.delete(p.id)
		waits(p, undefined)
		const n = ++p.runs
		const given = [...p.kept.values()]
		const parents = new Set<Cause>()
		for (const k of given) if (k.causes) parents.add(k.causes)
		const causes = new Cause(p.id, [...parents])
		ran.add(p.id)
		const run: Run = {
			p,
			n,
			mark: markTime,
			rank,
			given,
			causes,
			reads: [],
			wrote: [],
			values: new Set(),
			replaced: p.replaced,
			looping: p.looping,
		}
		p.looping = undefined
		pass({ starts: p.id, run: n, rank })
		graph.begin(p.track)
		try {
			const ctx: Ctx = { p, agent: runAgent(p, n), base: { run: n }, run, compute: true, causes }
			if (p.path) {
				let alive = true
				const view = processApi(ctx, { tracked: true, writes: false, alive: () => alive })
				const found = part(p, () => finder!(processOf(p), view))
				alive = false
				if (run.stopped) return stop(run)
				const takes = p.code === undefined || p.replaced
				if ("error" in found) {
					if (takes) return finish(run, "failed", found.error)
					run.shown = { value: errorOf(found.error) }
				} else if (found.value === PENDING) {
					if (takes) return finish(run, "pending")
					run.shown = { value: null }
				} else {
					const f = found.value as Found
					if (takes) {
						p.code = f.code
						p.program = f.program
					} else if (
						!p.program || f.program.node !== p.program.node ||
						f.program.time !== p.program.time
					) run.shown = { value: f.program }
				}
			}
			const c = p.code!
			if (typeof c === "function") {
				if (p.setup && !p.replaced) return finish(run, "done")
				run.part = "setup"
				p.waiting = run
				waiting.push(run)
				return
			}
			// the compute
			const cctx: Ctx = { ...ctx, call: partCall(p, "compute", run.replaced) }
			let open = true
			const out = part(p, () =>
				(c.compute as (g: unknown) => unknown)({
					api: processApi(cctx, { tracked: true, writes: false, alive: () => open }),
					peep: processApi(cctx, { writes: false, alive: () => open }),
					start: starter(cctx, () => open),
					by: given.map((k) => k.by),
					pending: PENDING,
					self: p.id,
					name: p.name,
				}))
			open = false
			if (run.stopped) return stop(run)
			if ("error" in out) return finish(run, "failed", out.error)
			if (out.value === PENDING) return finish(run, "pending")
			if (isPromise(out.value)) return awaiting(run, out.value as Promise<unknown>, cctx)
			computed(run, cctx, out.value)
		} finally {
			graph.end(p.track)
		}
	}

	// a compute's value: compared, written, its effect part waiting if new
	function computed(run: Run, cctx: Ctx, v: unknown) {
		const p = run.p
		const c = p.code as { compute: Fn; effect?: Fn }
		let value: unknown
		try {
			value = valueOf(v, false)
		} catch (e) {
			return finish(run, "failed", e)
		}
		settleChildren(cctx)
		const equals = same(p, value)
		run.equal = equals
		if (run.looping && !equals) {
			run.value = value
			return finish(run, "parked")
		}
		if (!equals) {
			run.why = p.last === undefined ? "a first value" : whyNew(value, p.equal !== undefined)
			writeValue(p, value, shownStatus(run), run)
		}
		if (c.effect && (!equals || run.replaced)) {
			if (run.replaced) run.why = "replaced"
			run.part = "effect"
			run.value = value
			p.waiting = run
			waiting.push(run)
			return
		}
		finish(run, "done")
	}

	// an async compute: its run ends pending; the settling, unless rerun or killed since, a
	// request finishing that run
	function awaiting(run: Run, promise: Promise<unknown>, cctx: Ctx) {
		const p = run.p
		finish(run, "pending")
		const settle = (f: () => void) => {
			if (p.state !== "running" || p.runs !== run.n) return
			request(() => {
				run.reads = run.reads.slice()
				f()
			})
		}
		promise.then(
			(v) => settle(() => computed(run, cctx, v)),
			(e) => settle(() => finish(run, "failed", e)),
		)
	}

	const shownStatus = (run: Run): Status => (run.shown ? { new: run.shown.value } : {})

	// a run's second half: the cleanups before, then the setup, or the effect part
	function second(run: Run) {
		const p = run.p
		waiting.splice(waiting.indexOf(run), 1)
		p.waiting = undefined
		if (p.state !== "running") return
		const agent = runAgent(p, run.n)
		let error = cleanups(p, false, run)
		if (p.state !== "running") return finish(run, error === undefined ? "done" : "failed", error)
		const ctx: Ctx = {
			p,
			agent,
			base: { run: run.n },
			run,
			causes: run.causes,
			call: partCall(p, run.part!, run.replaced),
		}
		if (run.part === "effect") ctx.cause = run.why
		let alive = true
		const given: Record<string, unknown> = {
			api: processApi(ctx, { writes: true, alive: () => alive }),
			start: starter(ctx, () => alive),
			call: callerOf(ctx),
			onCleanup: cleaner(p, () => alive),
			self: p.id,
			name: p.name,
		}
		const c = p.code!
		if (run.part === "effect") {
			given.value = run.value
			if (p.previous) given.previous = p.previous.value
			const effect = (c as { effect: Fn }).effect
			const out = part(p, () => (effect as (g: unknown) => unknown)(given))
			alive = false
			p.previous = { value: run.value }
			if ("error" in out) error ??= out.error
			else if (p.state === "running") settleChildren(ctx)
			return finish(run, error === undefined ? "done" : "failed", error)
		}
		const out = part(p, () => (c as (g: unknown) => unknown)(given))
		alive = false
		p.setup = true
		if ("error" in out) return finish(run, "failed", error ?? out.error)
		let value: unknown
		try {
			value = valueOf(out.value, true)
		} catch (e) {
			return finish(run, "failed", error ?? e)
		}
		if (p.state !== "running") return finish(run, error === undefined ? "done" : "failed", error)
		settleChildren(ctx)
		const equals = same(p, value)
		run.equal = equals
		if (!equals) writeValue(p, value, shownStatus(run), run)
		finish(run, error === undefined ? "done" : "failed", error)
	}

	function stop(run: Run) {
		const p = run.p
		waits(p, run.stopped!)
		if (p.state === "running") dueList.set(p.id, run.mark)
		finish(run, "stopped")
	}

	function finish(run: Run, ended: Ended, error?: unknown, keep = false) {
		const p = run.p
		const json = error === undefined ? undefined : errorOf(error)
		if (p.state === "running") {
			if (ended === "done" && !keep) {
				for (const k of run.given) p.kept.delete(k.by.time!)
				p.replaced = false
			}
			if (ended === "parked") p.parked = true
			if (ended !== "stopped") sees(p, run.values)
			if (ended !== "pending" && ended !== "stopped") p.since = dueList.get(p.id)
			const status: Status = {}
			if (ended === "pending" || ended === "stopped") status.pending = p.since ?? run.mark
			if (ended === "failed") status.error = json
			if (ended === "parked") {
				const loop: { through: string[]; value?: unknown } = { through: run.looping ?? [p.id] }
				if (!isLive(run.value)) loop.value = run.value
				status.loop = loop
			}
			if (run.shown) status.new = run.shown.value
			if (!sameStatus(status, p.status)) writeStatus(p, status, run.n, run.causes)
			writeRun(p, run, ended, json)
		}
		const ends: Moment = { ends: p.id, run: run.n, ended }
		if (ended === "stopped" && run.stopped) ends.waits = run.stopped.id
		if (run.equal !== undefined) ends.equal = run.equal
		if (json !== undefined) ends.error = json
		pass(ends)
	}

	// order

	function afterOf(p: Proc): string[] {
		const out = new Set<string>()
		for (const id of p.values) if (id !== p.id && procs.get(id)?.state === "running") out.add(id)
		if (p.after && p.after !== p && p.after.state === "running") out.add(p.after.id)
		return [...out].sort(byCodePoint)
	}

	function ranks(): Map<Proc, number> {
		return rankOf ??= makeRanks()
	}

	// strongly connected components (Tarjan), each after the ones its members are after
	function makeRanks(): Map<Proc, number> {
		const rank = new Map<Proc, number>()
		const index = new Map<Proc, number>()
		const low = new Map<Proc, number>()
		const on = new Set<Proc>()
		const stack: Proc[] = []
		let next = 0
		const edges = (p: Proc) => {
			const out: Proc[] = []
			for (const id of p.values) {
				const q = id === p.id ? undefined : procs.get(id)
				if (q?.state === "running") out.push(q)
			}
			if (p.after && p.after !== p && p.after.state === "running") out.push(p.after)
			return out
		}
		const visit = (p: Proc) => {
			index.set(p, next)
			low.set(p, next++)
			stack.push(p)
			on.add(p)
			const out = edges(p)
			for (const q of out) {
				if (!index.has(q)) {
					visit(q)
					low.set(p, Math.min(low.get(p)!, low.get(q)!))
				} else if (on.has(q)) low.set(p, Math.min(low.get(p)!, index.get(q)!))
			}
			if (low.get(p) !== index.get(p)) return
			const members: Proc[] = []
			let m: Proc
			do {
				m = stack.pop()!
				on.delete(m)
				members.push(m)
			} while (m !== p)
			let r = 0
			const inside = new Set(members)
			for (const x of members) {
				for (const q of edges(x)) if (!inside.has(q)) r = Math.max(r, rank.get(q)! + 1)
			}
			for (const x of members) rank.set(x, r)
		}
		for (const p of procs.values()) if (p.state === "running" && !index.has(p)) visit(p)
		return rank
	}

	function pick(): { p: Proc; rank: number } {
		const rank = ranks()
		let best: Proc | undefined
		let bestMark = 0
		for (const [id, m] of dueList) {
			const p = procs.get(id)!
			if (p.after && dueList.has(p.after.id)) continue
			const r = rank.get(p) ?? 0
			const b = best && (rank.get(best) ?? 0)
			if (
				!best || r < b! ||
				(r === b && (m < bestMark || (m === bestMark && byCodePoint(p.id, best.id) < 0)))
			) {
				best = p
				bestMark = m
			}
		}
		return { p: best!, rank: rank.get(best!) ?? 0 }
	}

	// requests and rounds

	function round() {
		inRound = true
		try {
			while (dueList.size) {
				const next = pick()
				first(next.p, next.rank)
			}
			while (waiting.length) second(waiting[0])
		} finally {
			inRound = false
		}
		while (queue.length) queue.shift()!()
	}

	function request<T>(fn: () => T): T {
		if (depth > 0 || active > 0) return fn()
		depth++
		let out: T
		try {
			out = fn()
			while (dueList.size || queue.length) round()
		} finally {
			depth--
			for (const id of [...dueList.keys()]) {
				const p = procs.get(id)
				if (p?.state === "running") pendingAt(p)
			}
			for (const k of stamped) k.causes = undefined
			stamped.length = 0
			if (!queue.length) ran.clear()
		}
		return out
	}

	// the root: the host's, or one made holding nothing
	if (!table.get(options.root)) {
		table.intro(createNode<unknown, Change>(options.root, {}))
	}

	// the host's interface
	const host = bound({
		place: [],
		agent: hostActor,
		writes: true,
		alive: () => true,
	})
	return {
		...host,
		get: table.get,
		intro: (node: N) => request(() => intro(node)),
		outro: (id: string) => request(() => outro(id)),
		ephemeral: (id: string) => ephemeral.has(id),
		start: (op: StartOp) => request(() => start(op)),
		call(op: CallOp) {
			let agent: unknown = op.actor ?? hostActor
			if (op.person !== undefined || op.trusted !== undefined) {
				const a = { ...normal(agent) }
				if (op.person !== undefined) a.person = op.person
				if (op.trusted !== undefined) a.trusted = op.trusted
				agent = a
			}
			const from = { place: op.place ?? [], agent }
			if (inRound || active > 0) {
				queue.push(() => {
					try {
						calling(op, from)
					} catch { /* shows in the moments */ }
				})
				return
			}
			return request(() => calling(op, from))
		},
		replace(op: { address: Address; place?: Place }) {
			return request(() => {
				const item = places.look(op.place ?? [], op.address).find((it) => it.node)
				if (!item) throw new SchedulerError("nothing-there", "the address reaches nothing")
				allowed(
					ask(hostActor, [...passing(item.route), edit("write", item.id, "value")]),
					"replace",
				)
				const p = procs.get(item.id)
				if (!p || p.state !== "running") {
					throw new SchedulerError("not-a-process", "the node is no process")
				}
				replacing(p, { actor: hostActor })
			})
		},
		batch(fn: () => void) {
			let thrown: { e: unknown } | undefined
			request(() => {
				try {
					fn()
				} catch (e) {
					thrown = { e }
				}
			})
			if (thrown) throw thrown.e
		},
	}
}

export type Scheduler = ReturnType<typeof createScheduler>
