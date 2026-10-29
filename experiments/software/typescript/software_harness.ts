// software (software.ts) on the line protocol: one JSON request per line in, one answer per line out.
// one ermine (manual pulses: only "pulse" runs one); paths are strings. every loader is made of a
// kind; every run and every interpreter is kept by its `at`, to be stopped by it.
//
// loader kinds (a program's value is its code)
//   double   the code is a number; the setup logs ["ran", code] and gives code * 2 (the process's value)
//   note     the setup logs ["ran", code] and writes the code to its node "note" (a program that
//            waited for its code can write; it can't give a value)
//   refuse   the load throws "no native code here"
//   broken   the setup throws "setup broke"
//
// { op: "node", path, value? }              → {}   the node ensured, as the host
// { op: "set", path, value }                → {}   its value replaced
// { op: "loader", path, kind }              → {}   a loader placed by the host
// { op: "interpreter", at, name, kind }     → {}   a process at `at` whose setup places a loader at
//    `name` (inside its node), of the kind
// { op: "run", loader, program, at }        → { at } | { refused: "taken", at }   software's run;
//    a throw: { error }
// { op: "stop", at }                        → {}   the run or interpreter at `at` stopped
// { op: "pulse" }                           → {}
// { op: "read", path }                      → { value } | { pending: true }
// { op: "has", path }                       → { has }
// { op: "status", path }                    → { state }   null: nothing there
// { op: "log" }                             → { log }   what the setups logged, in order
// { op: "call", loader, program }           → { end, error?, readsProgram }   the loader's latest call
//    record: how it ended, and whether its reads include the program
import {
	createErmine,
	ensureNode,
	getStatus,
	hasNode,
	patch,
	PENDING,
	pulse,
	read,
} from "@ermine/system"
import { get } from "@ermine/places/lib"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { manual } from "../../../system/typescript/manual_fixture.ts"
import { createLoader, run, type Setup } from "./software.ts"

const e = createErmine({ features: [manual] })
const log: unknown[] = []
const kept = new Map<string, { stop: (why?: string) => void }>()

const kinds: Record<string, (code: unknown) => Setup> = {
	double: (code) => () => {
		log.push(["ran", code])
		return (code as number) * 2
	},
	note: (code) => () => {
		log.push(["ran", code])
		ensureNode("note", code)
	},
	refuse: () => {
		throw new Error("no native code here")
	},
	broken: () => () => {
		throw new Error("setup broke")
	},
}
const kind = (name: string) =>
	kinds[name] ?? (() => {
		throw new Error(`no kind ${name}`)
	})()

const path = (p: string) => p.split("/").filter((x) => x !== "")
const idOf = (p: string) => get(e.places, path(p))

serve((r: Request) => {
	switch (r.op) {
		case "node":
			e.within(() => ensureNode(r.path, r.value))
			return {}
		case "set":
			e.within(() => patch(r.path, [{ path: [], value: r.value }]))
			return {}
		case "loader":
			e.within(() => createLoader(r.path, kind(r.kind)))
			return {}
		case "interpreter": {
			const made = e.start(() => void createLoader(r.name, kind(r.kind)), r.at)
			if ("refused" in made) throw new Error("taken")
			kept.set(r.at, made)
			return {}
		}
		case "run": {
			const out = e.within(() => run(r.loader, r.program, r.at))
			if ("refused" in out) return out
			kept.set(r.at, out)
			return { at: out.process.at }
		}
		case "stop":
			kept.get(r.at)!.stop()
			return {}
		case "pulse":
			e.within(() => pulse())
			return {}
		case "read":
			try {
				return { value: e.within(() => read(r.path)) ?? null }
			} catch (x) {
				if (x === PENDING) return { pending: true }
				throw x
			}
		case "has":
			return { has: e.within(() => hasNode(r.path)) }
		case "status":
			return { state: e.within(() => getStatus(r.path as never))?.state ?? null }
		case "log":
			return { log }
		case "call": {
			const call = e.records.call(idOf(r.loader)!)
			if (call === undefined) return { end: null, readsProgram: false }
			const program = idOf(r.program)
			return {
				end: call.end,
				...call.error !== undefined && { error: (call.error as Error).message },
				readsProgram: call.reads.some((x) => (x as { id: string }).id === program),
			}
		}
	}
	return { error: `unknown op ${r.op}` }
})
