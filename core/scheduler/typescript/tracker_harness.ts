// the tracker (tracker.ts) on the line protocol (conformance/typescript/harness.ts). A node's owner
// is its name. Another implementation joins by speaking this (HARNESS).
//
// { op: "begin" | "end", from }        → {}   begin in a run is an error
// { op: "track" | "add", from, to }    → {}
// { op: "untrack", from, to? }         → {}   no to: all of from's
// { op: "reads", of }                  → { names }   what of reads, in order
// { op: "readers", of }                → { names }   who reads of, in the order made
//
// names: any string, compared whole (NUL, lone surrogates, __proto__ are names like any). a name
// not seen before is a node with no links. fields a request does not use are not read.
// answers: exactly these fields, nothing else. a write answers {}.
// errors: { error: text }, the text free (not compared); the request changes nothing and the
// next line goes on. begin in a run, add in a run ("use track"), an op not listed (case counts).
// a link: one edge from → to. a reader may hold two links to one spot; reads and readers list
// every link, so a duplicate shows twice. readers: one name per link.
// a run: begin(from) ... end(from), one per node at a time; runs of different nodes nest or
// interleave freely and end in any order, each with its own cursor. begin puts the cursor
// before from's first link.
// track(from, to) in from's run, in turn (the first that holds):
//   the link under the cursor is to: nothing
//   the link after the cursor (the first link, with no cursor) is to: the cursor moves onto it
//     (confirmed: it keeps its place among to's readers)
//   to's last reader is a link of from's made or confirmed in this run: nothing
//   else a new link right after the cursor (at the front with no cursor), last among to's
//     readers; the cursor moves onto it
// end(from): every link after the cursor (all of them with no cursor) is dropped, from from's
//   reads and its spots' readers. outside a run: nothing.
// add(from, to), outside a run: nothing if any link of from's goes to to; else a new link at the
//   end of from's reads (outside a run the cursor is the last link), last among to's readers
// untrack(from, to): every link of from's to to, duplicates too; the cursor, if on one, steps
//   back to the link before. in a run the run goes on. untrack(from): all of from's, the cursor
//   back to none, so a run's later tracks start from the front.
// readers keep the order made: a link dropped leaves the others' order; a new link goes last.
// not in the suite: track outside a run; a request missing from, to or of, or one with a name
// that is not a string (the C harness stops on some of these).
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
