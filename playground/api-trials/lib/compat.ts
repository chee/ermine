// the designs' adapters treat a node as data ({ path } or { id }, with its part), as the base did
// before its handles became opaque (10-25). this wraps a process's api for them: a node given as
// data is minted that process's handle, and a handle given back is its data again. the trial's
// host does it, with the host's power (ermine.handleOf, dataOf); programs never see it
import type { API, Ermine, Item, Node, NodeData, ProcessContext } from "@ermine/ermine"

// the api as the adapters see it: a node as its data, given or taken (entries' items carry its id)
type Data<T> = T extends Node ? NodeData : T extends Item[] ? (Item & { id?: unknown })[] : T
export type DataAPI = {
	[K in keyof API]: API[K] extends (...a: infer A) => infer R
		? (...a: { [I in keyof A]: A[I] | NodeData }) => Data<R>
		: API[K]
}

const isData = (x: unknown): x is NodeData =>
	x !== null && typeof x === "object" && !Array.isArray(x) && "part" in x &&
	Object.keys(x).every((k) => k === "id" || k === "path" || k === "part")

// the functions whose answer is a node, and entries, whose items hold one
const GIVES = new Set([
	"open",
	"create",
	"make",
	"ref",
	"info",
	"memo",
	"effect",
	"early",
	"method",
])

export function compat(api: API, ermine: Ermine): DataAPI {
	// this process's context: a handle its own api made says whose it is
	let context: ProcessContext | undefined
	const own = () => context ??= ermine.dataOf(api.info("."))!.context
	const into = (x: unknown) => isData(x) ? ermine.handleOf(x, own()) : x
	const back = (x: unknown) => ermine.dataOf(x)?.node ?? x
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(api)) {
		if (typeof v !== "function") {
			out[k] = v
			continue
		}
		out[k] = (...a: unknown[]) => {
			const r = (v as (...a: unknown[]) => unknown)(...a.map(into))
			if (GIVES.has(k)) return back(r)
			if (k === "entries" && Array.isArray(r)) {
				return r.map((i) => {
					if (i.node === undefined) return i
					const d = back(i.node) as NodeData
					return { ...i, id: d.id ?? d }
				})
			}
			return r
		}
	}
	return out as unknown as DataAPI
}
