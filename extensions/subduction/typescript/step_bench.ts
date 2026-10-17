// sync taking in n placements on one children table, copy-on-write as tables are: one update per
// commit (today), one update for all that came together (batched), squished then one update.
// fresh: n new names. again: every name placed, then set again 3 times (later commits redo earlier)
// deno run -A typescript/step_bench.ts
import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import type { Patch } from "@ermine/op/apply"
import { squish } from "@ermine/op/squish"

const header = { actor: "bench" } as never

function placements(n: number, again: boolean): Patch[][] {
	const commits: Patch[][] = []
	for (let i = 0; i < n; i++) commits.push([{ path: [`e${i}`], value: `id${i}` }])
	if (again) {
		for (let r = 1; r <= 3; r++) {
			for (let i = 0; i < n; i++) commits.push([{ path: [`e${i}`], value: `id${i}.${r}` }])
		}
	}
	return commits
}

function time(f: () => void) {
	f()
	const t = performance.now()
	for (let i = 0; i < 5; i++) f()
	return (performance.now() - t) / 5
}

for (const again of [false, true]) {
	for (const n of [900, 5000]) {
		const commits = placements(n, again)
		const each = time(() => {
			const e = createEntry({} as never, header)
			for (const c of commits) update(e, structuredClone(c) as never, header)
		})
		const batched = time(() => {
			const e = createEntry({} as never, header)
			update(e, structuredClone(commits.flat()) as never, header)
		})
		const squished = time(() => {
			const e = createEntry({} as never, header)
			update(e, squish(structuredClone(commits.flat())) as never, header)
		})
		console.log(
			`${again ? "again" : "fresh"} n=${n} (${commits.length} commits)  each ${
				each.toFixed(1)
			}ms  batched ${batched.toFixed(1)}ms  squish+batched ${squished.toFixed(1)}ms`,
		)
	}
}
