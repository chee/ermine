// the graph: newcore's libraries hooked up. it holds the table, places, a trackgraph and one notify
// per node; no library knows another. places says what a read rested on (depend), the graph tracks
// it in the trackgraph and asks that node's notify to watch it; mutate tells the graph each patch
// (patched), the graph tells the node's notify, and notify's reads mark the owners that read there.
//
// an owner is anything that reads tracked (the scheduler's processes); the graph knows nothing of
// it but that it read, and tells marked when a change reached what it read. ephemeral nodes may
// have an owner too. protect is asked as the actor before each operation through bound.
import createChange, { type Change, type Header } from "../nodes/change.ts"
import type { Which } from "../opstreams/mutate.ts"
import createNode, { type Node, type Version } from "../nodes/node.ts"
import { createNotify, type Facts, facts, type Patch, type Read as Watch } from "../notify.ts"
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
} from "../protect.ts"
import { capture, type Site } from "../nodes/stacktrace.ts"
import { createTable } from "./table.ts"
import { createTrackgraph, type Node as Track } from "../trackgraph.ts"

type N = Node<unknown, Change>
type V = Version<unknown, Change>

export class GraphError extends Error {
	// refused: protect's why, or {code: "pending"} where it did not know yet
	constructor(readonly code: string, message?: string, readonly why?: unknown) {
		super(message === undefined ? code : `${code}: ${message}`)
	}
}

// a change that marked an owner: its where and header (SCHEDULER.tex, Marks)
export type By = Header & { node: string; which?: Which | "loaded" }

// who a change is by, as places asks for it
export type Acting = { actor: unknown; reader?: string; cause?: unknown; site?: Header["site"] }

// what the host and code act through: reads, and writes unless read only
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
	// a new node holding value (none: no value); an owner may make it ephemeral
	create(value?: unknown, options?: { id?: string; ephemeral?: boolean }): string
}

// a read, given what to track it with (none: untracked)
export type Read = (depend?: Depend) => unknown
export type ReadArgs = { address?: Address; name?: string }

// an interface: at a place, as an actor; it stops when alive says so
export type Bind<O> = {
	place: Place
	agent: unknown
	reader?: string
	cause?: unknown
	// the caller's site captured on each change: the host's
	site?: boolean
	depend?: Depend
	writes: boolean
	alive: () => boolean
	// may make, place and move ephemeral nodes, owning those it makes
	owner?: O
	// what changes are made with: given to marked; and own, not marked by them
	tag?: unknown
	// the times of the changes made, pushed
	wrote?: number[]
	// around each read (default: run it tracked by depend), and each change (default: run it)
	reading?: (op: string, read: Read, args: ReadArgs) => unknown
	around?: <T>(f: () => T) => T
}

// what a tracked reader is given: depend to track with, and its trackgraph node's begin/end/untrack
export type Reader = { depend: Depend; begin(): void; end(): void; untrack(): void }

export type Options<O> = {
	// the root's id; the host introduces its node, or one is made holding nothing
	root: string
	// who the host's own changes are by
	actor?: unknown
	// the last time given; each change takes the next
	clock?: { time: number }
	// a fresh id for a node made at a time; "@" and the time if not given
	id?: (time: number) => string
	// who may do what (protect.ts); default anyone
	may?: May
	// a change reached what owner read; tag: what it was made with
	marked?: (owner: O, by: By, tag: unknown) => void
	// an ephemeral node now owned by owner
	owned?: (owner: O, id: string) => void
	// a node gone, and its owner if ephemeral: before its loaded readers are marked
	released?: (id: string, owner: O | undefined) => void
	// the host's site for its changes; default read off the call stack
	site?: () => Site | undefined
}

// the newcore files a site is not in
export const ours: ReadonlySet<string> = new Set(
	[
		"graph/graph.ts",
		"scheduler/scheduler.ts",
		"scheduler/order.ts",
		"scheduler/run.ts",
		"scheduler/rank.ts",
		"programs/records.ts",
		"programs/processes.ts",
		"programs/handlers.ts",
		"programs/code.ts",
		"graph/places.ts",
		"opstreams/mutate.ts",
		"nodes/change.ts",
		"nodes/node.ts",
		"graph/table.ts",
		"notify.ts",
		"trackgraph.ts",
		"nodes/stacktrace.ts",
		"nodes/because.ts",
	].map((f) => new URL(`../${f}`, import.meta.url).href),
)

export function pidOf(time: number): string {
	return `@${time}`
}

const partKey = (id: string, part: Part) =>
	`${id}\u0000${typeof part === "string" ? part : part.join("\u0000")}`
const whichKey = (w: Which) => (typeof w === "string" ? w : w.join("\u0000"))
const pathOf = (w: Which): string[] => (typeof w === "string" ? [w] : [...w])

// a spot: a part of a node something read; a trackgraph node's owner: an owner, or a spot
type Spot<O> = { id: string; part: Part; key: string; track: Track<Own<O>>; watch?: Watch }
type Own<O> = { owner: O } | { spot: Spot<O> }

export function createGraph<O>(options: Options<O>) {
	const clock = options.clock ?? { time: 0 }
	const fresh = options.id ?? pidOf
	const hostActor = options.actor ?? "host"
	const may = options.may ?? anyone

	const table = createTable<unknown, Change>()
	const tracks = createTrackgraph<Own<O>>()

	// who the changes now being made are by; set around each operation
	let acting: Acting | undefined
	// whether mutate's patches are heard, or the operation is told to notify whole
	let hearing = true
	type Heard = { patch: Patch; facts: Facts; id: string; which: Which; header: Header }
	const heard: Heard[] = []
	const made: Header[] = []
	// told whole instead: which change touched each object, so each is told by its own
	let touched: Map<string, Header> | undefined
	function by(): Header {
		if (acting === undefined) throw new Error("a change made outside an operation")
		const h: Header = { ...acting, time: ++clock.time }
		made.push(h)
		if (!hearing) {
			if (!touched) return h
			const t = touched
			const patched = (_p: Patch, _f: Facts, id: string, which: Which) =>
				void t.set(`${id}\u0000${whichKey(which)}`, h)
			return { ...h, patched } as Header
		}
		return { ...h, patched: hear } as Header
	}
	const hear = (patch: Patch, facts: Facts, id: string, which: Which) =>
		void heard.push({ patch, facts, id, which, header: made[made.length - 1] })

	const places = createPlaces<unknown, Change>(table.get, options.root, { by })

	const ephemeral = new Set<string>()
	const owners = new Map<string, O>()

	// spots and notify: what was read, and the watch on it

	const spots = new Map<string, Spot<O>>()
	const spotsOf = new Map<string, Set<Spot<O>>>()
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

	function spot(id: string, part: Part): Spot<O> {
		const key = partKey(id, part)
		let s = spots.get(key)
		if (s) return s
		s = { id, part, key, track: undefined as unknown as Track<Own<O>> }
		s.track = tracks.node({ spot: s })
		spots.set(key, s)
		let of = spotsOf.get(id)
		if (!of) spotsOf.set(id, of = new Set())
		of.add(s)
		watch(s)
		return s
	}

	// notify watches what is read: an object deep, a node's names not
	function watch(s: Spot<O>) {
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
	let telling: { by: By; tag?: unknown; own?: O } | undefined

	// readers of a spot: marked by the change being told
	function fire(s: Spot<O>) {
		if (!telling) return
		for (const l of [...tracks.readers(s.track)]) {
			const o = l.from.owner
			if (!("owner" in o) || o.owner === telling.own) continue
			options.marked?.(o.owner, telling.by, telling.tag)
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

	// an operation making changes: by whom, then notify told, the readers marked.
	// slot: the version patched (null: none told by patch); snap: objects told whole instead
	function changing<T>(
		who: Acting,
		o: {
			tag?: unknown
			own?: O
			wrote?: number[]
			slot?: number | null
			snap?: [string, Which][]
		},
		f: () => T,
	): T {
		const was = { acting, hearing, telling, touched }
		const snaps = (o.snap ?? []).map(([id, which]) => {
			const n = table.get(id)
			return { n, which, old: n ? versionsOf(n, which) : undefined }
		})
		acting = who
		hearing = o.snap === undefined
		const touches = (touched = hearing ? undefined : new Map())
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
			touched = was.touched
		}
		const mine = made.splice(start)
		const header = mine[mine.length - 1]
		telling = {
			by: { ...(header ?? { time: clock.time }), node: "" },
			tag: o.tag,
			own: o.own,
		}
		try {
			if (o.snap === undefined) flush(o.slot === undefined ? 0 : o.slot)
			else {
				for (const s of snaps) {
					if (!s.n) continue
					const h = touches?.get(`${s.n.id}\u0000${whichKey(s.which)}`) ?? header
					telling.by = { ...h, node: s.n.id, which: s.which }
					if (versionsOf(s.n, s.which) !== s.old) whole(s.n, s.which, s.old)
				}
			}
		} finally {
			telling = was.telling
		}
		if (o.wrote) { for (const h of mine) o.wrote.push(h.time!) }
		return out
	}

	// loading: a node in, or out

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

	// no longer loaded: not ephemeral, owned by none; its loaded readers marked by cause
	function release(id: string, cause: By) {
		if (!table.get(id)) return
		table.outro(id)
		notifies.delete(id)
		for (const s of spotsOf.get(id) ?? []) s.watch = undefined
		ephemeral.delete(id)
		const owner = owners.get(id)
		owners.delete(id)
		options.released?.(id, owner)
		loaded(id, cause)
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
			{ header },
		)
		intro(node, who, header.time)
		return pid
	}

	// an ephemeral node, owned by owner if given
	function own(id: string, owner?: O) {
		ephemeral.add(id)
		if (owner === undefined) return
		owners.set(id, owner)
		options.owned?.(owner, id)
	}

	// what owner reads tracked through
	function reader(owner: O): Reader {
		const t = tracks.node({ owner })
		return {
			depend: (id, part) => tracks.track(t, spot(id, part).track),
			begin: () => tracks.begin(t),
			end: () => tracks.end(t),
			untrack: () => tracks.untrack(t),
		}
	}

	// protect: asked as the actor, before each operation not the graph's own. the policy's
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
		throw new GraphError("refused", `${op}: ${why.code}`, why)
	}
	// asked as actor; refused: thrown
	const asking = (actor: unknown, asks: Iterable<Ask>, op: string) => allowed(ask(actor, asks), op)

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
			if (it.node && object) asks.push({ op: "read", args: { node: it.id, object } })
			// no one object asked for: the whole node goes out, so every object is read
			else if (it.node) asks.push(...readAsks(it.node as Parameters<typeof readAsks>[0]))
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

	// the interface

	function bound(b: Bind<O>): Api {
		const live = (op: string) => {
			if (!b.alive()) throw new GraphError("stopped", `${op}: this interface has stopped`)
		}
		const around = b.around ?? (<T>(f: () => T) => f())
		const r = (op: string, f: Read, args: ReadArgs = {}) => {
			live(op)
			return b.reading ? b.reading(op, f, args) : f(b.depend)
		}
		const pl = b.place
		const who = (): Acting => {
			const a: Acting = { actor: b.agent }
			if (b.reader !== undefined) a.reader = b.reader
			if (b.cause !== undefined) a.cause = b.cause
			if (b.site) {
				const site = options.site ? options.site() : capture(ours)
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
			if (!b.writes) throw new GraphError("read-only", `${op}: a compute only reads`)
			if (asks) allowed(ask(b.agent, asks()), op)
			return around(() => changing(who(), { ...o, tag: b.tag, wrote: b.wrote }, f))
		}
		const slot = (s?: Span) => (s === undefined ? 0 : typeof s === "number" ? s : null)
		const mayPlace = (child: string) => {
			if (ephemeral.has(child) && b.owner === undefined) {
				throw new GraphError(
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
					() => {
						// a number is a gap: nothing replaced; a span: the ids there
						const gone = Array.isArray(index)
							? idsAt(id, name, slotindex).slice(index[0], index[1])
							: []
						return placed(id, name, gone, [child])
					},
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
				if (!b.writes) throw new GraphError("read-only", "create: a compute only reads")
				if (o.ephemeral && b.owner === undefined) {
					throw new GraphError("not-a-process", "only a process makes an ephemeral node")
				}
				const id = around(() => make(o.id, value, who(), value !== undefined))
				if (o.ephemeral) own(id, b.owner)
				return id
			},
		}
	}

	// the root: the host's, or one made holding nothing
	if (!table.get(options.root)) {
		table.intro(createNode<unknown, Change>(options.root, {}))
	}

	return {
		get: table.get,
		places,
		by,
		changing,
		intro,
		release,
		make,
		own,
		ephemeral: (id: string) => ephemeral.has(id),
		owner: (id: string) => owners.get(id),
		reader,
		asking,
		bound,
	}
}

export type Graph<O> = ReturnType<typeof createGraph<O>>
