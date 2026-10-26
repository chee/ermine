// patch nodes on @ermine/system, split by the three kinds: the overlay a feature, patch a library,
// land a service. nothing of theirs is in the base
//
//   import patchy, { createPatch, land, layers } from "@ermine/patchy/feature"
//   const ermine = createErmine({ features: [patchy] })
//   ermine.createAction("/system/land", land(ermine))    // the host places the service, where it says
//   // a program:
//   const skin = createPatch("cherry", face, [{ path: ["accent"], value: "cherry" }])
//   read(face)                                           // through the overlay: { accent: "cherry" }
//   layers(face, ["accent"])                             // [{ value: "cherry", from: <skin> }, { value: "red", from: "table" }]
//   executeAction("/system/land", skin)                  // its patches on face for real
//
// the feature: onTable puts the overlay in front of places' table (its events and commits on to
// what is in front of it); onRead adds, where a patch node is over the node read, every layer,
// front first: { value, from: { kind: "layer", layer: <patch node's id, or "table">, stale?,
// error? } } (createErmine adds from.feature).
// createPatch(at, over, change) (was patch; @ermine/system's patch writes a node): a library on
// @ermine/system's functions, as the process calling it. the patch node at at (made, with nothing
// in it, when missing: ensureNode), its "patch" entry written by patch: { on, part, at, patches }
// against over's saved value (the table's layer, else read's) and its change's time. change:
// patches, or a recipe over that value (the library's: the base takes patches only).
// layers(x, path?): readAll's layers, front first, as the overlay's Item; none over x: the table's
// alone (read's), or none.
// land(ermine): the service's handler: the patch node sent landed. no stricter and no looser than
// its caller's own functions (chee 10-24: holding an id is the permission; boxes limit paths only): a
// path is resolved in the caller's box (ermine.calling()'s context), an id is reached as it is, as
// is the id the patch names (on). asked "edit" on the target (by its id) and on the patch node (by
// the path it was sent by, else its id) as the caller and as the service, as the caller's own edit
// would be asked (it lands only where both may), written with the service's power in the call (the
// caller on its change); the patch entry taken out once the write has landed. a write that fails
// throws, one an onWrite hook holds back gives false: either way the patch node is kept. landed:
// true
import type { Ermine, Feature, FeatureAPI, Node, NodeData, Target, Version } from "@ermine/system"
import { ensureNode, ErmineError, getNode, patch, readAll, readEntries } from "@ermine/system"
import type { Key as Step, Patch } from "@ermine/core/op/apply"
import produce from "@ermine/core/op/produce"
import { get } from "@ermine/core/places/lib"
import { target } from "@ermine/core/places/guard"
import type { ChangeHeader } from "@ermine/core/node/entry"
import type { Table } from "@ermine/core/table"
import {
	createOverlay,
	entries,
	type Item,
	type Overlay,
	PatchError,
	type PatchNode,
	TABLE,
} from "./patch.ts"

// the kind of a layer's from, in reads
export const LAYER = "layer"

const patchy: Feature = {
	name: "patchy",
	files: [import.meta.url],
	setup(f) {
		installed.add(new WeakRef(f))
		let overlay: Overlay | undefined
		// what the overlay is in front of: each layer's change is read there
		let under: Pick<Table, "get"> | undefined
		f.onTable((table, next) => {
			const t = next(table)
			under = t
			return overlay = createOverlay(t, table.ahead)
		})
		f.onRead((x, items, next) => {
			if (overlay === undefined) return next(x, items)
			const ls = entries(f.places, overlay, x.part, x.id, x.path)
			if (!ls.some((l) => l.from !== TABLE)) return next(x, items)
			// a layer's change: the patch node's patch entry's; the table's, the target's own
			const changeOf = (l: Item) =>
				(l.from === TABLE ? under?.get(x.part, x.id) : under?.get("patch", l.from))?.change
			// a layer named by its patch node's path as the reader sees it (no ids: seen)
			const layerOf = (l: Item) => l.from === TABLE ? TABLE : f.seen(l.from, x.context) ?? null
			return next(x, [...items, ...ls.map((l) => asVersion(l, changeOf(l), layerOf(l)))])
		})
	},
}
export default patchy

const asVersion = (
	l: Item,
	change: ChangeHeader | undefined,
	layer: readonly string[] | typeof TABLE | null,
): Version => ({
	value: l.value,
	from: {
		...change !== undefined && { change },
		kind: LAYER,
		layer,
		...l.stale && { stale: true },
		...l.error !== undefined && { error: l.error },
	},
})

const isPath = (x: unknown): x is string | readonly string[] =>
	typeof x === "string" || Array.isArray(x)

// every patchy set up, one per ermine, held weakly (its hooks hold it while its ermine is): a
// handle is known to its own ermine's only (dataOf). one closed (its dataOf throws closed) or let go
// is dropped as it is met
const installed = new Set<WeakRef<FeatureAPI>>()
function featureOf(h: Node): { f: FeatureAPI; node: NodeData } {
	for (const r of installed) {
		const f = r.deref()
		const d = known(f, h)
		if (d === null) installed.delete(r)
		else if (d !== undefined) return { f: f!, node: d.node }
	}
	throw new PatchError("nothing-there", "a node no ermine with patchy gave")
}
// what h reaches in f's ermine (none: undefined); f's ermine gone or closed: null
function known(f: FeatureAPI | undefined, h: Node): { node: NodeData } | undefined | null {
	if (f === undefined) return null
	try {
		return f.dataOf(h)
	} catch (e) {
		if (e instanceof ErmineError && e.code === "closed") return null
		throw e
	}
}

// patches, or a recipe over the saved value (produce: core/op's draft)
// deno-lint-ignore no-explicit-any
export type Change = readonly Patch[] | ((draft: any) => unknown)

export function createPatch(at: string | readonly string[], over: Target, change: Change): Node {
	const o: Node = isPath(over) ? getNode(over as string) : over
	const { f, node: od } = featureOf(o)
	// the target's id, from the handle readEntries gives (patchy's power: dataOf)
	const first = readEntries(o)[0]?.node
	const on = od.id ?? (first === undefined ? undefined : f.dataOf(first)?.node.id)
	if (on === undefined) throw new PatchError("nothing-there", String(od.path?.join("/") ?? od.id))
	const shown = readAll(o)
	const saved = shown.find((v) => v.from.kind === LAYER && v.from.layer === TABLE) ?? shown[0]
	const patches = typeof change === "function"
		? produce(saved?.value ?? (od.part === "attributes" ? {} : undefined), change as never)
		: change as readonly Patch[]
	const node: PatchNode = { on, part: od.part, at: shown[0]?.from.change?.time ?? 0, patches }
	const n = ensureNode(at as string)
	// its patch entry, through a handle to that table (patchy's power: minted from the node's
	// place), the edit asked as the process calling, as any patch is
	const made = f.dataOf(n)!
	patch(f.handleOf({ ...made.node, part: "patch" }), [{ path: [], value: node }])
	return n
}

// a layer as layers gives it: its value, and the patch node by its path as the caller sees it
// (the table's own: TABLE; outside its box: null)
export type Layer = {
	readonly value: unknown
	readonly from: readonly string[] | typeof TABLE | null
	readonly stale?: true
	readonly error?: unknown
}

export function layers(x: Target, path: readonly Step[] = []): Layer[] {
	const all = readAll(x, path)
	const ls = all.filter((v) => v.from.kind === LAYER)
	if (ls.length) {
		return ls.map((v) => ({
			value: v.value,
			from: v.from.layer as Layer["from"],
			...v.from.stale === true && { stale: true as const },
			...v.from.error !== undefined && { error: v.from.error },
		}))
	}
	return all.length ? [{ value: all[0].value, from: TABLE }] : []
}

export function land(
	ermine: Pick<Ermine, "table" | "getProcessContext" | "calling" | "dataOf" | "readEntries">,
) {
	return (p: Target): boolean => {
		// the service's own context (the host's, who placed it), and the caller's (where and as whom
		// it sent; none: the host called it)
		const own = ermine.getProcessContext()!
		// the patch node as the caller's own edit would reach it: a handle, its place from the root
		// (or its id); a path, in the caller's box
		const d = isPath(p) ? undefined : ermine.dataOf(p)
		if (!isPath(p) && d === undefined) throw new PatchError("nothing-there", "not a node handle")
		// asked as the caller (it acts for its caller), whether sent a handle or a path
		const from = ermine.calling()?.context ?? own
		const n: NodeData = d?.node ?? { path: from.resolve(p as string), part: "value" }
		// a handle's place: the node the host reaches there, by id (readEntries gives it)
		const reached = d !== undefined && n.path !== undefined
			? ermine.readEntries(p)[0]?.node
			: undefined
		const id = reached !== undefined
			? ermine.dataOf(reached)?.node.id
			: n.id ?? get(from.box.places, n.path!)
		const v = id === undefined
			? undefined
			: ermine.table.get("patch", id)?.value as PatchNode | undefined
		if (id === undefined || v === undefined) {
			throw new PatchError("nothing-there", String(id ?? n.path?.join("/")))
		}
		// asked as both, in the form the caller's own edit would be: the target by its id (what the
		// patch names), the patch node by the path it was sent by, else its id. it lands only where
		// the caller and the service may both edit
		const on = target({ id: v.on }, v.part)
		const it = target(n.path === undefined ? { id } : { id, path: n.path }, "patch")
		for (const o of from === own ? [own] : [from, own]) o.ask("edit", on, it)
		const before = ermine.table.get(v.part, v.on)?.change
		own.write(v.part, v.on, v.patches)
		// held back (an onWrite hook): the patch node kept
		if (ermine.table.get(v.part, v.on)?.change === before) return false
		own.remove("patch", id)
		return true
	}
}
