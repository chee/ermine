// sites (sites.ts) on the line protocol: one JSON request per line in, one answer per line out, in
// order. one scheduler and its sites last for the process; scopes by name. only whether a site is
// there and how long a chain is are told: where in the code is the language's own (the tests of
// each have it). another implementation joins by speaking this (HARNESS)
//
// { op: "root", name, wrapped? }              → {}   a scope with no parent
// { op: "scope", name, parent?, wrapped? }    → {}   a scope under parent (none: the one open: none)
// { op: "computer", name, parent, wrapped? }  → {}   a compute made with parent open
// { op: "effect", name, parent, wrapped? }    → {}   an effect made with parent open
//    wrapped: false makes it with the scheduler alone (default true: through the sites). each
//    computer and effect reads one key, the same for all
// { op: "frame", name, parent, wrapped? } → {}   a frame alone under parent's (a scope's: its own)
// { op: "note", name }                        → {}   a site noted on it, the harness's
// { op: "rerun" }                             → {}   a pulse, the key marked, a pulse: each
//    computer and effect runs again
// { op: "site", name }                        → { site }   whether it has a site of its own
// { op: "chain", name }                       → { length } how many sites its chain has (frames)
import { createScheduler, type Frame, type Scope } from "@ermine/core/scheduler"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { createSites } from "./sites.ts"

const info = { owner: "test" }
const scheduler = createScheduler()
const sites = createSites(scheduler)
const named = new Map<string, Scope | Frame>()
// what every computer and effect reads
const KEY = {}
const read = () => (scheduler.track(KEY), 1)

function find(name: unknown): Scope | undefined {
	const x = typeof name === "string" ? named.get(name) : undefined
	return x !== undefined && "frame" in x ? x : undefined
}
const either = (name: unknown) => typeof name === "string" ? named.get(name) : undefined

export function answer(r: Request): Record<string, unknown> {
	const wrapped = r.wrapped !== false
	const via = wrapped ? sites : scheduler
	switch (r.op) {
		case "root":
		case "scope":
		case "computer":
		case "effect": {
			if (typeof r.name !== "string") throw new Error(`${r.op}: no name`)
			const parent = find(r.parent)
			let made: Scope
			if (r.op === "root") made = via.createRootScope(info)
			else if (r.op === "scope") made = via.createScope(info, parent)
			else {
				if (parent === undefined) throw new Error(`${r.op}: no parent`)
				made = scheduler.runWithScope(
					parent,
					() =>
						r.op === "effect"
							? via.createEffect(read, () => {})
							: via.createComputer(read, () => {}),
				)
			}
			named.set(r.name, made)
			return {}
		}
		case "frame": {
			if (typeof r.name !== "string") throw new Error("frame: no name")
			const up = either(r.parent)
			if (up === undefined) throw new Error("frame: no parent")
			const f = "frame" in up ? up.frame : up
			named.set(r.name, via.createFrame(info, f))
			return {}
		}
		case "note": {
			const o = either(r.name)
			if (o === undefined) throw new Error(`note: no ${r.name}`)
			sites.note(o, { file: import.meta.url, line: 1 })
			return {}
		}
		case "rerun":
			scheduler.pulse()
			scheduler.mark([KEY])
			scheduler.pulse()
			return {}
		case "site": {
			const o = either(r.name)
			if (o === undefined) throw new Error(`site: no ${r.name}`)
			return { site: sites.siteOf(o) !== undefined }
		}
		case "chain": {
			const o = either(r.name)
			if (o === undefined) throw new Error(`chain: no ${r.name}`)
			return { length: sites.sitesOf(o).length }
		}
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

if (import.meta.main) {
	await serve(answer)
}
