// places on what it is used for, timed by hand: every case is run ROUNDS times, round robin, and
// its median printed. with several modules given it runs itself on each, RUNS times, interleaved,
// so the machine's noise lands on all alike, and prints the median of each run's medians against
// the first module, with the spread of those medians as noise
//
//   deno run --allow-read --allow-run --allow-env core/places/typescript/places_bench.ts
//   deno run --allow-read --allow-run --allow-env core/places/typescript/places_bench.ts ./places.ts ./optim/places-final.ts
//
// the world: a deep chain (8 names), a wide folder (5000 names), a fan (3 entries at a name, 4
// deep: 81 items), a shallow name; nodes in a map per source, the hole as a scheduler would have it
import createEntry, { type ChangeHeader, type Entry } from "@ermine/node/entry"
import type { createPlaces as create } from "./places.ts"

const ROUNDS = 15
const WARMUP = 3
const RUNS = Number(Deno.env.get("RUNS") ?? 5)
const here = new URL(".", import.meta.url).pathname

// several modules: this script on each, interleaved
if (Deno.args.length > 1) {
	const versions = Deno.args
	const results = new Map<string, Record<string, number>[]>(versions.map((v) => [v, []]))
	for (let run = 0; run < RUNS; run++) {
		for (const v of versions) {
			const cmd = new Deno.Command(Deno.execPath(), {
				args: ["run", "--allow-read", "--allow-env", `${here}places_bench.ts`, v],
				stdout: "piped",
				stderr: "inherit",
				env: { JSON: "1" },
			})
			const out = await cmd.output()
			results.get(v)!.push(JSON.parse(new TextDecoder().decode(out.stdout).trim()))
		}
	}
	const median = (xs: number[]) => {
		const s = [...xs].sort((a, b) => a - b)
		return s[s.length >> 1]
	}
	const show = (v: string) =>
		v.replace(/^\.\.?\//, "").replace(/\.ts$/, "").replace(/^optim\//, "")
	const cases = Object.keys(results.get(versions[0])![0])
	const base: Record<string, number> = {}
	console.log(
		`${RUNS} runs × ${ROUNDS} rounds; µs per rep, median; ×: vs ${show(versions[0])}; ±: noise`,
	)
	console.log(["case", ...versions.map(show)].join("\t"))
	for (const c of cases) {
		const row = [c]
		for (const v of versions) {
			const xs = results.get(v)!.map((r) => r[c])
			const m = median(xs)
			if (v === versions[0]) base[c] = m
			const noise = (Math.max(...xs) - Math.min(...xs)) / m
			const n = m >= 1000
				? `${(m / 1000).toFixed(1)}ms`
				: m >= 10
				? `${m.toFixed(1)}µs`
				: `${m.toFixed(2)}µs`
			row.push(`${n} ${(m / base[c]).toFixed(2)}× ±${(noise * 100).toFixed(0)}%`)
		}
		console.log(row.join("\t"))
	}
	Deno.exit(0)
}

const mod = await import(new URL(Deno.args[0] ?? "./places.ts", import.meta.url).href)
const createPlaces: typeof create = mod.createPlaces

type Key = string | symbol
const h: ChangeHeader = { time: 1, actor: "me" }
const world = new Map<Key, Map<Key, Entry<unknown>>>()
const children = (source: Key, id: Key) => world.get(source)?.get(id)
function kids(id: string, value: Record<string, unknown>) {
	let ids = world.get("s")
	if (!ids) world.set("s", ids = new Map())
	const n = createEntry<unknown>(value, h)
	ids.set(id, n)
	return n
}
const entry = (id: string) => ["s", id]

const DEPTH = 8
const DEEP = Array.from({ length: DEPTH }, (_, i) => `deep-${i}`)
const WIDTH = 5000
const WIDE = Array.from({ length: WIDTH }, (_, i) => `wide-${i}`)

const root: Record<string, unknown> = { a: [entry("A")], wide: [entry("W")], fan: [entry("F")] }
root[DEEP[0]] = [entry("D0")]
kids("R", root)
kids("A", { b: [entry("B")] })
for (let i = 1; i < DEPTH; i++) kids(`D${i - 1}`, { [DEEP[i]]: [entry(`D${i}`)] })
kids(`D${DEPTH - 1}`, { leaf: [entry("L")] })
kids("W", Object.fromEntries(WIDE.map((name, i) => [name, [entry(`W${i}`)]])))
// a fan: x has 3 entries, in each of F, F0, F1, F2 and so on 4 deep
const fan = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { x: ids.map(entry) }]))
kids("F", { x: ["F0", "F1", "F2"].map(entry) })
for (const [id, v] of Object.entries(fan(["F0", "F1", "F2"]))) kids(id, v)
const FAN = ["fan", "x", "x", "x", "x"]

let sink = 0
let reads = 0
// one places telling reads, one not: both over the same world
const quiet = createPlaces({ root: ["s", "R"], children })
const told = createPlaces({ root: ["s", "R"], children, read: () => void reads++ })
const [deepItem] = quiet.get(DEEP)
const R = ["s", "R"] as const, W = ["s", "W"] as const, A = ["s", "A"] as const

// a node with n entries under t (and u for moves across names), fresh before each write; A, the
// other parent moved into, fresh too
function small() {
	kids("A", { b: [entry("B")] })
	return kids("X", { t: [entry("1"), entry("2"), entry("3")], u: [entry("4")] })
}
const large = () =>
	kids("X", { t: Array.from({ length: 2000 }, (_, i) => entry(`e${i}`)), u: [entry("4")] })
const X = ["s", "X"] as const

// opened places sharing a beginning: wide-0 .. wide-999 under wide, from the places told of reads
const MANY = 1000
const many = Array.from({ length: MANY }, (_, i) => told.open(["wide", WIDE[i]]))
const all = () => {
	for (let i = 0; i < MANY; i++) sink += many[i].items().length
}
const one = quiet.open(DEEP)
const oneTold = told.open(DEEP)

// name, reps per timing, what to do before each rep (not timed), the work
type Case = [string, number, (() => void) | null, () => void]
const CASES: Case[] = [
	["get shallow", 20000, null, () => void (sink += quiet.get(["a"]).length)],
	["get shallow, read", 20000, null, () => void (sink += told.get(["a"]).length)],
	["get deep", 5000, null, () => void (sink += quiet.get(DEEP).length)],
	["get deep, read", 5000, null, () => void (sink += told.get(DEEP).length)],
	[
		"get deep from item, ..",
		5000,
		null,
		() => void (sink += quiet.get(["..", "leaf"], deepItem).length),
	],
	["get dots", 10000, null, () => void (sink += quiet.get(["a", ".", "..", "a", "b"]).length)],
	["get wide name", 20000, null, () => void (sink += quiet.get(["wide", WIDE[2500]]).length)],
	["get fan (81 items)", 1000, null, () => void (sink += quiet.get(FAN).length)],
	["get missing", 20000, null, () => void (sink += quiet.get(["nope"]).length)],
	[
		"lookup from deep, missing",
		2000,
		null,
		() => void (sink += quiet.lookup(["nope"], deepItem).length),
	],
	[
		"lookup from deep, at root",
		2000,
		null,
		() => void (sink += quiet.lookup(["a"], deepItem).length),
	],
	[
		"lookup from deep, all",
		2000,
		null,
		() => void (sink += quiet.lookup(["leaf"], deepItem, true).length),
	],
	["names wide", 20, null, () => void (sink += quiet.names(W).length)],
	["open + drop deep", 5000, null, () => {
		const o = quiet.open(DEEP)
		sink += o.items().length
		o.drop()
	}],
	["items same, deep", 20000, null, () => void (sink += one.items().length)],
	["items same, deep, read", 20000, null, () => void (sink += oneTold.items().length)],
	["items same, 1000 shared", 10, null, all],
	["items after unrelated change, 1000 shared", 10, () => {
		told.place([R, "other"], ["s", "O"], h)
		told.unplace([R, "other"], 0, h)
	}, all],
	["items after rename above, 1000 shared", 10, () => {
		told.rename([R, "wide"], "gone", h)
		all()
		told.rename([R, "gone"], "wide", h)
	}, all],
	["place small", 2000, small, () => told.place([X, "t"], entry("9") as [Key, Key], h)],
	["place large", 500, large, () => told.place([X, "t"], entry("9") as [Key, Key], h, 1000)],
	["unplace small", 2000, small, () => told.unplace([X, "t"], 1, h)],
	["unplace large", 500, large, () => told.unplace([X, "t"], 1000, h)],
	["order small", 2000, small, () => told.order([X, "t"], 0, 2, h)],
	["order large", 500, large, () => told.order([X, "t"], 0, 1999, h)],
	["rename small", 2000, small, () => told.rename([X, "t"], "v", h)],
	["rename large", 500, large, () => told.rename([X, "t"], "v", h)],
	["move small", 2000, small, () => told.move([X, "t"], 0, [X, "u"], h)],
	["move large", 500, large, () => told.move([X, "t"], 0, [X, "u"], h)],
	["move small, other parent", 2000, small, () => told.move([X, "t"], 0, [A, "u"], h)],
]

const times = new Map<string, number[]>(CASES.map(([name]) => [name, []]))
for (let r = 0; r < WARMUP + ROUNDS; r++) {
	for (const [name, reps, before, f] of CASES) {
		let t = 0
		if (before === null) {
			const t0 = performance.now()
			for (let i = 0; i < reps; i++) f()
			t = performance.now() - t0
		} else {
			for (let i = 0; i < reps; i++) {
				before()
				const t0 = performance.now()
				f()
				t += performance.now() - t0
			}
		}
		if (r >= WARMUP) times.get(name)!.push(t / reps)
	}
}
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b)
	return s[s.length >> 1]
}
const out: Record<string, number> = {}
for (const [name, xs] of times) out[name] = median(xs) * 1000 // µs
if (Deno.env.get("JSON")) console.log(JSON.stringify(out))
else {
	for (const [name, us] of Object.entries(out)) {
		console.log(
			`${name.padEnd(44)} ${us >= 1000 ? `${(us / 1000).toFixed(2)}ms` : `${us.toFixed(2)}µs`}`,
		)
	}
}
if (sink === -1 || reads === -1) console.log(sink, reads)
