// deno bench newcore/graph/ts/read_bench.ts
// a read as the scheduler makes one: places' walk alone, then said to depend, then the graph's
// (protect's guard), then tracked; cd's trail against a walk from the root. and ways to key a spot
import { createGraph } from "./graph.ts"
import type { Depend, Part } from "./places.ts"
import createNode from "../../nodes/ts/node.ts"

// fixed counts: the first benches otherwise run during warmup
const bench = (name: string, o: Omit<Deno.BenchDefinition, "fn" | "name">, fn: () => void) =>
	Deno.bench(name, { n: 200_000, warmup: 50_000, ...o }, fn)

// root/s/1..64, as the benchmarks' signals; and root/a/b/c/d/x, a deep place
const g = createGraph<{ id: string }>({ root: createNode("root", {}) })
const who = { actor: "host" }
const put = (parent: string, name: string, value: unknown) => {
	const id = g.make(undefined, value, who)
	g.changing(who, {}, () => g.places.insert(parent, name, id))
	return id
}
const s = put("root", "s", null)
for (let i = 1; i <= 64; i++) put(s, String(i), i)
let at = "root"
for (const name of ["a", "b", "c", "d"]) at = put(at, name, null)
put(at, "x", 1)

let said = 0
const counting: Depend = () => void said++
const address = ["/", "s", "33"]

// how many times one read is said to depend
said = 0
g.places.content([], address, counting)
const perRead = said

const group = "read /s/33"
bench("places: walk, no depend", { group, baseline: true }, () => {
	g.places.content([], address)
})
bench(`places: said to depend (${perRead} per read)`, { group }, () => {
	g.places.content([], address, counting)
})
const host = g.bound({ place: [], agent: "host", writes: false, alive: () => true })
bench("graph: untracked (protect's guard)", { group }, () => {
	host.content(address)
})
const reader = g.reader({ id: "p" })
const tracked = g.bound({
	place: [],
	agent: "host",
	writes: false,
	alive: () => true,
	depend: reader.depend,
})
reader.begin()
bench("graph: tracked, the same read again", { group }, () => {
	tracked.content(address)
})
bench("graph: tracked, a run of one read", { group }, () => {
	reader.begin()
	tracked.content(address)
	reader.end()
})

const deep = ["a", "b", "c", "d"]
const cdGroup = "read x at a/b/c/d"
bench("from the root each read", { group: cdGroup, baseline: true }, () => {
	g.places.content(deep, ["x"], counting)
})
const here = g.places.cd(deep, counting)
bench("cd once, then reads from its trail", { group: cdGroup }, () => {
	here.content(["x"], counting)
})
bench("cd each read", { group: cdGroup }, () => {
	g.places.cd(deep, counting).content(["x"], counting)
})

// a spot: found again by id and part on each depend. as graph.ts keys them now, and two others
const ids = Array.from({ length: 1000 }, (_, i) => `@${i}`)
const parts: Part[] = ["loaded", ["children", "s"], "value", ["info", "theme"]]
const partKey = (id: string, part: Part) =>
	`${id}\u0000${typeof part === "string" ? part : part.join("\u0000")}`

type Spot = { id: string; part: Part }
const byString = new Map<string, Spot>()
function stringKey(id: string, part: Part): Spot {
	const key = partKey(id, part)
	let sp = byString.get(key)
	if (!sp) byString.set(key, sp = { id, part })
	return sp
}

// per node: its loaded and value spots as fields; its lists' by name
type Spots = {
	loaded?: Spot
	value?: Spot
	names?: Spot
	children?: Map<string, Spot>
	info?: Map<string, Spot>
}
const byNode = new Map<string, Spots>()
function nodeKey(id: string, part: Part): Spot {
	let n = byNode.get(id)
	if (!n) byNode.set(id, n = {})
	if (part === "loaded") return n.loaded ??= { id, part }
	if (part === "value") return n.value ??= { id, part }
	if (part.length === 1) return n.names ??= { id, part }
	const m = part[0] === "children" ? (n.children ??= new Map()) : (n.info ??= new Map())
	let sp = m.get(part[1])
	if (!sp) m.set(part[1], sp = { id, part })
	return sp
}

// the same, its lists' spots by name in plain objects (no prototype)
type SpotsObj = {
	loaded?: Spot
	value?: Spot
	names?: Spot
	children?: Record<string, Spot>
	info?: Record<string, Spot>
}
const byNodeObj = new Map<string, SpotsObj>()
function objKey(id: string, part: Part): Spot {
	let n = byNodeObj.get(id)
	if (!n) byNodeObj.set(id, n = {})
	if (part === "loaded") return n.loaded ??= { id, part }
	if (part === "value") return n.value ??= { id, part }
	if (part.length === 1) return n.names ??= { id, part }
	const m = part[0] === "children"
		? (n.children ??= Object.create(null) as Record<string, Spot>)
		: (n.info ??= Object.create(null) as Record<string, Spot>)
	return m[part[1]] ??= { id, part }
}

// the same, its lists' spots by name in arrays, found by a scan: lists read by few names
type SpotsArr = {
	loaded?: Spot
	value?: Spot
	names?: Spot
	children?: Spot[]
	info?: Spot[]
}
const byNodeArr = new Map<string, SpotsArr>()
function arrKey(id: string, part: Part): Spot {
	let n = byNodeArr.get(id)
	if (!n) byNodeArr.set(id, n = {})
	if (part === "loaded") return n.loaded ??= { id, part }
	if (part === "value") return n.value ??= { id, part }
	if (part.length === 1) return n.names ??= { id, part }
	const m = part[0] === "children" ? (n.children ??= []) : (n.info ??= [])
	for (const sp of m) if (sp.part[1] === part[1]) return sp
	const sp = { id, part }
	m.push(sp)
	return sp
}

// the per node table in a plain object by id, not a map
const byNodeRec: Record<string, Spots> = Object.create(null)
function recKey(id: string, part: Part): Spot {
	const n = byNodeRec[id] ??= {}
	if (part === "loaded") return n.loaded ??= { id, part }
	if (part === "value") return n.value ??= { id, part }
	if (part.length === 1) return n.names ??= { id, part }
	const m = part[0] === "children" ? (n.children ??= new Map()) : (n.info ??= new Map())
	let sp = m.get(part[1])
	if (!sp) m.set(part[1], sp = { id, part })
	return sp
}

let k = 0
const keyGroup = "find a spot"
bench("string key, one map (before)", { group: keyGroup, baseline: true }, () => {
	stringKey(ids[k++ % 1000], parts[k & 3])
})
bench("map per node, fields and maps by name", { group: keyGroup }, () => {
	nodeKey(ids[k++ % 1000], parts[k & 3])
})
bench("map per node, lists' by name in objects", { group: keyGroup }, () => {
	objKey(ids[k++ % 1000], parts[k & 3])
})
bench("map per node, lists' by name in arrays", { group: keyGroup }, () => {
	arrKey(ids[k++ % 1000], parts[k & 3])
})
bench("object per node by id, maps by name", { group: keyGroup }, () => {
	recKey(ids[k++ % 1000], parts[k & 3])
})

// many names in one list: a node with 200 children, each read by name
const names = Array.from({ length: 200 }, (_, i) => ["children", `n${i}`] as const)
const wide = "find a spot: one node, 200 names"
bench("string key, one map (before)", { group: wide, baseline: true }, () => {
	stringKey("@w", names[k++ % 200])
})
bench("map per node, maps by name", { group: wide }, () => {
	nodeKey("@w", names[k++ % 200])
})
bench("map per node, objects by name", { group: wide }, () => {
	objKey("@w", names[k++ % 200])
})
bench("map per node, arrays by name", { group: wide }, () => {
	arrKey("@w", names[k++ % 200])
})
