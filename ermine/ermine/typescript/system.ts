// @ermine/system: the process api, verb-first and mechanical, one module [chee 10-25: "let's change
// the process api to be verb first, like verb noun mostly or just verb and make it a very clear
// mechanical api"; "the let's do @ermine/system"]. every function finds its process from the scope
// open (as found.ts's), over the base's own functions (words.ts); nothing open: nothing-open.
//
//   import { createMemo, ensureNode, readValue } from "@ermine/system"
//   export default function setup() {
//     ensureNode("./items", [])
//     return createMemo("count", () => (readValue("./items") as unknown[]).length)
//   }
//
// one verb for each of a node's three parts [chee 10-25: "i wonder if we should have readChildren
// peepChildren readChildrenVersions explainChildren patchChildren and we build these other things
// atop. i also thing we should drop `value` from the value ones"; "yep i want all three to happen.
// we'll go with peep"; readAll: "i guess is best of these"]:
//            value        attributes          children
// read       read         readAttributes      readChildren ({ name: node })
// every one  readAll      readAllAttributes   readAllChildren
// write      patch        patchAttributes     patchChildren (one name a patch: a node, or none)
// who        explain      explainAttributes   explainChildren
// untracked  peep(f): f with nothing it reads tracked
// nodes      getNode (makes nothing), hasNode, ensureNode (made with value only if missing),
//            createNode (a fresh name), ref (make() only if missing: a live value), readEntries
//            (every node a path reaches). patches only; a node not there: nothing-there
// names      place, unplace (patchChildren's rule, by a path), rename (the base's move: one change
//            over two folders, its cycle check), list
// computing  createMemo, createEffect ({ early }), watch (until pipes)
// actions    createAction, executeAction, getCaller
// asking     getStatus, explain
// the rest   addTeardown, createBox, getArgs, PENDING, REFUSED
// the host's own (not here): remove, pulse
import type { Key as Step, Patch } from "@ermine/core/op/apply"
import type { Equal } from "@ermine/core/scheduler"
import type { Path } from "@ermine/places"
import type { Node, Target, Version, Why } from "./context.ts"
import { ErmineError } from "./features.ts"
import { foundFor } from "./registry.ts"
import type {
	API,
	BoxNode,
	Caller,
	ChangeView,
	Explained,
	HostAPI,
	Item,
	Status,
	Watched,
} from "./words.ts"

type Computed<T> = (previous: T | undefined) => T | PromiseLike<T> | symbol

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

// patches, never a recipe (the base is mechanical [chee 10-25: "the core lib should actually not
// have proxies, and should be this kind of mechanical thing"])
function patchesOnly(patches: unknown): readonly Patch[] {
	if (!Array.isArray(patches)) {
		throw new ErmineError("not-patches", "patch takes patches: [{ path, value }]")
	}
	return patches
}

// the process api over at(name): the base's functions to use (a process's, found from the scope
// open; the host's, for the host). name: the function asked, for nothing-open's message
export function systemFrom(at: (name: string, x?: unknown) => API | HostAPI): System {
	return {
		getNode: (path) => at("getNode").open(path),
		hasNode: (x) => at("hasNode", x).entries(x).some((i) => i.refused !== true),
		ensureNode: (path, value) =>
			value === undefined ? at("ensureNode").make(path) : at("ensureNode").open(path, value),
		createNode: (folder, value) => at("createNode").create(folder, value),
		ref: (path, make) => at("ref").ref(path, make),
		read: (x, key) => at("read", x).read(x, key),
		readAttributes: (x, key) => {
			const a = at("readAttributes", x)
			return a.read(a.info(x), key)
		},
		readChildren: (x) => at("readChildren", x).readChildren(x),
		readAll: (x, key) => at("readAll", x).readAllOf(x, "value", key),
		readAllAttributes: (x, key) => at("readAllAttributes", x).readAllOf(x, "attributes", key),
		readAllChildren: (x) => at("readAllChildren", x).readAllOf(x, "children"),
		readEntries: (x) => at("readEntries", x).entries(x),
		peep: (f) => at("peep").untrack(f),
		patch: (x, patches) => at("patch", x).edit(x, patchesOnly(patches)),
		patchAttributes: (x, patches) => {
			const a = at("patchAttributes", x)
			a.edit(a.info(x), patchesOnly(patches))
		},
		patchChildren: (x, patches) => at("patchChildren", x).patchChildren(x, patchesOnly(patches)),
		explain: (x, key) => at("explain", x).explain(x, key),
		explainAttributes: (x) => at("explainAttributes", x).explainOf(x, "attributes"),
		explainChildren: (x) => at("explainChildren", x).explainOf(x, "children"),
		place: (path, x) => at("place").place(path, x),
		unplace: (path) => at("unplace").unplace(path),
		rename: (from, to) => at("rename").move(from, to),
		list: (x) => at("list", x).list(x),
		createMemo: (name, f, options) => at("createMemo").memo(name, f as never, options),
		createEffect: (name, f, act, options) => {
			const a = at("createEffect")
			const o = options?.equal === undefined ? undefined : { equal: options.equal }
			return options?.early
				? a.early(name, f as never, act as never, o as never)
				: a.effect(name, f as never, act as never, o as never)
		},
		watch: (x, fn) => at("watch", x).watch(x, fn),
		createAction: (path, fn) => at("createAction").method(path, fn),
		executeAction: (path, ...args) => at("executeAction", path).send(path, ...args),
		getCaller: () => at("getCaller").getCaller(),
		getStatus: (x) => at("getStatus", x).status(x),
		addTeardown: (fn) => at("addTeardown").teardown(fn),
		createBox: (path) => at("createBox").box(path),
		getArgs: () => at("getArgs").args,
	}
}

// a process's: found from the scope open; nothing open, a handle given first: its maker's
const system = systemFrom(foundFor)

export const getNode: System["getNode"] = system.getNode
export const hasNode: System["hasNode"] = system.hasNode
export const ensureNode: System["ensureNode"] = system.ensureNode
export const createNode: System["createNode"] = system.createNode
export const ref: System["ref"] = system.ref
export const read: System["read"] = system.read
export const readAttributes: System["readAttributes"] = system.readAttributes
export const readChildren: System["readChildren"] = system.readChildren
export const readAll: System["readAll"] = system.readAll
export const readAllAttributes: System["readAllAttributes"] = system.readAllAttributes
export const readAllChildren: System["readAllChildren"] = system.readAllChildren
export const readEntries: System["readEntries"] = system.readEntries
export const peep: System["peep"] = system.peep
export const patch: System["patch"] = system.patch
export const patchAttributes: System["patchAttributes"] = system.patchAttributes
export const patchChildren: System["patchChildren"] = system.patchChildren
export const explain: System["explain"] = system.explain
export const explainAttributes: System["explainAttributes"] = system.explainAttributes
export const explainChildren: System["explainChildren"] = system.explainChildren
export const place: System["place"] = system.place
export const unplace: System["unplace"] = system.unplace
export const rename: System["rename"] = system.rename
export const list: System["list"] = system.list
export const createMemo: System["createMemo"] = system.createMemo
export const createEffect: System["createEffect"] = system.createEffect
export const watch: System["watch"] = system.watch
export const createAction: System["createAction"] = system.createAction
export const executeAction: System["executeAction"] = system.executeAction
export const getCaller: System["getCaller"] = system.getCaller
export const getStatus: System["getStatus"] = system.getStatus
export const addTeardown: System["addTeardown"] = system.addTeardown
export const createBox: System["createBox"] = system.createBox
export const getArgs: System["getArgs"] = system.getArgs
export { PENDING } from "@ermine/core/scheduler"
export { REFUSED } from "@ermine/places/guard"
