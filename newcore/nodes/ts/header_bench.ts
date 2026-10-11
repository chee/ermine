// deno bench newcore/header_bench.ts
// the change's whole header (change.ts) through mutate and places: two fields against five
import createChange, { type Change } from "./nodes/change.ts"
import createNode from "./nodes/node.ts"
import mutate from "./opstreams/mutate.ts"
import { createPlaces } from "./graph/places.ts"
import { createTable } from "./graph/table.ts"

const small = { time: 1, actor: "me" }
const whole = {
	time: 1,
	actor: { actor: "a1", person: "p1", trusted: true, code: ["c1"] },
	reader: "pid7",
	cause: "a new list",
	site: { file: "file:///x.ts", line: 3, column: 1, function: "f" },
}
const bench = (name: string, group: string, fn: () => void, baseline = false) =>
	Deno.bench(name, { group, baseline, n: 300_000, warmup: 50_000 }, fn)

// the change object alone: before, mutate made a two-field header and spread it; now it spreads
// what it is given
bench(
	"before: two fields picked",
	"change",
	() => void createChange("a", { time: small.time, actor: small.actor }),
	true,
)
bench("now: two fields", "change", () => void createChange("a", small))
bench("now: five fields", "change", () => void createChange("a", whole))

// mutate: one small patch, a fresh node each time
const host = createChange("a", { time: 0, actor: "host" })
for (const [name, header] of [["two fields", small], ["five fields", whole]] as const) {
	bench(name, "mutate: one put", () => {
		const n = createNode<unknown, Change>("a", { value: [{ content: { x: 1 }, change: host }] })
		mutate(n, "value", [{ path: ["x"], value: 2 }], header)
	}, name === "two fields")
}

// places: insert into a list of 8, and write a value at depth 4
for (const [name, header] of [["two fields", small], ["five fields", whole]] as const) {
	const t = createTable<unknown, Change>()
	const ids = ["n0", "n1", "n2", "n3", "n4"]
	for (const id of ids) t.intro(createNode(id))
	const p = createPlaces(t.get, "n0", { by: () => header })
	for (let i = 0; i < 4; i++) p.insert(ids[i], "k", ids[i + 1])
	for (let i = 0; i < 7; i++) p.insert("n4", "list", `x${i}`)
	bench(name, "places: insert, then remove", () => {
		p.insert("n4", "list", "y", 3)
		p.remove("n4", "list", 3)
	}, name === "two fields")
	bench(
		name,
		"places: write at depth 4",
		() => void p.write(["k", "k", "k"], ["k"], [{ path: [], value: 1 }]),
		name === "two fields",
	)
}
