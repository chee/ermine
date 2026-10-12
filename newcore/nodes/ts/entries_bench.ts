// deno bench newcore/nodes/ts/entries_bench.ts
// a node's info or children looked up by name: a Map against an array of [name, sides] entries,
// at 1, 3, 5, 8, 16, 64 and 1000 names. Each run looks up 100 names, stepping through every name
// and one that is not there; the names asked for are equal copies, not the stored strings
type Sides = { content: unknown; change: number }[]
type Entries = (readonly [string, Sides])[]

const few = ["title", "icon", "kind", "items", "on", "style", "size", "where"]
const names = (count: number) =>
	Array.from({ length: count }, (_, k) => k < few.length ? few[k] : `name${k}`)
const copy = (s: string) => [...s].join("")

const bench = (name: string, o: Omit<Deno.BenchDefinition, "fn" | "name">, fn: () => void) =>
	Deno.bench(name, { n: 200_000, warmup: 50_000, ...o }, fn)

let sink: unknown

for (const count of [1, 3, 5, 8, 16, 64, 1000]) {
	const stored = names(count)
	const entries: Entries = stored.map((k, i) => [k, [{ content: i, change: 1 }]])
	const map = new Map(entries)
	// every name, then one not there
	const asked = [...stored.map(copy), copy("missing")]
	const steps = asked.length
	let at = 0
	const group = `lookup ×100, ${count} names`
	const o = count === 1000 ? { n: 5_000, warmup: 1_000 } : {}

	// each loop written out, so no call site is shared between them
	bench("Map get", { group, baseline: true, ...o }, () => {
		let s = 0
		for (let k = 0; k < 100; k++) {
			const n = asked[at]
			at = at + 1 === steps ? 0 : at + 1
			s += map.get(n)?.length ?? 0
		}
		sink = s
	})
	bench("Map, walked as an iterable", { group, ...o }, () => {
		let s = 0
		for (let k = 0; k < 100; k++) {
			const n = asked[at]
			at = at + 1 === steps ? 0 : at + 1
			for (const [key, v] of map) {
				if (key === n) {
					s += v.length
					break
				}
			}
		}
		sink = s
	})
	bench("array, for by index", { group, ...o }, () => {
		let s = 0
		for (let k = 0; k < 100; k++) {
			const n = asked[at]
			at = at + 1 === steps ? 0 : at + 1
			for (let i = 0; i < entries.length; i++) {
				if (entries[i][0] === n) {
					s += entries[i][1].length
					break
				}
			}
		}
		sink = s
	})
	bench("array, for of", { group, ...o }, () => {
		let s = 0
		for (let k = 0; k < 100; k++) {
			const n = asked[at]
			at = at + 1 === steps ? 0 : at + 1
			for (const [key, v] of entries) {
				if (key === n) {
					s += v.length
					break
				}
			}
		}
		sink = s
	})
	bench("array, find", { group, ...o }, () => {
		let s = 0
		for (let k = 0; k < 100; k++) {
			const n = asked[at]
			at = at + 1 === steps ? 0 : at + 1
			s += entries.find((e) => e[0] === n)?.[1].length ?? 0
		}
		sink = s
	})

	// the array is kept as given; a Map is made from it
	bench(`new Map, ${count} names`, { group: "make", ...o }, () => {
		sink = new Map(entries)
	})
}

addEventListener("unload", () => void sink)
