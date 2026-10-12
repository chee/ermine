// deno bench newcore/programs/ts/records_bench.ts
// what the scheduler writes after a run: the value, the status, the latest run; each against the
// pieces it is made of (the agent, an empty change, the bare assignment)
import { createGraph } from "@ermine/graph"
import createChange from "@ermine/graph/change"
import createNode from "@ermine/graph/node"
import mutate from "@ermine/op/mutate"
import { createRecords, type Ran, type Recorded } from "./records.ts"

const bench = (name: string, o: Omit<Deno.BenchDefinition, "fn" | "name">, fn: () => void) =>
	Deno.bench(name, { n: 100_000, warmup: 20_000, ...o }, fn)

type P = Recorded & { owned: string[] }
const g = createGraph<P>({ root: createNode("root", {}), owned: (p, id) => void p.owned.push(id) })
const records = createRecords<P>(g)
const who = { actor: "host" }

// a process as start makes one: an ephemeral node placed at the root
function proc(name: string): P {
	const id = g.make(undefined, null, who)
	g.own(id)
	g.changing(who, {}, () => g.places.insert("root", name, id))
	return {
		id,
		state: "running",
		base: { actor: "host" },
		prefix: [],
		runs: 1,
		status: {},
		owned: [],
	}
}

const p = proc("p")
let n = 0
const group = "after a run"
bench("value", { group, baseline: true }, () => {
	records.value(p, ++n, {}, n)
})
const q = proc("q")
bench("status: pending, then not", { group }, () => {
	records.status(q, (++n & 1) ? { pending: n } : {}, n)
})
const r = proc("r")
const ran = (i: number): Ran => ({
	n: i,
	given: [{ by: { time: i } }],
	reads: [{ op: "content", tracked: true, times: [i] }],
	wrote: [],
	rank: 0,
})
records.run(r, ran(0), "done", undefined, [])
bench("latest run (its node made already)", { group }, () => {
	records.run(r, ran(++n), "done", undefined, [])
})

const parts = "what value is made of"
bench("agentOf", { group: parts, baseline: true }, () => {
	records.agentOf(p, { run: ++n, status: {} })
})
bench("changing, nothing changed", { group: parts }, () => {
	g.changing(who, {}, () => {})
})
bench("changing, snap told whole, nothing changed", { group: parts }, () => {
	g.changing(who, { snap: [[p.id, "value"]] }, () => {})
})
const node = g.get(p.id)!
bench("changing, snap told whole, a new version", { group: parts }, () => {
	g.changing(who, { snap: [[p.id, "value"]] }, () => {
		const vs = node.value.slice()
		vs[0] = { content: ++n, change: createChange(p.id, g.by()) }
		node.value = vs
	})
})
bench("a new version, no changing", { group: parts }, () => {
	const vs = node.value.slice()
	vs[0] = { content: ++n, change: createChange(p.id, { time: n, actor: who }) }
	node.value = vs
})

// the latest run, written three ways: a put of the whole (records.run, now); its version replaced,
// told whole; patches of only what changed since the last run (most of a run's record is the same)
const ways = "latest run, written"
const record = (i: number) => ({
	run: i,
	program: null,
	by: [i],
	reads: [{ op: "content", address: ["/", "s", "3"], tracked: true, times: [i] }],
	wrote: [],
	rank: 0,
	ended: "done",
	after: [],
})
const w = proc("w")
records.run(w, ran(0), "done", undefined, [])
const there = g.get(w.run!)!
bench("put of the whole (now)", { group: ways, baseline: true }, () => {
	records.run(w, ran(++n), "done", undefined, [])
})
bench("version replaced, told whole", { group: ways }, () => {
	const value = record(++n)
	g.changing({ actor: "host" }, { snap: [[there.id, "value"]] }, () => {
		const vs = there.value.slice()
		vs[0] = { content: value, change: createChange(there.id, g.by()) }
		there.value = vs
	})
})
bench("patches of what changed", { group: ways }, () => {
	const i = ++n
	g.changing({ actor: "host" }, {}, () =>
		mutate(there, "value", [
			{ path: ["run"], value: i },
			{ path: ["by", 0], value: i },
			{ path: ["reads", 0, "times", 0], value: i },
		], g.by()))
})
