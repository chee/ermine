// deno run --allow-read --allow-run newcore/notify/wasm/bench.ts
// The same twelve cases, three ways: notify.ts, notify.c as wasm (both timed by the same loop
// here, in V8), and notify.c native (its own bench, ../c/bench). patched() only, every time.
import { createNotify, type Patch } from "../../notify.ts"

const here = new URL(".", import.meta.url).pathname
const N = 10_000

// time f until it has taken a fifth of a second, at least 3 runs; ns per call of one
function time(f: (times: number) => void): number {
	f(1)
	let times = 1
	for (;;) {
		const start = performance.now()
		f(times)
		const took = performance.now() - start
		if (took > 200 && times >= 3) return (took * 1e6) / times
		times = took < 1 ? times * 10 : Math.ceil(times * Math.max(1.5, 220 / took))
	}
}

const names = [
	"insert first, no reads",
	"put a row's field, no reads",
	"10k plain: insert first, all fire",
	"10k plain: append, none fire",
	"10k plain: same-length put in the middle",
	"10k chased: insert first, all move",
	"10k chased: append, none move",
	"10k chased: move last to first",
	"10k row field reads: put one",
	"10k key reads: put a new key",
	"a caret in 100k chars: type before it",
	"100 carets: type at the start",
]

// notify.ts
function ts(): number[] {
	const items = Array.from({ length: N }, (_, i) => `e${i}`)
	const rows = Array.from({ length: N }, (_, i) => ({ id: `r${i}`, v: i }))
	const text = "x".repeat(100_000)
	const meta = Object.fromEntries(Array.from({ length: N }, (_, i) => [`k${i}`, i]))
	const content = { items, rows, text, meta }
	const first: Patch = { path: ["items"], range: [0, 0], value: ["t"] }
	const append: Patch = { path: ["items"], range: [N, N], value: ["t"] }
	const middle: Patch = { path: ["items"], range: [N / 2, N / 2 + 1], value: ["t"] }
	const field: Patch = { path: ["rows", 5000, "v"], value: 1 }
	const newkey: Patch = { path: ["meta", "new"], value: 1 }
	const typed: Patch = { path: ["text"], range: [49_999, 49_999], value: "a" }
	const typed0: Patch = { path: ["text"], range: [0, 0], value: "a" }
	const lastfirst: Patch = { path: ["items"], range: [0, 0], move: { path: ["items", N - 1] } }
	type Notify = ReturnType<typeof createNotify>
	const every = (chase: boolean) => (n: Notify) => {
		for (let i = 0; i < N; i++) n.read(["items", i], { chase }).on(() => {})
	}
	const none = () => {}
	const cases: [(n: Notify) => void, Patch][] = [
		[none, first],
		[none, field],
		[every(false), first],
		[every(false), append],
		[every(false), middle],
		[every(true), first],
		[every(true), append],
		[every(true), lastfirst],
		[(n) => {
			for (let i = 0; i < N; i++) n.read(["rows", i, "v"]).on(() => {})
		}, field],
		[(n) => {
			for (let i = 0; i < N; i++) n.read(["meta", `k${i}`]).on(() => {})
			n.read(["meta"]).on(() => {})
		}, newkey],
		[(n) => n.read(["text", [50_000, 50_000]], { chase: true }).on(() => {}), typed],
		[(n) => {
			for (let i = 0; i < 100; i++) n.read(["text", [i * 1000, i * 1000]], { chase: true }).on(() => {})
		}, typed0],
	]
	return cases.map(([reads, patch]) => {
		const n = createNotify(() => content)
		reads(n)
		return time((times) => {
			for (let k = 0; k < times; k++) n.patched(patch, content)
		})
	})
}

// notify.c, as wasm: nothing imported
async function wasm(): Promise<number[]> {
	const { instance } = await WebAssembly.instantiate(await Deno.readFile(`${here}notify.wasm`))
	const w = instance.exports as {
		init(): void
		cases(): number
		setup(i: number): void
		run(i: number, times: number): void
	}
	w.init()
	return Array.from({ length: w.cases() }, (_, i) => {
		w.setup(i)
		return time((times) => w.run(i, times))
	})
}

// notify.c, native: its bench prints its own lines, in the same order
async function native(): Promise<number[]> {
	const { stdout } = await new Deno.Command(`${here}../c/bench`).output()
	const unit: Record<string, number> = { ns: 1, us: 1e3, ms: 1e6 }
	return new TextDecoder().decode(stdout).trim().split("\n").map((l) => {
		const m = l.match(/([\d.]+) (ns|us|ms)\s*$/)!
		return Number(m[1]) * unit[m[2]]
	})
}

const show = (ns: number) =>
	ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(2)} µs` : `${ns.toFixed(0)} ns`

const t = ts(), w = await wasm()
// ../c/bench runs the move case last
const raw = await native()
const c = [...raw.slice(0, 7), raw[11], ...raw.slice(7, 11)]
console.log(`| case | notify.ts | wasm | native C | wasm ÷ native | ts ÷ wasm |`)
console.log(`|---|---|---|---|---|---|`)
names.forEach((name, i) => {
	console.log(
		`| ${name} | ${show(t[i])} | ${show(w[i])} | ${show(c[i])} | ${(w[i] / c[i]).toFixed(1)}× | ${(t[i] / w[i]).toFixed(1)}× |`,
	)
})
