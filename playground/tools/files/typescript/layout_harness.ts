// layout (layout.ts) on the line protocol (conformance/typescript/harness.ts); requests stand alone
//
//   hash     64 lowercase hex digits; the null value's is NULL (a folder's file needs it)
//   head     a bin value's first bytes (names.HEAD, 12), lowercase hex
//   node     {kept: [hash, form], head?, sides: [[hash, form, head?]], info: [[name, hash, form]],
//            directory: {name: [ids]}}
//   graph    {root, nodes: {id: node}}
//   record   a Layout: {home?: [holder, name, position], file?, laid?, was?, sides?: [names],
//            folder?: true, entries?: {slot: stem | [stem, ...]}, left?: [paths], away?: true}
//   layout   {id: record}
//   laid     a Laid (types.ts), every field written, none undefined
//   step     a Step (types.ts), undefined fields omitted; before/after null for nothing
// key order is never part of an answer; list order is (union stems, sides, info, plan steps)
//
//   {op: "relative", from, to}                      -> {path}
//   {op: "dir", layout, id}                         -> {path: the path | null}
//   {op: "disk", graph, layout, pass?}              -> {laid: {path: laid}}
//   {op: "prune", graph, layout}                    -> {layout}
//   {op: "sameInfo", a, b}                          -> {same: true | false}
//   {op: "lay", graph, old, probe, ino?, time, pass?, before?}
//                                                   -> {layout, changed, plan}
//     probe   {folder: [names]} on disk; a folder not given has none
//     ino     {path: number | null}; a path not given: null; no ino: lay gets none
//     pass    the store's names passed over; default names.PASS
//     before  the graph old was laid out from; default lay's own (the graph)
import { dir, disk, lay, prune, relative, sameInfo } from "./layout.ts"
import * as names from "./names.ts"
import type { Form, Graph, Id, Info, Layout, Node } from "./types.ts"
import { type Answer, type Request, serve } from "../../../../conformance/typescript/harness.ts"

/** The null value's hash. */
export const NULL = "61a9bf10f0ffedc7dc77589ae2ab4ca80b006c806e6636e41b60410cd8f0bbc4"

type J = Record<string, unknown>

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

function nodeIn(j: J): Node {
	const n: Node = {
		kept: j.kept as [string, Form],
		sides: (j.sides as [string, Form, string?][]).map(([h, f, head]) =>
			head === undefined ? [h, f] as const : [h, f, unhex(head)] as const
		),
		info: j.info as Info,
		directory: new Map(Object.entries(j.directory as Record<string, Id[]>)),
	}
	if (typeof j.head === "string") n.head = unhex(j.head)
	return n
}
const graphIn = (j: J): Graph => ({
	root: j.root as Id,
	nodes: new Map(Object.entries(j.nodes as Record<string, J>).map(([id, n]) => [id, nodeIn(n)])),
})

function recordIn(j: J): Layout {
	const r: Layout = { ...j } as Layout
	if (j.entries) r.entries = new Map(Object.entries(j.entries as Record<string, string>))
	return r
}
function recordOut(r: Layout): J {
	const j: J = {}
	for (const [k, v] of Object.entries(r)) {
		if (v === undefined) continue
		j[k] = k === "entries" ? Object.fromEntries(v as Map<string, unknown>) : v
	}
	return j
}
const layoutIn = (j: unknown) =>
	new Map(Object.entries(j as Record<string, J>).map(([id, r]) => [id, recordIn(r)]))
const layoutOut = (m: ReadonlyMap<Id, Layout>) =>
	Object.fromEntries([...m].map(([id, r]) => [id, recordOut(r)]))

function run(r: Request): Answer {
	switch (r.op) {
		case "relative":
			return { path: relative(r.from as string, r.to as string) }
		case "dir":
			return { path: dir(layoutIn(r.layout), r.id as Id) ?? null }
		case "disk":
			return {
				laid: Object.fromEntries(
					disk(graphIn(r.graph as J), layoutIn(r.layout), (r.pass as string[]) ?? names.PASS),
				),
			}
		case "prune":
			return { layout: layoutOut(prune(graphIn(r.graph as J), layoutIn(r.layout))) }
		case "sameInfo":
			return { same: sameInfo(r.a as Info, r.b as Info) }
		case "lay": {
			const probe = (r.probe ?? {}) as Record<string, string[]>
			const ino = r.ino as Record<string, number | null> | undefined
			const out = lay(
				graphIn(r.graph as J),
				layoutIn(r.old),
				(folder) => Object.hasOwn(probe, folder) ? probe[folder] : [],
				r.time as number,
				(r.pass as string[]) ?? names.PASS,
				{
					...(r.before ? { before: graphIn(r.before as J) } : {}),
					...(ino ? { ino: (p: string) => Object.hasOwn(ino, p) ? ino[p] : null } : {}),
				},
			)
			return { layout: layoutOut(out.layout), changed: layoutOut(out.changed), plan: out.plan }
		}
		default:
			return { error: `unknown op ${r.op}` }
	}
}

// head bytes, should any reach an answer, as hex
function hexed(v: unknown): unknown {
	if (v instanceof Uint8Array) return hex(v)
	if (Array.isArray(v)) return v.map(hexed)
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hexed(x)]))
	}
	return v
}

if (import.meta.main) await serve((r) => hexed(run(r)) as Answer)
