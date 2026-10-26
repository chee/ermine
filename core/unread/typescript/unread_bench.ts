// deno run core/unread/typescript/unread_bench.ts [name…]
// µs per write, fastest of 31 rounds (the machine may be busy): node's update copying on write
// ("copy"), in place (op's apply with cow: false: "in place"), and unread.
// a burst: writes with no read between; read between: unread is told of a read before each write
import createEntry, { type ChangeHeader, type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import apply, { type Patch } from "@ermine/core/op/apply"
import { createPlaces, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable } from "@ermine/core/table"
import { createUnread, keeping, reading } from "./unread.ts"

const only = Deno.args
const h: ChangeHeader = { time: 1, actor: "bench" }

// in place, as op's apply does with cow: false: the value changed where it is, the change made
// as node's update makes it
function inPlace(e: Entry<unknown>, ps: Patch[], change: ChangeHeader) {
	const undo: Patch[] = []
	const after = apply(e.value, ps, { undo, cow: false })
	if (after === undefined) delete e.value
	else e.value = after
	e.change = { ...change, op: { patches: ps, undo } }
}

function fastest(f: () => void, calls: number): number {
	for (let i = 0; i < calls; i++) f()
	const times: number[] = []
	for (let r = 0; r < 31; r++) {
		const t0 = performance.now()
		for (let i = 0; i < calls; i++) f()
		times.push((performance.now() - t0) * 1000 / calls)
	}
	return Math.min(...times)
}
function row(name: string, ways: Record<string, () => () => void>, calls: number) {
	if (only.length && !only.some((o) => name.includes(o))) return
	const cols = Object.entries(ways).map(([way, make]) =>
		`${way} ${fastest(make(), calls).toFixed(2)}`
	)
	console.log(`${name}\t${cols.join("\t")} µs`)
}

// three ways to write an entry made by start; patch(i): the i-th write
function ways(start: () => unknown, patch: (i: number) => Patch[], read = false) {
	const out: Record<string, () => () => void> = {
		copy: () => {
			const e = createEntry(start(), h)
			let i = 0
			return () => update(e, patch(i++), h)
		},
		"in place": () => {
			const e = createEntry<unknown>(start(), h)
			let i = 0
			return () => inPlace(e, patch(i++), h)
		},
		unread: () => {
			const u = createUnread()
			const e = createEntry(start(), h) as Entry<unknown>
			let i = 0
			return () => {
				if (read) u.read(e)
				u.update(e, patch(i++), h)
			}
		},
	}
	// in place changes what a reader holds: not a way when there are readers
	if (read) delete out["in place"]
	return out
}

const folder = (n: number) => () => ({
	...Object.fromEntries(Array.from({ length: n }, (_, i) => [`name${i}`, `id${i}`])),
})
const rename = (i: number): Patch[] => [{ path: [`name${i % 1000}`], value: `id${i}` }]
row("a name in a folder of 1000, a burst", ways(folder(1000), rename), 1000)
row("a name in a folder of 1000, read between", ways(folder(1000), rename, true), 1000)
row("a name in a folder of 30k, a burst", ways(folder(30000), rename), 20)

const doc = () => ({
	theme: { accent: "lemon", font: "chicago" },
	n: 0,
	...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, `field ${i}`])),
})
const field = (i: number): Patch[] => [{ path: ["n"], value: i }]
row("a field of a 52-field doc, a burst", ways(doc, field), 10000)
row("a field of a 52-field doc, read between", ways(doc, field, true), 10000)

const items = () => ({
	items: Array.from({ length: 1000 }, (_, i) => ({ id: i, text: `item ${i}`, done: false })),
})
const done = (i: number): Patch[] => [{ path: ["items", i % 1000, "done"], value: i % 2 === 0 }]
row("an item's field in a list of 1000, a burst", ways(items, done), 10000)
row("an item's field in a list of 1000, read between", ways(items, done, true), 10000)

// a deep path: six maps down
const deep = () => ({ a: { b: { c: { d: { e: { f: { n: 0 } } } } } }, side: { x: 1 } })
const deepField = (i: number): Patch[] => [{ path: ["a", "b", "c", "d", "e", "f", "n"], value: i }]
row("a field six maps down, a burst", ways(deep, deepField), 10000)
row("a field six maps down, read between", ways(deep, deepField, true), 10000)

// five fields in one write
const five = (i: number): Patch[] =>
	[0, 1, 2, 3, 4].map((k) => ({ path: [`f${k * 10}`], value: `${i}` }))
row("five fields of a 52-field doc in one write, a burst", ways(doc, five), 10000)

// a list growing at its end
const list = () => ({ list: Array.from({ length: 10000 }, (_, i) => i) })
const append = (
	i: number,
): Patch[] => [{ path: ["list"], range: [10000 + i, 10000 + i], value: [i] }]
row("append to a list of 10k, a burst", ways(list, append), 2000)
row("append to a list of 10k, read between", ways(list, append, true), 2000)

// typing into a long string: a string never changes in place, so all three alike
const text = () => ({ body: "x".repeat(10000) })
const type = (i: number): Patch[] => [{ path: ["body"], range: [5000, 5000], value: "a" }]
row("typing into a 10k string, a burst", ways(text, type), 2000)

// one number of a typed array
const floats = () => ({ samples: new Float64Array(10000) })
const sample = (i: number): Patch[] => [
	{ path: ["samples"], range: [i % 10000, i % 10000 + 1], value: new Float64Array([i]) },
]
row("one sample of a 10k Float64Array, a burst", ways(floats, sample), 2000)
row("one sample of a 10k Float64Array, read between", ways(floats, sample, true), 2000)

// a first write to each of many entries: what an entry's first write costs
{
	const name = "a first write to each of 10k entries"
	if (!only.length || only.some((o) => name.includes(o))) {
		const docs = () => Array.from({ length: 10000 }, () => createEntry<unknown>(doc(), h))
		const cols = (["copy", "unread"] as const).map((way) => {
			let best = Infinity
			for (let r = 0; r < 11; r++) {
				const es = docs(), u = createUnread()
				const t0 = performance.now()
				for (const e of es) {
					if (way === "copy") update(e, field(1), h)
					else u.update(e, field(1), h)
				}
				best = Math.min(best, (performance.now() - t0) * 1000 / es.length)
			}
			return `${way} ${best.toFixed(2)}`
		})
		console.log(`${name}\t${cols.join("\t")} µs`)
	}
}

// kept: what a computation's result costs to let go, by its size: walked whole, or handed (what
// the run was given: the walk stops there)
{
	const u = createUnread()
	const sized: [string, () => unknown][] = [
		["a 52-field doc", doc],
		["a list of 1000 items", () => items().items],
		["a folder of 30k names", folder(30000)],
	]
	for (const [what, make] of sized) {
		const name = `kept: ${what}`
		if (only.length && !only.some((o) => name.includes(o))) continue
		const v = make(), handed = new Set([v]), calls = what.includes("30k") ? 20 : 1000
		const whole = fastest(() => u.kept(v), calls), stops = fastest(() => u.kept(v, handed), calls)
		console.log(`${name}\twhole ${whole.toFixed(2)}\thanded ${stops.toFixed(2)} µs`)
	}
}

// through places: a place into a folder of 1000 names, a reader of one name, a pulse after each
// write. unread's world gives places the table through reading: places' reads are reads
function world(way: "copy" | "in place" | "unread") {
	const u = createUnread()
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places: Places = createPlaces({
		root: "R",
		table: way === "unread" ? reading(table, u) : table,
		paths: createPaths(),
		scheduler: s,
	})
	const host = s.createRootScope({ actor: "host" })
	const header = s.runWithScope(host, () => createChangeHeader(s))
	table.sub("children", "F", createEntry(folder(1000)(), header) as never)
	const e = table.get("children", "F")! as Entry<unknown>
	s.runWithScope(
		s.createRootScope({ actor: "r" }),
		() => s.createComputer(() => places.readValue("children", "F", ["name0"]), () => {}),
	)
	s.pulse()
	let i = 0
	return () => {
		const ps = rename(++i)
		if (way === "unread") u.update(e, ps, header)
		else if (way === "in place") inPlace(e, ps, header)
		else update(e, ps, header)
		places.commit([e])
		s.pulse()
	}
}
row("places: a name in a folder of 1000 + pulse, a reader of name0", {
	copy: () => world("copy"),
	"in place": () => world("in place"),
	unread: () => world("unread"),
}, 1000)

// keeping's cost to the scheduler: a chain of 100 computes, one write at its head, µs per pulse.
// any run-end listener has every run keep its reads (onRunEnd's reads), so a plain listener is
// measured too
{
	const name = "scheduler: a chain of 100 computes, a pulse"
	if (!only.length || only.some((o) => name.includes(o))) {
		const chain = (listen: "none" | "listener" | "keeping") => {
			const s = createScheduler()
			const u = createUnread()
			if (listen === "listener") s.onRunEnd(() => {})
			if (listen === "keeping") keeping(s, u)
			const store = new Map<unknown, unknown>()
			const o = s.createRootScope({ actor: "bench" })
			let prev: unknown = "head"
			store.set(prev, { n: 0 })
			for (let i = 0; i < 100; i++) {
				const from = prev, key = { i }
				s.runWithScope(o, () =>
					s.createComputer(
						() => {
							s.track(from)
							return { n: (store.get(from) as { n: number }).n + 1 }
						},
						(v) => {
							store.set(key, v)
							s.mark([key], s.getRun())
						},
						undefined,
						key,
					))
				prev = key
			}
			s.pulse()
			let i = 0
			return () => {
				store.set("head", { n: ++i })
				s.mark(["head"])
				s.pulse()
			}
		}
		const cols = (["none", "listener", "keeping"] as const).map((l) =>
			`${l} ${fastest(chain(l), 200).toFixed(2)}`
		)
		console.log(`${name}\t${cols.join("\t")} µs`)
	}
}
