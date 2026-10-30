// The tracker (tracker.ts) on the line protocol (conformance/typescript/harness.ts); HARNESS names
// another implementation that speaks it. A node's owner is its name; names are any string.
// { op: "begin" | "end" | "leave" | "trim" | "dedupe", from }  -> {}   begin in a run is an error
// { op: "track" | "add", from, to }                           -> {}   add in a run is an error
// { op: "untrack", from, to? }                                -> {}   no to: all of from's
// { op: "reads", of }                                         -> { names }  in order
// { op: "readers", of }                                       -> { names }  in the order made
// Errors are { error: text } (text is not compared) and change nothing. Reads and readers list
// every link, so a duplicate shows twice. tracker.ts and reactivity/conformance/tracker hold the
// rules for track, end, add and untrack.
import { createTracker, type Node } from "./tracker.ts"
import { type Answer, type Request, serve } from "../../conformance/typescript/harness.ts"

const g = createTracker<string>()
const nodes = new Map<string, Node<string>>()
const node = (name: string) => {
	let n = nodes.get(name)
	if (n === undefined) nodes.set(name, n = g.node(name))
	return n
}

const uses: Record<string, string[]> = {
	begin: ["from"],
	end: ["from"],
	leave: ["from"],
	trim: ["from"],
	dedupe: ["from"],
	track: ["from", "to"],
	add: ["from", "to"],
	untrack: ["from"],
	reads: ["of"],
	readers: ["of"],
}

function answer(r: Request): Answer {
	for (const k of uses[r.op] ?? []) if (r[k] === undefined) return { error: `no ${k}` }
	switch (r.op) {
		case "begin":
			g.begin(node(r.from))
			return {}
		case "track":
			g.track(node(r.from), node(r.to))
			return {}
		case "end":
			g.end(node(r.from))
			return {}
		case "leave":
			g.leave(node(r.from))
			return {}
		case "trim":
			g.trim(node(r.from))
			return {}
		case "dedupe":
			g.dedupe(node(r.from))
			return {}
		case "add":
			g.add(node(r.from), node(r.to))
			return {}
		case "untrack":
			g.untrack(node(r.from), r.to === undefined ? undefined : node(r.to))
			return {}
		case "reads":
			return { names: g.reads(node(r.of)).map((n) => n.owner) }
		case "readers":
			return { names: g.readers(node(r.of)).map((l) => l.from.owner) }
		default:
			return { error: `unknown op ${r.op}` }
	}
}

if (import.meta.main) await serve(answer)
