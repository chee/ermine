// deno run core/scheduler/typescript/scheduler_bench.ts [name…]
// the scheduler on its own, over a Map for a store: a write from outside marks its key, a
// compute's set writes its own key, named by its run. medians of up to 21 rounds: µs per pulse,
// and per run where the pulse runs many. names given: only the shapes whose name holds one of them
import { createScheduler } from "./scheduler.ts"
import { trace } from "./trace.ts"

type Key = { name: string }

function world() {
	const s = createScheduler()
	const store = new Map<Key, unknown>()
	const root = s.createRootScope({ actor: "bench" })
	const key = (name: string): Key => ({ name })
	const read = <T>(k: Key) => (s.track(k), store.get(k) as T)
	const write = (k: Key, v: unknown) => (store.set(k, v), s.mark([k]))
	// results land at k
	const compute = <T>(k: Key, f: () => T, at = root) =>
		s.runWithScope(
			at,
			() => s.createComputer(f, (v) => (store.set(k, v), s.mark([k], s.getRun())), undefined, k),
		)
	const effect = <T>(f: () => T, at = root) =>
		s.runWithScope(at, () => s.createEffect(f, () => {}))
	return { s, root, key, read, write, compute, effect }
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
	console.log(`${name.padEnd(36)}\t${us.toFixed(2)} µs${per}`)
}

// a chain: src → c1 → … → cn → an effect. every run is at a new rank
for (const n of [10, 1000]) {
	bench(`chain of ${n}`, () => {
		const w = world()
		const src = w.key("src")
		w.write(src, 0)
		let prev = src
		for (let i = 0; i < n; i++) {
			const k = w.key("c" + i), p = prev
			w.compute(k, () => w.read<number>(p) + 1)
			prev = k
		}
		const last = prev
		w.effect(() => w.read(last))
		w.s.pulse()
		let i = 0
		return [n + 1, n < 100 ? 2000 : 20, () => {
			w.write(src, ++i)
			w.s.pulse()
		}]
	})
}

// a fan: src → n computes, each reading it
for (const n of [10, 1000]) {
	bench(`fan of ${n}`, () => {
		const w = world()
		const src = w.key("src")
		w.write(src, 0)
		for (let i = 0; i < n; i++) w.compute(w.key("c" + i), () => w.read<number>(src) + i)
		w.s.pulse()
		let i = 0
		return [n, n < 100 ? 2000 : 20, () => {
			w.write(src, ++i)
			w.s.pulse()
		}]
	})
}

// a fan in: one compute reading n sources; one source changes
bench(`fan in of 1000`, () => {
	const n = 1000
	const w = world()
	const srcs = Array.from({ length: n }, (_, i) => w.key("s" + i))
	for (const k of srcs) w.write(k, 1)
	w.compute(w.key("sum"), () => {
		let t = 0
		for (const k of srcs) t += w.read<number>(k)
		return t
	})
	w.s.pulse()
	let i = 0
	return [1, 200, () => {
		w.write(srcs[i++ % n], i)
		w.s.pulse()
	}]
})

// a grid: width x depth, each reading two of the layer above; every source changes
bench(`grid 100x10, all sources`, () => {
	const width = 100, depth = 10
	const w = world()
	const srcs = Array.from({ length: width }, (_, i) => w.key("s" + i))
	for (const k of srcs) w.write(k, 0)
	let above = srcs
	for (let d = 0; d < depth; d++) {
		const layer = Array.from({ length: width }, (_, j) => w.key(`g${d}.${j}`))
		const from = above
		layer.forEach((k, j) =>
			w.compute(k, () => w.read<number>(from[j]) + w.read<number>(from[(j + 1) % width]))
		)
		above = layer
	}
	w.s.pulse()
	let i = 0
	return [width * depth, 20, () => {
		i++
		for (const k of srcs) w.write(k, i)
		w.s.pulse()
	}]
})

// many effects on one source
for (const n of [1000, 10000]) {
	bench(`${n} effects on one source`, () => {
		const w = world()
		const src = w.key("src")
		w.write(src, 0)
		for (let i = 0; i < n; i++) w.effect(() => w.read<number>(src) + i)
		w.s.pulse()
		let i = 0
		return [n, n < 5000 ? 20 : 3, () => {
			w.write(src, ++i)
			w.s.pulse()
		}]
	})
}

// reads that change: each compute reads the one before it, or src, by a flag. every run changes
// whose results it read
for (const n of [100, 1000]) {
	bench(`changing reads, ${n}`, () => {
		const w = world()
		const src = w.key("src"), flag = w.key("flag")
		w.write(src, 0)
		w.write(flag, false)
		let prev = src
		for (let i = 0; i < n; i++) {
			const k = w.key("d" + i), p = prev
			w.compute(k, () => (w.read<boolean>(flag) ? w.read<number>(p) : w.read<number>(src)) + 1)
			prev = k
		}
		w.s.pulse()
		let on = false
		return [n, n < 500 ? 50 : 3, () => {
			w.write(flag, on = !on)
			w.s.pulse()
		}]
	})
}

// a big world, a small change: n pairs src → compute; one src changes
for (const n of [10, 10000]) {
	bench(`one change among ${n} pairs`, () => {
		const w = world()
		const srcs = Array.from({ length: n }, (_, i) => w.key("s" + i))
		for (const k of srcs) w.write(k, 0)
		srcs.forEach((k, i) => w.compute(w.key("c" + i), () => w.read<number>(k) + 1))
		w.s.pulse()
		let i = 0
		return [1, 2000, () => {
			w.write(srcs[0], ++i)
			w.s.pulse()
		}]
	})
}

// an equal result stops there: src → a compute that stays the same → n readers
bench(`equal result before 1000 readers`, () => {
	const n = 1000
	const w = world()
	const src = w.key("src"), same = w.key("same")
	w.write(src, 0)
	w.compute(same, () => w.read<number>(src) >= 0)
	for (let i = 0; i < n; i++) w.compute(w.key("r" + i), () => w.read(same))
	w.s.pulse()
	let i = 0
	return [1, 2000, () => {
		w.write(src, ++i)
		w.s.pulse()
	}]
})

// a write from outside nobody reads
bench(`write nobody reads`, () => {
	const w = world()
	const k = w.key("lonely")
	let i = 0
	return [1, 20000, () => {
		w.write(k, ++i)
		w.s.pulse()
	}]
})

// making n computes under a scope, their first runs, and tearing it down
bench(`make, run, tear down 1000`, () => {
	const n = 1000
	const w = world()
	const src = w.key("src")
	w.write(src, 0)
	return [n, 20, () => {
		const o = w.s.runWithScope(w.root, () => w.s.createScope({ why: "bench" }))
		for (let i = 0; i < n; i++) w.compute(w.key("m" + i), () => w.read<number>(src) + i, o)
		w.s.pulse()
		w.s.teardown(o)
	}]
})

// the same with a chain: each first run finds a new writer
bench(`make, run, tear down a chain of 1000`, () => {
	const n = 1000
	const w = world()
	const src = w.key("src")
	w.write(src, 0)
	return [n, 2, () => {
		const o = w.s.runWithScope(w.root, () => w.s.createScope({ why: "bench" }))
		let prev = src
		for (let i = 0; i < n; i++) {
			const k = w.key("m" + i), p = prev
			w.compute(k, () => w.read<number>(p) + 1, o)
			prev = k
		}
		w.s.pulse()
		w.s.teardown(o)
	}]
})

// the fan of 1000 with a trace listening (every run's reads kept)
bench(`fan of 1000, traced`, () => {
	const n = 1000
	const w = world()
	let told = 0
	trace(w.s, () => void told++)
	const src = w.key("src")
	w.write(src, 0)
	for (let i = 0; i < n; i++) w.compute(w.key("c" + i), () => w.read<number>(src) + i)
	w.s.pulse()
	let i = 0
	return [n, 20, () => {
		w.write(src, ++i)
		w.s.pulse()
	}]
})
