// deno run places/typescript/crowify_bench.ts [name…]
// µs per call, fastest of 31 rounds: through places, writing a folder under a reader ("copy": update,
// "in place": op's apply with cow: false, crow), and crowify's cost to the scheduler
import update from "@ermine/changeable/update"
import type { Patch } from "@ermine/changeable/apply"
import createEntry, { type Entry } from "@ermine/graph/entry"
import { createCrow } from "@ermine/crow"
import { createScheduler } from "@ermine/reactivity"
import { createPaths } from "@ermine/reactivity/paths"
import { createTable } from "@ermine/graph/table"
import { fastest, inPlace, only, row } from "../../crow/typescript/bench_harness.ts"
import { createPlaces, type Places } from "./places.ts"
import { createChangeHeader } from "./header.ts"
import { crowify, crowifyTable, updateEntry } from "./crowify.ts"

const folder = (n: number) => () => ({
	...Object.fromEntries(Array.from({ length: n }, (_, i) => [`name${i}`, `id${i}`])),
})
const rename = (i: number): Patch[] => [{ path: [`name${i % 1000}`], value: `id${i}` }]

// through places: a place into a folder of 1000 names, a reader of one name, a pulse after each
// write. crow's world gives places the table through reading: places' reads are reads
function world(way: "copy" | "in place" | "crow") {
	const u = createCrow()
	const s = createScheduler()
	s.onTrackingEnd((key) => places.release(key))
	const table = createTable((part, id) => places.onTableChange(part, id))
	const places: Places = createPlaces({
		root: "R",
		table: way === "crow" ? crowifyTable(table, u) : table,
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
		if (way === "crow") updateEntry(u, e, ps, header)
		else if (way === "in place") inPlace(e, ps, header)
		else update(e, ps, header)
		places.commit([e])
		s.pulse()
	}
}
row("places: a name in a folder of 1000 + pulse, a reader of name0", {
	copy: () => world("copy"),
	"in place": () => world("in place"),
	crow: () => world("crow"),
}, 1000)

// crowify's cost to the scheduler: a chain of 100 computes, one write at its head, µs per pulse.
// any run-end listener has every run keep its reads (onRunEnd's reads), so a plain listener is
// measured too
{
	const name = "scheduler: a chain of 100 computes, a pulse"
	if (!only.length || only.some((o) => name.includes(o))) {
		const chain = (listen: "none" | "listener" | "crowify") => {
			const s = createScheduler()
			const u = createCrow()
			if (listen === "listener") s.onRunEnd(() => {})
			if (listen === "crowify") crowify(s, u)
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
		const cols = (["none", "listener", "crowify"] as const).map((l) =>
			`${l} ${fastest(chain(l), 200).toFixed(2)}`
		)
		console.log(`${name}\t${cols.join("\t")} µs`)
	}
}
