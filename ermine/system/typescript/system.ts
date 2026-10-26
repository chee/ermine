// @ermine/system's functions [chee 10-25: "let's change the process api to be verb first … a very
// clear mechanical api"; "the let's do @ermine/system"]. each is one function, shared by every
// process: it finds the context it acts as (systemFrom's at: a process's from the scope open,
// registry.ts; the host's, for the host's ermine object) and does its work as that context. no api
// object per process [chee 10-25: ">Drop the objects. ye"]. programs import them from
// @ermine/system (ermine/system/mod.ts); each below takes the context first, as systemFrom calls it.
//
// one verb for each of a node's three parts [chee 10-25: "i wonder if we should have readChildren
// peepChildren readChildrenVersions explainChildren patchChildren and we build these other things
// atop. i also thing we should drop `value` from the value ones"; "we'll go with peep"; readAll: "i
// guess is best of these"]:
//            value        attributes          children
// read       read         readAttributes      readChildren ({ name: node })
// every one  readAll      readAllAttributes   readAllChildren
// write      patch        patchAttributes     patchChildren (one name a patch: a node, or none)
// who        explain      explainAttributes   explainChildren
// untracked  peep(f): f with nothing it reads tracked
// nodes      getNode (makes nothing), hasNode, ensureNode (made, with value or nothing, only if
//            missing), createNode (a fresh name), ref (make() only if missing: a live value),
//            readEntries (every node a path reaches)
// names      place, unplace (patchChildren's rule, by a path), rename (one change over two
//            folders, its cycle check), list
// computing  createMemo, createEffect ({ early }), watch (until pipes)
// actions    createAction, executeAction, getCaller
// the rest   getStatus, addTeardown, createBox, getArgs, PENDING, REFUSED
// the host's only: remove, pulse
//
// paths: a bare name inside the process's node (the host's: the root), gone at stop; ./ its cwd;
// ../ above; / its box's root. a node: a path (walked at each use) or a handle (handles.ts: the
// node and the context that made it, resolved and asked as that context; the rest of a call stays
// the caller's). no ids anywhere a process is given [chee 10-25]: paths as it sees them (seenIn),
// handles for what it reached, changes as views.
// pulses: every write and every promise settling asks for one. a read after a write sees it at
// once; a memo gives its last result until the pulse.
// writes: patches only, never a recipe [chee 10-25]; under the open scope (nothing open: a
// process's throws nothing-open, the host's falls back to its own scope); each value and attribute
// write through onWrite. a write's site: outside a run, the program's call into the api; in a run,
// the running memo's or effect's own line.
//
//   read(x, key?)        the value at key, tracked; none: undefined; a pending memo with no value
//                        throws PENDING
//   readAll(x, key?)     every value at key, tracked: [{ value, from }]. position 0 read's, from:
//                        { change } (a ChangeView: time, actor, site); then what features show
//                        (onRead), each from naming its feature
//   readEntries(x)       every node x's path reaches: [{ value, from, node?, refused? }], node a
//                        handle; refused: no value, no node
//   watch(x, fn)         fn at each write at x, with patches, change (a view) and value (refused:
//                        refused, none of them); returns the stop
//   place(p, x)          x's node at a second name. unplace(p): the name out, the node stays.
//                        remove(x), the host's only: unplaced and its entries deleted; a process
//                        unplaces, and a node no name reaches no longer exists [chee 10-25]
//   createMemo(name, f, o?)   a compute at its own node at name: its result, status and latest
//                        run; made again by its owner's next run (same node, new f); a name not
//                        made again goes after the run. a second at a name in one run: already-there
//   createAction(p, fn)  fn as the node's value, run by executeAction in a scope under the open one
//   executeAction(p, ...args)  the action at p, in a call scope { caller: { node, actor },
//                        handler, call }; its return. its record (calls.ts) held as the handler's
//                        latest. nothing there: pending, loudly (a wait recorded, PENDING thrown,
//                        so a memo or effect running it reruns when the action comes). a value no
//                        function: not-a-method
//   addTeardown(fn)      fn(why) as the open scope goes, through onTeardown: "replaced", "ended",
//                        or a stop's reason
//   createBox(at)        a box: the folder at, seen from its own "/" (ermine/boxes), as a handle:
//                        { at, place, unplace }
//   getStatus(x)         tracked: { state, error?, phase?, waiting?, n? }; not there: undefined.
//                        waiting names nodes by path as this process sees them (null: outside)
//   explain(x, key?)     tracked: a change and its writer, one step. x a change's view: that one;
//                        a node: its entry's, and a write held there. the writer and its record
//                        name nodes by path as this process sees them (null: outside its box)
//   getCaller()          in an action: { actor, process? }; elsewhere: undefined
//
// a memo or effect made in an action's call goes with the call, and the call's record says so
// (made). the call lasts as its record does: a promise's till it settles; then its teardowns are
// told "ended". protect: reads ask "read" (refused: Refusal; readEntries keeps the item, refused);
// watch is asked as it is made, and at each write told; patch "edit"; ensureNode, createNode,
// place, unplace, rename "place" on the slot; remove "remove"; executeAction "execute"; a memo's
// and effect's own writes not asked.
// scope nodes: a write's metadata stops after the first scope whose own info holds the NODE key. a
// process's scope holds its node's; each memo and effect is made with { [NODE]: its node's id }.
import type { ChangeHeader, Entry } from "@ermine/core/node/entry"
import type { Key as Step, Patch } from "@ermine/core/op/apply"
import { type Box, box as boxInto, createBox as makeBox, type Host, unbox } from "@ermine/boxes"
import {
	type Fact,
	type Id,
	moving,
	type Path,
	type Places,
	PlacesError,
	placing,
	unplacing,
} from "@ermine/core/places"
import { parse, plan } from "@ermine/core/places/path"
import { get, gets, list as listAt } from "@ermine/core/places/lib"
import { NODE } from "@ermine/core/places/header"
import {
	Refusal,
	REFUSED,
	slot as slotOf,
	target as targetOf,
	type Thing,
} from "@ermine/core/places/guard"
import { STATUS, TABLE as STATUS_TABLE } from "@ermine/core/places/status"
import type { Run, Runs } from "@ermine/processes/runs"
import { type Computer, type Equal, PENDING, type Scope } from "@ermine/core/scheduler"
import type { Sited } from "@ermine/sites"
import type { Key, Table } from "@ermine/core/table"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import type { Call, Calls } from "./calls.ts"
import type { Found } from "./registry.ts"
import type { Target as Aimed } from "@ermine/core/protect"
import { type Asked, ErmineError, type Reading } from "./features.ts"
import { dataOf, type Handles, isHandle, mint } from "./handles.ts"
import {
	empty,
	type Inner,
	type Node,
	type NodeData,
	type Parts,
	type ProcessContext,
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
// or placed by no functions): no ids [chee 10-25: "i'm not sure the process api should be able to do
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
	// what each reader is waiting to be there: a read of a node not there (thrown PENDING), by the
	// reader (a computer's node, in which run; else the context's node), the paths as it read them
	readonly missing: Map<Id, { readonly n?: number; readonly paths: Path[] }>
	// each method placed, by its node: the function, and the scope open when it was placed (one
	// function placed by two owners: each placement its own). gone with that scope
	readonly methods: Map<Id, { readonly fn: unknown; readonly scope: Scope }>
	// why a process is stopping (by its node), said by stop before its scope goes
	readonly whys: Map<Id, Why>
	readonly newId: () => string
	// every node handle the functions gave (handles.ts)
	readonly handles: Handles
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
	// every box, the root's first: where a handle's path from the root is walked (walkFrom)
	readonly boxList: Box[]
	// f as a public function: a write's site outside a run is its caller
	readonly entered: <F extends (...args: never[]) => unknown>(f: F) => F
	// f(inner, ...a) with the entry here: a write made in it has its site at the line that called in
	readonly enter: <A extends unknown[], T>(
		f: (inner: Inner, ...a: A) => T,
		inner: Inner,
		a: A,
	) => T
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

// one context's setting, what every function below works from: its ermine's base, its own
// (places, guard, scope, asks), and its state (a peep going; the memos, effects and earlies its
// owners' runs made, by name). no api object per process [chee 10-25: ">Drop the objects. ye"]:
// each function is given the context it found (systemFrom) and works from its setting
const bases = new WeakMap<Inner, Base>()
const inners = new WeakMap<ProcessContext, Inner>()
const settings = new WeakMap<Inner, Setting>()
type Setting = ReturnType<typeof setting>
// a context of base's: each one base makes, before any function is given it
export function attach(base: Base, inner: Inner) {
	bases.set(inner, base)
	inners.set(inner.context, inner)
}
// a process context's inner side (the host's and features' code: the harness, ermine.api)
export const innerOf = (context: ProcessContext): Inner | undefined => inners.get(context)
function setting(inner: Inner) {
	const base = bases.get(inner)
	if (base === undefined) throw new ErmineError("not-yet", "a process context no ermine made")
	const { parts, calls, runs, memos, methods, newId } = base
	const { scheduler: s, table, queuePulse } = parts
	const { context, places, guard, guarded, inside } = inner
	return {
		base,
		parts,
		calls,
		runs,
		memos,
		methods,
		newId,
		s,
		table,
		queuePulse,
		context,
		places,
		guard,
		guarded,
		inside,
		scope: context.scope,
		resolve: context.resolve,
		ask: context.ask,
		state: { peeping: 0, named: new Map<string, Set<Made>>() },
	}
}
function here(c: Inner): Setting {
	let h = settings.get(c)
	if (h === undefined) settings.set(c, h = setting(c))
	return h
}

const header = (inner: Inner) => {
	const { parts } = here(inner)
	return parts.header()
}

const owner = (inner: Inner) => {
	const { s, scope } = here(inner)
	return s.getCurrentScope() ?? scope
}
// the actor a write made now would carry: the first the open scope (none: the context's) or one
// above it gives
const actorHere = (inner: Inner) => {
	for (let o: Scope | undefined = owner(inner); o !== undefined; o = o.parent) {
		if ("actor" in o.info) return o.info.actor
	}
	return undefined
}
const thing = (id: Id, path?: Path): Thing => path === undefined ? { id } : { id, path }
// the parent at path's folder, and the name: what placing there changes
const slotAt = (inner: Inner, path: Path, parent: Id) =>
	slotOf(thing(parent, path.slice(0, -1)), path[path.length - 1])

// a box's folder's path from the root now (up its names); the root's box: []
const boxAt = (base: Base, box: Id): Path | undefined =>
	up(base, base.host.places, base.host.places.root, box)

// where a path from the root is walked: in the deepest box whose folder is on it (so a boxed
// process's own nodes, named by its rows, are reached), the path in that box
function walkFrom(base: Base, abs: Path): { places: Places; path: Path } {
	let found = { places: base.host.places, path: abs }, depth = 0
	for (const b of base.boxList) {
		const at = boxAt(base, b.root)
		if (at === undefined || at.length < depth || at.length > abs.length) continue
		if (!at.every((n, i) => abs[i] === n)) continue
		found = { places: b.places, path: abs.slice(at.length) }
		depth = at.length
	}
	return found
}

// what x reaches, as inner reaches it: a path (resolved here); a handle's place (its path from the
// root: in inner's box, the path as inner sees it; outside it, the node there by id, and nothing
// there: nothing-there, naming no path, so a process is never told where something outside its
// box sits); a handle by id, that node. an object that is no handle: not-a-handle
function nodeOf(inner: Inner, x: Target): NodeData {
	const { base, parts, resolve } = here(inner)
	parts.alive()
	if (typeof x === "string" || Array.isArray(x)) {
		const path = resolve(x)
		// a box further down the path (a process started in a box, under one's own place): its own
		// view holds its rows, so the node is found there, by id (the review's finding 11)
		const at = boxAt(base, inner.context.box.root)
		if (at !== undefined && base.boxList.length > 1) {
			const w = walkFrom(base, [...at, ...path])
			if (w.places !== inner.places) {
				const id = get(w.places, w.path)
				if (id !== undefined && get(inner.places, path) !== id) return { id, part: "value" }
			}
		}
		return { path, part: "value" }
	}
	const d = dataOf(base.handles, x).node
	if (d.path === undefined) return d
	// in inner's box and walked the same there: the path as inner sees it (so asks and watches go by
	// it); else the node at the place, by id
	const at = boxAt(base, inner.context.box.root)
	const w = walkFrom(base, d.path)
	const id = get(w.places, w.path)
	if (at !== undefined && at.every((n, i) => d.path[i] === n)) {
		const mine = d.path.slice(at.length)
		if (id === undefined || get(inner.places, mine) === id) return { path: mine, part: d.part }
	}
	if (id === undefined) throw new PlacesError("nothing-there")
	return { id, part: d.part }
}
// a handle for n: a path in inner's box made a path from the root; an id as it is. no maker: a
// handle names a place, whoever made it
const handle = (inner: Inner, n: NodeData): Node => {
	const { base } = here(inner)
	if (n.path === undefined) return mint(base.handles, n)
	const at = boxAt(base, inner.context.box.root) ?? []
	return mint(base.handles, { path: [...at, ...n.path], part: n.part })
}
const byId = (inner: Inner, id: Id, part: Key): Node => handle(inner, { id, part })
// id's path as this process sees it (seenIn; none: outside its box)
const seen = (inner: Inner, id: Id) => {
	const { base } = here(inner)
	return seenIn(base, inner, id)
}
const idOf = (inner: Inner, n: NodeData): Id | undefined => {
	const { places } = here(inner)
	return n.id ?? (n.path ? get(places, n.path) : undefined)
}
// x's id, as inner reaches it
const idThrough = (inner: Inner, x: Target): Id => needId(inner, nodeOf(inner, x))
function needId(inner: Inner, n: NodeData): Id {
	const id = idOf(inner, n)
	if (id === undefined) throw new PlacesError("nothing-there", n.path?.join("/"))
	return id
}

// a node already there given a name in a folder: asked as inner "place" of the
// slot with the node beside, then read and edit of the node (an action's: execute too), so a name
// can't widen what anyone may do with it [chee 10-26: "we will do it the protected_hardlinks way
// for now, it's better to over- than under-"]. x: the node as it was given (the path it came by)
function askPlacing(inner: Inner, slot: Aimed, x: Target, id: Id) {
	const { guard, guarded, methods } = here(inner)
	if (!guarded) return
	const node = targetOf(thing(id, nodeOf(inner, x).path), "value")
	guard.place(slot, node, methods.has(id) ? ["read", "edit", "execute"] : ["read", "edit"])
}

// id placed under name in the folder parent (at path, its name the last): its children entry
// made when it has none
function placeUnder(inner: Inner, parent: Id, name: string, id: Id, path?: Path) {
	const { table, ask } = here(inner)
	if (path !== undefined) ask("place", slotAt(inner, path, parent))
	const children = table.get("children", parent) as Entry<unknown> | undefined
	inner.put({ part: "children", id: parent, patches: placing(children, name, id) })
}
// a node at path holding value (none: nothing in it), the nodes on the way made
function build(inner: Inner, path: Path, value: unknown, given?: Id): Id {
	const { newId, places, ask } = here(inner)
	const id = given ?? newId()
	if (path.length === 0) throw new PlacesError("already-there", "/")
	let parent: Id = places.root
	for (let i = 0; i < path.length - 1; i++) {
		const there = get(places, path.slice(0, i + 1))
		if (there !== undefined) parent = there
		else {
			const folder = newId()
			placeUnder(inner, parent, path[i], folder, path.slice(0, i + 1))
			parent = folder
		}
	}
	ask("place", slotAt(inner, path, parent))
	if (value !== undefined) inner.put({ part: "value", id, path, patches: whole(value) })
	placeUnder(inner, parent, path[path.length - 1], id)
	return id
}
// the children entry of the folder a path is in, and the name
function slot(inner: Inner, path: Path): [Entry<unknown>, string] {
	const { table, places } = here(inner)
	const parent = get(places, path.slice(0, -1))
	const children = parent === undefined ? undefined : table.get("children", parent)
	if (children === undefined || path.length === 0) {
		throw new PlacesError("nothing-there", path.join("/"))
	}
	return [children as Entry<unknown>, path[path.length - 1]]
}

// the node at p, as a handle: made nothing
function getNode(inner: Inner, p: string | Path): Node {
	const { resolve } = here(inner)
	return handle(inner, { path: resolve(p), part: "value" })
}

// the node at p, made (with the folders on the way) if missing: holding value, or nothing (no
// value); there already: as it is
function ensureNode(inner: Inner, p: string | Path, value?: unknown): Node {
	const { queuePulse, places, inside, resolve } = here(inner)
	const path = resolve(p)
	inside(() => {
		if (get(places, path) === undefined) build(inner, path, value)
	})
	queuePulse()
	return handle(inner, { path, part: "value" })
}

// a new node under folder, named by a fresh name of its own: drawn as an id is, but never its id
// (a name is what list gives, and a process holds no ids)
function createNode(inner: Inner, folder: string | Path, value: unknown): Node {
	const { newId, queuePulse, inside, resolve } = here(inner)
	const id = newId()
	const path = [...resolve(folder), String(newId())]
	inside(() => build(inner, path, value, id))
	queuePulse()
	return handle(inner, { path, part: "value" })
}

function read(inner: Inner, x: Target, path: readonly Step[] = []): unknown {
	const { calls, memos, state } = here(inner)
	const t = inner
	const { places, guard, guarded } = here(t)
	const n = nodeOf(t, x)
	const id = idOf(t, n)
	// a node not there: pending, as a memo with no value is ("not there yet" one way) [chee 10-25:
	// "i think a missing node should also throw pending"], the read tracked so its coming reruns it,
	// and said where the reader waits [chee: "the read available in the graph so you can put
	// something somewhere somebody wants it"]
	if (id === undefined) {
		if (n.path !== undefined && state.peeping === 0) waitFor(inner, n.path)
		throw PENDING
	}
	if (guarded) guard.read(targetOf(thing(id, n.path), n.part, path))
	if (state.peeping === 0) calls.read(n.part, id, path)
	if (n.part === "value" && memos.has(id)) {
		const v = places.readValue("value", id, path)
		if (v === undefined && places.readValue(STATUS_TABLE, id, [STATUS]) === PENDING) {
			throw PENDING
		}
		return v
	}
	return places.readValue(n.part, id, path)
}

// read's, from its entry's change; then what features show
function versions(inner: Inner, x: Target, path: readonly Step[] = []): Version[] {
	const { base, table, context } = here(inner)
	const t = inner
	const n = nodeOf(t, x)
	const shown = read(inner, x, path)
	const id = idOf(t, n)
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
const refused = (inner: Inner, t: ReturnType<typeof targetOf>) => {
	const { guard, guarded } = here(inner)
	if (!guarded) return false
	try {
		guard.read(t)
		return false
	} catch (e) {
		if (e instanceof Refusal) return true
		throw e
	}
}

function readEntries(inner: Inner, x: Target): Item[] {
	const { calls, table } = here(inner)
	const t = inner
	const { places, guard, guarded } = here(t)
	const n = nodeOf(t, x)
	if (n.path === undefined) {
		if (n.id === undefined) return []
		if (refused(t, targetOf(thing(n.id), n.part))) {
			return [{ value: undefined, from: "id", refused: true }]
		}
		calls.read(n.part, n.id, [])
		// a node there by id, with or without a value (as by a path); nothing under that id: none
		const value = places.readValue(n.part, n.id)
		if (value === undefined && table.get(n.id).length === 0) return []
		return [{ value, from: "id", node: byId(t, n.id, n.part) }]
	}
	const found = gets(places, n.path)
	for (const a of found) calls.read(n.part, a.id, [])
	if (!guarded || n.path.length === 0) {
		return found.map((a) => ({
			value: places.readValue(n.part, a.id),
			from: a.from,
			node: byId(t, a.id, n.part),
		}))
	}
	const name = n.path[n.path.length - 1]
	const asked = guard.members(found.map((a) => ({ name, id: a.id })), n.path.slice(0, -1))
	return found.map((a, i) =>
		asked[i].id === REFUSED
			? { value: undefined, from: a.from, refused: true as const }
			: { value: places.readValue(n.part, a.id), from: a.from, node: byId(t, a.id, n.part) }
	)
}

function list(inner: Inner, x: Target): string[] {
	const { calls } = here(inner)
	const t = inner
	const { places, guard, guarded } = here(t)
	const n = nodeOf(t, x)
	const id = idOf(t, n)
	if (guarded && id !== undefined) guard.read(targetOf(thing(id, n.path), "children"))
	if (id !== undefined) calls.read("children", id, [], true)
	if (n.path !== undefined) return [...listAt(places, n.path)]
	return n.id === undefined ? [] : places.readKeys("children", n.id)
}

// x's attributes, as a node
const attributesOf = (inner: Inner, x: Target): Node => {
	const t = inner
	return handle(t, { ...nodeOf(t, x), part: "attributes" })
}

// x's part patched: patches only, never a recipe (the base is mechanical [chee 10-25: "the core
// lib should actually not have proxies, and should be this kind of mechanical thing"])
function patch(inner: Inner, x: Target, given: readonly Patch[]) {
	const patches = patchesOnly(given)
	const { queuePulse, inside } = here(inner)
	const t = inner
	const { ask } = here(t)
	inside(() => {
		const n = nodeOf(t, x)
		const id = needId(t, n)
		ask("edit", targetOf(thing(id, n.path), n.part))
		if (patches.length) {
			t.put({
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
function watch(inner: Inner, x: Target, fn: (w: Watched) => void): () => void {
	const { base, s } = here(inner)
	const t = inner
	const { places, guard, guarded } = here(t)
	const n = nodeOf(t, x)
	if (n.path === undefined) throw new PlacesError("nothing-there", "a node with no place")
	const path = n.path
	if (guarded) {
		const id = idOf(t, n)
		guard.read(
			id === undefined ? { path: [...path], part: n.part } : targetOf(thing(id, path), n.part),
		)
	}
	const stop = places.watchPath(
		path,
		(fact: Fact) =>
			refused(t, targetOf(thing(fact.id, path), n.part))
				? fn({ patches: [], change: undefined, value: undefined, refused: true })
				: fn({
					patches: fact.patches,
					change: fact.change === undefined ? undefined : viewOf(base, fact.change),
					value: fact.entry?.value,
				}),
		{ part: n.part },
	)
	s.registerTeardown(owner(inner), stop)
	return stop
}

function place(inner: Inner, p: string | Path, x: Target) {
	const { queuePulse, places, inside, resolve } = here(inner)
	inside(() => {
		const path = resolve(p)
		const id = idThrough(inner, x)
		const parent = get(places, path.slice(0, -1))
		if (parent === undefined || path.length === 0) {
			throw new PlacesError("nothing-there", path.join("/"))
		}
		askPlacing(inner, slotAt(inner, path, parent), x, id)
		placeUnder(inner, parent, path[path.length - 1], id)
	})
	queuePulse()
}

// x's children, each as a handle (reached by this process's path, so its own to hold)
function readChildren(inner: Inner, x: Target): Record<string, Node> {
	const t = inner
	const { places } = here(t)
	const n = nodeOf(t, x)
	const id = idOf(t, n)
	const names = list(inner, x)
	const kids = id === undefined
		? {}
		: places.readValue("children", id) as Record<string, Id> | undefined ?? {}
	const out: Record<string, Node> = {}
	for (const name of names) {
		const at = n.path === undefined ? kids[name] : get(places, [...n.path, name]) ?? kids[name]
		if (at !== undefined) out[name] = byId(t, at, "value")
	}
	return out
}

// every version of x's part; children's ids turned handles (no ids given out)
function allOf(
	inner: Inner,
	x: Target,
	part: "value" | "attributes" | "children",
	path: readonly Step[] = [],
): Version[] {
	const t = inner
	const all = versions(inner, handle(t, { ...nodeOf(t, x), part }), path)
	if (part !== "children") return all
	return all.map((v) => ({ ...v, value: handlesFor(t, v.value) }))
}
const handlesFor = (inner: Inner, v: unknown) =>
	v === null || typeof v !== "object" ? v : Object.fromEntries(
		Object.entries(v as Record<string, unknown>).map(([k, id]) => [
			k,
			typeof id === "string" ? byId(inner, id, "value") : id,
		]),
	)
const explainPart = (inner: Inner, x: Target, part: "value" | "attributes" | "children") => {
	const t = inner
	return explain(inner, handle(t, { ...nodeOf(t, x), part }))
}

// a folder's names patched: one name a patch, { path: [name], value: node } placing node there,
// { path: [name] } unplacing it; anything else not-patches (a process never writes a children
// entry whole: its ids). each name asked "place", as place asks
function patchChildren(inner: Inner, x: Target, patches: readonly Patch[]) {
	const { table, queuePulse, inside } = here(inner)
	const t = inner
	const { ask } = here(t)
	inside(() => {
		const n = nodeOf(t, x)
		const folder = needId(t, n)
		for (const p of patches) {
			const name = p.path[0]
			if (p.path.length !== 1 || typeof name !== "string" || p.move !== undefined) {
				throw new ErmineError(
					"not-patches",
					"patchChildren: one name a patch, { path: [name], value: node } or { path: [name] }",
				)
			}
			const slot = slotOf(thing(folder, n.path), name)
			const children = table.get("children", folder) as Entry<unknown> | undefined
			if ("value" in p && p.value !== undefined) {
				// a path in a patch: the caller's, resolved in its own box [the dormouse's finding 1]
				const id = idThrough(inner, p.value as Target)
				askPlacing(t, slot, p.value as Target, id)
				t.put({ part: "children", id: folder, patches: placing(children, name, id) })
			} else if (children !== undefined) {
				ask("place", slot)
				t.put({ part: "children", id: folder, patches: unplacing(children, name) })
			}
		}
	})
	queuePulse()
}

// f with nothing it reads tracked (a read of a pending memo: undefined, as peep's)
// a path from the root as inner sees it: in its box, the rest; else none (null)
function asSeen(inner: Inner, abs: Path): Path | null {
	const at = boxAt(here(inner).base, inner.context.box.root)
	return at !== undefined && at.length <= abs.length && at.every((n, i) => abs[i] === n)
		? abs.slice(at.length)
		: null
}

// path waited on by the reader now: a computer's (in its run now), else the context's node
function waitFor(inner: Inner, path: Path) {
	const { base, s, runs } = here(inner)
	const run = s.getRun()
	const computer = run?.computer.info[NODE] as Id | undefined
	const key = computer ?? inner.node
	const n = computer === undefined ? undefined : (runs.read(computer)?.n ?? 0) + 1
	const was = base.missing.get(key)
	const paths = was !== undefined && was.n === n ? was.paths : []
	// kept from the root, shown to each asker as it sees it
	const abs = [...boxAt(base, inner.context.box.root) ?? [], ...path]
	if (!paths.some((p) => p.length === abs.length && p.every((x, i) => x === abs[i]))) {
		paths.push(abs)
	}
	base.missing.set(key, n === undefined ? { paths } : { n, paths })
}

function peep<T>(inner: Inner, f: () => T): T {
	const { places, state } = here(inner)
	state.peeping++
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
		state.peeping--
	}
}

function unplace(inner: Inner, p: string | Path) {
	const { queuePulse, places, inside, resolve, ask } = here(inner)
	inside(() => {
		const path = resolve(p)
		const [children, name] = slot(inner, path)
		const parent = get(places, path.slice(0, -1))!
		ask("place", slotAt(inner, path, parent))
		inner.put({ part: "children", id: parent, patches: unplacing(children, name) })
	})
	queuePulse()
}

function rename(inner: Inner, from: string | Path, to: string | Path) {
	const { table, queuePulse, places, guard, inside, resolve, ask } = here(inner)
	inside(() => {
		const fromPath = resolve(from)
		const source = slot(inner, fromPath)
		const sourceParent = get(places, fromPath.slice(0, -1))!
		guard.move(fromPath, resolve(to))
		ask("place", slotAt(inner, fromPath, sourceParent))
		const path = resolve(to)
		const parent = get(places, path.slice(0, -1))
		if (parent === undefined || path.length === 0) {
			throw new PlacesError("nothing-there", path.join("/"))
		}
		ask("place", slotAt(inner, path, parent))
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

function remove(inner: Inner, x: Target) {
	const { base, runs, table, queuePulse, inside } = here(inner)
	const t = inner
	const { places, ask } = here(t)
	inside(() => {
		const n = nodeOf(t, x)
		const id = needId(t, n)
		ask("remove", targetOf(thing(id, n.path)))
		if (n.path !== undefined && n.path.length) {
			const [children, name] = slot(t, n.path)
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

const keyOf = (path: Path) => JSON.stringify(path)

// the one made at path under own: claimed, given new code (a parent's rerun does not destroy
// its children; two of a name in one run are refused). as own's run starts, what its earlier
// runs made is old (the scheduler's): one old is claimed; one not old was made in this run (or
// own has had no run since): already-there. none: a new one is to be made
function again(inner: Inner, own: Scope, path: Path, code: Code): Made | undefined {
	const { s, queuePulse, state } = here(inner)
	for (const m of state.named.get(keyOf(path)) ?? []) {
		if (m.own !== own || m.c === undefined || m.c.state !== "alive") continue
		if (!s.claim(m.c)) throw new PlacesError("already-there", path.join("/"))
		m.code = code
		gone(inner, m, path)
		queuePulse()
		return m
	}
}

// m's node and name go once its computer has: asked again in each run of its owner that makes
// it (a cleanup of that run: run once the next run is done, it finds the computer claimed,
// alive, and leaves it), and as the owner goes (what is under it first)
function gone(inner: Inner, m: Made, path: Path) {
	const { base, runs, memos, s, table, places, state } = here(inner)
	s.registerTeardown(m.own, () => {
		if (m.c?.state === "alive") return
		const there = state.named.get(keyOf(path))
		if (there?.delete(m) && there.size === 0) state.named.delete(keyOf(path))
		memos.delete(m.id)
		base.computers.delete(m.id)
		base.contexts.delete(m.id)
		base.awaiting.delete(m.id)
		try {
			const [children, last] = slot(inner, path)
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
function computerNode(
	inner: Inner,
	own: Scope,
	path: Path,
	code: Code,
	kind: "memo" | "effect" | "early",
) {
	const { base, calls, newId, places, inside, state } = here(inner)
	const id = newId()
	const above = nodeAbove(own)
	inside(() => {
		const parent = get(places, path.slice(0, -1))
		if (parent === undefined) throw new PlacesError("nothing-there", path.join("/"))
		placeUnder(inner, parent, path[path.length - 1], id, path)
		if (above !== undefined) {
			inner.put({ part: "attributes", id, patches: [{ path: [SCOPE], value: above }] })
		}
	})
	const m: Made = { own, id, code }
	const at = keyOf(path)
	state.named.set(at, (state.named.get(at) ?? new Set()).add(m))
	gone(inner, m, path)
	base.computers.add(id)
	base.contexts.set(id, inner)
	calls.going(own)?.made.push({ kind, id, path })
	return m
}

const same = (inner: Inner, m: Made) => (a: unknown, b: unknown) =>
	m.code.equal ? m.code.equal(a, b) : Object.is(a, b)

// m's code run: a promise given marks its node awaiting till it settles
const ran = (inner: Inner, m: Made, previous: unknown) => {
	const { base } = here(inner)
	const r = m.code.f(previous)
	if (isThen(r)) {
		base.awaiting.add(m.id)
		const done = () => void base.awaiting.delete(m.id)
		r.then(done, done)
	} else base.awaiting.delete(m.id)
	return r
}

function createMemo<T>(
	inner: Inner,
	name: string | Path,
	f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
	options: { equal?: Equal<T> } = {},
): Node {
	const { base, parts, runs, memos, s, table, queuePulse, resolve } = here(inner)
	const own = owner(inner)
	const path = resolve(name)
	const n: NodeData = { path, part: "value" }
	const code: Code = { f, equal: options.equal }
	if (again(inner, own, path, code)) return handle(inner, n)
	const m = computerNode(inner, own, path, code, "memo")
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
				(previous) => ran(inner, m, previous) as T,
				set,
				same(inner, m),
				undefined,
				{ [NODE]: id },
			),
	)
	m.c = c
	base.statuses.give(c, id)
	runs.give(c, id)
	parts.onCreateFunction?.({ kind: "memo", computer: c, node: n, id, process: inner.node })
	queuePulse()
	return handle(inner, n)
}

// an effect at its own node at name: f tracked, act(value, before) after the round; early: run and
// acted at once, and later acts before other effects'
function createEffect<T>(
	inner: Inner,
	name: string | Path,
	f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
	act: (value: T, before: T | undefined) => void,
	options: { equal?: Equal<T>; early?: boolean } = {},
): Node {
	const { early, ...o } = options
	return effectOf(inner, early === true, name, f, act, o)
}

// an effect, early or not. an early one runs, and acts, inside createEffect: before its
// computer is given back, so its first run gives the status and the run record its node, from
// inside it (runs.ts: a run given while it ran)
function effectOf<T>(
	inner: Inner,
	isEarly: boolean,
	name: string | Path,
	f: (previous: T | undefined) => T | PromiseLike<T> | typeof PENDING,
	act: (value: T, before: T | undefined) => void,
	options: { equal?: Equal<T> },
): Node {
	const { base, parts, runs, s, table, queuePulse, resolve } = here(inner)
	const own = owner(inner)
	const path = resolve(name)
	const n: NodeData = { path, part: "value" }
	const code: Code = { f, act, equal: options.equal }
	if (again(inner, own, path, code)) return handle(inner, n)
	const m = computerNode(inner, own, path, code, isEarly ? "early" : "effect")
	const id = m.id
	let given = false
	const run = (previous: T | undefined) => {
		if (!given) {
			given = true
			const c = s.getRun()!.computer
			base.statuses.give(c, id)
			runs.give(c, id)
		}
		return ran(inner, m, previous) as T
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
				? base.sited.createEffect<T>(run, then, same(inner, m), { early: true }, { [NODE]: id })
				: base.sited.createEffect<T>(
					(previous) => ran(inner, m, previous) as T,
					then,
					same(inner, m),
					undefined,
					{ [NODE]: id },
				),
	)
	m.c = c
	base.statuses.give(c, id)
	runs.give(c, id)
	parts.onCreateFunction?.({ kind: "effect", computer: c, node: n, id, process: inner.node })
	queuePulse()
	return handle(inner, n)
}

// deno-lint-ignore no-explicit-any
function createAction(inner: Inner, p: string | Path, fn: (...args: any[]) => unknown): Node {
	const { parts, methods, s, queuePulse, places, inside, resolve, ask } = here(inner)
	const own = owner(inner)
	const path = resolve(p)
	const made = inside(() => {
		const id = get(places, path)
		if (id === undefined) return build(inner, path, fn)
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
	return handle(inner, n)
}

function executeAction(inner: Inner, p: Target, ...args: unknown[]): unknown {
	const { base, calls, methods, s, table, queuePulse, context, scope } = here(inner)
	const t = inner
	const { places, ask } = here(t)
	const n = nodeOf(t, p)
	const id = idOf(t, n)
	const at = n.path !== undefined ? { path: n.path } : { id: n.id }
	// in a run, the computer waits; else whoever this context is
	const run = s.getRun()
	const caller = (run?.computer.info[NODE] as Id | undefined) ?? inner.node
	// tracked in a run, so the handler coming reruns it
	const fn = id === undefined ? undefined : places.readValue("value", id)
	if (fn === undefined) {
		// kept while the caller is: a computer's with it, else the context's. the path: in t's box
		calls.wait(caller, at, t.context.box.root, run?.computer ?? scope)
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
		{ caller: { node: inner.node, actor: actorHere(inner) }, handler: id, call: k },
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
const inCall = (inner: Inner, own: Scope) => {
	const { calls, scope } = here(inner)
	for (let o: Scope | undefined = own; o !== undefined && o !== scope; o = o.parent) {
		if (calls.going(o) !== undefined) return true
	}
	return false
}
function addTeardown(inner: Inner, fn: (why: Why) => unknown) {
	const { base, s, scope } = here(inner)
	const own = owner(inner)
	s.registerTeardown(own, () => {
		const why = base.whys.get(inner.node) ??
			(scope.state !== "alive" || (own.state !== "alive" && inCall(inner, own))
				? "ended"
				: "replaced")
		base.torn(own, why, fn)
	})
}

function ref<T>(inner: Inner, p: string | Path, made: () => T): Node {
	const { queuePulse, places, inside, resolve } = here(inner)
	const path = resolve(p)
	inside(() => {
		if (get(places, path) === undefined) build(inner, path, made())
	})
	queuePulse()
	return handle(inner, { path, part: "value" })
}

function createBox(inner: Inner, where: string | Path): BoxNode {
	const { base, queuePulse, context, inside, resolve } = here(inner)
	// its writes, this context's (through onWrite)
	const host = { ...base.host, write: inner.writer }
	const at = resolve(where)
	const b = inside(() => makeBox(host, at, context.box, header(inner)))
	base.boxList.push(b)
	queuePulse()
	const handle: BoxNode = {
		at,
		place: base.entered((p: string | Path, y: Target) => {
			const id = idThrough(inner, y)
			inside(() => {
				// the slot: the box's folder's children, at the path in it
				const at = typeof p === "string" ? parse(p) : p
				askPlacing(inner, { id: b.root, part: "children", field: [...at] }, y, id)
				boxInto(b, p, id, header(inner))
			})
			queuePulse()
		}),
		unplace: base.entered((p: string | Path) => {
			inside(() => void unbox(b, p, header(inner)))
			queuePulse()
		}),
	}
	base.boxes.set(handle, b)
	return handle
}

// the base's, then what features show (onStatus)
function getStatus(inner: Inner, x: Target): Status | undefined {
	const { base } = here(inner)
	const t = inner
	const n = nodeOf(t, x)
	const id = idOf(t, n)
	if (id === undefined) return undefined
	return base.statused({ node: n, id }, ownStatus(inner, t, n, id))
}

// a send's wait as this process sees it: where the send went (its path in the sender's box, or
// the node it named), none outside this box
const waitOf = (inner: Inner, w: { path?: Path; id?: Id; box: Id; since: number }): Waiting => {
	const { base } = here(inner)
	return {
		send: (w.path !== undefined ? pathIn(base, inner, w.box, w.path) : seen(inner, w.id!)) ??
			null,
		since: w.since,
	}
}
// a wait a process's status says (written as start goes pending): a send's as waitOf, the rest as
// it is
const saidOf = (inner: Inner, w: unknown): Waiting => {
	if (w !== null && typeof w === "object" && "missing" in w) {
		return { node: asSeen(inner, (w as { missing: Path }).missing) }
	}
	if (w !== null && typeof w === "object" && "send" in w) {
		const { send, box, since } = w as { send: Path | Id; box: Id; since: number }
		return waitOf(
			inner,
			Array.isArray(send) ? { path: send, box, since } : { id: send as Id, box, since },
		)
	}
	return w as Waiting
}

// asked and read as t (the node's side), told as inner sees it
function ownStatus(inner: Inner, t: Inner, n: NodeData, id: Id): Status {
	const { base, calls, runs } = here(inner)
	const { places, guard, guarded } = here(t)
	if (guarded) guard.read(targetOf(thing(id, n.path), STATUS_TABLE, [STATUS]))
	const st = places.readValue(STATUS_TABLE, id, [STATUS])
	const h = base.held.status(id) ?? base.held.row(id)
	const held = h === undefined ? {} : { held: h }
	if (!base.computers.has(id)) {
		if (st === undefined) return { state: "done", ...held }
		if (st !== PENDING) return { state: "failed", error: st, ...held }
		const said = places.readValue(STATUS_TABLE, id, [WAITING])
		const live = calls.waits(id).map((w) => waitOf(inner, w))
		const waiting = Array.isArray(said) && said.length ? said.map((w) => saidOf(inner, w)) : live
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
			waiting.push({ node: seen(inner, w.id) ?? null })
		}
	}
	for (const w of calls.waits(id)) waiting.push(waitOf(inner, w))
	const m = base.missing.get(id)
	if (m !== undefined && r !== undefined && m.n === r.n) {
		for (const p of m.paths) waiting.push({ node: asSeen(inner, p) })
	}
	if (base.awaiting.has(id)) waiting.push("a promise")
	if (waiting.length === 0) waiting.push("PENDING")
	return { state: "pending", waiting, ...nOf }
}

function explain(
	inner: Inner,
	x: Target | ChangeView,
	path: readonly Step[] = [],
): Explained | undefined {
	const { base, table } = here(inner)
	const t = inner
	const { places, guard, guarded } = here(t)
	// a change's view (a reads item's from.change, a watch's): its change. a view is known only
	// by base.changes, so none can be forged into a record's lookup
	const viewed = typeof x === "object" && !isHandle(x) && !Array.isArray(x)
		? base.changes.get(x as ChangeView)
		: undefined
	if (viewed !== undefined) return writerOf(inner, viewed)
	if (typeof x === "object" && !isHandle(x) && !Array.isArray(x)) {
		throw new PlacesError("nothing-there", "not a change this ermine shows")
	}
	const n = nodeOf(t, x as Target)
	const id = idOf(t, n)
	if (id === undefined) return undefined
	if (guarded) guard.read(targetOf(thing(id, n.path), n.part, path))
	places.readChange(n.part, id)
	const change = (table.get(n.part, id) as Entry<unknown> | undefined)?.change
	const h = base.held.at(n.part, id)
	if (change === undefined) return h === undefined ? undefined : { held: h }
	const by = writerOf(inner, change)
	return h === undefined ? by : { ...by, held: h }
}

// a record's read or write, as this process sees it
const touched = (inner: Inner, t: { part: Key; id: Id }): Touched => {
	const p = seen(inner, t.id)
	return p === undefined ? { part: t.part } : { part: t.part, path: p }
}
const pathOf = (inner: Inner, id: Id) => {
	const p = seen(inner, id)
	return p === undefined ? {} : { path: p }
}
const runView = (inner: Inner, r: Run): RunView => ({
	n: r.n,
	...r.started !== undefined && { started: r.started },
	ended: r.ended,
	end: r.end,
	..."error" in r && { error: r.error },
	...r.act !== undefined && { act: r.act },
	reads: r.reads.flatMap((x) => "part" in x ? [touched(inner, x)] : []),
	writes: r.writes.map((t) => touched(inner, t)),
})
// a value a record holds (a call's args, what it returned) as inner is shown it: a handle in it, the
// path it reaches as inner sees it (none: null), never the handle [the dormouse's finding 2]. lists
// and plain maps looked through; anything else as it is
function shown(inner: Inner, v: unknown, seenAlready = new Map<object, unknown>()): unknown {
	if (isHandle(v)) {
		const d = dataOf(here(inner).base.handles, v).node
		const id = d.id ??
			get(walkFrom(here(inner).base, d.path).places, walkFrom(here(inner).base, d.path).path)
		return (id === undefined ? undefined : seen(inner, id)) ?? null
	}
	if (v === null || typeof v !== "object") return v
	const proto = Object.getPrototypeOf(v)
	if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v
	const again = seenAlready.get(v)
	if (again !== undefined) return again
	if (Array.isArray(v)) {
		const out: unknown[] = []
		seenAlready.set(v, out)
		for (const x of v) out.push(shown(inner, x, seenAlready))
		return out
	}
	const out: Record<string, unknown> = {}
	seenAlready.set(v, out)
	for (const [k, x] of Object.entries(v)) out[k] = shown(inner, x, seenAlready)
	return out
}

const callView = (inner: Inner, c: Call): CallView => ({
	n: c.n,
	args: shown(inner, c.args) as unknown[],
	end: c.end,
	..."returned" in c && { returned: shown(inner, c.returned) },
	..."error" in c && { error: c.error },
	started: c.started,
	...c.ended !== undefined && { ended: c.ended },
	reads: c.reads.flatMap((x) => "part" in x ? [touched(inner, x)] : []),
	writes: c.writes.map((t) => touched(inner, t)),
	...c.made !== undefined &&
		{ made: c.made.map((m) => ({ kind: m.kind, ...pathOf(inner, m.id) })) },
})

// the call open now: its scope's info names its caller (send's call scope)
function getCaller(inner: Inner): Caller | undefined {
	for (let o: Scope | undefined = owner(inner); o !== undefined; o = o.parent) {
		if (o.info.call === undefined || o.info.handler === undefined) continue
		const c = o.info.caller as { node?: Id; actor?: unknown } | undefined
		const p = c?.node === undefined ? undefined : seen(inner, c.node)
		return p === undefined ? { actor: c?.actor } : { actor: c?.actor, process: p }
	}
	return undefined
}

// the change's writer, one step: its view, the writer by path as this process sees it
function writerOf(inner: Inner, change: ChangeHeader): Explained & { change: ChangeView } {
	const { base, calls, runs } = here(inner)
	const m = change.metadata ?? {}
	const holds = (writes: readonly { change: ChangeHeader | undefined }[]) =>
		writes.some((w) => w.change === change)
	const view = viewOf(base, change)
	if (m.run !== undefined && m[NODE] !== undefined) {
		const computer = m[NODE] as Id
		const run = runs.read(computer)
		return run !== undefined && run.n === m.run && holds(run.writes)
			? {
				change: view,
				writer: { kind: "computer", ...pathOf(inner, computer), run: runView(inner, run) },
			}
			: { change: view, writer: { kind: "computer", ...pathOf(inner, computer) } }
	}
	if (m.call !== undefined && m.handler !== undefined) {
		const handler = m.handler as Id
		const call = calls.latest(handler)
		if (call !== undefined && call.n === m.call && holds(call.writes)) {
			return {
				change: view,
				writer: { kind: "method", ...pathOf(inner, handler), call: callView(inner, call) },
			}
		}
		return { change: view, writer: { kind: "method", ...pathOf(inner, handler) } }
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

type Computed<T> = (previous: T | undefined) => T | PromiseLike<T> | symbol

// the parts alike: attributes and children by the same functions as the value
const hasNode = (inner: Inner, x: Target) => readEntries(inner, x).some((i) => i.refused !== true)
const readAttributes = (inner: Inner, x: Target, key?: readonly Step[]) =>
	read(inner, attributesOf(inner, x), key)
const patchAttributes = (inner: Inner, x: Target, patches: readonly Patch[]) =>
	patch(inner, attributesOf(inner, x), patches)

// patches, never a recipe; anything else: not-patches
function patchesOnly(patches: unknown): readonly Patch[] {
	if (!Array.isArray(patches)) {
		throw new ErmineError("not-patches", "patch takes patches: [{ path, value }]")
	}
	return patches
}

export type System = {
	getNode: (path: string | Path) => Node
	hasNode: (x: Target) => boolean
	ensureNode: (path: string | Path, value?: unknown) => Node
	createNode: (folder: string | Path, value?: unknown) => Node
	ref: <T>(path: string | Path, make: () => T) => Node
	read: (x: Target, key?: readonly Step[]) => unknown
	readAttributes: (x: Target, key?: readonly Step[]) => unknown
	readChildren: (x: Target) => Record<string, Node>
	readAll: (x: Target, key?: readonly Step[]) => Version[]
	readAllAttributes: (x: Target, key?: readonly Step[]) => Version[]
	readAllChildren: (x: Target) => Version[]
	readEntries: (x: Target) => Item[]
	peep: <T>(f: () => T) => T
	patch: (x: Target, patches: readonly Patch[]) => void
	patchAttributes: (x: Target, patches: readonly Patch[]) => void
	patchChildren: (x: Target, patches: readonly Patch[]) => void
	explain: (x: Target | ChangeView, key?: readonly Step[]) => Explained | undefined
	explainAttributes: (x: Target) => Explained | undefined
	explainChildren: (x: Target) => Explained | undefined
	place: (path: string | Path, x: Target) => void
	unplace: (path: string | Path) => void
	rename: (from: string | Path, to: string | Path) => void
	list: (x: Target) => string[]
	createMemo: <T>(name: string | Path, f: Computed<T>, options?: { equal?: Equal<T> }) => Node
	createEffect: <T>(
		name: string | Path,
		f: Computed<T>,
		act: (value: T, before: T | undefined) => void,
		options?: { equal?: Equal<T>; early?: boolean },
	) => Node
	watch: (x: Target, fn: (w: Watched) => void) => () => void
	// deno-lint-ignore no-explicit-any
	createAction: (path: string | Path, fn: (...args: any[]) => unknown) => Node
	executeAction: (path: Target, ...args: unknown[]) => unknown
	getCaller: () => Caller | undefined
	getStatus: (x: Target) => Status | undefined
	addTeardown: (fn: (why: Why) => unknown) => void
	createBox: (path: string | Path) => BoxNode
	getArgs: () => readonly string[]
}

// the host's beside them: remove (a process unplaces), and a pulse now
export type HostOnly = { remove: (x: Target) => void; pulse: () => void }

// @ermine/system's functions over at(name, x): the context each acts as (a process's, found from
// the scope open, registry.ts; the host's, for the host's ermine object), and its scope opened
// round the call when at says so. name: the function asked, for nothing-open's message; x: what it
// is asked of. a writer's call is entered: its
// writes' site the line calling it
export function systemFrom(at: (name: string, x?: unknown) => Found): System
export function systemFrom(
	at: (name: string, x?: unknown) => Found,
	options: { host: true },
): System & HostOnly
export function systemFrom(
	at: (name: string, x?: unknown) => Found,
	options?: { host: true },
): System | (System & HostOnly) {
	// name's implementation run as the context at(name, x) gives (a writer: entered, so its writes'
	// site is the line calling in; few frames between: a site is found in the stack's first ten)
	function go<A extends unknown[], T>(
		name: string,
		x: unknown,
		writer: boolean,
		f: (inner: Inner, ...a: A) => T,
		...a: A
	): T {
		const found = at(name, x)
		const inner = found.inner
		if (found.within !== undefined) {
			return found.within(() => writer ? here(inner).base.enter(f, inner, a) : f(inner, ...a))
		}
		return writer ? here(inner).base.enter(f, inner, a) : f(inner, ...a)
	}
	const getArgs = (inner: Inner) => inner.context.args
	const readAll = (inner: Inner, x: Target, key?: readonly Step[]) => allOf(inner, x, "value", key)
	const readAllAttributes = (inner: Inner, x: Target, key?: readonly Step[]) =>
		allOf(inner, x, "attributes", key)
	const readAllChildren = (inner: Inner, x: Target) => allOf(inner, x, "children")
	const explainAttributes = (inner: Inner, x: Target) => explainPart(inner, x, "attributes")
	const explainChildren = (inner: Inner, x: Target) => explainPart(inner, x, "children")
	const patchChildrenOnly = (inner: Inner, x: Target, patches: readonly Patch[]) =>
		patchChildren(inner, x, patchesOnly(patches))
	const system: System = {
		getNode: (path) => go("getNode", undefined, false, getNode, path),
		hasNode: (x) => go("hasNode", x, false, hasNode, x),
		ensureNode: (path, value) => go("ensureNode", undefined, true, ensureNode, path, value),
		createNode: (folder, value) => go("createNode", undefined, true, createNode, folder, value),
		ref: (path, make) => go("ref", undefined, true, ref, path, make),
		read: (x, key) => go("read", x, false, read, x, key),
		readAttributes: (x, key) => go("readAttributes", x, false, readAttributes, x, key),
		readChildren: (x) => go("readChildren", x, false, readChildren, x),
		readAll: (x, key) => go("readAll", x, false, readAll, x, key),
		readAllAttributes: (x, key) => go("readAllAttributes", x, false, readAllAttributes, x, key),
		readAllChildren: (x) => go("readAllChildren", x, false, readAllChildren, x),
		readEntries: (x) => go("readEntries", x, false, readEntries, x),
		peep: (f) => go("peep", undefined, false, peep, f),
		patch: (x, patches) => go("patch", x, true, patch, x, patches),
		patchAttributes: (x, patches) => go("patchAttributes", x, true, patchAttributes, x, patches),
		patchChildren: (x, patches) => go("patchChildren", x, true, patchChildrenOnly, x, patches),
		explain: (x, key) => go("explain", x, false, explain, x, key),
		explainAttributes: (x) => go("explainAttributes", x, false, explainAttributes, x),
		explainChildren: (x) => go("explainChildren", x, false, explainChildren, x),
		place: (path, x) => go("place", undefined, true, place, path, x),
		unplace: (path) => go("unplace", undefined, true, unplace, path),
		rename: (from, to) => go("rename", undefined, true, rename, from, to),
		list: (x) => go("list", x, false, list, x),
		createMemo: (name, f, options) =>
			go("createMemo", undefined, true, createMemo, name, f as never, options as never),
		createEffect: (name, f, act, options) =>
			go(
				"createEffect",
				undefined,
				true,
				createEffect,
				name,
				f as never,
				act as never,
				options as never,
			),
		watch: (x, fn) => go("watch", x, false, watch, x, fn),
		createAction: (path, fn) => go("createAction", undefined, true, createAction, path, fn),
		executeAction: (path, ...args) =>
			go("executeAction", path, true, executeAction, path, ...args),
		getCaller: () => go("getCaller", undefined, false, getCaller),
		getStatus: (x) => go("getStatus", x, false, getStatus, x),
		addTeardown: (fn) => go("addTeardown", undefined, false, addTeardown, fn),
		createBox: (path) => go("createBox", undefined, true, createBox, path),
		getArgs: () => go("getArgs", undefined, false, getArgs),
	}
	if (options?.host !== true) return system
	return {
		...system,
		remove: (x) => go("remove", x, true, remove, x),
		pulse: () => go("pulse", undefined, false, (i) => here(i).s.pulse()),
	}
}

// how a process's functions find it (registry.ts), for @ermine/system's module
export { foundFor } from "./registry.ts"
export type { Table }
