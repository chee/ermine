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
// { op: "rerun" }                             → {}   a pulse, the key marked, a pulse: each
//    computer and effect runs again
// { op: "site", name }                        → { site }   whether the scope has a site of its own
// { op: "chain", name }                       → { length } how many sites its chain has
import { createScheduler, type Scope } from "@ermine/core/scheduler"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { createSites } from "./sites.ts"

const info = { owner: "test" }
const scheduler = createScheduler()
const sites = createSites(scheduler)
const named = new Map<string, Scope>()
// what every computer and effect reads
const KEY = {}
const read = () => (scheduler.track(KEY), 1)

function find(name: unknown): Scope | undefined {
	return typeof name === "string" ? named.get(name) : undefined
}

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
		case "rerun":
			scheduler.pulse()
			scheduler.mark([KEY])
			scheduler.pulse()
			return {}
		case "site": {
			const o = find(r.name)
			if (o === undefined) throw new Error(`site: no scope ${r.name}`)
			return { site: sites.siteOf(o) !== undefined }
		}
		case "chain": {
			const o = find(r.name)
			if (o === undefined) throw new Error(`chain: no scope ${r.name}`)
			return { length: sites.sitesOf(o).length }
		}
		default:
			throw new Error(`unknown op ${r.op}`)
	}
}

if (import.meta.main) {
	await serve(answer)
}
