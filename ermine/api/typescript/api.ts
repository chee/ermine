// the process api: what createProcessAPI gives a program. chee 10-15: "the host has this power, to
// let the user create processes with a different api, it's just once you're in the graph this is
// all you have". the words are hers (10-15), from what 43 demos kept needing
// (playground/ermine-slaygrounds/N.E.E.D.MD): open ("like upsert", and with no value "open-only"),
// read, edit, watch ("interface of edit, watch, read"), info ("gives a handle to the attributes"),
// list ("lists children"), memo ("yes to memo"), effect, method and send ("yes to method+send"),
// teardown, ref, remove, place, unplace, move, start, stop, openwith, box, args, pulse
//
//   const apis = createProcessAPIs({ scheduler, table, commit, boxes, programs: () => programs })
//   const programs = createPrograms({ ..., createProcessAPI: apis.createProcessAPI })
//   put("value", RUN, apis.run)                       // a host runner for javascript programs
//
//   export default function ({ open, read, edit, memo, effect, method, send }) {
//     const notes = open("./notes", { a: 1 })
//     const a = memo(() => read(notes, ["a"]))
//     method("on/bump", () => edit(notes, (d) => { d.a++ }))
//     effect(() => read(a), (n) => draw(n))
//     return "the process's value"
//   }
//
// paths: a string, split as path.ts' parse, or names already. mine, open (chee: "maybe crew means
// inside me and ./crew is folder and ../crew is above. it's one or the other"):
//   crew      inside the process's own node (never saved: gone at its stop)
//   ./crew    the folder the process is in
//   ../crew   above that
//   /crew     the box's "/"
//
// a node is {path}, walked again at each use (tracked in a run), or {id} for one with no place (an
// unnamed memo or effect); part: the table read and written, "value", or "attributes" from info
//
// pulses: none by hand ("still provide pulse but also batch automatically"). every write here, and
// every promise settling (the scheduler's onSettle), asks for one pulse in a microtask, as Solid
// 2.0 does; pulse() runs one now. a node read after a write sees it at once (it is in the table); a
// memo gives its last result until the pulse (chee: "whatever is fastest and most reasonable")
//
// writes: each with a scope open, its header from it (header.ts). attributes with nothing there
// are {} to a recipe and to patches (mine). nothing open (a timer, a promise,
// a listener): the process's own scope is opened, so a write needs no method to go through (mine);
// a stopped process's scope is gone, and its writes throw. committed to the host's commit (every
// box told). the patches given, or a recipe handed to produce on the value now, read untracked:
// "edit is its own function, that when it receives a function calls out to produce in the
// background"
//
//   open(p, value?)      the node at p. a value: made if nothing is there, folders on the way (the
//                        value given is the first only: an edit of it in the code changes nothing
//                        there, mine, open). no value: open only, nothing made
//   create(folder, v)    a new node in folder, named by its own id
//   read(x, path?)       its value at path, tracked; nothing: undefined. a memo pending with no
//                        value yet: throws PENDING, so the reader is pending too
//   entries(x)           every item at x: [{ value, from, id }] (reads are lists); nothing: []
//   list(x)              the names under x, tracked
//   info(x)              x's attributes, as a node read, edited and watched as any other
//   edit(x, change)      patches, or a recipe: one change on the value (none there: made)
//   watch(x, fn)         fn at each write landing at x (places' watchPath), with its patches, its
//                        change and the value; gives back the stop (its scope's teardown stops it)
//   place(p, x)          x's node at a second name. unplace(p): the name taken out, the node stays
//   move(from, to)       places' move. remove(x): unplaced, and its entries deleted (mine: not
//                        what is under it, which nothing reaches any more)
//   memo(f, options?)    a compute (the scheduler's), its result written to a node of its own
//                        (runs are writes), its status on it (status.ts); named: placed at the name
//   effect(f, act, o?)   an effect: f tracked, act(value, before) after the round; f's value written
//                        to its node at each act
//   method(p, fn)        fn as the value of the node at p, called by send in a scope under the one
//                        open when it was made
//   send(p, ...args)     the method at p called, with [["caller", this process's id]] and the host's
//                        pairs (setup.pairs) after; its return given back
//   teardown(fn)         fn(why) as the scope open goes: "ended" (the process stopped), "replaced"
//                        (a computer running again, or a host's stop(p, "replaced"))
//   ref(p, make)         the node at p, make() its value if nothing is there: a live value kept
//                        while the node is (inside the process: till its stop)
//   start(program, at, { box?, args?, onwhynot? })   a process: program a name (satisfy's first
//                        way, from this process's place; another box: from its "/"), or a way; at a
//                        path here, or from the box's "/". no way: refused no-way, the whynots
//                        given. stopped when this one stops (10-06)
//   stop(p)              a process this one started
//   openwith(x, { onwhynot }?)   programs' openwith from this process's place: every way to open
//                        x, nearest first (a generator), each candidate not taken told to onwhynot
//   box(folder?)         a box made in this process's box from folder (none: empty); place and
//                        unplace in it; closed at this process's stop
//   args, pulse, PENDING
//
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import update from "@ermine/node/update"
import apply, { type Key as Step, type Patch } from "@ermine/op/apply"
import produce from "@ermine/op/produce"
import { type Box, box as boxInto, type Boxes, closeBox, unbox } from "@ermine/boxes"
import {
	type Fact,
	type Id,
	move as moveIn,
	type Path,
	place as placeIn,
	PlacesError,
	unplace as unplaceIn,
} from "@ermine/places"
import { get, gets, list as listAt } from "@ermine/places/lib"
import { parse, plan } from "@ermine/places/path"
import { createChangeHeader } from "@ermine/places/header"
import { createStatus, STATUS } from "@ermine/places/status"
import { openwith as openwithIn, satisfy, type Way, type Whynot } from "@ermine/programs"
import type { Context, Process, Programs, Runner } from "@ermine/programs/start"
import { type Equal, type Pair, PENDING, type Scheduler, type Scope } from "@ermine/scheduler"
import type { Key, Table } from "@ermine/table"

export type Setup = {
	scheduler: Scheduler
	table: Table
	// the host's commit: its own places and every box told (boxes.commit)
	commit: (changed: readonly Entry<unknown>[]) => void
	boxes: Pick<Boxes, "createBox">
	// made after this (createPrograms takes createProcessAPI): asked when used
	programs: () => Programs
	// pairs a send adds after the caller's: the host's (trusted, read from the native event)
	pairs?: () => Iterable<Pair>
}

// a node: walked to by its path at each use, or its id (a node with no place)
export type Node = { readonly path?: Path; readonly id?: Id; readonly part: Key }
export type Target = Node | string | readonly string[]

// a recipe (produce's), or patches
export type Change = readonly Patch[] | ((draft: any, helpers: any) => unknown)

export type Why = "ended" | "replaced"

// a write landing at a watched node
export type Watched = {
	readonly patches: readonly Patch[]
	readonly change: ChangeHeader | undefined
	readonly value: unknown
}

export type Item = { readonly value: unknown; readonly from: string; readonly id: Id }

export type BoxNode = {
	readonly box: Box
	place: (at: string | Path, x: Target) => void
	unplace: (at: string | Path) => void
}

// what a refusal from start says: start's, or no-way (satisfy yielded none), with the whynots
export type Refusal = { readonly refused: string; readonly why?: readonly Whynot[] }

export type API = {
	open: (at: string | Path, value?: unknown) => Node
	create: (folder: string | Path, value: unknown) => Node
	read: (x: Target, path?: readonly Step[]) => unknown
	entries: (x: Target) => Item[]
	list: (x: Target) => string[]
	info: (x: Target) => Node
	edit: (x: Target, change: Change) => void
	watch: (x: Target, fn: (w: Watched) => void) => () => void
	place: (at: string | Path, x: Target) => void
	unplace: (at: string | Path) => void
	move: (from: string | Path, to: string | Path) => void
	remove: (x: Target) => void
	memo: <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		options?: { name?: string | Path; equal?: Equal<T> },
	) => Node
	effect: <T>(
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options?: { name?: string | Path; equal?: Equal<T> },
	) => Node
	method: (at: string | Path, fn: (...args: any[]) => unknown) => Node
	send: (at: Target, ...args: unknown[]) => unknown
	teardown: (fn: (why: Why) => unknown) => void
	ref: <T>(at: string | Path, make: () => T) => Node
	start: (
		program: string | Way,
		at: string | Path,
		options?: { box?: BoxNode; args?: readonly string[]; onwhynot?: (why: Whynot) => void },
	) => Process | Refusal
	stop: (p: Process) => void
	openwith: (x: Target, options?: { onwhynot?: (why: Whynot) => void }) => Generator<Way, void>
	box: (folder?: Target) => BoxNode
	readonly args: readonly string[]
	pulse: () => void
	readonly PENDING: typeof PENDING
}

export class SendError extends Error {
	constructor(readonly code: "not-a-method", readonly at: string) {
		super(`${code} (${at})`)
		this.name = "SendError"
	}
}

export type ProcessAPIs = {
	createProcessAPI: (ctx: Context) => API
	// a host runner for a javascript program: its value (or module's default) called with the api,
	// once, untracked; its return the process's value
	run: Runner
	// a process stopped, its teardowns told why
	stop: (p: Process, why?: Why) => void
}

const isNode = (x: Target): x is Node => typeof x === "object" && !Array.isArray(x)

// the names a path in a box comes to, from its "/"
function inBox(at: string | Path): Path {
	const names = plan(["/", ...(typeof at === "string" ? parse(at) : at)])
	if (names === undefined) throw new PlacesError("nothing-there", "..")
	return names
}

export function createProcessAPIs(setup: Setup): ProcessAPIs {
	const { scheduler: s, table, commit, boxes } = setup
	const statuses = createStatus({ places: { commit }, table, scheduler: s })
	// a method's function: the scope open when it was made
	const methods = new WeakMap<object, Scope>()
	// why a process is stopping, said by stop before its scope goes
	const whys = new Map<Id, Why>()
	// the memos' nodes: a read of one pending with no value throws PENDING
	const memos = new Set<Id>()
	// each api's process
	const inners = new WeakMap<object, { id: Id; scope: Scope }>()

	// one pulse, in a microtask, however many ask
	let queued = false
	function later() {
		if (queued) return
		queued = true
		queueMicrotask(() => {
			queued = false
			s.pulse()
		})
	}
	s.onSettle(later)

	const header = () => createChangeHeader(s)

	// what a part holds when nothing is there: attributes are a map, so {}; a value, nothing
	const empty = (part: Key) => part === "attributes" ? {} : undefined

	// patches on (part, id): the entry made when there is none (the table event tells its readers),
	// else updated and committed
	function write(part: Key, id: Id, patches: readonly Patch[]) {
		const entry = table.get(part, id) as Entry<unknown> | undefined
		if (entry === undefined) {
			const v = apply(empty(part), patches)
			if (v !== undefined) table.add(part, id, createEntry(v, header()) as never)
			return
		}
		update(entry, patches, header())
		commit([entry])
	}

	// a whole value as patches; undefined: taken out
	const whole = (v: unknown): Patch[] => [v === undefined ? { path: [] } : { path: [], value: v }]

	function stop(p: Process, why: Why = "ended") {
		whys.set(p.id, why)
		try {
			setup.programs().stop(p)
		} finally {
			whys.delete(p.id)
		}
	}

	function createProcessAPI(ctx: Context): API {
		const { box: home, places, process, scope } = ctx
		const at = process.at

		// f with a scope open: the one open, else the process's own
		const within = <T>(f: () => T): T =>
			s.getCurrentScope() !== undefined ? f() : s.runWithScope(scope, f)
		const owner = () => s.getCurrentScope() ?? scope

		function resolve(p: string | Path): Path {
			const steps = typeof p === "string" ? parse(p) : p
			const first = steps[0]
			const from = first === "/" ? [] : first === "." || first === ".." ? at.slice(0, -1) : at
			const names = plan(["/", ...from, ...steps])
			if (names === undefined) throw new PlacesError("nothing-there", "..")
			return names
		}
		const nodeOf = (x: Target): Node => isNode(x) ? x : { path: resolve(x), part: "value" }
		const idOf = (n: Node): Id | undefined => n.id ?? (n.path ? get(places, n.path) : undefined)
		function needId(n: Node): Id {
			const id = idOf(n)
			if (id === undefined) throw new PlacesError("nothing-there", n.path?.join("/"))
			return id
		}

		// id placed under name in the folder parent: its children entry made when it has none
		function placeUnder(parent: Id, name: string, id: Id) {
			const children = table.get("children", parent) as Entry<unknown> | undefined
			if (children === undefined) {
				table.add(
					"children",
					parent,
					createEntry<Record<string, unknown>>({ [name]: id }, header()),
				)
			} else commit(placeIn(children, name, id, header()))
		}
		// a node at path holding value (none: a folder), folders made on the way
		function make(path: Path, value: unknown, id: Id = crypto.randomUUID()): Id {
			if (path.length === 0) throw new PlacesError("already-there", "/")
			let parent: Id = places.root
			for (let i = 0; i < path.length - 1; i++) {
				const there = get(places, path.slice(0, i + 1))
				if (there !== undefined) parent = there
				else {
					const folder = crypto.randomUUID()
					placeUnder(parent, path[i], folder)
					parent = folder
				}
			}
			if (value !== undefined) table.add("value", id, createEntry(value, header()))
			placeUnder(parent, path[path.length - 1], id)
			return id
		}
		// the children entry of the folder a path is in, and the name
		function slot(path: Path): [Entry<unknown>, string] {
			const parent = get(places, path.slice(0, -1))
			const children = parent === undefined ? undefined : table.get("children", parent)
			if (children === undefined || path.length === 0) {
				throw new PlacesError("nothing-there", path.join("/"))
			}
			return [children as Entry<unknown>, path[path.length - 1]]
		}

		function open(p: string | Path, value?: unknown): Node {
			const path = resolve(p)
			if (value !== undefined) {
				within(() => {
					if (get(places, path) === undefined) make(path, value)
				})
				later()
			}
			return { path, part: "value" }
		}

		function create(folder: string | Path, value: unknown): Node {
			const id = crypto.randomUUID()
			const path = [...resolve(folder), id]
			within(() => make(path, value, id))
			later()
			return { path, part: "value" }
		}

		function read(x: Target, path: readonly Step[] = []): unknown {
			const n = nodeOf(x)
			const id = idOf(n)
			if (id === undefined) return undefined
			if (n.part === "value" && memos.has(id)) {
				const v = places.readValue("value", id, path)
				if (v === undefined && places.readValue("attributes", id, [STATUS]) === PENDING) {
					throw PENDING
				}
				return v
			}
			return places.readValue(n.part, id, path)
		}

		function entries(x: Target): Item[] {
			const n = nodeOf(x)
			if (n.path === undefined) {
				if (n.id === undefined) return []
				const value = places.readValue(n.part, n.id)
				return value === undefined ? [] : [{ value, from: "id", id: n.id }]
			}
			return gets(places, n.path).map((a) => ({
				value: places.readValue(n.part, a.id),
				from: a.from,
				id: a.id,
			}))
		}

		function list(x: Target): string[] {
			const n = nodeOf(x)
			if (n.path !== undefined) return [...listAt(places, n.path)]
			return n.id === undefined ? [] : places.readKeys("children", n.id)
		}

		const info = (x: Target): Node => ({ ...nodeOf(x), part: "attributes" })

		function edit(x: Target, change: Change) {
			within(() => {
				const n = nodeOf(x)
				const id = needId(n)
				const patches = typeof change === "function"
					? produce(table.get(n.part, id)?.value ?? empty(n.part), change as never)
					: change
				if (patches.length) write(n.part, id, patches)
			})
			later()
		}

		function watch(x: Target, fn: (w: Watched) => void): () => void {
			const n = nodeOf(x)
			if (n.path === undefined) throw new PlacesError("nothing-there", "a node with no place")
			const stop = places.watchPath(
				n.path,
				(fact: Fact) =>
					fn({ patches: fact.patches, change: fact.change, value: fact.entry?.value }),
				{ part: n.part },
			)
			s.registerTeardown(owner(), stop)
			return stop
		}

		function place(p: string | Path, x: Target) {
			within(() => {
				const path = resolve(p)
				const id = needId(nodeOf(x))
				const parent = get(places, path.slice(0, -1))
				if (parent === undefined || path.length === 0) {
					throw new PlacesError("nothing-there", path.join("/"))
				}
				placeUnder(parent, path[path.length - 1], id)
			})
			later()
		}

		function unplace(p: string | Path) {
			within(() => {
				const [children, name] = slot(resolve(p))
				commit(unplaceIn(children, name, header()))
			})
			later()
		}

		function move(from: string | Path, to: string | Path) {
			within(() => {
				const source = slot(resolve(from))
				const path = resolve(to)
				const parent = get(places, path.slice(0, -1))
				if (parent === undefined || path.length === 0) {
					throw new PlacesError("nothing-there", path.join("/"))
				}
				if (table.get("children", parent) === undefined) {
					table.add("children", parent, createEntry<Record<string, unknown>>({}, header()))
				}
				const into = table.get("children", parent) as Entry<unknown>
				commit(moveIn(source, [into, path[path.length - 1]], header()))
			})
			later()
		}

		function remove(x: Target) {
			within(() => {
				const n = nodeOf(x)
				const id = needId(n)
				if (n.path !== undefined && n.path.length) {
					const [children, name] = slot(n.path)
					const v = children.value as Record<string, unknown> | undefined
					if (v !== undefined && v[name] === id) commit(unplaceIn(children, name, header()))
				}
				for (const [part] of table.get(id)) table.del(part as Key, id)
			})
			later()
		}

		// a computer's node: its id, placed at name when given, its entries gone with own
		function computerNode(kind: string, own: Scope, name?: string | Path): [Node, Id] {
			const id = `${kind}:${crypto.randomUUID()}`
			const path = name === undefined ? undefined : resolve(name)
			if (path !== undefined) {
				within(() => {
					const parent = get(places, path.slice(0, -1))
					if (parent === undefined) throw new PlacesError("nothing-there", path.join("/"))
					placeUnder(parent, path[path.length - 1], id)
				})
			}
			s.registerTeardown(own, () => {
				memos.delete(id)
				if (path !== undefined) {
					try {
						const [children, last] = slot(path)
						if ((children.value as Record<string, unknown>)?.[last] === id) {
							commit(unplaceIn(children, last, header()))
						}
					} catch (e) {
						if (!(e instanceof PlacesError)) throw e
					}
				}
				for (const [part] of table.get(id)) table.del(part as Key, id)
			})
			return [path === undefined ? { id, part: "value" } : { path, part: "value" }, id]
		}

		function memo<T>(
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			options: { name?: string | Path; equal?: Equal<T> } = {},
		): Node {
			const own = owner()
			const [n, id] = computerNode("memo", own, options.name)
			memos.add(id)
			const c = s.runWithScope(own, () =>
				s.createComputer<T>(f, (v) => {
					if (v !== undefined || table.get("value", id) !== undefined) {
						write("value", id, whole(v))
					}
				}, options.equal))
			statuses.give(c, id)
			later()
			return n
		}

		function effect<T>(
			f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
			act: (value: T, before: T | undefined) => void,
			options: { name?: string | Path; equal?: Equal<T> } = {},
		): Node {
			const own = owner()
			const [n, id] = computerNode("effect", own, options.name)
			const c = s.runWithScope(own, () =>
				s.createEffect<T>(f, (v, before) => {
					if (v !== undefined || table.get("value", id) !== undefined) {
						write("value", id, whole(v))
					}
					act(v, before)
				}, options.equal))
			statuses.give(c, id)
			later()
			return n
		}

		function method(p: string | Path, fn: (...args: any[]) => unknown): Node {
			methods.set(fn, owner())
			const path = resolve(p)
			within(() => {
				const id = get(places, path)
				if (id === undefined) make(path, fn)
				else write("value", id, whole(fn))
			})
			later()
			return { path, part: "value" }
		}

		function send(p: Target, ...args: unknown[]): unknown {
			const n = nodeOf(p)
			const id = idOf(n)
			const fn = id === undefined ? undefined : table.get("value", id)?.value
			if (typeof fn !== "function") {
				throw new SendError("not-a-method", n.path?.join("/") ?? String(n.id))
			}
			const call = s.createScope(
				[["caller", process.id], ...(setup.pairs?.() ?? [])],
				methods.get(fn) ?? scope,
			)
			try {
				return s.runWithScope(call, () => fn(...args))
			} finally {
				s.teardown(call)
				later()
			}
		}

		function teardown(fn: (why: Why) => unknown) {
			s.registerTeardown(
				owner(),
				() => fn(whys.get(process.id) ?? (scope.state === "alive" ? "replaced" : "ended")),
			)
		}

		function ref<T>(p: string | Path, made: () => T): Node {
			const path = resolve(p)
			within(() => {
				if (get(places, path) === undefined) make(path, made())
			})
			later()
			return { path, part: "value" }
		}

		function start(
			program: string | Way,
			where: string | Path,
			options: { box?: BoxNode; args?: readonly string[]; onwhynot?: (why: Whynot) => void } =
				{},
		): Process | Refusal {
			const target = options.box?.box ?? home
			const path = options.box ? inBox(where) : resolve(where)
			let way: Way | undefined
			const why: Whynot[] = []
			if (typeof program !== "string") way = program
			else {
				const onwhynot = (w: Whynot) => (why.push(w), options.onwhynot?.(w))
				const from = target === home ? at : []
				for (const w of satisfy(target.places, program, from, { onwhynot })) {
					way = w
					break
				}
			}
			if (way === undefined) return { refused: "no-way", why }
			const args = options.args === undefined ? {} : { args: options.args }
			const p = within(() => setup.programs().start(target, way, path, args))
			if (!("refused" in p)) {
				s.registerTeardown(scope, () => stop(p, whys.get(process.id) ?? "ended"))
			}
			later()
			return p
		}

		function openwith(
			x: Target,
			options: { onwhynot?: (why: Whynot) => void } = {},
		): Generator<Way, void> {
			return openwithIn(places, needId(nodeOf(x)), at, options)
		}

		function box(folder?: Target): BoxNode {
			const id = folder === undefined ? undefined : needId(nodeOf(folder))
			const b = boxes.createBox(id, home)
			s.registerTeardown(scope, () => closeBox(b))
			return {
				box: b,
				place: (p, y) => {
					within(() => void boxInto(b, inBox(p), needId(nodeOf(y)), header()))
					later()
				},
				unplace: (p) => {
					within(() => void unbox(b, inBox(p), header()))
					later()
				},
			}
		}

		const api: API = {
			open,
			create,
			read,
			entries,
			list,
			info,
			edit,
			watch,
			place,
			unplace,
			move,
			remove,
			memo,
			effect,
			method,
			send,
			teardown,
			ref,
			start,
			stop: (p) => stop(p, "ended"),
			openwith,
			box,
			args: process.args,
			pulse: () => s.pulse(),
			PENDING,
		}
		inners.set(api, { id: process.id, scope })
		return api
	}

	const run: Runner = (code, api) => {
		const f = typeof code === "function" ? code : (code as { default?: unknown } | null)?.default
		if (typeof f !== "function") throw new TypeError("not a program: no function, no default")
		const inner = inners.get(api as object)
		const value = f(api)
		if (inner !== undefined && value !== undefined) {
			s.runWithScope(inner.scope, () => write("value", inner.id, whole(value)))
			later()
		}
		return { stop: () => {} }
	}

	return { createProcessAPI, run, stop }
}
