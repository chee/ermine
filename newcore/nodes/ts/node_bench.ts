// deno bench newcore/nodes/ts/node_bench.ts
// a node's info and children as new Map (now) against a plain object and a null-prototype object:
// made empty, made from entries, made from one given as is; then used the way places and graph use
// them (get, set, place and remove, keys)
// self-contained: node.ts's own types, copied, so the bench runs while node.ts is mid-change
type V = { content: unknown; change: number }
type L = { content: readonly (string | symbol)[]; change: number }

const bench = (name: string, o: Omit<Deno.BenchDefinition, "fn" | "name">, fn: () => void) =>
	Deno.bench(name, { n: 500_000, warmup: 100_000, ...o }, fn)

// the three shapes, made the way createNode makes a node; the outside site is left out, the same
// for all three
const map = (
	id: string,
	info?: Iterable<readonly [string, V[]]>,
	children?: Iterable<readonly [string, L[]]>,
) => ({
	id,
	value: [] as V[],
	info: new Map(info),
	children: new Map(children),
	changed: {},
})
const object = (
	id: string,
	info?: Iterable<readonly [string, V[]]>,
	children?: Iterable<readonly [string, L[]]>,
) => ({
	id,
	value: [] as V[],
	info: info ? Object.fromEntries(info) as Record<string, V[]> : {} as Record<string, V[]>,
	children: children
		? Object.fromEntries(children) as Record<string, L[]>
		: {} as Record<string, L[]>,
	changed: {},
})
const bare = <T>(entries?: Iterable<readonly [string, T]>) => {
	const o = Object.create(null) as Record<string, T>
	if (entries) { for (const [k, v] of entries) o[k] = v }
	return o
}
const nulled = (
	id: string,
	info?: Iterable<readonly [string, V[]]>,
	children?: Iterable<readonly [string, L[]]>,
) => ({
	id,
	value: [] as V[],
	info: bare(info),
	children: bare(children),
	changed: {},
})

let sink: unknown

// empty: no info, no children
const empty = "make, empty"
bench("new Map (now)", { group: empty, baseline: true }, () => {
	sink = map("a")
})
bench("object {}", { group: empty }, () => {
	sink = object("a")
})
bench("Object.create(null)", { group: empty }, () => {
	sink = nulled("a")
})

// from entries, as Contents takes them: 3 info, 2 children
const version = (content: unknown): V => ({ content, change: 1 })
const infos: [string, V[]][] = [["title", [version("t")]], ["icon", [version("i")]], ["kind", [
	version("k"),
]]]
const kids: [string, L[]][] = [["items", [{ content: ["x", "y"], change: 1 }]], ["on", [{
	content: [],
	change: 1,
}]]]
const entries = "make, 3 info + 2 children from entries"
bench("new Map(entries) (now)", { group: entries, baseline: true }, () => {
	sink = map("a", infos, kids)
})
bench("Object.fromEntries", { group: entries }, () => {
	sink = object("a", infos, kids)
})
bench("Object.create(null) + loop", { group: entries }, () => {
	sink = nulled("a", infos, kids)
})

// given as is: the caller's map or object kept, not copied
const infoMap = new Map(infos), kidsMap = new Map(kids)
const infoObject = Object.fromEntries(infos), kidsObject = Object.fromEntries(kids)
const given = "make, 3 info + 2 children given as is"
bench("Map kept", { group: given, baseline: true }, () => {
	sink = { id: "a", value: [], info: infoMap, children: kidsMap, changed: {} }
})
bench("object kept", { group: given }, () => {
	sink = { id: "a", value: [], info: infoObject, children: kidsObject, changed: {} }
})

// use: 1000 nodes of 8 children each, every name looked at once per run
const names = ["items", "on", "a", "b", "c", "d", "e", "f"]
const list = (k: number): L[] => [{ content: [`x${k}`], change: 1 }]
const filled = names.map((n, k) => [n, list(k)] as [string, L[]])
const maps = Array.from({ length: 1000 }, (_, k) => map(`n${k}`, undefined, filled))
const objects = Array.from({ length: 1000 }, (_, k) => object(`n${k}`, undefined, filled))
const nulls = Array.from({ length: 1000 }, (_, k) => nulled(`n${k}`, undefined, filled))
const use = { n: 20_000, warmup: 5_000 }

const get = "get: 8 names of 1000 nodes"
bench("Map", { group: get, baseline: true, ...use }, () => {
	let s = 0
	for (const n of maps) for (const k of names) s += n.children.get(k)?.[0]?.content?.length ?? 0
	sink = s
})
bench("object", { group: get, ...use }, () => {
	let s = 0
	for (const n of objects) for (const k of names) s += n.children[k]?.[0]?.content?.length ?? 0
	sink = s
})
bench("Object.create(null)", { group: get, ...use }, () => {
	let s = 0
	for (const n of nulls) for (const k of names) s += n.children[k]?.[0]?.content?.length ?? 0
	sink = s
})

const set = "set: one name, already there, of 1000 nodes"
const next = list(9)
bench("Map", { group: set, baseline: true, ...use }, () => {
	for (const n of maps) n.children.set("c", next)
})
bench("object", { group: set, ...use }, () => {
	for (const n of objects) n.children["c"] = next
})
bench("Object.create(null)", { group: set, ...use }, () => {
	for (const n of nulls) n.children["c"] = next
})

const keys = "keys: all 8 of 1000 nodes"
bench("Map .keys()", { group: keys, baseline: true, ...use }, () => {
	let s = 0
	for (const n of maps) for (const k of n.children.keys()) s += k.length
	sink = s
})
bench("object for in", { group: keys, ...use }, () => {
	let s = 0
	for (const n of objects) for (const k in n.children) s += k.length
	sink = s
})
bench("object Object.keys", { group: keys, ...use }, () => {
	let s = 0
	for (const n of objects) for (const k of Object.keys(n.children)) s += k.length
	sink = s
})
bench("Object.create(null) for in", { group: keys, ...use }, () => {
	let s = 0
	for (const n of nulls) for (const k in n.children) s += k.length
	sink = s
})

// place a new name and remove it again (places' insert and remove); objects go to dictionary
// mode on the first delete and stay there, so this group runs last, on its own nodes
const placeMaps = Array.from({ length: 1000 }, (_, k) => map(`n${k}`, undefined, filled))
const placeObjects = Array.from({ length: 1000 }, (_, k) => object(`n${k}`, undefined, filled))
const placeNulls = Array.from({ length: 1000 }, (_, k) => nulled(`n${k}`, undefined, filled))
const place = "place and remove: one name, 1000 nodes"
bench("Map set + delete", { group: place, baseline: true, ...use }, () => {
	for (const n of placeMaps) {
		n.children.set("new", next)
		n.children.delete("new")
	}
})
bench("object = + delete", { group: place, ...use }, () => {
	for (const n of placeObjects) {
		n.children["new"] = next
		delete n.children["new"]
	}
})
bench("Object.create(null) = + delete", { group: place, ...use }, () => {
	for (const n of placeNulls) {
		n.children["new"] = next
		delete n.children["new"]
	}
})

// after a delete, gets on the objects that went to dictionary mode
const after = "get after remove: 8 names of 1000 nodes"
bench("Map", { group: after, baseline: true, ...use }, () => {
	let s = 0
	for (const n of placeMaps) {
		for (const k of names) s += n.children.get(k)?.[0]?.content?.length ?? 0
	}
	sink = s
})
bench("object", { group: after, ...use }, () => {
	let s = 0
	for (const n of placeObjects) {
		for (const k of names) s += n.children[k]?.[0]?.content?.length ?? 0
	}
	sink = s
})
bench("Object.create(null)", { group: after, ...use }, () => {
	let s = 0
	for (const n of placeNulls) for (const k of names) s += n.children[k]?.[0]?.content?.length ?? 0
	sink = s
})

addEventListener("unload", () => void sink)
