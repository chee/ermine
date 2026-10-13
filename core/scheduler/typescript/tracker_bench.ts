// deno bench core/scheduler/typescript/tracker_bench.ts
// what a scheduler does with the tracker: runs that read spots, readers of a hot spot
import { createTracker, type Node } from "./tracker.ts"

const N = 1000
const HOT = 5000

function make() {
	const t = createTracker<number>()
	const nodes = (n: number, base = 0) => Array.from({ length: n }, (_, i) => t.node(base + i))
	const run = (r: Node<number>, to: Node<number>[]) => {
		t.begin(r)
		for (let i = 0; i < to.length; i++) t.track(r, to[i])
		t.end(r)
	}
	return { t, nodes, run }
}

// a run reading N spots the first time; the reads dropped between runs, not timed
{
	const { t, nodes, run } = make()
	const spots = nodes(N)
	const r = t.node(-1)
	Deno.bench(`first run, ${N} spots`, { group: "run" }, (b) => {
		b.start()
		run(r, spots)
		b.end()
		t.untrack(r)
	})
}

// a re-run reading the same spots in the same order: the cursor path, the common case
for (const n of [10, N]) {
	const { nodes, run, t } = make()
	const spots = nodes(n)
	const r = t.node(-1)
	run(r, spots)
	Deno.bench(`re-run, same ${n} spots`, { group: "run" }, () => run(r, spots))
}

// a re-run reading a different subset each time: every other run reads a shifted half
{
	const { nodes, run, t } = make()
	const spots = nodes(N)
	const a = spots.slice(0, N / 2)
	const b = spots.slice(N / 4, N / 4 + N / 2)
	const r = t.node(-1)
	let flip = false
	run(r, a)
	Deno.bench(`re-run, other half of ${N} (overlap half)`, { group: "run" }, () => {
		flip = !flip
		run(r, flip ? b : a)
	})
}

// a re-run reading the same spots reversed: nothing matches the cursor, links are made and dropped
{
	const { nodes, run, t } = make()
	const spots = nodes(100)
	const back = [...spots].reverse()
	const r = t.node(-1)
	let flip = false
	run(r, spots)
	Deno.bench(`re-run, reversed 100 spots`, { group: "run" }, () => {
		flip = !flip
		run(r, flip ? back : spots)
	})
}

// the same spot read many times in a run: the tail check
{
	const { nodes, run, t } = make()
	const [s] = nodes(1)
	const r = t.node(-1)
	const many = Array.from({ length: N }, () => s)
	Deno.bench(`one spot read ${N} times in a run`, { group: "run" }, () => run(r, many))
}

// one spot with thousands of readers; one comes and goes each round, round the ring
{
	const { nodes, run, t } = make()
	const hot = t.node(-1)
	const readers = nodes(HOT)
	for (const r of readers) run(r, [hot])
	let i = 0
	Deno.bench(`hot spot, ${HOT} readers, one leaves and returns`, { group: "hot" }, () => {
		const r = readers[i++ % HOT]
		run(r, [])
		run(r, [hot])
	})
}
// the same, but the leaving is by untrack
{
	const { nodes, run, t } = make()
	const hot = t.node(-1)
	const readers = nodes(HOT)
	for (const r of readers) run(r, [hot])
	let i = 0
	Deno.bench(`hot spot, ${HOT} readers, untrack and add back`, { group: "hot" }, () => {
		const r = readers[i++ % HOT]
		t.untrack(r, hot)
		t.add(r, hot)
	})
}
// readers of a hot spot: no holes (live array), and with one hole (compacts)
{
	const { nodes, run, t } = make()
	const hot = t.node(-1)
	const readers = nodes(HOT)
	for (const r of readers) run(r, [hot])
	Deno.bench(`readers of a hot spot, ${HOT}, no holes`, { group: "readers" }, () => {
		t.readers(hot)
	})
	let i = 0
	// untrack one in the middle, read, add it back: the compaction is most of it
	Deno.bench(`readers of a hot spot, ${HOT}, after one leaves`, { group: "readers" }, () => {
		const r = readers[1 + (i++ % (HOT - 2))]
		t.untrack(r, hot)
		t.readers(hot)
		t.add(r, hot)
	})
}

// untrack of a reader with many reads
{
	const { nodes, run, t } = make()
	const spots = nodes(N)
	const r = t.node(-1)
	Deno.bench(`untrack a reader of ${N} spots`, { group: "untrack" }, (b) => {
		run(r, spots)
		b.start()
		t.untrack(r)
		b.end()
	})
	Deno.bench(`untrack one spot of ${N} (the last)`, { group: "untrack" }, (b) => {
		run(r, spots)
		b.start()
		t.untrack(r, spots[N - 1])
		b.end()
		t.untrack(r)
	})
}

// the whole life of a reader, run and untrack both in the time (as tracker_bench.c)
{
	const { nodes, run, t } = make()
	const spots = nodes(N)
	const r = t.node(-1)
	Deno.bench(`run + untrack a reader of ${N} spots`, { group: "untrack" }, () => {
		run(r, spots)
		t.untrack(r)
	})
	Deno.bench(`run + untrack one spot (the last) + untrack all`, { group: "untrack" }, () => {
		run(r, spots)
		t.untrack(r, spots[N - 1])
		t.untrack(r)
	})
}

// a deep chain: each node's run reads the next; the whole chain re-runs
{
	const { nodes, run } = make()
	const chain = nodes(N)
	for (let i = 0; i < N - 1; i++) run(chain[i], [chain[i + 1]])
	Deno.bench(`deep chain, ${N} re-runs of one read`, { group: "shape" }, () => {
		for (let i = 0; i < N - 1; i++) run(chain[i], [chain[i + 1]])
	})
}
// a wide fan: N readers of one spot all re-run
{
	const { nodes, run, t } = make()
	const hot = t.node(-1)
	const readers = nodes(N)
	for (const r of readers) run(r, [hot])
	Deno.bench(`wide fan, ${N} readers of one spot re-run`, { group: "shape" }, () => {
		for (const r of readers) run(r, [hot])
	})
}
// a wide fan out: one reader of N spots, each read by one other reader as well
{
	const { nodes, run, t } = make()
	const spots = nodes(N)
	for (const s of spots) run(t.node(-2), [s])
	const r = t.node(-1)
	run(r, spots)
	Deno.bench(
		`fan out, one reader of ${N} spots (each shared), re-run`,
		{ group: "shape" },
		() => run(r, spots),
	)
}
