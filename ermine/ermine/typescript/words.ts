// the base's own functions, one set per process context (context.ts), the host's too (ermine.ts).
// programs never hold these: the process api is @ermine/system (system.ts), verb-first, built over
// them; found.ts gives them under these names, found from the scope open (the api-trials' adapters
// use them).
//
//   export default function ({ open, read, edit, memo, effect, method, send, status }) {
//     const notes = open("./notes", { a: 1 })
//     const a = memo("a", () => read(notes, ["a"]))
//     method("on/bump", () => edit(notes, (d) => { d.a++ }))
//     effect("draw", () => [status(a).state, read(a)], ([s, n]) => draw(n, s))
//     return "the process's value"
//   }
//
// paths: a bare name inside the process's node (the host's: the root), gone at stop; ./ its cwd;
// ../ above; / its box's root. a node: { path } (walked at each use) or { id }, never both (both:
// nothing-there); part "value" or "attributes".
// pulses: every write and every promise settling asks for one; pulse() runs one now. a read after
// a write sees it at once; a memo gives its last result until the pulse.
// writes: under the open scope (none: the context's, today's; the throw is §8 step 5); patches or a
// recipe; each value and attribute write through onWrite. a write's site: outside a run, the
// program's call into the api; in a run, the running memo's or effect's own line.
//
//   open(p, value?)      the node at p; a value: made (with folders) if missing, else unchanged
//   create(folder, v)    a new node in folder, a fresh name of its own (never its id)
//   make(p)              the node at p, made with nothing in it (no value) if missing, else as it is
//   read(x, path?)       value at path, tracked; none: undefined; a pending memo with no value
//                        throws PENDING
//   peep(x, path?)       read's, untracked; a pending memo: undefined
//   reads(x, path?)      every value at path, tracked: [{ value, from, gone?, inside? }]. position
//                        0 read's, from: { change } (its entry's, as a ChangeView: time, actor,
//                        site); then what features show (onRead), each from naming its feature (and
//                        its own change); none: []
//   entries(x)           every node x's path reaches: [{ value, from, node?, refused? }], node a
//                        handle (reached by this process's path); refused: no value, no node
//   list(x)              the names under x, tracked
//   info(x)              x's attributes, as a node
//   edit(x, change)      patches or a recipe; one change (made if missing)
//   watch(x, fn)         fn at each write at x, with patches, change (a view) and value (refused: refused,
//                        none of them); returns the stop
//   place(p, x)          x's node at a second name. unplace(p): the name out, the node stays
//   move(from, to)       places' move. remove(x), the host's only (HostAPI): unplaced and its
//                        entries deleted; a process unplaces, and a node no name reaches no longer
//                        exists [chee 10-25]
//   getCaller()          in an action: { actor, process? } (Caller); elsewhere: undefined
//   memo(name, f, o?)    a compute at its own node at name: its result, status and latest run;
//                        made again by its owner's next run (same node, new f); a name not made
//                        again goes after the run. a second at a name in one run: already-there
//   effect(name, f, act, o?)   f tracked, act(value, before) after the round; node as memo's
//   early(name, f, act, o?)    an effect run and acted at once; later acts before other effects'
//   method(p, fn)        fn as the node's value, called by send in a scope under the open one
//   send(p, ...args)     the method at p, in a call scope { caller: { node, actor }, handler,
//                        call }; its return.
//                        its record (calls.ts) held as the handler's latest. nothing there (no
//                        node, or no value): pending, loudly: a wait recorded (calls.ts) and
//                        PENDING thrown, so a memo or effect sending reruns when the handler comes.
//                        a value that is no function: not-a-method
//   teardown(fn)         fn(why) as the open scope goes, through onTeardown: "replaced", "ended",
//                        or a stop's reason
//   ref(p, make)         the node at p, make() if missing: a live value kept while the node is
//   box(at)              a box: the folder at, seen from its own "/" (ermine/boxes), as a handle:
//                        { at, place, unplace }; the box itself (and its folder's id) the host's
//   status(x)            tracked: { state, error?, phase?, waiting?, n? } (Status); not there:
//                        undefined. waiting names nodes by path as this process sees them (null:
//                        outside its box)
//   explain(x, path?)    tracked: a change and its writer, one step (Explained). x a change's
//                        view (a reads item's from.change, a watch's): that one; a node: its
//                        entry's, and a write held there; none: undefined. the writer and its
//                        record name nodes by path as this process sees them (none: outside its box)
// no ids anywhere a process is given [chee 10-25]: paths as it sees them (seenIn), handles for what
// it reached, changes as views
//   args, pulse, PENDING, REFUSED
//
// a memo, effect or early made in a send goes with the call, and the send's record says so (made).
// the call lasts as its record does: a promise's till it settles; then its teardowns are told
// "ended" (a stop's reason, the process stopping first).
// protect: reads ask "read" (refused: Refusal; entries keeps the item with id REFUSED, by a path
// or an id; watch is asked as it is made, and at each write told: refused, told refused); edit
// "edit"; open, create, place, unplace, move "place" on the slot; remove "remove"; send "execute";
// memo's and effect's own writes not asked.
// scope nodes: a write's metadata stops after the first scope whose own info holds the NODE key. a
// process's scope holds its node's; each memo and effect is made with { [NODE]: its node's id }.
import type { ChangeHeader, Entry } from "@ermine/core/node/entry"
import type { Key as Step, Patch } from "@ermine/core/op/apply"
import produce from "@ermine/core/op/produce"
import { type Box, box as boxInto, createBox, type Host, unbox } from "@ermine/boxes"
import {
	type Fact,
	type Id,
	moving,
	type Path,
	type Places,
	PlacesError,
	placing,
	unplacing,
} from "@ermine/places"
import { parse, plan } from "@ermine/places/path"
import { get, gets, list as listAt } from "@ermine/places/lib"
import { NODE } from "@ermine/places/header"
import {
	Refusal,
	REFUSED,
	slot as slotOf,
	target as targetOf,
	type Thing,
} from "@ermine/places/guard"
import { STATUS, TABLE as STATUS_TABLE } from "@ermine/places/status"
import type { Run, Runs } from "@ermine/processes/runs"
import { type Computer, type Equal, PENDING, type Scope } from "@ermine/core/scheduler"
import type { Sited } from "@ermine/sites"
import type { Key, Table } from "@ermine/core/table"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import type { Call, Calls } from "./calls.ts"
import { type Asked, ErmineError, type Reading } from "./features.ts"
import { dataOf, type Handles, isHandle, mint } from "./handles.ts"
import {
	type Change,
	empty,
	type Inner,
	type Node,
	type NodeData,
	type Parts,
	type Target,
	type Version,
	whole,
	type Why,
} from "./context.ts"

// the attribute a memo's or effect's node holds its scope in: the NODE key's id of the nearest
// scope above it with one, written once as the node is made (beside status.ts')
export const SCOPE = "ermine.computer.scope"
// what a pending process waits on, written by what started it (ermine's start)
export const WAITING = "ermine.process.waiting"

// a write landing at a watched node
export type Watched = {
	readonly patches: readonly Patch[]
	readonly change: ChangeView | undefined
	readonly value: unknown
	// refused by the policy as it was told: no patches, no change, no value
	readonly refused?: true
}

// one node a path reaches: its value, where it was found, and a handle to it (reached by this
// process's own path, so its to hold); refused by the policy: no value, no handle
export type Item = {
	readonly value: unknown
	readonly from: string
	readonly node?: Node
	readonly refused?: true
}

// a box, as box(at) gives it: its folder's id and path, and placing in it. a handle: the box itself
// (its places, a view of the host's) stays on the host's side (Base's boxes), so a program holding
// one reads nothing by it and commits nothing unasked; ermine.start takes the handle
export type BoxNode = {
	readonly at: Path
	place: (at: string | Path, x: Target) => void
	unplace: (at: string | Path) => void
}

// what a pending one waits on: a memo it read that is pending (its node), a send to nothing, a
// process's code not at its path yet, a promise, or nothing it says (it gave PENDING itself)
export type Waiting =
	| { readonly node: Path | null }
	| { readonly code: Path }
	| { readonly send: Path | null; readonly since: number }
	| "a promise"
	| "PENDING"

// a write a feature's onWrite held back, shown where it would have shown: its status write, or a
// stopped process's row's removal [chee: "Held, with a trace", "Held, and shown"]
export type Held = { readonly feature: string; readonly write: "status" | "row" }

export type Status = {
	readonly state: "done" | "pending" | "failed" | "looping"
	// what it shows is so because a feature held a write back
	readonly held?: Held
	readonly error?: unknown
	// failed: in its run, or in an effect's act
	readonly phase?: "run" | "act"
	readonly waiting?: readonly Waiting[]
	// a computer's latest run's: a value from an older run is stale
	readonly n?: number
	// a feature's own fields (onStatus): pully's provider …
	readonly [field: string]: unknown
}

// what made a change, one step: a computer (a memo or effect; run: its latest record, when that
// still holds the change), a method (call: likewise), or code outside any (site: its first;
// fallback: a process's write with nothing open)
// nodes named by their path as the process asking sees them (seen; none: outside its box, moved,
// or placed by no words): no ids [chee 10-25: "i'm not sure the process api should be able to do
// anything by id"; "not quite true when there is sync"]
export type Writer =
	| { readonly kind: "computer"; readonly path?: Path; readonly run?: RunView }
	| { readonly kind: "method"; readonly path?: Path; readonly call?: CallView }
	| { readonly kind: "outside"; readonly site?: FileLocation }
// a record's read or write, as the process asking sees it
export type Touched = { readonly part: Key; readonly path?: Path }
// a run's record, as a process sees it (runs.ts' Run, its nodes by path)
export type RunView = {
	readonly n: number
	readonly started?: number
	readonly ended: number
	readonly end: Run["end"]
	readonly error?: unknown
	readonly act?: Run["act"]
	readonly reads: readonly Touched[]
	readonly writes: readonly Touched[]
}
// a call's record, as a process sees it (calls.ts' Call, its nodes by path; no caller: getCaller)
export type CallView = {
	readonly n: number
	readonly args: readonly unknown[]
	readonly end: Call["end"]
	readonly returned?: unknown
	readonly error?: unknown
	readonly started: number
	readonly ended?: number
	readonly reads: readonly Touched[]
	readonly writes: readonly Touched[]
	readonly made?: readonly { readonly kind: "memo" | "effect" | "early"; readonly path?: Path }[]
}
// who called the action running now [chee 10-25: "oh well, it should"]: the actor its writes carry,
// and its process's node by path as the action sees it (none: outside its box)
export type Caller = { readonly actor: unknown; readonly process?: Path }

// the process api with what the host keeps: remove (a process removes a name, unplace; a node no
// name reaches no longer exists [chee 10-25: "yep sounds good"])
export type HostAPI = API & { remove: (x: Target) => void }

// a change as a process sees it: when, who, and the line that made it; explain takes it back to its
// change (one view per change, base.views). its metadata (node ids) stays the host's
export type ChangeView = {
	readonly time: number
	readonly actor: unknown
	readonly site?: FileLocation
}
// a change explained: it and its writer. held (a node's only): the latest write there a feature
// held back, since the change (no change: only that)
export type Explained =
	| {
		readonly change: ChangeView
		readonly writer: Writer
		readonly held?: { readonly feature: string }
	}
	| {
		readonly change?: undefined
		readonly writer?: undefined
		readonly held: { readonly feature: string }
	}

export type API = {
	open: (at: string | Path, value?: unknown) => Node
	create: (folder: string | Path, value: unknown) => Node
	read: (x: Target, path?: readonly Step[]) => unknown
	peep: (x: Target, path?: readonly Step[]) => unknown
	reads: (x: Target, path?: readonly Step[]) => Version[]
	entries: (x: Target) => Item[]
	list: (x: Target) => string[]
	info: (x: Target) => Node
	edit: (x: Target, change: Change) => void
	make: (at: string | Path) => Node
	watch: (x: Target, fn: (w: Watched) => void) => () => void
	place: (at: string | Path, x: Target) => void
	unplace: (at: string | Path) => void
	move: (from: string | Path, to: string | Path) => void
	memo: <T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		options?: { equal?: Equal<T> },
	) => Node
	effect: <T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options?: { equal?: Equal<T> },
	) => Node
	early: <T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options?: { equal?: Equal<T> },
	) => Node
	// deno-lint-ignore no-explicit-any
	method: (at: string | Path, fn: (...args: any[]) => unknown) => Node
	send: (at: Target, ...args: unknown[]) => unknown
	teardown: (fn: (why: Why) => unknown) => void
	ref: <T>(at: string | Path, make: () => T) => Node
	box: (at: string | Path) => BoxNode
	status: (x: Target) => Status | undefined
	explain: (x: Target | ChangeView, path?: readonly Step[]) => Explained | undefined
	// in an action: who called it; elsewhere: undefined
	getCaller: () => Caller | undefined
	// a node's children as handles ({ name: node }), tracked; every version of a part (children:
	// their ids as handles); a folder's names patched (one name a patch: a node placed, or none:
	// unplaced); f with nothing it reads tracked [chee 10-25: "we'll go with peep"]
	readChildren: (x: Target) => Record<string, Node>
	readAllOf: (
		x: Target,
		part: "value" | "attributes" | "children",
		path?: readonly Step[],
	) => Version[]
	explainOf: (x: Target, part: "value" | "attributes" | "children") => Explained | undefined
	patchChildren: (x: Target, patches: readonly Patch[]) => void
	untrack: <T>(f: () => T) => T
	readonly args: readonly string[]
	pulse: () => void
	readonly PENDING: typeof PENDING
	readonly REFUSED: typeof REFUSED
}

// a send's record as a program sees it (explain's writer.call): the caller by its id, no context (a
// program's api holds no context: the caller's is the host's and features' side, ermine.calling)
export type Sent = Omit<Call, "context">

export class SendError extends Error {
	constructor(readonly code: "not-a-method", readonly at: string) {
		super(`${code} (${at})`)
		this.name = "SendError"
	}
}

// what every api of one ermine shares, beside the context's parts
export type Base = {
	readonly parts: Parts
	readonly sited: Pick<Sited, "createScope" | "createComputer" | "createEffect">
	readonly statuses: { give: (c: Computer, id: Id) => void }
	readonly runs: Runs
	readonly calls: Calls
	// the memos' nodes: a read of one pending with no value throws PENDING
	readonly memos: Set<Id>
	// every memo's and effect's node: status reads its run
	readonly computers: Set<Id>
	// a memo's or effect's node → the context that made it (its status written as that context's)
	readonly contexts: Map<Id, Inner>
	// a computer's node whose latest run gave a promise not settled yet
	readonly awaiting: Set<Id>
	// each method placed, by its node: the function, and the scope open when it was placed (one
	// function placed by two owners: each placement its own). gone with that scope
	readonly methods: Map<Id, { readonly fn: unknown; readonly scope: Scope }>
	// why a process is stopping (by its node), said by stop before its scope goes
	readonly whys: Map<Id, Why>
	readonly newId: () => string
	// every node handle the words gave, and each context's words: a word on a handle another context
	// made is done by that context's own (handles.ts)
	readonly handles: Handles
	readonly words: WeakMap<Inner, HostAPI>
	// each process's node: its box's folder, and where it runs in that box (its rows name it, not a
	// children entry, so places' namesOf has it not): seen's
	readonly running: Map<Id, { readonly box: Id; readonly at: Path }>
	// each change's view, and each view's change (ChangeView)
	readonly views: WeakMap<ChangeHeader, ChangeView>
	readonly changes: WeakMap<ChangeView, ChangeHeader>
	// what boxes are made over
	readonly host: Host
	// each box handle's box (the host's side)
	readonly boxes: WeakMap<BoxNode, Box>
	// f as a public word: a write's site outside a run is its caller
	readonly entered: <F extends (...args: never[]) => unknown>(f: F) => F
	// the onRead hooks
	readonly shown: (x: Reading, items: readonly Version[]) => readonly Version[]
	// the onTeardown hooks around fn(why)
	readonly torn: (scope: Scope, why: Why, fn: (why: Why) => unknown) => void
	// the onStatus hooks around the base's status
	readonly statused: (x: Asked, status: Status) => Status
	// writes held back by onWrite, tracked: at (part, id); a node's status write; a stopped
	// process's row
	readonly held: {
		at: (part: Key, id: Id) => { feature: string } | undefined
		status: (id: Id) => Held | undefined
		row: (id: Id) => Held | undefined
		// a node gone: what was held at its parts holding nothing goes with it
		drop: (id: Id) => void
	}
}

// the NODE key's id of o or the nearest scope above it with one; none: undefined
function nodeAbove(o: Scope | undefined): Id | undefined {
	for (; o !== undefined; o = o.parent) if (NODE in o.info) return o.info[NODE] as Id
	return undefined
}

// the method nodes each scope placed, its teardown registered (once each; scopes are one
// ermine's, so one map serves every api)
const placers = new WeakMap<Scope, Set<Id>>()

// a change's view (ChangeView): made once, and kept so explain can take it back
export function viewOf(base: Base, h: ChangeHeader): ChangeView {
	let v = base.views.get(h)
	if (v === undefined) {
		const site = h.external?.[0]
		v = Object.freeze({ time: h.time, actor: h.actor, ...site !== undefined && { site } })
		base.views.set(h, v)
		base.changes.set(v, h)
	}
	return v
}

// the names from root down to id, up id's names now (places' namesOf, the latest placed first at
// each step; a process's node, named by its rows: up from its box's folder, then where it runs);
// none: nothing reaches it from root. read untracked
function up(base: Base, places: Places, root: Id, id: Id): Path | undefined {
	const visited = new Set<Id>()
	const go = (at: Id): Path | undefined => {
		if (at === root) return []
		visited.add(at)
		const running = base.running.get(at)
		if (running !== undefined && !visited.has(running.box)) {
			const above = go(running.box)
			if (above !== undefined) return [...above, ...running.at]
		}
		const names = places.namesOf(at)
		for (let i = names.length - 1; i >= 0; i--) {
			if (visited.has(names[i].folder)) continue
			const above = go(names[i].folder)
			if (above !== undefined) return [...above, names[i].name]
		}
		return undefined
	}
	return go(id)
}

// id's path as reader sees it: up its names to the reader's box's folder, then walked down in the
// reader's box (tracked: a rename on the way reruns who asked). none: nothing in reader's box
// reaches it
export function seenIn(base: Base, reader: Inner, id: Id): Path | undefined {
	const p = up(base, reader.places, reader.context.box.root, id)
	return p !== undefined && get(reader.places, p) === id ? p : undefined
}

// a path in a box (by its folder's id) as reader sees it, whether anything is there or not; the
// box's folder out of reader's box: none
export function pathIn(base: Base, reader: Inner, box: Id, path: Path): Path | undefined {
	const at = up(base, reader.places, reader.context.box.root, box)
	return at === undefined ? undefined : [...at, ...path]
}
const isThen = (v: unknown): v is PromiseLike<unknown> =>
	(typeof v === "object" || typeof v === "function") && v !== null &&
	typeof (v as PromiseLike<unknown>).then === "function"

export function createWords(base: Base, inner: Inner): HostAPI {
	const { parts, calls, runs, memos, methods, newId } = base
	const { scheduler: s, table, queuePulse } = parts
	const { context, places, guard, guarded, inside } = inner
	const { scope, resolve } = context
	const header = () => parts.header()

	const owner = () => s.getCurrentScope() ?? scope
	// the actor a write made now would carry: the first the open scope (none: the context's) or one
	// above it gives
	const actorHere = () => {
		for (let o: Scope | undefined = owner(); o !== undefined; o = o.parent) {
			if ("actor" in o.info) return o.info.actor
		}
		return undefined
	}
	const thing = (id: Id, path?: Path): Thing => path === undefined ? { id } : { id, path }
	const ask = context.ask
	// the parent at path's folder, and the name: what placing there changes
	const slotAt = (path: Path, parent: Id) =>
		slotOf(thing(parent, path.slice(0, -1)), path[path.length - 1])

	// what x reaches: a path (resolved here), or a handle's (handles.ts); an object that is no
	// handle: not-a-handle
	function nodeOf(x: Target): NodeData {
		parts.alive()
		if (typeof x === "string" || Array.isArray(x)) return { path: resolve(x), part: "value" }
		return dataOf(base.handles, x).node
	}
	// a handle for n, made here; one by id, for a node this process reached by its own path
	const handle = (n: NodeData): Node => mint(base.handles, n, inner)
	const byId = (id: Id, part: Key): Node => handle({ id, part })
	// id's path as this process sees it (seenIn; none: outside its box)
	const seen = (id: Id) => seenIn(base, inner, id)
	const idOf = (n: NodeData): Id | undefined => n.id ?? (n.path ? get(places, n.path) : undefined)
	// x's id, a handle another context made walked in its maker's places
	function idThrough(x: Target): Id {
		if (isHandle(x)) {
			const d = dataOf(base.handles, x)
			if (d.maker !== inner) {
				const id = d.node.id ?? get(d.maker.places, d.node.path!)
				if (id === undefined) throw new PlacesError("nothing-there", d.node.path?.join("/"))
				return id
			}
		}
		return needId(nodeOf(x))
	}
	function needId(n: NodeData): Id {
		const id = idOf(n)
		if (id === undefined) throw new PlacesError("nothing-there", n.path?.join("/"))
		return id
	}

	// id placed under name in the folder parent (at path, its name the last): its children entry
	// made when it has none
	function placeUnder(parent: Id, name: string, id: Id, path?: Path) {
		if (path !== undefined) ask("place", slotAt(path, parent))
		const children = table.get("children", parent) as Entry<unknown> | undefined
		inner.put({ part: "children", id: parent, patches: placing(children, name, id) })
	}
	// a node at path holding value (none: nothing in it), the nodes on the way made
	function build(path: Path, value: unknown, id: Id = newId()): Id {
		if (path.length === 0) throw new PlacesError("already-there", "/")
		let parent: Id = places.root
		for (let i = 0; i < path.length - 1; i++) {
			const there = get(places, path.slice(0, i + 1))
			if (there !== undefined) parent = there
			else {
				const folder = newId()
				placeUnder(parent, path[i], folder, path.slice(0, i + 1))
				parent = folder
			}
		}
		ask("place", slotAt(path, parent))
		if (value !== undefined) inner.put({ part: "value", id, path, patches: whole(value) })
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
			inside(() => {
				if (get(places, path) === undefined) build(path, value)
			})
			queuePulse()
		}
		return handle({ path, part: "value" })
	}

	// a new node under folder, named by a fresh name of its own: drawn as an id is, but never its id
	// (a name is what list gives, and a process holds no ids)
	function create(folder: string | Path, value: unknown): Node {
		const id = newId()
		const path = [...resolve(folder), String(newId())]
		inside(() => build(path, value, id))
		queuePulse()
		return handle({ path, part: "value" })
	}

	function make(p: string | Path): Node {
		const path = resolve(p)
		inside(() => {
			if (get(places, path) === undefined) build(path, undefined)
		})
		queuePulse()
		return handle({ path, part: "value" })
	}

	// a peep going: its reads are no call's
	let peeping = 0
	function read(x: Target, path: readonly Step[] = []): unknown {
		const n = nodeOf(x)
		const id = idOf(n)
		if (id === undefined) return undefined
		if (guarded) guard.read(targetOf(thing(id, n.path), n.part, path))
		if (peeping === 0) calls.read(n.part, id, path)
		if (n.part === "value" && memos.has(id)) {
			const v = places.readValue("value", id, path)
			if (v === undefined && places.readValue(STATUS_TABLE, id, [STATUS]) === PENDING) {
				throw PENDING
			}
			return v
		}
		return places.readValue(n.part, id, path)
	}

	function peep(x: Target, path: readonly Step[] = []): unknown {
		peeping++
		try {
			return places.peep(() => {
				try {
					return read(x, path)
				} catch (e) {
					if (e === PENDING) return undefined
					throw e
				}
			})
		} finally {
			peeping--
		}
	}

	// read's, from its entry's change; then what features show
	function reads(x: Target, path: readonly Step[] = []): Version[] {
		const n = nodeOf(x)
		const shown = read(x, path)
		const id = idOf(n)
		if (id === undefined) return []
		const items: Version[] = []
		if (shown !== undefined) {
			const change = (table.get(n.part, id) as Entry<unknown> | undefined)?.change
			items.push({ value: shown, from: change === undefined ? {} : { change } })
		}
		// each item's change as its view (a feature's too): the header's metadata stays the host's
		return base.shown({ node: n, part: n.part, id, path, context }, items).map((v) =>
			v.from.change === undefined || base.changes.has(v.from.change as never)
				? v
				: { ...v, from: { ...v.from, change: viewOf(base, v.from.change as ChangeHeader) } }
		)
	}

	// whether the policy refuses reading t, asked as read asks (a pending answer: PENDING thrown)
	const refused = (t: ReturnType<typeof targetOf>) => {
		if (!guarded) return false
		try {
			guard.read(t)
			return false
		} catch (e) {
			if (e instanceof Refusal) return true
			throw e
		}
	}

	function entries(x: Target): Item[] {
		const n = nodeOf(x)
		if (n.path === undefined) {
			if (n.id === undefined) return []
			if (refused(targetOf(thing(n.id), n.part))) {
				return [{ value: undefined, from: "id", refused: true }]
			}
			calls.read(n.part, n.id, [])
			const value = places.readValue(n.part, n.id)
			return value === undefined ? [] : [{ value, from: "id", node: byId(n.id, n.part) }]
		}
		const found = gets(places, n.path)
		for (const a of found) calls.read(n.part, a.id, [])
		if (!guarded || n.path.length === 0) {
			return found.map((a) => ({
				value: places.readValue(n.part, a.id),
				from: a.from,
				node: byId(a.id, n.part),
			}))
		}
		const name = n.path[n.path.length - 1]
		const asked = guard.members(found.map((a) => ({ name, id: a.id })), n.path.slice(0, -1))
		return found.map((a, i) =>
			asked[i].id === REFUSED
				? { value: undefined, from: a.from, refused: true as const }
				: { value: places.readValue(n.part, a.id), from: a.from, node: byId(a.id, n.part) }
		)
	}

	function list(x: Target): string[] {
		const n = nodeOf(x)
		const id = idOf(n)
		if (guarded && id !== undefined) guard.read(targetOf(thing(id, n.path), "children"))
		if (id !== undefined) calls.read("children", id, [], true)
		if (n.path !== undefined) return [...listAt(places, n.path)]
		return n.id === undefined ? [] : places.readKeys("children", n.id)
	}

	const info = (x: Target): Node => handle({ ...nodeOf(x), part: "attributes" })

	function edit(x: Target, change: Change) {
		inside(() => {
			const n = nodeOf(x)
			const id = needId(n)
			ask("edit", targetOf(thing(id, n.path), n.part))
			const patches = typeof change === "function"
				? produce(table.get(n.part, id)?.value ?? empty(n.part), change as never)
				: change
			if (patches.length) {
				inner.put({
					part: n.part,
					id,
					...n.path !== undefined && { path: n.path },
					patches,
				})
			}
		})
		queuePulse()
	}

	// asked read as it is made (refused: a Refusal), and at each write told (refused: told so)
	function watch(x: Target, fn: (w: Watched) => void): () => void {
		const n = nodeOf(x)
		if (n.path === undefined) throw new PlacesError("nothing-there", "a node with no place")
		const path = n.path
		if (guarded) {
			const id = idOf(n)
			guard.read(
				id === undefined
					? { path: [...path], part: n.part }
					: targetOf(thing(id, path), n.part),
			)
		}
		const stop = places.watchPath(
			path,
			(fact: Fact) =>
				refused(targetOf(thing(fact.id, path), n.part))
					? fn({ patches: [], change: undefined, value: undefined, refused: true })
					: fn({
						patches: fact.patches,
						change: fact.change === undefined ? undefined : viewOf(base, fact.change),
						value: fact.entry?.value,
					}),
			{ part: n.part },
		)
		s.registerTeardown(owner(), stop)
		return stop
	}

	function place(p: string | Path, x: Target) {
		inside(() => {
			const path = resolve(p)
			const id = idThrough(x)
			const parent = get(places, path.slice(0, -1))
			if (parent === undefined || path.length === 0) {
				throw new PlacesError("nothing-there", path.join("/"))
			}
			placeUnder(parent, path[path.length - 1], id, path)
		})
		queuePulse()
	}

	// x's children, each as a handle (reached by this process's path, so its own to hold)
	function readChildren(x: Target): Record<string, Node> {
		const n = nodeOf(x)
		const id = idOf(n)
		const names = list(x)
		const kids = id === undefined
			? {}
			: places.readValue("children", id) as Record<string, Id> | undefined ?? {}
		const out: Record<string, Node> = {}
		for (const name of names) {
			const at = n.path === undefined ? kids[name] : get(places, [...n.path, name]) ?? kids[name]
			if (at !== undefined) out[name] = byId(at, "value")
		}
		return out
	}

	// every version of x's part; children's ids turned handles (no ids given out)
	function readAllOf(
		x: Target,
		part: "value" | "attributes" | "children",
		path: readonly Step[] = [],
	): Version[] {
		const all = reads(handle({ ...nodeOf(x), part }), path)
		if (part !== "children") return all
		return all.map((v) => ({ ...v, value: handlesFor(v.value) }))
	}
	const handlesFor = (v: unknown) =>
		v === null || typeof v !== "object" ? v : Object.fromEntries(
			Object.entries(v as Record<string, unknown>).map(([k, id]) => [
				k,
				typeof id === "string" ? byId(id, "value") : id,
			]),
		)
	const explainOf = (x: Target, part: "value" | "attributes" | "children") =>
		explain(handle({ ...nodeOf(x), part }))

	// a folder's names patched: one name a patch, { path: [name], value: node } placing node there,
	// { path: [name] } unplacing it; anything else not-patches (a process never writes a children
	// entry whole: its ids). each name asked "place", as place asks
	function patchChildren(x: Target, patches: readonly Patch[]) {
		inside(() => {
			const n = nodeOf(x)
			const folder = needId(n)
			for (const p of patches) {
				const name = p.path[0]
				if (p.path.length !== 1 || typeof name !== "string" || p.move !== undefined) {
					throw new ErmineError(
						"not-patches",
						"patchChildren: one name a patch, { path: [name], value: node } or { path: [name] }",
					)
				}
				ask("place", slotOf(thing(folder, n.path), name))
				const children = table.get("children", folder) as Entry<unknown> | undefined
				if ("value" in p && p.value !== undefined) {
					const id = idThrough(p.value as Target)
					inner.put({ part: "children", id: folder, patches: placing(children, name, id) })
				} else if (children !== undefined) {
					inner.put({ part: "children", id: folder, patches: unplacing(children, name) })
				}
			}
		})
		queuePulse()
	}

	// f with nothing it reads tracked (a read of a pending memo: undefined, as peep's)
	function untrack<T>(f: () => T): T {
		peeping++
		try {
			return places.peep(() => {
				try {
					return f()
				} catch (e) {
					if (e === PENDING) return undefined as T
					throw e
				}
			})
		} finally {
			peeping--
		}
	}

	function unplace(p: string | Path) {
		inside(() => {
			const path = resolve(p)
			const [children, name] = slot(path)
			const parent = get(places, path.slice(0, -1))!
			ask("place", slotAt(path, parent))
			inner.put({ part: "children", id: parent, patches: unplacing(children, name) })
		})
		queuePulse()
	}

	function move(from: string | Path, to: string | Path) {
		inside(() => {
			const fromPath = resolve(from)
			const source = slot(fromPath)
			const sourceParent = get(places, fromPath.slice(0, -1))!
			guard.move(fromPath, resolve(to))
			ask("place", slotAt(fromPath, sourceParent))
			const path = resolve(to)
			const parent = get(places, path.slice(0, -1))
			if (parent === undefined || path.length === 0) {
				throw new PlacesError("nothing-there", path.join("/"))
			}
			ask("place", slotAt(path, parent))
			const into = table.get("children", parent) as Entry<unknown> | undefined
			const moved = (source[0].value as Record<string, Id> | undefined)?.[source[1]]
			for (const m of moving(source, [into, path[path.length - 1]])) {
				inner.put({
					part: "children",
					id: m.entry === "from" ? sourceParent : parent,
					patches: m.patches,
				})
			}
		})
		queuePulse()
	}

	function remove(x: Target) {
		inside(() => {
			const n = nodeOf(x)
			const id = needId(n)
			ask("remove", targetOf(thing(id, n.path)))
			if (n.path !== undefined && n.path.length) {
				const [children, name] = slot(n.path)
				const v = children.value as Record<string, unknown> | undefined
				if (v !== undefined && v[name] === id) {
					const parent = get(places, n.path.slice(0, -1))!
					inner.put({ part: "children", id: parent, patches: unplacing(children, name) })
				}
			}
			for (const [part] of table.get(id)) inner.put({ part, id, patches: [], gone: true })
			runs.drop(id)
			base.held.drop(id)
		})
		queuePulse()
	}

	// a memo's or effect's code, in place: a run of its owner making it again gives it new code
	type Code = {
		// deno-lint-ignore no-explicit-any
		f: (previous: any) => unknown
		// deno-lint-ignore no-explicit-any
		act?: (value: any, before: any) => void
		// deno-lint-ignore no-explicit-any
		equal?: Equal<any>
	}
	// what is made at each path (its names), by owner: the computer, its node's id, its code
	type Made = { own: Scope; c?: Computer; id: Id; code: Code }
	const named = new Map<string, Set<Made>>()
	const keyOf = (path: Path) => JSON.stringify(path)

	// the one made at path under own: claimed, given new code (a parent's rerun does not destroy
	// its children; two of a name in one run are refused). as own's run starts, what its earlier
	// runs made is old (the scheduler's): one old is claimed; one not old was made in this run (or
	// own has had no run since): already-there. none: a new one is to be made
	function again(own: Scope, path: Path, code: Code): Made | undefined {
		for (const m of named.get(keyOf(path)) ?? []) {
			if (m.own !== own || m.c === undefined || m.c.state !== "alive") continue
			if (!s.claim(m.c)) throw new PlacesError("already-there", path.join("/"))
			m.code = code
			gone(m, path)
			queuePulse()
			return m
		}
	}

	// m's node and name go once its computer has: asked again in each run of its owner that makes
	// it (a cleanup of that run: run once the next run is done, it finds the computer claimed,
	// alive, and leaves it), and as the owner goes (what is under it first)
	function gone(m: Made, path: Path) {
		s.registerTeardown(m.own, () => {
			if (m.c?.state === "alive") return
			const there = named.get(keyOf(path))
			if (there?.delete(m) && there.size === 0) named.delete(keyOf(path))
			memos.delete(m.id)
			base.computers.delete(m.id)
			base.contexts.delete(m.id)
			base.awaiting.delete(m.id)
			try {
				const [children, last] = slot(path)
				if ((children.value as Record<string, unknown>)?.[last] === m.id) {
					const parent = get(places, path.slice(0, -1))!
					inner.put({ part: "children", id: parent, patches: unplacing(children, last) })
				}
			} catch (e) {
				if (!(e instanceof PlacesError)) throw e
			}
			for (const [part] of table.get(m.id)) {
				inner.put({ part, id: m.id, patches: [], gone: true })
			}
			runs.drop(m.id)
			base.held.drop(m.id)
		})
	}

	// a computer's node: a new id, placed at path, its scope written (own's NODE key, or the
	// nearest above with one; none: not written); told to named, its node and name gone with it.
	// made in a call: the call's record says so
	function computerNode(own: Scope, path: Path, code: Code, kind: "memo" | "effect" | "early") {
		const id = newId()
		const above = nodeAbove(own)
		inside(() => {
			const parent = get(places, path.slice(0, -1))
			if (parent === undefined) throw new PlacesError("nothing-there", path.join("/"))
			placeUnder(parent, path[path.length - 1], id, path)
			if (above !== undefined) {
				inner.put({ part: "attributes", id, patches: [{ path: [SCOPE], value: above }] })
			}
		})
		const m: Made = { own, id, code }
		const at = keyOf(path)
		named.set(at, (named.get(at) ?? new Set()).add(m))
		gone(m, path)
		base.computers.add(id)
		base.contexts.set(id, inner)
		calls.going(own)?.made.push({ kind, id, path })
		return m
	}

	const same = (m: Made) => (a: unknown, b: unknown) =>
		m.code.equal ? m.code.equal(a, b) : Object.is(a, b)

	// m's code run: a promise given marks its node awaiting till it settles
	const ran = (m: Made, previous: unknown) => {
		const r = m.code.f(previous)
		if (isThen(r)) {
			base.awaiting.add(m.id)
			const done = () => void base.awaiting.delete(m.id)
			r.then(done, done)
		} else base.awaiting.delete(m.id)
		return r
	}

	function memo<T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		options: { equal?: Equal<T> } = {},
	): Node {
		const own = owner()
		const path = resolve(name)
		const n: NodeData = { path, part: "value" }
		const code: Code = { f, equal: options.equal }
		if (again(own, path, code)) return handle(n)
		const m = computerNode(own, path, code, "memo")
		const id = m.id
		memos.add(id)
		const set = (v: T) => {
			if (v !== undefined || table.get("value", id) !== undefined) {
				inner.put({ part: "value", id, patches: whole(v) })
			}
		}
		const c = s.runWithScope(
			own,
			() =>
				base.sited.createComputer<T>(
					(previous) => ran(m, previous) as T,
					set,
					same(m),
					undefined,
					{ [NODE]: id },
				),
		)
		m.c = c
		base.statuses.give(c, id)
		runs.give(c, id)
		parts.onCreateFunction?.({ kind: "memo", computer: c, node: n, id, process: inner.node })
		queuePulse()
		return handle(n)
	}

	function effect<T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options: { equal?: Equal<T> } = {},
	): Node {
		return effectOf(false, name, f, act, options)
	}

	function early<T>(
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options: { equal?: Equal<T> } = {},
	): Node {
		return effectOf(true, name, f, act, options)
	}

	// an effect, early or not. an early one runs, and acts, inside createEffect: before its
	// computer is given back, so its first run gives the status and the run record its node, from
	// inside it (runs.ts: a run given while it ran)
	function effectOf<T>(
		isEarly: boolean,
		name: string | Path,
		f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
		act: (value: T, before: T | undefined) => void,
		options: { equal?: Equal<T> },
	): Node {
		const own = owner()
		const path = resolve(name)
		const n: NodeData = { path, part: "value" }
		const code: Code = { f, act, equal: options.equal }
		if (again(own, path, code)) return handle(n)
		const m = computerNode(own, path, code, isEarly ? "early" : "effect")
		const id = m.id
		let given = false
		const run = (previous: T | undefined) => {
			if (!given) {
				given = true
				const c = s.getRun()!.computer
				base.statuses.give(c, id)
				runs.give(c, id)
			}
			return ran(m, previous) as T
		}
		const then = (v: T, before: T | undefined) => {
			if (v !== undefined || table.get("value", id) !== undefined) {
				inner.put({ part: "value", id, patches: whole(v) })
			}
			m.code.act!(v, before)
		}
		const c = s.runWithScope(
			own,
			() =>
				isEarly
					? base.sited.createEffect<T>(run, then, same(m), { early: true }, { [NODE]: id })
					: base.sited.createEffect<T>(
						(previous) => ran(m, previous) as T,
						then,
						same(m),
						undefined,
						{ [NODE]: id },
					),
		)
		m.c = c
		base.statuses.give(c, id)
		runs.give(c, id)
		parts.onCreateFunction?.({ kind: "effect", computer: c, node: n, id, process: inner.node })
		queuePulse()
		return handle(n)
	}

	// deno-lint-ignore no-explicit-any
	function method(p: string | Path, fn: (...args: any[]) => unknown): Node {
		const own = owner()
		const path = resolve(p)
		const made = inside(() => {
			const id = get(places, path)
			if (id === undefined) return build(path, fn)
			ask("edit", targetOf(thing(id, path), "value"))
			inner.put({ part: "value", id, path, patches: whole(fn) })
			return id
		})
		// kept while own is: own going takes it out, unless a later placement took over. one
		// teardown per (own, node), however often it is placed; a computer's cleanup after a run
		// (own still alive) passes it on to the next run's
		methods.set(made, { fn, scope: own })
		let mine = placers.get(own)
		if (mine === undefined) placers.set(own, mine = new Set())
		if (!mine.has(made)) {
			mine.add(made)
			const set = mine
			const keep = () => {
				if (methods.get(made)?.scope !== own) return void set.delete(made)
				if (own.state === "alive") return s.registerTeardown(own, keep)
				set.delete(made)
				methods.delete(made)
			}
			s.registerTeardown(own, keep)
		}
		const n: NodeData = { path, part: "value" }
		parts.onCreateFunction?.({ kind: "method", node: n, id: made, process: inner.node })
		queuePulse()
		return handle(n)
	}

	function send(p: Target, ...args: unknown[]): unknown {
		const n = nodeOf(p)
		const id = idOf(n)
		const at = n.path !== undefined ? { path: n.path } : { id: n.id }
		// in a run, the computer waits; else whoever this context is
		const run = s.getRun()
		const caller = (run?.computer.info[NODE] as Id | undefined) ?? inner.node
		// tracked in a run, so the handler coming reruns it
		const fn = id === undefined ? undefined : places.readValue("value", id)
		if (fn === undefined) {
			// kept while the caller is: a computer's with it, else the context's
			calls.wait(caller, at, context.box.root, run?.computer ?? scope)
			throw PENDING
		}
		if (typeof fn !== "function") {
			throw new SendError("not-a-method", n.path?.join("/") ?? "a node it was handed")
		}
		calls.answered(caller, at)
		const k = calls.next()
		// the placement's scope while the node still holds what was placed; else (its owner gone, or
		// a function written there by edit) the sender's, as any function value
		const placed = methods.get(id!)
		// the caller on the call's changes, its own field: its node, and the actor its writes carry
		// (the handler's writes are the handler's: their actor its own)
		const call = base.sited.createScope(
			{ caller: { node: inner.node, actor: actorHere() }, handler: id, call: k },
			placed !== undefined && placed.fn === fn ? placed.scope : scope,
		)
		try {
			s.runWithScope(call, () => ask("execute", targetOf(thing(id!, n.path), "value")))
		} catch (e) {
			s.teardown(call)
			throw e
		}
		const g = calls.begin(k, call, {
			caller: inner.node,
			context,
			handler: { id: id!, change: table.get("value", id!)?.change },
			args,
		})
		// the call scope lasts as the record does: a promise's till it settles (the record ended
		// first), else till the handler returns or throws
		let out: unknown
		try {
			out = s.runWithScope(call, () => fn(...args))
			calls.end(g, { returned: out })
		} catch (e) {
			calls.end(g, e === PENDING ? { pending: true } : { error: e })
			s.teardown(call)
			queuePulse()
			throw e
		}
		if (isThen(out)) {
			const ended = () => {
				s.teardown(call)
				queuePulse()
			}
			out.then(ended, ended)
		} else s.teardown(call)
		queuePulse()
		return out
	}

	// why a teardown's scope goes: a stop's reason; a call ending (the scope a call's, or under
	// one): ended; else, the process still there, its owner ran again (replaced), or ended
	const inCall = (own: Scope) => {
		for (let o: Scope | undefined = own; o !== undefined && o !== scope; o = o.parent) {
			if (calls.going(o) !== undefined) return true
		}
		return false
	}
	function teardown(fn: (why: Why) => unknown) {
		const own = owner()
		s.registerTeardown(own, () => {
			const why = base.whys.get(inner.node) ??
				(scope.state !== "alive" || (own.state !== "alive" && inCall(own))
					? "ended"
					: "replaced")
			base.torn(own, why, fn)
		})
	}

	function ref<T>(p: string | Path, made: () => T): Node {
		const path = resolve(p)
		inside(() => {
			if (get(places, path) === undefined) build(path, made())
		})
		queuePulse()
		return handle({ path, part: "value" })
	}

	function box(where: string | Path): BoxNode {
		// its writes, this context's (through onWrite)
		const host = { ...base.host, write: inner.writer }
		const at = resolve(where)
		const b = inside(() => createBox(host, at, context.box, header()))
		queuePulse()
		const handle: BoxNode = {
			at,
			place: base.entered((p: string | Path, y: Target) => {
				const id = idThrough(y)
				inside(() => void boxInto(b, p, id, header()))
				queuePulse()
			}),
			unplace: base.entered((p: string | Path) => {
				inside(() => void unbox(b, p, header()))
				queuePulse()
			}),
		}
		base.boxes.set(handle, b)
		return handle
	}

	// the base's, then what features show (onStatus)
	function status(x: Target): Status | undefined {
		const n = nodeOf(x)
		const id = idOf(n)
		if (id === undefined) return undefined
		return base.statused({ node: n, id }, ownStatus(n, id))
	}

	// a send's wait as this process sees it: where the send went (its path in the sender's box, or
	// the node it named), none outside this box
	const waitOf = (w: { path?: Path; id?: Id; box: Id; since: number }): Waiting => ({
		send: (w.path !== undefined ? pathIn(base, inner, w.box, w.path) : seen(w.id!)) ?? null,
		since: w.since,
	})
	// a wait a process's status says (written as start goes pending): a send's as waitOf, the rest as
	// it is
	const saidOf = (w: unknown): Waiting => {
		if (w !== null && typeof w === "object" && "send" in w) {
			const { send, box, since } = w as { send: Path | Id; box: Id; since: number }
			return waitOf(
				Array.isArray(send) ? { path: send, box, since } : { id: send as Id, box, since },
			)
		}
		return w as Waiting
	}

	function ownStatus(n: NodeData, id: Id): Status {
		if (guarded) guard.read(targetOf(thing(id, n.path), STATUS_TABLE, [STATUS]))
		const st = places.readValue(STATUS_TABLE, id, [STATUS])
		const h = base.held.status(id) ?? base.held.row(id)
		const held = h === undefined ? {} : { held: h }
		if (!base.computers.has(id)) {
			if (st === undefined) return { state: "done", ...held }
			if (st !== PENDING) return { state: "failed", error: st, ...held }
			const said = places.readValue(STATUS_TABLE, id, [WAITING])
			const live = calls.waits(id).map(waitOf)
			const waiting = Array.isArray(said) && said.length ? said.map(saidOf) : live
			return { state: "pending", waiting: waiting.length ? waiting : ["PENDING"], ...held }
		}
		const r = runs.read(id)
		const nOf = r === undefined ? { ...held } : { n: r.n, ...held }
		if (st === undefined) return { state: "done", ...nOf }
		if (st !== PENDING) {
			if (r?.end === "looping") return { state: "looping", error: st, ...nOf }
			const phase = r?.end !== "failed" && r?.act?.end === "failed" ? "act" : "run"
			return { state: "failed", error: st, phase, ...nOf }
		}
		const waiting: Waiting[] = []
		for (const w of r?.reads ?? []) {
			if (!("part" in w) || w.part !== STATUS_TABLE || w.id === id) continue
			if (w.path?.length !== 1 || w.path[0] !== STATUS) continue
			if (places.peep(() => places.readValue(STATUS_TABLE, w.id, [STATUS])) === PENDING) {
				waiting.push({ node: seen(w.id) ?? null })
			}
		}
		for (const w of calls.waits(id)) waiting.push(waitOf(w))
		if (base.awaiting.has(id)) waiting.push("a promise")
		if (waiting.length === 0) waiting.push("PENDING")
		return { state: "pending", waiting, ...nOf }
	}

	function explain(x: Target | ChangeView, path: readonly Step[] = []): Explained | undefined {
		// a change's view (a reads item's from.change, a watch's): its change. a view is known only
		// by base.changes, so none can be forged into a record's lookup
		const viewed = typeof x === "object" && !isHandle(x) && !Array.isArray(x)
			? base.changes.get(x as ChangeView)
			: undefined
		if (viewed !== undefined) return writerOf(viewed)
		if (typeof x === "object" && !isHandle(x) && !Array.isArray(x)) {
			throw new PlacesError("nothing-there", "not a change this ermine shows")
		}
		const n = nodeOf(x)
		const id = idOf(n)
		if (id === undefined) return undefined
		if (guarded) guard.read(targetOf(thing(id, n.path), n.part, path))
		places.readChange(n.part, id)
		const change = (table.get(n.part, id) as Entry<unknown> | undefined)?.change
		const h = base.held.at(n.part, id)
		if (change === undefined) return h === undefined ? undefined : { held: h }
		const by = writerOf(change)
		return h === undefined ? by : { ...by, held: h }
	}

	// a record's read or write, as this process sees it
	const touched = (t: { part: Key; id: Id }): Touched => {
		const p = seen(t.id)
		return p === undefined ? { part: t.part } : { part: t.part, path: p }
	}
	const pathOf = (id: Id) => {
		const p = seen(id)
		return p === undefined ? {} : { path: p }
	}
	const runView = (r: Run): RunView => ({
		n: r.n,
		...r.started !== undefined && { started: r.started },
		ended: r.ended,
		end: r.end,
		..."error" in r && { error: r.error },
		...r.act !== undefined && { act: r.act },
		reads: r.reads.flatMap((x) => "part" in x ? [touched(x)] : []),
		writes: r.writes.map(touched),
	})
	const callView = (c: Call): CallView => ({
		n: c.n,
		args: c.args,
		end: c.end,
		..."returned" in c && { returned: c.returned },
		..."error" in c && { error: c.error },
		started: c.started,
		...c.ended !== undefined && { ended: c.ended },
		reads: c.reads.flatMap((x) => "part" in x ? [touched(x)] : []),
		writes: c.writes.map(touched),
		...c.made !== undefined && { made: c.made.map((m) => ({ kind: m.kind, ...pathOf(m.id) })) },
	})

	// the call open now: its scope's info names its caller (send's call scope)
	function getCaller(): Caller | undefined {
		for (let o: Scope | undefined = owner(); o !== undefined; o = o.parent) {
			if (o.info.call === undefined || o.info.handler === undefined) continue
			const c = o.info.caller as { node?: Id; actor?: unknown } | undefined
			const p = c?.node === undefined ? undefined : seen(c.node)
			return p === undefined ? { actor: c?.actor } : { actor: c?.actor, process: p }
		}
		return undefined
	}

	// the change's writer, one step: its view, the writer by path as this process sees it
	function writerOf(change: ChangeHeader): Explained & { change: ChangeView } {
		const m = change.metadata ?? {}
		const holds = (writes: readonly { change: ChangeHeader | undefined }[]) =>
			writes.some((w) => w.change === change)
		const view = viewOf(base, change)
		if (m.run !== undefined && m[NODE] !== undefined) {
			const computer = m[NODE] as Id
			const run = runs.read(computer)
			return run !== undefined && run.n === m.run && holds(run.writes)
				? { change: view, writer: { kind: "computer", ...pathOf(computer), run: runView(run) } }
				: { change: view, writer: { kind: "computer", ...pathOf(computer) } }
		}
		if (m.call !== undefined && m.handler !== undefined) {
			const handler = m.handler as Id
			const call = calls.latest(handler)
			if (call !== undefined && call.n === m.call && holds(call.writes)) {
				return {
					change: view,
					writer: { kind: "method", ...pathOf(handler), call: callView(call) },
				}
			}
			return { change: view, writer: { kind: "method", ...pathOf(handler) } }
		}
		const site = change.external?.[0]
		return {
			change: view,
			writer: {
				kind: "outside",
				...site !== undefined && { site },
			},
		}
	}

	const e = base.entered
	// a word on a handle another context made: that context's own word does it (the handle's
	// capability: resolved in its maker's box and cwd, asked as its maker)
	const via = <K extends keyof HostAPI>(name: K, f: HostAPI[K]): HostAPI[K] =>
		((x: unknown, ...a: unknown[]) => {
			if (isHandle(x)) {
				const d = dataOf(base.handles, x)
				const theirs = d.maker === inner ? undefined : base.words.get(d.maker)
				if (theirs !== undefined) {
					return (theirs[name] as (...a: unknown[]) => unknown)(x, ...a)
				}
			}
			return (f as (...a: unknown[]) => unknown)(x, ...a)
		}) as HostAPI[K]
	// the writers entered: a write's site is the program's call into one
	const api: HostAPI = {
		open: e(open),
		create: e(create),
		make: e(make),
		read: via("read", read),
		peep: via("peep", peep),
		reads: via("reads", reads),
		entries: via("entries", entries),
		list: via("list", list),
		info: via("info", info),
		edit: via("edit", e(edit)),
		watch: via("watch", watch),
		place: e(place),
		unplace: e(unplace),
		move: e(move),
		remove: via("remove", e(remove)),
		memo: e(memo),
		effect: e(effect),
		early: e(early),
		method: e(method),
		send: via("send", e(send)),
		teardown,
		ref: e(ref),
		box: e(box),
		status: via("status", status),
		explain: via("explain", explain),
		getCaller,
		readChildren: via("readChildren", readChildren),
		readAllOf: via("readAllOf", readAllOf),
		explainOf: via("explainOf", explainOf),
		patchChildren: via("patchChildren", e(patchChildren)),
		untrack,
		args: context.args,
		pulse: () => s.pulse(),
		PENDING,
		REFUSED,
	}
	if (!base.words.has(inner)) base.words.set(inner, api)
	return api
}

export type { Table }
