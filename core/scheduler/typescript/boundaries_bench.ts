// deno run core/scheduler/typescript/boundaries_bench.ts [name…]
// boundaries over the scheduler: what they cost runs that end done, catching and letting go of many
// at once, one among many, and depth. medians of up to 21 rounds: µs per pulse, and per run where the
// pulse runs many. names given: only the shapes whose name holds one of them
import { createBoundaries } from "./boundaries.ts"
import { createScheduler, PENDING, type Scope } from "./scheduler.ts"

type Key = { name: string }

// with: boundaries over the scheduler; with a loading and an errored boundary at the root too
function world(with_: "none" | "boundaries" | "a boundary of each" = "a boundary of each") {
	const s = createScheduler()
	const store = new Map<Key, unknown>()
	const root = s.createRootScope([["actor", "bench"]])
	const key = (name: string): Key => ({ name })
	const read = <T>(k: Key) => (s.track(k), store.get(k) as T)
	const write = (k: Key, v: unknown) => (store.set(k, v), s.mark([k]))
	const b = with_ === "none" ? undefined : createBoundaries(s)
	let told = 0
	const loading = with_ === "a boundary of each" ? b!.loading(root) : undefined
	const errored = with_ === "a boundary of each" ? b!.errored(root) : undefined
	loading?.on(() => void told++)
	errored?.on(() => void told++)
	// PENDING while k holds "wait", a throw while it holds "fail"
	const compute = (k: Key, at: Scope = root, plus = 0) =>
		s.runWithScope(at, () =>
			s.createComputer(() => {
				const v = read(k)
				if (v === "wait") return PENDING
				if (v === "fail") throw new Error("failed")
				return (v as number) + plus
			}, () => {}))
	return { s, root, key, read, write, compute, loading, errored, told: () => told }
}

// 21 rounds, or as many past 5 as fit in two seconds
function median(f: () => void, calls: number): number {
	for (let i = 0; i < calls; i++) f()
	const times: number[] = []
	const start = performance.now()
	for (let r = 0; r < 21; r++) {
		const t0 = performance.now()
		for (let i = 0; i < calls; i++) f()
		times.push((performance.now() - t0) * 1000 / calls)
		if (r >= 4 && performance.now() - start > 2000) break
	}
	return times.sort((a, b) => a - b)[times.length >> 1]
}

// setup gives back the runs a pulse makes, the calls per round, and the timed function; it runs
// only for a shape picked
const only = Deno.args
function bench(name: string, setup: () => [runs: number, calls: number, f: () => void]) {
	if (only.length && !only.some((o) => name.includes(o))) return
	const [runs, calls, f] = setup()
	const us = median(f, calls)
	const per = runs > 1 ? `\t${(us / runs).toFixed(3)} µs/run` : ""
	console.log(`${name.padEnd(52)}\t${us.toFixed(2)} µs${per}`)
}

// runs that end done: the fan of 1000 and the chain of 1000, with no boundaries, boundaries made
// and none placed, and a boundary of each at the root
for (const with_ of ["none", "boundaries", "a boundary of each"] as const) {
	bench(`fan of 1000, all done, ${with_}`, () => {
		const w = world(with_)
		const src = w.key("src")
		w.write(src, 0)
		for (let i = 0; i < 1000; i++) w.compute(src, w.root, i)
		w.s.pulse()
		let i = 0
		return [1000, 20, () => {
			w.write(src, ++i)
			w.s.pulse()
		}]
	})
	bench(`chain of 1000, all done, ${with_}`, () => {
		const w = world(with_)
		const src = w.key("src")
		w.write(src, 0)
		let prev = src
		for (let i = 0; i < 1000; i++) {
			const k = w.key("c" + i), p = prev
			w.s.runWithScope(w.root, () =>
				w.s.createComputer(
					() => w.read<number>(p) + 1,
					(v) => (w.write(k, v), void 0),
				))
			prev = k
		}
		w.s.pulse()
		let i = 0
		return [1000, 20, () => {
			w.write(src, ++i)
			w.s.pulse()
		}]
	})
}

// n under the root's boundaries, all caught and all let go: one pulse to "wait" or "fail", one back
// to a number. two pulses a call
for (const [kind, v] of [["pending", "wait"], ["failed", "fail"]] as const) {
	for (const n of [100, 1000, 10000]) {
		bench(`${n} ${kind} then done`, () => {
			const w = world()
			const src = w.key("src")
			w.write(src, 0)
			for (let i = 0; i < n; i++) w.compute(src)
			w.s.pulse()
			let i = 0
			return [2 * n, n <= 100 ? 200 : n <= 1000 ? 10 : 2, () => {
				w.write(src, v)
				w.s.pulse()
				w.write(src, ++i)
				w.s.pulse()
			}]
		})
	}
}

// the same with a listener asking caught() each time it is told (as one putting it in the graph)
for (const n of [100, 1000]) {
	bench(`${n} pending then done, on reads caught()`, () => {
		const w = world()
		let length = 0
		w.loading!.on(() => void (length += w.loading!.caught().length))
		const src = w.key("src")
		w.write(src, 0)
		for (let i = 0; i < n; i++) w.compute(src)
		w.s.pulse()
		let i = 0
		return [2 * n, n <= 100 ? 200 : 10, () => {
			w.write(src, "wait")
			w.s.pulse()
			w.write(src, ++i)
			w.s.pulse()
		}]
	})
}

// the same with no boundaries: what the scheduler costs on its own
for (const [kind, v] of [["pending", "wait"], ["failed", "fail"]] as const) {
	for (const n of [1000, 10000]) {
		bench(`${n} ${kind} then done, none`, () => {
			const w = world("none")
			const src = w.key("src")
			w.write(src, 0)
			for (let i = 0; i < n; i++) w.compute(src)
			w.s.pulse()
			let i = 0
			return [2 * n, n <= 1000 ? 10 : 2, () => {
				w.write(src, v)
				w.s.pulse()
				w.write(src, ++i)
				w.s.pulse()
			}]
		})
	}
}

// n caught and held, one more comes and goes: the list changes by one, twice a call
for (const n of [100, 1000, 10000]) {
	bench(`one comes and goes among ${n} held`, () => {
		const w = world()
		const wait = w.key("wait"), one = w.key("one")
		w.write(wait, "wait")
		w.write(one, 0)
		for (let i = 0; i < n; i++) w.compute(wait)
		w.compute(one)
		w.s.pulse()
		let i = 0
		return [2, n <= 1000 ? 2000 : 200, () => {
			w.write(one, "wait")
			w.s.pulse()
			w.write(one, ++i)
			w.s.pulse()
		}]
	})
}

// n caught and held, each run again still pending: the same boundary, the item swapped in place
for (const n of [100, 1000]) {
	bench(`${n} held, all run again still pending`, () => {
		const w = world()
		const wait = w.key("wait"), poke = w.key("poke")
		w.write(wait, "wait")
		w.write(poke, 0)
		for (let i = 0; i < n; i++) {
			w.s.runWithScope(
				w.root,
				() => w.s.createComputer(() => (w.read(poke), w.read(wait), PENDING), () => {}),
			)
		}
		w.s.pulse()
		let i = 0
		return [n, n <= 100 ? 200 : 10, () => {
			w.write(poke, ++i)
			w.s.pulse()
		}]
	})
}

// depth: one computation d scopes below the root's boundaries, pending then done
for (const d of [1, 100, 1000]) {
	bench(`one at depth ${d}, pending then done`, () => {
		const w = world()
		const src = w.key("src")
		w.write(src, 0)
		let at: Scope = w.root
		for (let i = 0; i < d; i++) at = w.s.createScope([["why", "bench"]], at)
		w.compute(src, at)
		w.s.pulse()
		let i = 0
		return [2, 2000, () => {
			w.write(src, "wait")
			w.s.pulse()
			w.write(src, ++i)
			w.s.pulse()
		}]
	})
}

// listeners told: how many times a boundary's on is called for n caught in one pulse
{
	const w = world()
	const src = w.key("src")
	w.write(src, 0)
	for (let i = 0; i < 1000; i++) w.compute(src)
	w.s.pulse()
	const before = w.told()
	w.write(src, "wait")
	w.s.pulse()
	const caught = w.told() - before
	w.write(src, 1)
	w.s.pulse()
	if (!only.length || only.some((o) => "told".includes(o))) {
		console.log(`told, 1000 caught then let go\t${caught} then ${w.told() - before - caught}`)
	}
}
