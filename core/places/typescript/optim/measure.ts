// trie_bench.ts's cases (and a few more) on one version, timed by hand: every case is run
// ROUNDS times, round robin, and its median is printed as json. compare.ts runs this for each
// version, several times, interleaved, so the machine's noise lands on all of them alike
//
//   deno run --allow-read core/places/typescript/optim/measure.ts ../trie.ts

import type { createTrie as create } from "../trie.ts"

const ROUNDS = 20
const WARMUP = 3

function rand(seed: number) {
	let x = seed * 2654435761 >>> 0 || 1
	return (n: number) => {
		x ^= x << 13
		x ^= x >>> 17
		x ^= x << 5
		return (x >>> 0) % n
	}
}

// 20k paths, 2 to 6 names deep, from 40 names, as in trie_bench.ts
const pick = rand(7)
const WORDS = Array.from({ length: 40 }, (_, i) => `name-${i}`)
const PATHS = Array.from(
	{ length: 20_000 },
	() => Array.from({ length: 2 + pick(5) }, () => WORDS[pick(WORDS.length)]),
)
// the same paths as fresh strings: what a path from outside looks like
const FRESH = PATHS.map((p) => p.join("\0").split("\0"))
const TOP = WORDS[3]
// 5k distinct names: a wide folder
const WIDE = Array.from({ length: 5000 }, (_, i) => [`wide-${i}`])
// one 300-deep path
const DEEP = Array.from({ length: 300 }, (_, i) => `deep-${i}`)

const mod = await import(new URL(Deno.args[0], import.meta.url).href)
const createTrie: typeof create = mod.createTrie

const built = createTrie<number>()
PATHS.forEach((p, i) => built.make(p).value = i)
const ENTRIES = PATHS.map((p) => built.at(p)!)
const base = built.make(["base"])
for (const w of WIDE) built.make(w, base)
let sink = 0

// name, times to run per timing, the work
const CASES: [string, number, () => void][] = [
	["make", 1, () => {
		const t = createTrie<number>()
		for (let i = 0; i < PATHS.length; i++) t.make(PATHS[i]).value = i
		sink += t.size()
	}],
	["remake", 1, () => {
		for (let i = 0; i < PATHS.length; i++) sink += built.make(PATHS[i]).value!
	}],
	["find", 1, () => {
		for (let i = 0; i < PATHS.length; i++) sink += built.at(PATHS[i])!.value!
	}],
	["find-fresh", 1, () => {
		for (let i = 0; i < FRESH.length; i++) sink += built.at(FRESH[i])!.value!
	}],
	["step", 2, () => {
		for (let i = 0; i < ENTRIES.length; i++) sink += built.at([WORDS[0]], ENTRIES[i]) ? 1 : 0
	}],
	["subtree", 20, () => {
		built.each(built.at([TOP])!, () => void sink++)
	}],
	["up", 2, () => {
		for (let i = 0; i < ENTRIES.length; i++) {
			for (let e = ENTRIES[i].parent; e !== null; e = e.parent) sink++
		}
	}],
	["path", 1, () => {
		for (let i = 0; i < ENTRIES.length; i++) sink += built.path(ENTRIES[i]).length
	}],
	["drop", 4, () => {
		const t = createTrie<number>()
		for (let i = 0; i < 2000; i++) t.make(PATHS[i])
		t.drop(t.at([TOP]) ?? t.make([TOP]))
		sink += t.size()
	}],
	["prune", 4, () => {
		const t = createTrie<number>()
		const es = []
		for (let i = 0; i < 2000; i++) es.push(t.make(PATHS[i]))
		for (let i = 0; i < 2000; i++) t.prune(es[i])
		sink += t.size()
	}],
	["wide-make", 2, () => {
		const t = createTrie<number>()
		const b = t.make(["base"])
		for (let i = 0; i < WIDE.length; i++) t.make(WIDE[i], b)
		sink += t.size()
	}],
	["wide-find", 4, () => {
		for (let i = 0; i < WIDE.length; i++) sink += built.at(WIDE[i], base) ? 1 : 0
	}],
	["deep-make", 20, () => {
		const t = createTrie<number>()
		t.make(DEEP)
		sink += t.size()
	}],
]

const times = new Map<string, number[]>(CASES.map(([name]) => [name, []]))
for (let r = 0; r < WARMUP + ROUNDS; r++) {
	for (const [name, reps, f] of CASES) {
		const t0 = performance.now()
		for (let i = 0; i < reps; i++) f()
		const t = (performance.now() - t0) / reps
		if (r >= WARMUP) times.get(name)!.push(t)
	}
}
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b)
	return s[s.length >> 1]
}
const out: Record<string, number> = {}
for (const [name, xs] of times) out[name] = median(xs) * 1000 // µs
console.log(JSON.stringify(out))
if (sink === -1) console.log(sink)
