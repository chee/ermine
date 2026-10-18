// deno run core/scheduler/typescript/selector_bench.ts [name…]
// createSelector against n readers each reading the source themselves, and what the keyed index
// costs the rest of the scheduler. medians of up to 21 rounds: µs per pulse, and per run where the
// pulse runs many. names given: only the shapes whose name holds one of them
import { createScheduler } from "./scheduler.ts"
import { createSelector, keyed } from "./selector.ts"

type Key = { name: string }

function world() {
	const s = createScheduler()
	const store = new Map<Key, unknown>()
	const root = s.createRootScope({ actor: "bench" })
	const key = (name: string): Key => ({ name })
	const read = <T>(k: Key) => (s.track(k), store.get(k) as T)
	const write = (k: Key, v: unknown) => (store.set(k, v), s.mark([k]))
	const reader = <T>(f: () => T, at = root) =>
		s.runWithScope(at, () => s.createComputer(f, () => {}))
	// the selection: src holds a number, the key selected
	const src = key("src")
	write(src, 0)
	const select = (equal?: (k: number, v: number) => boolean, at = root) =>
		s.runWithScope(at, () => createSelector(s, () => read<number>(src), equal))
	return { s, root, key, read, write, reader, src, select }
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
	console.log(`${name.padEnd(48)}\t${us.toFixed(2)} µs${per}`)
}

const calls = (n: number) => n <= 100 ? 2000 : n <= 1000 ? 200 : 20

// the selection moves to the next key; n readers, one per key. selector: the source's computer and
// the readers of the two keys run. each comparing: every reader runs
for (const n of [10, 1000, 10000]) {
	bench(`move among ${n}, selector`, () => {
		const w = world()
		const is = w.select()
		for (let k = 0; k < n; k++) w.reader(() => is(k))
		w.s.pulse()
		let i = 0
		return [3, calls(n), () => {
			w.write(w.src, ++i % n)
			w.s.pulse()
		}]
	})
	bench(`move among ${n}, each comparing`, () => {
		const w = world()
		for (let k = 0; k < n; k++) w.reader(() => w.read(w.src) === k)
		w.s.pulse()
		let i = 0
		return [n, n <= 1000 ? calls(n) / 10 : 3, () => {
			w.write(w.src, ++i % n)
			w.s.pulse()
		}]
	})
}

// equal given: every key held is asked at each move, whatever it selects
for (const n of [1000, 10000]) {
	bench(`move among ${n}, selector, equal given`, () => {
		const w = world()
		const is = w.select((k, v) => k === v)
		for (let k = 0; k < n; k++) w.reader(() => is(k))
		w.s.pulse()
		let i = 0
		return [3, calls(n), () => {
			w.write(w.src, ++i % n)
			w.s.pulse()
		}]
	})
}

// many readers of one key: a move to or from it runs them all
bench(`1000 readers of one key, in and out`, () => {
	const w = world()
	const is = w.select()
	for (let r = 0; r < 1000; r++) w.reader(() => is(0))
	w.s.pulse()
	let i = 0
	return [1001, 20, () => {
		w.write(w.src, ++i % 2)
		w.s.pulse()
	}]
})

// one reader asking of every key (a list painted in one computation): a move runs it, and it
// tracks n keys again
for (const n of [100, 1000]) {
	bench(`one reader of ${n} keys, selector`, () => {
		const w = world()
		const is = w.select()
		w.reader(() => {
			let on = 0
			for (let k = 0; k < n; k++) if (is(k)) on++
			return on
		})
		w.s.pulse()
		let i = 0
		return [2, calls(n), () => {
			w.write(w.src, ++i % n)
			w.s.pulse()
		}]
	})
}

// many selectors over one source, 10 readers each: a move runs every selector's computer, and
// the index sorts their marks
bench(`100 selectors x 10 readers, a move`, () => {
	const w = world()
	for (let x = 0; x < 100; x++) {
		const is = w.select()
		for (let k = 0; k < 10; k++) w.reader(() => is(k))
	}
	w.s.pulse()
	let i = 0
	return [300, 50, () => {
		w.write(w.src, ++i % 10)
		w.s.pulse()
	}]
})

// making n readers under a scope, their first runs, and tearing it down: each key held at its first
// track, dropped at its tracking end
for (const n of [1000]) {
	bench(`make, run, tear down ${n} readers, selector`, () => {
		const w = world()
		const is = w.select()
		w.s.pulse()
		return [n, 20, () => {
			const o = w.s.runWithScope(w.root, () => w.s.createScope({ why: "bench" }))
			for (let k = 0; k < n; k++) w.reader(() => is(k), o)
			w.s.pulse()
			w.s.teardown(o)
		}]
	})
	bench(`make, run, tear down ${n} readers, comparing`, () => {
		const w = world()
		return [n, 20, () => {
			const o = w.s.runWithScope(w.root, () => w.s.createScope({ why: "bench" }))
			for (let k = 0; k < n; k++) w.reader(() => w.read(w.src) === k, o)
			w.s.pulse()
			w.s.teardown(o)
		}]
	})
}

// n readers held; one more, of a key of its own, made, run and torn down: the same key each time
// (a row scrolled out and back), or a new one
for (const fresh of [false, true]) {
	for (const n of [100, 10000]) {
		bench(`one comes and goes among ${n} held, ${fresh ? "new key" : "same key"}`, () => {
			const w = world()
			const is = w.select()
			for (let k = 0; k < n; k++) w.reader(() => is(k))
			w.s.pulse()
			let i = 0
			return [1, 2000, () => {
				const k = fresh ? n + ++i : n
				const c = w.reader(() => is(k))
				w.s.pulse()
				w.s.teardown(c)
			}]
		})
	}
}

// what the index costs the rest: a write nobody reads, and one change among 10000 pairs, with no
// index, an index holding nothing, and an index holding 1000 keys
for (const held of ["no index", "index, nothing held", "index, 1000 held"]) {
	const make = () => {
		const w = world()
		if (held !== "no index") keyed(w.s)
		if (held === "index, 1000 held") {
			const is = w.select()
			for (let k = 0; k < 1000; k++) w.reader(() => is(k))
		}
		w.s.pulse()
		return w
	}
	bench(`write nobody reads, ${held}`, () => {
		const w = make()
		const k = w.key("lonely")
		let i = 0
		return [1, 20000, () => {
			w.write(k, ++i)
			w.s.pulse()
		}]
	})
	bench(`one change among 10000 pairs, ${held}`, () => {
		const w = make()
		const srcs = Array.from({ length: 10000 }, (_, i) => w.key("s" + i))
		for (const k of srcs) w.write(k, 0)
		srcs.forEach((k) => w.reader(() => w.read<number>(k) + 1))
		w.s.pulse()
		let i = 0
		return [1, 2000, () => {
			w.write(srcs[0], ++i)
			w.s.pulse()
		}]
	})
}
