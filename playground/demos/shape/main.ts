/// <reference lib="dom" />
// shape: one world, two pictures of it. left, places: the tree of names the host keeps, read
// through its api. right, the scheduler: what it holds itself (lib/shape.ts), read from its own
// state each draw: who waits on whom, in columns by rank; the keys each computer tracks and
// writes; who made whom.
//
// the world: a graph placed at /graph, shared by sync (@ermine/sync over Subduction): two inputs
// there; here, a chain of computes over them (sum → double → label), an effect drawing the label,
// and readers of a added and killed with the buttons. the processes are this page's own (their
// nodes have no ermine:// id, so sync keeps none of them): two pages on one graph each run their
// own, over the same inputs.
//
// the graph is the one the page's url names after # (an ermine:// id); none: a new one, its id put
// there. every node it reaches is followed as it is reached, so a graph opened from elsewhere comes
// in as it arrives.
//   ?server=wss://… another server (ws://localhost:… for a local subduction_cli), ?server=none none
//   ?service=… the server's service name, when it isn't its host (a local subduction_cli: ermine)
//
// save: what the graph reaches, packed (slaygrounds' save graph, a .ermine file). load: a .ermine
// file's nodes put in under new ids, so it is a new graph, opened
import { unpack } from "@ermine/encoding/pack"
import type { Entry } from "@ermine/node/entry"
import { createSigner } from "@ermine/sync/seal"
import { createSync, type Sync } from "@ermine/sync/sync"
import { save } from "../slaygrounds/src/graph-file.ts"
import {
	type ComputeGiven,
	type EffectGiven,
	idAt,
	make,
	type Node,
	put,
	set,
	tryLine,
	val,
} from "./lib/host.ts"
import { inspector } from "./lib/inspector.ts"
import { readShape, rootsOf, shapeView } from "./lib/shape.ts"

const $ = <T extends HTMLElement = HTMLElement>(q: string) => document.querySelector(q) as T
const ID = /ermine:\/\/[0-9a-f]{64}/
const PARTS = ["value", "attributes", "children"]

const search = new URLSearchParams(location.search)
const server = search.get("server") === "none"
	? undefined
	: search.get("server") ?? "wss://galaxy.observer"
const service = search.get("service") ?? undefined
// galaxy stores an id only when its last 16 bytes are zero (until Keyhive)
const zeros = server !== undefined && !/^wss?:\/\/(localhost|127\.)/.test(server)

// ---- the host, and sync beside its table ----
let sync: Sync | undefined
const s = make({
	tableChanged: (part, id) => (sync?.tableChanged(part, id), reach()),
	wrote: (changed) => (sync?.wrote(changed), reach()),
})
const w = s.world()
sync = createSync({
	table: w.table,
	signer: await createSigner(),
	zeros,
	// what comes in on the head shown: told as the host's writes are
	commit: (entries) => (w.places.commit(entries), soon()),
})
const device = sync.device
// what sync writes comes outside a round: one soon lets the computes see it
let due = false
const soon = () => {
	if (due) return
	due = true
	setTimeout(() => (due = false, w.scheduler.pulse()), 0)
}
device.arrived(() => (soon(), reach()))

// the graph shown at /graph, and every kept id it reaches followed, soon after any change
let graph = ""
let reaching = false
function reach() {
	if (reaching) return
	reaching = true
	setTimeout(() => {
		reaching = false
		const seen = new Set<string>(), todo = [graph]
		while (todo.length) {
			const id = todo.pop()!
			if (seen.has(id)) continue
			seen.add(id)
			if (ID.test(id)) sync!.follow(id).catch((e) => console.error("follow", id, e))
			const kids = w.table.get("children", id)?.value
			if (kids && typeof kids === "object") {
				for (const k of Object.values(kids)) if (typeof k === "string") todo.push(k)
			}
		}
	}, 0)
}

function open(id: string) {
	if (id === graph) return
	graph = id
	s.batch(() => {
		if (idAt(s, ["graph"]) !== undefined) s.remove("root", "graph")
		s.insert("root", "graph", id)
	})
	if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id)
	$<HTMLInputElement>("#url").value = id
	reach()
}

// a new graph: inputs a and b
function fresh(): string {
	const mint = sync!.mint
	const id = mint()
	s.batch(() => {
		s.create(null, { id })
		const inputs = put(s, id, "inputs", null, { id: mint() })
		put(s, inputs, "a", 1, { id: mint() })
		put(s, inputs, "b", 2, { id: mint() })
	})
	return id
}

put(s, "root", "calc", null)

// a chain: each reads the one before, by its place under calc
s.start({
	address: ["calc"],
	name: "sum",
	program: {
		compute: ({ api }: ComputeGiven) =>
			val<number>(api, ["..", "graph", "inputs", "a"]) + val<number>(api, ["..", "graph", "inputs", "b"]),
	},
})
s.start({
	address: ["calc"],
	name: "double",
	program: { compute: ({ api }: ComputeGiven) => 2 * val<number>(api, ["sum"]) },
})
s.start({
	address: ["calc"],
	name: "label",
	program: {
		compute: ({ api }: ComputeGiven) =>
			`a=${val(api, ["..", "graph", "inputs", "a"])}, 2(a+b)=${val(api, ["double"])}`,
		effect: (
			{ value }: EffectGiven,
		) => ($(".try").firstChild!.textContent = `${value} — pick a box on the right`),
	},
})

// readers of a, started and killed by hand
const readers: string[] = []
put(s, "root", "readers", null)
$("#more").onclick = () => {
	const n = readers.length + 1
	const { id } = s.start({
		address: ["readers"],
		name: `r${n}`,
		program: {
			compute: ({ api }: ComputeGiven) => `r${n} sees a=${val(api, ["..", "graph", "inputs", "a"])}`,
		},
	})
	readers.push(id)
}
$("#less").onclick = () => {
	const id = readers.pop()
	if (id) s.outro(id)
}
// a graph without inputs/a gets one
$("#bump").onclick = () => {
	const a = ["graph", "inputs", "a"]
	if (idAt(s, a) !== undefined) return set(s, a, (Number(val(s, a)) || 0) + 1)
	s.batch(() => {
		const inputs = idAt(s, a.slice(0, 2)) ?? put(s, graph, "inputs", null, { id: sync!.mint() })
		put(s, inputs, "a", 1, { id: sync!.mint() })
	})
}

document.querySelector(".try-more")!.innerHTML =
	`<b>two graphs, one world.</b> the left is places: names under names, what the host's api
	walks. the right is what the scheduler holds and nothing else: computers and scopes, the keys its
	tracker links them to, the writer of each key. <b>values</b>: an arrow from w to c when c's last
	run read a key w writes; columns are ranks, the order a round runs them in. <b>keys</b>: what each
	computer reads (blue) and writes (green); only a compute's mark counts as a write, so an effect's
	or the host's writes show no writer. <b>owners</b>: who made whom. keys are opaque to the
	scheduler: one shaped like a places spot is named by its node and part.
	<p><b>/graph</b> is shared: open this page's link in another window (or another machine) and
	both show one graph, each running its own processes over it. paste an ermine:// id or a link in
	the box to open another; <b>save</b> downloads the graph as a .ermine file, <b>load</b> opens
	one as a new graph.`
tryLine()

const ins = inspector(s, $("#places"), { moments: 0 }) // the explorer opens on its map
;(document.querySelector("#places .vtabs button:nth-child(2)") as HTMLElement)?.click()

const w = s.world()
const roots = rootsOf(w.scheduler, [w.scope])
const view = shapeView({
	read: (m) => readShape(roots.roots(), m, ins.nameOf),
	place: (id) => ins.show(id),
})
$("#shape").append(view.el)
// drawn when the clock moved, between rounds (never inside a hook)
let drawn = -1
const tick = () => {
	if (s.clock.time !== drawn) (drawn = s.clock.time, view.draw())
	requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
