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
//            folders, its cycle check), list, remove
// computing  createMemo, createEffect ({ early }), pipe, pulse (the pending pulse now; in one:
//            nothing)
// actions    createAction, executeAction, getCaller
// the rest   getStatus, addTeardown, createBox, getArgs, PENDING, REFUSED
//
// paths: a bare name inside the process's node (the host's: the root), gone at stop; ./ its folder;
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
//   read(x, key?)        the value at key, tracked; a node there with none: undefined; a node not
//                        there, or a pending memo with no value: throws PENDING
//   readAll(x, key?)     every value at key, tracked: [{ value, from }]. position 0 read's, from:
//                        { change } (a ChangeView: time, actor, site); then what features show
//                        (onRead), each from naming its feature
//   readEntries(x)       every node x's path reaches: [{ value, from, node?, refused? }], node a
//                        handle; refused: no value, no node
//   pipe(from, fn)       fn at each write at from: { patches, change (a view), value } (refused:
//                        refused, none of them); pipe(from, to, fnA?, fnB?): mirror, transform,
//                        translate (pipe below); { timing: "pulse" | "write", name }; its node
//   place(p, x)          x's node at a second name. unplace(p): the name out, the node stays.
//                        remove(x): unplaced and its entries deleted, asked "remove" [chee 10-27:
//                        "why wouldn't we just export remove and pulse too? protect remove"]; a
//                        node no name reaches no longer exists [chee 10-25]
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
// pipe is asked as it is made (read of from, edit of to), and at each write told; patch "edit"; ensureNode, createNode,
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
import { parse } from "@ermine/core/places/path"
import { equal } from "@ermine/core/places/upsert"
import applyPatches from "@ermine/core/op/apply"
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
import { PROCESS } from "@ermine/processes"
import type { Run, Runs } from "@ermine/processes/runs"
import { type Computer, type Equal, PENDING, type Scope } from "@ermine/core/scheduler"
import type { Sited } from "@ermine/sites"
import type { Key, Table } from "@ermine/core/table"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import type { Call, Calls } from "./calls.ts"
import { type Found, hinting } from "./registry.ts"
import { take } from "./site.ts"
import { attach as attachHint } from "./hints.ts"
import type { Target as Aimed } from "@ermine/core/protect"
import { type Asked, ErmineError, type Reading } from "./features.ts"
import { dataOf, type Handles, isHandle, mint } from "./handles.ts"
import {
	type Inner,
	isThen,
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
	// what to do, where ermine has advice (hints.ts; createErmine's hints: false, none)
	readonly hint?: string
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
	| { readonly kind: "pipe"; readonly path?: Path }
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
	// reader, the paths as it read them (and each once, by key). kept while what shows it does: a
	// computer's (its node) for its latest run, gone with it; a process's setup's (its node) while
	// the setup runs, then said in its status. a read anywhere else is shown nowhere: none kept
	readonly missing: Map<
		Id,
		{ readonly n?: number; readonly paths: Path[]; readonly keys: Set<string> }
	>
	// the processes whose setup is running now, by node
	readonly setting: Set<Id>
	// each method placed, by its node: the function, and the scope open when it was placed (one
	// function placed by two owners: each placement its own). gone with that scope
	readonly methods: Map<Id, { readonly fn: unknown; readonly scope: Scope }>
	// why a process is stopping (by its node), said by stop before its scope goes
	readonly whys: Map<Id, Why>
	readonly newId: () => string
	// an ermine error a function threw given its advice (hints.ts), as it passes; hints: false, none
	readonly hints: boolean
	// every node handle the functions gave (handles.ts)
	readonly handles: Handles
	// each process's node: its box's folder, and where it runs in that box (its rows name it, not a
	// children entry, so places' namesOf has it not): seen's
	readonly running: Map<Id, { readonly box: Id; readonly at: Path }>
	// each change's view, and each view's change (ChangeView)
	readonly views: WeakMap<ChangeHeader, ChangeView>
	readonly changes: WeakMap<ChangeView, ChangeHeader>
	// every pipe's node (getStatus: looping)
	readonly pipes: Set<Id>
	// what pipes heard, to be told at the next pulse, in order (base.pulse tells them first)
	readonly piped: (() => void)[]
	// how deep pipes told as writes land are now (a pipe's write telling a pipe)
	pipeDepth: number
	// a pulse: what pipes heard told first, then the scheduler's
	readonly pulse: () => void
	// what boxes are made over
	readonly host: Host
	// each box handle's box (the host's side)
	readonly boxes: WeakMap<BoxNode, Box>
	// every box, by its folder's id, the root's first: where a path from the root is walked
	// (walkFrom). createBox at a folder a box is at gives that box; a box whose folder nothing
	// reaches and that holds no rows (the one thing its view shows beyond the host's) is let go as
	// the boxes are walked, and comes back as a process starts in it or it is made again
	readonly boxIndex: Map<Id, Box>
	// counted up as names can change (a children fact, a process's node placed or gone): what the
	// boxes' paths are kept against (walks)
	names: number
	// the boxes' folders' paths, and a trie of them, as of names (walks)
	walked: Walked | undefined
	// f as a public function: a write's site outside a run is its caller
	readonly entered: <F extends (...args: never[]) => unknown>(f: F) => F
	// f(inner, ...a) with the entry here: a write made in it has its site at the line that called in;
	// site, a build's (site.ts): that one, nothing captured
	readonly enter: <A extends unknown[], T>(
		f: (inner: Inner, ...a: A) => T,
		inner: Inner,
		a: A,
		site?: FileLocation,
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
// a process context's inner side (the host's and features' code: the harness); base given, only one
// of that ermine's
export function innerOf(context: ProcessContext, base?: Base): Inner | undefined {
	const inner = inners.get(context)
	return inner === undefined || (base !== undefined && bases.get(inner) !== base)
		? undefined
		: inner
}
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
		state: {
			peeping: 0,
			named: new Map<string, Set<Made>>(),
			// pipes by path, who made each (a computer, or a scope), and how many each run made
			pipes: new Map<string, Piped>(),
			pipeOwner: new WeakMap<Piped, unknown>(),
			pipeOrder: new WeakMap<object, number>(),
		},
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
const slotAt = (path: Path, parent: Id) =>
	slotOf(thing(parent, path.slice(0, -1)), path[path.length - 1])

// the boxes' folders by path from the root: a box at the end of a path's names
type Trie = { box?: Box; readonly kids: Map<string, Trie> }
// what the boxes are walked by, as of base.names: each folder's path (up its names, none: out of
// the root's reach) and the trie of them
export type Walked = {
	readonly names: number
	readonly at: Map<Id, Path | undefined>
	readonly trie: Trie
}
// the boxes walked as names are now: made again only once a name may have changed. a box nothing
// reaches and holding no rows let go (Base's boxIndex)
function walks(base: Base): Walked {
	const was = base.walked
	if (was !== undefined && was.names === base.names) return was
	const { places, table } = base.host
	const at = new Map<Id, Path | undefined>()
	const trie: Trie = { kids: new Map() }
	for (const b of base.boxIndex.values()) {
		const p = up(base, places, places.root, b.root)
		at.set(b.root, p)
		if (p === undefined) {
			if (b.root !== places.root && !rowed(table.get(PROCESS, b.root)?.value)) {
				base.boxIndex.delete(b.root)
			}
			continue
		}
		let t = trie
		for (const name of p) {
			let k = t.kids.get(name)
			if (k === undefined) t.kids.set(name, k = { kids: new Map() })
			t = k
		}
		t.box = b
	}
	return base.walked = { names: base.names, at, trie }
}
// whether a box's rows hold a process (a row under any name)
const rowed = (v: unknown): boolean =>
	typeof v === "string" ||
	(typeof v === "object" && v !== null && Object.values(v).some(rowed))

// a box's folder's path from the root now (up its names); the root's box: []
function boxAt(base: Base, box: Id): Path | undefined {
	const w = walks(base)
	if (w.at.has(box)) return w.at.get(box)
	const p = up(base, base.host.places, base.host.places.root, box)
	w.at.set(box, p)
	return p
}

// where a path from the root is walked: in the deepest box whose folder is on it (so a boxed
// process's own nodes, named by its rows, are reached), the path in that box
function walkFrom(base: Base, abs: Path): { places: Places; path: Path } {
	let t: Trie | undefined = walks(base).trie
	let found = { places: t.box?.places ?? base.host.places, path: abs }
	for (let i = 0; i < abs.length; i++) {
		t = t.kids.get(abs[i])
		if (t === undefined) break
		if (t.box !== undefined) found = { places: t.box.places, path: abs.slice(i + 1) }
	}
	return found
}

// the boxes below inner's own whose folders are on its path (in its box): each one's places and the
// path in it, outermost first. a walk reaching a box's folder reads that box's rows beneath it, as
// the box's own view does
function boxesOn(inner: Inner, path: Path): { places: Places; path: Path }[] {
	const { base } = here(inner)
	if (base.boxIndex.size < 2) return []
	const at = boxAt(base, inner.context.box.root)
	if (at === undefined) return []
	const abs = [...at, ...path]
	const out: { places: Places; path: Path }[] = []
	let t: Trie | undefined = walks(base).trie
	for (let i = 0; i < abs.length; i++) {
		t = t.kids.get(abs[i])
		if (t === undefined) break
		if (i >= at.length && t.box !== undefined && t.box.places !== inner.places) {
			out.push({ places: t.box.places, path: abs.slice(i + 1) })
		}
	}
	return out
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
		if (at !== undefined && base.boxIndex.size > 1) {
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
	if (path !== undefined) ask("place", slotAt(path, parent))
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
	ask("place", slotAt(path, parent))
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
	const { calls, memos, state, places, guard, guarded } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
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
	const n = nodeOf(inner, x)
	const shown = read(inner, x, path)
	const id = idOf(inner, n)
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
	const { calls, table, places, guard, guarded } = here(inner)
	const n = nodeOf(inner, x)
	if (n.path === undefined) {
		if (n.id === undefined) return []
		if (refused(inner, targetOf(thing(n.id), n.part))) {
			return [{ value: undefined, from: "id", refused: true }]
		}
		calls.read(n.part, n.id, [])
		// a node there by id, with or without a value (as by a path); nothing under that id: none
		const value = places.readValue(n.part, n.id)
		if (value === undefined && table.get(n.id).length === 0) return []
		return [{ value, from: "id", node: byId(inner, n.id, n.part) }]
	}
	const found = gets(places, n.path)
	for (const a of found) calls.read(n.part, a.id, [])
	const item = (a: (typeof found)[number]): Item => ({
		value: places.readValue(n.part, a.id),
		from: a.from,
		node: byId(inner, a.id, n.part),
	})
	if (!guarded) return found.map(item)
	// the box's "/": no name in a folder to ask by, so the node itself, as read asks
	if (n.path.length === 0) {
		return found.map((a) =>
			refused(inner, targetOf(thing(a.id, n.path), n.part))
				? { value: undefined, from: a.from, refused: true as const }
				: item(a)
		)
	}
	const name = n.path[n.path.length - 1]
	const asked = guard.members(found.map((a) => ({ name, id: a.id })), n.path.slice(0, -1))
	return found.map((a, i) =>
		asked[i].id === REFUSED ? { value: undefined, from: a.from, refused: true as const } : item(a)
	)
}

function list(inner: Inner, x: Target): string[] {
	const { calls, places, guard, guarded } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	if (guarded && id !== undefined) guard.read(targetOf(thing(id, n.path), "children"))
	if (id !== undefined) calls.read("children", id, [], true)
	if (n.path === undefined) return n.id === undefined ? [] : places.readKeys("children", n.id)
	const names = [...listAt(places, n.path)]
	// a box beneath on the path (a process started in it): its rows' names too, after
	const more = boxesOn(inner, n.path)
	if (more.length === 0) return names
	const had = new Set(names)
	for (const v of more) {
		for (const name of listAt(v.places, v.path)) {
			if (!had.has(name)) had.add(name), names.push(name)
		}
	}
	return names
}

// x's attributes, as a node
const attributesOf = (inner: Inner, x: Target): Node =>
	handle(inner, { ...nodeOf(inner, x), part: "attributes" })

// x's part patched: patches only, never a recipe (the base is mechanical [chee 10-25: "the core
// lib should actually not have proxies, and should be this kind of mechanical thing"])
function patch(inner: Inner, x: Target, given: readonly Patch[]) {
	const patches = patchesOnly(given)
	const { queuePulse, inside, ask } = here(inner)
	inside(() => {
		const n = nodeOf(inner, x)
		const id = needId(inner, n)
		ask("edit", targetOf(thing(id, n.path), n.part))
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

// pipe(from, fn) | pipe(from, to, fnA?, fnB?), options last [chee 10-26: "let's do `pipe(from,
// to?, fnA?, fnB?)` where if the sec arg is str ifs a to, so it can replace watch, and also can be
// mirror, and also can be transform, and also can be translate"]: a node of its own, in its own
// scope (its writes its own, asked as its process), told each write at from: the write [chee:
// "the write"]. fn: told it. to and no fnA: mirror (its patches at to). fnA: transform (fnA(write)
// gives to's patches; none: nothing). fnB: translate (fnB(write at to) gives from's). never told
// its own writes; a throw fails its own status, not the writer's. timing per pipe, the next pulse
// by default [chee: "let's make this a per-pipe option, maybe revisit later, default to next
// pulse"]: "pulse", told at the next pulse, in order; "write", as the write lands, a pipe told
// more than LOOPING deep (pipes told by pipes' writes) looping, not told again. asked read of from
// as it is made (and edit of to), and at each write told (refused: told so). the node: { name }, or
// pipe-<n>, its order among the pipes its owner's run made; made again by a later run of its owner
// (the same node, the new functions), as a memo is (decision-pipes-2026-10-26: the builder's picks)
export type PipeOptions = { timing?: "pulse" | "write"; name?: string | Path }
// deno-lint-ignore no-explicit-any
type PipeFn = (w: Watched) => any
type Piped = {
	id: Id
	scope: Scope
	run: unknown
	tell?: PipeFn
	from: Target
	to?: Target
	there?: PipeFn
	back?: PipeFn
	timing: "pulse" | "write"
	looping: boolean
	// how many writes in a row it was told were pipes' (a cycle of pipes: past LOOPING, looping)
	chain: number
	stops: (() => void)[]
	// what the listeners watch now (from's path and part, to's when fnB is there): made again with
	// another, the old are stopped and new started
	watching?: string
}
// how deep pipes told by pipes' writes go, as writes land, before the one told is looping
const LOOPING = 64

function pipe(inner: Inner, from: Target, ...rest: unknown[]): Node {
	const { base, s, state, guard, guarded, queuePulse, resolve } = here(inner)
	const last = rest[rest.length - 1]
	const options: PipeOptions = rest.length > 1 && last !== null && typeof last === "object" &&
			!Array.isArray(last) && !isHandle(last)
		? rest.pop() as PipeOptions
		: {}
	const [second, fnA, fnB] = rest
	if (
		second === undefined || (typeof second !== "function" && fnA !== undefined &&
			typeof fnA !== "function") ||
		(fnB !== undefined && typeof fnB !== "function")
	) {
		throw new ErmineError("not-a-function", "pipe takes (from, fn) or (from, to, fnA?, fnB?)")
	}
	const n = nodeOf(inner, from)
	if (n.path === undefined) throw new PlacesError("nothing-there", "a node with no place")
	const fromPath = n.path
	const to = typeof second === "function" ? undefined : second as Target
	if (to !== undefined && (typeof to === "function" || to === null)) {
		throw new ErmineError("not-a-function", "pipe takes (from, fn) or (from, to, fnA?, fnB?)")
	}
	const toData = to === undefined ? undefined : nodeOf(inner, to)
	if (guarded) {
		const id = idOf(inner, n)
		guard.read(
			id === undefined
				? { path: [...fromPath], part: n.part }
				: targetOf(thing(id, fromPath), n.part),
		)
		if (toData !== undefined) {
			const tid = idOf(inner, toData)
			guard.write(
				"edit",
				tid === undefined
					? { path: [...toData.path!], part: toData.part }
					: targetOf(thing(tid, toData.path), toData.part),
			)
		}
	}
	const own = owner(inner)
	const run = s.getRun()
	const order = run ?? own
	const k = state.pipeOrder.get(order as object) ?? 0
	state.pipeOrder.set(order as object, k + 1)
	const path = resolve(options.name ?? `pipe-${k}`)
	const key = keyOf(path)
	const was = state.pipes.get(key)
	const ownerOf = (o: Scope) => run?.computer ?? o
	let p: Piped
	if (
		was !== undefined && was.scope.state === "alive" && state.pipeOwner.get(was) === ownerOf(own)
	) {
		if (was.run === run && run !== undefined) {
			throw new PlacesError("already-there", path.join("/"))
		}
		p = was
	} else {
		const id = here(inner).newId()
		here(inner).inside(() => build(inner, path, undefined, id))
		p = {
			id,
			from,
			scope: own,
			run,
			timing: "pulse",
			looping: false,
			chain: 0,
			stops: [],
		}
		state.pipes.set(key, p)
		state.pipeOwner.set(p, ownerOf(own))
		base.pipes.add(id)
	}
	// its scope: this run's (or the owner's), told its node, so its writes say so
	const scope = s.createScope({ [NODE]: p.id, pipe: true }, own)
	p.scope = scope
	p.run = run
	p.tell = typeof second === "function" ? second as PipeFn : undefined
	p.from = from
	p.to = to
	p.there = fnA as PipeFn | undefined
	p.back = fnB as PipeFn | undefined
	p.timing = options.timing ?? "pulse"
	const backAt = toData?.path !== undefined && fnB !== undefined ? toData : undefined
	const watching = JSON.stringify([
		fromPath,
		n.part,
		backAt === undefined ? null : [backAt.path, backAt.part],
	])
	if (p.watching !== watching) {
		for (const stop of p.stops) stop()
		p.stops = []
		p.watching = watching
		listen(inner, p, fromPath, n.part, false)
		if (backAt !== undefined) listen(inner, p, backAt.path!, backAt.part, true)
	}
	// made again: told again
	p.looping = false
	p.chain = 0
	s.registerTeardown(scope, () => {
		if (p.scope !== scope) return
		for (const stop of p.stops) stop()
		p.stops = []
		if (state.pipes.get(key) === p) state.pipes.delete(key)
		base.pipes.delete(p.id)
		gonePipe(inner, p, path)
	})
	queuePulse()
	return handle(inner, { path, part: "value" })
}

// the pipe's node unplaced and its entries gone (its scope gone, not made again)
function gonePipe(inner: Inner, p: Piped, path: Path) {
	const { places, table } = here(inner)
	try {
		const [children, last] = slot(inner, path)
		if ((children.value as Record<string, unknown>)?.[last] === p.id) {
			const parent = get(places, path.slice(0, -1))!
			inner.put({ part: "children", id: parent, patches: unplacing(children, last) })
		}
	} catch (e) {
		if (!(e instanceof PlacesError)) throw e
	}
	for (const [part] of table.get(p.id)) inner.put({ part, id: p.id, patches: [], gone: true })
}

// p told each write at path (back: the translate's way back, to's writes)
function listen(inner: Inner, p: Piped, path: Path, part: Key, back: boolean) {
	const { base, places } = here(inner)
	const stop = places.watchPath(
		path,
		(fact: Fact) => {
			const m = fact.change?.metadata as Record<string, unknown> | undefined
			// never told its own writes
			if (m?.[NODE] === p.id) return
			const byPipe = m?.pipe !== undefined
			const w: Watched = refused(inner, targetOf(thing(fact.id, path), part))
				? { patches: [], change: undefined, value: undefined, refused: true }
				: {
					patches: fact.patches,
					change: fact.change === undefined ? undefined : viewOf(base, fact.change),
					value: fact.entry?.value,
				}
			if (p.timing === "write") told(inner, p, w, back, byPipe)
			else {
				base.piped.push(() => told(inner, p, w, back, byPipe))
				here(inner).queuePulse()
			}
		},
		{ part },
	)
	p.stops.push(stop)
}

// p told w, in its own scope: its fn, or its patches written at to (back: at from); a throw fails
// p's status, never the writer's
function told(inner: Inner, p: Piped, w: Watched, back: boolean, byPipe: boolean) {
	const { base, s, places } = here(inner)
	if (p.scope.state !== "alive" || p.looping) return
	p.chain = byPipe ? p.chain + 1 : 0
	if (base.pipeDepth >= LOOPING || p.chain > LOOPING) {
		p.looping = true
		pipeStatus(
			inner,
			p,
			new ErmineError("looping", `a pipe told pipes' writes more than ${LOOPING} in a row`),
		)
		return
	}
	base.pipeDepth++
	try {
		s.runWithScope(p.scope, () => {
			if (p.tell !== undefined) return void p.tell(w)
			if (w.refused) return
			const f = back ? p.back : p.there
			const patches = f === undefined ? w.patches : f(w)
			if (patches === undefined || patches === null) return
			if (!Array.isArray(patches)) {
				throw new ErmineError(
					"not-patches",
					"a pipe's function gives patches: [{ path, value }]",
				)
			}
			if (patches.length === 0) return
			// back: from, by its path as the pipe heard it
			const target = back ? p.from : p.to!
			// a write that would change nothing is not made (so a mirror pair settles)
			const aimed = nodeOf(inner, target)
			const at = idOf(inner, aimed)
			if (at !== undefined) {
				const now = places.peep(() => places.readValue(aimed.part, at))
				let next: unknown
				try {
					next = applyPatches(now, patches as Patch[])
				} catch {
					next = undefined
				}
				if (next !== undefined && equal(now, next)) return
			}
			patch(inner, target, patches)
		})
		if (!p.looping) pipeStatus(inner, p, undefined)
	} catch (e) {
		pipeStatus(inner, p, e)
	} finally {
		base.pipeDepth--
	}
}

// a pipe's status, in the status table: failed (the error), or none (done)
function pipeStatus(inner: Inner, p: Piped, error: unknown) {
	const { table, s } = here(inner)
	const had = table.get(STATUS_TABLE as Key, p.id)?.value as Record<string, unknown> | undefined
	if (error === undefined && had?.[STATUS] === undefined) return
	s.runWithScope(p.scope, () =>
		inner.put({
			part: STATUS_TABLE,
			id: p.id,
			patches: error === undefined
				? [{ path: [STATUS] }]
				: had === undefined
				? [{ path: [], value: { [STATUS]: error } }]
				: [{ path: [STATUS], value: error }],
		}))
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
		askPlacing(inner, slotAt(path, parent), x, id)
		placeUnder(inner, parent, path[path.length - 1], id)
	})
	queuePulse()
}

// x's children, each as a handle (reached by this process's path, so its own to hold)
function readChildren(inner: Inner, x: Target): Record<string, Node> {
	const { places } = here(inner)
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	const names = list(inner, x)
	const kids = id === undefined
		? {}
		: places.readValue("children", id) as Record<string, Id> | undefined ?? {}
	// the boxes beneath on the path, innermost first, then inner's own: a name's node as a path
	// reaches it (nodeOf: the deepest box's)
	const views = n.path === undefined
		? []
		: [...boxesOn(inner, n.path).reverse(), { places, path: n.path }]
	const out: Record<string, Node> = {}
	for (const name of names) {
		let at: Id | undefined
		for (const v of views) if ((at = get(v.places, [...v.path, name])) !== undefined) break
		at ??= kids[name]
		if (at !== undefined) out[name] = byId(inner, at, "value")
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
	const all = versions(inner, handle(inner, { ...nodeOf(inner, x), part }), path)
	if (part !== "children") return all
	return all.map((v) => ({ ...v, value: handlesFor(inner, v.value) }))
}
const handlesFor = (inner: Inner, v: unknown) =>
	v === null || typeof v !== "object" ? v : Object.fromEntries(
		Object.entries(v as Record<string, unknown>).map(([k, id]) => [
			k,
			typeof id === "string" ? byId(inner, id, "value") : id,
		]),
	)
const explainPart = (inner: Inner, x: Target, part: "value" | "attributes" | "children") =>
	explain(inner, handle(inner, { ...nodeOf(inner, x), part }))

// a folder's names patched: one name a patch, { path: [name], value: node } placing node there,
// { path: [name] } unplacing it; anything else not-patches (a process never writes a children
// entry whole: its ids). each name asked "place", as place asks
function patchChildren(inner: Inner, x: Target, patches: readonly Patch[]) {
	const { table, queuePulse, inside, ask } = here(inner)
	inside(() => {
		const n = nodeOf(inner, x)
		const folder = needId(inner, n)
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
				askPlacing(inner, slot, p.value as Target, id)
				inner.put({ part: "children", id: folder, patches: placing(children, name, id) })
			} else if (children !== undefined) {
				ask("place", slot)
				inner.put({ part: "children", id: folder, patches: unplacing(children, name) })
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

// path waited on by the reader now: a computer's (in its run now), else a setup's (the context's
// node, its setup running); anyone else's is shown nowhere, so not kept (Base's missing)
function waitFor(inner: Inner, path: Path) {
	const { base, s, runs } = here(inner)
	const run = s.getRun()
	const computer = run?.computer.info[NODE] as Id | undefined
	if (computer === undefined && !base.setting.has(inner.node)) return
	const key = computer ?? inner.node
	const n = computer === undefined ? undefined : (runs.read(computer)?.n ?? 0) + 1
	let m = base.missing.get(key)
	if (m === undefined || m.n !== n) {
		m = n === undefined ? { paths: [], keys: new Set() } : { n, paths: [], keys: new Set() }
		base.missing.set(key, m)
	}
	// kept from the root, shown to each asker as it sees it
	const abs = [...boxAt(base, inner.context.box.root) ?? [], ...path]
	const k = keyOf(abs)
	if (!m.keys.has(k)) m.keys.add(k), m.paths.push(abs)
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
		ask("place", slotAt(path, parent))
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

function remove(inner: Inner, x: Target) {
	const { base, calls, runs, table, queuePulse, inside, places, ask } = here(inner)
	inside(() => {
		const n = nodeOf(inner, x)
		const id = needId(inner, n)
		ask("remove", targetOf(thing(id, n.path)))
		if (n.path !== undefined && n.path.length) {
			const [children, name] = slot(inner, n.path)
			const v = children.value as Record<string, unknown> | undefined
			if (v !== undefined && v[name] === id) {
				const parent = get(places, n.path.slice(0, -1))!
				inner.put({ part: "children", id: parent, patches: unplacing(children, name) })
			}
		}
		for (const [part] of table.get(id)) inner.put({ part, id, patches: [], gone: true })
		runs.drop(id)
		calls.drop(id)
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
		base.missing.delete(m.id)
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

const same = (m: Made) => (a: unknown, b: unknown) =>
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
				? base.sited.createEffect<T>(run, then, same(m), { early: true }, { [NODE]: id })
				: base.sited.createEffect<T>(
					(previous) => ran(inner, m, previous) as T,
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
	return handle(inner, n)
}

// deno-lint-ignore no-explicit-any
function createAction(inner: Inner, p: string | Path, fn: (...args: any[]) => unknown): Node {
	const { calls, parts, methods, s, queuePulse, places, inside, resolve, ask } = here(inner)
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
			// its record goes with it (calls.ts)
			calls.drop(made)
		}
		s.registerTeardown(own, keep)
	}
	const n: NodeData = { path, part: "value" }
	parts.onCreateFunction?.({ kind: "method", node: n, id: made, process: inner.node })
	queuePulse()
	return handle(inner, n)
}

function executeAction(inner: Inner, p: Target, ...args: unknown[]): unknown {
	const { base, calls, methods, s, table, queuePulse, context, scope, places, ask } = here(inner)
	const n = nodeOf(inner, p)
	const id = idOf(inner, n)
	const at = n.path !== undefined ? { path: n.path } : { id: n.id }
	// in a run, the computer waits; else whoever this context is
	const run = s.getRun()
	const caller = (run?.computer.info[NODE] as Id | undefined) ?? inner.node
	// tracked in a run, so the handler coming reruns it
	const fn = id === undefined ? undefined : places.readValue("value", id)
	if (fn === undefined) {
		// kept while the caller is: a computer's with it, else the context's. the path: in inner's box
		calls.wait(caller, at, inner.context.box.root, run?.computer ?? scope)
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
	const made = inside(() => makeBox(host, at, context.box, header(inner)))
	// a box at that folder already: that one (made again by a rerun, or by another)
	const b = base.boxIndex.get(made.root) ?? made
	if (!base.boxIndex.has(b.root)) base.boxIndex.set(b.root, b), base.names++
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
	const n = nodeOf(inner, x)
	const id = idOf(inner, n)
	if (id === undefined) return undefined
	return base.statused({ node: n, id }, ownStatus(inner, n, id))
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

// asked, read and told as inner sees it
function ownStatus(inner: Inner, n: NodeData, id: Id): Status {
	const { base, calls, runs, places, guard, guarded } = here(inner)
	if (guarded) guard.read(targetOf(thing(id, n.path), STATUS_TABLE, [STATUS]))
	const st = places.readValue(STATUS_TABLE, id, [STATUS])
	const h = base.held.status(id) ?? base.held.row(id)
	const held = h === undefined ? {} : { held: h }
	if (!base.computers.has(id)) {
		if (st === undefined) return { state: "done", ...held }
		if (base.pipes.has(id) && st instanceof ErmineError && st.code === "looping") {
			return { state: "looping", error: st, ...held }
		}
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
	const { base, table, places, guard, guarded } = here(inner)
	// a change's view (a reads item's from.change, a watch's): its change. a view is known only
	// by base.changes, so none can be forged into a record's lookup
	const viewed = typeof x === "object" && !isHandle(x) && !Array.isArray(x)
		? base.changes.get(x as ChangeView)
		: undefined
	if (viewed !== undefined) return writerOf(inner, viewed)
	if (typeof x === "object" && !isHandle(x) && !Array.isArray(x)) {
		throw new PlacesError("nothing-there", "not a change this ermine shows")
	}
	const n = nodeOf(inner, x as Target)
	const id = idOf(inner, n)
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
		const w = d.id === undefined ? walkFrom(here(inner).base, d.path) : undefined
		const id = d.id ?? get(w!.places, w!.path)
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
	if (m.pipe !== undefined && m[NODE] !== undefined) {
		return { change: view, writer: { kind: "pipe", ...pathOf(inner, m[NODE] as Id) } }
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
	pipe: {
		(from: Target, fn: (w: Watched) => unknown, options?: PipeOptions): Node
		(
			from: Target,
			to: Target,
			fnA?: (w: Watched) => readonly Patch[] | undefined,
			fnB?: (w: Watched) => readonly Patch[] | undefined,
			options?: PipeOptions,
		): Node
		(from: Target, to: Target, options: PipeOptions): Node
	}
	// deno-lint-ignore no-explicit-any
	createAction: (path: string | Path, fn: (...args: any[]) => unknown) => Node
	executeAction: (path: Target, ...args: unknown[]) => unknown
	getCaller: () => Caller | undefined
	getStatus: (x: Target) => Status | undefined
	addTeardown: (fn: (why: Why) => unknown) => void
	createBox: (path: string | Path) => BoxNode
	getArgs: () => readonly string[]
	remove: (x: Target) => void
	pulse: () => void
}

// each function's implementation, given the context it acts as (functions.ts finds it)
export const getArgs = (inner: Inner): readonly string[] => inner.context.args
export const readAll = (inner: Inner, x: Target, key?: readonly Step[]) =>
	allOf(inner, x, "value", key)
export const readAllAttributes = (inner: Inner, x: Target, key?: readonly Step[]) =>
	allOf(inner, x, "attributes", key)
export const readAllChildren = (inner: Inner, x: Target) => allOf(inner, x, "children")
export const explainAttributes = (inner: Inner, x: Target) => explainPart(inner, x, "attributes")
export const explainChildren = (inner: Inner, x: Target) => explainPart(inner, x, "children")
export const patchChildrenOnly = (inner: Inner, x: Target, patches: readonly Patch[]) =>
	patchChildren(inner, x, patchesOnly(patches))
export const pulse = (inner: Inner) => here(inner).base.pulse()
export {
	addTeardown,
	createAction,
	createBox,
	createEffect,
	createMemo,
	createNode,
	ensureNode,
	executeAction,
	explain,
	getCaller,
	getNode,
	getStatus,
	hasNode,
	here,
	list,
	patch,
	patchAttributes,
	peep,
	pipe,
	place,
	read,
	readAttributes,
	readChildren,
	readEntries,
	ref,
	remove,
	rename,
	unplace,
}
// whether inner's ermine gives hints (createErmine's hints)
export const hintsOn = (inner: Inner): boolean | undefined => bases.get(inner)?.hints

export { foundFor } from "./registry.ts"
export type { Table }
