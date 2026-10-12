// deno bench newcore/nodes/ts/change_shape_bench.ts
// whether a class would help a change: made by spread (now), as a literal with every field, and as
// a class; then read back, the way notify and records read them, from headers of mixed shapes
import createChange, { type Change, type Header } from "./change.ts"

const bench = (name: string, o: Omit<Deno.BenchDefinition, "fn" | "name">, fn: () => void) =>
	Deno.bench(name, { n: 200_000, warmup: 50_000, ...o }, fn)

// the headers the graph makes: the host's, a process's, a process's with a cause, with a site
const site = { file: "x.ts", line: 4, column: 2, function: "main" }
const headers: Header[] = [
	{ actor: "host", time: 1 },
	{ actor: { actor: "host", code: [] }, reader: "@3", time: 2 },
	{ actor: { actor: "host", code: [] }, reader: "@3", cause: "a new map", time: 3 },
	{ actor: "host", site, time: 4 },
]

class ChangeClass {
	time: number
	actor: unknown
	reader: string | undefined
	site: Header["site"]
	cause: unknown
	node: string
	constructor(node: string, h: Header) {
		this.time = h.time
		this.actor = h.actor
		this.reader = h.reader
		this.site = h.site
		this.cause = h.cause
		this.node = node
	}
}
const literal = (node: string, h: Header) => ({
	time: h.time,
	actor: h.actor,
	reader: h.reader,
	site: h.site,
	cause: h.cause,
	node,
})

let i = 0
const make = "make, mixed headers"
bench("spread (createChange, now)", { group: make, baseline: true }, () => {
	createChange("a", headers[i++ & 3])
})
bench("literal, every field", { group: make }, () => {
	literal("a", headers[i++ & 3])
})
bench("class", { group: make }, () => {
	new ChangeClass("a", headers[i++ & 3])
})

// reading: 1000 changes of the four shapes, each read for its time and reader
const spread: Change[] = Array.from({ length: 1000 }, (_, k) => createChange("a", headers[k & 3]))
const literals = Array.from({ length: 1000 }, (_, k) => literal("a", headers[k & 3]))
const classes = Array.from({ length: 1000 }, (_, k) => new ChangeClass("a", headers[k & 3]))
let sink = 0
const read = "read time and reader of 1000"
bench("spread (four shapes)", { group: read, baseline: true, n: 20_000, warmup: 5_000 }, () => {
	for (const c of spread) sink += c.time + (c.reader === undefined ? 0 : 1)
})
bench("literal (one shape)", { group: read, n: 20_000, warmup: 5_000 }, () => {
	for (const c of literals) sink += c.time + (c.reader === undefined ? 0 : 1)
})
bench("class (one shape)", { group: read, n: 20_000, warmup: 5_000 }, () => {
	for (const c of classes) sink += c.time + (c.reader === undefined ? 0 : 1)
})
