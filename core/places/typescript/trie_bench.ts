// deno bench core/places/typescript/trie_bench.ts
// the trie against a flat Map keyed by the path joined (JSON, and names joined by a NUL, which a
// name could hold), on what places does: make, find, walk a subtree, walk up, drop a subtree
import { createTrie } from "./trie.ts"

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// 20k paths, 2 to 6 names deep, from 40 names: a folder tree with some sharing
const pick = rand(7)
const WORDS = Array.from({ length: 40 }, (_, i) => `name-${i}`)
const PATHS = Array.from(
	{ length: 20_000 },
	() => Array.from({ length: 2 + pick(5) }, () => WORDS[pick(WORDS.length)]),
)
const json = (p: readonly string[]) => JSON.stringify(p)
const nul = (p: readonly string[]) => p.join("\0")

const built = createTrie<number>()
PATHS.forEach((p, i) => built.make(p).value = i)
const byJson = new Map<string, number>(PATHS.map((p, i) => [json(p), i]))
const byNul = new Map<string, number>(PATHS.map((p, i) => [nul(p), i]))
const ENTRIES = PATHS.map((p) => built.at(p)!)
let sink = 0

Deno.bench("make 20k paths: trie", { group: "make", baseline: true }, () => {
	const t = createTrie<number>()
	for (let i = 0; i < PATHS.length; i++) t.make(PATHS[i]).value = i
	sink += t.root.kids?.size ?? 0
})
Deno.bench("make 20k paths: Map by JSON", { group: "make" }, () => {
	const m = new Map<string, number>()
	for (let i = 0; i < PATHS.length; i++) m.set(json(PATHS[i]), i)
	sink += m.size
})
Deno.bench("make 20k paths: Map by NUL join", { group: "make" }, () => {
	const m = new Map<string, number>()
	for (let i = 0; i < PATHS.length; i++) m.set(nul(PATHS[i]), i)
	sink += m.size
})

Deno.bench("find 20k paths: trie", { group: "find", baseline: true }, () => {
	for (let i = 0; i < PATHS.length; i++) sink += built.at(PATHS[i])!.value!
})
Deno.bench("find 20k paths: Map by JSON", { group: "find" }, () => {
	for (let i = 0; i < PATHS.length; i++) sink += byJson.get(json(PATHS[i]))!
})
Deno.bench("find 20k paths: Map by NUL join", { group: "find" }, () => {
	for (let i = 0; i < PATHS.length; i++) sink += byNul.get(nul(PATHS[i]))!
})

// one name down from a held entry: what walking from a place does
Deno.bench("one step down from 20k held places: trie", { group: "step", baseline: true }, () => {
	for (let i = 0; i < ENTRIES.length; i++) {
		sink += built.at([WORDS[0]], ENTRIES[i]) ? 1 : 0
	}
})
Deno.bench("one step down from 20k places: Map by NUL join", { group: "step" }, () => {
	for (let i = 0; i < PATHS.length; i++) {
		const p = PATHS[i]
		sink += byNul.has(nul([...p, WORDS[0]])) ? 1 : 0
	}
})

// everything under a first name: a subtree's places, as a rename above them needs
const TOP = WORDS[3]
Deno.bench("everything under one name: trie", { group: "subtree", baseline: true }, () => {
	built.each(built.at([TOP])!, () => void sink++)
})
Deno.bench("everything under one name: Map by NUL join, scanned", { group: "subtree" }, () => {
	const prefix = TOP + "\0"
	for (const k of byNul.keys()) if (k.startsWith(prefix)) sink++
})

Deno.bench("walk up to the root from 20k places: trie", { group: "up", baseline: true }, () => {
	for (let i = 0; i < ENTRIES.length; i++) {
		for (let e = ENTRIES[i].parent; e !== null; e = e.parent) sink++
	}
})
Deno.bench("walk up to the root from 20k places: Map by NUL join", { group: "up" }, () => {
	for (let i = 0; i < PATHS.length; i++) {
		const p = PATHS[i]
		for (let n = p.length - 1; n > 0; n--) sink += byNul.has(nul(p.slice(0, n))) ? 1 : 0
	}
})

Deno.bench("path of 20k entries: trie", { group: "path" }, () => {
	for (let i = 0; i < ENTRIES.length; i++) sink += built.path(ENTRIES[i]).length
})

// the drop alone: a tree of 2000 paths made before the clock starts
Deno.bench("drop a subtree: trie", { group: "drop", baseline: true }, (b) => {
	const t = createTrie<number>()
	for (let i = 0; i < 2000; i++) t.make(PATHS[i])
	const top = t.at([TOP]) ?? t.make([TOP])
	b.start()
	t.drop(top)
	b.end()
	sink += t.root.kids?.size ?? 0
})
Deno.bench("drop a subtree: Map by NUL join", { group: "drop" }, (b) => {
	const m = new Map<string, number>()
	for (let i = 0; i < 2000; i++) m.set(nul(PATHS[i]), i)
	const prefix = TOP + "\0"
	b.start()
	for (const k of [...m.keys()]) if (k === TOP || k.startsWith(prefix)) m.delete(k)
	b.end()
	sink += m.size
})

addEventListener("unload", () => sink === -1 && console.log(sink))
