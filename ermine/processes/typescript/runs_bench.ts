// deno run ermine/processes/typescript/runs_bench.ts
// what recording each run costs (runs.ts): a pulse rerunning computers that read through places,
// with nothing recorded, with status.ts alone, with runs.ts, with both. medians of up to 21
// rounds: µs per pulse, and per run where the pulse runs many. the host's write each pulse is
// made with a header of its own (no site captured), so it costs the same in every shape
import createEntry, { type ChangeHeader } from "@ermine/core/node/entry"
import update from "@ermine/core/changeable/update"
import { createTable, type Key } from "@ermine/core/table"
import { createScheduler } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createPlaces } from "@ermine/core/places"
import { createRuns } from "./runs.ts"
import { createStatus } from "@ermine/core/places/status"

type Shape = "none" | "status" | "runs" | "both"

// n computers, each reading the shared node "a" at x, then its own node at x, then "b" whole;
// each pulse the host writes a's x, so every one runs again
function world(n: number, shape: Shape) {
	const s = createScheduler()
	s.onTrackingEnd((k) => places.release(k))
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places = createPlaces({ root: "R", table, paths: createPaths<unknown>(), scheduler: s })
	const o = s.createRootScope({ actor: "bench" })
	const h = (): ChangeHeader => ({ time: 0, actor: "bench" })
	for (const k of ["a", "b"]) table.add("value", k, createEntry<unknown>({ x: 0 }, h()))
	const statuses = shape === "status" || shape === "both"
		? createStatus({ places, table, scheduler: s })
		: undefined
	const runs = shape === "runs" || shape === "both"
		? createRuns({ places, table, scheduler: s })
		: undefined
	for (let i = 0; i < n; i++) {
		table.add("value", `own${i}`, createEntry<unknown>({ x: i }, h()))
		const f = () =>
			(places.readValue("value", "a", ["x"]) as number) +
			(places.readValue("value", `own${i}`, ["x"]) as number) +
			(places.readValue("value", "b") === undefined ? 1 : 0)
		const c = s.runWithScope(o, () => s.createComputer(f, () => {}))
		statuses?.give(c, `c${i}`)
		runs?.give(c, `c${i}`)
	}
	s.pulse()
	let x = 0
	return () => {
		const e = table.get("value", "a")!
		update(e, [{ path: ["x"], value: ++x }], h())
		places.commit([e])
		s.pulse()
	}
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

const shapes: Shape[] = ["none", "status", "runs", "both"]
for (const n of [1, 100]) {
	const line = shapes.map((shape) => {
		const us = median(world(n, shape), n === 1 ? 2000 : 50)
		return `${shape} ${us.toFixed(2)}${n > 1 ? ` (${(us / n).toFixed(2)}/run)` : ""}`
	})
	console.log(`${n} computer${n > 1 ? "s" : ""}, µs per pulse: ${line.join("  ")}`)
}
