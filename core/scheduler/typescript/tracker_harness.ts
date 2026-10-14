// the tracker (tracker.ts) on the line protocol (conformance/typescript/harness.ts). A node's owner
// is its name. Another implementation joins by speaking this (HARNESS).
//
// { op: "begin" | "end", from }        → {}   begin in a run is an error
// { op: "track" | "add", from, to }    → {}
// { op: "untrack", from, to? }         → {}   no to: all of from's
// { op: "reads", of }                  → { names }   what of reads, in order
// { op: "readers", of }                → { names }   who reads of, in the order made
import { createTracker, type Node } from "./tracker.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"

const g = createTracker<string>()
const nodes = new Map<string, Node<string>>()
const node = (name: string) => {
	let n = nodes.get(name)
	if (n === undefined) nodes.set(name, n = g.node(name))
	return n
}

function answer(r: Request): Answer {
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
